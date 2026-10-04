import fs from "node:fs/promises"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { runProcess } from "./process-runner.mjs"
import { createCodexExecArgs } from "./codex-build.mjs"
import { normalizeResult } from "./adapters.mjs"
import { deliveryPrompt } from "./pr-delivery-prompts.mjs"
import { DeliveryError, pause, keyFor, readJson, writeJson, withLease, reserveCodex } from "./pr-delivery-state.mjs"

const SHA = /^[0-9a-f]{40}$/
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const FIELDS = "number,title,state,baseRefName,isCrossRepository,headRefName,headRefOid,mergeStateStatus,mergeable,isDraft,comments,statusCheckRollup,mergeCommit"
const digestOf = value => createHash("sha256").update(value).digest("hex")
const pass = data => normalizeResult({ status: "pass", data }, "delivery")
const fail = error => normalizeResult({ status: "fail",
  data: { code: Number.isInteger(error.code) ? error.code : 1, message: error.message, transient: error.transient ?? false },
  findings: [{ reason: error.message }] }, "delivery")

export async function loadDeliveryConfig(file) {
  const value = await readJson(file)
  if (!value || !value.repos || !Object.keys(value.repos).length) throw new DeliveryError("config.repos is required", 9)
  const base = path.dirname(path.resolve(file))
  const absolute = p => {
    if (typeof p !== "string" || !p.trim()) throw new DeliveryError("config path is required", 9)
    return path.resolve(base, p)
  }
  const config = { ...value, stateDir: absolute(value.stateDir),
    repos: Object.fromEntries(Object.entries(value.repos).map(([repo, local]) => {
      if (!REPO.test(repo)) throw new DeliveryError("invalid repository in config", 9)
      return [repo, { ...local, checkout: absolute(local.checkout), worktreeRoot: absolute(local.worktreeRoot) }]
    })),
    limits: { runsPer24h: 8, slots: 4, timeoutMs: 4500_000, ...value.limits },
    pollMs: value.pollMs ?? 30_000, commandTimeoutMs: value.commandTimeoutMs ?? 120_000,
    checksTimeoutMs: value.checksTimeoutMs ?? 3600_000, retryMs: value.retryMs ?? 120_000,
    autoPollMs: value.autoPollMs ?? 300_000, queueRunsPer24h: value.queueRunsPer24h ?? 4 }
  for (const v of [...Object.values(config.limits), config.pollMs, config.commandTimeoutMs, config.checksTimeoutMs, config.autoPollMs, config.queueRunsPer24h])
    if (!Number.isSafeInteger(v) || v <= 0) throw new DeliveryError("config limits must be positive integers", 9)
  if (!Number.isSafeInteger(config.retryMs) || config.retryMs < 0) throw new DeliveryError("invalid retryMs", 9)
  createCodexExecArgs(config.codex)
  config.holds = (value.holds ?? []).map(h => {
    if (!config.repos[h.repo] || typeof h.titlePattern !== "string") throw new DeliveryError("invalid config hold", 9)
    return { ...h, regex: new RegExp(h.titlePattern, "i") }
  })
  return config
}

// One hosted-CI policy for CheckRun and StatusContext provider shapes.
// Empty/unfinished checks wait; success, skipped and neutral are accepted;
// terminal failures trigger repair. Unknown responses stop as service errors.
function checksOutcome(checks) {
  if (!Array.isArray(checks)) throw new DeliveryError("invalid hosted checks response", 1, true)
  const accepted = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"])
  const failed = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STALE", "STARTUP_FAILURE"])
  const pending = new Set(["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"])
  const outcomes = checks.map(c => {
    const state = c.status === "COMPLETED" ? c.conclusion : c.status ?? c.state
    if (accepted.has(state)) return "accepted"
    if (failed.has(state)) return "failed"
    if (pending.has(state)) return "pending"
    throw new DeliveryError("invalid hosted checks state", 1, true)
  })
  return outcomes.includes("failed") ? "failed" : !outcomes.length || outcomes.includes("pending") ? "pending" : "accepted"
}

function reviews(pr) {
  return (pr.comments ?? []).map(c => {
    const [verdict, line] = (c.body ?? "").split(/\r?\n/)
    const sha = /^Reviewed-SHA: ([0-9a-f]{40})$/.exec(line ?? "")?.[1]
    if (!sha || !["APPROVE", "REVIEW: BLOCKED", "CHANGES REQUESTED"].includes(verdict)) return null
    return { verdict, sha, body: c.body }
  }).filter(Boolean)
}

export function createPrDeliveryAdapter(config, { env = process.env } = {}) {
  const locks = path.join(config.stateDir, "locks"), queueFile = path.join(config.stateDir, "queue.json")
  const prLeases = new Map()
  const getRepo = repo => {
    if (!config.repos[repo]) throw new DeliveryError(`UNKNOWN REPO ${repo}: add checkout and worktreeRoot to config.repos`, 9)
    return config.repos[repo]
  }
  async function command(argv, cwd, { allowFailure = false, timeoutMs = config.commandTimeoutMs, input = "", ...streamOptions } = {}) {
    const result = await runProcess(argv, { cwd, env, timeoutMs, input, ...streamOptions })
    if (result.code && !allowFailure) {
      const transient = result.timedOut || /GraphQL|rate limit|Something went wrong|timed out|502/i.test(result.stderr)
      // Diagnostics never echo credential-bearing command output.
      throw new DeliveryError(`${argv[0]} ${argv[1]} failed (${result.code})${transient ? ": transient service error" : ""}`, result.code, transient)
    }
    return result
  }
  const git = async (cwd, ...args) => (await command(["git", ...args], cwd)).stdout.trim()
  const gh = async (repo, pr, action, ...args) => (await command(["gh", "pr", action, String(pr), "-R", repo, ...args], getRepo(repo).checkout)).stdout
  async function view(repo, pr) {
    const value = JSON.parse(await gh(repo, pr, "view", "--json", FIELDS))
    if (!["OPEN", "CLOSED", "MERGED"].includes(value.state) || !SHA.test(value.headRefOid ?? ""))
      throw new DeliveryError("invalid GitHub PR response", 1, true)
    supportedBase(value)
    return value
  }
  function supportedBase(pr) {
    if (pr.baseRefName !== "main") throw new DeliveryError("unsupported PR base: delivery target must be main", 9)
  }
  function requireOpen(pr) {
    if (pr.state !== "OPEN") throw new DeliveryError(`NOT OPEN (${pr.state}): no repair or review work`, 8)
  }
  async function latestReview(repo, pr, current) {
    const candidate = reviews(current).at(-1)
    if (!candidate || candidate.verdict !== "APPROVE") return candidate
    const id = /^Factory-Review: ([0-9a-f-]{36})$/m.exec(candidate.body)?.[1]
    if (!id) return null // Imported/handwritten approvals require a new factory review.
    const receipt = await readJson(path.join(config.stateDir, "reviews", `${id}.json`), null)
    if (!receipt || receipt.schema !== "factory-review/v1" || receipt.repo !== repo || receipt.pr !== pr ||
        receipt.head !== candidate.sha || receipt.verdict !== "APPROVE" || receipt.commentDigest !== digestOf(candidate.body) ||
        receipt.execution?.code !== 0 || !receipt.execution?.pid || !receipt.sourceVerified) return null
    const artifacts = path.join(config.stateDir, "reviews", id)
    const prompt = await fs.readFile(`${artifacts}.prompt`, "utf8").catch(() => null)
    const output = await fs.readFile(receipt.output, "utf8").catch(() => null)
    if (prompt === null || output === null || digestOf(prompt) !== receipt.promptDigest || digestOf(output) !== receipt.outputDigest) return null
    if (await git(getRepo(repo).checkout, "rev-parse", `${receipt.head}^{tree}`) !== receipt.tree) return null
    return candidate
  }
  async function log(event) {
    await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 })
    await fs.appendFile(path.join(config.stateDir, "delivery.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", { mode: 0o600 })
  }
  async function waitChecks(repo, pr, head, completedOnly = false, inspect = view) {
    const until = Date.now() + config.checksTimeoutMs
    while (true) {
      const current = await inspect(repo, pr)
      requireOpen(current)
      if (current.headRefOid !== head) throw new DeliveryError("HEAD MOVED during checks; needs fresh review", 1)
      const outcome = checksOutcome(current.statusCheckRollup)
      if (outcome !== "pending") {
        if (!completedOnly && outcome !== "accepted") throw new DeliveryError(`NONGREEN on ${head}`, 3)
        return current
      }
      if (Date.now() >= until) throw new DeliveryError("CI-WAIT-TIMEOUT", 142)
      await pause(config.pollMs)
    }
  }
  async function branchWorktree(repo, branch, fallback, observedHead) {
    const local = getRepo(repo)
    const origin = await git(local.checkout, "remote", "get-url", "origin")
    const identity = origin.replace(/^git@github\.com:/, "").replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "")
    if (local.originUrl ? origin !== local.originUrl : identity !== repo)
      throw new DeliveryError("repair repository binding does not match configured origin")
    if (branch === "main" || branch.startsWith("-")) throw new DeliveryError("refusing to repair main or invalid branch")
    await git(local.checkout, "check-ref-format", "--branch", branch)
    await git(local.checkout, "fetch", "-q", "origin", branch)
    const remoteHead = await git(local.checkout, "rev-parse", `refs/remotes/origin/${branch}`)
    if (observedHead && remoteHead !== observedHead) throw new DeliveryError("repair origin source does not match observed PR head")
    const trees = (await git(local.checkout, "worktree", "list", "--porcelain")).split("\n\n")
    let worktree = trees.find(t => t.split("\n").includes(`branch refs/heads/${branch}`))?.split("\n")[0].slice(9)
    if (!worktree) {
      worktree = fallback ?? path.join(local.worktreeRoot, branch.replaceAll("/", "--"))
      await fs.mkdir(path.dirname(worktree), { recursive: true })
      // Never reset an existing fallback or repoint someone else's branch.
      try { await fs.access(worktree); throw new DeliveryError(`fallback worktree already exists: ${worktree}`) }
      catch (e) { if (e.code !== "ENOENT") throw e }
      const exists = await command(["git", "show-ref", "--verify", `refs/heads/${branch}`], local.checkout, { allowFailure: true })
      if (exists.code === 0) await git(local.checkout, "worktree", "add", "-q", worktree, branch)
      else await git(local.checkout, "worktree", "add", "-q", "-b", branch, worktree, `origin/${branch}`)
    }
    if (await git(worktree, "status", "--porcelain", "--untracked-files=no"))
      throw new DeliveryError(`worktree ${worktree} holding ${branch} has uncommitted changes`)
    if (await git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir") !==
        await git(local.checkout, "rev-parse", "--path-format=absolute", "--git-common-dir") ||
        await git(worktree, "symbolic-ref", "HEAD") !== `refs/heads/${branch}`)
      throw new DeliveryError("repair worktree repository/branch binding mismatch")
    if ((await command(["git", "merge-base", "--is-ancestor", "HEAD", remoteHead], worktree, { allowFailure: true })).code)
      throw new DeliveryError("repair worktree ahead/diverged from observed source; retained")
    const ff = await command(["git", "merge", "-q", "--ff-only", `origin/${branch}`], worktree, { allowFailure: true })
    if (ff.code) throw new DeliveryError(`worktree ${worktree}: ${branch} diverged from origin`)
    if (await git(worktree, "rev-parse", "HEAD") !== remoteHead) throw new DeliveryError("repair source binding mismatch; retained")
    return worktree
  }
  async function guarded(repo, pr, kind, argv, cwd, input) {
    const release = await reserveCodex(config, repo, pr, kind)
    try {
      await log({ repo, pr, step: kind, status: "started" })
      const digest = createHash("sha256")
      const result = await command(argv, cwd, { input, timeoutMs: config.limits.timeoutMs, allowFailure: true,
        captureOutput: false, onOutput: chunk => digest.update(chunk), onSpawn: async job => {
          const bindings = [await release.bindJob(job)]
          const prLease = prLeases.get(keyFor(repo, pr))
          if (prLease) bindings.push(await prLease.bindJob(job))
          return bindings
        } })
      const outputDigest = digest.digest("hex")
      await log({ repo, pr, step: kind, status: result.timedOut ? "TIMEOUT" : result.code ? "failed" : "complete", code: result.code,
        outputDigest })
      if (result.code) throw new DeliveryError(result.timedOut ? `TIMEOUT ${repo}#${pr}` : `${kind} exited ${result.code}`, result.code)
      return { ...result, outputDigest }
    } finally { await release() }
  }
  async function review(repo, pr) {
    const initial = await view(repo, pr)
    requireOpen(initial)
    const current = await waitChecks(repo, pr, initial.headRefOid, true)
    const local = getRepo(repo), head = current.headRefOid
    await git(local.checkout, "fetch", "-q", "origin", head)
    const attempt = randomUUID()
    const dir = path.join(local.worktreeRoot, `review-${pr}-${head}-${attempt}`)
    await fs.mkdir(local.worktreeRoot, { recursive: true })
    await git(local.checkout, "worktree", "add", "-q", "--detach", dir, head)
    const tree = await git(dir, "rev-parse", "HEAD^{tree}")
    const unchanged = async () => await git(dir, "rev-parse", "HEAD") === head &&
      await git(dir, "write-tree") === tree &&
      !(await git(dir, "status", "--porcelain", "--untracked-files=no"))
    const output = path.join(config.stateDir, `review-${keyFor(repo, pr)}-${attempt}.txt`)
    try {
      const prior = reviews(current).filter(r => ["REVIEW: BLOCKED", "CHANGES REQUESTED"].includes(r.verdict)).at(-1)
      const prompt = deliveryPrompt("review", { repo, pr, head, prior })
      await fs.rm(output, { force: true })
      const argv = [config.codex.command ?? "codex", ...createCodexExecArgs(config.codex),
        "--sandbox", "danger-full-access", "--output-last-message", output, "-"]
      const execution = await guarded(repo, pr, "review", argv, dir, prompt)
      if (!(await unchanged()))
        throw new DeliveryError("reviewer changed pinned source; refusing approval, worktree retained")
      const body = await fs.readFile(output, "utf8")
      const parsed = reviews({ comments: [{ body }] })[0]
      if (!parsed || parsed.sha !== head || !["APPROVE", "REVIEW: BLOCKED"].includes(parsed.verdict))
        throw new DeliveryError("invalid reviewer comment format or Reviewed-SHA")
      const beforePost = await view(repo, pr)
      requireOpen(beforePost)
      if (beforePost.headRefOid !== head) throw new DeliveryError("HEAD MOVED during review; needs fresh review")
      const comment = `${body}\nFactory-Review: ${attempt}`
      const artifacts = path.join(config.stateDir, "reviews", attempt)
      await fs.mkdir(path.dirname(artifacts), { recursive: true, mode: 0o700 })
      await fs.writeFile(`${artifacts}.prompt`, prompt, { mode: 0o600 })
      await writeJson(`${artifacts}.json`, { schema: "factory-review/v1", repo, pr, head, tree,
        verdict: parsed.verdict, sourceVerified: true, cwd: dir, argv, execution,
        promptDigest: digestOf(prompt), output, outputDigest: digestOf(body), commentDigest: digestOf(comment) })
      await gh(repo, pr, "comment", "--body", comment)
      return { head, verdict: parsed.verdict }
    } finally {
      // Test artifacts may be untracked; keep a modified tracked source tree for
      // diagnosis rather than silently discarding an agent's prohibited edit.
      if (await unchanged())
        await git(local.checkout, "worktree", "remove", "--force", dir)
    }
  }
  async function fix(repo, pr, kind, worktree) {
    const current = await view(repo, pr)
    requireOpen(current)
    if (current.isCrossRepository !== false) throw new DeliveryError("fork repair is unsupported; origin is not the PR source")
    const fallback = worktree && worktree !== "-" ? path.resolve(worktree) : path.join(getRepo(repo).worktreeRoot, `fix-${pr}`)
    const cwd = await branchWorktree(repo, current.headRefName, fallback, current.headRefOid)
    await git(cwd, "fetch", "-q", "origin")
    if ((await view(repo, pr)).headRefOid !== current.headRefOid || await git(cwd, "rev-parse", "HEAD") !== current.headRefOid)
      throw new DeliveryError("HEAD MOVED before repair; source retained")
    await guarded(repo, pr, kind, [config.codex.command ?? "codex", ...createCodexExecArgs(config.codex), "--sandbox", "danger-full-access", "-"], cwd,
      deliveryPrompt(kind, { repo, pr, head: current.headRefOid, branch: current.headRefName }))
    return { head: (await view(repo, pr)).headRefOid }
  }
  async function queueState(fn) {
    return withLease(locks, "queue-state", async () => {
      const queue = await readJson(queueFile, [])
      const result = await fn(queue)
      await writeJson(queueFile, queue)
      return result
    }, { waitMs: config.commandTimeoutMs, pollMs: config.pollMs })
  }
  async function enqueue(repo, pr, head, note = "", mode = "manual") {
    getRepo(repo)
    if (!SHA.test(head)) throw new DeliveryError("approved SHA must be a full commit SHA")
    return queueState(queue => {
      const prior = queue.filter(e => e.repo === repo && e.pr === pr && e.head === head)
      if (mode !== "manual" && (prior.some(e => mode === "import" || !e.outcome || e.outcome.status === "pass") ||
          prior.filter(e => (e.createdAt ?? 0) >= Date.now() - 86400_000).length >= config.queueRunsPer24h))
        return { message: `ALREADY QUEUED or RETRY LIMIT ${repo}#${pr} ${head}`, enqueued: false }
      queue.push({ id: randomUUID(), repo, pr, head, note: note.replaceAll("\n", " "), attempts: 0,
        availableAt: 0, createdAt: Date.now(), recoveryOf: prior.at(-1)?.id ?? null })
      return { message: `QUEUED ${repo}#${pr} ${head}`, enqueued: true }
    })
  }
  async function verifyApprovedHead(local, head, old) {
    let cursor = head, hops = 0
    while (cursor !== old) {
      if (++hops > 6) throw new DeliveryError("HEAD IS NOT A MAIN-MERGE OF THE APPROVED HEAD; needs fresh review")
      const parents = (await git(local.checkout, "show", "-s", "--format=%P", cursor)).split(" ")
      if (parents.length !== 2) throw new DeliveryError("NON-MERGE COMMIT after approval; needs fresh review")
      const [first, second] = parents
      if ((await command(["git", "merge-base", "--is-ancestor", second, "origin/main"], local.checkout, { allowFailure: true })).code)
        throw new DeliveryError("SECOND PARENT NOT ON MAIN; needs fresh review")
      const tree = (await git(local.checkout, "merge-tree", "--write-tree", second, first)).split("\n")[0]
      if (tree !== await git(local.checkout, "rev-parse", `${cursor}^{tree}`))
        throw new DeliveryError("MERGE HAS HAND EDITS; needs fresh review", 2)
      cursor = first
    }
  }
  async function verifyDelivery(repo, pr, observed, approvedHead) {
    const local = getRepo(repo), commit = observed.mergeCommit?.oid
    supportedBase(observed)
    if (observed.state !== "MERGED" || !SHA.test(commit ?? "")) throw new DeliveryError("MERGE VERIFY: invalid merged commit", 7, true)
    await git(local.checkout, "fetch", "-q", "origin", "main", observed.headRefOid)
    await verifyApprovedHead(local, observed.headRefOid, approvedHead)
    if ((await command(["git", "merge-base", "--is-ancestor", commit, "origin/main"], local.checkout, { allowFailure: true })).code)
      throw new DeliveryError("MERGE NOT ON MAIN", 7, true)
    const parents = (await git(local.checkout, "show", "-s", "--format=%P", commit)).split(" ")
    if (parents.length !== 1) throw new DeliveryError("MERGE SOURCE VERIFY: expected squash commit", 7)
    const expected = (await git(local.checkout, "merge-tree", "--write-tree", parents[0], observed.headRefOid)).split("\n")[0]
    if (expected !== await git(local.checkout, "rev-parse", `${commit}^{tree}`))
      throw new DeliveryError("MERGE SOURCE VERIFY: delivered tree does not match PR", 7)
    return { message: `${repo}#${pr} MERGED ${commit} (on main, source verified)`, mergeCommit: commit, merged: true }
  }
  // Integration reads use REST and complete pagination. Never inherit a verdict
  // from the pre-integration tree, even for disjoint filenames.
  async function integrationView(repo, pr) {
    const api = async (...args) => {
      const result = await command(["gh", "api", ...args], getRepo(repo).checkout)
      try { return JSON.parse(result.stdout) }
      catch { throw new DeliveryError("invalid integration REST JSON", 1, true) }
    }
    const p = await api(`repos/${repo}/pulls/${pr}`)
    if (!["open", "closed"].includes(p.state) || !SHA.test(p.head?.sha ?? ""))
      throw new DeliveryError("invalid integration PR response", 1, true)
    supportedBase({baseRefName: p.base?.ref})
    const pages = async endpoint => {
      const result = await api("--paginate", "--slurp", endpoint)
      if (!Array.isArray(result)) throw new DeliveryError("invalid integration pages", 1, true)
      return result
    }
    const checks = (await pages(`repos/${repo}/commits/${p.head.sha}/check-runs?per_page=100`))
      .flatMap(page => {
        if (!Array.isArray(page.check_runs)) throw new DeliveryError("invalid integration checks", 1, true)
        return page.check_runs
      }).map(c => ({status: c.status?.toUpperCase(), conclusion: c.conclusion?.toUpperCase()}))
    const statuses = (await pages(`repos/${repo}/commits/${p.head.sha}/statuses?per_page=100`)).flat()
    // Statuses are newest first; old failures must not overwrite a newer state.
    const contexts = new Set()
    for (const c of statuses) if (!contexts.has(c.context)) {
      contexts.add(c.context); checks.push({state: c.state?.toUpperCase()})
    }
    const comments = (await pages(`repos/${repo}/issues/${pr}/comments?per_page=100`)).flat()
    const current = {state: p.merged ? "MERGED" : p.state.toUpperCase(), headRefOid: p.head.sha,
      baseRefName: p.base?.ref, mergeStateStatus: p.mergeable_state?.toUpperCase(),
      mergeable: p.mergeable === false ? "CONFLICTING" : "MERGEABLE", isDraft: p.draft,
      mergeCommit: {oid: p.merge_commit_sha}, statusCheckRollup: checks, comments}
    supportedBase(current)
    return current
  }
  async function mergeOne(repo, pr, old, note = "", retry = false) {
    const local = getRepo(repo)
    if (!SHA.test(old)) throw new DeliveryError("approved SHA must be a full commit SHA")
    let current = await integrationView(repo, pr)
    if (current.state === "MERGED") return verifyDelivery(repo, pr, current, old)
    if (current.state !== "OPEN") throw new DeliveryError(`${repo}#${pr} NOT OPEN (${current.state})`, 8)
    if (current.isDraft) throw new DeliveryError("DRAFT: integration requires a published candidate", 8)
    await git(local.checkout, "fetch", "-q", "origin", "main", current.headRefOid, old)
    if (current.mergeStateStatus === "DIRTY" || current.mergeable === "CONFLICTING")
      throw new DeliveryError("CONFLICT with main; needs a builder merge + fresh review", 5)
    const ancestor = await command(["git", "merge-base", "--is-ancestor", "origin/main", current.headRefOid], local.checkout, { allowFailure: true })
    if (ancestor.code) {
      const update = await command(["gh", "api", "-X", "PUT", `repos/${repo}/pulls/${pr}/update-branch`,
        "-f", `expected_head_sha=${current.headRefOid}`], local.checkout, {allowFailure: true})
      if (update.code) throw new DeliveryError("UPDATE-BRANCH FAILED; needs a builder integration + fresh review", 5)
      throw new DeliveryError("INTEGRATION UPDATED; needs fresh review and CI of the integrated tree", 2)
    }
    const head = current.headRefOid
    if (head !== old) throw new DeliveryError("HEAD CHANGED after integration; needs fresh review", 2)
    const base = await git(local.checkout, "rev-parse", "origin/main")
    await waitChecks(repo, pr, head, false, integrationView)
    current = await integrationView(repo, pr)
    if (current.headRefOid !== head) throw new DeliveryError("HEAD MOVED during checks; needs fresh review")
    requireOpen(current)
    await git(local.checkout, "fetch", "-q", "origin", "main")
    if (await git(local.checkout, "rev-parse", "origin/main") !== base)
      throw new DeliveryError("INTEGRATION BASE MOVED; needs fresh integration, review and CI", 2)
    const approval = await latestReview(repo, pr, current)
    if (checksOutcome(current.statusCheckRollup) !== "accepted") throw new DeliveryError(`NONGREEN on ${head}`, 3)
    if (!approval || approval.verdict !== "APPROVE" || approval.sha !== old)
      throw new DeliveryError(`NO INDEPENDENT APPROVE for ${old}`, 4)
    await command(["gh", "api", `repos/${repo}/issues/${pr}/comments`, "-f", `body=DELIVERY VERIFIED\nSource-SHA: ${head}\nIntegration-Base: ${base}\n\nExact integrated head, independent review and hosted checks verified. ${note}`], local.checkout)
    const result = await command(["gh", "api", "-X", "PUT", `repos/${repo}/pulls/${pr}/merge`, "-f", "merge_method=squash", "-f", `sha=${head}`], local.checkout, { allowFailure: true })
    if (result.code) {
      if (!retry && result.stderr.includes("not up to date")) return mergeOne(repo, pr, old, note, true)
      throw new DeliveryError("MERGE REFUSED" + (/GraphQL|rate limit|timed out|502/i.test(result.stderr) || result.timedOut ? ": transient service error" : ""), 6,
        /GraphQL|rate limit|timed out|502/i.test(result.stderr) || result.timedOut)
    }
    let acknowledgement
    try { acknowledgement = JSON.parse(result.stdout) } catch { /* fail closed below */ }
    if (acknowledgement?.merged !== true || !SHA.test(acknowledgement.sha ?? ""))
      throw new DeliveryError("MERGE acknowledgement missing; reconcile before retry", 7)
    let lastError
    for (let attempt = 0; attempt < 6; attempt++) {
      try { return await verifyDelivery(repo, pr, await integrationView(repo, pr), head) }
      catch (error) { if (!error.transient) throw error; lastError = error }
      await pause(config.pollMs)
    }
    throw lastError
  }
  async function consumeQueue(repo) {
    const entry = await queueState(queue => queue.find(e => e.repo === repo && !e.outcome && e.availableAt <= Date.now()))
    if (!entry) return { message: "QUEUE IDLE", idle: true }
    let outcome
    try { outcome = pass(await withLease(locks, `pr-${keyFor(entry.repo, entry.pr)}`, () => mergeOne(entry.repo, entry.pr, entry.head, entry.note))) }
    catch (e) { outcome = fail(e) }
    if (outcome.data.code === 75) throw new DeliveryError("BUSY: integration PR writer already owned", 75)
    await queueState(queue => {
      const index = queue.findIndex(e => e.id === entry.id), stored = queue[index]
      stored.attempts++
      if (outcome.data.transient && stored.attempts < 4) {
        stored.availableAt = Date.now() + config.retryMs
        queue.splice(index, 1)
        queue.push(stored)
      } else stored.outcome = outcome
    })
    await log({ step: "merge", repo: entry.repo, pr: entry.pr, head: entry.head, ...outcome.data })
    return { message: outcome.data.message, processed: true, outcome, code: 0 }
  }
  async function autoEnqueue() {
    let count = 0
    for (const repo of Object.keys(config.repos)) {
      let prs
      // gh paginates internally up to --limit. Expand until completeness is
      // proven; fail visibly at the repository bound instead of starving a tail.
      for (let limit = 50; ; limit = Math.min(limit * 2, 10000)) {
        prs = JSON.parse((await command(["gh", "pr", "list", "-R", repo, "--state", "open", "--json", FIELDS,
          "--limit", String(limit)], getRepo(repo).checkout, { maxOutputBytes: 16_000_000 })).stdout)
        if (!Array.isArray(prs)) throw new DeliveryError("invalid GitHub PR list", 1, true)
        if (prs.length < limit) break
        if (limit === 10000) throw new DeliveryError("PR scan exceeds repository bound; narrow the configured repository scope")
      }
      for (const current of prs) {
        if (config.holds.some(h => h.repo === repo && h.regex.test(current.title))) continue
        const approval = await latestReview(repo, current.number, current), checks = current.statusCheckRollup ?? []
        if (current.state !== "OPEN" || current.baseRefName !== "main" || approval?.verdict !== "APPROVE" ||
          approval.sha !== current.headRefOid || checksOutcome(checks) !== "accepted") continue
        if ((await enqueue(repo, current.number, current.headRefOid, "auto-enqueued: approved head + green", "automatic")).enqueued) count++
      }
    }
    return { message: `AUTO-ENQUEUED ${count}` }
  }
  async function importLegacy(root) {
    // Only the orchestrator calls this during cutover, with both old writers
    // stopped. Source records are read; this module never writes into root.
    if (!(await fs.stat(root)).isDirectory()) throw new DeliveryError("legacy source must be an existing directory")
    const text = async file => {
      if (!(await fs.stat(path.join(root, file))).isFile()) throw new DeliveryError(`legacy source is not a file: ${file}`)
      return fs.readFile(path.join(root, file), "utf8")
    }
    const lines = s => s.split("\n").filter(Boolean)
    const queued = lines(await text("merge-queue.txt")), done = lines(await text("merge-queue.done"))
    if (done.length > queued.length || done.some((l, i) => l !== queued[i]))
      throw new DeliveryError("legacy queue done prefix does not match; inspect before cutover")
    const pending = queued.slice(done.length).map(line => {
      const match = /^(\S+) (\d+) ([0-9a-f]{40})(?: (.*))?$/.exec(line)
      if (!match) throw new DeliveryError("invalid legacy queue entry")
      getRepo(match[1])
      return { repo: match[1], pr: Number(match[2]), head: match[3], note: match[4] ?? "" }
    })
    const recent = []
    const names = await fs.readdir(path.join(root, "budget"))
    for (const name of names) {
      const match = /^(.+)-(\d+)\.log$/.exec(name)
      if (!match) continue
      const repos = Object.keys(config.repos).filter(r => r.split("/")[1] === match[1])
      if (!repos.length) continue
      if (repos.length !== 1) throw new DeliveryError("ambiguous legacy budget repository; reconcile before cutover")
      for (const [index, line] of lines(await text(`budget/${name}`)).entries()) {
        const [seconds, kind] = line.split(" "), at = Number(seconds) * 1000
        if (!Number.isSafeInteger(at) || !kind) throw new DeliveryError("invalid legacy usage record")
        if (at >= Date.now() - 86400_000) recent.push({ repo: repos[0], pr: Number(match[2]), kind, at,
          legacyId: createHash("sha256").update(`${path.resolve(root)}:${name}:${index}:${line}`).digest("hex") })
      }
    }
    await withLease(locks, "budget", async () => {
      const file = path.join(config.stateDir, "usage.json"), usage = await readJson(file, [])
      await writeJson(file, [...usage, ...recent.filter(r => !usage.some(u => u.legacyId === r.legacyId))])
    }, { waitMs: config.commandTimeoutMs, pollMs: config.pollMs })
    for (const entry of pending) await enqueue(entry.repo, entry.pr, entry.head, entry.note, "import")
    return { message: `IMPORTED pending queue and recent usage; source unchanged` }
  }
  return {
    config,
    async exclusive(repo, pr, fn) {
      getRepo(repo)
      return withLease(locks, `pr-${keyFor(repo, pr)}`, async release => {
        const key = keyFor(repo, pr)
        prLeases.set(key, release)
        try { return await fn() } finally { prLeases.delete(key) }
      })
    },
    async execute(step, request = {}) {
      const { repo, pr, head, worktree, note } = request
      try {
        if (repo) getRepo(repo)
        let data
        switch (step) {
          case "pr:inspect": {
            let current = await view(repo, pr)
            if (current.state === "MERGED") { data = await verifyDelivery(repo, pr, current, current.headRefOid); break }
            requireOpen(current)
            let review = await latestReview(repo, pr, current)
            let approved = review?.verdict === "APPROVE" && review.sha === current.headRefOid
            if (approved) {
              current = await waitChecks(repo, pr, current.headRefOid, true)
              review = await latestReview(repo, pr, current)
              approved = review?.verdict === "APPROVE" && review.sha === current.headRefOid
            }
            const ready = approved && current.mergeable !== "CONFLICTING" && checksOutcome(current.statusCheckRollup) === "accepted"
            data = { head: current.headRefOid, approved, ready, blocked: ["REVIEW: BLOCKED", "CHANGES REQUESTED"].includes(review?.verdict) }

            break
          }
          case "review": data = await review(repo, pr); break
          case "fix": case "ci-fix": data = await fix(repo, pr, step, worktree); break
          case "branch-wt": data = { worktree: await branchWorktree(repo, request.branch, request.fallback) }; break
          case "codex-guard": data = await guarded(repo, pr, request.kind, request.argv, getRepo(repo).checkout, ""); break
          case "enqueue": data = await enqueue(repo, pr, head, note); break
          case "auto-enqueue": data = await autoEnqueue(); break
          case "import-legacy": data = await importLegacy(request.root); break
          case "merge-one-core": data = await withLease(locks, `merge-${encodeURIComponent(repo)}`, () => withLease(locks, `pr-${keyFor(repo, pr)}`, () => mergeOne(repo, pr, head, note))); break
          case "merge-queue": {
            const repos = repo ? [repo] : Object.keys(config.repos)
            let busy = false
            for (const target of repos) {
              try { data = await withLease(locks, `merge-${encodeURIComponent(target)}`, () => consumeQueue(target)) }
              catch (e) { if (e.code !== 75) throw e; busy = true; continue }
              if (!data.idle) break
            }
            if (!data || (data.idle && busy)) throw new DeliveryError("BUSY: integration lane already owned", 75)
            break
          }
          default: throw new DeliveryError(`unknown delivery step: ${step}`)
        }
        return pass(data)
      } catch (error) {
        await log({ step, repo, pr, status: "failed", code: error.code ?? 1, message: error.message })
        return fail(error)
      }
    }
  }
}

import fs from "node:fs/promises"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { runProcess } from "./process-runner.mjs"
import { createCodexExecArgs } from "./codex-build.mjs"
import { normalizeResult } from "./adapters.mjs"
import { deliveryPrompt } from "./pr-delivery-prompts.mjs"
import { classifyChecks, validRequiredChecks } from "./pr-readiness.mjs"
import { DeliveryError, pause, keyFor, readJson, writeJson, withLease, reserveCodex, deliveryWait, completeDeliveryWait } from "./pr-delivery-state.mjs"

const SHA = /^[0-9a-f]{40}$/
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const REST_PAGE_SIZE = 25
const REST_SCAN_ROWS = 10_000
const digestOf = value => createHash("sha256").update(value).digest("hex")
const pass = data => normalizeResult({ status: "pass", data }, "delivery")
const fail = error => normalizeResult({ status: "fail",
  data: { code: Number.isInteger(error.code) ? error.code : 1, message: error.message, transient: error.transient ?? false,
    ...(error.wait ? { cause: error.wait.cause, resetAt: error.wait.resetAt, head: error.wait.head, nextAction: "wait-for-input-or-reset", admitted: false } : {}) },
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
      if (!validRequiredChecks(local.requiredChecks)) throw new DeliveryError("config repo requiredChecks must name the expected checks", 9)
      if (local.dependencyRevision !== undefined && (typeof local.dependencyRevision !== "string" || !local.dependencyRevision.trim()))
        throw new DeliveryError("config dependencyRevision must be a nonempty owned input pin", 9)
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
  function rest(response) {
    const parts = response.stdout.split(/\r?\n\r?\n/), headers = parts.shift() ?? ""
    const status = Number(/^HTTP\/[^ ]+ (\d+)/.exec(headers)?.[1])
    const exhausted = status === 403 && /^x-ratelimit-remaining: 0\s*$/im.test(headers)
    let body
    try { body = JSON.parse(parts.join("\n\n")) } catch { body = undefined }
    return { status, headers, body, exhausted, ok: !response.code && status >= 200 && status < 300,
      transient: response.timedOut || exhausted || [429, 500, 502, 503, 504].includes(status) }
  }
  async function api(repo, route) {
    for (let attempt = 0; ; attempt++) {
      // Full REST pages include long PR bodies, comments and check output.
      // Pair smaller pages with the prior reader's 16 MB capture allowance.
      const response = rest(await command(["gh", "api", `repos/${repo}/${route}`, "--include"], getRepo(repo).checkout,
        { allowFailure: true, maxOutputBytes: 16_000_000 }))
      const { status, headers, exhausted, transient } = response
      if (response.ok && status === 200) {
        if (response.body === undefined) throw new DeliveryError("invalid GitHub REST JSON", 1)
        return response.body
      }
      if (!transient || attempt >= 2) throw new DeliveryError("GitHub REST observation unavailable", 1, transient)
      const retryAfter = Number(/^retry-after: (\d+)/im.exec(headers)?.[1]) * 1000
      const reset = Number(/^x-ratelimit-reset: (\d+)/im.exec(headers)?.[1]) * 1000 - Date.now()
      const delay = Number.isFinite(retryAfter) ? retryAfter : exhausted && Number.isFinite(reset) ? Math.max(0, reset) : config.retryMs
      if (delay > config.commandTimeoutMs) throw new DeliveryError("GitHub REST waiting for provider reset", 1, true)
      await pause(delay)
    }
  }
  // A write is a supervised job bound to every lease its caller owns, so a dead
  // controller cannot hand ownership to a successor while the write runs. The
  // body travels on stdin, which the supervisor opens only after binding.
  // No response (timeout, network) means the effect is unknown: callers read back.
  async function mutate(repo, method, route, body, owners) {
    const response = rest(await command(["gh", "api", "-X", method, `repos/${repo}/${route}`, "--include", "--input", "-"],
      getRepo(repo).checkout, { allowFailure: true, input: JSON.stringify(body),
        onSpawn: job => Promise.all(owners.map(owner => owner.bindJob(job))) }))
    if (!Number.isFinite(response.status)) response.transient = true
    return response
  }
  async function pages(repo, route, field) {
    const rows = []
    let expected = null
    for (let page = 1; page <= REST_SCAN_ROWS / REST_PAGE_SIZE; page++) {
      const value = await api(repo, `${route}${route.includes("?") ? "&" : "?"}per_page=${REST_PAGE_SIZE}&page=${page}`)
      const batch = field ? value?.[field] : value
      if (!Array.isArray(batch) || batch.length > REST_PAGE_SIZE || field && (!Number.isSafeInteger(value.total_count) || value.total_count < 0))
        throw new DeliveryError("invalid GitHub REST page", 1)
      if (field) {
        if (expected !== null && expected !== value.total_count) throw new DeliveryError("GitHub REST pages changed during observation", 1, true)
        expected = value.total_count
      }
      rows.push(...batch)
      if (batch.length < REST_PAGE_SIZE) {
        if (field && rows.length !== expected) throw new DeliveryError("incomplete GitHub REST checks", 1, true)
        return rows
      }
    }
    throw new DeliveryError("GitHub REST scan exceeds repository bound", 1)
  }
  function prValue(value) {
    if (!value || !["open", "closed"].includes(value.state) || !SHA.test(value.head?.sha ?? "") || !value.head?.ref || !value.base?.ref)
      throw new DeliveryError("invalid GitHub PR response", 1)
    const current = { number: value.number, title: value.title, state: value.merged ? "MERGED" : value.state.toUpperCase(),
      baseRefName: value.base.ref, headRefName: value.head.ref, headRefOid: value.head.sha,
      isCrossRepository: value.head.repo?.full_name !== value.base.repo?.full_name,
      mergeStateStatus: value.mergeable_state?.toUpperCase(), mergeable: value.mergeable === true ? "MERGEABLE" : value.mergeable === false ? "CONFLICTING" : "UNKNOWN",
      isDraft: value.draft, mergeCommit: { oid: value.merge_commit_sha } }
    supportedBase(current)
    return current
  }
  async function view(repo, pr) {
    const value = prValue(await api(repo, `pulls/${pr}`))
    value.comments = await pages(repo, `issues/${pr}/comments`)
    if (value.comments.some(c => !c || typeof c.body !== "string")) throw new DeliveryError("invalid GitHub comments response", 1)
    return value
  }
  async function ciFor(repo, current, head = current.headRefOid) {
    const checkRuns = await pages(repo, `commits/${head}/check-runs?filter=all`, "check_runs")
    const statuses = (await pages(repo, `commits/${head}/statuses`)).map(s => ({ ...s, head_sha: head }))
    const observed = prValue(await api(repo, `pulls/${current.number}`))
    return classifyChecks({ head, observedHead: observed.headRefOid, requiredChecks: getRepo(repo).requiredChecks, checkRuns, statuses })
  }
  function requireKnownCi(ci) {
    if (ci.state === "provider-unknown") throw new DeliveryError("invalid hosted checks response", 1)
    if (ci.state === "superseded") throw new DeliveryError("SUPERSEDED: HEAD MOVED during checks; observe current head", 1)
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
  async function waitInput(repo, pr, head) {
    const usage = await readJson(path.join(config.stateDir, "usage.json"), [])
    return { head, dependency: digestOf(JSON.stringify(getRepo(repo).dependencyRevision ?? null)),
      budgetAvailable: usage.filter(r => r.repo === repo && r.pr === pr && r.at >= Date.now() - 86400_000).length < config.limits.runsPer24h }
  }
  async function suspend(repo, pr, head, stop) {
    const { budgetAvailable, ...input } = await waitInput(repo, pr, head)
    const wait = await deliveryWait(config, repo, pr, input, { repo, pr, ...stop })
    if (wait.recorded) await log({ repo, pr, step: "wait", status: "suspended", ...input, ...stop })
    return wait
  }
  async function eligible(repo, pr, head) {
    await deliveryWait(config, repo, pr, await waitInput(repo, pr, head))
  }
  async function waitChecks(repo, pr, head, completedOnly = false) {
    const until = Date.now() + config.checksTimeoutMs
    while (true) {
      const current = await view(repo, pr)
      requireOpen(current)
      if (current.headRefOid !== head) throw new DeliveryError("HEAD MOVED during checks; needs fresh review", 1)
      const ci = await ciFor(repo, current, head)
      requireKnownCi(ci)
      const outcome = ci.state
      if (outcome !== "pending") {
        if (outcome === "failure" && !ci.repairable) throw new DeliveryError("CI REQUIRED CHECK REFUSED: rerun current required check", 3)
        if (!completedOnly && outcome !== "success") throw new DeliveryError(`NONGREEN on ${head}`, 3)
        current.ci = ci
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
  async function guarded(repo, pr, kind, argv, cwd, input, head) {
    if (!["review", "fix", "ci-fix", "rescope"].includes(kind)) throw new DeliveryError("invalid guarded delivery kind", 9)
    head ??= (await view(repo, pr)).headRefOid
    await eligible(repo, pr, head)
    let release
    try {
      release = await reserveCodex(config, repo, pr, kind)
      const admitted = await view(repo, pr)
      requireOpen(admitted)
      if (admitted.headRefOid !== head) throw new DeliveryError("SUPERSEDED: HEAD MOVED before child dispatch; observe current head", 1)
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
    } catch (error) {
      if (error.code === 75 && !error.message.startsWith("BUSY:"))
        error.wait = await suspend(repo, pr, head, { cause: error.cause ?? "capacity-refused", code: 75, message: error.message, resetAt: error.resetAt ?? null })
      throw error
    } finally { if (release) await release() }
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
      const execution = await guarded(repo, pr, "review", argv, dir, prompt, head)
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
      deliveryPrompt(kind, { repo, pr, head: current.headRefOid, branch: current.headRefName }), current.headRefOid)
    const head = (await view(repo, pr)).headRefOid
    if (head === current.headRefOid) {
      const error = new DeliveryError("NO-PROGRESS: fix pushed nothing", 2)
      error.wait = await suspend(repo, pr, head, { cause: "source-no-progress", code: 2, message: error.message, resetAt: null })
      throw error
    }
    return { head }
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
  async function verifyDelivery(repo, pr, observed, approvedHead, base = null) {
    const local = getRepo(repo), commit = observed.mergeCommit?.oid
    supportedBase(observed)
    if (observed.state !== "MERGED" || !SHA.test(commit ?? "")) throw new DeliveryError("MERGE VERIFY: invalid merged commit", 7, true)
    await git(local.checkout, "fetch", "-q", "origin", "main", observed.headRefOid)
    await verifyApprovedHead(local, observed.headRefOid, approvedHead)
    if ((await command(["git", "merge-base", "--is-ancestor", commit, "origin/main"], local.checkout, { allowFailure: true })).code)
      throw new DeliveryError("MERGE NOT ON MAIN", 7, true)
    const parents = (await git(local.checkout, "show", "-s", "--format=%P", commit)).split(" ")
    if (parents.length !== 1) throw new DeliveryError("MERGE SOURCE VERIFY: expected squash commit", 7)
    if (base && parents[0] !== base) throw new DeliveryError("MERGE BASE VERIFY: delivered onto a base the integrated review never saw", 7)
    const expected = (await git(local.checkout, "merge-tree", "--write-tree", parents[0], observed.headRefOid)).split("\n")[0]
    if (expected !== await git(local.checkout, "rev-parse", `${commit}^{tree}`))
      throw new DeliveryError("MERGE SOURCE VERIFY: delivered tree does not match PR", 7)
    return { message: `${repo}#${pr} MERGED ${commit} (on main, source verified)`, mergeCommit: commit, merged: true }
  }
  // GitHub must itself refuse a merge once main is no longer an ancestor of the
  // reviewed head; no local comparison can close the race with other writers.
  async function requireServerUpToDate(repo) {
    for (const rule of await pages(repo, "rules/branches/main")) {
      if (rule?.type !== "required_status_checks" || rule.parameters?.strict_required_status_checks_policy !== true ||
          !Number.isSafeInteger(rule.ruleset_id)) continue
      const ruleset = await api(repo, `rulesets/${rule.ruleset_id}`)
      if (ruleset?.enforcement === "active" && ruleset.current_user_can_bypass === "never") return
    }
    throw new DeliveryError("INTEGRATION BASE NOT SERVER-ENFORCED: main needs an active strict required-status-checks rule the merger cannot bypass", 9)
  }
  const integrationRecord = (repo, pr, head) => path.join(config.stateDir, "integrations", `${keyFor(repo, pr)}-${head}.json`)
  async function integrationBase(repo, pr, head) {
    const record = await readJson(integrationRecord(repo, pr, head), null)
    if (record && (record.schema !== "factory-integration/v1" || record.repo !== repo || record.pr !== pr ||
        record.head !== head || !SHA.test(record.base ?? ""))) throw new DeliveryError("invalid integration record", 9)
    return record?.base ?? null
  }
  async function mergeOne(repo, pr, old, note, owners, retry = false) {
    const local = getRepo(repo)
    if (!SHA.test(old)) throw new DeliveryError("approved SHA must be a full commit SHA")
    let current = await view(repo, pr)
    if (current.state === "MERGED") return verifyDelivery(repo, pr, current, old, await integrationBase(repo, pr, old))
    if (current.state !== "OPEN") throw new DeliveryError(`${repo}#${pr} NOT OPEN (${current.state})`, 8)
    if (current.isDraft) throw new DeliveryError("DRAFT: integration requires a published candidate", 8)
    if (current.mergeable === "UNKNOWN") throw new DeliveryError("MERGEABILITY UNKNOWN: wait for provider observation", 75)
    await git(local.checkout, "fetch", "-q", "origin", "main", current.headRefOid, old)
    if (current.mergeStateStatus === "DIRTY" || current.mergeable === "CONFLICTING")
      throw new DeliveryError("CONFLICT with main; needs a builder merge + fresh review", 5)
    const ancestor = await command(["git", "merge-base", "--is-ancestor", "origin/main", current.headRefOid], local.checkout, { allowFailure: true })
    if (ancestor.code) {
      // Integration never inherits a verdict from the pre-integration tree.
      const update = await mutate(repo, "PUT", `pulls/${pr}/update-branch`, { expected_head_sha: current.headRefOid }, owners)
      const integrated = "INTEGRATION UPDATED; needs fresh review and CI of the integrated tree"
      if (update.ok || (await view(repo, pr)).headRefOid !== current.headRefOid) throw new DeliveryError(integrated, 2)
      if (update.transient) throw new DeliveryError("UPDATE-BRANCH: transient service error; head unchanged", 6, true)
      if (update.status === 422) throw new DeliveryError("UPDATE-BRANCH FAILED; needs a builder integration + fresh review", 5)
      throw new DeliveryError(`UPDATE-BRANCH REFUSED (HTTP ${update.status})`, 6)
    }
    const head = current.headRefOid
    if (head !== old) throw new DeliveryError("HEAD CHANGED after integration; needs fresh review", 2)
    const base = await git(local.checkout, "rev-parse", "origin/main")
    await waitChecks(repo, pr, head)
    current = await view(repo, pr)
    if (current.headRefOid !== head) throw new DeliveryError("HEAD MOVED during checks; needs fresh review")
    requireOpen(current)
    if (current.mergeable !== "MERGEABLE") throw new DeliveryError("MERGEABILITY NOT READY", 75)
    const approval = await latestReview(repo, pr, current)
    const finalCi = await ciFor(repo, current, head)
    requireKnownCi(finalCi)
    if (finalCi.state !== "success") throw new DeliveryError(`NONGREEN on ${head}`, 3)
    if (!approval || approval.verdict !== "APPROVE" || approval.sha !== old)
      throw new DeliveryError(`NO INDEPENDENT APPROVE for ${old}`, 4)
    await requireServerUpToDate(repo)
    await git(local.checkout, "fetch", "-q", "origin", "main")
    if (await git(local.checkout, "rev-parse", "origin/main") !== base)
      throw new DeliveryError("INTEGRATION BASE MOVED; needs fresh integration, review and CI", 2)
    await writeJson(integrationRecord(repo, pr, head), { schema: "factory-integration/v1", repo, pr, head, base })
    const evidence = await mutate(repo, "POST", `issues/${pr}/comments`, { body: `DELIVERY VERIFIED\nSource-SHA: ${head}\nIntegration-Base: ${base}\n\nExact integrated head, independent review and hosted checks verified. ${note}` }, owners)
    if (!evidence.ok) throw new DeliveryError("DELIVERY EVIDENCE REFUSED" + (evidence.transient ? ": transient service error" : ""), 6, evidence.transient)
    const result = await mutate(repo, "PUT", `pulls/${pr}/merge`, { merge_method: "squash", sha: head }, owners)
    if (!result.ok) {
      if (result.transient) {
        const after = await view(repo, pr)
        if (after.state === "MERGED") return verifyDelivery(repo, pr, after, head, base)
        throw new DeliveryError("MERGE REFUSED: transient service error", 6, true)
      }
      // 405/409: the provider's base or head condition failed; observe afresh.
      if (!retry && [405, 409].includes(result.status)) return mergeOne(repo, pr, old, note, owners, true)
      throw new DeliveryError(`MERGE REFUSED (HTTP ${result.status})`, 6)
    }
    if (result.body?.merged !== true || !SHA.test(result.body.sha ?? ""))
      throw new DeliveryError("MERGE acknowledgement missing; reconcile before retry", 7)
    let lastError
    for (let attempt = 0; attempt < 6; attempt++) {
      try { return await verifyDelivery(repo, pr, await view(repo, pr), head, base) }
      catch (error) { if (!error.transient) throw error; lastError = error }
      await pause(config.pollMs)
    }
    throw lastError
  }
  const integrationLane = (repo, fn) => withLease(locks, `merge-${encodeURIComponent(repo)}`, fn)
  const prWriter = (repo, pr, fn) => withLease(locks, `pr-${keyFor(repo, pr)}`, fn)
  async function consumeQueue(repo, lane) {
    const entry = await queueState(queue => queue.find(e => e.repo === repo && !e.outcome && e.availableAt <= Date.now()))
    if (!entry) return { message: "QUEUE IDLE", idle: true }
    let outcome
    try { outcome = pass(await prWriter(entry.repo, entry.pr, writer => mergeOne(entry.repo, entry.pr, entry.head, entry.note, [lane, writer]))) }
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
      const prs = await pages(repo, "pulls?state=open")
      for (const raw of prs) {
        if (raw.base?.ref !== "main") continue
        const current = prValue(raw)
        current.comments = await pages(repo, `issues/${current.number}/comments`)
        if (config.holds.some(h => h.repo === repo && h.regex.test(current.title))) continue
        const approval = await latestReview(repo, current.number, current)
        if (current.state !== "OPEN" || current.baseRefName !== "main" || approval?.verdict !== "APPROVE" ||
          approval.sha !== current.headRefOid) continue
        const ci = await ciFor(repo, current)
        requireKnownCi(ci)
        if (ci.state !== "success") continue
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
    async recoveryCandidates() {
      const dir = path.join(config.stateDir, "waits")
      const names = await fs.readdir(dir).catch(e => { if (e.code === "ENOENT") return []; throw e })
      const candidates = []
      for (const name of names) {
        if (!name.endsWith(".json")) continue
        const record = await readJson(path.join(dir, name))
        if (record.schema !== "factory-delivery-wait/v1" || !config.repos[record.repo] || !Number.isSafeInteger(record.pr) || record.pr <= 0)
          throw new DeliveryError("invalid delivery recovery record", 9)
        if (["suspended", "resumable"].includes(record.status)) candidates.push({ repo: record.repo, pr: record.pr })
      }
      return candidates
    },
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
            await eligible(repo, pr, current.headRefOid)
            current = await waitChecks(repo, pr, current.headRefOid, true)
            const review = await latestReview(repo, pr, current)
            const approved = review?.verdict === "APPROVE" && review.sha === current.headRefOid
            const ci = current.ci
            if (ci.state === "success" && current.mergeable === "UNKNOWN") throw new DeliveryError("MERGEABILITY UNKNOWN: wait for provider observation", 75)
            const ready = approved && current.mergeable === "MERGEABLE" && ci.state === "success"
            data = { head: current.headRefOid, approved, ready, blocked: review?.sha === current.headRefOid && ["REVIEW: BLOCKED", "CHANGES REQUESTED"].includes(review?.verdict) }

            break
          }
          case "review": data = await review(repo, pr); break
          case "readiness": {
            const current = await view(repo, pr)
            requireOpen(current)
            const ci = await ciFor(repo, current, head ?? current.headRefOid)
            data = { head: current.headRefOid, state: ci.state, missing: ci.missing ?? [], nextAction: ci.nextAction }
            break
          }
          case "pr:suspend": data = await suspend(repo, pr, head, request.stop); break
          case "pr:complete": await completeDeliveryWait(config, repo, pr); data = {}; break
          case "fix": case "ci-fix": data = await fix(repo, pr, step, worktree); break
          case "branch-wt": data = { worktree: await branchWorktree(repo, request.branch, request.fallback) }; break
          case "codex-guard": data = await guarded(repo, pr, request.kind, request.argv, getRepo(repo).checkout, ""); break
          case "enqueue": data = await enqueue(repo, pr, head, note); break
          case "auto-enqueue": data = await autoEnqueue(); break
          case "import-legacy": data = await importLegacy(request.root); break
          case "merge-one-core":
            data = await integrationLane(repo, lane => prWriter(repo, pr, writer => mergeOne(repo, pr, head, note ?? "", [lane, writer]))); break
          case "merge-queue": {
            let busy = false
            for (const target of repo ? [repo] : Object.keys(config.repos)) {
              try { data = await integrationLane(target, lane => consumeQueue(target, lane)) }
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
        if (!error.wait) await log({ step, repo, pr, status: "failed", code: error.code ?? 1, message: error.message })
        return fail(error)
      }
    }
  }
}

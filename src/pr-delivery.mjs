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
const FIELDS = "number,title,state,headRefName,headRefOid,mergeStateStatus,mergeable,isDraft,comments,statusCheckRollup,mergeCommit"
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
    autoPollMs: value.autoPollMs ?? 300_000 }
  for (const v of [...Object.values(config.limits), config.pollMs, config.commandTimeoutMs, config.checksTimeoutMs, config.autoPollMs])
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
    // Queue attestations are never evidence of independent review.
    return { verdict, sha, body: c.body, independent: !c.body.includes("Orchestrator merge queue:") }
  }).filter(Boolean)
}
function latestReview(pr) { return reviews(pr).filter(r => r.independent).at(-1) }

export function createPrDeliveryAdapter(config, { env = process.env } = {}) {
  const locks = path.join(config.stateDir, "locks"), queueFile = path.join(config.stateDir, "queue.json")
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
    return value
  }
  async function log(event) {
    await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 })
    await fs.appendFile(path.join(config.stateDir, "delivery.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", { mode: 0o600 })
  }
  async function checkStates(repo, pr) {
    const result = await command(["gh", "pr", "checks", String(pr), "-R", repo, "--json", "state"], getRepo(repo).checkout, { allowFailure: true })
    if (result.timedOut || ![0, 1, 8].includes(result.code) || !result.stdout.trim())
      throw new DeliveryError("GitHub checks unavailable: transient service error", 1, true)
    let states
    try { states = JSON.parse(result.stdout) } catch { throw new DeliveryError("invalid GitHub checks response", 1, true) }
    if (!Array.isArray(states) || states.some(c => typeof c.state !== "string"))
      throw new DeliveryError("invalid GitHub checks response", 1, true)
    return states
  }
  async function waitChecks(repo, pr, head, completedOnly = false) {
    const until = Date.now() + config.checksTimeoutMs
    while (true) {
      const current = await view(repo, pr)
      if (current.headRefOid !== head) throw new DeliveryError("HEAD MOVED during checks; needs fresh review", 1)
      const checks = current.statusCheckRollup ?? []
      if (checks.every(c => c.status === "COMPLETED" || c.state === "SUCCESS" || c.state === "FAILURE")) {
        if (completedOnly) return current
        const states = await checkStates(repo, pr)
        if (!states.length || states.some(c => c.state !== "SUCCESS")) throw new DeliveryError(`NONGREEN on ${head}`, 3)
        return current
      }
      if (Date.now() >= until) throw new DeliveryError("CI-WAIT-TIMEOUT", 142)
      await pause(config.pollMs)
    }
  }
  async function branchWorktree(repo, branch, fallback) {
    const local = getRepo(repo)
    if (branch === "main" || branch.startsWith("-")) throw new DeliveryError("refusing to repair main or invalid branch")
    await git(local.checkout, "check-ref-format", "--branch", branch)
    await git(local.checkout, "fetch", "-q", "origin", branch)
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
    const ff = await command(["git", "merge", "-q", "--ff-only", `origin/${branch}`], worktree, { allowFailure: true })
    if (ff.code) throw new DeliveryError(`worktree ${worktree}: ${branch} diverged from origin`)
    return worktree
  }
  async function guarded(repo, pr, kind, argv, cwd, input) {
    const release = await reserveCodex(config, repo, pr, kind)
    try {
      await log({ repo, pr, step: kind, status: "started" })
      const digest = createHash("sha256")
      const result = await command(argv, cwd, { input, timeoutMs: config.limits.timeoutMs, allowFailure: true,
        captureOutput: false, onOutput: chunk => digest.update(chunk) })
      await log({ repo, pr, step: kind, status: result.timedOut ? "TIMEOUT" : result.code ? "failed" : "complete", code: result.code,
        outputDigest: digest.digest("hex") })
      if (result.code) throw new DeliveryError(result.timedOut ? `TIMEOUT ${repo}#${pr}` : `${kind} exited ${result.code}`, result.code)
      return result
    } finally { await release() }
  }
  async function review(repo, pr) {
    const initial = await view(repo, pr)
    const current = await waitChecks(repo, pr, initial.headRefOid, true)
    const local = getRepo(repo), head = current.headRefOid
    await git(local.checkout, "fetch", "-q", "origin", head)
    const dir = path.join(local.worktreeRoot, `review-${pr}-${head}`)
    await fs.mkdir(local.worktreeRoot, { recursive: true })
    await git(local.checkout, "worktree", "add", "-q", "--detach", dir, head)
    const output = path.join(config.stateDir, `review-${keyFor(repo, pr)}.txt`)
    try {
      const prior = reviews(current).filter(r => r.independent && ["REVIEW: BLOCKED", "CHANGES REQUESTED"].includes(r.verdict)).at(-1)
      const prompt = deliveryPrompt("review", { repo, pr, head, prior })
      await fs.rm(output, { force: true })
      await guarded(repo, pr, "review", [config.codex.command ?? "codex", ...createCodexExecArgs(config.codex),
        "--sandbox", "danger-full-access", "--output-last-message", output, "-"], dir, prompt)
      if (await git(dir, "status", "--porcelain", "--untracked-files=no"))
        throw new DeliveryError("reviewer edited tracked source; refusing approval, worktree retained")
      const body = await fs.readFile(output, "utf8")
      const parsed = reviews({ comments: [{ body }] })[0]
      if (!parsed || parsed.sha !== head || !["APPROVE", "REVIEW: BLOCKED"].includes(parsed.verdict))
        throw new DeliveryError("invalid reviewer comment format or Reviewed-SHA")
      if ((await view(repo, pr)).headRefOid !== head) throw new DeliveryError("HEAD MOVED during review; needs fresh review")
      await gh(repo, pr, "comment", "--body", body)
      return { head, verdict: parsed.verdict }
    } finally {
      // Test artifacts may be untracked; keep a modified tracked source tree for
      // diagnosis rather than silently discarding an agent's prohibited edit.
      if (!(await git(dir, "status", "--porcelain", "--untracked-files=no")))
        await git(local.checkout, "worktree", "remove", "--force", dir)
    }
  }
  async function fix(repo, pr, kind, worktree) {
    const current = await view(repo, pr)
    const fallback = worktree && worktree !== "-" ? path.resolve(worktree) : path.join(getRepo(repo).worktreeRoot, `fix-${pr}`)
    const cwd = await branchWorktree(repo, current.headRefName, fallback)
    await git(cwd, "fetch", "-q", "origin")
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
  async function enqueue(repo, pr, head, note = "", deduplicate = false) {
    getRepo(repo)
    if (!SHA.test(head)) throw new DeliveryError("approved SHA must be a full commit SHA")
    return queueState(queue => {
      if (!deduplicate || !queue.some(e => e.repo === repo && e.pr === pr && e.head === head))
        queue.push({ id: randomUUID(), repo, pr, head, note: note.replaceAll("\n", " "), attempts: 0, availableAt: 0 })
      return { message: `QUEUED ${repo}#${pr} ${head}` }
    })
  }
  async function mergeOne(repo, pr, old, note = "", retry = false) {
    const local = getRepo(repo)
    if (!SHA.test(old)) throw new DeliveryError("approved SHA must be a full commit SHA")
    let current = await view(repo, pr)
    if (current.state === "MERGED") return { message: `${repo}#${pr} ALREADY MERGED` }
    if (current.state !== "OPEN") throw new DeliveryError(`${repo}#${pr} NOT OPEN (${current.state})`, 8)
    await git(local.checkout, "fetch", "-q", "origin", "main", current.headRefOid, old)
    if (current.mergeStateStatus === "DIRTY" || current.mergeable === "CONFLICTING")
      throw new DeliveryError("CONFLICT with main; needs a builder merge + fresh review", 5)
    const ancestor = await command(["git", "merge-base", "--is-ancestor", "origin/main", current.headRefOid], local.checkout, { allowFailure: true })
    if (ancestor.code) {
      await gh(repo, pr, "update-branch")
      current = await view(repo, pr)
      await git(local.checkout, "fetch", "-q", "origin", current.headRefOid)
    }
    const head = current.headRefOid
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
    await waitChecks(repo, pr, head)
    current = await view(repo, pr)
    if (current.headRefOid !== head) throw new DeliveryError("HEAD MOVED during checks; needs fresh review")
    const approval = latestReview(current)
    if (!approval || approval.verdict !== "APPROVE" || approval.sha !== old)
      throw new DeliveryError(`NO INDEPENDENT APPROVE for ${old}`, 4)
    await gh(repo, pr, "comment", "--body", `APPROVE\nReviewed-SHA: ${head}\n\nOrchestrator merge queue: exact head verified, independent approval of ${old}, all hosted checks green. ${head !== old ? "Deterministic re-approval: every intervening commit is an automatic main merge with matching tree." : ""} ${note}`)
    if (current.isDraft) await gh(repo, pr, "ready")
    const result = await command(["gh", "pr", "merge", String(pr), "-R", repo, "--squash", "--match-head-commit", head], local.checkout, { allowFailure: true })
    if (result.code) {
      if (!retry && result.stderr.includes("not up to date")) return mergeOne(repo, pr, old, note, true)
      throw new DeliveryError("MERGE REFUSED" + (/GraphQL|rate limit|timed out|502/i.test(result.stderr) || result.timedOut ? ": transient service error" : ""), 6,
        /GraphQL|rate limit|timed out|502/i.test(result.stderr) || result.timedOut)
    }
    for (let attempt = 0; attempt < 6; attempt++) {
      const merged = await view(repo, pr), commit = merged.mergeCommit?.oid
      await git(local.checkout, "fetch", "-q", "origin", "main")
      if (SHA.test(commit ?? "") && !(await command(["git", "merge-base", "--is-ancestor", commit, "origin/main"], local.checkout, { allowFailure: true })).code)
        return { message: `${repo}#${pr} MERGED ${commit} (on main)`, mergeCommit: commit }
      await pause(config.pollMs)
    }
    throw new DeliveryError("MERGE NOT ON MAIN", 7)
  }
  async function consumeQueue() {
    const entry = await queueState(queue => queue.find(e => !e.outcome && e.availableAt <= Date.now()))
    if (!entry) return { message: "QUEUE IDLE", idle: true }
    let outcome
    try { outcome = pass(await mergeOne(entry.repo, entry.pr, entry.head, entry.note)) }
    catch (e) { outcome = fail(e) }
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
      const prs = JSON.parse((await command(["gh", "pr", "list", "-R", repo, "--state", "open", "--json", FIELDS, "--limit", "50"], getRepo(repo).checkout)).stdout)
      for (const current of prs) {
        if (config.holds.some(h => h.repo === repo && h.regex.test(current.title))) continue
        const approval = latestReview(current), checks = current.statusCheckRollup ?? []
        if (approval?.verdict !== "APPROVE" || approval.sha !== current.headRefOid || !checks.length ||
          checks.some(c => !["SUCCESS", "SKIPPED", "NEUTRAL"].includes(c.conclusion))) continue
        await enqueue(repo, current.number, current.headRefOid, "auto-enqueued: approved head + green", true)
        count++
      }
    }
    return { message: `AUTO-ENQUEUED ${count}` }
  }
  async function importLegacy(root) {
    // Only the orchestrator calls this during cutover, with both old writers
    // stopped. Source records are read; this module never writes into root.
    const text = async file => {
      try { return await fs.readFile(path.join(root, file), "utf8") }
      catch (e) { if (e.code === "ENOENT") return ""; throw e }
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
    const names = await fs.readdir(path.join(root, "budget")).catch(e => { if (e.code === "ENOENT") return []; throw e })
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
    for (const entry of pending) await enqueue(entry.repo, entry.pr, entry.head, entry.note, true)
    return { message: `IMPORTED pending queue and recent usage; source unchanged` }
  }
  return {
    config,
    async exclusive(repo, pr, fn) {
      getRepo(repo)
      return withLease(locks, `pr-${keyFor(repo, pr)}`, fn)
    },
    async execute(step, request = {}) {
      const { repo, pr, head, worktree, note } = request
      try {
        if (repo) getRepo(repo)
        let data
        switch (step) {
          case "pr:inspect": {
            const current = await view(repo, pr), review = latestReview(current)
            const approved = review?.verdict === "APPROVE" && review.sha === current.headRefOid
            const states = approved ? await checkStates(repo, pr) : []
            const ready = approved && current.mergeable !== "CONFLICTING" && states.length > 0 && states.every(c => c.state === "SUCCESS")
            data = { head: current.headRefOid, approved, ready, blocked: review?.verdict === "REVIEW: BLOCKED" }
            break
          }
          case "review": data = await review(repo, pr); break
          case "fix": case "ci-fix": data = await fix(repo, pr, step, worktree); break
          case "branch-wt": data = { worktree: await branchWorktree(repo, request.branch, request.fallback) }; break
          case "codex-guard": data = await guarded(repo, pr, request.kind, request.argv, getRepo(repo).checkout, ""); break
          case "enqueue": data = await enqueue(repo, pr, head, note); break
          case "auto-enqueue": data = await autoEnqueue(); break
          case "import-legacy": data = await importLegacy(request.root); break
          case "merge-one-core": data = await withLease(locks, "merge-owner", () => mergeOne(repo, pr, head, note)); break
          case "merge-queue": data = await withLease(locks, "merge-owner", consumeQueue); break
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

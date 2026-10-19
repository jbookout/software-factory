import { deliveryStatus } from "./delivery-daemon.mjs"
import { createGitHubObservation } from "./github-observation.mjs"
import { AsyncLocalStorage } from "node:async_hooks"
import { Deadline, DeadlineError, waitForCondition, validDuration } from "./deadline.mjs"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHash, randomUUID } from "node:crypto"
import { reserveCompute } from "./process-capacity.mjs"
import { runProcess, validateProcessRequest, observeProcessJob } from "./process-runner.mjs"
import { createCodexExecArgs } from "./codex-build.mjs"
import { normalizeResult } from "./adapters.mjs"
import { deliveryPrompt } from "./pr-delivery-prompts.mjs"
import { deliveryEffectId, isDeliveryBinding } from "./evidence.mjs"
import { validRequiredChecks } from "./pr-readiness.mjs"
import { createGithubProvider } from "./github-snapshot.mjs"
import { DeliveryError, keyFor, readJson, writeJson, withLease, reserveCodex, deliveryWait, completeDeliveryWait, orphanLeaseCount } from "./pr-delivery-state.mjs"

const DEFAULT_MODELS = fileURLToPath(new URL("../config/delivery-models.v1.json", import.meta.url))
const MODEL_ROLES = ["fix", "ci-fix"]
const SHA = /^[0-9a-f]{40}$/
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const nonemptyText = value => typeof value === "string" && value.trim().length > 0
const digestOf = value => createHash("sha256").update(value).digest("hex")
const effectIdentity = (repo, pr, head, action, fields) => deliveryEffectId({ repo, pr, head, action: `${action}:${digestOf(JSON.stringify(fields))}` })
const pass = data => normalizeResult({ status: "pass", data }, "delivery")
const fail = error => normalizeResult({ status: "fail",
  data: { code: Number.isInteger(error.code) ? error.code : 1, message: error.message, transient: error.transient ?? false,
    ...(error.observation ?? {}),
    ...(error.cancelled ? { cancelled: true, nextAction: "none" } : {}),
    ...(error.state ? { state: error.state, pool: error.pool, retryAt: error.retryAt, queryErrors: error.queryErrors, terminal: error.terminal, nextAction: "wait-for-provider-observation" } : {}),
    ...(error.pendingUpdate ? { pendingUpdate: true } : {}),
    ...(error.phase ? { phase: error.phase, nextAction: error.nextAction } : {}),
    ...(error.uncertain ? { uncertain: true, nextAction: "readback-before-retry" } : {}),
    ...(error.wait ? { cause: error.wait.cause, resetAt: error.wait.resetAt, head: error.wait.head, nextAction: error.wait.cause === "mutation-uncertain" ? "readback-before-retry" : "wait-for-input-or-reset", admitted: false } : {}) },
  findings: [{ reason: error.message }] }, "delivery")

export async function loadDeliveryConfig(file) {
  const value = await readJson(file)
  if (!value || !value.repos || !Object.keys(value.repos).length) throw new DeliveryError("config.repos is required", 9)
  const base = path.dirname(path.resolve(file))
  const absolute = p => {
    if (typeof p !== "string" || !p.trim()) throw new DeliveryError("config path is required", 9)
    return path.resolve(base, p)
  }
  const config = { ...value, configFile: path.resolve(file), stateDir: absolute(value.stateDir),
    repos: Object.fromEntries(Object.entries(value.repos).map(([repo, local]) => {
      if (!REPO.test(repo)) throw new DeliveryError("invalid repository in config", 9)
      if (!validRequiredChecks(local.requiredChecks)) throw new DeliveryError("config repo requiredChecks must name the expected checks", 9)
      if (local.checks !== undefined && (!Array.isArray(local.checks) || !local.checks.length))
        throw new DeliveryError("config repo checks must be nonempty argv commands", 9)
      if(local.checkTimeoutMs !== undefined && !validDuration(local.checkTimeoutMs)) throw new DeliveryError("invalid repository check timeout",9)
      for (const argv of local.checks ?? []) {
        try {validateProcessRequest(argv)}
        catch {throw new DeliveryError("config repo checks must be valid argv commands",9)}
      }
      if (local.dependencyRevision !== undefined && (typeof local.dependencyRevision !== "string" || !local.dependencyRevision.trim()))
        throw new DeliveryError("config dependencyRevision must be a nonempty owned input pin", 9)
      return [repo, { ...local, checkout: absolute(local.checkout), worktreeRoot: absolute(local.worktreeRoot) }]
    })),
    limits: { runsPer24h: 8, slots: 4, timeoutMs: 4500_000, ...value.limits },
    pollMs: value.pollMs ?? 30_000, commandTimeoutMs: value.commandTimeoutMs ?? 120_000,
    checksTimeoutMs: value.checksTimeoutMs ?? 3600_000, retryMs: value.retryMs ?? 120_000,
    autoPollMs: value.autoPollMs ?? 300_000, queueRunsPer24h: value.queueRunsPer24h ?? 4 }
  config.github = { requestsPerHour: 1000, cacheMs: 60_000, ...value.github }
  if (!Number.isSafeInteger(config.github.requestsPerHour) || config.github.requestsPerHour <= 0 ||
      !validDuration(config.github.cacheMs, 0)) throw new DeliveryError("invalid GitHub request budget/cache configuration", 9)
  config.queueTimeoutMs = value.queueTimeoutMs ?? config.limits.timeoutMs
  config.apiTimeoutMs = value.apiTimeoutMs ?? config.commandTimeoutMs
  config.attemptTimeoutMs = value.attemptTimeoutMs ?? config.checksTimeoutMs + config.queueTimeoutMs + config.limits.timeoutMs + 600_000
  for (const v of [config.limits.runsPer24h, config.limits.slots, config.queueRunsPer24h])
    if (!Number.isSafeInteger(v) || v <= 0) throw new DeliveryError("config limits must be positive integers", 9)
  for (const ms of [config.limits.timeoutMs, config.pollMs, config.commandTimeoutMs, config.checksTimeoutMs,
    config.autoPollMs, config.queueTimeoutMs, config.apiTimeoutMs, config.attemptTimeoutMs])
    if (!validDuration(ms)) throw new DeliveryError("config duration exceeds supported timer range", 9)
  if (!validDuration(config.retryMs, 0)) throw new DeliveryError("invalid retryMs", 9)
  if (value.resources) {
    config.resources = { browserConcurrency: 1, agentUnits: 1, ...value.resources }
    for (const v of [config.resources.capacity, config.resources.browserConcurrency, config.resources.agentUnits]) if (!Number.isSafeInteger(v) || v <= 0)
      throw new DeliveryError("resource limits must be positive integers", 9)
    if (config.resources.agentUnits + config.resources.browserConcurrency > config.resources.capacity)
      throw new DeliveryError("agent and child reservation exceeds capacity", 9)
  }
  config.models = (await readJson(value.modelsFile ? absolute(value.modelsFile) : DEFAULT_MODELS, null))?.roles
  for (const role of MODEL_ROLES) {
    try { createCodexExecArgs(config.models?.[role]) }
    catch { throw new DeliveryError(`model roles file must name model and effort for ${role}`, 9) }
  }
  return config
}

export function createPrDeliveryAdapter(config, { env = process.env, onTransition = async () => {} } = {}) {
  const locks = path.join(config.stateDir, "locks"), queueFile = path.join(config.stateDir, "queue.json")
  const github = createGitHubObservation(config)
  const prLeases = new Map()
  const cancelFile = path.join(config.stateDir, "cancellations.json")
  const deadlines = new AsyncLocalStorage()
  const inAttempt = fn => deadlines.getStore() ? fn() : deadlines.run(new Deadline(config.attemptTimeoutMs), fn)
  const budget = () => deadlines.getStore()
  async function measured(phase, repo, pr, fn) {
    const start = budget().clock.now()
    let code = 0
    try { return await fn() } catch (error) { code = Number.isInteger(error.code) ? error.code : 1; throw error }
    finally { await log({ repo, pr, step: phase, phase, status: code ? "stopped" : "complete", code,
      durationMs: Math.round(budget().clock.now() - start) }) }
  }

  const getRepo = repo => {
    if (!Object.hasOwn(config.repos, repo)) throw new DeliveryError(`UNKNOWN REPO ${repo}: add checkout and worktreeRoot to config.repos`, 9)
    return config.repos[repo]
  }
  async function command(argv, cwd, { allowFailure = false, timeoutMs = config.commandTimeoutMs, input = "", env: childEnv, ...streamOptions } = {}) {
    budget()?.check()
    const boundedMs = Math.max(1, Math.floor(Math.min(timeoutMs, budget()?.remaining() ?? timeoutMs)))
    const mutation = streamOptions.mutation ?? (argv[0] === "gh" && argv[1] !== "api" ||
      argv[0] === "git" && !["rev-parse", "status", "show", "show-ref", "merge-base", "merge-tree", "check-ref-format", "symbolic-ref"].includes(argv[1]) && !(argv[1] === "worktree" && argv[2] === "list") && !(argv[1] === "remote" && argv[2] === "get-url"))
    const result = await runProcess(argv, { cwd, env: { ...env, ...childEnv, FACTORY_PR_CONFIG: config.configFile, ...(config.resources ? {
      FACTORY_BROWSER_CONCURRENCY: String(config.resources.browserConcurrency) } : {}) }, timeoutMs: boundedMs, input, signal: budget()?.signal, ...streamOptions, mutation })
    if (result.timedOut || result.cancelled || result.uncertain) {
      const error = result.cancelled ? new DeliveryError("ATTEMPT-CANCELLED", 130)
        : result.timedOut ? new DeadlineError(budget()?.phase ?? "command")
        : new DeliveryError("MUTATION OUTCOME UNKNOWN: readback required", result.signal ? 130 : result.code)
      error.uncertain = result.uncertain
      throw error
    }
    if (result.code && !allowFailure) {
      const transient = /GraphQL|rate limit|Something went wrong|timed out|502/i.test(result.stderr)
      // Diagnostics never echo credential-bearing command output.
      throw new DeliveryError(`${argv[0]} ${argv[1]} failed (${result.code})${transient ? ": transient service error" : ""}`, result.code, transient)
    }
    return result
  }
  const git = async (cwd, ...args) => (await command(["git", ...args], cwd)).stdout.trim()
  const provider = createGithubProvider(config, { command, getRepo, authenticate: async () => false, observer: github, budget,
    withRead: (repo, fn) => {
      const phase = budget().phaseBudget("api", config.apiTimeoutMs)
      return measured("api", repo, undefined, () => deadlines.run(phase, fn))
    } })
  async function observe(repo, pr, options) {
    const snapshot = await provider.snapshot(repo, pr, options)
    await log({ step: "observation", repo, pr, state: snapshot.state,
      observationId: snapshot.observationId, head: snapshot.head?.sha ?? null, base: snapshot.base?.sha ?? null,
      startedAt: snapshot.startedAt, fetchedAt: snapshot.fetchedAt, ...snapshot.metrics, errors: snapshot.errors })
    return snapshot
  }
  function observationError(snapshot) {
    const issue = snapshot.errors[0]
    const error = new DeliveryError(issue.message, issue.code ?? 1, issue.transient)
    if (issue.phase) { error.phase = issue.phase; error.nextAction = issue.nextAction }
    Object.assign(error, issue)
    error.observation = { state: "provider-unknown", errors: snapshot.errors, ...snapshot.metrics }
    return error
  }
  async function view(repo, pr, options) {
    const snapshot = await observe(repo, pr, options)
    if (snapshot.state !== "known") throw observationError(snapshot)
    supportedBase(snapshot)
    return { ...snapshot, state: snapshot.prState }
  }
  async function fresh(repo, pr, before) {
    const current = await view(repo, pr)
    if (JSON.stringify(current.head) !== JSON.stringify(before.head) ||
        JSON.stringify(current.base) !== JSON.stringify(before.base) || current.state !== before.state) {
      await log({ step: "precondition", repo, pr, staleActions: 1, nextAction: "observe-current-head" })
      throw new DeliveryError("HEAD MOVED or BASE MOVED before action; observe current bindings", 1, true)
    }
    return current
  }
  function requireKnownCi(ci) {
    if (ci.state === "provider-unknown") throw Object.assign(new DeliveryError("invalid hosted checks response", 1), { state: "unknown" })
    if (ci.state === "superseded") throw new DeliveryError("SUPERSEDED: HEAD MOVED during checks; observe current head", 1)
  }
  function supportedBase(pr) {
    if (pr.baseRefName !== "main") throw new DeliveryError("unsupported PR base: delivery target must be main", 9)
  }
  function requireOpen(pr) {
    if (pr.state !== "OPEN") throw new DeliveryError(`NOT OPEN (${pr.state}): no repair or review work`, 8)
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
    const wait = await deliveryWait(config, repo, pr, input, { repo, pr, ...stop }, budget())
    if (wait.recorded) await log({ repo, pr, step: "wait", status: "suspended", ...input, ...stop })
    return wait
  }
  async function eligible(repo, pr, head) {
    await deliveryWait(config, repo, pr, await waitInput(repo, pr, head), null, budget())
  }
  async function waitChecks(repo, pr, head, completedOnly = false, initial) {
    const phase = budget().phaseBudget("readiness", config.checksTimeoutMs)
    return measured("readiness", repo, pr, () => deadlines.run(phase, () => waitForCondition(async () => {
      const current = initial ?? await view(repo, pr)
      initial = null
      requireOpen(current)
      if (current.headRefOid !== head) throw new DeliveryError("HEAD MOVED during checks; observe the new candidate", 1)
      const ci = current.ci
      requireKnownCi(ci)
      if (ci.state === "failure" && !ci.repairable) throw new DeliveryError("CI REQUIRED CHECK REFUSED: rerun current required check", 3)
      if (ci.state !== "pending" && !completedOnly && ci.state !== "success") throw new DeliveryError(`NONGREEN on ${head}`, 3)
      current.ci = ci
      return current
    }, { budget: phase, boundedProbe: true, ready: value => value.ci.state !== "pending", pollMs: config.pollMs })))
  }
  async function verifyOrigin(repo,local) {
    const origin = await git(local.checkout, "remote", "get-url", "origin")
    const identity = origin.replace(/^git@github\.com:/, "").replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "")
    if (local.originUrl ? origin !== local.originUrl : identity !== repo)
      throw new DeliveryError("repair repository binding does not match configured origin")
  }
  async function branchWorktree(repo, branch, fallback, observedHead) {
    const local = getRepo(repo)
    await verifyOrigin(repo,local)
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
    if (await fs.realpath(worktree) === await fs.realpath(local.checkout))
      throw new DeliveryError("refusing to run a fixer in the canonical checkout", 4)
    const ff = await command(["git", "merge", "-q", "--ff-only", `origin/${branch}`], worktree, { allowFailure: true })
    if (ff.code) throw new DeliveryError(`worktree ${worktree}: ${branch} diverged from origin`)
    if (await git(worktree, "rev-parse", "HEAD") !== remoteHead) throw new DeliveryError("repair source binding mismatch; retained")
    return worktree
  }
  const codexArgv = (role, ...extra) => [config.codex?.command ?? "codex", ...createCodexExecArgs(config.models[role]), ...extra]
  async function retriggerCi(repo, pr) {
    const current = await view(repo, pr)
    requireOpen(current)
    const file = path.join(config.stateDir, "retriggers", `${keyFor(repo, pr)}.json`)
    const prior = await readJson(file, null)
    if (prior && prior.state !== "acknowledged") {
      if (current.headRefOid === prior.newHead) {
        await writeJson(file, { ...prior, state: "acknowledged" })
        return { retriggered: true, head: current.headRefOid }
      }
      throw new DeliveryError("CI RETRIGGER UNCERTAIN: inspect Git API intent before retry", 75)
    }
    if (prior?.newHead === current.headRefOid || !current.ci.cancelled)
      return { retriggered: false, head: current.headRefOid }
    if (current.isCrossRepository !== false) throw new DeliveryError("CI retrigger requires an owned repository branch", 9)
    await requireNotCancelled(repo, pr, current.headRefOid)
    const commit = (await provider.request(repo, `git/commits/${current.headRefOid}`)).value
    if (!SHA.test(commit?.tree?.sha ?? "")) throw new DeliveryError("CI retrigger source tree missing", 9)
    let record = { schema: "factory-ci-retrigger/v1", repo, pr, head: current.headRefOid, branch: current.headRefName,
      tree: commit.tree.sha, state: "requested" }
    await fresh(repo, pr, current)
    const owners = [prLeases.get(keyFor(repo, pr))].filter(Boolean)
    const fields = { message: "ci: retrigger checks cancelled by the GitHub Actions outage", tree: record.tree, parents: [record.head],
      author: { name: "jbookout", email: "64207374+jbookout@users.noreply.github.com" } }
    await writeJson(file, record)
    const created = await provider.mutate(repo, "POST", "git/commits", fields, owners)
    if (!created.ok || !SHA.test(created.value?.sha ?? "")) throw new DeliveryError("CI RETRIGGER CREATE UNCONFIRMED: inspect persisted intent", 75)
    record = { ...record, newHead: created.value.sha, state: "commit-created" }
    await writeJson(file, record)
    await fresh(repo, pr, current)
    const updated = await provider.mutate(repo, "PATCH", `git/refs/heads/${record.branch.split("/").map(encodeURIComponent).join("/")}`,
      { sha: record.newHead, force: false }, owners)
    const observed = await view(repo, pr)
    if (observed.headRefOid !== record.newHead) throw new DeliveryError(`CI RETRIGGER REF UNCONFIRMED (HTTP ${updated.status}); inspect persisted intent`, 75)
    await writeJson(file, { ...record, state: "acknowledged" })
    return { retriggered: true, head: record.newHead }
  }
  async function guarded(repo, pr, kind, argv, cwd, input, head, afterExecution, beforeExecution, route = null, attemptDirectory) {
    if (!["review", "fix", "ci-fix", "rescope"].includes(kind)) throw new DeliveryError("invalid guarded delivery kind", 9)
    validateProcessRequest(argv, config.limits.timeoutMs)
    await fs.mkdir(path.join(config.stateDir,"attempts"),{recursive:true,mode:0o700})
    attemptDirectory ??= await fs.mkdtemp(path.join(config.stateDir,"attempts","job-"))
    head ??= (await view(repo, pr)).headRefOid
    await eligible(repo, pr, head)
    await requireNotCancelled(repo, pr, head)
    const attemptId = randomUUID()
    const effectId = deliveryEffectId({ repo, pr, head, action: kind + ":" + attemptId })
    let release, compute, mutationPending = false
    try {
      if (!config.resources) throw new DeliveryError("resource configuration required before child admission", 9)
      const queue = budget().phaseBudget("queue", config.queueTimeoutMs)
      await measured("queue", repo, pr, async () => {
        compute = await reserveCompute(config,
          config.resources.agentUnits + config.resources.browserConcurrency, queue, { agentUnits: config.resources.agentUnits })
        const admission = { beforeAdmission: () => requireNotCancelled(repo, pr, head), identity: { attemptId, effectId, head } }
        release = await reserveCodex(config, repo, pr, kind, queue, admission)
      })
      const admitted = await view(repo, pr)
      requireOpen(admitted)
      if (admitted.headRefOid !== head) throw new DeliveryError("SUPERSEDED: HEAD MOVED before child dispatch; observe current head", 1)
      await log({ repo, pr, head, step: kind, status: "started", attemptId: release.attemptId,
        effectId })
      const jobId = randomUUID()
      const job = {id:jobId, ownership:"caller", worktree:cwd, model:route?.model ?? "external", effort:route?.effort ?? "external",
        log:path.join(attemptDirectory,"worker.log"), receipt:path.join(attemptDirectory,"worker.json")}
      const digest = createHash("sha256")
      // Persist before launch: if the controller disappears there is no final
      // callback to write uncertainty. A completed child retires this marker.
      if (kind !== "review") {
        const { budgetAvailable, ...inputBinding } = await waitInput(repo, pr, head)
        await deliveryWait(config, repo, pr, inputBinding, { repo, pr, cause: "mutation-uncertain", code: 130,
          message: "MUTATION UNCERTAIN: readback required before retry", resetAt: null }, budget())
        mutationPending = true
      }
      await beforeExecution?.(job)
      const result = await launchFence(repo, pr, head, () => {
        const runBudget = budget().phaseBudget("execution", config.limits.timeoutMs)
        return measured("execution", repo, pr, () => deadlines.run(runBudget, () => command(argv, cwd, { input, timeoutMs: config.limits.timeoutMs, allowFailure: true,
          env:{...env,TMPDIR:attemptDirectory,FACTORY_ATTEMPT_DIR:attemptDirectory}, job, onStarted: receipt => log({repo,pr,step:kind,status:"running",jobId:receipt.id,receipt:job.receipt}),
          mutation: kind !== "review", captureOutput: false, onOutput: chunk => digest.update(chunk), onSpawn: async (job, signal) => {
            await requireNotCancelled(repo, pr, head)
            const bindings = [await release.bindJob(job, signal), ...await compute.bindJob(job, signal)]
            const prLease = prLeases.get(keyFor(repo, pr))
            if (prLease) bindings.push(await prLease.bindJob(job, signal))
            return bindings
          } })))
      })
      if (mutationPending && (!afterExecution || result.code)) { await completeDeliveryWait(config, repo, pr, budget()); mutationPending = false }
      const outputDigest = digest.digest("hex")
      await log({ repo, pr, step: kind, status: result.code ? "failed" : "complete", code: result.code,
        outputDigest })
      if (result.code) {
        const hold = await github.activeHold()
        if (hold) throw hold
      }
      if (result.code) throw new DeliveryError(`${kind} exited ${result.code}`, result.code)
      const completed = afterExecution ? await afterExecution(compute) : { ...result, outputDigest }
      if (mutationPending) { await completeDeliveryWait(config, repo, pr, budget()); mutationPending = false }
      return completed
    } catch (error) {
      if (mutationPending && error.uncertain === false)
        await completeDeliveryWait(config, repo, pr, budget())
      if (budget().remaining() && error.phase === "queue" && error.code === 142)
        error.wait = await suspend(repo, pr, head, { cause: "slot-wait", code: 142, message: error.message, resetAt: null })
      if (budget().remaining() && error.uncertain)
        error.wait = await suspend(repo, pr, head, { cause: "mutation-uncertain", code: error.code, message: "MUTATION UNCERTAIN: readback required before retry", resetAt: null })
      if (budget().remaining() && error.code === 75 && !error.state && !error.message.startsWith("BUSY:"))
        error.wait = await suspend(repo, pr, head, { cause: error.cause ?? "capacity-refused", code: 75, message: error.message, resetAt: error.resetAt ?? null })
      throw error
    } finally {
      await measured("cleanup", repo, pr, async () => {
        if (release) await release()
        if (compute) await compute()
      })
    }
  }
  const repairFile = (repo, pr) => path.join(config.stateDir,"repairs",`${keyFor(repo,pr)}.json`)
  const checkPolicyFor = local => digestOf(JSON.stringify({checks:local.checks,timeoutMs:local.checkTimeoutMs ?? config.checksTimeoutMs}))
  async function verifyRepairSource(repo,pr,record) {
    const local=getRepo(repo),cwd=record.worktree
    if(record.schema!=="factory-repair-delivery/v1" || record.repo!==repo || record.pr!==pr ||
       await git(cwd,"rev-parse","--path-format=absolute","--git-common-dir")!==
       await git(local.checkout,"rev-parse","--path-format=absolute","--git-common-dir"))
      throw new DeliveryError("repair receipt repository binding mismatch",9)
    await verifyOrigin(repo,local)
    if(await git(cwd,"symbolic-ref","--short","HEAD")!==record.branch ||
       await git(cwd,"rev-parse","HEAD")!==record.head || await git(cwd,"rev-parse","HEAD^{tree}")!==record.tree ||
       await git(cwd,"status","--porcelain"))throw new DeliveryError("repair source changed; retain worktree and reconcile",9)
  }
  async function repairRemote(repo,record) {
    const local=getRepo(repo),cwd=record.worktree
    await verifyOrigin(repo,{...local,checkout:cwd})
    const fetchUrl=await git(cwd,"remote","get-url","origin")
    const destinations=(await git(cwd,"remote","get-url","--push","--all","origin")).split("\n")
    if(destinations.length!==1 || destinations[0]!==fetchUrl)
      throw new DeliveryError("repair push destination differs from bound origin",9)
    record.pushDestination=destinations[0]
    const transport=repairTransport(record.pushDestination)
    return (await git(cwd,...transport.options,"ls-remote","--heads",transport.remote,`refs/heads/${record.branch}`)).split(/\s+/)[0]
  }
  function repairTransport(destination) {
    const remote=`factory-repair-${randomUUID()}`,alias=`${remote}:`
    // Git expands this exact alias once. Explicit pushurl skips pushInsteadOf;
    // neither observation nor push feeds the expanded URL back through rewrites.
    return {remote,options:["-c",`url.${destination}.insteadOf=${alias}`,
      "-c",`remote.${remote}.url=${alias}`,"-c",`remote.${remote}.pushurl=${alias}`]}
  }
  async function repairObservation(repo,pr,record,heads) {
    const current=await view(repo,pr)
    requireOpen(current)
    if(current.isCrossRepository!==false || current.head.repo!==repo || current.headRefName!==record.branch ||
       current.base.repo!==record.base.repo || current.base.ref!==record.base.ref || current.base.sha!==record.base.sha ||
       !heads.includes(current.headRefOid))throw new DeliveryError("repair PR source/base binding moved; reconcile retained source",9)
    return current
  }
  async function terminalJob(job,label) {
    const observed=await observeProcessJob(job.receipt)
    if(["starting","running","startup_unconfirmed"].includes(observed.status))
      throw new DeliveryError(`${label} INCOMPLETE: observe job receipt before retry`,75)
    if(observed.id!==job.id || observed.worktree!==job.worktree || observed.ownership!=="caller")
      throw new DeliveryError(`${label} job binding mismatch`,9)
    return observed
  }
  async function finishRepair(repo, pr, record, ownedCompute) {
    const local=getRepo(repo),cwd=record.worktree,file=repairFile(repo,pr)
    const persist=async status=>{record={...record,status};await writeJson(file,record)}
    await verifyRepairSource(repo,pr,record)
    let remoteHead=await repairRemote(repo,record)
    // A checked push may have succeeded before its controller died. Any earlier
    // publication is an observed contract violation, never an unpushed claim.
    if(remoteHead!==record.baseHead && !(record.testedHead===record.head && remoteHead===record.head)) {
      record.remoteHead=remoteHead;await persist("early_publication")
      throw new DeliveryError("EARLY PUBLICATION: remote changed before runner-owned checks; reconcile published source",9)
    }
    await repairObservation(repo,pr,record,[record.baseHead,...(record.testedHead===record.head?[record.head]:[])])
    const checkPolicy=checkPolicyFor(local)
    if(record.checkPolicy!==checkPolicy)delete record.testedHead
    if(record.checkJob)await terminalJob(record.checkJob,"CHECK")
    if(record.testedHead!==record.head) {
      let compute
      try {
        compute=ownedCompute ?? await reserveCompute(config,config.resources.browserConcurrency,budget().phaseBudget("queue",config.queueTimeoutMs))
        record.checks=[]
        for(const argv of local.checks) {
          const id=randomUUID()
          await fs.mkdir(path.join(config.stateDir,"attempts"),{recursive:true,mode:0o700})
          const attemptDirectory=await fs.mkdtemp(path.join(config.stateDir,"attempts","check-"))
                record.checkJob={id,ownership:"caller",worktree:cwd,model:"repository-check",effort:"deterministic",
            log:path.join(attemptDirectory,"check.log"),receipt:path.join(attemptDirectory,"check.json")}
          record.checkPolicy=checkPolicy
          await persist("checking")
          let result
          try {
            result=await command(argv,cwd,{allowFailure:true,timeoutMs:local.checkTimeoutMs ?? config.checksTimeoutMs,
              env:{...env,TMPDIR:attemptDirectory,FACTORY_ATTEMPT_DIR:attemptDirectory},job:record.checkJob,captureOutput:false,onSpawn:async(job,signal)=>{
                const bindings=[...await compute.bindJob(job,signal)]
                const owner=prLeases.get(keyFor(repo,pr));if(owner)bindings.push(await owner.bindJob(job,signal))
                return bindings
              }})
          } catch(error){await persist("check_interrupted");throw error}
          record.checks.push({argv,code:result.code,receipt:record.checkJob.receipt})
          remoteHead=await repairRemote(repo,record)
          if(remoteHead!==record.baseHead) {
            record.remoteHead=remoteHead;await persist("early_publication")
            throw new DeliveryError("EARLY PUBLICATION: remote changed during runner checks",9)
          }
          if(result.code) {
            record.remoteHead=remoteHead;await persist("check_failed")
            throw new DeliveryError(`repository check failed (${result.code}); source unpushed at observed remote ${remoteHead}`,result.code)
          }
          delete record.checkJob
          await verifyRepairSource(repo,pr,record)
        }
        record.testedHead=record.head;record.checkPolicy=checkPolicy
      } finally {if(compute && !ownedCompute)await compute()}
    }
    await verifyRepairSource(repo,pr,record)
    remoteHead=await repairRemote(repo,record)
    if(![record.baseHead,record.head].includes(remoteHead))throw new DeliveryError("repair remote moved before publication",9)
    await repairObservation(repo,pr,record,[remoteHead])
    await persist("push_pending")
    if(remoteHead!==record.head) {
      const transport=repairTransport(record.pushDestination)
      await launchFence(repo,pr,record.baseHead,()=>command(["git",...transport.options,"push",transport.remote,`${record.head}:refs/heads/${record.branch}`],cwd,
        {onSpawn:async(job,signal)=>{const owner=prLeases.get(keyFor(repo,pr));return owner?[await owner.bindJob(job,signal)]:[]}}))
    }
    record.remoteHead=await repairRemote(repo,record)
    if(record.remoteHead!==record.head)throw new DeliveryError("PUSH PENDING: remote head differs from tested source",1)
    await repairObservation(repo,pr,record,[record.head])
    record={...record,status:"delivered"};await writeJson(file,record)
    await log({repo,pr,step:"repair-delivery",status:"delivered",head:record.head,remoteHead:record.remoteHead})
    return {head:record.head}
  }
  async function reconcileBuilder(repo,pr,record) {
    const job=await terminalJob(record.builderJob,"BUILDER"),cwd=record.worktree
    const head=await git(cwd,"rev-parse","HEAD"),tree=await git(cwd,"rev-parse","HEAD^{tree}")
    record={...record,head,tree,builderOutcome:{status:job.status,code:job.code},status:"candidate_unconfirmed"}
    await verifyRepairSource(repo,pr,record)
    await repairRemote(repo,record)
    await repairObservation(repo,pr,record,[record.baseHead])
    await writeJson(repairFile(repo,pr),record)
    // Even a clean commit from an interrupted builder has no completion claim.
    // Recovery observes it; an explicit fix request may dispatch a corrective builder.
    return record
  }
  async function fix(repo, pr, kind, worktree, repairId) {
    const local=getRepo(repo)
    if(!local.checks?.length)throw new DeliveryError("repository-owned checks required before repair",9)
    let prior=await readJson(repairFile(repo,pr),null)
    if(repairId && (!prior || prior.status==="delivered"))return {message:"REPAIR ALREADY RECONCILED"}
    if(repairId && prior.id!==repairId)throw new DeliveryError("repair recovery receipt changed; observe before retry",75)
    const current=await view(repo,pr)
    requireOpen(current)
    if(prior?.status==="no_progress") {await eligible(repo,pr,current.headRefOid);prior=null}
    if(current.isCrossRepository!==false)throw new DeliveryError("fork repair is unsupported; origin is not the PR source")
    let corrective=false
    if(prior && prior.status!=="delivered") {
      if(prior.status==="building")prior=await reconcileBuilder(repo,pr,prior)
      if(prior.status==="candidate_unconfirmed") {
        await terminalJob(prior.builderJob,"BUILDER")
        if(repairId)throw new DeliveryError("CANDIDATE UNCONFIRMED: observed interrupted builder; explicit corrective fix required",75)
        corrective=true
      } else if(prior.status==="check_failed" && prior.checkPolicy===checkPolicyFor(local)) {
        const job=await terminalJob(prior.checkJob,"CHECK")
        if(job.status!=="failed" || !job.code || job.code!==prior.checks.at(-1)?.code)
          throw new DeliveryError("failed check receipt unconfirmed; observe before correction",75)
        corrective=true
      } else {
        if(prior.status==="early_publication")throw new DeliveryError("EARLY PUBLICATION: reconcile published source before repair",9)
        if(prior.status==="check_failed") {
          // A changed repository-owned policy can recheck the same source, but
          // the failed attempt remains immutable and keeps its original ID.
          prior={...prior,id:randomUUID(),corrects:prior.id,status:"built"}
          await writeJson(repairFile(repo,pr),prior)
        }
        return finishRepair(repo,pr,prior)
      }
      await verifyRepairSource(repo,pr,prior)
      if(await repairRemote(repo,prior)!==prior.baseHead)throw new DeliveryError("corrective repair remote moved",9)
      await repairObservation(repo,pr,prior,[prior.baseHead])
      await log({repo,pr,step:"repair",status:prior.status,head:prior.head})
      await completeDeliveryWait(config,repo,pr,budget())
    }
    if (kind === "ci-fix" && !corrective) {
      requireKnownCi(current.ci)
      if (!current.ci.repairable) throw new DeliveryError("CI FIX REFUSED: no observed failed required check", 3)
    }
    const fallback=worktree && worktree!=="-"?path.resolve(worktree):path.join(local.worktreeRoot,`fix-${pr}`)
    const cwd=corrective?prior.worktree:await branchWorktree(repo,current.headRefName,fallback,current.headRefOid)
    await git(cwd,"fetch","-q","origin")
    await fresh(repo,pr,current)
    const inputHead=corrective?prior.head:current.headRefOid
    if(await git(cwd,"rev-parse","HEAD")!==inputHead)throw new DeliveryError("HEAD MOVED before repair; source retained")
    let record={schema:"factory-repair-delivery/v1",id:randomUUID(),repo,pr,branch:current.headRefName,
      baseHead:current.headRefOid,base:current.base,inputHead,head:inputHead,tree:await git(cwd,"rev-parse","HEAD^{tree}"),
      worktree:cwd,status:"building",checks:[],...(corrective?{corrects:prior.id}:{})}
    const prompt=deliveryPrompt(kind,{repo,pr,head:inputHead,branch:current.headRefName,prior:current.review,ci:current.ci,reader:{root:fileURLToPath(new URL("../",import.meta.url))}})+
      (corrective?`\nCorrective repair of ${prior.id} on retained local candidate ${inputHead}. Prior status: ${prior.status}. Check outcomes: ${JSON.stringify(prior.checks)}. Builder receipt: ${prior.builderJob?.receipt ?? "none"}. Confirm and finish this candidate; never repeat an uncertain external action.`:"")
    return guarded(repo,pr,kind,codexArgv(kind,"--sandbox","danger-full-access","-"),cwd,
      prompt,current.headRefOid,async compute=>{
        const head=await git(cwd,"rev-parse","HEAD")
        if(head===inputHead) {
          record={...record,status:"no_progress"};await writeJson(repairFile(repo,pr),record)
          const error=new DeliveryError("NO-PROGRESS: fix produced no commit",2)
          error.wait=await suspend(repo,pr,current.headRefOid,{cause:"source-no-progress",code:2,message:error.message,resetAt:null})
          throw error
        }
        record={...record,head,tree:await git(cwd,"rev-parse","HEAD^{tree}"),status:"built"}
        await writeJson(repairFile(repo,pr),record)
        return finishRepair(repo,pr,record,compute)
      },async job=>{record.builderJob=job;await writeJson(repairFile(repo,pr),record)},config.models[kind])
  }
  async function readQueue() {
    const queue = await readJson(queueFile, [])
    if (!Array.isArray(queue)) throw new DeliveryError("invalid queue journal", 9)
    for (const entry of queue) {
      if (!isDeliveryBinding(entry) || !nonemptyText(entry.id)) throw new DeliveryError("invalid queue job binding", 9)
      entry.state ??= entry.outcome ? "acknowledged" : "pending"
      if (!["pending", "claimed", "effect-requested", "reconciled", "acknowledged"].includes(entry.state))
        throw new DeliveryError("invalid queue transition", 9)
      const claimed = ["claimed", "effect-requested", "reconciled"].includes(entry.state)
      if ((claimed || Object.hasOwn(entry, "attemptId")) && !nonemptyText(entry.attemptId) ||
          (claimed || Object.hasOwn(entry, "effectId")) &&
          (typeof entry.effectId !== "string" || !/^[0-9a-f]{64}$/.test(entry.effectId)))
        throw new DeliveryError("unbound queue claim", 9)
      if (["reconciled", "acknowledged"].includes(entry.state) && !["pass", "fail"].includes(entry.outcome?.status))
        throw new DeliveryError("missing queue outcome", 9)
      if (["pending", "claimed", "effect-requested"].includes(entry.state) && Object.hasOwn(entry, "outcome"))
        throw new DeliveryError("unexpected queue outcome", 9)
    }
    return queue
  }
  async function queueState(fn) {
    return withLease(locks, "queue-state", async () => {
      const queue = await readQueue()
      const result = await fn(queue)
      await writeJson(queueFile, queue)
      return result
    }, { waitMs: config.commandTimeoutMs, pollMs: config.pollMs, budget: budget() })
  }
  const cancellationKey = (repo, pr, head) => deliveryEffectId({ repo, pr, head, action: "cancel" })
  const leaseWait = () => ({ waitMs: config.commandTimeoutMs, pollMs: config.pollMs, budget: budget() })
  // Invalid tombstones refuse: dropping one would silently reopen cancelled work.
  async function readCancellations() {
    const cancellations = await readJson(cancelFile, {})
    if (cancellations === null || typeof cancellations !== "object" || Array.isArray(cancellations) ||
        Object.entries(cancellations).some(([key, value]) => !isDeliveryBinding(value) ||
          key !== cancellationKey(value.repo, value.pr, value.head) || !Number.isSafeInteger(value.at)))
      throw new DeliveryError("invalid cancellation journal", 9)
    return cancellations
  }
  async function cancelled(repo, pr, head) {
    return Object.hasOwn(await readCancellations(), cancellationKey(repo, pr, head))
  }
  async function requireNotCancelled(repo, pr, head) {
    if (await cancelled(repo, pr, head)) {
      // Refused before any launch: the outcome is known, not uncertain.
      const error = new DeliveryError("QUEUED WORK CANCELLED", 130)
      error.cancelled = true; error.uncertain = false
      throw error
    }
  }
  // Every launch of a new effect checks cancellation and dispatches inside this
  // per-binding fence. Cancellation takes the same fence, so it returns only
  // after an in-flight dispatch, and no dispatch starts after it returns.
  const launchFenceName = (repo, pr, head) => `launch-${cancellationKey(repo, pr, head)}`
  function launchFence(repo, pr, head, fn) {
    return withLease(locks, launchFenceName(repo, pr, head), async () => {
      await requireNotCancelled(repo, pr, head)
      return fn()
    }, leaseWait())
  }
  async function cancelQueued(repo, pr, head) {
    const key = cancellationKey(repo, pr, head)
    // The tombstone is authoritative if publication of the projection fails.
    await withLease(locks, launchFenceName(repo, pr, head), () => withLease(locks, "queue-state", async () => {
      const cancellations = await readCancellations()
      cancellations[key] = { repo, pr, head, at: Date.now() }
      await writeJson(cancelFile, cancellations)
    }, leaseWait()), leaseWait())
    await queueState(queue => {
      for (const entry of queue.filter(e => e.repo === repo && e.pr === pr && e.head === head && e.state === "pending")) {
        entry.state = "acknowledged"
        entry.outcome = pass({ message: "QUEUED WORK CANCELLED", cancelled: true })
      }
    })
    return { message: "QUEUED WORK CANCELLED", cancelled: true }
  }
  async function enqueue(repo, pr, head, note = "", mode = "manual") {
    getRepo(repo)
    if (!SHA.test(head)) throw new DeliveryError("candidate SHA must be a full commit SHA")
    if (await cancelled(repo, pr, head)) return { message: "QUEUED WORK CANCELLED", enqueued: false }
    if (mode !== "import") {
      const current = await view(repo, pr)
      requireOpen(current)
      if (current.headRefOid !== head ||
          current.ci.state !== "success" || current.mergeable !== "MERGEABLE" || current.isDraft)
        throw new DeliveryError("enqueue preconditions not satisfied", 4)
    }
    return queueState(async queue => {
      if (await cancelled(repo, pr, head)) return { message: "QUEUED WORK CANCELLED", enqueued: false }
      const prior = queue.filter(e => e.repo === repo && e.pr === pr && e.head === head)
      if (prior.some(e => mode === "import" || e.state !== "acknowledged" || e.outcome?.status === "pass") ||
          mode !== "manual" && prior.filter(e => (e.createdAt ?? 0) >= Date.now() - 86400_000).length >= config.queueRunsPer24h)
        return { message: `ALREADY QUEUED or RETRY LIMIT ${repo}#${pr} ${head}`, enqueued: false }
      queue.push({ id: randomUUID(), repo, pr, head, note: note.replaceAll("\n", " "), attempts: 0,
        state: "pending", effectAttempt: prior.length + 1, availableAt: 0, createdAt: Date.now(), recoveryOf: prior.at(-1)?.id ?? null })
      // Offers are observed outside this lease and may land out of order, so no
      // offer retires another head; dispatch refuses any head the PR no longer has.
      return { message: `QUEUED ${repo}#${pr} ${head}`, enqueued: true }
    })
  }
  // A retried row moves behind its lane's other work, keeping its identity.
  async function queueTransition(id, state, fields = {}, { requeue = false } = {}) {
    const entry = await queueState(queue => {
      const index = queue.findIndex(e => e.id === id), stored = queue[index]
      if (!stored) throw new DeliveryError("queue claim disappeared", 9)
      Object.assign(stored, fields, { state })
      if (requeue) queue.push(...queue.splice(index, 1))
      return structuredClone(stored)
    })
    await onTransition(state, entry)
    return entry
  }
  // A durable intent is never resent on missing acknowledgement. Provider state
  // must reconcile it first; confirmed refusals may be retried with a new attempt.
  async function mutation(repo, pr, head, action, fields, owners, { reconcileOnly = false } = {}) {
    const id = effectIdentity(repo, pr, head, action, fields)
    const file = path.join(config.stateDir, "effects", `${id}.json`)
    return withLease(locks, `effect-${id}`, async () => {
      let record = await readJson(file, null)
      if (record && (record.schema !== "factory-effect/v1" || record.id !== id || record.repo !== repo || record.pr !== pr ||
          record.head !== head || record.action !== action || !Number.isSafeInteger(record.attempt) || record.attempt <= 0 ||
          !/^[0-9a-f-]{36}$/.test(record.attemptId ?? "") || !["effect-requested", "acknowledged", "refused"].includes(record.state)))
        throw new DeliveryError("invalid persisted effect binding", 9)
      const observeEffect = async () => {
        const current = await view(repo, pr)
        if (current.state === "MERGED") {
          return { ok: true, status: 200, value: { merged: true, sha: current.mergeCommit.oid } }
        }
        return null
      }
      const unknown = () => {
        const error = new DeliveryError("EFFECT OUTCOME UNKNOWN: reconcile provider before retry", 6, true)
        error.uncertain = true
        return error
      }
      // Once an intent is durable, no failure (readback, refusal of the readback,
      // or journal publication) may turn the unknown outcome into a terminal one.
      const unresolved = fn => fn().catch(error => { throw record?.state === "refused" || error.uncertain ? error : unknown() })
      const reconcile = async () => {
        const observed = await observeEffect()
        if (observed) return observed
        throw unknown()
      }
      const acknowledge = async result => {
        // Persist only provider identity and typed outcome, never raw errors/body.
        await writeJson(file, { ...record, state: "acknowledged", status: result.status,
          providerId: result.value?.id ?? result.value?.sha ?? null })
        return result
      }
      if (record && (record.state !== "refused" || reconcileOnly)) return unresolved(async () => acknowledge(await reconcile()))
      if (reconcileOnly) throw new DeliveryError("missing effect reconciliation intent", 9)
      // A restored checkpoint may predate the intent, while the provider still
      // retains its effect. Observe even when no local journal row survives.
      const observed = await observeEffect()
      record = { schema: "factory-effect/v1", id, repo, pr, head, action,
        attemptId: randomUUID(), attempt: (record?.attempt ?? 0) + 1, state: "effect-requested" }
      if (observed) return acknowledge(observed)
      return launchFence(repo, pr, head, async () => {
        await writeJson(file, record)
        return unresolved(async () => {
          await onTransition(`provider:${action}:requested`, record)
          const route = `pulls/${pr}/merge`
          const result = await provider.mutate(repo, "PUT", route, fields, owners).catch(async error => {
            // An explicit write refusal or proven non-launch is known. A failed
            // reconciliation read is handled separately and remains uncertain.
            if (error.uncertain === false || error.state === "auth_error") {
              const refused = { ...record, state: "refused" }
              await writeJson(file, refused); record = refused
            }
            throw error
          })
          await onTransition(`provider:${action}:returned`, record)
          if (result.ok && result.value?.merged === true && SHA.test(result.value.sha ?? "")) return acknowledge(result)
          if (result.transient || result.ok) return acknowledge(await reconcile())
          await writeJson(file, { ...record, state: "refused", status: result.status })
          return result
        })
      })
    }, { budget: budget() })
  }
  async function verifyCandidateHead(local, head, old, main = "origin/main") {
    let cursor = head, hops = 0
    while (cursor !== old) {
      if (++hops > 6) throw new DeliveryError("HEAD IS NOT A MAIN-MERGE OF THE CANDIDATE HEAD; observe the new candidate")
      const parents = (await git(local.checkout, "show", "-s", "--format=%P", cursor)).split(" ")
      if (parents.length !== 2) throw new DeliveryError("NON-MERGE COMMIT after the candidate; observe the new candidate")
      const [first, second] = parents
      if ((await command(["git", "merge-base", "--is-ancestor", second, main], local.checkout, { allowFailure: true })).code)
        throw new DeliveryError("SECOND PARENT NOT ON MAIN; observe the new candidate")
      const tree = (await git(local.checkout, "merge-tree", "--write-tree", second, first)).split("\n")[0]
      if (tree !== await git(local.checkout, "rev-parse", `${cursor}^{tree}`))
        throw new DeliveryError("MERGE HAS HAND EDITS; observe the new candidate", 2)
      cursor = first
    }
  }
  async function verifyDelivery(repo, pr, observed, candidateHead, base = null) {
    const local = getRepo(repo), commit = observed.mergeCommit?.oid
    supportedBase(observed)
    if (observed.state !== "MERGED" || !SHA.test(commit ?? "")) throw new DeliveryError("MERGE VERIFY: invalid merged commit", 7, true)
    await git(local.checkout, "fetch", "-q", "origin", "main", observed.headRefOid)
    await verifyCandidateHead(local, observed.headRefOid, candidateHead)
    if ((await command(["git", "merge-base", "--is-ancestor", commit, "origin/main"], local.checkout, { allowFailure: true })).code)
      throw new DeliveryError("MERGE NOT ON MAIN", 7, true)
    const parents = (await git(local.checkout, "show", "-s", "--format=%P", commit)).split(" ")
    if (parents.length !== 1) throw new DeliveryError("MERGE SOURCE VERIFY: expected squash commit", 7)
    if (base && parents[0] !== base) throw new DeliveryError("MERGE BASE VERIFY: delivered onto a base the candidate did not include", 7)
    const expected = (await git(local.checkout, "merge-tree", "--write-tree", parents[0], observed.headRefOid)).split("\n")[0]
    if (expected !== await git(local.checkout, "rev-parse", `${commit}^{tree}`))
      throw new DeliveryError("MERGE SOURCE VERIFY: delivered tree does not match PR", 7)
    return { message: `${repo}#${pr} MERGED ${commit} (on main, source verified)`, mergeCommit: commit, merged: true }
  }
  // GitHub must itself refuse a merge once main is no longer an ancestor of the
  // reviewed head; no local comparison can close the race with other writers.
  async function requireServerUpToDate(repo) {
    for (const rule of await provider.pages(repo, "rules/branches/main", { rowKey: row => `${row?.ruleset_id}:${row?.type}` })) {
      if (rule?.type !== "required_status_checks" || rule.parameters?.strict_required_status_checks_policy !== true ||
          !Number.isSafeInteger(rule.ruleset_id)) continue
      const ruleset = (await provider.request(repo, `rulesets/${rule.ruleset_id}`)).value
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
  const updateRecord = (repo, pr, head) => path.join(config.stateDir, "updates", `${keyFor(repo, pr)}-${head}.json`)
  async function pendingUpdate(repo, pr, head) {
    const value = await readJson(updateRecord(repo, pr, head), null)
    if (value && (value.schema !== "factory-branch-update/v1" || value.repo !== repo || value.pr !== pr ||
        value.head !== head || !SHA.test(value.base ?? ""))) throw new DeliveryError("invalid pending branch update", 9)
    return value
  }
  function branchUpdatePending() {
    const error = new DeliveryError("UPDATE-BRANCH PENDING: await changed head before CI", 6, true)
    error.pendingUpdate = true
    return error
  }
  // Any expiry during readback, pacing included, leaves the recorded intent
  // pending; the next attempt observes again instead of writing again.
  async function reconcileUpdate(repo, pr, pending) {
    const local = getRepo(repo), until = Date.now() + config.checksTimeoutMs
    try {
      while (true) {
        let current
        try { current = await view(repo, pr, { observeChecks: false }) }
        catch (error) {
          if (error.uncertain) throw branchUpdatePending()
          if (!error.transient) throw error
          if (Date.now() < until) { await budget().sleep(config.pollMs); continue }
        }
        if (current) requireOpen(current)
        if (current && current.headRefOid !== pending.head) {
          await git(local.checkout, "fetch", "-q", "origin", current.headRefOid, pending.head, pending.base)
          await verifyCandidateHead(local, current.headRefOid, pending.head, pending.base)
          if ((await command(["git", "merge-base", "--is-ancestor", pending.base, current.headRefOid], local.checkout, { allowFailure: true })).code)
            throw new DeliveryError("UPDATED HEAD DOES NOT INCLUDE REQUESTED MAIN; observe the new candidate", 2)
          // Verified readback resolves this intent; the old head now needs a
          // terminal fresh-review outcome rather than further reconciliation.
          await fs.unlink(updateRecord(repo, pr, pending.head))
          return { updated: true, head: current.headRefOid, message: "INTEGRATION UPDATED; await CI on the new head" }
        }
        if (Date.now() >= until) throw branchUpdatePending()
        await budget().sleep(config.pollMs)
      }
    } catch (error) {
      if (error.code === 142) throw branchUpdatePending()
      throw error
    }
  }
  async function mergeOne(repo, pr, old, note, owners, retry = false) {
    const local = getRepo(repo)
    if (!SHA.test(old)) throw new DeliveryError("candidate SHA must be a full commit SHA")
    const pending = await pendingUpdate(repo, pr, old)
    if (pending) return reconcileUpdate(repo, pr, pending)
    let current = await view(repo, pr)
    if (current.state === "MERGED") {
      const delivered = await verifyDelivery(repo, pr, current, old, await integrationBase(repo, pr, old))
      const id = effectIdentity(repo, pr, current.headRefOid, "merge", { merge_method: "squash", sha: current.headRefOid })
      if (await readJson(path.join(config.stateDir, "effects", `${id}.json`), null))
        await mutation(repo, pr, current.headRefOid, "merge", { merge_method: "squash", sha: current.headRefOid }, owners, { reconcileOnly: true })
      return delivered
    }
    if (current.state !== "OPEN") throw new DeliveryError(`${repo}#${pr} NOT OPEN (${current.state})`, 8)
    if (current.isDraft) throw new DeliveryError("DRAFT: integration requires a published candidate", 8)
    if (current.mergeable === "UNKNOWN") throw new DeliveryError("MERGEABILITY UNKNOWN: wait for provider observation", 75)
    if (current.headRefOid !== old) throw new DeliveryError("HEAD CHANGED after integration; observe the new candidate", 2)
    await git(local.checkout, "fetch", "-q", "origin", "main", current.headRefOid, old)
    if (current.mergeStateStatus === "DIRTY" || current.mergeable === "CONFLICTING")
      throw new DeliveryError("CONFLICT with main; needs a builder merge", 5)
    const ancestor = await command(["git", "merge-base", "--is-ancestor", current.base.sha, current.headRefOid], local.checkout, { allowFailure: true })
    if (ancestor.code) {
      current = await fresh(repo, pr, current)
      requireOpen(current)
      if (current.isDraft)
        throw new DeliveryError("update-branch preconditions changed", 4)
      const pending = { schema: "factory-branch-update/v1", repo, pr, head: current.headRefOid, base: current.base.sha,
        attemptId: randomUUID(), effectId: deliveryEffectId({ repo, pr, head: old, action: "update-branch:" + current.base.sha }) }
      // Persist intent before sending once. Accepted and ambiguous writes both
      // reconcile this intent, including after a controller restart.
      const update = await launchFence(repo, pr, old, async () => {
        await writeJson(updateRecord(repo, pr, old), pending)
        return provider.mutate(repo, "PUT", `pulls/${pr}/update-branch`, { expected_head_sha: current.headRefOid }, owners)
      }).catch(async error => {
        if (error.uncertain === false && !error.cancelled) await fs.unlink(updateRecord(repo, pr, old))
        if (!error.uncertain) throw error
        await log({ step: "update", repo, pr, status: "uncertain", code: error.code ?? 1, message: error.message })
        throw branchUpdatePending()
      })
      if (update.ok || update.transient) return reconcileUpdate(repo, pr, pending)
      await fs.unlink(updateRecord(repo, pr, old))
      if (update.status === 422) throw new DeliveryError("UPDATE-BRANCH FAILED; needs a builder integration", 5)
      throw new DeliveryError(`UPDATE-BRANCH REFUSED (HTTP ${update.status})`, 6)
    }
    const head = current.headRefOid
    const base = current.base.sha
    await waitChecks(repo, pr, head)
    current = await view(repo, pr)
    if (current.headRefOid !== head) throw new DeliveryError("HEAD MOVED during checks; observe the new candidate")
    requireOpen(current)
    if (current.mergeable !== "MERGEABLE") throw new DeliveryError("MERGEABILITY NOT READY", 75)
    const finalCi = current.ci
    requireKnownCi(finalCi)
    if (finalCi.state !== "success") throw new DeliveryError(`NONGREEN on ${head}`, 3)
    await git(local.checkout, "fetch", "-q", "origin", "main")
    if (await git(local.checkout, "rev-parse", "origin/main") !== base)
      throw new DeliveryError("INTEGRATION BASE MOVED; needs fresh integration and CI", 2)
    await requireServerUpToDate(repo)
    await writeJson(integrationRecord(repo, pr, head), { schema: "factory-integration/v1", repo, pr, head, base })
    const result = await mutation(repo, pr, head, "merge", { merge_method: "squash", sha: head }, owners)
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
    if (result.value?.merged !== true || !SHA.test(result.value.sha ?? "")) {
      const after = await view(repo, pr)
      if (after.state === "MERGED") return verifyDelivery(repo, pr, after, head, base)
      throw new DeliveryError("MERGE acknowledgement missing; reconcile before retry", 7, true)
    }
    let lastError
    for (let attempt = 0; attempt < 6; attempt++) {
      try { return await verifyDelivery(repo, pr, await view(repo, pr), head, base) }
      catch (error) { if (!error.transient) throw error; lastError = error }
      await budget().sleep(config.pollMs)
    }
    throw lastError
  }
  const integrationLane = (repo, fn) => withLease(locks, "delivery-worker", fn, { budget: budget() })
  const prWriter = (repo, pr, fn) => withLease(locks, `pr-${keyFor(repo, pr)}`, fn, { budget: budget() })
  async function unresolvedIntent(repo, pr, head) {
    if (await pendingUpdate(repo, pr, head)) return true
    const dir = path.join(config.stateDir, "effects")
    const names = await fs.readdir(dir).catch(error => { if (error.code === "ENOENT") return []; throw error })
    for (const name of names) {
      if (!name.endsWith(".json")) continue
      const record = await readJson(path.join(dir, name), null)
      if (record?.repo === repo && record.pr === pr && record.head === head && record.state === "effect-requested") return true
    }
    return false
  }
  async function consumeQueue(repo, lane) {
    const entry = await queueState(queue => queue.find(e => e.repo === repo && e.state !== "acknowledged" && e.availableAt <= Date.now()))
    if (!entry) return { message: "QUEUE IDLE", idle: true }
    return prWriter(entry.repo, entry.pr, async writer => {
      let stored = await queueState(queue => structuredClone(queue.find(e => e.id === entry.id)))
      if (stored.state === "acknowledged") return { message: stored.outcome.data.message, processed: true }
      if (stored.state === "pending") {
        if (await cancelled(repo, stored.pr, stored.head)) {
          await cancelQueued(repo, stored.pr, stored.head)
          return { message: "QUEUED WORK CANCELLED", processed: true }
        }
        stored = await queueTransition(entry.id, "claimed", { owner: process.pid, attemptId: randomUUID(),
          effectId: deliveryEffectId({ repo, pr: entry.pr, head: entry.head, action: "queue-merge", attempt: entry.effectAttempt ?? 1 }) })
      }
      stored = await queueState(queue => {
        const owned = queue.find(e => e.id === entry.id); owned.owner = process.pid; return structuredClone(owned)
      })
      let outcome = stored.outcome
      if (stored.state !== "reconciled") {
        if (stored.state === "claimed") stored = await queueTransition(entry.id, "effect-requested")
        try { outcome = pass(await mergeOne(entry.repo, entry.pr, entry.head, entry.note, [lane, writer])) }
        catch (e) {
          // Provider reads can fail before reaching mutation's reconciliation
          // path. Durable intents keep their obligation even across those stops.
          let unresolved = true
          try { unresolved = await unresolvedIntent(entry.repo, entry.pr, entry.head) } catch { /* Unknown journal state must reconcile. */ }
          if (unresolved) e.uncertain = true
          if (e.cancelled && !unresolved) outcome = pass({ message: "QUEUED WORK CANCELLED", cancelled: true })
          else outcome = fail(e)
        }
        if (outcome.status === "fail") await deliveryStatus(config, {repo:entry.repo, pr:entry.pr, step:"merge", ...outcome.data, nextAction: "reconcile-and-requeue"})
        await deadlines.run(new Deadline(config.commandTimeoutMs), async () => {
          if (outcome.data.pendingUpdate || outcome.data.uncertain || (outcome.data.state ? !outcome.data.terminal : outcome.data.transient || outcome.data.code === 6 || outcome.data.code === 75)) {
            await queueTransition(entry.id, "effect-requested", { attempts: stored.attempts + 1, availableAt: outcome.data.retryAt ?? Date.now() + config.retryMs,
              owner: null, lastResult: outcome, nextAction: "reconcile-provider" }, { requeue: true })
          } else {
            stored = await queueTransition(entry.id, "reconciled", { attempts: stored.attempts + 1, outcome })
          }
        })
        if (stored.state !== "reconciled") {
          if (outcome.data.code === 75) return { ...outcome, data: { ...outcome.data, processed: true, transient: true } }
          return outcome.data.state ? { ...outcome, data: { ...outcome.data, processed: true } } : { message: outcome.data.message, processed: true, outcome, code: 0 }
        }
      }
      await deadlines.run(new Deadline(config.commandTimeoutMs), () => queueTransition(entry.id, "acknowledged", { owner: null, nextAction: "none" }))
      await log({ step: "merge", repo: entry.repo, pr: entry.pr, head: entry.head, attemptId: stored.attemptId, effectId: stored.effectId, ...outcome.data })
      return outcome.data.state ? { ...outcome, data: { ...outcome.data, processed: true } } : { message: outcome.data.message, processed: true, outcome, code: 0 }
    })
  }
  async function queueSummary() {
    return queueState(async queue => {
      const pending = queue.filter(e => e.state === "pending").length
      const terminal = queue.filter(e => e.state === "acknowledged").length
      const owned = queue.length - pending - terminal
      const effectIds = queue.map(e => e.effectId).filter(Boolean)
      const orphanLeases = await orphanLeaseCount(locks, { recover: true, budget: budget() })
      return { offered: queue.length, pending, owned, terminal,
        orphanLeases,
        duplicateEffectIds: effectIds.length - new Set(effectIds).size,
        nextAction: effectIds.length !== new Set(effectIds).size ? "stop-and-reconcile-duplicate-effects"
          : orphanLeases ? "wait-for-supervised-child-or-recover-lease" : owned ? "reconcile-provider" : "consume-pending" }
    })
  }
  async function discoverDelivery(repo) {
    const open = await provider.pages(repo, "pulls?state=open")
    return { candidates: open.filter(pr => pr.base?.ref === "main" && !pr.draft).map(pr => ({ repo, pr: pr.number })) }
  }
  async function installationStatus() {
    const sourceRoot = fileURLToPath(new URL("../", import.meta.url))
    return { sourceRevision: await git(sourceRoot, "rev-parse", "HEAD"),
      entrypoint: path.join(sourceRoot, "bin/pr-delivery.mjs"), configFile: config.configFile,
      policySource: path.join(sourceRoot, "docs/pr-delivery-cutover.md"), installation: "unverified",
      checkPolicy: Object.fromEntries(Object.entries(config.repos).map(([repo, local]) => [repo, local.requiredChecks])),
      paths: { stateDir: config.stateDir, deliveryLog: path.join(config.stateDir, "delivery.jsonl"), queue: queueFile } }
  }
  async function jobStatus(repo, pr) {
    const navigation = await installationStatus()
    const waitReceipt = path.join(config.stateDir, "waits", `${keyFor(repo, pr)}.json`)
    const repairReceipt = repairFile(repo, pr)
    const absolutePath = value => typeof value === "string" && path.isAbsolute(value) && !value.includes("\0")
    const jobPaths = value => value == null || typeof value === "object" && !Array.isArray(value) &&
      absolutePath(value.receipt) && absolutePath(value.log)
    const read = async (file, schema, valid) => {
      const record = await readJson(file)
      if (record !== undefined && (!isDeliveryBinding(record) || record.schema !== schema || record.repo !== repo || record.pr !== pr || !valid(record)))
        throw new DeliveryError("invalid job journal", 9)
      return record ?? null
    }
    const wait = await read(waitReceipt, "factory-delivery-wait/v1", record =>
      ["suspended", "resumable", "complete"].includes(record.status) && nonemptyText(record.cause) &&
      Number.isSafeInteger(record.code) && record.code >= 0)
    const repair = await read(repairReceipt, "factory-repair-delivery/v1", record =>
      nonemptyText(record.id) && ["building", "built", "no_progress", "checking", "check_interrupted", "check_failed",
        "push_pending", "early_publication", "candidate_unconfirmed", "delivered"].includes(record.status) &&
      absolutePath(record.worktree) && jobPaths(record.builderJob) && jobPaths(record.checkJob))
    const job = value => value ? { receipt: value.receipt, log: value.log } : null
    return { ...navigation, repo, pr, observation: "recorded history, not process liveness",
      queue: (await readQueue()).filter(row => row.repo === repo && row.pr === pr)
        .map(row => ({ id: row.id, head: row.head, state: row.state, outcome: row.outcome?.status ?? null })),
      wait: wait ? { head: wait.head, status: wait.status, cause: wait.cause, code: wait.code } : null,
      repair: repair ? { id: repair.id, head: repair.head, status: repair.status, worktree: repair.worktree,
        builderJob: job(repair.builderJob), checkJob: job(repair.checkJob) } : null,
      paths: { ...navigation.paths, waitReceipt, repairReceipt } }
  }
  return {
    config,
    async recoveryCandidates() {
      const candidates = new Map()
      for (const [directory, schema] of [["waits","factory-delivery-wait/v1"],["repairs","factory-repair-delivery/v1"]]) {
        const dir = path.join(config.stateDir,directory)
        const names = await fs.readdir(dir).catch(e => { if (e.code === "ENOENT") return []; throw e })
        for (const name of names) {
          if (!name.endsWith(".json")) continue
          const record = await readJson(path.join(dir,name))
          if (record.schema !== schema || !config.repos[record.repo] || !Number.isSafeInteger(record.pr) || record.pr <= 0 ||
              directory === "repairs" && (typeof record.id !== "string" || !record.id))
            throw new DeliveryError("invalid delivery recovery record",9)
          if (directory === "repairs" ? !["delivered","no_progress"].includes(record.status) : ["suspended","resumable"].includes(record.status))
            candidates.set(keyFor(record.repo,record.pr),{repo:record.repo,pr:record.pr,...(directory === "repairs" ? {repairId:record.id} : {})})
        }
      }
      return [...candidates.values()]
    },
    async exclusive(repo, pr, fn) {
      getRepo(repo)
      return inAttempt(() => withLease(locks, `pr-${keyFor(repo, pr)}`, async release => {
        const key = keyFor(repo, pr)
        prLeases.set(key, release)
        try { return await fn() } finally { prLeases.delete(key) }
      }, { budget: budget() }))
    },
    async execute(step, request = {}) {
      return inAttempt(async () => {
        const { repo, pr, head, worktree, note } = request
        try {
          if (repo) getRepo(repo)
          let data
          switch (step) {
            case "installation-status": data = await installationStatus(); break
            case "job-status": data = await jobStatus(repo, pr); break
            case "snapshot": data = await observe(repo, pr, { head }); break
            case "pr:inspect": {
              let current = await view(repo, pr)
              if (current.state === "MERGED") { data = await verifyDelivery(repo, pr, current, current.headRefOid); break }
              requireOpen(current)
              if (current.ci.cancelled) {
                await retriggerCi(repo, pr)
                current = await view(repo, pr)
              }
              await eligible(repo, pr, current.headRefOid)
              current = await waitChecks(repo, pr, current.headRefOid, true, current)
              const ci = current.ci
              if (ci.state === "success" && current.mergeable === "UNKNOWN") throw new DeliveryError("MERGEABILITY UNKNOWN: wait for provider observation", 75)
              const ready = current.mergeable === "MERGEABLE" && ci.state === "success"
              data = { head: current.headRefOid, ready, repairable: ci.repairable === true }

              break
            }
            case "github-logs": data = {body: (await provider.request(repo, `actions/jobs/${request.job}/logs`, {format:"text"})).value}; break
            case "github-read": data = { body: (await provider.request(repo, request.route)).value }; break
            case "repair-status": data = await readJson(repairFile(repo,pr),{status:"absent"});
              if(data.checkJob) data = {...data,job:await observeProcessJob(data.checkJob.receipt)}; break
            case "readiness": {
              const current = await view(repo, pr, { head })
              requireOpen(current)
              const ci = current.ci
              data = { head: current.headRefOid, state: ({success:"green",failure:"red"})[ci.state] ?? ci.state, missing: ci.missing ?? [], nextAction: ci.nextAction }
              break
            }
            case "pr:suspend":
              data = await suspend(repo, pr, head, request.stop)
              await deliveryStatus(config, {repo, pr, step: "deliver", ...request.stop, nextAction: "wait-for-input-or-reset"})
              break
            case "pr:complete":
              await completeDeliveryWait(config, repo, pr, budget())
              data = {}; break
            case "fix": case "ci-fix": data = await fix(repo, pr, step, worktree, request.repairId); break
            case "ci-retrigger": data = await retriggerCi(repo, pr); break
            case "branch-wt": data = { worktree: await branchWorktree(repo, request.branch, request.fallback) }; break
            case "codex-guard": data = await guarded(repo, pr, request.kind, request.argv, getRepo(repo).checkout, ""); break
            case "queue-cancel": data = await cancelQueued(repo, pr, head); break
            case "queue-status": data = await queueSummary(); break
            case "enqueue": data = await enqueue(repo, pr, head, note); break
            case "enqueue-event": {
              const current = await view(repo, pr)
              if (head && head !== current.headRefOid) data = { enqueued: false }
              else data = await enqueue(repo, pr, current.headRefOid, note)
              break
            }
            case "delivery-scan": data = await discoverDelivery(repo); break
            case "merge-one-core":
              data = await integrationLane(repo, lane => prWriter(repo, pr, writer => mergeOne(repo, pr, head, note ?? "", [lane, writer]))); break
            case "merge-queue": {
              let busy
              for (const target of repo ? [repo] : Object.keys(config.repos)) {
                try { data = await integrationLane(target, lane => consumeQueue(target, lane)) }
                catch (e) { if (e.code !== 75) throw e; busy = e; continue }
                if (!data.idle) break
              }
              if (!data || (data.idle && busy)) throw new DeliveryError(busy.message, 75, true)
              break
            }
            default: throw new DeliveryError(`unknown delivery step: ${step}`)
          }
          if (step === "merge-queue" && data.status) return normalizeResult(data, "delivery")
          return pass(data)
        } catch (error) {
          if (["installation-status", "job-status"].includes(step))
            return fail(new DeliveryError("Delivery navigation unavailable: check configuration, journal fields and bindings", 9))
          await deliveryStatus(config, {repo, pr, step, code:error.code, message:error.message, nextAction:error.nextAction ?? (error.wait ? "wait-for-input-or-reset" : "inspect-and-resume")})
          if (!error.wait) await log({ step, repo, pr, status: "failed", code: error.code ?? 1, message: error.message })
          return fail(error)
        }
      })
    }
  }
}

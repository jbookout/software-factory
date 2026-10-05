import { AsyncLocalStorage } from "node:async_hooks"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { Deadline } from "./deadline.mjs"
import { normalizeResult } from "./adapters.mjs"
import { deliveryEffectId, isDeliveryBinding } from "./evidence.mjs"
import { DeliveryError, keyFor, readJson, writeJson, withLease, orphanLeaseCount } from "./pr-delivery-state.mjs"

const SHA = /^[0-9a-f]{40}$/
const digestOf = value => createHash("sha256").update(value).digest("hex")
export const deliveryPass = data => normalizeResult({ status: "pass", data }, "delivery")
export const deliveryFailure = error => normalizeResult({ status: "fail",
  data: { code: Number.isInteger(error.code) ? error.code : 1, message: error.message, transient: error.transient ?? false,
    ...(error.observation ?? {}),
    ...(error.cancelled ? { cancelled: true, nextAction: "none" } : {}),
    ...(error.state ? { state: error.state, pool: error.pool, retryAt: error.retryAt, queryErrors: error.queryErrors, terminal: error.terminal, nextAction: "wait-for-provider-observation" } : {}),
    ...(error.pendingUpdate ? { pendingUpdate: true } : {}),
    ...(error.phase ? { phase: error.phase, nextAction: error.nextAction } : {}),
    ...(error.uncertain ? { uncertain: true, nextAction: "readback-before-retry" } : {}),
    ...(error.wait ? { cause: error.wait.cause, resetAt: error.wait.resetAt, head: error.wait.head, nextAction: error.wait.cause === "mutation-uncertain" ? "readback-before-retry" : "wait-for-input-or-reset", admitted: false } : {}) },
  findings: [{ reason: error.message }] }, "delivery")
// All recovery writers use the same record. Reading eligibility is advisory;
// callers still take the PR lease and reserve the budget at dispatch time.
async function deliveryWait(config, repo, pr, input, stop, budget) {
  return withLease(path.join(config.stateDir, "locks"), `wait-${keyFor(repo, pr)}`, async () => {
    const file = path.join(config.stateDir, "waits", `${keyFor(repo, pr)}.json`)
    const prior = await readJson(file, null)
    if (stop) {
      const record = { schema: "factory-delivery-wait/v1", status: "suspended", ...input, ...stop }
      if (prior?.status === "suspended" && JSON.stringify(prior) === JSON.stringify(record)) return { ...prior, recorded: false }
      await writeJson(file, record)
      return { ...record, recorded: true }
    }
    if (!prior || prior.status !== "suspended") return null
    const changed = prior.head !== input.head || prior.dependency !== input.dependency
    const budgetOpen = prior.cause === "budget-exhausted" && input.budgetAvailable
    // Slot waits retry admission; reserveCodex remains the atomic arbiter.
    // Capacity signals cannot reopen a deterministic source/dependency stop.
    if (prior.cause === "slot-wait" && !changed) return null
    const budgetReset = prior.cause === "budget-exhausted" && prior.resetAt && Date.now() >= prior.resetAt
    if (changed || budgetOpen || budgetReset) {
      await writeJson(file, { ...prior, status: "resumable" })
      return null
    }
    const error = new DeliveryError(prior.message, prior.code)
    error.wait = prior
    throw error
  }, { waitMs: config.commandTimeoutMs, pollMs: config.pollMs, budget })
}

async function completeDeliveryWait(config, repo, pr, budget) {
  return withLease(path.join(config.stateDir, "locks"), `wait-${keyFor(repo, pr)}`, async () => {
    const file = path.join(config.stateDir, "waits", `${keyFor(repo, pr)}.json`)
    const prior = await readJson(file, null)
    if (prior) await writeJson(file, { ...prior, status: "complete" })
  }, { waitMs: config.commandTimeoutMs, pollMs: config.pollMs, budget })
}


/** Own attempt ordering and publication; actions supply observations and effects. */
export function createDeliveryJournal(config, { budget = () => undefined, onTransition = async () => {} } = {}) {
  const locks = path.join(config.stateDir, "locks"), queueFile = path.join(config.stateDir, "queue.json")
  const cancelFile = path.join(config.stateDir, "cancellations.json")
  const pass = deliveryPass, fail = deliveryFailure
  async function queueState(fn) {
    return withLease(locks, "queue-state", async () => {
      const queue = await readJson(queueFile, [])
      if (!Array.isArray(queue)) throw new DeliveryError("invalid queue journal", 9)
      for (const entry of queue) {
        // The journal is shared across lanes; dispatch, rather than reading
        // another lane's row, requires a configured repository.
        if (!isDeliveryBinding(entry) || !entry.id) throw new DeliveryError("invalid queue job binding", 9)
        entry.state ??= entry.outcome ? "acknowledged" : "pending"
        if (!["pending", "claimed", "effect-requested", "reconciled", "acknowledged"].includes(entry.state))
          throw new DeliveryError("invalid queue transition", 9)
        if (["claimed", "effect-requested", "reconciled"].includes(entry.state) &&
            (typeof entry.attemptId !== "string" || !/^[0-9a-f]{64}$/.test(entry.effectId ?? "")))
          throw new DeliveryError("unbound queue claim", 9)
        if (["reconciled", "acknowledged"].includes(entry.state) && !["pass", "fail"].includes(entry.outcome?.status))
          throw new DeliveryError("missing queue outcome", 9)
      }
      const result = await fn(queue)
      await writeJson(queueFile, queue)
      return result
    }, { waitMs: config.commandTimeoutMs, pollMs: config.pollMs, budget: activeBudget() })
  }
  const cancellationKey = (repo, pr, head) => deliveryEffectId({ repo, pr, head, action: "cancel" })
  const leaseWait = () => ({ waitMs: config.commandTimeoutMs, pollMs: config.pollMs, budget: activeBudget() })
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
  async function offer({ repo, pr, head }, { note = "", mode = "manual" } = {}) {
    if (!SHA.test(head)) throw new DeliveryError("approved SHA must be a full commit SHA")
    if (await cancelled(repo, pr, head)) return { message: "QUEUED WORK CANCELLED", enqueued: false }
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
  const publication = new AsyncLocalStorage()
  const activeBudget = () => publication.getStore() ?? budget()
  const settlement = fn => publication.run(new Deadline(config.commandTimeoutMs), fn)
  async function consume(repo, { perform, hasUnresolved = async () => false, onOutcome = async () => {} }) {
    const entry = await queueState(queue => queue.find(e => e.repo === repo && e.state !== "acknowledged" && e.availableAt <= Date.now()))
    if (!entry) return { message: "QUEUE IDLE", idle: true }
    return withLease(locks, `pr-${keyFor(entry.repo, entry.pr)}`, async writer => {
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
        try { outcome = pass(await perform(entry, writer)) }
        catch (e) {
          // Provider reads can fail before reaching mutation's reconciliation
          // path. Durable intents keep their obligation even across those stops.
          let unresolved = true
          try { unresolved = await hasUnresolved(entry) } catch { /* Unknown journal state must reconcile. */ }
          if (unresolved) e.uncertain = true
          if (e.cancelled && !unresolved) outcome = pass({ message: "QUEUED WORK CANCELLED", cancelled: true })
          else outcome = fail(e)
        }
        await settlement(async () => {
          if (outcome.data.pendingUpdate || outcome.data.uncertain || (outcome.data.state ? !outcome.data.terminal : outcome.data.transient && stored.attempts < 3 || outcome.data.code === 75)) {
            await queueTransition(entry.id, "effect-requested", { attempts: stored.attempts + 1, availableAt: outcome.data.retryAt ?? Date.now() + config.retryMs,
              owner: null, lastResult: outcome, nextAction: "reconcile-provider" }, { requeue: true })
          } else {
            stored = await queueTransition(entry.id, "reconciled", { attempts: stored.attempts + 1, outcome })
          }
        })
        if (stored.state !== "reconciled") return outcome.data.state ? { ...outcome, data: { ...outcome.data, processed: true } } : { message: outcome.data.message, processed: true, outcome, code: 0 }
      }
      await settlement(() => queueTransition(entry.id, "acknowledged", { owner: null, nextAction: "none" }))
      await onOutcome({ step: "merge", repo: entry.repo, pr: entry.pr, head: entry.head, attemptId: stored.attemptId, effectId: stored.effectId, ...outcome.data })
      return outcome.data.state ? { ...outcome, data: { ...outcome.data, processed: true } } : { message: outcome.data.message, processed: true, outcome, code: 0 }
    }, { budget: activeBudget() })
  }
  async function queueSummary() {
    return queueState(async queue => {
      const pending = queue.filter(e => e.state === "pending").length
      const terminal = queue.filter(e => e.state === "acknowledged").length
      const owned = queue.length - pending - terminal
      const effectIds = queue.map(e => e.effectId).filter(Boolean)
      const orphanLeases = await orphanLeaseCount(locks, { recover: true, budget: activeBudget() })
      return { offered: queue.length, pending, owned, terminal,
        orphanLeases,
        duplicateEffectIds: effectIds.length - new Set(effectIds).size,
        nextAction: effectIds.length !== new Set(effectIds).size ? "stop-and-reconcile-duplicate-effects"
          : orphanLeases ? "wait-for-supervised-child-or-recover-lease" : owned ? "reconcile-provider" : "consume-pending" }
    })
  }
  const repairFile = (repo, pr) => path.join(config.stateDir,"repairs",`${keyFor(repo,pr)}.json`)
  const repairReceipt = record => path.join(config.stateDir,"repair-receipts",`${record.id}.json`)
  async function retainRepair(record) {
    const file=repairReceipt(record), bytes=JSON.stringify(record)
    await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700})
    const temp=`${file}.${randomUUID()}.tmp`
    await writeJson(temp,record)
    try {await fs.link(temp,file)}
    catch(error) {
      if(error.code!=="EEXIST")throw error
      if(await fs.readFile(file,"utf8")!==bytes)throw new DeliveryError("terminal repair receipt changed",9)
    } finally {await fs.unlink(temp)}
    return file
  }
  async function saveRepair(record) {
    if (record?.schema !== "factory-repair-delivery/v1" || !isDeliveryBinding(record) || !record.id)
      throw new DeliveryError("repair receipt repository binding mismatch", 9)
    await writeJson(repairFile(record.repo, record.pr), record)
  }
  async function deliverRepair(record, publish) {
    const terminal = { ...record, status: "delivered" }
    const receipt = await retainRepair(terminal)
    if (publish) {
      await saveRepair({ ...record, status: "inbox_pending" })
      await publish(receipt)
    }
    await saveRepair(terminal)
    return { head: terminal.head, receipt }
  }
  async function recoveryCandidates() {
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
    }
  // A durable intent is never resent on missing acknowledgement. Provider state
  // must reconcile it first; confirmed refusals may be retried with a new attempt.
  async function effect({ repo, pr, head, action, fields }, { observe: observeEffect, dispatch, confirmed, reconcileOnly = false }) {
    const id = effectId({ repo, pr, head, action, fields })
    const file = path.join(config.stateDir, "effects", `${id}.json`)
    return withLease(locks, `effect-${id}`, async () => {
      let record = await readJson(file, null)
      if (record && (record.schema !== "factory-effect/v1" || record.id !== id || record.repo !== repo || record.pr !== pr ||
          record.head !== head || record.action !== action || !Number.isSafeInteger(record.attempt) || record.attempt <= 0 ||
          !/^[0-9a-f-]{36}$/.test(record.attemptId ?? "") || !["effect-requested", "acknowledged", "refused"].includes(record.state)))
        throw new DeliveryError("invalid persisted effect binding", 9)
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
          const result = await dispatch().catch(async error => {
            // An explicit write refusal or proven non-launch is known. A failed
            // reconciliation read is handled separately and remains uncertain.
            if (error.uncertain === false || error.state === "auth_error") {
              const refused = { ...record, state: "refused" }
              await writeJson(file, refused); record = refused
            }
            throw error
          })
          await onTransition(`provider:${action}:returned`, record)
          if (result.ok && confirmed(result)) return acknowledge(result)
          if (result.transient || result.ok) return acknowledge(await reconcile())
          await writeJson(file, { ...record, state: "refused", status: result.status })
          return result
        })
      })
    }, { budget: activeBudget() })
  }
  const effectId = ({ repo, pr, head, action, fields }) => deliveryEffectId({ repo, pr, head,
    action: `${action}:${digestOf(JSON.stringify(fields))}` })
  const effectFile = binding => path.join(config.stateDir, "effects", `${effectId(binding)}.json`)
  async function hasPendingEffect({ repo, pr, head }) {
    const dir = path.join(config.stateDir, "effects")
    const names = await fs.readdir(dir).catch(error => { if (error.code === "ENOENT") return []; throw error })
    for (const name of names) {
      if (!name.endsWith(".json")) continue
      const record = await readJson(path.join(dir, name), null)
      if (record?.repo === repo && record.pr === pr && record.head === head && record.state === "effect-requested") return true
    }
    return false
  }
  return {
    queue: { offer, cancel: cancelQueued, consume, summary: queueSummary },
    effects: { execute: effect, hasPending: hasPendingEffect,
      has: async binding => Boolean(await readJson(effectFile(binding), null)) },
    repairs: { read: (repo, pr, fallback = null) => readJson(repairFile(repo, pr), fallback),
      save: saveRepair, retain: retainRepair, deliver: deliverRepair },
    waits: { record: (repo, pr, input, stop) => deliveryWait(config, repo, pr, input, stop, activeBudget()),
      complete: (repo, pr) => completeDeliveryWait(config, repo, pr, activeBudget()) },
    cancelled, requireNotCancelled, launchFence, recoveryCandidates
  }
}

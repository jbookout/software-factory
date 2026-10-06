const SHA = /^[0-9a-f]{40}$/
export function validRequiredChecks(checks) {
  return Array.isArray(checks) && checks.length > 0 && checks.every(c => c && typeof c.name === "string" && c.name.trim() &&
    (c.appId === undefined || Number.isSafeInteger(c.appId) && c.appId > 0)) &&
    new Set(checks.map(c => c.name)).size === checks.length
}

// Provider observations are data, never a green boolean. Retain all original
// evidence while selecting the latest attempt for each exact context/producer.
export function classifyChecks({ head, observedHead, requiredChecks, checkRuns, statuses }) {
  const evidence = [...(Array.isArray(checkRuns) ? checkRuns : []), ...(Array.isArray(statuses) ? statuses : [])]
  const result = (state, extra = {}) => ({ state, evidence, nextAction: "retry-provider-observation", ...extra })
  if (!SHA.test(head ?? "") || !SHA.test(observedHead ?? "")) return result("provider-unknown")
  if (head !== observedHead) return result("superseded", { nextAction: "observe-current-head" })
  if (!validRequiredChecks(requiredChecks) || !Array.isArray(checkRuns) || !Array.isArray(statuses)) return result("provider-unknown")
  const latest = new Map()
  const pending = new Set(["queued", "in_progress", "waiting", "requested", "pending"])
  const failures = new Set(["failure", "error", "cancelled", "timed_out", "action_required", "stale", "startup_failure"])
  const runStatuses = new Set(["queued", "in_progress", "waiting", "requested", "pending", "completed"])
  const runConclusions = new Set(["success", "skipped", "neutral", "failure", "cancelled", "timed_out", "action_required", "stale", "startup_failure"])
  for (const c of evidence) {
    if (!c || !SHA.test(c.head_sha ?? "") || !Number.isSafeInteger(c.id) || c.id <= 0) return result("provider-unknown")
    if (c.head_sha !== head) continue
    const name = c.name ?? c.context, appId = c.name ? c.app?.id : undefined
    if (typeof name !== "string" || !name || (c.name && (!Number.isSafeInteger(appId) || appId <= 0))) return result("provider-unknown")
    let state
    if (c.name) {
      if (!runStatuses.has(c.status) || (c.status === "completed" ? !runConclusions.has(c.conclusion) : c.conclusion !== null))
        return result("provider-unknown")
      state = c.status === "completed" ? c.conclusion : c.status
    } else {
      if (!["success", "failure", "error", "pending"].includes(c.state)) return result("provider-unknown")
      state = c.state
    }
    if (!["success", "skipped", "neutral"].includes(state) && !pending.has(state) && !failures.has(state)) return result("provider-unknown")
    const key = JSON.stringify([name, appId ?? null])
    if (!latest.has(key) || latest.get(key).id < c.id) latest.set(key, { id: c.id, name, appId, state })
  }
  const missing = [], selected = [...latest.values()]
  const cancelled = selected.some(c => c.state === "cancelled")
  let failed = false, waiting = false, repairable = false
  for (const c of selected) {
    if (failures.has(c.state)) failed = true
    waiting ||= pending.has(c.state)
  }
  for (const required of requiredChecks) {
    const matches = selected.filter(c => c.name === required.name && (required.appId === undefined || c.appId === required.appId))
    repairable ||= matches.some(c => ["failure", "error"].includes(c.state))
    if (!matches.length) { missing.push(required.name); continue }
    if (matches.some(c => ["skipped", "neutral"].includes(c.state))) failed = true
  }
  if (failed) return result("failure", { repairable, cancelled, nextAction: repairable ? "repair-failed-check" : "rerun-required-check" })
  if (waiting || missing.length) return result("pending", { missing, cancelled, nextAction: "wait-for-required-checks" })
  return result("success", { cancelled, nextAction: "verify-review" })
}

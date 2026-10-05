import { canonicalDigest } from "./canonical.mjs";

export function assessRecovery(
  queue,
  { offeredIds, effectIds, expectedEffectIds = [], now = Date.now(), owner },
) {
  const base = {
    schema: "recovery-observation.v1",
    mode: "shadow",
    gateAuthority: false,
    owner: "orchestrator",
    nextAction: "reconcile-disposable-journal-with-provider-before-retry",
    autoClear: "all-offered-jobs-accounted-and-waits-owned",
  };
  if (
    !Array.isArray(queue) ||
    !Array.isArray(offeredIds) ||
    !Array.isArray(effectIds) ||
    !Array.isArray(expectedEffectIds) ||
    typeof owner !== "string" ||
    !/^factory-[a-z-]+$/.test(owner) ||
    !Number.isFinite(now)
  )
    return { ...base, state: "unknown" };
  if (
    queue.some((e) => !e || typeof e.id !== "string" || !e.id) ||
    [offeredIds, effectIds, expectedEffectIds].some((ids) =>
      ids.some((id) => typeof id !== "string" || !id),
    )
  )
    return { ...base, state: "unknown" };
  const ids = queue.map((e) => e.id),
    unique = new Set(ids),
    offered = new Set(offeredIds);
  const lost =
      offeredIds.filter((id) => !unique.has(id)).length +
      expectedEffectIds.filter((id) => !effectIds.includes(id)).length,
    duplicates =
      ids.length - unique.size + effectIds.length - new Set(effectIds).size;
  if (
    lost ||
    duplicates ||
    offered.size !== offeredIds.length ||
    ids.some((id) => !offered.has(id))
  )
    return { ...base, state: "breach", lost, duplicates };
  const waiting = [],
    failures = [];
  for (const entry of queue) {
    if (entry.state === "acknowledged") {
      if (!["pass", "fail"].includes(entry.outcome?.status))
        return { ...base, state: "unknown" };
      if (entry.outcome.status === "fail")
        failures.push({
          id: canonicalDigest(entry.id),
          owner,
          nextAction:
            "inspect-terminal-failure-and-explicitly-reopen-after-repair",
        });
    } else {
      if (
        !["pending", "claimed", "effect-requested", "reconciled"].includes(
          entry.state,
        ) ||
        !Number.isSafeInteger(entry.availableAt) ||
        entry.availableAt < 0
      )
        return { ...base, state: "breach", reason: "waiting-without-wakeup" };
      waiting.push({
        id: canonicalDigest(entry.id),
        owner,
        wakeupAt: new Date(Math.max(now, entry.availableAt)).toISOString(),
        nextAction:
          entry.state === "pending"
            ? "admit-through-existing-queue"
            : "reconcile-provider-before-new-effect",
      });
    }
  }
  return {
    ...base,
    state: waiting.length
      ? "waiting"
      : failures.length
        ? "owned-failure"
        : "recovered",
    lost,
    duplicates,
    offered: offered.size,
    terminal: queue.length - waiting.length,
    waiting,
    failures,
  };
}

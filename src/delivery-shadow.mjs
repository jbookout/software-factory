// Agreement between the shadow delivery path's decisions and what the old
// orchestrator scripts actually did, from factory-delivery-shadow/v1 records.
// One row per (repo, PR, head): its open-state decisions, and the old path's
// latest verdict and merge for that head.
export function compareShadow(records) {
  const heads = new Map()
  for (const r of records) {
    if (r?.schema !== "factory-delivery-shadow/v1") continue
    const key = `${r.repo}#${r.pr}@${r.head}`
    const row = heads.get(key) ?? { repo: r.repo, pr: r.pr, head: r.head, tier: null, wouldReview: null, wouldApprove: null, wouldMerge: false, frozen: false }
    if (r.state === "OPEN") Object.assign(row, { tier: r.tier, wouldReview: r.wouldReview, wouldApprove: r.wouldApprove,
      wouldMerge: row.wouldMerge || r.wouldMerge, frozen: row.frozen || r.frozen })
    row.legacyVerdict = r.legacy.reviewedSha === r.head ? r.legacy.verdict : row.legacyVerdict ?? null
    row.legacyMerged = r.legacy.merged
    heads.set(key, row)
  }
  const rows = [...heads.values()].filter(row => row.tier !== null)
  const name = row => `${row.repo}#${row.pr}@${row.head.slice(0, 12)}`
  const approvals = rows.filter(row => row.wouldApprove !== null && row.legacyVerdict)
  const approvalAgree = approvals.filter(row => row.wouldApprove === (row.legacyVerdict === "APPROVE"))
  const settled = rows.filter(row => row.legacyMerged || row.legacyVerdict)
  const mergeAgree = settled.filter(row => row.wouldMerge === row.legacyMerged)
  const rate = (part, whole) => whole.length ? Math.round(1000 * part.length / whole.length) / 10 : null
  return {
    heads: rows.length,
    tiers: { 1: rows.filter(r => r.tier === 1).length, 2: rows.filter(r => r.tier === 2).length, 3: rows.filter(r => r.tier === 3).length },
    modelReviewsAvoided: rows.filter(r => r.wouldReview === "none").length,
    focusedInsteadOfFull: rows.filter(r => r.wouldReview === "focused").length,
    tier1Approval: { compared: approvals.length, agreePercent: rate(approvalAgree, approvals),
      disagreements: approvals.filter(r => !approvalAgree.includes(r)).map(r => `${name(r)} shadow ${r.wouldApprove ? "APPROVE" : "BLOCK"} / old ${r.legacyVerdict}`) },
    merge: { compared: settled.length, agreePercent: rate(mergeAgree, settled),
      disagreements: settled.filter(r => !mergeAgree.includes(r)).map(r => `${name(r)} shadow ${r.wouldMerge ? "merge" : "hold"} / old ${r.legacyMerged ? "merged" : "not merged"}`),
      mergedWhileFrozen: settled.filter(r => r.frozen && r.legacyMerged).map(name) },
    pending: rows.length - settled.length,
  }
}

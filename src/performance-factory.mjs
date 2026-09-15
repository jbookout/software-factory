import { createHash } from "node:crypto"

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)
}

export function evaluatePerformance({ baseline = {}, current = {}, budgets = {}, knownFingerprints = [] } = {}) {
  const findings = []
  for (const [metric, budget] of Object.entries(budgets)) {
    const before = baseline[metric]
    const after = current[metric]
    if (!Number.isFinite(before) || !Number.isFinite(after)) continue

    const direction = budget.direction ?? "lower"
    const delta = after - before
    const relative = before === 0 ? null : delta / Math.abs(before)
    const absoluteExceeded = Number.isFinite(budget.max)
      && (direction === "lower" ? after > budget.max : after < budget.max)
    const regressionExceeded = Number.isFinite(budget.maxRegression)
      && relative !== null
      && (direction === "lower" ? relative > budget.maxRegression : relative < -budget.maxRegression)

    if (absoluteExceeded || regressionExceeded) {
      const finding = { metric, before, after, delta, relative, direction }
      findings.push({ ...finding, fingerprint: fingerprint(finding) })
    }
  }

  const deduplicated = [...new Map(findings.map((item) => [item.fingerprint, item])).values()]
  const known = new Set(knownFingerprints)
  return {
    status: deduplicated.length ? "fail" : "pass",
    findings: deduplicated.filter((item) => !known.has(item.fingerprint)),
    duplicates: deduplicated.filter((item) => known.has(item.fingerprint)).map(({ fingerprint: value }) => value)
  }
}

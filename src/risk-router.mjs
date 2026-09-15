const REVIEW_ORDER = [
  "Architecture Engineer",
  "Security Engineer",
  "Data Engineer",
  "Infrastructure Engineer",
  "Performance Engineer",
  "UI and Accessibility Engineer",
  "Test Engineer"
]

const PATH_SIGNALS = [
  [/migration|schema|database|\bsql\b/i, "data"],
  [/auth|permission|credential|secret|security/i, "security"],
  [/deploy|wrangler|terraform|\.github\/workflows|infrastructure/i, "operations"],
  [/contract|openapi|graphql|\bapi\b/i, "contract"],
  [/performance|benchmark|latency|throughput/i, "performance"],
  [/\bui\b|component|\.css$|\.tsx$|\.jsx$/i, "interface"],
  [/delete|purge|drop|truncate|retire/i, "destructive"]
]

const WEIGHT = {
  source: 1,
  interface: 1,
  performance: 2,
  contract: 3,
  operations: 3,
  data: 4,
  security: 4,
  destructive: 5
}

export function classifyRisk({ changedPaths = [], signals = [] } = {}) {
  const found = new Set(signals)
  for (const path of changedPaths) {
    let matched = false
    for (const [pattern, signal] of PATH_SIGNALS) {
      if (pattern.test(path)) {
        found.add(signal)
        matched = true
      }
    }
    if (!matched && /\.(mjs|js|ts|py|java|go|rs)$/.test(path)) found.add("source")
  }

  const score = [...found].reduce((total, signal) => total + (WEIGHT[signal] ?? 1), 0)
  const level = found.has("destructive") || score >= 7
    ? "critical"
    : score >= 4
      ? "high"
      : score >= 2
        ? "medium"
        : "low"

  return { level, score, signals: [...found].sort() }
}

export function reviewsFor(risk) {
  const roles = new Set(["Test Engineer"])
  if (risk.level !== "low") roles.add("Architecture Engineer")
  if (risk.signals.includes("security")) roles.add("Security Engineer")
  if (risk.signals.includes("data")) roles.add("Data Engineer")
  if (risk.signals.some((value) => ["operations", "destructive"].includes(value))) {
    roles.add("Infrastructure Engineer")
  }
  if (risk.signals.includes("performance")) roles.add("Performance Engineer")
  if (risk.signals.includes("interface")) roles.add("UI and Accessibility Engineer")
  return REVIEW_ORDER.filter((role) => roles.has(role))
}

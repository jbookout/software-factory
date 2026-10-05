// Reader for carr-system's review-tiers.v1 schema and its
// repository-review-decision/v1 record (carr lib/review_tiers.py). The
// decision is computed exactly as carr computes it; routeTier() then applies
// the factory's dispatch rule: anything unknown, unparseable or unclassified
// gets the full tier-3 review.
import { createHash } from "node:crypto"
import fs from "node:fs/promises"

const SCHEMA_VERSION = "review-tiers.v1"
const MATCH_KINDS = ["path", "prefix", "suffix", "basename", "contains"]
const CLASSES = ["protected", "security_sensitive", "adversarial"]
const TOP_TIER = 3
const isTier = value => Number.isInteger(value) && value >= 1 && value <= 3

function validate(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return ["map must be an object"]
  const problems = []
  if (doc.schema_version !== SCHEMA_VERSION) problems.push(`schema_version must be ${SCHEMA_VERSION}`)
  for (const key of ["purpose", "provenance"]) if (typeof doc[key] !== "string" || !doc[key].trim()) problems.push(`${key} missing`)
  if (!isTier(doc.default_tier)) problems.push("default_tier must be 1, 2 or 3")
  const rows = (name, tiered) => {
    const list = doc[name]
    if (!Array.isArray(list) || !list.length) return problems.push(`${name} must be a non-empty list`)
    const seen = new Set()
    for (const row of list) {
      if (!row || typeof row !== "object" || typeof row.id !== "string" || !row.id || seen.has(row.id) ||
          !MATCH_KINDS.includes(row.match) || typeof row.pattern !== "string" || !row.pattern ||
          ("case_insensitive" in row && typeof row.case_insensitive !== "boolean") ||
          typeof row.why !== "string" || !row.why.trim() ||
          (tiered && (!isTier(row.tier) || !CLASSES.includes(row.class)))) problems.push(`${name}: invalid row ${row?.id ?? "?"}`)
      seen.add(row?.id)
    }
  }
  rows("rules", true); rows("noise_exclusions", false); rows("never_exclude", false)
  if ("test_files" in doc) rows("test_files", false)
  if ("change_size" in doc) {
    const size = doc.change_size
    if (!size || typeof size !== "object" || Object.keys(size).sort().join() !== "medium_max_code_lines,small_max_code_lines" ||
        !Object.values(size).every(v => Number.isSafeInteger(v) && v >= 0) || size.small_max_code_lines > size.medium_max_code_lines)
      problems.push("change_size: expected ordered nonnegative integer limits")
  }
  const tunables = doc.tunable_scalars ?? []
  if (!Array.isArray(tunables) || tunables.some(r => !r || Object.keys(r).sort().join() !== "field,maximum,minimum,path" ||
      typeof r.path !== "string" || !r.path || typeof r.field !== "string" || !r.field ||
      !Number.isInteger(r.minimum) || !Number.isInteger(r.maximum) || r.minimum < 0 || r.maximum < r.minimum))
    problems.push("tunable_scalars: expected a named integer field and nonnegative range")
  return problems
}

function normalize(path) {
  if (typeof path !== "string" || !path) return null
  path = path.replaceAll("\\", "/")
  while (path.startsWith("./")) path = path.slice(2)
  return path || null
}

function matches(row, path) {
  const [subject, pattern] = row.case_insensitive ? [path.toLowerCase(), row.pattern.toLowerCase()] : [path, row.pattern]
  switch (row.match) {
    case "path": return subject === pattern
    case "prefix": return subject.startsWith(pattern)
    case "suffix": return subject.endsWith(pattern)
    case "basename": return subject.split("/").at(-1) === pattern
    case "contains": return subject.includes(pattern)
  }
  throw new Error(`unknown match kind ${row.match}`)
}

function tierForPath(path, doc) {
  const normal = normalize(path)
  if (normal === null) return TOP_TIER
  return doc.rules.reduce((tier, row) => row.tier > tier && matches(row, normal) ? row.tier : tier, doc.default_tier)
}

// Python json.dumps(sort_keys=True, separators=(",", ":")), ensure_ascii on.
function pythonJson(value) {
  const sorted = v => Array.isArray(v) ? v.map(sorted) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])])) : v
  return JSON.stringify(sorted(value)).replace(/[\u007f-￿]/g, c => c === "\u007f" ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
}
const sameJson = (a, b) => pythonJson(a) === pythonJson(b)
const sha256 = bytes => "sha256:" + createHash("sha256").update(bytes).digest("hex")

export function isTestFile(path, doc) {
  const normal = normalize(path)
  return normal !== null && (doc.test_files ?? []).some(row => matches(row, normal))
}

function changeSummary(changes, doc) {
  const code_paths = [], test_paths = []
  let code_lines = 0, test_lines = 0
  for (const change of changes) {
    const test = isTestFile(change.path, doc)
    ;(test ? test_paths : code_paths).push(change.path)
    const counts = [change.additions === undefined ? 0 : change.additions, change.deletions === undefined ? 0 : change.deletions]
    const known = counts.every(v => Number.isSafeInteger(v) && v >= 0)
    if (test) test_lines = known && test_lines !== null ? test_lines + counts[0] + counts[1] : null
    else code_lines = known && code_lines !== null ? code_lines + counts[0] + counts[1] : null
  }
  const limits = doc.change_size
  const change_size = code_lines === null || !limits ? "unknown" : code_lines <= limits.small_max_code_lines ? "small"
    : code_lines <= limits.medium_max_code_lines ? "medium" : "large"
  return {code_lines, test_lines, change_size, code_paths, test_paths}
}

export function reviewDecision(changes, { base, head, policyRevision, diffDigest, doc }) {
  const problems = validate(doc)
  if (problems.length) throw new Error(`invalid review policy: ${problems.slice(0, 3).join("; ")}`)
  const summary = changeSummary(changes, doc)
  let bounded = changes.length > 0 && !summary.test_paths.length
  const fields = []
  for (const change of changes) {
    if (change.mode_changed) bounded = false
    const { before, after } = change
    const object = v => v && typeof v === "object" && !Array.isArray(v)
    if (!object(before) || !object(after) || !sameJson(Object.keys(before).sort(), Object.keys(after).sort())) { bounded = false; continue }
    const changed = Object.keys(before).filter(key => !sameJson(before[key], after[key]))
    if (!changed.length) bounded = false
    for (const field of changed) {
      const rule = (doc.tunable_scalars ?? []).find(r => r.path === change.path && r.field === field)
      if (!rule || ![before[field], after[field]].every(v => Number.isInteger(v) && rule.minimum <= v && v <= rule.maximum)) bounded = false
      else fields.push({ path: change.path, field, before: before[field], after: after[field] })
    }
  }
  return { schema: "repository-review-decision/v1", base, head, policy_revision: policyRevision, diff_digest: diffDigest,
    policy_digest: sha256(pythonJson(doc)), changed_paths: changes.map(c => c.path), ...summary,
    lane: bounded ? "tunable_scalar" : "review",
    tier: bounded ? 1 : Math.max(...changes.map(c => tierForPath(c.path, doc)), doc.default_tier, summary.test_paths.length ? 2 : 1),
    validated_fields: bounded ? fields : [], required_ci: true }
}

// Dispatch tier: carr's bounded tunable lane and fully classified change sets
// keep the decision's tier; anything the policy does not name is tier 3.
export function routeTier(decision, doc) {
  if (!decision || decision.schema !== "repository-review-decision/v1" || !isTier(decision.tier) || validate(doc).length)
    return { tier: TOP_TIER, reason: "unknown or unparseable review decision" }
  if (!decision.changed_paths?.length) return { tier: TOP_TIER, reason: "empty change set" }
  if (decision.lane === "tunable_scalar") return { tier: decision.tier, reason: "bounded tunable scalar" }
  const unclassified = decision.changed_paths.filter(p => normalize(p) === null || !doc.rules.some(row => matches(row, normalize(p))))
  if (unclassified.length) return { tier: TOP_TIER, reason: `unclassified path: ${unclassified.slice(0, 3).join(", ")}` }
  return { tier: decision.tier, reason: "classified by policy" }
}

function strictJson(text) {
  return JSON.parse(text, (key, value) => {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("nonfinite JSON")
    return value
  })
}

// One decision for a PR's own change (merge-base..head), bound to the policy
// the repository declares. `git` returns raw stdout: the diff digest is over
// the exact bytes. Every failure is a tier-3 route, never a throw.
export async function decideReview({ git, cwd, base, head, policy }) {
  try {
    if (!policy?.repositoryPath && !policy?.file) return { tier: TOP_TIER, reason: "no review policy configured", decision: null, digest: null }
    const raw = policy.file ? await fs.readFile(policy.file, "utf8") : await git(cwd, "show", `${base}:${policy.repositoryPath}`)
    const doc = strictJson(raw)
    const policyRevision = policy.file ? sha256(raw) : base
    const paths = (await git(cwd, "diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", base, head)).split("\0").filter(Boolean)
    const content = async (revision, file) => {
      const entry = await git(cwd, "ls-tree", revision, "--", file)
      if (!/^100(644|755) blob /.test(entry)) return null
      try { return strictJson(await git(cwd, "show", `${revision}:${file}`)) } catch { return null }
    }
    const mode = async (revision, file) => (await git(cwd, "ls-tree", revision, "--", file)).slice(0, 6)
    const counts = new Map((await git(cwd, "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--numstat", "-z", base, head)).split("\0").filter(Boolean).map(entry => {
      const first = entry.indexOf("\t"), second = entry.indexOf("\t", first + 1)
      const added = entry.slice(0, first), deleted = entry.slice(first + 1, second), path = entry.slice(second + 1)
      return [path, {additions: added === "-" ? null : Number(added), deletions: deleted === "-" ? null : Number(deleted)}]
    }))
    const changes = []
    for (const file of paths) changes.push({ path: file, ...counts.get(file), before: await content(base, file), after: await content(head, file),
      mode_changed: await mode(base, file) !== await mode(head, file) })
    const diffDigest = sha256(await git(cwd, "diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-renames", base, head))
    const decision = reviewDecision(changes, { base, head, policyRevision, diffDigest, doc })
    return { ...routeTier(decision, doc), decision, digest: sha256(pythonJson(decision)) }
  } catch (error) {
    return { tier: TOP_TIER, reason: `review policy unreadable: ${error.message.split("\n")[0].slice(0, 120)}`, decision: null, digest: null }
  }
}

export async function assembleReviewDiff({git, cwd, base, head, decision}) {
  const diff = paths => paths.length ? git(cwd, "--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", base, head, "--", ...paths) : "(none)\n"
  if (!decision) return "Code changes (classification unavailable; review the full diff)\n" +
    await git(cwd, "diff", "--no-ext-diff", "--no-textconv", "--no-renames", base, head) + "\nTests (evidence)\nClassification unavailable; tests remain in the full diff above.\n"
  return "Code changes\n" + await diff(decision.code_paths) + "\nTests (evidence)\n" + await diff(decision.test_paths)
}

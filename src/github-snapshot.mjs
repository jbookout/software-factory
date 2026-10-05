import { classifyChecks } from "./pr-readiness.mjs"
import { DeliveryError, pause } from "./pr-delivery-state.mjs"
import { DeadlineError } from "./deadline.mjs"
import { randomUUID } from "node:crypto"

export function readProbe(client,route,result) {
 const tls=/x509: OSStatus -?\d+/.exec(result.stderr??'')?.[0]
 return {client,route,ok:result.code===0,kind:result.code===0?'success':tls?'tls':'transport',
  ...result.code===0?{}:{error:tls??`transport exit ${result.code}`}}
}
export function probeAvailability(probes) {
 const route=probes[0]?.route
 return {route,availability:probes.some(p=>p.route===route && p.ok)?'reachable':'unproven',probes}
}


const SHA = /^[0-9a-f]{40}$/
const PAGE_SIZE = 25
const MAX_ROWS = 10_000
const fail = (message, transient = false) => { throw new DeliveryError(message, 1, transient) }
const freeze = value => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

const REVIEW_VERDICTS = new Set(["APPROVE", "BLOCK", "REVIEW: BLOCKED", "CHANGES REQUESTED"])
function reviewEnvelope(body) {
  if (typeof body !== "string") return { attempted: false, review: null }
  const [verdict, line] = body.split(/\r?\n/)
  const sha = /^Reviewed-SHA: ([0-9a-f]{40})$/.exec(line ?? "")?.[1]
  // A reserved envelope field or a whitespace-damaged verdict is an attempted
  // review. Ordinary prose remains a note; damaged envelopes revoke approval.
  const attempted = REVIEW_VERDICTS.has(verdict.trim()) || /^Reviewed-SHA:/m.test(body)
  return { attempted, review: sha && REVIEW_VERDICTS.has(verdict) ? { verdict, sha, body } : null }
}
export function parseReview(body) { return reviewEnvelope(body).review }

// The latest trusted author's verdict wins, including a blocking verdict.
// Approval additionally needs the existing independent execution receipt.
export async function latestTrustedReview(comments, trustedReviewers, authenticate) {
  const ordered = [...comments].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)
  for (const comment of ordered) {
    if (!trustedReviewers.some(login => login.toLowerCase() === comment.user.login.toLowerCase())) continue
    const { attempted, review: candidate } = reviewEnvelope(comment.body)
    if (!attempted) continue
    if (!candidate) return null
    return candidate.verdict !== "APPROVE" || await authenticate(candidate) ? candidate : null
  }
  return null
}

function prValue(value, repo, pr) {
  if (!value || value.number !== pr || !["open", "closed"].includes(value.state) ||
      typeof value.merged !== "boolean" || typeof value.draft !== "boolean" || typeof value.title !== "string" || (value.body != null && typeof value.body !== "string") ||
      !SHA.test(value.head?.sha ?? "") || !SHA.test(value.base?.sha ?? "") ||
      typeof value.head.ref !== "string" || !value.head.ref || typeof value.base.ref !== "string" || !value.base.ref ||
      value.base.repo?.full_name !== repo || typeof value.head.repo?.full_name !== "string" ||
      !Number.isSafeInteger(value.comments) || value.comments < 0 ||
      ![true, false, null].includes(value.mergeable) || typeof value.mergeable_state !== "string" ||
      (value.merged && !SHA.test(value.merge_commit_sha ?? ""))) fail("invalid GitHub PR response")
  return { number: pr, title: value.title, description: value.body ?? "", state: value.merged ? "MERGED" : value.state.toUpperCase(),
    baseRefName: value.base.ref, baseRefOid: value.base.sha, recordedBaseOid: value.base.sha, headRefName: value.head.ref, headRefOid: value.head.sha,
    head: { sha: value.head.sha, ref: value.head.ref, repo: value.head.repo.full_name },
    base: { sha: value.base.sha, ref: value.base.ref, repo: value.base.repo.full_name },
    isCrossRepository: value.head.repo.full_name !== repo, mergeStateStatus: value.mergeable_state.toUpperCase(),
    mergeable: value.mergeable === true ? "MERGEABLE" : value.mergeable === false ? "CONFLICTING" : "UNKNOWN",
    isDraft: value.draft, mergeCommit: { oid: value.merge_commit_sha ?? null },
    commentCount: value.comments, updatedAt: value.updated_at ?? null }
}

// All callers cross this interface. No durable cache: mutable comments/checks
// are shared only within an observation, and every effect gets a fresh read.
export function createGithubProvider(config, { command, getRepo, authenticate, now = Date.now, withRead = (repo, fn) => fn(pause) }) {
  const observations = new Map()
  async function transport(repo, route, { method = "GET", fields = {}, owners = [], metrics, sleep = pause } = {}) {
    const argv = ["gh", "api", `repos/${repo}/${route}`, "--include"]
    if (method !== "GET") argv.push("-X", method, "--input", "-")
    for (let attempt = 0; ; attempt++) {
      if (metrics) metrics.providerCalls++
      const response = await command(argv, getRepo(repo).checkout, { allowFailure: true, maxOutputBytes: 16_000_000,
        ...(method !== "GET" ? { input: JSON.stringify(fields), mutation: true, onSpawn: (job, signal) => Promise.all(owners.map(owner => owner.bindJob(job, signal))) } : {}) })
      const parts = response.stdout.split(/\r?\n\r?\n/), headers = parts.shift() ?? ""
      const status = Number(/^HTTP\/[^ ]+ (\d+)/.exec(headers)?.[1])
      const exhausted = status === 403 && /^x-ratelimit-remaining: 0\s*$/im.test(headers)
      const transient = method !== "GET" && !Number.isFinite(status) || exhausted || [429, 500, 502, 503, 504].includes(status)
      let value
      try { value = JSON.parse(parts.join("\n\n")) } catch { value = undefined }
      const ok = !response.code && status >= 200 && status < 300
      // Effects are sent exactly once and bound to their writers' leases. The
      // caller reconciles absent or ambiguous acknowledgements from observations.
      if (method !== "GET") return { value, headers, status, ok, transient }
      if (ok) {
        if (value === undefined) fail("invalid GitHub REST JSON")
        return { value, headers, probe:readProbe("gh",`repos/${repo}/${route}`,response) }
      }
      if (!transient || attempt >= 2) {
        const probe=readProbe("gh",`repos/${repo}/${route}`,response)
        const error=new DeliveryError(`GitHub REST observation unavailable: ${probe.kind}; client=${probe.client}; route=${probe.route}; probe=${probe.error}; service availability unproven`,1,transient)
        error.probe=probe
        throw error
      }
      const guidance = /^retry-after: ([^\r\n]+)/im.exec(headers)?.[1]
      const retryAfter = guidance === undefined ? NaN : /^\d+$/.test(guidance) ? Number(guidance) * 1000 : Date.parse(guidance) - now()
      const reset = Number(/^x-ratelimit-reset: (\d+)/im.exec(headers)?.[1]) * 1000 - now()
      const delay = Number.isFinite(retryAfter) ? retryAfter : exhausted && Number.isFinite(reset) ? Math.max(0, reset) : config.retryMs
      if (delay > config.commandTimeoutMs) fail("GitHub REST waiting for provider reset", true)
      await sleep(delay)
    }
  }
  const request = (repo, route, options = {}) => withRead(repo, sleep => transport(repo, route, { metrics: options.metrics, sleep }))
  const mutate = (repo, method, route, fields, owners = []) => transport(repo, route, { method, fields, owners })
  async function pages(repo, route, { field, expected = null, metrics, rowKey = null } = {}) {
    const rows = [], ids = new Set()
    let promisedNext = false
    for (let page = 1; page <= MAX_ROWS / PAGE_SIZE; page++) {
      const { value, headers } = await request(repo, `${route}${route.includes("?") ? "&" : "?"}per_page=${PAGE_SIZE}&page=${page}`, { metrics })
      const batch = field ? value?.[field] : value
      if (!Array.isArray(batch) || batch.length > PAGE_SIZE || field && (!Number.isSafeInteger(value.total_count) || value.total_count < 0))
        fail("invalid GitHub REST page")
      if (promisedNext && batch.length === 0) fail("missing GitHub REST page", true)
      if (field) {
        if (expected !== null && expected !== value.total_count) fail("GitHub REST pages changed during observation", true)
        expected = value.total_count
      }
      for (const row of batch) {
        const id = rowKey ? rowKey(row) : row?.id
        if (!(rowKey ? typeof id === "string" && id.length > 0 : Number.isSafeInteger(id) && id > 0) || ids.has(id)) fail("invalid or duplicate GitHub REST row")
        ids.add(id)
      }
      rows.push(...batch)
      const next = /<([^>]+)>;\s*rel="next"/i.exec(/^link: (.*)$/im.exec(headers)?.[1] ?? "")?.[1]
      if (next) {
        const url = new URL(next)
        const expectedUrl = new URL(`https://api.github.com/repos/${repo}/${route}`)
        if (url.origin !== expectedUrl.origin || url.pathname !== expectedUrl.pathname || Number(url.searchParams.get("page")) !== page + 1 ||
            Number(url.searchParams.get("per_page")) !== PAGE_SIZE || batch.length === 0) fail("invalid GitHub REST pagination link")
      }
      if (!next && batch.length < PAGE_SIZE) {
        if (expected !== null && rows.length !== expected) fail("incomplete GitHub REST pages", true)
        return rows
      }
      promisedNext = Boolean(next)
    }
    fail("GitHub REST scan exceeds repository bound")
  }
  async function liveTarget(repo, current, metrics) {
    const { value } = await request(repo, `git/ref/heads/${current.base.ref.split("/").map(encodeURIComponent).join("/")}`, { metrics })
    if (value?.ref !== `refs/heads/${current.base.ref}` || value.object?.type !== "commit" || !SHA.test(value.object.sha ?? ""))
      fail("invalid GitHub target ref response")
    return { ...current, baseRefOid: value.object.sha, base: { ...current.base, sha: value.object.sha } }
  }
  async function collect(repo, pr, { head, requireApproval = false, observeChecks = true } = {}) {
    getRepo(repo)
    const metrics = { providerCalls: 0, staleActions: 0 }, startedAt = new Date(now()).toISOString()
    const base = { schema: "factory-github-snapshot/v1", observationId: randomUUID(), repo, pr, startedAt, metrics }
    try {
      const policy = structuredClone({ requiredChecks: getRepo(repo).requiredChecks, trustedReviewers: getRepo(repo).trustedReviewers })
      if (!Number.isSafeInteger(pr) || pr <= 0 || head !== undefined && !SHA.test(head)) fail("invalid GitHub snapshot request")
      const initialRead=await request(repo, `pulls/${pr}`, { metrics })
      const initial = await liveTarget(repo, prValue(initialRead.value, repo, pr), metrics)
      const observedHead = head ?? initial.headRefOid
      const comments = await pages(repo, `issues/${pr}/comments`, { expected: initial.commentCount, metrics })
      if (comments.some(c => typeof c.body !== "string" || typeof c.user?.login !== "string" ||
          !Number.isFinite(Date.parse(c.created_at)) || !Number.isFinite(Date.parse(c.updated_at)))) fail("invalid GitHub comments response")
      const review = await latestTrustedReview(comments, policy.trustedReviewers, candidate => authenticate(repo, pr, candidate))
      const refused = requireApproval && (review?.verdict !== "APPROVE" || review.sha !== initial.headRefOid)
      const checkRuns = refused || !observeChecks ? null : await pages(repo, `commits/${observedHead}/check-runs?filter=all`, { field: "check_runs", metrics })
      const statuses = refused || !observeChecks ? null : (await pages(repo, `commits/${observedHead}/statuses`, { metrics })).map(s => ({ ...s, head_sha: observedHead }))
      const finalRead=await request(repo, `pulls/${pr}`, { metrics })
      const final = await liveTarget(repo, prValue(finalRead.value, repo, pr), metrics)
      const availability=probeAvailability([initialRead.probe,finalRead.probe])
      if (JSON.stringify(initial) !== JSON.stringify(final) || JSON.stringify(policy) !==
          JSON.stringify({ requiredChecks: getRepo(repo).requiredChecks, trustedReviewers: getRepo(repo).trustedReviewers })) {
        metrics.staleActions++
        fail("GitHub snapshot bindings changed during observation", true)
      }
      if (refused) return freeze({ ...base, ...final, state: "refused", prState: final.state, availability,
        reason: "no-current-trusted-approval", comments, review, ci: { state: "unobserved", nextAction: "await-trusted-review" },
        inventory: { comments, checkRuns: null, statuses: null, requiredChecks: policy.requiredChecks },
        fetchedAt: new Date(now()).toISOString(), errors: [] })
      const ci = observeChecks ? classifyChecks({ head: observedHead, observedHead: final.headRefOid, requiredChecks: policy.requiredChecks, checkRuns, statuses })
        : { state: "unobserved", nextAction: "await-updated-head" }
      if (ci.state === "provider-unknown") fail("invalid hosted checks response")
      return freeze({ ...base, ...final, state: "known", prState: final.state, availability, comments, ci, review,
        inventory: { comments, checkRuns, statuses, requiredChecks: policy.requiredChecks },
        fetchedAt: new Date(now()).toISOString(), errors: [] })
    } catch (error) {
      return freeze({ ...base, state: "unknown", availability:probeAvailability(error.probe?[error.probe]:[]), fetchedAt: new Date(now()).toISOString(),
        ci: { state: "provider-unknown", nextAction: "retry-provider-observation" }, review: null,
        errors: [{ message: error instanceof DeliveryError || error instanceof DeadlineError ? error.message : "GitHub snapshot unavailable", transient: error.transient ?? false, ...(error.probe ? {probe:error.probe} : {}),
          ...(error instanceof DeadlineError ? { code: error.code, phase: error.phase, nextAction: error.nextAction } : {}) }] })
    }
  }
  function snapshot(repo, pr, options = {}) {
    const key = JSON.stringify([repo, pr, options.head ?? null, options.requireApproval ?? false, options.observeChecks ?? true])
    if (!observations.has(key)) {
      const pending = collect(repo, pr, options).finally(() => observations.delete(key))
      observations.set(key, pending)
    }
    return observations.get(key)
  }
  return { snapshot, pages, request, mutate }
}

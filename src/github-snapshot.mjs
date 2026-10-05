import { classifyChecks } from "./pr-readiness.mjs"
import { DeliveryError } from "./pr-delivery-state.mjs"
import { DeadlineError } from "./deadline.mjs"
import { randomUUID } from "node:crypto"
import { createGitHubObservation } from "./github-observation.mjs"

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
  return { number: pr, title: value.title, body: value.body ?? "", state: value.merged ? "MERGED" : value.state.toUpperCase(),
    baseRefName: value.base.ref, baseRefOid: value.base.sha, recordedBaseOid: value.base.sha, headRefName: value.head.ref, headRefOid: value.head.sha,
    head: { sha: value.head.sha, ref: value.head.ref, repo: value.head.repo.full_name },
    base: { sha: value.base.sha, ref: value.base.ref, repo: value.base.repo.full_name },
    isCrossRepository: value.head.repo.full_name !== repo, mergeStateStatus: value.mergeable_state.toUpperCase(),
    mergeable: value.mergeable === true ? "MERGEABLE" : value.mergeable === false ? "CONFLICTING" : "UNKNOWN",
    isDraft: value.draft, mergeCommit: { oid: value.merge_commit_sha ?? null },
    author: typeof value.user?.login === "string" ? value.user.login : null,
    labels: Array.isArray(value.labels) && value.labels.every(l => typeof l?.name === "string") ? value.labels.map(l => l.name) : [],
    commentCount: value.comments, updatedAt: value.updated_at ?? null }
}

// Snapshots coalesce concurrent consumers. Persistent pacing and commit-bound
// evidence are shared through the observer; effects always get fresh bindings.
export function createGithubProvider(config, { command, getRepo, authenticate, now = Date.now, withRead = (repo, fn) => fn(), observer = createGitHubObservation(config, {now}), budget = () => undefined }) {
  const observations = new Map()
  async function transport(repo, route, { method = "GET", fields = {}, owners = [], metrics, validate = () => true, observation, format = "json" } = {}) {
    const argv = ["gh", "api", `repos/${repo}/${route}`, "--include"]
    if (format === "text") argv.push("--allow-escape-sequences")
    if (method !== "GET") argv.push("-X", method, "--input", "-")
    let launched = false, probe
    const response = await observer.request({pool: "rest", key: `${repo}/${route}`, mutation: method !== "GET",
      cache: route.startsWith("commits/"), validate, observation, format}, async () => {
      if (metrics) metrics.providerCalls++
      const result = await command(argv, getRepo(repo).checkout, {allowFailure:true,
        maxOutputBytes:format === "text" ? 4_000_000 : 16_000_000,
        ...(method !== "GET" ? {input:JSON.stringify(fields), mutation:true,
          onSpawn:(job,signal)=>{
            launched=true
            return Promise.all(owners.map(owner=>owner.bindJob(job,signal)))
          }} : {})})
      probe = readProbe("gh", `repos/${repo}/${route}`, result)
      return result
    }, budget()).catch(error => {
      // A provider hold or a pre-launch stop cannot have sent this mutation.
      // Once supervised launch starts, only the runner can prove non-dispatch.
      if (method !== "GET" && !launched) error.uncertain ??= false
      if (probe) error.probe = probe
      throw error
    })
    return {...response, value:response.body, probe}
  }
  const request = (repo, route, options = {}) => withRead(repo, () => transport(repo, route, options))
  const mutate = (repo, method, route, fields, owners = []) => transport(repo, route, { method, fields, owners })
  async function pages(repo, route, { field, expected = null, metrics, rowKey = null, observation, validateRow = () => {} } = {}) {
    const rows = [], ids = new Set()
    let promisedNext = false
    for (let page = 1; page <= MAX_ROWS / PAGE_SIZE; page++) {
      let batch, next
      await request(repo, `${route}${route.includes("?") ? "&" : "?"}per_page=${PAGE_SIZE}&page=${page}`, { metrics, observation, validate: (value, headers) => {
        batch = field ? value?.[field] : value
        if (!Array.isArray(batch) || batch.length > PAGE_SIZE || field && (!Number.isSafeInteger(value.total_count) || value.total_count < 0))
          fail("invalid GitHub REST page")
        if (promisedNext && batch.length === 0) fail("missing GitHub REST page", true)
        if (field) {
          if (expected !== null && expected !== value.total_count) fail("GitHub REST pages changed during observation", true)
          expected = value.total_count
        }
        const pageIds = new Set()
        for (const row of batch) {
          const id = rowKey ? rowKey(row) : row?.id
          if (!(rowKey ? typeof id === "string" && id.length > 0 : Number.isSafeInteger(id) && id > 0) || ids.has(id) || pageIds.has(id)) fail("invalid or duplicate GitHub REST row")
          pageIds.add(id)
          validateRow(row)
        }
        next = /<([^>]+)>;\s*rel="next"/i.exec(/^link: (.*)$/im.exec(headers)?.[1] ?? "")?.[1]
        if (next) {
          const url = new URL(next)
          const expectedUrl = new URL(`https://api.github.com/repos/${repo}/${route}`)
          if (url.origin !== expectedUrl.origin || url.pathname !== expectedUrl.pathname || Number(url.searchParams.get("page")) !== page + 1 ||
              Number(url.searchParams.get("per_page")) !== PAGE_SIZE || batch.length === 0) fail("invalid GitHub REST pagination link")
        }
        if (!next && batch.length < PAGE_SIZE && expected !== null && rows.length + batch.length !== expected)
          fail("incomplete GitHub REST pages", true)
        return true
      } })
      for (const row of batch) ids.add(rowKey ? rowKey(row) : row.id)
      rows.push(...batch)
      if (!next && batch.length < PAGE_SIZE) {
        return rows
      }
      promisedNext = Boolean(next)
    }
    fail("GitHub REST scan exceeds repository bound")
  }
  async function liveTarget(repo, current, metrics, observation) {
    const { value } = await request(repo, `git/ref/heads/${current.base.ref.split("/").map(encodeURIComponent).join("/")}`, { metrics, observation, validate: value => {
      if (value?.ref !== `refs/heads/${current.base.ref}` || value.object?.type !== "commit" || !SHA.test(value.object.sha ?? ""))
        fail("invalid GitHub target ref response")
      return true
    } })
    return { ...current, baseRefOid: value.object.sha, base: { ...current.base, sha: value.object.sha } }
  }
  async function collect(repo, pr, { head, requireApproval = false, observeChecks = true } = {}) {
    getRepo(repo)
    const metrics = { providerCalls: 0, staleActions: 0 }, startedAt = new Date(now()).toISOString()
    const base = { schema: "factory-github-snapshot/v1", observationId: randomUUID(), repo, pr, startedAt, metrics }
    const observation = JSON.stringify([repo,pr,observeChecks])
    try {
      const policy = structuredClone({ requiredChecks: getRepo(repo).requiredChecks, trustedReviewers: getRepo(repo).trustedReviewers })
      if (!Number.isSafeInteger(pr) || pr <= 0 || head !== undefined && !SHA.test(head)) fail("invalid GitHub snapshot request")
      const initialRead = await request(repo, `pulls/${pr}`, { metrics, observation, validate: value => {prValue(value,repo,pr);return true} })
      const initial = await liveTarget(repo, prValue(initialRead.value, repo, pr), metrics, observation)
      const observedHead = head ?? initial.headRefOid
      const comments = await pages(repo, `issues/${pr}/comments`, { expected: initial.commentCount, metrics, observation, validateRow: c => {
        if (typeof c.body !== "string" || typeof c.user?.login !== "string" ||
          !Number.isFinite(Date.parse(c.created_at)) || !Number.isFinite(Date.parse(c.updated_at))) fail("invalid GitHub comments response")
      } })
      const review = await latestTrustedReview(comments, policy.trustedReviewers, candidate => authenticate(repo, pr, candidate))
      const refused = requireApproval && (review?.verdict !== "APPROVE" || review.sha !== initial.headRefOid)
      const checkRuns = refused || !observeChecks ? null : await pages(repo, `commits/${observedHead}/check-runs?filter=all`, { field: "check_runs", metrics, observation, validateRow: row => {
        if (classifyChecks({head:observedHead,observedHead,requiredChecks:policy.requiredChecks,checkRuns:[row],statuses:[]}).state === "provider-unknown") fail("invalid hosted checks response")
      } })
      const statuses = refused || !observeChecks ? null : (await pages(repo, `commits/${observedHead}/statuses`, { metrics, observation, validateRow: row => {
        if (classifyChecks({head:observedHead,observedHead,requiredChecks:policy.requiredChecks,checkRuns:[],statuses:[{...row,head_sha:observedHead}]}).state === "provider-unknown") fail("invalid hosted checks response")
      } })).map(s => ({ ...s, head_sha: observedHead }))
      const finalRead = await request(repo, `pulls/${pr}`, { metrics, observation, validate: value => {prValue(value,repo,pr);return true} })
      const final = await liveTarget(repo, prValue(finalRead.value, repo, pr), metrics, observation)
      const availability = probeAvailability([initialRead.probe, finalRead.probe])
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
      await observer.complete(observation, budget())
      return freeze({ ...base, ...final, state: "known", prState: final.state, availability, comments, ci, review,
        inventory: { comments, checkRuns, statuses, requiredChecks: policy.requiredChecks },
        fetchedAt: new Date(now()).toISOString(), errors: [] })
    } catch (error) {
      return freeze({ ...base, state: "unknown", availability:probeAvailability(error.probe?[error.probe]:[]), fetchedAt: new Date(now()).toISOString(),
        ci: { state: "provider-unknown", nextAction: "retry-provider-observation" }, review: null,
        errors: [{ message: error instanceof DeliveryError || error instanceof DeadlineError ? error.message : "GitHub snapshot unavailable", transient: error.transient ?? false,
          ...(error.probe ? {probe:error.probe} : {}), code: error.code, state: error.state, pool: error.pool, retryAt: error.retryAt, queryErrors: error.queryErrors, terminal: error.terminal,
          ...(error.phase ? { phase: error.phase, nextAction: error.nextAction } : {}) }] })
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

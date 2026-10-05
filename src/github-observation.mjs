import path from 'node:path'
import { DeliveryError, readJson, writeJson, withLease } from './pr-delivery-state.mjs'

// pstack watch-pr/policy.ts: queryBackoffSeconds and pollUntilTerminal.
export const queryBackoffMs = failures => Math.min(60 * 2 ** (failures - 1), 300) * 1000
const observationError = record => Object.assign(new DeliveryError(record.message,
  record.state === 'quota_hold' ? 75 : 1, !record.terminal), record)

function parse(response, format) {
 const [headers = '', ...parts] = response.stdout.split(/\r?\n\r?\n/)
 const status = Number(/^HTTP\/[^ ]+ (\d+)/.exec(headers)?.[1])
 let body
 try { body = format === 'text' ? parts.join('\n\n') : JSON.parse(parts.join('\n\n')) } catch { /* Classified as unknown below. */ }
 return { status, headers, body, ok: !response.code && status >= 200 && status < 300,
  transient: [429,500,502,503,504].includes(status) || !Number.isFinite(status) }
}

export function createGitHubObservation(config, { now = Date.now } = {}) {
 const file = path.join(config.stateDir, 'github.json')
 const limits = { requestsPerHour: 1000, cacheMs: 60000, ...config.github }
 return {
  async activeHold() {
   const state = await readJson(file,null)
   return state?.hold && (state.hold.terminal || state.hold.retryAt > now()) ? observationError(state.hold) : null
  },
  async complete(observation, budget) {
   return withLease(path.join(config.stateDir,'locks'),'github-request',async () => {
    const state = await readJson(file,null)
    if (state && !state.hold) { delete state.failures[observation]; await writeJson(file,state) }
   },{waitMs:config.commandTimeoutMs,pollMs:Math.min(config.pollMs,30),budget})
  },
  async request({ pool, key, mutation = false, cache = true, validate = () => true, observation, format = 'json' }, transport, budget) {
   if (!['rest','graphql'].includes(pool)) throw new DeliveryError('GitHub observation pool is required',9)
   return withLease(path.join(config.stateDir,'locks'),'github-request',async () => {
    const valid = body => { try { return validate(body, response?.headers) === true } catch { return false } }
    const at = now()
    const state = await readJson(file,{schema:'factory-github/v1',requests:[],cache:{},failures:{}})
    if (state.schema !== 'factory-github/v1') throw new DeliveryError('invalid GitHub request state',9)
    if (state.hold && (state.hold.terminal || state.hold.retryAt > at)) throw observationError(state.hold)
    state.hold = null
    state.requests = state.requests.filter(r=>r.at > at-3600000)
    state.cache = Object.fromEntries(Object.entries(state.cache).filter(([,entry])=>entry.expiresAt > at))
    const cacheKey = JSON.stringify([pool,key,format])
    const owner = observation ?? JSON.stringify([pool,key])
    let transportError
    let response = !mutation && cache ? state.cache[cacheKey]?.response : undefined
    if (response && valid(response.body)) {
     if (!observation) delete state.failures[owner]
     await writeJson(file,state)
     return response
    }
    if (!response) {
    if (state.requests.length >= limits.requestsPerHour) {
     state.hold = {state:'quota_hold',pool,queryErrors:0,terminal:false,
      retryAt:state.requests[0].at+3600000,message:'GitHub shared request budget exhausted'}
     await writeJson(file,state);throw observationError(state.hold)
    }
    state.requests.push({at,pool,mutation})
    // Reservation survives interruption; a write invalidates all prior read evidence.
    if (mutation) state.cache = {}
    await writeJson(file,state)
    try { response = parse(await transport(), format) }
    catch (error) {
     // Preserve supervised mutation uncertainty and deadlines for readback.
     if (mutation || error.code === 130) throw error
     transportError = error
     response = {status:NaN,headers:'',body:undefined,ok:false,transient:true}
    }
    }
    const receivedAt = now()
    const header = name => new RegExp(`^${name}: ([^\\r\\n]+)`,'im').exec(response.headers)?.[1]
    const guidance = header('retry-after')
    const retryAt = guidance === undefined ? NaN : /^\d+$/.test(guidance) ? receivedAt+Number(guidance)*1000 : Date.parse(guidance)
    const resetAt = Number(header('x-ratelimit-reset'))*1000
    const graphErrors = Array.isArray(response.body?.errors) ? response.body.errors : []
    const graphQuota = pool === 'graphql' && graphErrors.some(e=>e?.type==='RATE_LIMITED')
    const quota = response.status === 429 || graphQuota || response.status === 403 &&
     (header('x-ratelimit-remaining') === '0' || guidance !== undefined || /rate limit/i.test(response.body?.message ?? ''))
    let kind
    if (quota) kind = 'quota_hold'
    else if ([401,403].includes(response.status)) kind = 'auth_error'
    else if (!mutation && (!response.ok || response.body === undefined || !valid(response.body) || pool === 'graphql' && response.body?.errors?.length)) kind = 'unknown'
    if (kind) {
     const queryErrors = (state.failures[owner] ?? 0)+1
     state.failures[owner] = queryErrors
     const terminal = kind === 'auth_error' || queryErrors >= 5
     const next = Math.max(receivedAt+queryBackoffMs(queryErrors),
      Number.isFinite(retryAt) ? retryAt : 0, quota && Number.isFinite(resetAt) ? resetAt : 0)
     const record = {state:kind,pool,observation:owner,retryAt:next,queryErrors,terminal,
      message:transportError ? transportError.message : kind === 'quota_hold' ? 'GitHub quota hold: wait for recorded retry time' : kind === 'auth_error' ?
       'GitHub authentication refused' : response.ok ? response.body === undefined ? 'invalid GitHub REST JSON' : 'invalid GitHub observation shape' : 'GitHub observation unavailable'}
     // A quota/secondary hold applies to every pool; fallback cannot drain another one.
     state.hold = record
     await writeJson(file,state);throw Object.assign(transportError ?? observationError(record), record, {transient:!terminal})
    }
    if (!mutation && !observation) delete state.failures[owner]
    if (!mutation && cache && limits.cacheMs > 0) state.cache[cacheKey] = {expiresAt:receivedAt+limits.cacheMs,response}
    await writeJson(file,state)
    return response
   },{waitMs:config.commandTimeoutMs,pollMs:Math.min(config.pollMs,30),budget})
  }
 }
}

import { appendFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'

// Count attempts before rejecting them. Each CLI worker inherits this preload.
function allow(url) {
  const host = new URL(url).hostname
  if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]') return
  appendFileSync(process.env.PROVIDER_CALL_LOG, 'external-invocation\n')
  throw new Error('provider/network invocation forbidden in deterministic qualification')
}
const originalFetch = globalThis.fetch
globalThis.fetch = (input, options) => {
  allow(typeof input === 'string' || input instanceof URL ? input : input.url)
  return originalFetch(input, options)
}
for (const [protocol, module] of [['http:', http], ['https:', https]]) {
  for (const method of ['request', 'get']) {
    const original = module[method]
    module[method] = function (input, ...args) {
      allow(typeof input === 'string' || input instanceof URL ? input :
        `${input.protocol ?? protocol}//${input.hostname ?? input.host ?? 'localhost'}${input.port ? `:${input.port}` : ''}`)
      return original.call(this, input, ...args)
    }
  }
}
syncBuiltinESMExports()

import { appendFileSync } from 'node:fs'
import net from 'node:net'
import { lookup } from 'node:dns'

// Count attempts before rejecting them. Each CLI worker inherits this preload.
function allow(host, resolving = false) {
  if (host === '127.0.0.1' || host === '::1' || host === '[::1]' || (!resolving && host === 'localhost')) return
  appendFileSync(process.env.PROVIDER_CALL_LOG, 'external-invocation\n')
  throw new Error('provider/network invocation forbidden in deterministic qualification')
}
const originalFetch = globalThis.fetch
globalThis.fetch = async (input, options) => {
  allow(new URL(typeof input === 'string' || input instanceof URL ? input : input.url).hostname)
  return originalFetch(input, options)
}
// HTTP option merging, TLS, HTTP/2 and undici all converge on this socket seam.
const originalConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  // Node's socket uses this same normalizer, including the internal array form.
  const [input, callback] = Array.isArray(args[0]) ? args[0] : net._normalizeArgs(args)
  const options = { ...input }
  if (!options.path) {
    allow(options.host ?? 'localhost')
    const resolve = options.lookup ?? lookup
    options.lookup = (host, config, done) => resolve(host, config, (error, address, family) => {
      if (error) return done(error)
      try {
        for (const item of Array.isArray(address) ? address : [{ address }]) allow(item.address, true)
      } catch (error) { done(error); return }
      done(null, address, family)
    })
  }
  return originalConnect.call(this, options, ...(callback ? [callback] : []))
}

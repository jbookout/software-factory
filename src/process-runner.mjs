import { killOwnedGroup } from './process-group.mjs'
import { monotonicNow } from './deadline.mjs'
import { fork } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

// The supervisor owns the group even when the caller disappears. Reserve TERM
// and hard-stop time inside the caller's elapsed budget, including launch/bind.
export function runProcess(argv, { cwd, env = process.env, input = '', timeoutMs = 120_000,
  maxOutputBytes = 1_000_000, captureOutput = true, onOutput, onSpawn, signal, mutation = false } = {}) {
  if (!Array.isArray(argv) || !argv.length || argv.some(v => typeof v !== 'string') ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error('invalid process request'))
  if (signal?.aborted) return Promise.resolve({ code: 130, cancelled: true, timedOut: false,
    uncertain: false, stdout: '', stderr: '', started: false })
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs, elapsedDeadline = monotonicNow() + timeoutMs
    const grace = Math.min(100, Math.floor(timeoutMs / 5))
    const child = fork(new URL('./process-supervisor.mjs', import.meta.url), [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'], execArgv: []
    })
    let result, groupPid, stdout = '', stderr = '', bytes = 0
    let timedOut = false, overflow = false, cancelled = false, launchError
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
    const hardKill = () => {
      if (groupPid) {
        try { killOwnedGroup(groupPid, 'SIGKILL') }
        catch (e) { if (e.code !== 'ESRCH') launchError ??= new Error(`process cleanup failed (${e.code})`) }
      }
      child.kill('SIGKILL')
    }
    const stop = () => {
      // TERM is caught by the supervisor, which stops its group first.
      child.kill('SIGTERM')
    }
    const abort = () => { cancelled = true; stop() }
    const timer = setTimeout(() => { timedOut = true; stop() }, Math.max(0, elapsedDeadline - monotonicNow() - grace))
    const hardStop = setTimeout(hardKill, Math.max(0, elapsedDeadline - monotonicNow()))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const collect = (stream, chunk) => {
      bytes += chunk.length
      try { onOutput?.(chunk, stream) } catch { launchError = new Error('process output consumer failed'); stop(); return }
      if (!captureOutput) return
      if (bytes > maxOutputBytes) { overflow = true; stop(); return }
      if (stream === 'stdout') stdout += decoders.stdout.write(chunk)
      else stderr += decoders.stderr.write(chunk)
    }
    child.stdout.on('data', chunk => collect('stdout', chunk))
    child.stderr.on('data', chunk => collect('stderr', chunk))
    child.on('error', () => { launchError = new Error('process supervisor launch failed'); stop() })
    child.on('message', message => {
      if (message.groupPid) groupPid = message.groupPid
      else result = message
    })
    child.on('exit', (code, exitSignal) => {
      if (code || exitSignal) hardKill()
    })
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer); clearTimeout(hardStop); signal?.removeEventListener('abort', abort)
      if (groupPid) {
        try { killOwnedGroup(groupPid, 'SIGKILL') }
        catch (e) { if (e.code !== 'ESRCH') launchError ??= new Error(`process cleanup failed (${e.code})`) }
      }
      stdout += decoders.stdout.end(); stderr += decoders.stderr.end()
      if (launchError) {
        launchError.uncertain = mutation && Boolean(groupPid)
        if (launchError.uncertain) launchError.nextAction = 'readback-before-retry'
        reject(launchError); return
      }
      timedOut ||= result?.timedOut ?? false
      const uncertain = mutation && Boolean(groupPid) && (timedOut || cancelled || overflow || !result)
      resolve({ code: timedOut ? 142 : cancelled ? 130 : overflow ? 1 : result?.code ?? code ?? 1,
        signal: result?.signal ?? exitSignal, stdout, stderr, timedOut, overflow, cancelled,
        uncertain, ...(uncertain ? { nextAction: 'readback-before-retry' } : {}), pid: child.pid, started: Boolean(groupPid) })
    })
    Promise.resolve().then(() => onSpawn?.({ pid: child.pid, deadline })).then(bindings => {
      if (child.connected && !timedOut && !cancelled && !launchError)
        child.send({ argv, cwd, env, input, elapsedDeadline, grace, bindings: bindings ?? [] }, error => {
          if (error) { launchError = new Error('process launch binding failed'); stop() }
        })
    }).catch(() => { launchError = new Error('process launch binding failed'); stop() })
  })
}

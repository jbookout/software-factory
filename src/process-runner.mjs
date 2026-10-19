import { readJson, writeJson } from './pr-delivery-state.mjs'
import { killOwnedGroup, ownedGroupAlive } from './process-group.mjs'
import { monotonicNow, validDuration } from './deadline.mjs'
import { fork } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import fs from 'node:fs'
import path from 'node:path'

// Only fixed, local diagnostics cross the provider's error-reporting seam.
export class ProcessError extends Error {}

// The supervisor owns the group even when the caller disappears. Reserve TERM
// and hard-stop time inside the caller's elapsed budget, including launch/bind.
export function validateProcessRequest(argv, timeoutMs = 120_000) {
  if (!Array.isArray(argv) || !argv.length || argv.some(v => typeof v !== 'string' || v.includes('\0')) ||
      !argv[0] || !validDuration(timeoutMs)) throw new Error('invalid process request')
}
export function runProcess(argv, { cwd, env = process.env, input = '', timeoutMs = 120_000,
  maxOutputBytes = 1_000_000, captureOutput = true, onOutput, onSpawn, signal, mutation = false, job, onStarted } = {}) {
  try { validateProcessRequest(argv, timeoutMs)
    if (job) {
      if (job.ownership !== 'caller' || !job.id || !job.model || !job.effort || job.worktree !== cwd ||
          !path.isAbsolute(job.log ?? '') || !path.isAbsolute(job.receipt ?? '')) throw new Error('invalid caller-owned job')
      fs.mkdirSync(path.dirname(job.log), {recursive:true, mode:0o700})
      fs.writeFileSync(job.log, '', {mode:0o600, flag:'wx'})
    }
  } catch (error) { return Promise.reject(error) }
  if (signal?.aborted) return Promise.resolve({ code: 130, cancelled: true, timedOut: false,
    uncertain: false, stdout: '', stderr: '', started: false })
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs, elapsedDeadline = monotonicNow() + timeoutMs
    const grace = Math.min(100, Math.floor(timeoutMs / 5))
    const child = fork(new URL('./process-supervisor.mjs', import.meta.url), [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'], execArgv: []
    })
    let started = false, acknowledgment = Promise.resolve()
    let result, groupPid, stdout = '', stderr = '', bytes = 0
    let timedOut = false, overflow = false, cancelled = false, launchError
    const binding = new AbortController()
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
    const hardKill = () => {
      binding.abort()
      if (groupPid) {
        try { killOwnedGroup(groupPid, 'SIGKILL') }
        catch (e) { if (e.code !== 'ESRCH') launchError ??= new ProcessError(`process cleanup failed (${e.code})`) }
      }
      child.kill('SIGKILL')
    }
    const stop = () => {
      binding.abort()
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
      if (job && captureOutput) { try { fs.appendFileSync(job.log, chunk) } catch { launchError = new ProcessError('job log write failed'); stop(); return } }
      try { onOutput?.(chunk, stream) } catch { launchError = new ProcessError('process output consumer failed'); stop(); return }
      if (!captureOutput) return
      if (bytes > maxOutputBytes) { overflow = true; stop(); return }
      if (stream === 'stdout') stdout += decoders.stdout.write(chunk)
      else stderr += decoders.stderr.write(chunk)
    }
    child.stdout.on('data', chunk => collect('stdout', chunk))
    child.stderr.on('data', chunk => collect('stderr', chunk))
    child.on('error', () => { launchError = new ProcessError('process supervisor launch failed'); stop() })
    child.on('message', message => {
      if (message.type === 'started') {
        started = true
        acknowledgment = Promise.resolve().then(() => onStarted?.(message.receipt)).catch(() => {launchError = new ProcessError('startup acknowledgment failed'); stop()})
      } else if (message.groupPid) groupPid = message.groupPid
      else result = message
    })
    child.on('exit', (code, exitSignal) => {
      if (code || exitSignal) hardKill()
    })
    child.on('close', async (code, exitSignal) => {
      let acknowledgmentTimer
      try {
        await Promise.race([acknowledgment,new Promise(resolve => {
          acknowledgmentTimer=setTimeout(()=>{timedOut=true;resolve()},Math.max(0,elapsedDeadline-monotonicNow()))
        })])
      } finally {clearTimeout(acknowledgmentTimer)}
      binding.abort()
      clearTimeout(timer); clearTimeout(hardStop); signal?.removeEventListener('abort', abort)
      if (groupPid) {
        try { killOwnedGroup(groupPid, 'SIGKILL') }
        catch (e) { if (e.code !== 'ESRCH') launchError ??= new ProcessError(`process cleanup failed (${e.code})`) }
      }
      stdout += decoders.stdout.end(); stderr += decoders.stderr.end()
      if (launchError) {
        launchError.uncertain = mutation && Boolean(groupPid)
        if (launchError.uncertain) launchError.nextAction = 'readback-before-retry'
        reject(launchError); return
      }
      timedOut ||= result?.timedOut ?? false
      const uncertain = mutation && Boolean(groupPid) && Boolean(timedOut || cancelled || overflow || result?.signal || exitSignal || !result)
      resolve({ code: timedOut ? 142 : cancelled ? 130 : overflow ? 1 : result?.code ?? code ?? 1,
        signal: result?.signal ?? exitSignal, stdout, stderr, timedOut, overflow, cancelled,
        uncertain, ...(uncertain ? { nextAction: 'readback-before-retry' } : {}), pid: child.pid, started })
    })
    Promise.resolve().then(async () => {
      if (job) await writeJson(job.receipt,{schema:'factory-process-job/v1',...job,pid:child.pid,deadline,status:'starting'})
      return onSpawn?.({ pid: child.pid, deadline }, binding.signal)
    }).then(bindings => {
      if (child.connected && !binding.signal.aborted && !launchError)
        child.send({ argv, cwd, env, input, elapsedDeadline, deadline, grace, job, bindings: bindings ?? [] }, error => {
          if (error) { launchError = new ProcessError('process launch binding failed'); stop() }
        })
    }).catch(() => { if (!binding.signal.aborted) { launchError = new ProcessError('process launch binding failed'); stop() } })
  })
}


export async function observeProcessJob(file) {
  const receipt = await readJson(file,null)
  if (!receipt || receipt.schema !== 'factory-process-job/v1') throw new Error('missing process receipt; observe owner before retry')
  const logExists = await fs.promises.access(receipt.log).then(()=>true,()=>false)
  if (['starting','running'].includes(receipt.status)) {
    let ownerAlive = false
    try {process.kill(receipt.pid,0);ownerAlive=true} catch(error) {ownerAlive=error.code!=='ESRCH'}
    const groupAlive = receipt.groupPid ? ownedGroupAlive(receipt.groupPid) : false
    return {...receipt, status:ownerAlive||groupAlive ? logExists ? receipt.status : 'startup_unconfirmed' : 'interrupted',
      ownerAlive,groupAlive,logExists}
  }
  return {...receipt,logExists}
}

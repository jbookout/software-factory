import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readJson, writeJson, withLease } from './pr-delivery-state.mjs'

const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const started = pid => { try { return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {encoding:'utf8'}).trim() } catch { return null } }

// The CLI owns work and recovery. This module only owns its detached launch,
// persistent identity and output, so caller death cannot kill delivery.
export async function startDeliveryDaemon(config, identity, argv, env = process.env) {
  const id = createHash('sha256').update(JSON.stringify(identity)).digest('hex')
  const root = path.join(config.stateDir, 'daemons'), file = path.join(root, `${id}.json`)
  return withLease(path.join(config.stateDir, 'locks'), `daemon-${id}`, async () => {
    const prior = await readJson(file, null)
    if (prior && alive(prior.pid) && prior.processStarted === started(prior.pid)) return { ...prior, file, resumed: true }
    await fs.mkdir(root, { recursive: true, mode: 0o700 })
    const log = path.join(root, `${id}.log`), out = await fs.open(log, 'a', 0o600)
    let child
    try {
      child = spawn(process.execPath, argv, { detached: true, stdio: ['ignore', out.fd, out.fd], env })
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
      const receipt = { schema: 'factory-delivery-daemon/v1', identity, argv, pid: child.pid, processStarted: started(child.pid), log, startedAt: new Date().toISOString() }
      await writeJson(file, receipt)
      child.unref()
      return { ...receipt, file, resumed: false }
    } catch (error) {
      if (child?.pid) try { process.kill(-child.pid, 'SIGTERM') } catch {}
      throw error
    } finally { await out.close() }
  }, { waitMs: config.commandTimeoutMs, pollMs: config.pollMs })
}

export async function deliveryStatus(config, { repo, pr, step, code = 1, message, nextAction = 'inspect-and-resume' }) {
  const file = config.statusFile ?? path.join(config.stateDir, 'status.txt')
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  // Child diagnostics are kept in private logs. This line contains only the
  // controller's fixed diagnostic and the action that owns the dead end.
  const clean = value => String(value ?? '').replace(/[\r\n]/g, ' ')
  await withLease(path.join(config.stateDir,'locks'),'delivery-status',async()=>{
    const state=path.join(config.stateDir,'status-lines.json'), prior=await readJson(state,{})
    const key=`${repo ?? 'delivery'}#${pr ?? '-'}:${step}`
    const line=`${clean(repo ?? 'delivery')}#${pr ?? '-'} ${clean(step)} code=${code} ${clean(message)} next=${clean(nextAction)}`
    if(prior[key]===line)return
    await fs.appendFile(file,`${new Date().toISOString()} ${line}\n`,{mode:0o600})
    prior[key]=line;await writeJson(state,prior)
  },{waitMs:config.commandTimeoutMs ?? 5000,pollMs:config.pollMs ?? 20})
}

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { startDeliveryDaemon } from '../src/delivery-daemon.mjs'

test('detached delivery survives its launcher and restart returns the same running receipt', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-daemon-'))
  const config = { stateDir: root, commandTimeoutMs: 1000, pollMs: 10 }
  const tick = path.join(root, 'ticks')
  const argv = ['-e', `const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(tick)},'tick\\n'),50)`]
  const receipt = await startDeliveryDaemon(config, ['deliver', 'r/x'], argv)
  t.after(() => { try { process.kill(-receipt.pid, 'SIGTERM') } catch {} })
  await new Promise(r => setTimeout(r, 200))
  assert.notEqual(Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(receipt.pid)], { encoding: 'utf8' }).trim()), process.pid)
  const again = await startDeliveryDaemon(config, ['deliver', 'r/x'], argv)
  assert.equal(again.pid, receipt.pid)
  const before = (await fs.readFile(tick, 'utf8')).length
  await new Promise(r => setTimeout(r, 100))
  assert.ok((await fs.readFile(tick, 'utf8')).length > before)
  assert.equal(JSON.parse(await fs.readFile(receipt.file, 'utf8')).pid, receipt.pid)
})

test('killing the session parent does not terminate detached delivery', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-parent-'))
  const module = new URL('../src/delivery-daemon.mjs', import.meta.url).href
  const tick = path.join(root, 'ticks')
  const parent = spawn(process.execPath, ['--input-type=module', '-e', `
    import {startDeliveryDaemon} from ${JSON.stringify(module)};
    const r=await startDeliveryDaemon({stateDir:${JSON.stringify(root)},commandTimeoutMs:1000,pollMs:10},['deliver','r/y'],['-e',${JSON.stringify(`setInterval(()=>require('fs').appendFileSync(${JSON.stringify(tick)},'x'),50)`)}]);
    console.log(JSON.stringify(r));setInterval(()=>{},1000);
  `], { stdio: ['ignore', 'pipe', 'inherit'] })
  const r = await new Promise(resolve => parent.stdout.once('data', b => resolve(JSON.parse(b))))
  t.after(() => { try { process.kill(-r.pid, 'SIGTERM') } catch {} })
  parent.kill('SIGKILL')
  await new Promise(resolve => parent.once('exit', resolve))
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.ok((await fs.readFile(tick, 'utf8')).length > 0)
})

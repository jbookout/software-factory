import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { reserveBuilderEscalation, queueDotReview, remoteReview } from '../src/delivery-lanes.mjs'

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-lanes-'))
  const config = { stateDir: root, orchestratorDir: path.join(root, 'orch'), commandTimeoutMs: 1000, pollMs: 10 }
  await fs.mkdir(path.join(config.orchestratorDir, 'budget'), { recursive: true })
  return { config, flag: name => fs.writeFile(path.join(config.orchestratorDir, 'budget', name), '') }
}
test('budget exhaustion escalates a PR exactly once across restarts and moved heads', async () => {
  const { config } = await setup()
  const first = await reserveBuilderEscalation(config, 'r/x', 1536, 'a'.repeat(40))
  assert.equal(first.lane, 'claude-opus')
  await assert.rejects(reserveBuilderEscalation(config, 'r/x', 1536, 'b'.repeat(40)), /ESCALATION ALREADY/)
  assert.equal((await fs.readdir(path.join(config.stateDir, 'escalations'))).length, 1)
})
test('Dot queues one AF brief for each full head and enforces its flag and four-waiting budget', async () => {
  const { config, flag } = await setup()
  const request = { repo: 'r/x', pr: 7, head: 'a'.repeat(40), full: true }
  assert.equal(await queueDotReview(config, request), null)
  await flag('DOT_AF_ON')
  const file = await queueDotReview(config, request)
  assert.match(await fs.readFile(file, 'utf8'), /DOT-REPORT-END AF-x-7/)
  assert.equal(await queueDotReview(config, request), null)
  assert.equal(await queueDotReview(config, { ...request, full: false }), null)
  for (let pr = 8; pr < 11; pr++) await queueDotReview(config, { ...request, pr })
  assert.equal(await queueDotReview(config, { ...request, pr: 11 }), null)
})
test('MacBook requires AC power, uses its persistent worktree, and otherwise falls through', async () => {
  const { config, flag } = await setup()
  await flag('MACBOOK_ON')
  const calls = []
  const request = { repo: 'r/x', pr: 7, head: 'a'.repeat(40), prompt: 'review', output: path.join(config.stateDir, 'review.txt') }
  assert.equal(await remoteReview(config, request, { command: async argv => { calls.push(argv); return { code: 1 } } }), null)
  assert.match(calls[0].at(-1), /AC Power/)
  calls.length = 0
  const result = await remoteReview(config, request, { command: async argv => { calls.push(argv); return { code: 0, stdout: calls.length === 1 ? '' : `APPROVE\nReviewed-SHA: ${request.head}\n\nNone`, pid: 42 } } })
  assert.equal(result.lane, 'macbook')
  assert.match(calls[1].at(-1), /orch-wt\/x/)
})
test('one cloud reviewer is admitted by default, only with CLOUD_ON, and matches the exact head', async () => {
  const { config, flag } = await setup()
  const request = { repo: 'jbookout/carr-system', pr: 7, head: 'a'.repeat(40), prompt: 'review', output: path.join(config.stateDir, 'review.txt') }
  let launches = 0, release
  const launched = new Promise(resolve => { release = resolve })
  const deps = { command: async () => { launches++; await launched; return { code: 0, pid: 42 } }, observe: async () => `APPROVE\nReviewed-SHA: ${request.head}\n\nNone` }
  assert.equal(await remoteReview(config, request, deps), null)
  await flag('CLOUD_ON')
  const first = remoteReview(config, request, deps)
  while (!launches) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(await remoteReview(config, { ...request, pr: 8 }, deps), null)
  release()
  assert.equal((await first).lane, 'cloud')
  assert.equal(launches, 1)
})

test('MacBook async reviewer receives the complete SSH stdin prompt', async () => {
  const { config, flag } = await setup()
  await flag('MACBOOK_ON')
  const home = path.join(config.stateDir, 'remote-home'), tools = path.join(config.stateDir, 'tools')
  await fs.mkdir(path.join(home, 'orch-wt', 'x'), { recursive: true })
  await fs.mkdir(tools)
  const head = 'a'.repeat(40), prompt = 'A complete multiline review prompt\nwith its exact source binding\n'
  await fs.writeFile(path.join(tools, 'git'), `#!/bin/sh\ncase "$1" in rev-parse) echo ${head};; write-tree) echo ${head};; esac\n`, {mode:0o755})
  await fs.writeFile(path.join(tools, 'codex'), `#!${process.execPath}\nconst fs=require('node:fs'); const args=process.argv.slice(2); const prompt=fs.readFileSync(0,'utf8'); fs.writeFileSync('received-prompt.txt',prompt); fs.writeFileSync(args[args.indexOf('--output-last-message')+1], 'APPROVE\\nReviewed-SHA: ${head}\\n\\n'+(prompt.length?'received':'missing'));\n`, {mode:0o755})
  let calls = 0
  const result = await remoteReview(config, {repo:'r/x',pr:7,head,prompt,output:path.join(config.stateDir,'review.txt')}, {
    command: async (argv, cwd, options) => {
      if (++calls === 1) return {code:0,stdout:''}
      return {code:0,stdout:execFileSync('sh',['-c',argv.at(-1).replace('PATH=/opt/homebrew/bin:$PATH','PATH=$PATH')],{input:options.input,encoding:'utf8',env:{...process.env,HOME:home,PATH:tools+path.delimiter+process.env.PATH}})}
    }
  })
  assert.equal(result.lane,'macbook')
  assert.equal(await fs.readFile(path.join(home,'orch-wt','x','received-prompt.txt'),'utf8'),prompt)
})

test('unconfirmed cloud completion retains its only slot across later PRs', async () => {
 const {config,flag}=await setup();await flag('CLOUD_ON')
 let launches=0
 const request={repo:'jbookout/carr-system',pr:7,head:'a'.repeat(40),prompt:'review',output:path.join(config.stateDir,'review.txt')}
 const deps={command:async()=>{launches++;return {code:1}},observe:async()=>null}
 assert.equal(await remoteReview(config,request,deps),null)
 assert.equal(await remoteReview(config,{...request,pr:8},deps),null)
 assert.equal(launches,1)
 const records=await fs.readdir(path.join(config.stateDir,'cloud-reviews'))
 assert.equal(JSON.parse(await fs.readFile(path.join(config.stateDir,'cloud-reviews',records[0]))).state,'uncertain')
})

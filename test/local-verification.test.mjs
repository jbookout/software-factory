import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const api = () => import('../src/local-verification.mjs')
async function repository(t, name) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), `verification-${name}-`))
  // Disposable fixtures are left outside the reviewed source tree.
  execFileSync('git', ['init', '-q', cwd])
  execFileSync('git', ['-C', cwd, 'config', 'user.email', 'fixture@example.invalid'])
  execFileSync('git', ['-C', cwd, 'config', 'user.name', 'Fixture'])
  await fs.writeFile(path.join(cwd, 'source'), name)
  execFileSync('git', ['-C', cwd, 'add', 'source'])
  execFileSync('git', ['-C', cwd, 'commit', '-qm', name])
  return cwd
}
test('concurrent verification results keep producer, source and opposite outcomes bound', async t => {
  const { runVerification, readVerification } = await api()
  const [a, b] = await Promise.all([repository(t, 'a'), repository(t, 'b')])
  const jobs = await Promise.all([runVerification({ cwd:a, producer:'a', argv:[process.execPath, '-e', 'console.log("pass")'] }),
    runVerification({ cwd:b, producer:'b', argv:[process.execPath, '-e', 'console.log("fail");process.exit(7)'] })])
  assert.notEqual(jobs[0].directory, jobs[1].directory)
  const results = await Promise.all(jobs.map(j => readVerification(j.receipt, j.binding, j.receiptDigest)))
  assert.deepEqual(results.map(r => r.code), [0,7])
  assert.notEqual(results[0].head, results[1].head)
  await assert.rejects(readVerification(jobs[1].receipt, jobs[0].binding, jobs[1].receiptDigest), /binding/)
  await fs.writeFile(path.join(b,'source'),'moved source')
  await assert.rejects(readVerification(jobs[1].receipt, jobs[1].binding, jobs[1].receiptDigest), /source binding/)
  await fs.appendFile(jobs[0].log, 'foreign output')
  await assert.rejects(readVerification(jobs[0].receipt, jobs[0].binding, jobs[0].receiptDigest), /digest/)
})
test('occupied outputs and shared launch paths fail before replacing evidence', async () => {
  const { allocateVerification, runVerification, validateLaunchOutput } = await api()
  const cwd = await repository(null, 'occupied')
  const attempt = await allocateVerification({ cwd, producer:'owner', argv:[process.execPath, '-e', ''] })
  await fs.writeFile(attempt.log, 'existing review')
  await assert.rejects(runVerification({ ...attempt.binding, cwd, attempt }), /EEXIST/)
  assert.equal(await fs.readFile(attempt.log, 'utf8'), 'existing review')
  for(const argv of [['codex','--output-last-message','/tmp/review.txt'],['codex','--output-last-message=/tmp/review.txt']])
    await assert.rejects(validateLaunchOutput(argv, attempt.directory, cwd), /owned attempt/)
  await validateLaunchOutput(['codex','--output-last-message',path.join(attempt.directory,'review.txt')], attempt.directory, cwd)
})

test('failed receipt cannot be changed to green with the producer evidence intact', async t => {
  const { runVerification, readVerification } = await api()
  const cwd = await repository(t, 'tamper')
  const attempt = await runVerification({ cwd, producer:'failed-check', argv:[process.execPath, '-e', 'process.exit(7)'] })
  const receipt = JSON.parse(await fs.readFile(attempt.receipt, 'utf8'))
  receipt.code = 0
  await fs.writeFile(attempt.receipt, JSON.stringify(receipt))
  await assert.rejects(readVerification(attempt.receipt, attempt.binding, attempt.receiptDigest), /producer receipt digest/)
})

test('checks launched from a subdirectory bind parent repository source', async t => {
  const { runVerification, readVerification } = await api()
  const root = await repository(t, 'parent-source')
  const cwd = path.join(root, 'scripts')
  await fs.mkdir(cwd)
  await fs.writeFile(path.join(cwd, 'check.mjs'), "console.log(require('fs').readFileSync('../source','utf8'))")
  execFileSync('git', ['-C', root, 'add', 'scripts'])
  const attempt = await runVerification({ cwd, producer:'subdirectory', argv:[process.execPath, '-e', "console.log(require('fs').readFileSync('../source','utf8'))"] })
  await fs.writeFile(path.join(root, 'source'), 'changed parent')
  await assert.rejects(readVerification(attempt.receipt, attempt.binding, attempt.receiptDigest), /source binding/)
})

for (const shape of ['symlink', 'gitlink']) test(`source fingerprint refuses unsupported ${shape} checkouts`, async t => {
  const { verificationSource } = await api()
  const cwd = await repository(t, shape)
  if (shape === 'symlink') {
    const other = await repository(t, 'symlink-target')
    await fs.symlink(path.join(other, 'source'), path.join(cwd, 'linked-source'))
    execFileSync('git', ['-C', cwd, 'add', 'linked-source'])
  } else {
    const other = await repository(t, 'submodule-target')
    execFileSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', other, 'nested'])
  }
  await assert.rejects(verificationSource(cwd), /unsupported.*(symlink|gitlink)/)
})

test('relative launch output is resolved from the child working directory', async t => {
  const { validateLaunchOutput } = await api()
  const root = await fs.realpath(await repository(t, 'relative-output'))
  const controller = path.join(root, 'controller'), attempt = path.join(root, 'attempt')
  const cwd = path.join(root, 'product', 'sub')
  await Promise.all([controller, attempt, cwd].map(dir=>fs.mkdir(dir, {recursive:true})))
  const previousCwd = process.cwd()
  process.chdir(controller)
  t.after(() => process.chdir(previousCwd))
  const relative = path.relative(controller, path.join(attempt, 'result'))
  await assert.rejects(async()=>validateLaunchOutput(['codex', '--output', relative], attempt, cwd), /owned attempt/)
  await validateLaunchOutput(['codex', '--output', path.relative(cwd,path.join(attempt,'result'))], attempt, cwd)
})

test('launch output cannot replace a foreign file through a symlink', async t => {
  const { allocateVerification, runVerification } = await api()
  const cwd = await repository(t, 'output-symlink')
  const foreign = path.join(os.tmpdir(), `foreign-${Date.now()}-${Math.random()}.log`)
  await fs.writeFile(foreign, 'foreign evidence')
  const argv = [process.execPath, '-e', "require('fs').writeFileSync(process.argv[2],'replaced')", '--', '--output']
  const attempt = await allocateVerification({cwd, producer:'symlink-output', argv})
  const output = path.join(attempt.directory, 'result')
  argv.push(output)
  attempt.binding.argv = [...argv]
  await fs.symlink(foreign, output)
  await assert.rejects(runVerification({cwd, producer:'symlink-output', argv, attempt}), /symlink/)
  assert.equal(await fs.readFile(foreign, 'utf8'), 'foreign evidence')
})

test('output containment checks physical parent directories', async t => {
  const { validateLaunchOutput } = await api()
  const cwd = await repository(t, 'physical-output')
  const attempt = path.join(cwd, 'attempt'), foreign = path.join(cwd, 'foreign')
  await fs.mkdir(attempt); await fs.mkdir(foreign)
  await fs.symlink(foreign, path.join(attempt,'redirect'))
  await assert.rejects(async()=>validateLaunchOutput(['codex','--output',attempt+'/redirect/../result'],attempt,cwd), /owned attempt/)
})

test('shared-log shell collision is refused before either check dispatches', async t => {
  const { runVerification } = await api()
  const cwd = await repository(t, 'collision')
  const shared = path.join(os.tmpdir(), `shared-${Date.now()}-${Math.random()}.log`)
  const gate = shared+'.gate'
  const first = ['sh','-c', `echo FAIL > '${shared}'; while [ ! -f '${gate}' ]; do sleep 0.01; done; cat '${shared}'; test "$(cat '${shared}')" = PASS`]
  const second = ['sh','-c', `echo PASS > '${shared}'; touch '${gate}'; cat '${shared}'; test "$(cat '${shared}')" = PASS`]
  const results = await Promise.allSettled([runVerification({cwd,producer:'first',argv:first,timeoutMs:3000}),runVerification({cwd,producer:'second',argv:second,timeoutMs:3000})])
  assert.ok(results.every(r=>r.status==='rejected' && /shell.*unsupported/.test(r.reason.message)), JSON.stringify(results))
  await assert.rejects(fs.access(shared), /ENOENT/)
})

test('shell scripts cannot hide a fixed shared output behind literal argv', async t => {
  const { runVerification } = await api()
  const cwd = await repository(t, 'shell-script')
  const script = path.join(cwd, 'check.sh'), shared = path.join(os.tmpdir(), `script-shared-${Date.now()}.log`)
  await fs.writeFile(script, `#!/bin/sh\necho PASS > '${shared}'\ncat '${shared}'\n`, {mode:0o755})
  await assert.rejects(runVerification({cwd,producer:'script',argv:[script]}), /shell.*unsupported/)
  await assert.rejects(fs.access(shared), /ENOENT/)
})

test('stale allocated source is refused before a check can restore it in teardown', async t => {
  const { allocateVerification, runVerification } = await api()
  const cwd = await repository(t, 'A')
  const argv = [process.execPath, '-e', "const fs=require('fs');console.log('dispatched');const b=fs.readFileSync('source','utf8')==='B';fs.writeFileSync('source','A');process.exit(b?0:7)"]
  const attempt = await allocateVerification({cwd,producer:'stale',argv})
  await fs.writeFile(path.join(cwd,'source'),'B')
  await assert.rejects(runVerification({cwd,producer:'stale',argv,attempt}), /source binding/)
  assert.equal(await fs.readFile(path.join(cwd,'source'),'utf8'),'B')
  await assert.rejects(fs.access(attempt.log), /ENOENT/)
})

test('renamed shell executables cannot bypass the bounded launch contract', async t => {
  const { runVerification } = await api()
  const cwd = await repository(t, 'shell-alias')
  const alias = path.join(os.tmpdir(), `shell-alias-${Date.now()}-${Math.random()}`)
  await fs.symlink('/bin/sh',alias)
  await assert.rejects(runVerification({cwd,producer:'shell-alias',argv:[alias,'-c','echo bypass']}), /shell.*unsupported/)
})

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
  const results = await Promise.all(jobs.map(j => readVerification(j.receipt, j.binding)))
  assert.deepEqual(results.map(r => r.code), [0,7])
  assert.notEqual(results[0].head, results[1].head)
  await assert.rejects(readVerification(jobs[1].receipt, jobs[0].binding), /binding/)
  await fs.writeFile(path.join(b,'source'),'moved source')
  await assert.rejects(readVerification(jobs[1].receipt, jobs[1].binding), /source binding/)
  await fs.appendFile(jobs[0].log, 'foreign output')
  await assert.rejects(readVerification(jobs[0].receipt, jobs[0].binding), /digest/)
})
test('occupied outputs and shared launch paths fail before replacing evidence', async () => {
  const { allocateVerification, runVerification, validateLaunchOutput } = await api()
  const cwd = await repository(null, 'occupied')
  const attempt = await allocateVerification({ cwd, producer:'owner', argv:[process.execPath, '-e', ''] })
  await fs.writeFile(attempt.log, 'existing review')
  await assert.rejects(runVerification({ ...attempt.binding, cwd, attempt }), /EEXIST/)
  assert.equal(await fs.readFile(attempt.log, 'utf8'), 'existing review')
  for(const argv of [['codex','--output-last-message','/tmp/review.txt'],['codex','--output-last-message=/tmp/review.txt']])
    assert.throws(() => validateLaunchOutput(argv, attempt.directory), /owned attempt/)
  validateLaunchOutput(['codex','--output-last-message',path.join(attempt.directory,'review.txt')], attempt.directory)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('check runner binds a focused Node command and validates its receipt', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-check-command-'))
  t.after(() => fs.rm(cwd, { recursive:true, force:true }))
  execFileSync('git', ['init', '-q', cwd])
  await fs.writeFile(path.join(cwd, 'focused.test.mjs'), "import test from 'node:test';test('focused sentinel',()=>{})")
  execFileSync('git', ['-C', cwd, 'add', 'focused.test.mjs'])
  execFileSync('git', ['-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture'])
  const runner = fileURLToPath(new URL('../scripts/check.mjs', import.meta.url))
  const env = {...process.env}
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, [runner, 'node', '--test-name-pattern=sentinel', 'focused.test.mjs'], { cwd, env, encoding:'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const receipt = JSON.parse(result.stdout.trim())
  assert.deepEqual(receipt.argv, [process.execPath, '--test', '--test-concurrency=2', '--test-name-pattern=sentinel', 'focused.test.mjs'])
  assert.equal(receipt.code, 0)
  assert.match(await fs.readFile(receipt.log, 'utf8'), /focused sentinel/)
})

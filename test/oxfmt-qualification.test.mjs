import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { extractPinnedArchive, sha } from '../capabilities/oxfmt-qualification/install.mjs'
import { assertSemanticParity } from '../capabilities/oxfmt-qualification/semantics.mjs'
import { nativeHtmlUnsupported, peakRssBytes, qualifyFile } from '../capabilities/oxfmt-qualification/qualify.mjs'

async function owned(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oxfmt-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

test('rusage parses the complete captured report and converts Linux KiB without treating Darwin bytes as KiB', () => {
  // The first hosted npm check retained this GNU report on the combined stream.
  const stdout = 'Checking formatting...\n\tMaximum resident set size (kbytes): 79536\n'
  assert.equal(peakRssBytes(stdout + '', 'linux'), 79536 * 1024)
  assert.equal(peakRssBytes('  8585216  maximum resident set size\n', 'darwin'), 8585216)
  assert.throws(() => peakRssBytes('formatter output only', 'linux'), /missing or ambiguous/)
  assert.throws(() => peakRssBytes(stdout + stdout, 'linux'), /missing or ambiguous/)
})
function archive(members) {
  return execFileSync('python3', ['-c', `import io,json,sys,tarfile
buf=io.BytesIO()
with tarfile.open(fileobj=buf,mode='w:gz') as tar:
 for item in json.loads(sys.argv[1]):
  member=tarfile.TarInfo(item['name']);data=b'not executed'
  if item.get('link'):member.type=tarfile.SYMTYPE;member.linkname=item['link'];tar.addfile(member)
  else:member.size=len(data);tar.addfile(member,io.BytesIO(data))
sys.stdout.buffer.write(buf.getvalue())`, JSON.stringify(members)])
}

test('native extraction validates digest before creating any installation', async t => {
  const root = await owned(t), target = path.join(root, 'install')
  await assert.rejects(extractPinnedArchive(Buffer.from('wrong'), { member: 'oxfmt', digest: '0'.repeat(64) }, target), /digest mismatch/)
  await assert.rejects(fs.stat(target), { code: 'ENOENT' })
})

test('native extraction accepts only one exact regular member and preserves existing targets', async t => {
  const root = await owned(t)
  for (const [i, members] of [
    [{ name: '../oxfmt' }], [{ name: 'oxfmt', link: '../outside' }],
    [{ name: 'oxfmt' }, { name: 'extra' }]
  ].entries()) {
    const bytes = archive(members), target = path.join(root, 'bad-' + i)
    await assert.rejects(extractPinnedArchive(bytes, { member: 'oxfmt', digest: sha(bytes) }, target), /unexpected release archive member/)
    await assert.rejects(fs.stat(path.join(target, 'oxfmt')), { code: 'ENOENT' })
  }
  const bytes = archive([{ name: 'oxfmt' }]), target = path.join(root, 'good')
  const binary = await extractPinnedArchive(bytes, { member: 'oxfmt', digest: sha(bytes) }, target)
  assert.equal(await fs.readFile(binary, 'utf8'), 'not executed')
  assert.equal((await fs.stat(binary)).mode & 0o777, 0o700)
  await assert.rejects(extractPinnedArchive(bytes, { member: 'oxfmt', digest: sha(bytes) }, target), { code: 'EEXIST' })
  assert.equal(await fs.readFile(binary, 'utf8'), 'not executed')
})

test('semantic checks preserve declaration filename classification and ignore formatting only', async () => {
  await assertSemanticParity('ts', 'export const items: readonly string[];\n', 'export const items: readonly string[];\n\n', 'sample.d.mts')
  await assertSemanticParity('js', 'const value=(1 + 2);', 'const value = 1 + 2;\n', 'sample.js')
  await assertSemanticParity('yaml', 'name: sample\nitems: [one, two]\n', 'name: sample\nitems:\n  - one\n  - two\n', 'sample.yaml')
})

test('semantic checks reject altered literals, operators, declarations and structured data', async () => {
  for (const [kind, before, after, name] of [
    ['js', 'const a="one";', 'const a="two";', 'sample.js'],
    ['js', 'const a=1+2;', 'const a=1-2;', 'sample.js'],
    ['ts', 'export const a: string;', 'export const a: number;', 'sample.d.mts'],
    ['tsx', 'const a=<div title="one"/>;', 'const a=<div title="two"/>;', 'sample.tsx'],
    ['tsx', 'const a=<div>One</div>;', 'const a=<div>Two</div>;', 'sample.tsx'],
    ['json', '{"value":1}', '{"value":2}', 'sample.json'],
    ['yaml', 'value: one\n', 'value: two\n', 'sample.yaml'],
    ['css', '@theme {--color-primary: red;} @tailwind utilities;', '@theme {--color-primary: blue;} @tailwind utilities;', 'sample.css']
  ]) await assert.rejects(assertSemanticParity(kind, before, after, name), `${kind} semantic mutation must fail`)
})

test('HTML fallback requires the native no-target error and an unchanged copied input', () => {
  const result = { code: 2, stdout: '', stderr: 'Expected at least one target file.' }
  assert(nativeHtmlUnsupported('html', result, true))
  assert(!nativeHtmlUnsupported('js', result, true))
  assert(!nativeHtmlUnsupported('html', result, false))
  assert(!nativeHtmlUnsupported('html', { ...result, stderr: 'syntax error' }, true))
  assert(!nativeHtmlUnsupported('html', { ...result, code: 0 }, true))
})

async function fake(t, body, extension = 'js') {
  const root = await owned(t), source = path.join(root, 'sample.' + extension), cli = path.join(root, 'fake.cjs')
  await fs.writeFile(source, extension === 'html' ? '<html></html>\n' : 'const value=42;\n')
  await fs.writeFile(cli, `const fs=require('node:fs');const file=process.argv.at(-1);const text=fs.readFileSync(file,'utf8');${body}`)
  return { root, source, command: [process.execPath, cli] }
}

test('copied input skipped by a successful checker is rejected', async t => {
  const fixture = await fake(t, 'process.exit(0)')
  await assert.rejects(qualifyFile({ ...fixture, kind: 'js', distribution: 'npm', directory: path.join(fixture.root, 'copy'), samples: 1 }), /must be detected/)
  assert.equal(await fs.readFile(fixture.source, 'utf8'), 'const value=42;\n')
})

test('native unsupported HTML is recorded, but npm no-target and native syntax failures fail', async t => {
  const fixture = await fake(t, "console.error('Expected at least one target file.');process.exit(2)", 'html')
  const row = await qualifyFile({ ...fixture, kind: 'html', distribution: 'native', directory: path.join(fixture.root, 'native'), samples: 1 })
  assert.equal(row.status, 'unsupported'); assert.equal(row.fallback, 'npm')
  await assert.rejects(qualifyFile({ ...fixture, kind: 'html', distribution: 'npm', directory: path.join(fixture.root, 'npm'), samples: 1 }), /must be detected/)
  const broken = await fake(t, "console.error('syntax error');process.exit(2)", 'html')
  await assert.rejects(qualifyFile({ ...broken, kind: 'html', distribution: 'native', directory: path.join(broken.root, 'copy'), samples: 1 }), /must be detected/)
})

test('a formatter which changes semantics fails even if its output is idempotent', async t => {
  const fixture = await fake(t, `const next=(text.trimEnd()+String.fromCharCode(10)).replace('42','43');
if(process.argv.includes('--check'))process.exit(text===next?0:1);fs.writeFileSync(file,next);`)
  await assert.rejects(qualifyFile({ ...fixture, kind: 'js', distribution: 'npm', directory: path.join(fixture.root, 'copy'), samples: 1 }), /deep-equal/)
  assert.equal(await fs.readFile(fixture.source, 'utf8'), 'const value=42;\n')
})

test('missing and symlinked corpus inputs are rejected before creating copies', async t => {
  const root = await owned(t), source = path.join(root, 'missing.js'), directory = path.join(root, 'copy')
  await assert.rejects(qualifyFile({ kind: 'js', source, directory, command: [process.execPath], distribution: 'npm' }), { code: 'ENOENT' })
  await fs.writeFile(path.join(root, 'actual.js'), 'const value=42;'); await fs.symlink('actual.js', source)
  await assert.rejects(qualifyFile({ kind: 'js', source, directory, command: [process.execPath], distribution: 'npm' }), /regular file/)
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' })
})

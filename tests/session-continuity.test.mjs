import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import Ajv from 'ajv';

const root = new URL('../', import.meta.url);
const fixtures = new URL('./fixtures/session-continuity/', import.meta.url);
const read = (url) => JSON.parse(readFileSync(url, 'utf8'));

test('continuity contract and native app-server fixtures validate', () => {
  const ajv = new Ajv({ strict: false, validateFormats: false });
  const validate = ajv.compile(read(new URL('contracts/session-continuity.v1.json', root)));
  for (const file of readdirSync(fixtures).filter((name) => !name.endsWith('.schema.json'))) {
    const fixture = read(new URL(file, fixtures));
    assert.ok(fixture.provenance, file);
    assert.ok(validate(fixture.envelope), `${file}: ${JSON.stringify(validate.errors)}`);
  }
  const native = ajv.compile(read(new URL('codex-appserver.schema.json', fixtures)));
  const payload = read(new URL('codex-appserver.json', fixtures)).envelope.payload;
  assert.ok(native(payload), JSON.stringify(native.errors));
  const missingTotal = structuredClone(payload);
  delete missingTotal.tokenUsage.total;
  assert.equal(native(missingTotal), false);
  const malformedLast = structuredClone(payload);
  malformedLast.tokenUsage.last.totalTokens = true;
  assert.equal(native(malformedLast), false);
});

test('continuity executable and crash fixtures', () => {
  const result = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_session_continuity.py'], {
    cwd: root, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

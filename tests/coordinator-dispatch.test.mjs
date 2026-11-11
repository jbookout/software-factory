import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';

test('coordinator dispatch command', () => {
  const result = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_coordinator_dispatch.py'], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});


test('synthetic dispatch request conforms to deployed mint contract', () => {
  const fixture = (name) => JSON.parse(readFileSync(new URL('./fixtures/dispatch/' + name, import.meta.url), 'utf8'));
  const validate = new Ajv({ strict: false, validateFormats: false }).compile(fixture('input-schema.json'));
  assert.ok(validate(fixture('request.json').card), JSON.stringify(validate.errors));
  const response = fixture('mint.json').response;
  assert.equal(response.ok, true);
  assert.match(response.card_id, /^WR[1-9]\d*\.S[1-9]\d*\.J[1-9]\d*$/);
  assert.equal(typeof response.priority, 'number');
});

test('request and response pass registered handler semantic validation with negative control', () => {
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', 'tests/fixtures/dispatch/semantic-check.mjs'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

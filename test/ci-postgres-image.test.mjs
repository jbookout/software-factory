import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync(new URL('../.github/workflows/ci-postgres-image.yml', import.meta.url), 'utf8');
const dockerfile = readFileSync(new URL('../ci/postgres/Dockerfile', import.meta.url), 'utf8');

test('all external actions and the base image are immutable', () => {
  for (const [, reference] of workflow.matchAll(/uses: (\S+)/g)) {
    assert.match(reference, /@[a-f0-9]{40}$/);
  }
  assert.match(dockerfile, /FROM python:3\.14-slim-bookworm@sha256:[a-f0-9]{64} AS base/);
  assert.match(dockerfile, /signed-by=/);
  assert.doesNotMatch(dockerfile, /trusted=yes|allow-unauthenticated/);
});

test('publication requires qualification and only main pushes publish', () => {
  assert.ok(workflow.indexOf('id: qualify') < workflow.indexOf('id: publish'));
  assert.match(workflow, /steps.qualify.outcome == 'success'/);
  assert.match(workflow, /github.event_name == 'push' && github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /--network none/);
  assert.match(workflow, /Deliberately broken image/);
  assert.match(dockerfile, /RUN --network=none python \/opt\/ci\/qualify.py/);
});

test('Python qualification failure-path suite', () => {
  const result = spawnSync(process.env.PYTHON || 'python3', ['-m', 'unittest', 'discover', '-s', 'ci/postgres', '-p', 'test_qualify.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

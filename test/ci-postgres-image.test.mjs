import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
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
  assert.match(workflow, /needs: image/);
  assert.match(workflow, /github.event_name == 'push' && github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /--network none/);
  assert.match(workflow, /Deliberately broken image/);
  assert.match(dockerfile, /RUN --network=none python \/opt\/ci\/qualify.py/);
});

test('Python qualification failure-path suite', () => {
  const result = spawnSync(process.env.PYTHON || 'python3', ['-m', 'unittest', 'discover', '-s', 'ci/postgres', '-p', 'test_qualify.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

const jobs = [...workflow.matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:|$(?![\s\S]))/gm)];

test('real-image qualification preserves Docker failure through receipt capture', () => {
  const image = jobs.find(([, name]) => name === 'image')[2];
  const step = image.match(/      - name: Qualify the real image[^\n]*\n([\s\S]*?)(?=      - )/)[1];
  const shell = step.match(/^        shell: (.+)$/m)?.[1]
    ?? image.match(/^        shell: (.+)$/m)?.[1];
  const command = step.split('        run: |\n')[1].replace(/^          /gm, '');
  const directory = mkdtempSync(join(tmpdir(), 'qualification-step-'));
  try {
    for (const status of [0, 9]) {
      const result = spawnSync('bash', ['--noprofile', '--norc', '-e',
        ...(shell === 'bash' ? ['-o', 'pipefail'] : []), '-c',
        `docker() { echo qualification-receipt; return ${status}; };\n${command}`],
      { cwd: directory, encoding: 'utf8' });
      assert.equal(result.status, status, `Docker exit ${status}: ${result.stdout}${result.stderr}`);
      assert.equal(readFileSync(join(directory, 'qualification.json'), 'utf8'), 'qualification-receipt\n');
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const [event, ref, mayWrite] of [
  ['pull_request', 'refs/heads/main', false],
  ['merge_group', 'refs/heads/main', false],
  ['push', 'refs/heads/feature', false],
  ['push', 'refs/heads/main', true],
]) {
  test(`package writes are main-publication only for ${event} ${ref}`, () => {
    const writers = jobs.filter(([, , body]) => /^      packages: write$/m.test(body));
    assert.equal(writers.length, 1);
    const [, , publisher] = writers[0];
    const guard = publisher.match(/^    if: (.+)$/m)?.[1];
    assert.equal(guard, "github.event_name == 'push' && github.ref == 'refs/heads/main'");
    assert.match(publisher, /^    needs: image$/m);
    const eligible = runInNewContext(`(${guard})`, { github: { event_name: event, ref } });
    assert.equal(eligible, mayWrite);
    assert.doesNotMatch(jobs.find(([, name]) => name === 'image')[2], /packages: write/);
  });
}

test('publication qualifies Rust and the exact CARR consumer before publishing', () => {
  assert.match(dockerfile, /FROM rust:1\.90\.0-bookworm@sha256:[a-f0-9]{64} AS rust/);
  assert.match(dockerfile, /COPY --from=rust \/usr\/local\/rustup/);
  assert.match(workflow, /ref: bd5c4984190293c51c2bd3a6e192525468156630/);
  assert.match(workflow, /cargo build --locked --release --manifest-path \/consumer\/vendor\/hxprobe\/Cargo.toml/);
  assert.match(workflow, /missing-rustc missing-cargo/);
});

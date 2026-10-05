import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { auditWorkflow, verifyActionProvenance } from '../src/workflow-audit.mjs';

const sha = 'a'.repeat(40);
const entry = {sha, canonical_tag_sha: sha, tag: 'v1.2.3', runtime: 'node20', metadata_blob: 'b'.repeat(40), release_url: 'https://github.com/owner/action/releases/tag/v1.2.3'};
const pins = {actions: Object.fromEntries(['checkout', 'upload-artifact', 'download-artifact', 'cache'].map(name => [`actions/${name}`, {...entry, release_url: `https://github.com/actions/${name}/releases/tag/v1.2.3`}]))};
const workflow = run => `on: push
permissions: {contents: read}
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: ${run}
`;
const has = (source, property) => assert.ok(auditWorkflow(source, pins).some(f => f.property === property), property);

const handoff = `on: push
permissions: {contents: read}
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    outputs:
      artifact_id: \${{ steps.upload.outputs.artifact-id }}
      tar_sha: \${{ steps.digest.outputs.sha }}
    steps:
      - uses: actions/checkout@${sha}
        with: {ref: main, persist-credentials: false}
      - run: npm ci
      - run: npm run build
      - id: digest
        run: echo "sha=$(sha256sum release.tgz | cut -d ' ' -f1)" >> "$GITHUB_OUTPUT"
      - id: upload
        uses: actions/upload-artifact@${sha}
        with: {path: release.tgz}
  publish:
    runs-on: ubuntu-latest
    needs: build
    timeout-minutes: 5
    permissions: {contents: write}
    steps:
      - uses: actions/download-artifact@${sha}
        with:
          artifact-ids: \${{ needs.build.outputs.artifact_id }}
          path: bundle
      - shell: bash
        env:
          ARTIFACT_SHA: \${{ needs.build.outputs.tar_sha }}
          ARTIFACT_FILE: bundle/release.tgz
        run: |
          set -euo pipefail
          printf '%s  %s\\n' "$ARTIFACT_SHA" "$ARTIFACT_FILE" | sha256sum -c -
      - run: gh release upload v1 bundle/release.tgz
`;

test('2: npm spellings preserve privilege and secret checks; unknown execution is explicit', () => {
  for (const command of ['npm run test', 'npm --prefix app ci', 'npm  test', 'npm --workspace=app run build', 'npm\tinstall']) {
    const source = workflow(command).replace('    steps:', '    permissions: {contents: write}\n    steps:').replace(`      - run: ${command}`, `      - env: {TOKEN: "\${{ secrets.DEPLOY }}"}\n        run: ${command}`);
    has(source, 'privileged-build'); has(source, 'build-secret');
  }
  has(workflow('./custom-check'), 'unclassified-execution');
});
test('3: bracket and mixed expressions retain credential and injection meaning', () => {
  for (const expression of ["github['event']['pull_request']['title']", "github.event['issue'].body", "github['head_ref']", 'inputs.command', "github['event']['comment'].body"]) has(workflow(`echo \${{ ${expression} }}`), 'event-shell-injection');
  for (const expression of ["secrets['DEPLOY']", "github['token']", "secrets[inputs.key]"]) has(workflow('npm test').replace('    steps:', `    env: {TOKEN: ${JSON.stringify(`\${{ ${expression} }}`)}}\n    steps:`), 'build-secret');
});
test('4: provider, action-input, checkout-token and reusable credentials carry authority', () => {
  const source = handoff.replace('permissions: {contents: write}', 'permissions: {contents: read}').replace('      - run: gh release upload v1 bundle/release.tgz', '      - env: {CLOUDFLARE_API_TOKEN: "${{ secrets.DEPLOY }}"}\n        run: wrangler deploy dist/').replace('          artifact-ids: ${{ needs.build.outputs.artifact_id }}', '          name: arbitrary');
  has(source, 'artifact-origin');
  for (const credential of ['token: "${{ secrets.CUSTOM }}"', 'token: custom-token']) {
    has(workflow('npm test').replace('      - run: npm test', `      - uses: actions/checkout@${sha}\n        with: {ref: "\${{ github.event.pull_request.head.sha }}", persist-credentials: false, ${credential}}\n      - run: npm test`), 'privileged-checkout');
  }
  has(workflow('npm test').replace('      - run: npm test', `      - uses: actions/cache@${sha}\n        with: {token: "\${{ secrets.DEPLOY }}"}`), 'privileged-cache');
  has(`on: pull_request\npermissions: {}\njobs:\n  call:\n    uses: owner/action/.github/workflows/publish.yml@${sha}\n    secrets: {DEPLOY: "\${{ secrets.DEPLOY }}"}\n`, 'privileged-trigger');
});
test('5: artifact IDs require a trusted producer and actual dependency', () => {
  assert.deepEqual(auditWorkflow(handoff, pins), []);
  for (const source of [handoff.replace('ref: main', 'ref: "${{ github.event.pull_request.head.sha }}"').replace('on: push', 'on: pull_request_target'), handoff.replace('    needs: build\n', ''), handoff.replace('needs.build.outputs.artifact_id', 'needs.missing.outputs.artifact_id'), handoff.replace('steps.upload.outputs.artifact-id', 'steps.missing.outputs.artifact-id')]) has(source, 'artifact-origin');
});
test('6: only byte-bound failure-propagating digest checks precede every publisher', () => {
  const guard = `set -euo pipefail\n          printf '%s  %s\\n' "$ARTIFACT_SHA" "$ARTIFACT_FILE" | sha256sum -c -`;
  for (const source of [handoff.replace(guard, "echo 'sha256sum -c'"), handoff.replace('sha256sum -c -', 'sha256sum -c - || true'), handoff.replace('ARTIFACT_FILE: bundle/release.tgz', 'ARTIFACT_FILE: other/release.tgz'), handoff.replace('needs.build.outputs.tar_sha', 'needs.other.outputs.tar_sha'), handoff.replace('      - shell: bash', '      - run: gh release upload v1 bundle/release.tgz\n      - shell: bash'), handoff.replace('      - shell: bash', '      - continue-on-error: true\n        shell: bash'), handoff.replace('      - shell: bash', '      - if: false\n        shell: bash')]) has(source, 'artifact-digest');
  const dir = mkdtempSync(join(tmpdir(), 'digest-contract-'));
  try {
    mkdirSync(join(dir, 'bundle')); writeFileSync(join(dir, 'bundle/release.tgz'), 'verified bytes');
    const digest = execFileSync('shasum', ['-a', '256', join(dir, 'bundle/release.tgz')], {encoding: 'utf8'}).split(' ')[0];
    const command = `set -euo pipefail\nprintf '%s  %s\\n' "$ARTIFACT_SHA" "$ARTIFACT_FILE" | sha256sum -c -`;
    // macOS ships shasum; supply the equivalent sha256sum executable for this contract replay.
    writeFileSync(join(dir, 'sha256sum'), '#!/bin/sh\nexec shasum -a 256 "$@"\n', {mode: 0o755});
    const options = {cwd: dir, env: {...process.env, PATH: `${dir}:${process.env.PATH}`, ARTIFACT_SHA: digest, ARTIFACT_FILE: 'bundle/release.tgz'}};
    assert.equal(spawnSync('bash', ['-c', command], options).status, 0);
    writeFileSync(join(dir, 'bundle/release.tgz'), 'tampered');
    assert.notEqual(spawnSync('bash', ['-c', command], options).status, 0);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
test('7: downloaded execution follows arbitrary and default destinations', () => {
  for (const [source, command] of [[handoff, 'node bundle/release.mjs'], [handoff.replace('          path: bundle\n', '').replace('bundle/release.tgz', 'release.tgz'), 'node release.mjs'], [handoff, 'bash bundle/publish.sh'], [handoff, 'cd bundle && ./release']]) has(source.replace('gh release upload v1 bundle/release.tgz', command).replace('gh release upload v1 release.tgz', command), 'executable-artifact');
});
test('8: workspace glob equivalents cannot be uploaded', () => {
  for (const path of ['*', '**/', './**/*', './*', './/', 'out/../*', '**/*.*']) has(handoff.replace('path: release.tgz', `path: '${path}', include-hidden-files: true`), 'artifact-path');
});
test('9: workflow, job, permission and step shapes fail closed', () => {
  for (const source of ['permissions: {}\njobs: []', 'on: push\npermissions: {}\njobs: {}', 'permissions: {}\njobs: {publish: {timeout-minutes: 5}}', workflow('npm test').replace('contents: read', 'contents: unknown'), workflow('npm test').replace('{contents: read}', 'unknown'), workflow('npm test').replace('    runs-on: ubuntu-latest\n', ''), workflow('npm test').replace('      - run: npm test', '      - env: {}'), workflow('npm test').replace('      - run: npm test', '      - run: npm test\n        uses: ./action')]) has(source, 'invalid-workflow');
});
const apiFor = (metadata, overrides = {}) => async endpoint => endpoint.includes('/git/ref/') ? {object: {type: 'commit', sha}} : endpoint.includes('/releases/') ? {tag_name: entry.tag, draft: false, html_url: entry.release_url} : {sha: entry.metadata_blob, encoding: 'base64', content: Buffer.from(metadata).toString('base64'), ...overrides};
test('10: exported provenance verifier rejects incomplete evidence and YAML errors', async () => {
  await assert.rejects(verifyActionProvenance('owner/action', entry, apiFor('runs: {using: node20}\nruns: {using: node20}')));
  for (const member of ['canonical_tag_sha', 'runtime', 'metadata_blob', 'release_url']) {
    const partial = {...entry}; delete partial[member];
    await assert.rejects(verifyActionProvenance('owner/action', partial, apiFor('runs: {using: node20}')));
  }
  await assert.rejects(verifyActionProvenance('owner/action', {sha, tag: entry.tag, release_url: entry.release_url}, async () => ({})));
  for (const overrides of [{content: undefined}, {sha: undefined}, {encoding: 'utf8'}, {content: '%%%'}]) await assert.rejects(verifyActionProvenance('owner/action', entry, apiFor('runs: {using: node20}', overrides)));
});
test('11: canonical action.yaml and all workflow_call forms are supported without hiding errors', async () => {
  const api = apiFor('runs: {using: node20}');
  const seen = [];
  assert.equal(await verifyActionProvenance('owner/action', entry, async endpoint => {
    seen.push(endpoint);
    if (endpoint.includes('/action.yml?')) throw Object.assign(new Error('missing'), {status: 404});
    return api(endpoint);
  }), true);
  assert.ok(seen.some(path => path.includes('/action.yaml?')));
  await assert.rejects(verifyActionProvenance('owner/action', entry, async () => { throw new Error('transport'); }));
  const pin = {...entry, runtime: 'reusable'};
  for (const on of ['workflow_call', '[workflow_call]', '{workflow_call: {}}']) assert.equal(await verifyActionProvenance('owner/action/.github/workflows/build.yml', pin, apiFor(`on: ${on}`)), true);
});
test('13: inherited reusable secrets have one diagnostic per location', () => {
  const findings = auditWorkflow(`on: push\npermissions: {}\njobs:\n  call:\n    uses: owner/action/.github/workflows/build.yml@${sha}\n    secrets: inherit\n`, pins).filter(f => f.property === 'inherited-secrets');
  assert.equal(findings.length, 1);
});

const cli = resolve('scripts/orch/audit-workflows.mjs');
function cliFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-cli-'));
  const root = join(dir, 'repo'); mkdirSync(join(root, '.github/workflows'), {recursive: true});
  const manifest = join(root, '.github/action-pins.json'); writeFileSync(manifest, JSON.stringify({actions: {}}));
  const file = join(root, '.github/workflows/ci.yml'); writeFileSync(file, workflow('npm test'));
  const run = (args = [root], env = {}) => {
    const result = spawnSync(process.execPath, [cli, ...args], {encoding: 'utf8', env: {...process.env, ...env}, timeout: 35000});
    assert.equal(result.error, undefined); const output = JSON.parse(result.stdout);
    return {...result, output};
  };
  try { fn({dir, root, manifest, file, run}); } finally { rmSync(dir, {recursive: true, force: true}); }
}
test('1: deeply nested YAML through the CLI returns JSON instead of terminating the scan', () => cliFixture(({file, run}) => {
  writeFileSync(file, 'a: ' + '['.repeat(1000) + '0' + ']'.repeat(1000));
  const {status, output} = run(); assert.equal(status, 1); assert.ok(output.findings.some(f => f.property === 'invalid-yaml'));
}));
test('12: CLI preserves findings and explicitly reports invalid manifests and scan coverage', () => cliFixture(({dir, root, manifest, file, run}) => {
  for (const content of ['{bad', 'null', '[]', '{}', '{"actions":[]}']) {
    writeFileSync(manifest, content); const result = run(['--verify-upstream', root]);
    assert.equal(result.status, 1); assert.ok(result.output.findings.some(f => f.property === 'manifest-input'));
  }
  rmSync(manifest); assert.ok(run().output.findings.some(f => f.property === 'manifest-input'));
  writeFileSync(manifest, '{"actions":{}}'); writeFileSync(file, 'jobs: [');
  const result = run([root, join(dir, 'missing')]);
  assert.ok(result.output.findings.some(f => f.property === 'invalid-yaml'));
  assert.ok(result.output.findings.some(f => f.property === 'workflow-input'));
  assert.equal(result.output.coverage.workflows_audited, 1);
  rmSync(file); assert.ok(run().output.findings.some(f => f.property === 'workflow-input'));
  mkdirSync(file); assert.ok(run().output.findings.some(f => f.property === 'workflow-input'));
  assert.equal(run([]).status, 1);
}));
test('12: CLI provider failures are bounded and sanitized', () => cliFixture(({dir, root, manifest, run}) => {
  writeFileSync(manifest, JSON.stringify({actions: {'owner/action': entry}}));
  writeFileSync(join(dir, 'gh'), '#!/bin/sh\necho private-provider-error >&2\nexit 1\n', {mode: 0o755});
  const result = run(['--verify-upstream', root], {PATH: `${dir}:${process.env.PATH}`});
  assert.equal(result.status, 1); assert.ok(result.output.findings.some(f => f.property === 'upstream-provenance'));
  assert.ok(!JSON.stringify(result.output).includes('private-provider-error'));
}));

test('unclassified shell segments and credential literals never certify execution clean', () => {
  for (const run of ['echo ok; ./custom-check', 'echo $(./custom-check)', 'gh release upload v1 bundle/release.tgz && node bundle/release.mjs']) has(workflow(run), 'unclassified-execution');
  has(workflow('npm test').replace('    steps:', '    env: {CLOUDFLARE_API_TOKEN: symbolic-token}\n    steps:'), 'privileged-build');
});
test('artifact guards respect working directories and verified download order', () => {
  has(handoff.replace('      - shell: bash', '      - working-directory: elsewhere\n        shell: bash'), 'artifact-digest');
  has(handoff.replace('    permissions: {contents: write}', '    permissions: {contents: write}\n    defaults: {run: {working-directory: elsewhere}}'), 'artifact-digest');
  has(handoff.replace('      - run: gh release upload v1 bundle/release.tgz', '      - run: gh release upload v1 bundle/release.tgz && node bundle/release.mjs'), 'executable-artifact');
  has(handoff.replace('    permissions: {contents: write}', '    permissions: {contents: write}\n    defaults: {run: {shell: bash}}').replace('      - uses: actions/download-artifact@', '      - run: gh release upload v1 bundle/release.tgz\n      - uses: actions/download-artifact@'), 'artifact-digest');
});
test('malformed producer structures cannot throw or discard diagnostics from other jobs', () => {
  for (const source of [handoff.replace('      artifact_id: ${{ steps.upload.outputs.artifact-id }}', '      artifact_id: 4'), handoff.replace(`uses: actions/checkout@${sha}`, 'uses: 4'), handoff.replace('    runs-on: ubuntu-latest', '    runs-on: []'), handoff.replace('    outputs:', '    steps: []\n    outputs:')]) {
    assert.doesNotThrow(() => auditWorkflow(source, pins));
    assert.ok(auditWorkflow(source, pins).length > 0);
  }
});
test('12: CLI returns bounded JSON on provider timeout', () => cliFixture(({dir, root, manifest, run}) => {
  writeFileSync(manifest, JSON.stringify({actions: {'owner/action': entry}}));
  writeFileSync(join(dir, 'gh'), '#!/bin/sh\nexec sleep 31\n', {mode: 0o755});
  const result = run(['--verify-upstream', root], {PATH: `${dir}:${process.env.PATH}`});
  assert.equal(result.status, 1);
  assert.ok(result.output.findings.some(f => f.property === 'upstream-provenance'));
}));

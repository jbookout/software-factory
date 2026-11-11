import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {runInNewContext} from 'node:vm';
const workflow = readFileSync(new URL('../.github/workflows/ci-postgres-image.yml', import.meta.url), 'utf8');
const dockerfile = readFileSync(new URL('../ci/postgres/Dockerfile', import.meta.url), 'utf8');
const profiles = JSON.parse(readFileSync(new URL('../ci/capabilities/profiles.json', import.meta.url)));
test('construction is independent of merge validation', () => {
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^  (pull_request|merge_group|push):/m);
  assert.match(workflow, /max-parallel: 2/);
});
test('actions and base images are immutable', () => {
  for (const [, ref] of workflow.matchAll(/uses: (\S+)/g)) assert.match(ref, /@[a-f0-9]{40}$/);
  const recipes = dockerfile + readFileSync(new URL('../ci/capabilities/Dockerfile', import.meta.url), 'utf8');
  for (const [, ref] of recipes.matchAll(/^FROM (\S+)/gm)) if (ref.includes(':')) assert.match(ref, /@sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(recipes, /trusted=yes|allow-unauthenticated/);
});
test('publication loads tested bytes and is main-maintenance only', () => {
  const publisher = workflow.slice(workflow.indexOf('  publish:'));
  const guard = publisher.match(/^    if: (.+)$/m)[1];
  for (const event_name of ['pull_request','merge_group','push','schedule','workflow_dispatch']) {
    for (const ref of ['refs/heads/main','refs/heads/branch']) {
      assert.equal(runInNewContext(guard, {github: {event_name, ref}}), ref === 'refs/heads/main' && ['schedule','workflow_dispatch'].includes(event_name));
    }
  }
  assert.equal((workflow.match(/packages: write/g) || []).length, 1);
  assert.match(publisher, /needs: image/);
  assert.doesNotMatch(publisher, /build-push-action|docker build/);
  assert.ok(publisher.indexOf('capabilities.py preflight') < publisher.indexOf('docker push'));
  assert.match(publisher, /docker load -i qualification\/image.tar/);
  assert.match(workflow, /docker save ci-postgres:qualification/);
});
test('all capability contracts retain canonical offline lifecycle and negative controls', () => {
  assert.deepEqual(Object.keys(profiles).sort(), ['app','backup','both','browser']);
  assert.equal(profiles.app.node, 'v26.12.1');
  assert.deepEqual(profiles.app.postgres, [17,18]);
  assert.equal(profiles.backup.pg_dump, '18');
  assert.match(workflow, /negative_controls.py/);
  assert.match(workflow, /--network none.*GITHUB_ACTIONS/);
  assert.match(workflow, /python ops\/disposable-pg-selftest.py/);
  assert.match(workflow, /ref: 6aeb09e0d766015754ea7ebb160180ef14090f3f/);
  assert.match(workflow, /missing-binary wrong-major missing-vector failed-sql missing-rustc missing-cargo/);
});
for (const directory of ['ci/postgres','ci/capabilities']) {
  test(`${directory} failure-path suite`, () => {
    const result = spawnSync(process.env.PYTHON || 'python3', ['-m','unittest','discover','-s',directory,'-p','test_*.py'], {encoding:'utf8'});
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
test('every pinned consumer failure stops image publication', () => {
  const step = workflow.match(/      - name: Exercise the pinned CARR[^\n]*\n([\s\S]*?)(?=      - )/)[1];
  const command = step.split('        run: |\n')[1].replace(/^          /gm, '');
  for (const fault of ['', 'cloud-hook-paths', 'config-as-code-launchd', 'github-gh-caller', 'github-rate-limit', 'disposable-pg']) {
    const setup = `
      cp() { :; }; cd() { :; }; mkdir() { :; }; chmod() { :; };
      timeout() { shift; "$@"; }; npm() { :; };
      python() { if [[ -n "$FAULT" && "$*" == "ops/$FAULT-selftest.py" ]]; then return 42; fi; };
      docker() { for argument; do :; done; bash -ec "$argument"; };
      export -f cp cd mkdir chmod timeout npm python docker;
    `;
    const result = spawnSync('bash', ['-e', '-c', setup + command], {encoding: 'utf8', env: {...process.env, FAULT: fault}});
    assert.equal(result.status, fault ? 42 : 0, result.stdout + result.stderr);
  }
});

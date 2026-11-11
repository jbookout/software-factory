import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const workflows = ["ci.yml"];
const locks = {
  "deploy.yml": [
    "concurrency:\n  group: production\n  cancel-in-progress: false\n"
  ],
  "ci-postgres-image.yml": [
    "concurrency:\n  group: ci-postgres-image-${{ github.ref }}\n  cancel-in-progress: false\n"
  ]
};
const source = (name) => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
const blocks = (text) => [...text.matchAll(/^([ \t]*)concurrency:\n(?:\1[ \t]+[^\n]*\n)+/gm)].map(match => match[0]);

for (const filename of workflows) {
  test(`${filename} isolates heads, events, workflows and refs but deduplicates identical heads`, () => {
    const template = blocks(source(filename))[0].match(/group: (.+)/)[1];
    const github = { workflow: 'CI', event_name: 'pull_request', ref: 'refs/pull/7/merge', sha: 'merge-a',
      run_id: 1, event: { pull_request: { number: 7, head: { sha: 'a'.repeat(40) } } } };
    const key = (context) => template.replace(/\$\{\{(.*?)\}\}/g, (_, expression) =>
      String(runInNewContext(expression, { github: context }, { timeout: 1000 })));
    const original = key(github);
    assert.notEqual(original, key({ ...github, event: { pull_request: { number: 7, head: { sha: 'b'.repeat(40) } } } }));
    assert.equal(original, key({ ...github, sha: 'different-merge', run_id: 2 }));
    assert.notEqual(original, key({ ...github, workflow: 'Other' }));
    assert.notEqual(original, key({ ...github, event: { pull_request: { number: 8, head: { sha: 'a'.repeat(40) } } } }));
    const keys = [original];
    for (const event_name of ['push', 'merge_group']) {
      const context = { ...github, event_name, ref: 'refs/heads/main', event: { pull_request: { number: 0, head: { sha: '' } } } };
      const eventKey = key(context);
      keys.push(eventKey);
      assert.notEqual(eventKey, key({ ...context, sha: 'merge-b' }));
      assert.notEqual(eventKey, key({ ...context, ref: 'refs/heads/other' }));
    }
    assert.equal(new Set(keys).size, 3);
  });
}

test('deployment and publication serialization locks are unchanged', () => {
  for (const [filename, expected] of Object.entries(locks)) assert.deepEqual(blocks(source(filename)), expected, filename);
});

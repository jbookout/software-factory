import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {loadTaskContext} from '../src/task-context.mjs';
test('research context retains factory constraints and loads its scoped references only', async () => {
  const result=await loadTaskContext({root:process.cwd(),task:'presentation-research'});
  assert.deepEqual(result.constraints.map(c=>c.id),['factory-boundaries','working-rules','enforcement','pr-verification']);
  assert.ok(result.references.some(r=>r.path.endsWith('demographics.js')));
  assert.equal(result.references.some(r=>r.path.endsWith('financial-model.md')),false);
  assert.ok(result.selectedBytes<result.catalogBytes);
  assert.ok(result.constraints[0].text.includes('deployment authority'));
});
test('missing mandatory constraint or escaped pointer refuses the load', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'factory-context-'));await fs.mkdir(path.join(root,'config'));
  const manifest=JSON.parse(await fs.readFile('config/task-context.v1.json','utf8'));
  manifest.constraints.pop();await fs.writeFile(path.join(root,'config/task-context.v1.json'),JSON.stringify(manifest));
  await assert.rejects(loadTaskContext({root,task:'presentation-research'}),/mandatory constraint/);
  manifest.constraints.push({id:'pr-verification',path:'../outside.md',section:'Rules'});await fs.writeFile(path.join(root,'config/task-context.v1.json'),JSON.stringify(manifest));
  await assert.rejects(loadTaskContext({root,task:'presentation-research'}),/binding changed/);
});

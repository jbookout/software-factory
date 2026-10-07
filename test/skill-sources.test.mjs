import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {discoverSkills,installSkill} from '../src/skill-sources.mjs';
test('retro is discoverable with verified MIT provenance and installs its dependency in a project', async () => {
  const skills=await discoverSkills(process.cwd());
  assert.equal(skills.find(s=>s.id==='retro').version,'1.3.1');
  assert.equal(skills.find(s=>s.id==='retro').license,'MIT');
  const project=await fs.mkdtemp(path.join(os.tmpdir(),'factory-skills-'));
  const result=await installSkill({root:process.cwd(),id:'retro',project});
  assert.deepEqual(result.installed,['writing-for-agents','retro']);
  assert.match(await fs.readFile(path.join(project,'.agents/skills/retro/SKILL.md'),'utf8'),/Conduct a retrospective/);
  assert.equal((await fs.readFile(path.join(project,'.agents/skills/retro/SKILL.md'),'utf8')).includes('disable-model-invocation'),false);
  assert.match(await fs.readFile(path.join(project,'.agents/skills/retro/agents/openai.yaml'),'utf8'),/allow_implicit_invocation: false/);
  assert.match(await fs.readFile(path.join(project,'.agents/skills/writing-for-agents/SKILL-MECHANICS.md'),'utf8'),/Skill mechanics/);
  await assert.rejects(installSkill({root:process.cwd(),id:'retro',project}),/already exists/);
});
test('install refuses home targets and tampered licensed source', async () => {
  await assert.rejects(installSkill({root:process.cwd(),id:'retro',project:os.homedir()}),/project directory/);
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'factory-registry-'));await fs.mkdir(path.join(root,'config'));
  const registry=JSON.parse(await fs.readFile('config/skill-sources.v1.json','utf8'));registry.sources[0].license='unknown';
  await fs.writeFile(path.join(root,'config/skill-sources.v1.json'),JSON.stringify(registry));
  await assert.rejects(discoverSkills(root),/verified reuse license/);
});

test('symlinked project skill ancestry cannot redirect install writes',async()=>{
  const project=await fs.mkdtemp(path.join(os.tmpdir(),'factory-skill-link-')),outside=await fs.mkdtemp(path.join(os.tmpdir(),'factory-skill-outside-'));
  await fs.symlink(outside,path.join(project,'.agents'),'dir');
  await assert.rejects(installSkill({root:process.cwd(),id:'retro',project}),/ancestry/);
  assert.deepEqual(await fs.readdir(outside),[]);
});

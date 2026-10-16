import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function registry(root) {
  const value=JSON.parse(await fs.readFile(path.join(root,'config/skill-sources.v1.json'),'utf8'));
  if(value.schema!=='factory-skill-sources/v1')throw new Error('unsupported skill source registry');
  if(!Array.isArray(value.sources) || !Array.isArray(value.skills))throw new Error('skill registry requires sources and skills');
  const ids=new Set();
  for(const skill of value.skills) {
    if(!/^[a-z][a-z0-9-]{0,63}$/.test(skill.id) || ids.has(skill.id) || !Array.isArray(skill.dependencies))throw new Error('skill identity or dependencies invalid');
    ids.add(skill.id);
  }
  for(const source of value.sources) {
    if(source.license!=='MIT' || !source.reuseVerified || !/^[a-f0-9]{40}$/.test(source.revision))throw new Error('verified reuse license and pinned revision required');
    if(!Array.isArray(source.files) || !source.files.some(file=>file.path===source.licensePath))throw new Error('license must belong to the verified source file set');
    for(const file of source.files) {
      if(path.isAbsolute(file.path) || file.path.split(/[\\/]/).includes('..'))throw new Error('skill path escapes source');
      const location=await fs.realpath(path.join(root,file.path)),base=await fs.realpath(root);
      if(!location.startsWith(base+path.sep) || (await fs.lstat(path.join(root,file.path))).isSymbolicLink())throw new Error('skill path escapes source');
      if(hash(await fs.readFile(location))!==file.sha256)throw new Error(`skill source digest mismatch: ${file.path}`);
    }
  }
  return value;
}
export async function discoverSkills(root) {
  const value=await registry(root);
  return value.skills.map(skill=>{
    const source=value.sources.find(s=>s.id===skill.source);
    if(!source)throw new Error('skill source missing');
    return {...skill,version:source.version,revision:source.revision,license:source.license,sourceUrl:source.url};
  });
}
export async function installSkill({root,id,project}) {
  const base=path.resolve(project),home=await fs.realpath(os.homedir());
  const real=await fs.realpath(base);
  if(real===home || real.startsWith(path.join(home,'.codex')+path.sep) || real.startsWith(path.join(home,'.agents')+path.sep) || real===path.join(home,'.codex') || real===path.join(home,'.agents'))throw new Error('install requires an explicit project directory, not a home skill location');
  for(const segment of ['.agents', '.agents/skills']) {
    const location=path.join(real,segment);
    const stat=await fs.lstat(location).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(stat?.isSymbolicLink() || (stat && !stat.isDirectory()))throw new Error('skill destination ancestry must be project directories without symlinks');
  }
  const value=await registry(root),installed=[],visiting=new Set();
  async function install(name) {
    if(installed.includes(name))return;
    if(visiting.has(name))throw new Error('skill dependency cycle');
    visiting.add(name);
    const skill=value.skills.find(s=>s.id===name);
    if(!skill)throw new Error(`unknown skill: ${name}`);
    for(const dependency of skill.dependencies)await install(dependency);
    const destination=path.join(real,'.agents','skills',name), source=value.sources.find(s=>s.id===skill.source);
    await fs.mkdir(destination,{recursive:false}).catch(async error=>{if(error.code==='ENOENT'){await fs.mkdir(path.dirname(destination),{recursive:true});await fs.mkdir(destination);}else if(error.code==='EEXIST')throw new Error(`skill already exists: ${name}`);else throw error;});
    for(const file of source.files.filter(f=>f.path.startsWith(skill.path+'/'))) {
      const target=path.join(destination,path.relative(skill.path,file.path));
      await fs.mkdir(path.dirname(target),{recursive:true});
      await fs.copyFile(path.join(root,file.path),target);
    }
    await fs.copyFile(path.join(root,source.licensePath),path.join(destination,'LICENSE'));
    const entrypoint=path.join(destination,'SKILL.md'),text=await fs.readFile(entrypoint,'utf8');
    if(/^disable-model-invocation: true$/m.test(text)) {
      await fs.writeFile(entrypoint,text.replace(/^disable-model-invocation: true\n/m,''));
      await fs.mkdir(path.join(destination,'agents'));
      await fs.writeFile(path.join(destination,'agents/openai.yaml'),'policy:\n  allow_implicit_invocation: false\n');
    }
    installed.push(name);visiting.delete(name);
  }
  await install(id);return {installed,project:base};
}

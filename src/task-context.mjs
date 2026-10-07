import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const required = {'factory-boundaries':'Boundaries','working-rules':'Working rules','enforcement':'Enforcement model','pr-verification':'Before every PR: design and debt pass'};
const digest = value => createHash('sha256').update(value).digest('hex');
async function readPointer(root, pointer) {
  if(typeof pointer.path !== 'string' || path.isAbsolute(pointer.path) || pointer.path.split(/[\\/]/).includes('..')) throw new Error('context pointers must stay inside the factory');
  const file=path.resolve(root,pointer.path), real=await fs.realpath(file), base=await fs.realpath(root);
  if(!real.startsWith(base+path.sep))throw new Error('context pointers must stay inside the factory');
  const bytes=await fs.readFile(real), text=bytes.toString();
  if(!pointer.section)return {...pointer,text,digest:digest(bytes)};
  const heading=`## ${pointer.section}`,start=text.split('\n').findIndex(line=>line===heading);
  if(start<0)throw new Error(`required context section missing: ${pointer.section}`);
  const lines=text.split('\n'),end=lines.findIndex((line,i)=>i>start && line.startsWith('## '));
  return {...pointer,text:lines.slice(start,end<0?undefined:end).join('\n'),digest:digest(bytes)};
}
export async function loadTaskContext({root,task}) {
  const manifest=JSON.parse(await fs.readFile(path.join(root,'config/task-context.v1.json'),'utf8'));
  if(manifest.schema!=='factory-task-context/v1')throw new Error('unsupported task context manifest');
  if(!Array.isArray(manifest.constraints) || manifest.constraints.length!==Object.keys(required).length || Object.keys(required).some(id=>manifest.constraints.filter(p=>p.id===id).length!==1))throw new Error('mandatory constraint pointer missing or duplicated');
  for(const constraint of manifest.constraints) if(constraint.path!=="AGENTS.md" || constraint.section!==required[constraint.id]) throw new Error("mandatory constraint binding changed");
  const pointers=manifest.tasks?.[task];
  if(!Array.isArray(pointers) || !pointers.length)throw new Error(`unknown task context: ${task}`);
  const constraints=await Promise.all(manifest.constraints.map(p=>readPointer(root,p)));
  const references=await Promise.all(pointers.map(p=>readPointer(root,p)));
  const all=new Map(Object.values(manifest.tasks).flat().map(p=>[JSON.stringify(p),p]));
  const catalog=await Promise.all([...all.values()].map(p=>readPointer(root,p)));
  const bytes=items=>items.reduce((sum,item)=>sum+Buffer.byteLength(item.text),0);
  return {schema:manifest.schema,task,constraints,references,selectedBytes:bytes([...constraints,...references]),catalogBytes:bytes([...constraints,...catalog]),scope:'factory-only; CARR runtime rule delivery is unchanged'};
}

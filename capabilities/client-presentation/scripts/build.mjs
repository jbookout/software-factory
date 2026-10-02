import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import '../assets/site/finance.js';

const skillRoot = fileURLToPath(new URL('..', import.meta.url));
const sections = new Set(['home','leases','purchases','strategy','demographics','sources']);
const text = (v, name) => {if(typeof v !== 'string' || !v.trim())throw new Error(`${name} requires text`);};
export function validate(data) {
  if(data.schemaVersion !== 1)throw new Error('schemaVersion must be 1');
  text(data.presentation?.preparedFor,'presentation.preparedFor');
  text(data.presentation?.title,'presentation.title');
  if(!Array.isArray(data.sections)||data.sections.length===0)throw new Error('sections must be a nonempty array');
  const pageIds=new Set();
  for(const s of data.sections){
    if(!sections.has(s.id)||pageIds.has(s.id))throw new Error(`invalid or duplicate section ${s.id}`);
    pageIds.add(s.id);text(s.label,'section label');text(s.title,'section title');
  }
  const ids=new Set();
  for(const [kind,items] of Object.entries({properties:data.properties,leases:data.leases,developments:data.developments})){
    if(!Array.isArray(items))throw new Error(`${kind} must be an array`);
    for(const item of items){
      if(typeof item.id!=='string'||!/^[a-zA-Z][\w-]*$/.test(item.id)||ids.has(item.id))throw new Error(`invalid or duplicate item ID ${item.id}`);
      ids.add(item.id);text(item.name,`${item.id} name`);
      if(item.locator)for(const axis of ['x','y'])if(!Number.isFinite(item.locator[axis])||item.locator[axis]<0||item.locator[axis]>100)throw new Error(`${item.id} locator ${axis} must be 0–100`);
    }
  }
  if(data.sections.some(s=>s.id==='strategy' && s.visible!==false)){
    for(const p of data.properties)globalThis.PresentationFinance.compute(p,data.assumptions,25);
  }
  for(const lease of data.leases)for(const key of ['areaSf','annualRentPerSf','parkingSpaces']){
    if(lease[key] != null && (!Number.isFinite(lease[key])||lease[key]<0))throw new Error(`${lease.id} ${key} must be a nonnegative number or omitted`);
  }
  const sourceIds=new Set();
  for(const s of data.sources || []){
    text(s.id,'source ID');
    if(sourceIds.has(s.id))throw new Error(`duplicate source ID ${s.id}`);
    sourceIds.add(s.id);
  }
  if(data.presentation.fictional !== true){
    if(!Array.isArray(data.sources)||!data.sources.length)throw new Error('client presentations require sources');
    for(const s of data.sources){text(s.id,'source ID');text(s.title,'source title');text(s.date,'source date');}
    const items=[...data.properties,...data.leases,...data.developments];
    if(items.length){
      text(data.locator?.image,'client locator image');
      text(data.locator?.sourceId,'client locator sourceId');
      if(!sourceIds.has(data.locator.sourceId))throw new Error('client locator requires a matching sourceId');
    }
    for(const x of items){
      if(!x.locator || !Number.isFinite(x.locator.x) || !Number.isFinite(x.locator.y))throw new Error(`${x.id} requires verified locator coordinates`);
      if(!x.image)throw new Error(`${x.id} requires an identifiable image for client use`);
      if(!x.sourceId||!data.sources.some(s=>s.id===x.sourceId))throw new Error(`${x.id} requires a matching sourceId`);
    }
  }
  return data;
}

async function localAssets(data, inputDir, output) {
  // Copy only explicitly referenced files. No client folder export or secret glob.
  async function visit(value){
    if(!value || typeof value!=='object')return;
    for(const [key,v] of Object.entries(value)){
      if(['image','reportPath','backgroundImage','logo'].includes(key)&&typeof v==='string'&&v){
        if(/^https:\/\//i.test(v))continue;
        if(/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(v))throw new Error(`unsupported asset URL: ${key}`);
        const source=path.resolve(inputDir,v);
        const allowed=key==='reportPath'?['.pdf']:['.png','.jpg','.jpeg','.webp','.gif'];
        const ext=path.extname(source).toLowerCase();
        if(!allowed.includes(ext))throw new Error(`unsupported ${key} extension ${ext}; use raster images or PDF`);
        if((await fs.lstat(source)).isSymbolicLink())throw new Error('asset symlinks are not copied');
        const bytes=await fs.readFile(source);
        const filename=createHash('sha256').update(bytes).digest('hex').slice(0,16)+ext;
        await fs.mkdir(path.join(output,'media'),{recursive:true});
        await fs.writeFile(path.join(output,'media',filename),bytes);
        value[key]='media/'+filename;
      } else await visit(v);
    }
  }
  await visit(data);
}

export async function build(inputPath, outputPath) {
  const input=path.resolve(inputPath),output=path.resolve(outputPath);
  const data=validate(JSON.parse(await fs.readFile(input,'utf8')));
  // Exclusive creation protects an existing approved artifact.
  await fs.mkdir(output,{recursive:false});
  await fs.cp(path.join(skillRoot,'assets/site'),output,{recursive:true});
  await localAssets(data,path.dirname(input),output);
  await fs.writeFile(path.join(output,'presentation.json'),JSON.stringify(data,null,2)+'\n');
  await fs.writeFile(path.join(output,'data.js'),'window.PresentationData = '+JSON.stringify(data).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029')+';\n');
  return path.join(output,'index.html');
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [input,output]=process.argv.slice(2);
  if(!input||!output){console.error('Usage: node scripts/build.mjs INPUT.json NEW_OUTPUT_DIRECTORY');process.exitCode=1;}
  else try{console.log(await build(input,output));}catch(e){console.error(e.message);process.exitCode=1;}
}

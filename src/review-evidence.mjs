import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
const required=['description','diff','checks']
export async function writeReviewEvidence(directory,binding,inputs) {
 await fs.mkdir(directory,{recursive:true,mode:0o700})
 const files={}
 for(const name of [...required,...(inputs.fixDiff===undefined?[]:['fixDiff'])]) {
  const bytes=name==='checks'?JSON.stringify(inputs[name]):inputs[name]
  if(typeof bytes!=='string')throw new Error(`review input ${name} missing`)
  const file=path.resolve(directory,`${name}.txt`)
  await fs.writeFile(file,bytes,{flag:'wx',mode:0o444})
  files[name]={path:file,digest:digest(bytes)}
 }
 const manifest=path.resolve(directory,'manifest.json')
 await fs.writeFile(manifest,JSON.stringify({schema:'factory-review-input/v1',binding,files}),{flag:'wx',mode:0o444})
 return manifest
}
export async function readReviewEvidence(manifest,expected) {
 const value=JSON.parse(await fs.readFile(manifest,'utf8'))
 if(value.schema!=='factory-review-input/v1' || !value.binding || Object.entries(expected).some(([k,v])=>value.binding[k]!==v))
  throw new Error('review input binding mismatch')
 if(!Number.isFinite(Date.parse(value.binding.observedAt)))throw new Error('review input observation time missing')
 for(const name of [...required,...(value.files?.fixDiff?['fixDiff']:[])]) {
  const file=value.files?.[name]
  if(!file || typeof file.path!=='string' || path.dirname(file.path)!==path.dirname(manifest))throw new Error(`review input ${name} path missing or foreign`)
  if(digest(await fs.readFile(file.path))!==file.digest)throw new Error(`review input ${name} digest mismatch`)
 }
 return {...value,manifest}
}

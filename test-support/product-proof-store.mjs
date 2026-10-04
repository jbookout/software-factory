import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {world} from './browser-proof.mjs'
import {recordingFixture} from './browser-recording.mjs'
export async function proofStore(t) {
  const root=await mkdtemp(join(tmpdir(),'proof-store-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const w=world(),f=await recordingFixture(t),row=w.packet.recordings[0]
  for(const key of ['video','trace','checkpoint']) row[key]=w.put(row[key].ref,f.input[key])
  const provenance=JSON.parse(w.store.get(row.provenance.ref))
  for(const key of ['video','trace','checkpoint']) provenance[key]=row[key]
  row.provenance=w.put(row.provenance.ref,provenance);w.expected.requiredRecordings[0].provenance=row.provenance
  const artifactRoot=join(root,'artifacts'),expectedRoot=join(root,'expected'),key=w.expected.repo.replace('/','--'),head=w.expected.sourceCommit
  const store=join(artifactRoot,key,head),packetFile=join(store,'packet.json'),expectedFile=join(expectedRoot,key,`${head}.json`)
  await mkdir(store,{recursive:true});await mkdir(join(expectedRoot,key),{recursive:true})
  for(const [ref,bytes] of w.store) await writeFile(join(store,ref),bytes)
  await writeFile(packetFile,JSON.stringify(w.packet));await writeFile(expectedFile,JSON.stringify(w.expected))
  return {...w,root,store,artifactRoot,expectedRoot,packetFile,expectedFile}
}

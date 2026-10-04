import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execute=promisify(execFile)
const refused=()=>({decoded:false,operationPresent:false})

// The authenticated capture metadata maps the trace's monotonic clock to video
// time and selects one page/context. Every subprocess can be cancelled within
// the evaluator's deadline; no synchronous decoder can hold its event loop.
export async function inspectBrowserRecording({video,trace,checkpoint,operation,provenance,deadline=Date.now()+30_000,signal}) {
  let root
  const remaining=()=>{
    const value=deadline-Date.now()
    if(value<=0 || signal?.aborted) throw Error('recording deadline')
    return value
  }
  const exec=async(command,args)=>{
    const result=await execute(command,args,{encoding:'buffer',timeout:remaining(),signal,killSignal:'SIGKILL',maxBuffer:16*1024*1024})
    remaining();return result.stdout
  }
  try {
    remaining()
    if(operation!=='save-reload' || !provenance || !Number.isFinite(provenance.videoStartTime) || !Number.isFinite(provenance.checkpointTime)) return refused()
    root=await mkdtemp(join(tmpdir(),'browser-proof-'))
    await Promise.all([writeFile(join(root,'video.webm'),video),writeFile(join(root,'trace.zip'),trace),writeFile(join(root,'checkpoint.png'),checkpoint)])
    const chunks=JSON.parse(await exec('python3',['-c',`
import json,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
  names=[n for n in archive.namelist() if n.endswith('.trace')]
  if not names or len(names)>100 or len(set(names))!=len(names) or sum(archive.getinfo(n).file_size for n in names)>4000000: raise ValueError('trace budget')
  print(json.dumps([[json.loads(line) for line in archive.read(n).splitlines()] for n in names]))
`,join(root,'trace.zip')]))
    let deciding
    for(const rows of chunks) {
      const contexts=rows.filter(row=>row.type==='context-options')
      if(contexts.length!==1 || contexts[0].contextId!==provenance.contextId || contexts[0].browserName!=='chromium' || contexts[0].playwrightVersion!=='1.63.0') continue
      const starts=rows.filter(row=>row.type==='before')
      const completions=rows.filter(row=>row.type==='after')
      const complete=before=>{
        if(typeof before.callId!=='string' || starts.filter(row=>row.callId===before.callId).length!==1 ||
           before.pageId!==provenance.pageId || before.contextId!==provenance.contextId || !Number.isFinite(before.startTime)) return null
        const matches=completions.filter(row=>row.callId===before.callId)
        if(matches.length!==1 || matches[0].error!==undefined || !Number.isFinite(matches[0].endTime) || matches[0].endTime<before.startTime) return null
        return matches[0]
      }
      const saves=starts.filter(row=>row.method==='click' && row.params?.selector==='#save-search')
      const reloads=starts.filter(row=>row.method==='reload')
      if(saves.length!==1 || reloads.length!==1) continue
      const save=complete(saves[0]),reload=complete(reloads[0])
      if(!save || !reload || reloads[0].startTime<=save.endTime || provenance.checkpointTime<reload.endTime ||
         saves[0].startTime<provenance.videoStartTime || deciding) return refused()
      deciding=reload
    }
    if(!deciding) return refused()
    const ffmpeg=(file,filter,...extra)=>exec('ffmpeg',['-v','error','-threads','1','-i',join(root,file),'-vf',filter,...extra,'-threads','1','-f','rawvideo','-pix_fmt','gray','pipe:1'])
    const image=await ffmpeg('checkpoint.png','scale=64:64','-frames:v','1')
    // Select a single frame at the authenticated checkpoint time. A match in
    // an earlier segment cannot satisfy this deciding post-reload observation.
    const seconds=(provenance.checkpointTime-provenance.videoStartTime)/1000
    if(seconds<0 || seconds>60 || provenance.checkpointTime<=deciding.endTime) return refused()
    const frame=await ffmpeg('video.webm',`select=gte(t\\,${seconds}),scale=64:64`,'-frames:v','1','-t','60')
    const size=64*64
    if(image.length!==size || frame.length!==size) return refused()
    let sum=0
    for(let i=0;i<size;i++) sum+=(image[i]-frame[i])**2
    remaining()
    return {decoded:true,operationPresent:Math.sqrt(sum/size)<8}
  } catch {return refused()}
  finally {if(root) await rm(root,{recursive:true,force:true})}
}

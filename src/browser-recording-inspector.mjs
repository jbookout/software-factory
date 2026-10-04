import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

// Decode bytes, not an extension or an exit-zero label. Match the post-reload
// screenshot to a frame and require the actual save then reload in the trace.
// This corroborates visible behavior; independent persistence remains decisive.
export async function inspectBrowserRecording({video,trace,checkpoint,operation}) {
  const root=await mkdtemp(join(tmpdir(),'browser-proof-'))
  const exec=(command,args)=>execFileSync(command,args,{timeout:30_000,maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe']})
  try {
    if(operation!=='save-reload') return {decoded:false,operationPresent:false}
    await Promise.all([writeFile(join(root,'video.webm'),video),writeFile(join(root,'trace.zip'),trace),writeFile(join(root,'checkpoint.png'),checkpoint)])
    const traceActions=JSON.parse(exec('python3',['-c',`
import json,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
  names=[n for n in archive.namelist() if n.endswith('.trace')]
  if not names or sum(archive.getinfo(n).file_size for n in names)>4000000: raise ValueError('trace budget')
  rows=[json.loads(line) for n in names for line in archive.read(n).splitlines()]
  actions=[r for r in rows if r.get('type')=='before']
  print(json.dumps([{'method':r.get('method'),'selector':r.get('params',{}).get('selector')} for r in actions]))
`,join(root,'trace.zip')]).toString())
    const save=traceActions.findIndex(row=>row.method==='click' && row.selector==='#save-search')
    const reload=traceActions.findIndex((row,i)=>i>save && row.method==='reload')
    const ffmpeg=(file,filter)=>exec('ffmpeg',['-v','error','-threads','1','-i',join(root,file),'-vf',filter,'-t','60','-threads','1','-f','rawvideo','-pix_fmt','gray','pipe:1'])
    const image=ffmpeg('checkpoint.png','scale=64:64')
    const frames=ffmpeg('video.webm','fps=2,scale=64:64')
    const size=64*64
    if(image.length!==size || frames.length<size || frames.length%size) return {decoded:false,operationPresent:false}
    let matching=false
    for(let offset=0;offset<frames.length;offset+=size) {
      let sum=0
      for(let i=0;i<size;i++) sum+=(image[i]-frames[offset+i])**2
      if(Math.sqrt(sum/size)<8) {matching=true;break}
    }
    return {decoded:true,operationPresent:save>=0 && reload>save && matching}
  } catch {return {decoded:false,operationPresent:false}}
  finally {await rm(root,{recursive:true,force:true})}
}

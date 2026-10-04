import { mkdtemp,readFile,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
export async function recordingFixture(t) {
  const root=await mkdtemp(join(tmpdir(),'recording-control-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const ffmpeg=args=>execFileSync('ffmpeg',['-v','error','-y','-threads','1',...args,'-threads','1'],{timeout:30_000,stdio:['ignore','pipe','pipe']})
  for(const color of ['red','blue']) ffmpeg(['-f','lavfi','-i',`color=c=${color}:s=320x240:d=2`,'-c:v','libvpx',join(root,`${color}.webm`)])
  ffmpeg(['-i',join(root,'red.webm'),'-frames:v','1',join(root,'checkpoint.png')])
  ffmpeg(['-f','lavfi','-i','color=c=red:s=320x240:d=1','-f','lavfi','-i','color=c=blue:s=320x240:d=1','-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0','-c:v','libvpx',join(root,'pre-only.webm')])
  const trace=async actions=>{
    execFileSync('python3',['-c','import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("trace.trace","\\n".join(json.dumps(r) for r in json.loads(sys.argv[2]))); z.close()',join(root,'trace.zip'),JSON.stringify(actions)],{timeout:5000})
    return readFile(join(root,'trace.zip'))
  }
  const actions=[{type:'context-options',contextId:'context-1',browserName:'chromium',playwrightVersion:'1.63.0'},
    {type:'before',callId:'save',startTime:200,pageId:'page-1',contextId:'context-1',method:'click',params:{selector:'#save-search'}},
    {type:'after',callId:'save',endTime:300},
    {type:'before',callId:'reload',startTime:700,pageId:'page-1',contextId:'context-1',method:'reload',params:{}},
    {type:'after',callId:'reload',endTime:1100}]
  const provenance={pageId:'page-1',contextId:'context-1',videoStartTime:0,checkpointTime:1500}
  const input={video:await readFile(join(root,'red.webm')),trace:await trace(actions),checkpoint:await readFile(join(root,'checkpoint.png')),operation:'save-reload',provenance}
  return {input,actions,trace,video:async name=>readFile(join(root,`${name}.webm`))}
}

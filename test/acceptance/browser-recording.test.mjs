import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { inspectBrowserRecording } from '../../src/browser-recording-inspector.mjs'

test('decoded video must contain its checkpoint and trace must save then reload',async t=>{
  const root=await mkdtemp(join(tmpdir(),'recording-control-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const ffmpeg=args=>execFileSync('ffmpeg',['-v','error','-y','-threads','1',...args,'-threads','1'],{timeout:30_000,stdio:['ignore','pipe','pipe']})
  for(const color of ['red','blue']) ffmpeg(['-f','lavfi','-i',`color=c=${color}:s=320x240:d=2`,'-c:v','libvpx',join(root,`${color}.webm`)])
  ffmpeg(['-i',join(root,'red.webm'),'-frames:v','1',join(root,'checkpoint.png')])
  const trace=async actions=>{
    execFileSync('python3',['-c','import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("trace.trace","\\n".join(json.dumps(r) for r in json.loads(sys.argv[2]))); z.close()',join(root,'trace.zip'),JSON.stringify(actions)],{timeout:5000})
    return readFile(join(root,'trace.zip'))
  }
  const actions=[{type:'before',method:'click',params:{selector:'#save-search'}},{type:'before',method:'reload',params:{}}]
  const input={video:await readFile(join(root,'red.webm')),trace:await trace(actions),checkpoint:await readFile(join(root,'checkpoint.png')),operation:'save-reload'}
  assert.deepEqual(await inspectBrowserRecording(input),{decoded:true,operationPresent:true})
  assert.equal((await inspectBrowserRecording({...input,video:await readFile(join(root,'blue.webm'))})).operationPresent,false)
  assert.equal((await inspectBrowserRecording({...input,trace:await trace([...actions].reverse())})).operationPresent,false)
  assert.equal((await inspectBrowserRecording({...input,trace:await trace([])})).operationPresent,false)
  assert.equal((await inspectBrowserRecording({...input,video:Buffer.from('CANARY_SECRET')})).decoded,false)
})

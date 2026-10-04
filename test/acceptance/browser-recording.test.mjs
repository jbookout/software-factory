import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectBrowserRecording } from '../../src/browser-recording-inspector.mjs'
import { recordingFixture } from '../../test-support/browser-recording.mjs'

test('decoded video must contain its checkpoint and successful same-page save then reload',async t=>{
  const f=await recordingFixture(t)
  assert.deepEqual(await inspectBrowserRecording(f.input),{decoded:true,operationPresent:true})
  assert.equal((await inspectBrowserRecording({...f.input,video:await f.video('blue')})).operationPresent,false)
  assert.equal((await inspectBrowserRecording({...f.input,trace:await f.trace([])})).operationPresent,false)
  assert.equal((await inspectBrowserRecording({...f.input,video:Buffer.from('CANARY_SECRET')})).decoded,false)
})
for(const [name,change] of [
 ['failed completions',rows=>rows.filter(r=>r.type==='after').forEach(r=>r.error={message:'failed'})],
 ['different page',rows=>rows.find(r=>r.callId==='reload' && r.type==='before').pageId='page-2'],
 ['different context',rows=>rows.find(r=>r.callId==='reload' && r.type==='before').contextId='context-2'],
 ['no completion',rows=>rows.splice(rows.findIndex(r=>r.callId==='reload' && r.type==='after'),1)],
 ['save still running at reload',rows=>rows.find(r=>r.callId==='save' && r.type==='after').endTime=1200],
 ['duplicate completion',rows=>rows.push({...rows.at(-1)})],
]) test(`review 7: refuses ${name}`,async t=>{const f=await recordingFixture(t);change(f.actions);assert.equal((await inspectBrowserRecording({...f.input,trace:await f.trace(f.actions)})).operationPresent,false)})
test('review 7: matching frames before the deciding reload cannot prove its result',async t=>{const f=await recordingFixture(t);assert.equal((await inspectBrowserRecording({...f.input,video:await f.video('pre-only')})).operationPresent,false)})
test('review 10: decoder processes obey a supplied acceptance deadline',async t=>{const f=await recordingFixture(t);assert.equal((await inspectBrowserRecording({...f.input,deadline:Date.now()-1})).decoded,false)})

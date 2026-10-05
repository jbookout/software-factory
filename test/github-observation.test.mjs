import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createGitHubObservation, queryBackoffMs } from '../src/github-observation.mjs'

async function fixture(t, options = {}) {
 const stateDir=await fs.mkdtemp(path.join(os.tmpdir(),'github-observation-'))
 t.after(()=>fs.rm(stateDir,{recursive:true,force:true}))
 let now=1000000, calls=0
 const config={stateDir,commandTimeoutMs:1000,pollMs:5,github:{requestsPerHour:20,cacheMs:60000,...options}}
 const observer=()=>createGitHubObservation(config,{now:()=>now})
 const fetch=(pool,key,response)=>observer().request({pool,key},async()=>{calls++;return response})
 return {config,observer,fetch,calls:()=>calls,advance:ms=>now+=ms}
}
const response=(status,headers='',body='{}')=>({code:status>=400?1:0,stdout:`HTTP/2.0 ${status} synthetic\n${headers}\n\n${body}`})
test('retro 2: cache is shared across consumers but REST and GraphQL evidence stay distinct',async t=>{
 const f=await fixture(t)
 const key='fixture/repo/head/checks'
 await f.fetch('rest',key,response(200,'','{"source":"rest"}'))
 await f.fetch('rest',key,response(200,'','{"source":"rest"}'))
 const graph=await f.fetch('graphql',key,response(200,'','{"source":"graphql"}'))
 assert.equal(graph.body.source,'graphql');assert.equal(f.calls(),2)
})
test('retro 2: concurrent consumers spend one budget and coalesce identical head reads',async t=>{
 const f=await fixture(t,{requestsPerHour:1})
 await Promise.all(Array.from({length:5},()=>f.fetch('rest','repo/head/checks',response(200))))
 assert.equal(f.calls(),1)
 await assert.rejects(f.fetch('graphql','other',response(200)),e=>e.state==='quota_hold')
 assert.equal(f.calls(),1)
})
test('retro 2: quota blocks fallback pools until both server reset and retry-after expire',async t=>{
 const f=await fixture(t)
 await assert.rejects(f.fetch('rest','checks',response(403,'X-RateLimit-Remaining: 0\nX-RateLimit-Reset: 1180\nRetry-After: 120')),e=>e.state==='quota_hold'&&e.retryAt===1180000)
 f.advance(120000)
 await assert.rejects(f.fetch('graphql','fallback',response(200)),e=>e.state==='quota_hold')
 assert.equal(f.calls(),1)
 f.advance(60001);await f.fetch('rest','checks',response(200));assert.equal(f.calls(),2)
})
test('retro 2: malformed observations use pstack backoff and terminate after five query errors',async t=>{
 const f=await fixture(t,{cacheMs:0})
 assert.deepEqual([1,2,3,4,5].map(queryBackoffMs),[60000,120000,240000,300000,300000])
 for(let failure=1;failure<=5;failure++) {
  await assert.rejects(f.fetch('rest','checks',response(200,'','malformed')),e=>e.state==='unknown'&&e.queryErrors===failure&&e.terminal===(failure===5))
  f.advance(queryBackoffMs(failure)+1)
 }
 await assert.rejects(f.fetch('rest','checks',response(200)),e=>e.terminal===true)
 assert.equal(f.calls(),5)
})
test('retro 2: GraphQL quota body cannot become a successful observation',async t=>{
 const f=await fixture(t)
 await assert.rejects(f.fetch('graphql','checks',response(200,'','{"errors":[{"type":"RATE_LIMITED"}]}')),e=>e.state==='quota_hold'&&e.pool==='graphql')
 await assert.rejects(f.fetch('rest','fallback',response(200)),e=>e.state==='quota_hold')
 assert.equal(f.calls(),1)
})
test('retro 2: valid JSON with malformed provider structure persists the same unknown hold',async t=>{
 const f=await fixture(t)
 await assert.rejects(f.observer().request({pool:'rest',key:'repo/head/checks',validate:body=>Array.isArray(body.check_runs)},async()=>response(200)),e=>e.state==='unknown'&&e.retryAt===1060000)
 await assert.rejects(f.fetch('rest','repo/head/checks',response(200)),e=>e.state==='unknown')
 assert.equal(f.calls(),0)
})
test('retro 2: successful partial reads cannot erase a failing observation streak', async t => {
 const f = await fixture(t, {cacheMs:0})
 for (let failure=1; failure<=5; failure++) {
  await f.fetch('rest','pr',response(200))
  await assert.rejects(f.fetch('rest','checks',response(200,'','malformed')),
   e=>e.queryErrors===failure && e.terminal===(failure===5))
  f.advance(queryBackoffMs(failure)+1)
 }
 assert.equal(f.calls(),10)
})
test('retro 2: a cached generic read still obeys the next consumer structural validator', async t => {
 const f=await fixture(t)
 await f.fetch('rest','repo/head/checks',response(200))
 await assert.rejects(f.observer().request({pool:'rest',key:'repo/head/checks',validate:body=>Array.isArray(body.check_runs)},
  async()=>{throw Error('cached invalid evidence must not make another request')}),e=>e.state==='unknown'&&e.retryAt===1060000)
 await assert.rejects(f.fetch('rest','other',response(200)),e=>e.state==='unknown')
 assert.equal(f.calls(),1)
})

test('PR46 finding 2: a successful cached observation clears only its own streak',async t=>{
 const f=await fixture(t)
 await f.fetch('rest','checks',response(200))
 await assert.rejects(f.observer().request({pool:'rest',key:'checks',validate:()=>false},async()=>response(200)),e=>e.state==='unknown')
 f.advance(60001)
 // Keep the known-good cache alive for this recovery probe.
 const file=path.join(f.config.stateDir,'github.json'),state=JSON.parse(await fs.readFile(file))
 for(const item of Object.values(state.cache)) item.expiresAt=2000000
 state.failures.other=3;await fs.writeFile(file,JSON.stringify(state))
 await f.fetch('rest','checks',response(200))
 assert.deepEqual(JSON.parse(await fs.readFile(file)).failures,{other:3})
})

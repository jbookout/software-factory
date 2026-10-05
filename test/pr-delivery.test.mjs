import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { loadDeliveryConfig, createPrDeliveryAdapter } from "../src/pr-delivery.mjs"
import { acquireLease, keyFor, pause } from "../src/pr-delivery-state.mjs"

const cli = fileURLToPath(new URL("../bin/pr-delivery.mjs", import.meta.url))
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const fake = `#!/usr/bin/env node
const fs = require('node:fs'), cp = require('node:child_process');
const args = process.argv.slice(2), file = process.env.FAKE_PR;
const s = JSON.parse(fs.readFileSync(file));
const save = () => fs.writeFileSync(file, JSON.stringify(s));
const git = (...a) => cp.execFileSync('git', a, {encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
s.headRefOid = git('--git-dir',s.remote,'rev-parse','refs/heads/topic');
const tool = require('node:path').basename(process.argv[1]);
if(tool === 'codex') {
 let prompt=''; process.stdin.on('data',b=>prompt+=b); process.stdin.on('end',()=>{
 s.calls.push({prompt,cwd:process.cwd(),args}); save();
 if(s.childCode) { console.error(s.childError??'synthetic child refusal');process.exit(s.childCode); }
 if(s.hang) { process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); return; }
 if(prompt.includes('REVIEW MODE:')) {
 if(s.reviewerCommit) { fs.writeFileSync('feature.txt','prohibited');git('add','feature.txt');git('commit','-qm','Prohibited reviewer edit'); }
 const body=(s.blockOnce && !s.blocked ? 'REVIEW: BLOCKED' : 'APPROVE')+'\\nReviewed-SHA: '+s.headRefOid+'\\n\\n'+(s.blockOnce && !s.blocked ? '1. fix defect\\nNon-blocking\\nNone' : 'Non-blocking\\nNone');
 s.blocked=true; save(); fs.writeFileSync(args[args.indexOf('--output-last-message')+1], body);
 } else if(!s.noProgress) {
 fs.writeFileSync('fix.txt',String(Date.now())); git('add','fix.txt'); git('commit','-qm','Repair'); git('push','-q','origin','HEAD:topic');
 s.statusCheckRollup=[{status:'COMPLETED',conclusion:'SUCCESS'}]; s.mergeable='MERGEABLE'; s.mergeStateStatus='CLEAN'; save();
 }
 });
} else {
 s.ghCalls.push(args); save(); const action=args[1];
 if(args[0]==='api') {
 const route=args.find(a=>a.startsWith('repos/')), params=new URL('https://fixture.invalid/'+route).searchParams;
 const page=Number(params.get('page')||1),pageSize=Number(params.get('per_page')||100);
 const respond=value=>console.log('HTTP/2.0 200 OK\\n\\n'+JSON.stringify(value));
 if(args.includes('-X')) {
 // Writes: JSON body on stdin; s.writeFaults[name] injects one outcome per call.
 const body=JSON.parse(fs.readFileSync(0,'utf8')),name=route.split('/').at(-1);
 const reply=(code,value)=>{console.log('HTTP/2.0 '+code+' synthetic\\n\\n'+JSON.stringify(value));process.exit(code<300?0:1)};
 const fault=s.writeFaults?.[name]?.shift();save();
 if(s.pauseWrite===name) {fs.writeFileSync(s.pauseMarker,String(process.pid));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,3000);}
 if(fault==='no-response') process.exit(1);
 if(typeof fault==='number') reply(fault,{message:'synthetic'});
 const topicHasMain=()=>{try{git('--git-dir',s.remote,'merge-base','--is-ancestor','refs/heads/main','refs/heads/topic');return true}catch{return false}};
 if(name==='comments') {
 s.comments.push({body:body.body,pr:Number(route.split('/')[4]),author:{login:'reviewer'}});
 if(s.advanceMainOnComment) {git('-C',s.checkout,'checkout','-q','main');fs.writeFileSync(s.checkout+'/late-main.txt','late');git('-C',s.checkout,'add','late-main.txt');git('-C',s.checkout,'commit','-qm','Late main');git('-C',s.checkout,'push','-q','origin','main');s.advanceMainOnComment=false;}
 save();reply(201,{id:s.comments.length});
 } else if(name==='update-branch') {
 if(body.expected_head_sha!==s.headRefOid) reply(422,{message:'expected head sha mismatch'});
 git('-C',s.checkout,'checkout','-q','topic');git('-C',s.checkout,'fetch','-q','origin');
 try {git('-C',s.checkout,'merge','--no-edit','origin/main')} catch {git('-C',s.checkout,'merge','--abort');git('-C',s.checkout,'checkout','-q','main');reply(422,{message:'merge conflict'})}
 git('-C',s.checkout,'push','-q','origin','topic');git('-C',s.checkout,'checkout','-q','main');s.headRefOid=git('--git-dir',s.remote,'rev-parse','refs/heads/topic');save();
 if(s.loseUpdateResponse) reply(502,{message:'synthetic lost response'});
 reply(202,{message:'Updating pull request branch.'});
 } else if(name==='merge') {
 if(body.merge_method!=='squash' || body.sha!==s.headRefOid) reply(409,{message:'Head branch was modified'});
 // Models an active strict ruleset: the provider refuses a head that lacks main.
 const strict=(s.rules??[{parameters:{strict_required_status_checks_policy:true}}]).some(r=>r.parameters?.strict_required_status_checks_policy)
  && (s.ruleset?.enforcement??'active')==='active' && (s.ruleset?.current_user_can_bypass??'never')==='never';
 if(strict && !topicHasMain()) reply(405,{message:'Head branch is not up to date with the base branch'});
 git('-C',s.checkout,'fetch','-q','origin');git('-C',s.checkout,'checkout','-q','main');git('-C',s.checkout,'reset','-q','--hard','origin/main');git('-C',s.checkout,'merge','--squash','origin/topic');git('-C',s.checkout,'commit','-qm','Merge PR');git('-C',s.checkout,'push','-q','origin','main');
 s.state='MERGED';s.mergeCommit={oid:git('-C',s.checkout,'rev-parse','HEAD')};save();
 reply(200,s.missingAck?{}:{merged:true,sha:s.mergeCommit.oid});
 }
 console.error('unexpected REST write');process.exit(2);
 }
 if(s.restCodes?.length) {const code=s.restCodes.shift();save();console.log('HTTP/2.0 '+code+' synthetic\\nRetry-After: 0\\n'+(s.quotaEvidence?'X-RateLimit-Remaining: 0\\n':'')+'\\n{}');process.exit(1);}
 if(s.apiHang) { if(s.apiHang!=='fetch') process.stdout.write('HTTP/2.0 200 OK\\n\\n{'); setInterval(()=>{if(s.apiHang==='drip') process.stdout.write(' ');},10); return; }
 if(s.apiFailure) { console.log('HTTP/2.0 403 Forbidden\\nx-ratelimit-remaining: 0\\n\\n{}');console.error('provider unavailable');process.exit(1); }
 if(s.restFault) { if(s.restFault==='exception') process.exit(2); if(s.restFault==='refusal') {console.log('HTTP/2.0 401 Unauthorized\\n\\n{}');process.exit(1);}
 console.log('HTTP/2.0 200 OK\\n\\n'+s.restFault);process.exit(0); }
 const pr=()=>({number:s.number,title:s.title,state:s.state==='OPEN'?'open':'closed',merged:s.state==='MERGED',draft:s.isDraft,
 head:{sha:s.headRefOid,ref:s.headRefName,repo:{full_name:s.isCrossRepository?'fixture/fork':'fixture/new-repository'}},
 base:{ref:s.baseRefName,repo:{full_name:'fixture/new-repository'}},mergeable:s.mergeable==='UNKNOWN'?null:s.mergeable!=='CONFLICTING',mergeable_state:s.mergeStateStatus.toLowerCase(),merge_commit_sha:s.mergeCommit?.oid});
 if(/pulls\\/[0-9]+$/.test(route)) {
 if(s.moveDuringChecks && ++s.moveViewCount>1) {
 git('-C',s.checkout,'checkout','-q','topic');fs.writeFileSync(s.checkout+'/moved.txt','moved');git('-C',s.checkout,'add','moved.txt');git('-C',s.checkout,'commit','-qm','Move head');git('-C',s.checkout,'push','-q','origin','topic');
 s.headRefOid=git('--git-dir',s.remote,'rev-parse','refs/heads/topic');s.moveDuringChecks=false;save(); }
 save();respond({...pr(),number:Number(route.split('/').at(-1))});
 } else if(route.includes('/pulls?')) {
 const prs=s.listCount?Array.from({length:s.listCount},(_,i)=>({...pr(),body:'x'.repeat(s.listBodyBytes??0),number:i===s.listCount-1?7:i+100})):[pr()];respond(prs.slice((page-1)*pageSize,page*pageSize));
 } else if(route.includes('/comments')) {
 const number=Number(/issues\\/([0-9]+)\\//.exec(route)[1]);
 respond(s.comments.filter(c=>(c.pr??7)===number).slice((page-1)*pageSize,page*pageSize));
 }
 else if(route.includes('/check-runs')) {
 const runs=s.checkRuns??s.statusCheckRollup.filter(c=>c.__typename!=='StatusContext').map((c,i)=>({id:i+1,name:c.name??(i?'optional-'+i:'test'),head_sha:s.headRefOid,status:c.status?.toLowerCase(),conclusion:c.conclusion?.toLowerCase()??null,app:{id:15368}}));
 respond({total_count:runs.length,check_runs:runs.slice((page-1)*pageSize,page*pageSize)});
 } else if(route.includes('/statuses')) {
 const statuses=s.statuses??s.statusCheckRollup.filter(c=>c.__typename==='StatusContext').map((c,i)=>({id:i+1,context:c.context??'test',state:c.state?.toLowerCase()}));
 respond(statuses.slice((page-1)*pageSize,page*pageSize));
 }
 else if(route.includes('/rules/branches/main')) {
 const rules=s.rules??[{type:'required_status_checks',ruleset_id:1,parameters:{strict_required_status_checks_policy:true}}];
 respond(rules.slice((page-1)*pageSize,page*pageSize));
 } else if(route.endsWith('/rulesets/1')) respond(s.ruleset??{id:1,enforcement:'active',current_user_can_bypass:'never'});
 else { console.error('unexpected REST route');process.exit(2); }
 } else if(action==='comment') {s.comments.push({body:args[args.indexOf('--body')+1],pr:Number(args[2]),author:{login:'reviewer'}}); save();}
 else {console.error('Unexpected gh action '+args.join(' '));process.exit(2);}
}
`

async function fixture(t, overrides = {}, configOverrides = {}) {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-delivery-"))
 t.after(() => fs.rm(root, { recursive: true, force: true }))
 const checkout = path.join(root, "checkout"), remote = path.join(root, "remote.git")
 const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid", FAKE_PR: path.join(root, "pr.json") }
 // Local Git identity is fixture-only; no inherited credentials or hooks.
 execFileSync("git", ["init", "--bare", remote], {env,stdio:"ignore"})
 execFileSync("git", ["clone", remote, checkout], {env,stdio:"ignore"})
 const g = (...args) => execFileSync("git", args, { cwd:checkout,env,encoding:"utf8",stdio:["ignore","pipe","pipe"] }).trim()
 g("checkout", "-b", "main"); g("config", "user.name", "Fixture"); g("config", "user.email", "fixture@example.invalid")
 await fs.writeFile(path.join(checkout,"base.txt"),"base\n");g("add","base.txt");g("commit","-qm","Base");g("push","-q","origin","main")
 g("checkout","-b","topic");await fs.writeFile(path.join(checkout,"feature.txt"),"feature\n");g("add","feature.txt");g("commit","-qm","Feature");g("push","-q","origin","topic")
 const head = g("rev-parse","HEAD");g("checkout","main")
 const tools=path.join(root,"tools");await fs.mkdir(tools)
 for(const name of ["gh","codex"]) await fs.writeFile(path.join(tools,name),fake,{mode:0o755})
 env.PATH=tools+path.delimiter+env.PATH
 const state={ remote,checkout,number:7,title:"Fixture PR",state:"OPEN",baseRefName:"main",isCrossRepository:false,headRefName:"topic",headRefOid:head,mergeStateStatus:"CLEAN",mergeable:"MERGEABLE",isDraft:false,author:{login:"builder"},comments:[],statusCheckRollup:[{status:"COMPLETED",conclusion:"SUCCESS"}],calls:[],ghCalls:[],...overrides }
 await fs.writeFile(env.FAKE_PR,JSON.stringify(state))
 const config=path.join(root,"config.json"), stateDir=path.join(root,"state")
 // CLI smoke controls use the trusted host observer. The shared development
 // host exceeded 32 occupied units before these fake workers could start.
 // Admission keeps its own budget when a test shortens execution.
 // Capacity refusal itself uses injected snapshots in its own tests.
 const cfg={repos:{"fixture/new-repository":{checkout,originUrl:remote,worktreeRoot:path.join(root,"worktrees"),requiredChecks:[{name:"test"}]}},stateDir,codex:{model:"fixture-model",effort:"high"},resources:{capacity:128,browserConcurrency:1,agentUnits:1},limits:{runsPer24h:8,slots:2,timeoutMs:5000},pollMs:5,retryMs:0,commandTimeoutMs:5000,queueTimeoutMs:5000,...configOverrides}
 await fs.writeFile(config,JSON.stringify(cfg))
 const read=async()=>JSON.parse(await fs.readFile(env.FAKE_PR,"utf8"))
 const launch=(command,args,workerEnv=env)=>new Promise((resolve,reject)=>{
  const child=spawn(command,args,{env:workerEnv,stdio:["ignore","pipe","pipe"]});let stdout="",stderr=""
  child.stdout.on("data",b=>stdout+=b);child.stderr.on("data",b=>stderr+=b);child.on("error",reject);child.on("close",code=>resolve({code,stdout,stderr}))
 })
 const run=(...args)=>launch(process.execPath,[cli,config,...args])
 const wrapper=(name,...args)=>launch("sh",[fileURLToPath(new URL(`../deploy/orch/${name}.sh`,import.meta.url)),...args],
   {...env,FACTORY_ROOT:fileURLToPath(new URL("../",import.meta.url)),FACTORY_PR_CONFIG:config})
 const approve=async (body,number=7)=>{
  if(body) { const s=await read();s.comments.push({body,author:{login:"reviewer"}});await fs.writeFile(env.FAKE_PR,JSON.stringify(s));return }
  const before=await read(), apiFailure=before.apiFailure, move=before.moveDuringChecks;before.apiFailure=false;before.moveDuringChecks=false;await fs.writeFile(env.FAKE_PR,JSON.stringify(before))
  // The short readiness deadline is the property under test, not approval setup.
  await fs.writeFile(config,JSON.stringify({...cfg,checksTimeoutMs:5000}))
  const r=await run("review-pr","fixture/new-repository",String(number))
  await fs.writeFile(config,JSON.stringify(cfg));assert.equal(r.code,0,JSON.stringify(r))
  const s=await read();s.apiFailure=apiFailure;s.moveDuringChecks=move;s.moveViewCount=0;s.calls=[];s.ghCalls=[];await fs.writeFile(env.FAKE_PR,JSON.stringify(s))
  await fs.writeFile(path.join(stateDir,"usage.json"),"[]") // approval is fixture setup, outside the exercised budget.
 }

 return {root,checkout,remote,head,stateDir,read,run,wrapper,approve,g,config,cfg,env}
}
const repo="fixture/new-repository"
const ok = r => assert.equal(r.code,0,JSON.stringify(r))
const merges = a => a.includes("-X") && a.some(v=>v.endsWith("/merge"))

test("approve -> enqueue -> serial squash merge verifies main",async t=>{
 const f=await fixture(t);ok(await f.run("review-pr",repo,"7"));const s=await f.read()
 assert.equal(s.comments[0].body.split("\n")[0],"APPROVE");assert.equal(s.comments[0].body.split("\n")[1],"Reviewed-SHA: "+f.head)
 for(const letter of "abcdefghijk") assert.match(s.calls[0].prompt,new RegExp("\\("+letter+"\\)"))
 assert.match(s.calls[0].prompt,/codebase-design/);assert.match(s.calls[0].prompt,/zero-tech-debt/);assert.match(s.calls[0].prompt,/swiftui-pro/)
 assert.ok(s.calls[0].args.includes("fixture-model"))
 ok(await f.run("auto-enqueue","--once"));ok(await f.run("merge-queue","--once"))
 const merged=await f.read();assert.equal(merged.state,"MERGED");assert.equal(f.g("rev-parse","origin/main"),merged.mergeCommit.oid)
 assert.ok(merged.ghCalls.some(a=>a.includes("PUT")&&a.some(v=>v.endsWith("/pulls/7/merge"))&&!a.includes("--auto")))
})
test("blocked review -> fix -> re-review uses confirmation scope",async t=>{
 const f=await fixture(t,{blockOnce:true});ok(await f.run("pr-loop",repo,"7","-","3"));const s=await f.read()
 assert.equal(s.calls.length,3);assert.match(s.calls[1].prompt,/Tests first/);assert.match(s.calls[2].prompt,/REVIEW MODE: confirm/)
 assert.notEqual(s.headRefOid,f.head);assert.match(s.comments.at(-1).body,/^APPROVE\nReviewed-SHA:/)
})
for(const action of ["fix-pr","ci-fix"]) test("checked-out branch is reused by "+action+" without exit 128",async t=>{
 const f=await fixture(t);const wt=path.join(f.root,"existing");f.g("worktree","add",wt,"topic")
 ok(await f.run(action,repo,"7","-", "--no-loop"));assert.equal(await fs.realpath((await f.read()).calls[0].cwd),await fs.realpath(wt))
})
test("dirty reused branch is refused without resetting it",async t=>{
 const f=await fixture(t);f.g("checkout","topic");await fs.writeFile(path.join(f.checkout,"feature.txt"),"dirty")
 const r=await f.run("fix-pr",repo,"7","-");assert.notEqual(r.code,0);assert.match(r.stderr,/uncommitted/);assert.equal((await f.read()).calls.length,0)
 assert.equal(await fs.readFile(path.join(f.checkout,"feature.txt"),"utf8"),"dirty")
})
test("an unpublished clean repair commit is retained and never given to a fixer",async t=>{
 const f=await fixture(t);f.g("checkout","topic")
 await fs.writeFile(path.join(f.checkout,"unrelated.txt"),"local work")
 f.g("add","unrelated.txt");f.g("commit","-qm","Unpublished")
 const local=f.g("rev-parse","HEAD"), r=await f.run("fix-pr",repo,"7","-")
 assert.notEqual(r.code,0);assert.match(r.stderr,/source|ahead|binding/i)
 assert.equal((await f.read()).calls.length,0);assert.equal(f.g("rev-parse","HEAD"),local)
})
test("a fork head cannot be repaired through an origin branch with the same name",async t=>{
 const f=await fixture(t,{isCrossRepository:true,headRepository:{nameWithOwner:"fixture/fork"}})
 const r=await f.run("fix-pr",repo,"7","-")
 assert.notEqual(r.code,0);assert.equal((await f.read()).calls.length,0)
})
for(const action of ["merge-one-core","review-pr","fix-pr"]) test(`unsupported PR base is refused before ${action} mutates or starts work`,async t=>{
 const f=await fixture(t,{baseRefName:"release"});await f.approve(`APPROVE\nReviewed-SHA: ${f.head}`)
 const r=await f.run(action,repo,"7",f.head)
 assert.notEqual(r.code,0);assert.match(r.stderr,/base|target/i)
 const s=await f.read();assert.equal(s.state,"OPEN");assert.equal(s.calls.length,0)
 assert.ok(s.ghCalls.every(a=>a[0]==="api" && !a.includes("-X")),"no update, comment or merge")
})
for(const action of ["pr-loop","review-pr","fix-pr","ci-fix"]) test(`closed PR stops ${action} before work or success claims`,async t=>{
 const f=await fixture(t,{state:"CLOSED"});await f.approve(`APPROVE\nReviewed-SHA: ${f.head}`)
 const r=await f.run(action,repo,"7","-")
 assert.notEqual(r.code,0);assert.match(r.stdout,/NOT OPEN/)
 assert.equal((await f.read()).calls.length,0)
})
test("NO-PROGRESS exits 2 instead of re-reviewing unchanged head",async t=>{
 const f=await fixture(t,{noProgress:true});await f.approve("REVIEW: BLOCKED\nReviewed-SHA: "+f.head+"\n1. defect")
 const r=await f.run("pr-loop",repo,"7","-","3");assert.equal(r.code,2);assert.match(r.stdout,/NO-PROGRESS/);assert.equal((await f.read()).calls.length,1)
})
test("nine automatic redispatches on one refused head record one wait and no new attempts",async t=>{
 const f=await fixture(t,{noProgress:true});await f.approve("REVIEW: BLOCKED\nReviewed-SHA: "+f.head+"\n1. defect")
 assert.equal((await f.run("pr-loop",repo,"7","-","3")).code,2)
 for(let i=0;i<9;i++) assert.equal((await f.run("pr-loop",repo,"7","-","3")).code,2)
 assert.equal((await f.read()).calls.length,1)
 const events=(await fs.readFile(path.join(f.stateDir,"delivery.jsonl"),"utf8")).trim().split("\n").map(JSON.parse)
 assert.equal(events.filter(e=>e.status==="suspended").length,1)
})
test("concurrent recovery writers cannot redispatch an unchanged deterministic stop",async t=>{
 const f=await fixture(t,{noProgress:true});await f.approve("REVIEW: BLOCKED\nReviewed-SHA: "+f.head+"\n1. defect")
 assert.equal((await f.run("pr-loop",repo,"7","-","3")).code,2)
 const results=await Promise.all([f.run("pr-loop",repo,"7","-","3"),f.run("pr-loop",repo,"7","-","3")])
 assert.ok(results.every(r=>[2,75].includes(r.code)))
 assert.equal((await f.read()).calls.length,1)
})
test("CHANGES REQUESTED starts a repair round before re-review",async t=>{
 const f=await fixture(t,{noProgress:true});await f.approve(`CHANGES REQUESTED\nReviewed-SHA: ${f.head}\n1. fix defect`)
 const r=await f.run("pr-loop",repo,"7","-","1")
 assert.equal(r.code,2);assert.equal((await f.read()).calls.length,1)
 assert.match((await f.read()).calls[0].prompt,/resolve every numbered blocking finding/)
})
test("approved pending CI waits for the deadline without spending repair usage",async t=>{
 const f=await fixture(t,{}, {checksTimeoutMs:100});await f.approve()
 const s=await f.read();s.statusCheckRollup=[{status:"IN_PROGRESS",conclusion:null}]
 await fs.writeFile(f.env.FAKE_PR,JSON.stringify(s))
 const r=await f.run("pr-loop",repo,"7","-","1")
 assert.equal(r.code,142);assert.match(r.stdout,/READINESS-TIMEOUT/)
 assert.equal((await f.read()).calls.length,0);assert.equal((await f.read()).headRefOid,f.head)
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.stateDir,"usage.json"))),[])
})
for(const checks of [
 [{__typename:"StatusContext",state:"SUCCESS"}],
 [{__typename:"CheckRun",status:"COMPLETED",conclusion:"SUCCESS"},{__typename:"CheckRun",status:"COMPLETED",conclusion:"SKIPPED"},{__typename:"CheckRun",status:"COMPLETED",conclusion:"NEUTRAL"}]
]) test(`scan, loop and merge agree on accepted provider checks ${JSON.stringify(checks)}`,async t=>{
 const f=await fixture(t,{statusCheckRollup:checks});await f.approve()
 ok(await f.run("auto-enqueue","--once"))
 assert.equal(JSON.parse(await fs.readFile(path.join(f.stateDir,"queue.json"))).length,1)
 ok(await f.run("pr-loop",repo,"7","-","1"));assert.equal((await f.read()).calls.length,0)
 ok(await f.run("merge-one-core",repo,"7",f.head));assert.equal((await f.read()).state,"MERGED")
})
test("terminal StatusContext ERROR refuses merge immediately",async t=>{
 const f=await fixture(t,{}, {checksTimeoutMs:5000});await f.approve()
 const s=await f.read();s.statusCheckRollup=[{__typename:"StatusContext",state:"ERROR"}]
 await fs.writeFile(f.env.FAKE_PR,JSON.stringify(s))
 const r=await f.run("merge-one-core",repo,"7",f.head)
 assert.equal(r.code,3);assert.match(r.stderr,/NONGREEN/);assert.equal((await f.read()).state,"OPEN")
})
test("already merged state must prove its commit exists on main and delivers the source",async t=>{
 const f=await fixture(t,{state:"MERGED",mergeCommit:{oid:"a".repeat(40)}})
 const r=await f.run("merge-one-core",repo,"7",f.head)
 assert.notEqual(r.code,0);assert.match(r.stderr,/MERGE.*(MAIN|SOURCE|VERIFY)/)
 assert.equal((await f.read()).ghCalls.filter(merges).length,0)
})
test("per-PR budget stop survives invocations and loop stops",async t=>{
 const f=await fixture(t,{blockOnce:true},{limits:{runsPer24h:1,slots:1,timeoutMs:5000}})
 const r=await f.run("pr-loop",repo,"7","-","3");assert.equal(r.code,75);assert.match(r.stdout,/BUDGET-STOP/);assert.equal((await f.read()).calls.length,1)
 const again=await f.run("review-pr",repo,"7");assert.equal(again.code,75)
})
test("hard timeout kills a Codex that ignores SIGTERM and releases slot",async t=>{
 const f=await fixture(t,{hang:true},{limits:{runsPer24h:8,slots:1,timeoutMs:400}})
 const r=await f.run("review-pr",repo,"7");assert.equal(r.code,142);assert.match(r.stdout,/TIMEOUT/)
 const events=(await fs.readFile(path.join(f.stateDir,"delivery.jsonl"),"utf8")).trim().split("\n").map(JSON.parse)
 const execution=events.find(e=>e.phase==="execution")
 assert.equal(execution.code,142);assert.ok(execution.durationMs<650,"400ms execution budget includes process cleanup, separately from readiness/queue")
 ok(await f.run("codex-guard",repo,"7","review","/usr/bin/true")) // The same 400ms budget admits a healthy command after cleanup.
})
test("a reviewer commit is refused and its evidence worktree retained",async t=>{
 const f=await fixture(t,{reviewerCommit:true});const r=await f.run("review-pr",repo,"7")
 assert.notEqual(r.code,0);assert.match(r.stderr,/reviewer.*source/i)
 const s=await f.read();assert.equal(s.comments.length,0)
 assert.notEqual(git(s.calls[0].cwd,"rev-parse","HEAD"),f.head)
 assert.equal(await fs.readFile(path.join(s.calls[0].cwd,"feature.txt"),"utf8"),"prohibited")
})
test("a retained same-head review attempt never prevents a fresh attempt",async t=>{
 const f=await fixture(t), old=path.join(f.root,"worktrees",`review-7-${f.head}`)
 f.g("worktree","add","--detach",old,f.head)
 ok(await f.run("review-pr",repo,"7"))
 const s=await f.read();assert.notEqual(s.calls[0].cwd,old)
 assert.equal(git(old,"rev-parse","HEAD"),f.head)
})
for(const condition of ["red CI","conflict"]) test("approved PR with "+condition+" receives CI-fix and fresh review",async t=>{
 const f=await fixture(t,condition==="red CI"?{statusCheckRollup:[{status:"COMPLETED",conclusion:"FAILURE"}]}:{mergeable:"CONFLICTING",mergeStateStatus:"DIRTY"});await f.approve()
 ok(await f.run("pr-loop",repo,"7","-","3"));const s=await f.read();assert.match(s.calls[0].prompt,/CI-FIX/);assert.match(s.calls[1].prompt,/REVIEW MODE:/);assert.notEqual(s.headRefOid,f.head)
})
test("configured repository outside old case list merges",async t=>{
 const f=await fixture(t);await f.approve();ok(await f.run("merge-enqueue",repo,"7",f.head,"fixture"));ok(await f.run("merge-queue","--once"));assert.equal((await f.read()).state,"MERGED")
})
test("unknown repo rejected with a clear configuration message",async t=>{
 const f=await fixture(t);const r=await f.run("merge-one-core","fixture/missing","7",f.head);assert.equal(r.code,9);assert.match(r.stderr,/UNKNOWN REPO.*config/);assert.equal((await f.read()).ghCalls.length,0)
})
test("stale approval on moved head requires re-review and cannot merge",async t=>{
 const f=await fixture(t);await f.approve();f.g("checkout","topic");await fs.writeFile(path.join(f.checkout,"extra.txt"),"extra");f.g("add","extra.txt");f.g("commit","-qm","Extra");f.g("push","-q","origin","topic");f.g("checkout","main")
 const r=await f.run("merge-one-core",repo,"7",f.head);assert.equal(r.code,2);assert.match(r.stderr,/fresh review/)
 ok(await f.run("pr-loop",repo,"7","-","2"));assert.equal((await f.read()).calls.length,1)
})
test("a blocked comment quoting Reviewed-SHA is not independent approval",async t=>{
 const f=await fixture(t);await f.approve("REVIEW: BLOCKED\nReviewed-SHA: "+f.head+"\n1. broken")
 const r=await f.run("merge-one-core",repo,"7",f.head);assert.equal(r.code,4);assert.equal((await f.read()).state,"OPEN")
})
test("a builder formatted approval has no reviewer execution and cannot merge",async t=>{
 const f=await fixture(t),s=await f.read()
 s.comments.push({body:`APPROVE\nReviewed-SHA: ${f.head}\n\nLooks good`,author:{login:"builder"}})
 await fs.writeFile(f.env.FAKE_PR,JSON.stringify(s))
 const r=await f.run("merge-one-core",repo,"7",f.head)
 assert.equal(r.code,4);assert.equal((await f.read()).state,"OPEN")
 assert.equal((await f.read()).ghCalls.filter(merges).length,0)
})
test("independence comes from fresh execution even with a shared GitHub account",async t=>{
 const f=await fixture(t);await f.approve()
 const s=await f.read();s.comments[0].author={login:"builder"};await fs.writeFile(f.env.FAKE_PR,JSON.stringify(s))
 ok(await f.run("merge-one-core",repo,"7",f.head));assert.equal((await f.read()).state,"MERGED")
})
for(const artifact of ["prompt","output","receipt"]) test(`changed reviewer ${artifact} invalidates approval evidence`,async t=>{
 const f=await fixture(t);await f.approve()
 const id=/Factory-Review: ([0-9a-f-]+)/.exec((await f.read()).comments[0].body)[1]
 const receiptFile=path.join(f.stateDir,"reviews",`${id}.json`)
 const receipt=JSON.parse(await fs.readFile(receiptFile))
 if(artifact==="receipt") {receipt.pr=8;await fs.writeFile(receiptFile,JSON.stringify(receipt))}
 else await fs.appendFile(artifact==="prompt"?path.join(f.stateDir,"reviews",`${id}.prompt`):receipt.output,"changed")
 const r=await f.run("merge-one-core",repo,"7",f.head)
 assert.equal(r.code,4);assert.equal((await f.read()).state,"OPEN")
})
test("head moving during checks cannot merge",async t=>{
 const f=await fixture(t,{moveDuringChecks:true});await f.approve();const r=await f.run("merge-one-core",repo,"7",f.head);assert.equal(r.code,1);assert.equal((await f.read()).state,"OPEN")
})
test("automatic main merge invalidates the pre-integration review",async t=>{
 const f=await fixture(t);await f.approve();await fs.writeFile(path.join(f.checkout,"main-change.txt"),"main");f.g("add","main-change.txt");f.g("commit","-qm","Main advances");f.g("push","-q","origin","main")
 const r=await f.run("merge-one-core",repo,"7",f.head);assert.equal(r.code,2);assert.equal((await f.read()).state,"OPEN")
})

test("concurrent guard invocations cannot overspend a per-PR budget",async t=>{
 const f=await fixture(t,{}, {limits:{runsPer24h:1,slots:2,timeoutMs:5000}})
 const results=await Promise.all([f.run("codex-guard",repo,"7","fix",process.execPath,"-e","setTimeout(()=>{},250)"),f.run("codex-guard",repo,"7","review",process.execPath,"-e","setTimeout(()=>{},250)")])
 assert.deepEqual(results.map(r=>r.code).sort((a,b)=>a-b),[0,75])
 assert.equal(JSON.parse(await fs.readFile(path.join(f.stateDir,"usage.json"))).length,1)
})
test("global concurrency slot serializes different PR Codex jobs",async t=>{
 const f=await fixture(t,{}, {limits:{runsPer24h:8,slots:1,timeoutMs:5000}})
 const events=path.join(f.root,"events.jsonl")
 const cmd=`const fs=require('fs');fs.appendFileSync(${JSON.stringify(events)},JSON.stringify({at:Date.now(),event:'start'})+'\\n');setTimeout(()=>{fs.appendFileSync(${JSON.stringify(events)},JSON.stringify({at:Date.now(),event:'end'})+'\\n')},300)`
 const results=await Promise.all([f.run("codex-guard",repo,"7","fix",process.execPath,"-e",cmd),f.run("codex-guard",repo,"8","review",process.execPath,"-e",cmd)])
 results.forEach(ok);assert.deepEqual((await fs.readFile(events,"utf8")).trim().split("\n").map(l=>JSON.parse(l).event),["start","end","start","end"])
})
test("usage older than 24 hours expires and owner namespaces do not collide",async t=>{
 const f=await fixture(t,{}, {limits:{runsPer24h:1,slots:1,timeoutMs:5000}})
 await fs.mkdir(f.stateDir);await fs.writeFile(path.join(f.stateDir,"usage.json"),JSON.stringify([{repo,pr:7,kind:"fix",at:Date.now()-86400_001},{repo:"other/new-repository",pr:7,kind:"fix",at:Date.now()}]))
 ok(await f.run("codex-guard",repo,"7","review",process.execPath,"-e","process.exit(0)"))
})
test("controller death cannot orphan a guarded child or release its occupied slot",async t=>{
 const f=await fixture(t,{}, {limits:{runsPer24h:8,slots:1,timeoutMs:700}})
 const pidFile=path.join(f.root,"child.pid")
 const childCode=`require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`
 const controller=spawn(process.execPath,[cli,f.config,"codex-guard",repo,"7","fix",process.execPath,"-e",childCode],{env:f.env,stdio:"ignore"})
 t.after(()=>{try{controller.kill("SIGKILL")}catch{}})
 let pid
 const bootUntil=Date.now()+5000 // Readiness includes CLI/API/admission; execution still has its separate 700ms cap.
 for(;Date.now()<bootUntil;) {try{const observed=Number(await fs.readFile(pidFile,"utf8"));if(Number.isSafeInteger(observed)&&observed>0){pid=observed;break}}catch{} await new Promise(r=>setTimeout(r,10))}
 assert.ok(pid,"guarded child started")
 t.after(()=>{try{process.kill(-pid,"SIGKILL")}catch{}})
 const claims=path.join(f.stateDir,"locks","codex-slot-0.claims")
 const [claim]=await fs.readdir(claims)
 const binding=JSON.parse(await fs.readFile(path.join(claims,claim)))
 const group=Number(execFileSync('ps',['-o','pgid=','-p',String(pid)],{encoding:'utf8'}).trim())
 assert.equal(binding.job.groupPid,group,"lease is bound before the command can execute")
 t.after(()=>{try{process.kill(-group,"SIGKILL")}catch{}})
 assert.ok(binding.job.deadline>Date.now(),"lease records the independent deadline")
 controller.kill("SIGKILL")
 await new Promise(r=>setTimeout(r,950))
 const alive=()=>{try{process.kill(pid,0);return true}catch{return false}}
 assert.equal(alive(),false,"child is stopped even without controller timeout")
 const usage=await fs.readFile(path.join(f.stateDir,"usage.json"),"utf8")
 const retry=await f.run("codex-guard",repo,"7","fix",process.execPath,"-e",childCode)
 assert.equal(retry.code,130,"controller death retains uncertain mutation until readback")
 assert.equal(await fs.readFile(path.join(f.stateDir,"usage.json"),"utf8"),usage)
 ok(await f.run("codex-guard",repo,"8","review",process.execPath,"-e","process.exit(0)"))
})
test("transient GitHub error is requeued at most three times",async t=>{
 const f=await fixture(t,{apiFailure:true},{retryMs:0});await f.approve();ok(await f.run("merge-enqueue",repo,"7",f.head))
 for(let i=0;i<5;i++) ok(await f.run("merge-queue","--once"))
 const queue=JSON.parse(await fs.readFile(path.join(f.stateDir,"queue.json")))
 assert.equal(queue[0].attempts,4);assert.equal(queue[0].outcome.status,"fail");assert.equal((await f.read()).state,"OPEN")
})
test("same-head CI recovery queues a fresh bounded attempt and preserves the failed outcome",async t=>{
 const f=await fixture(t,{statusCheckRollup:[{status:"COMPLETED",conclusion:"FAILURE"}]});await f.approve()
 ok(await f.run("merge-enqueue",repo,"7",f.head));ok(await f.run("merge-queue","--once"))
 const before=JSON.parse(await fs.readFile(path.join(f.stateDir,"queue.json")));assert.equal(before[0].outcome.status,"fail")
 const s=await f.read();s.statusCheckRollup=[{status:"COMPLETED",conclusion:"SUCCESS"}];await fs.writeFile(f.env.FAKE_PR,JSON.stringify(s))
 ok(await f.run("auto-enqueue","--once"));ok(await f.run("auto-enqueue","--once"));ok(await f.run("merge-queue","--once"))
 const after=JSON.parse(await fs.readFile(path.join(f.stateDir,"queue.json")))
 assert.equal(after.length,2);assert.deepEqual(after[0],before[0]);assert.equal(after[1].outcome.status,"pass")
 assert.equal((await f.read()).state,"MERGED")
})
test("automatic same-head recovery is capped while preserving history",async t=>{
 const f=await fixture(t,{}, {queueRunsPer24h:1});await f.approve()
 ok(await f.run("merge-enqueue",repo,"7",f.head))
 const queueFile=path.join(f.stateDir,"queue.json"), queue=JSON.parse(await fs.readFile(queueFile))
 queue[0].outcome={status:"fail",data:{code:3,message:"NONGREEN"}};await fs.writeFile(queueFile,JSON.stringify(queue))
 ok(await f.run("auto-enqueue","--once"));assert.deepEqual(JSON.parse(await fs.readFile(queueFile)),queue)
})
test("a valid already merged PR is verified again without another merge",async t=>{
 const f=await fixture(t);await f.approve();ok(await f.run("merge-one-core",repo,"7",f.head))
 const first=await f.read()
 ok(await f.run("merge-one-core",repo,"7",f.head))
 const r=await f.run("pr-loop",repo,"7","-","1");ok(r);assert.match(r.stdout,/source verified/)
 const after=await f.read();assert.equal(after.ghCalls.filter(merges).length,1)
 assert.equal(after.calls.length,0);assert.equal(after.mergeCommit.oid,first.mergeCommit.oid)
})
test("red hosted checks refuse merge without a queue approval comment",async t=>{
 const f=await fixture(t,{statusCheckRollup:[{status:"COMPLETED",conclusion:"FAILURE"}]});await f.approve()
 const r=await f.run("merge-one-core",repo,"7",f.head);assert.equal(r.code,3);assert.equal((await f.read()).comments.length,1)
})
test("auto enqueue respects configured holds and deduplicates",async t=>{
 const f=await fixture(t,{}, {holds:[{repo,titlePattern:"Fixture",reason:"owner hold"}]});await f.approve()
 ok(await f.run("auto-enqueue","--once"));await assert.rejects(fs.readFile(path.join(f.stateDir,"queue.json")),{code:"ENOENT"})
 f.cfg.holds=[];await fs.writeFile(f.config,JSON.stringify(f.cfg));ok(await f.run("auto-enqueue","--once"));ok(await f.run("auto-enqueue","--once"))
 assert.equal(JSON.parse(await fs.readFile(path.join(f.stateDir,"queue.json"))).length,1)
})
test("auto enqueue reaches approved PRs beyond the first fifty results",async t=>{
 const f=await fixture(t,{listCount:51});await f.approve()
 ok(await f.run("auto-enqueue","--once"))
 const queue=JSON.parse(await fs.readFile(path.join(f.stateDir,"queue.json")))
 assert.equal(queue.length,1);assert.equal(queue[0].pr,7)
})
test("concurrent merge workers use a single serial owner",async t=>{
 const f=await fixture(t);await f.approve();ok(await f.run("merge-enqueue",repo,"7",f.head))
 const results=await Promise.all([f.run("merge-queue","--once"),f.run("merge-queue","--once")])
 assert.ok(results.some(r=>r.code===0));assert.ok(results.every(r=>[0,75].includes(r.code)),JSON.stringify(results));assert.equal((await f.read()).ghCalls.filter(merges).length,1)
})
test("duplicate PR loops allow only one fixer/reviewer",async t=>{
 const f=await fixture(t,{noProgress:true});await f.approve("REVIEW: BLOCKED\nReviewed-SHA: "+f.head+"\n1. defect")
 const results=await Promise.all([f.run("pr-loop",repo,"7","-"),f.run("pr-loop",repo,"7","-")]);assert.deepEqual(results.map(r=>r.code).sort((a,b)=>a-b),[2,75]);assert.equal((await f.read()).calls.length,1)
})
test("manual merge edits invalidate deterministic re-approval",async t=>{
 const f=await fixture(t);await f.approve();await fs.writeFile(path.join(f.checkout,"main-change.txt"),"main");f.g("add","main-change.txt");f.g("commit","-qm","Main advances");f.g("push","-q","origin","main")
 f.g("checkout","topic");f.g("merge","--no-commit","origin/main");await fs.writeFile(path.join(f.checkout,"extra.txt"),"hand edit");f.g("add","extra.txt");f.g("commit","-qm","Merge with edits");f.g("push","-q","origin","topic");f.g("checkout","main")
 const r=await f.run("merge-one-core",repo,"7",f.head);assert.equal(r.code,2);assert.match(r.stderr,/needs fresh review/);assert.equal((await f.read()).state,"OPEN")
})

test("read-only legacy import preserves pending FIFO entries and recent usage",async t=>{
 const f=await fixture(t,{}, {limits:{runsPer24h:1,slots:1,timeoutMs:5000}})
 const legacy=path.join(f.root,"legacy");await fs.mkdir(path.join(legacy,"budget"),{recursive:true})
 const queue=`${repo} 6 ${f.head} already consumed\n${repo} 7 ${f.head} pending note\n`
 await fs.writeFile(path.join(legacy,"merge-queue.txt"),queue);await fs.writeFile(path.join(legacy,"merge-queue.done"),queue.split("\n")[0]+"\n")
 const budget=`${Math.floor(Date.now()/1000)} review\n`;await fs.writeFile(path.join(legacy,"budget","new-repository-7.log"),budget)
 ok(await f.run("import-legacy",legacy));ok(await f.run("import-legacy",legacy))
 const entries=JSON.parse(await fs.readFile(path.join(f.stateDir,"queue.json")));assert.equal(entries.length,1);assert.equal(entries[0].pr,7)
 const r=await f.run("review-pr",repo,"7");assert.equal(r.code,75)
 assert.equal(await fs.readFile(path.join(legacy,"merge-queue.txt"),"utf8"),queue);assert.equal(await fs.readFile(path.join(legacy,"budget","new-repository-7.log"),"utf8"),budget)
})
for(const missing of ["root","merge-queue.txt","merge-queue.done","budget"]) test(`missing legacy ${missing} cannot report a successful import`,async t=>{
 const f=await fixture(t),legacy=path.join(f.root,"legacy")
 if(missing!=="root") {
  await fs.mkdir(legacy)
  for(const file of ["merge-queue.txt","merge-queue.done"]) if(file!==missing) await fs.writeFile(path.join(legacy,file),"")
  if(missing!=="budget") await fs.mkdir(path.join(legacy,"budget"))
 }
 const r=await f.run("import-legacy",legacy)
 assert.notEqual(r.code,0);assert.doesNotMatch(r.stdout,/IMPORTED/)
 await assert.rejects(fs.readFile(path.join(f.stateDir,"usage.json")),{code:"ENOENT"})
})
test("API errors on approved PR stop without spending a CI-fix run",async t=>{
 const f=await fixture(t,{apiFailure:true});await f.approve();const r=await f.run("pr-loop",repo,"7");assert.notEqual(r.code,0);assert.equal((await f.read()).calls.length,0)
})
test("missing required check cannot authorize enqueue or merge and spends no fixer",async t=>{
 const f=await fixture(t,{}, {checksTimeoutMs:80});await f.approve()
 const s=await f.read();s.statusCheckRollup=[{name:"unrelated",status:"COMPLETED",conclusion:"SUCCESS"}]
 await fs.writeFile(f.env.FAKE_PR,JSON.stringify(s))
 ok(await f.run("auto-enqueue","--once"))
 await assert.rejects(fs.readFile(path.join(f.stateDir,"queue.json")),{code:"ENOENT"})
 assert.notEqual((await f.run("merge-one-core",repo,"7",f.head)).code,0)
 assert.notEqual((await f.run("pr-loop",repo,"7","-","1")).code,0)
 assert.equal((await f.read()).calls.length,0)
})
test("app refusal replay: nine launches across deployed recovery writers preserve exit 75 and one wait",async t=>{
 const f=await fixture(t,{}, {limits:{runsPer24h:1,slots:1,timeoutMs:5000}})
 await fs.mkdir(f.stateDir,{recursive:true})
 await fs.writeFile(path.join(f.stateDir,"usage.json"),JSON.stringify([{repo,pr:7,kind:"review",at:Date.now()}]))
 assert.equal((await f.wrapper("pr-loop",repo,"7","-","3")).code,75)
 for(const name of ["review-pr","fix-pr","codex-guard","unstick","stall-watch","unstick","stall-watch","pr-loop"]) {
   const args=["unstick","stall-watch"].includes(name)?["--once"]:name==="codex-guard"?[repo,"7","review",process.execPath,"-e","process.exit(0)"]:[repo,"7","-","3"]
   assert.equal((await f.wrapper(name,...args)).code,75,name)
 }
 assert.equal((await f.read()).calls.length,0)
 const events=(await fs.readFile(path.join(f.stateDir,"delivery.jsonl"),"utf8")).trim().split("\n").map(JSON.parse)
 assert.equal(events.filter(e=>e.status==="suspended").length,1)
 assert.equal(events.filter(e=>e.status==="started").length,0)
 const wait=JSON.parse(await fs.readFile(path.join(f.stateDir,"waits",encodeURIComponent(repo)+"-7.json")))
 assert.equal(wait.cause,"budget-exhausted");assert.ok(wait.resetAt>Date.now())
 await fs.writeFile(path.join(f.stateDir,"usage.json"),"[]")
 const results=await Promise.all([f.wrapper("unstick","--once"),f.wrapper("stall-watch","--once")])
 assert.ok(results.some(r=>r.code===0),JSON.stringify(results))
 assert.equal((await f.read()).calls.length,1,"budget reopening permits exactly one review")
})
test("named actionable dependency and new head each allow one start after no progress",async t=>{
 const f=await fixture(t,{noProgress:true});await f.approve("REVIEW: BLOCKED\nReviewed-SHA: "+f.head+"\n1. defect")
 assert.equal((await f.wrapper("pr-loop",repo,"7","-","3")).code,2)
 f.cfg.repos[repo].dependencyRevision="tested-contract-revision-two";await fs.writeFile(f.config,JSON.stringify(f.cfg))
 assert.equal((await f.wrapper("unstick","--once")).code,2)
 assert.equal((await f.wrapper("stall-watch","--once")).code,2)
 assert.equal((await f.read()).calls.length,2)
 const wt=path.join(f.root,"worktrees","fix-7")
 await fs.writeFile(path.join(wt,"feature.txt"),"changed\n")
 for(const args of [["add","feature.txt"],["commit","-qm","New actionable head"],["push","-q","origin","topic"]]) execFileSync("git",args,{cwd:wt,env:f.env,stdio:"ignore"})
 ok(await f.wrapper("unstick","--once"))
 ok(await f.wrapper("stall-watch","--once"))
 assert.equal((await f.read()).calls.length,3,"stale blocking evidence starts only a fresh review")
})
for(const code of [75,17]) test(`deployed review and fix wrappers preserve child exit ${code}`,async t=>{
 const f=await fixture(t,{childCode:code})
 assert.equal((await f.wrapper("review-pr",repo,"7")).code,code)
 // Give the separate fix a new declared dependency after the explicit refusal.
 f.cfg.repos[repo].dependencyRevision="fix-input";await fs.writeFile(f.config,JSON.stringify(f.cfg))
 assert.equal((await f.wrapper("fix-pr",repo,"7","-")).code,code)
})
for(const fault of ["", "{}", "{", "null", "refusal", "exception"])
 test(`REST terminal result ${JSON.stringify(fault)} never authorizes or dispatches`,async t=>{
  const f=await fixture(t);const s=await f.read();s.restFault=fault||" ";await fs.writeFile(f.env.FAKE_PR,JSON.stringify(s))
  assert.notEqual((await f.run("pr-loop",repo,"7","-","1")).code,0)
  assert.equal((await f.read()).calls.length,0)
  assert.equal((await f.read()).ghCalls.length,1,"permanent or malformed input has no blind retry")
 })
test("subprocess and provider canaries do not reach persisted wait/events or CLI errors",async t=>{
 const canary='synthetic-client-canary https://user:secret-canary@example.invalid/?token=secret-canary\\ncredential=secret-canary'
 const f=await fixture(t,{childCode:75,childError:canary})
 const result=await f.wrapper("review-pr",repo,"7")
 assert.equal(result.code,75)
 assert.ok(!JSON.stringify(result).includes("secret-canary"))
 const events=await fs.readFile(path.join(f.stateDir,"delivery.jsonl"),"utf8")
 const wait=await fs.readFile(path.join(f.stateDir,"waits",encodeURIComponent(repo)+"-7.json"),"utf8")
 for(const bytes of [events,wait]) { assert.ok(!bytes.includes("secret-canary"));assert.ok(!bytes.includes("synthetic-client-canary")) }
 const s=await f.read();s.restFault=JSON.stringify({identity:{client:canary},token:canary});await fs.writeFile(f.env.FAKE_PR,JSON.stringify(s))
 const failure=await f.run("pr-loop",repo,"7","-","1")
 assert.notEqual(failure.code,0);assert.ok(!JSON.stringify(failure).includes("secret-canary"))
 assert.ok(!(await fs.readFile(path.join(f.stateDir,"delivery.jsonl"),"utf8")).includes("secret-canary"))
})
test("close/reopen preserves unchanged refusal; recovery completion retires waits and disposes claims",async t=>{
 const f=await fixture(t,{noProgress:true});await f.approve(`REVIEW: BLOCKED\nReviewed-SHA: ${f.head}\n1. defect`)
 assert.equal((await f.run("pr-loop",repo,"7","-","1")).code,2)
 const file=f.env.FAKE_PR,s=await f.read();s.state="CLOSED";await fs.writeFile(file,JSON.stringify(s))
 assert.equal((await f.wrapper("unstick","--once")).code,8)
 s.state="OPEN";await fs.writeFile(file,JSON.stringify(s))
 assert.equal((await f.wrapper("stall-watch","--once")).code,2)
 assert.equal((await f.read()).calls.length,1)
 f.cfg.repos[repo].dependencyRevision="repaired-actionable-input";await fs.writeFile(f.config,JSON.stringify(f.cfg))
 s.noProgress=false;await fs.writeFile(file,JSON.stringify(s))
 ok(await f.wrapper("unstick","--once"))
 const wait=JSON.parse(await fs.readFile(path.join(f.stateDir,"waits",encodeURIComponent(repo)+"-7.json")))
 assert.equal(wait.status,"complete")
 const count=(await f.read()).calls.length;ok(await f.wrapper("stall-watch","--once"));assert.equal((await f.read()).calls.length,count)
 for(const dir of await fs.readdir(path.join(f.stateDir,"locks")))
   if(dir.endsWith(".claims")) assert.deepEqual(await fs.readdir(path.join(f.stateDir,"locks",dir)),[],"claims disposed")
})
test("current cancelled CI is refused by loop/review/scan/merge without fixer dispatch",async t=>{
 const f=await fixture(t);await f.approve()
 const s=await f.read();s.statusCheckRollup=[{status:"COMPLETED",conclusion:"CANCELLED"}];await fs.writeFile(f.env.FAKE_PR,JSON.stringify(s))
 for(const name of ["pr-loop","review-pr","merge-one-core"]) assert.equal((await f.wrapper(name,repo,"7",name==="merge-one-core"?f.head:"-","1")).code,3)
 ok(await f.wrapper("auto-enqueue","--once"))
 await assert.rejects(fs.readFile(path.join(f.stateDir,"queue.json")),{code:"ENOENT"})
 assert.equal((await f.read()).calls.length,0)
 assert.ok((await f.read()).ghCalls.every(a=>a[0]==="api"),"new reads never call GraphQL")
})
test("provider-unknown mergeability cannot send a green approved head to a code fixer",async t=>{
 const f=await fixture(t);await f.approve()
 const s=await f.read();s.mergeable="UNKNOWN";await fs.writeFile(f.env.FAKE_PR,JSON.stringify(s))
 assert.equal((await f.run("pr-loop",repo,"7","-","1")).code,75)
 assert.equal((await f.read()).calls.length,0)
})
test("obsolete A/B cancellation is superseded for all callers while current C passes",async t=>{
 const f=await fixture(t);await f.approve()
 const s=await f.read(),A="a".repeat(40),B="b".repeat(40)
 s.checkRuns=[A,B,f.head].map((head,i)=>({id:i+1,name:"test",head_sha:head,app:{id:15368},status:"completed",conclusion:i===2?"success":"cancelled"}))
 await fs.writeFile(f.env.FAKE_PR,JSON.stringify(s))
 for(const head of [A,B]) {const r=await f.run("readiness",repo,"7",head);ok(r);assert.equal(JSON.parse(r.stdout).state,"superseded")}
 ok(await f.wrapper("pr-loop",repo,"7","-","1"));ok(await f.wrapper("auto-enqueue","--once"))
 assert.equal((await f.read()).calls.length,0)
 assert.equal(JSON.parse(await fs.readFile(path.join(f.stateDir,"queue.json")))[0].head,f.head)
})
for(const [code,quotaEvidence,retries] of [[401,false,1],[403,false,1],[403,true,3],[429,false,3],[502,false,3]])
 test(`REST ${code} quota=${quotaEvidence} distinguishes bounded transient reads from refusal`,async t=>{
   const f=await fixture(t,{restCodes:Array(5).fill(code),quotaEvidence})
   assert.notEqual((await f.run("readiness",repo,"7")).code,0)
   assert.equal((await f.read()).ghCalls.length,retries)
   assert.equal((await f.read()).calls.length,0)
 })
test("transient read recovery resumes the observation without a duplicate model phase",async t=>{
 const f=await fixture(t,{restCodes:[502,429]})
 const r=await f.run("readiness",repo,"7");ok(r);assert.equal(JSON.parse(r.stdout).state,"success")
 assert.equal((await f.read()).calls.length,0)
})
test("deployed guard keeps the existing rescope caller in the shared budget",async t=>{
 const f=await fixture(t,{}, {limits:{runsPer24h:1,slots:1,timeoutMs:5000}})
 ok(await f.wrapper("codex-guard",repo,"7","rescope",process.execPath,"-e","process.exit(0)"))
 assert.equal((await f.wrapper("codex-guard",repo,"7","review",process.execPath,"-e","process.exit(0)")).code,75)
 assert.equal(JSON.parse(await fs.readFile(path.join(f.stateDir,"usage.json")))[0].kind,"rescope")
})
test("an unapproved pending head keeps the bounded CI wait before any review dispatch",async t=>{
 const f=await fixture(t,{statusCheckRollup:[{status:"IN_PROGRESS",conclusion:null}]},{checksTimeoutMs:80})
 const r=await f.run("pr-loop",repo,"7","-","1")
 assert.equal(r.code,142,"pending work reaches its existing CI deadline instead of silently dropping the review")
 assert.equal((await f.read()).calls.length,0)
})

for(const [status,conclusion] of [["success",null],["failure",null],["in_progress","success"],["completed","pending"]])
 test(`malformed CheckRun ${status}/${conclusion} cannot enqueue or dispatch`,async t=>{
  const f=await fixture(t);await f.approve()
  const s=await f.read();s.checkRuns=[{id:1,name:"test",head_sha:f.head,app:{id:15368},status,conclusion}]
  await fs.writeFile(f.env.FAKE_PR,JSON.stringify(s))
  assert.notEqual((await f.run("auto-enqueue","--once")).code,0)
  await assert.rejects(fs.readFile(path.join(f.stateDir,"queue.json")),{code:"ENOENT"})
  assert.notEqual((await f.run("pr-loop",repo,"7","-","1")).code,0)
  assert.equal((await f.read()).calls.length,0)
 })

test("slot timeout resumes the identical guard when the occupied slot is released",async t=>{
 const f=await fixture(t,{}, {limits:{runsPer24h:8,slots:1,timeoutMs:500}})
 const release=await acquireLease(path.join(f.stateDir,"locks"),"codex-slot-0")
 const marker=path.join(f.root,"guard-started")
 const args=["codex-guard",repo,"7","fix",process.execPath,"-e",`require('fs').writeFileSync(${JSON.stringify(marker)},'started')`]
 try {
  assert.equal((await f.run(...args)).code,75)
  const wait=JSON.parse(await fs.readFile(path.join(f.stateDir,"waits",encodeURIComponent(repo)+"-7.json")))
  assert.equal(wait.cause,"slot-wait")
  const stillOccupied=await f.run(...args)
  assert.equal(stillOccupied.code,75,JSON.stringify(stillOccupied))
  const events=(await fs.readFile(path.join(f.stateDir,"delivery.jsonl"),"utf8")).trim().split("\n").map(JSON.parse)
  assert.equal(events.filter(e=>e.status==="suspended").length,1,"repeated slot shortage retains one wait event")
 } finally {await release()}
 ok(await f.run(...args))
 assert.equal(await fs.readFile(marker,"utf8"),"started")
 assert.equal(JSON.parse(await fs.readFile(path.join(f.stateDir,"usage.json"))).length,1)
})

for(const cause of ["source-no-progress","rounds-exhausted"])
 test(`budget-only configuration changes do not reopen ${cause}`,async t=>{
  const f=await fixture(t,{noProgress:true})
  if(cause==="source-no-progress") await f.approve(`REVIEW: BLOCKED\nReviewed-SHA: ${f.head}\n1. defect`)
  else {const s=await f.read();s.blockOnce=true;await fs.writeFile(f.env.FAKE_PR,JSON.stringify(s))}
  const code=cause==="source-no-progress"?2:1
  assert.equal((await f.run("pr-loop",repo,"7","-","1")).code,code)
  f.cfg.limits.runsPer24h=9;await fs.writeFile(f.config,JSON.stringify(f.cfg))
  assert.equal((await f.run("recover","--once")).code,code)
  assert.equal((await f.read()).calls.length,1,"unchanged actionable input starts no second child")
 })

for(const action of ["fix-pr","ci-fix"])
 test(`standalone ${action} shares the no-progress suspension with loop and recovery`,async t=>{
  const f=await fixture(t,{noProgress:true});await f.approve(`REVIEW: BLOCKED\nReviewed-SHA: ${f.head}\n1. defect`)
  for(let i=0;i<2;i++) {
   const r=await f.wrapper(action,repo,"7","-","--no-loop")
   assert.equal(r.code,2);assert.match(r.stdout,/NO-PROGRESS/)
  }
  assert.equal((await f.run("pr-loop",repo,"7","-","1")).code,2)
  assert.equal((await f.run("recover","--once")).code,2)
  assert.equal((await f.read()).calls.length,1)
  const wait=JSON.parse(await fs.readFile(path.join(f.stateDir,"waits",encodeURIComponent(repo)+"-7.json")))
  assert.equal(wait.cause,"source-no-progress")
 })

test("REST multi-page scans accept large PR bodies, comments and check output",async t=>{
 const f=await fixture(t,{listCount:101,listBodyBytes:60000});await f.approve()
 const s=await f.read()
 s.comments.unshift(...Array.from({length:26},()=>({body:"x".repeat(60000)})))
 s.checkRuns=Array.from({length:26},(_,i)=>({id:i+1,name:i?"optional-"+i:"test",head_sha:f.head,
   app:{id:15368},status:"completed",conclusion:"success",output:{text:"x".repeat(60000)}}))
 await fs.writeFile(f.env.FAKE_PR,JSON.stringify(s))
 ok(await f.run("auto-enqueue","--once"))
 const queue=JSON.parse(await fs.readFile(path.join(f.stateDir,"queue.json")))
 assert.equal(queue.length,1);assert.equal(queue[0].pr,7)
 const calls=(await f.read()).ghCalls.map(a=>a[1])
 for(const route of ["/pulls?","/comments?","/check-runs?"])
  assert.ok(calls.some(r=>r.includes(route)&&r.includes("page=2")),`second page read: ${route}`)
})

for(const order of ["failure-first","failure-last","all-success"])
 test(`recovery batch retains outcome: ${order}`,async t=>{
  const f=await fixture(t,{}, {limits:{runsPer24h:1,slots:1,timeoutMs:5000}});await f.approve()
  const other=order==="failure-first"?6:8
  if(order==="all-success") await f.approve(undefined,other)
  await fs.mkdir(path.join(f.stateDir,"waits"),{recursive:true})
  // Seed resumable work as persisted recovery would, keeping source and approval real.
  for(const pr of [7,other]) await fs.writeFile(path.join(f.stateDir,"waits",encodeURIComponent(repo)+`-${pr}.json`),
   JSON.stringify({schema:"factory-delivery-wait/v1",status:"resumable",repo,pr}))
  if(order!=="all-success") await fs.writeFile(path.join(f.stateDir,"usage.json"),JSON.stringify([{repo,pr:other,kind:"review",at:Date.now()}]))
  const r=await f.run("recover","--once")
  assert.equal(r.code,order==="all-success"?0:75,JSON.stringify(r))
  assert.match(r.stdout,/APPROVED/)
  if(order!=="all-success") assert.match(r.stdout,/BUDGET-STOP/)
  assert.equal((await f.read()).calls.length,0)
 })

for (const apiHang of ['fetch', 'body', 'drip']) test(`readiness bounds never-settling ${apiHang} within one API/attempt budget`, async t => {
 const f=await fixture(t,{apiHang},{commandTimeoutMs:5000,apiTimeoutMs:1000,attemptTimeoutMs:1800})
 const adapter=createPrDeliveryAdapter(await loadDeliveryConfig(f.config),{env:f.env})
 const start=Date.now(), result=await adapter.execute('review',{repo,pr:7}), r={...result.data,code:result.data.code}
 assert.equal(r.code,142,JSON.stringify(r))
 assert.ok(Date.now()-start<2000,'API retries must not renew the budget')
 assert.equal((await f.read()).calls.length,0)
 assert.equal((await f.read()).ghCalls.length,1,'a deadline is terminal for this observation')
})
test('forever-pending readiness bounds probes and long pacing without paid dispatch',async t=>{
 const f=await fixture(t,{statusCheckRollup:[{status:'IN_PROGRESS',conclusion:null}]},
 {checksTimeoutMs:1000,pollMs:10000,attemptTimeoutMs:2500})
 const adapter=createPrDeliveryAdapter(await loadDeliveryConfig(f.config),{env:f.env})
 const start=Date.now(),result=await adapter.execute('review',{repo,pr:7}),r=result.data
 assert.equal(r.code,142,JSON.stringify(r));assert.ok(Date.now()-start<2500)
 assert.equal((await f.read()).calls.length,0)
})
test('ready-now performs no initial pacing sleep',async t=>{
 const f=await fixture(t,{}, {pollMs:10000,checksTimeoutMs:15000})
 const adapter=createPrDeliveryAdapter(await loadDeliveryConfig(f.config),{env:f.env})
 const start=Date.now(),result=await adapter.execute('pr:inspect',{repo,pr:7});assert.equal(result.status,'pass',JSON.stringify(result))
 assert.ok(Date.now()-start<10000,'no fixed initial pacing sleep')
})

test('interrupted source mutation is uncertain and unchanged input cannot redispatch it',async t=>{
 const f=await fixture(t,{}, {limits:{runsPer24h:8,slots:1,timeoutMs:700}})
 const argv=[process.execPath,'-e',"require('fs').writeFileSync('effect.txt','committed');process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"]
 const result=await f.run('codex-guard',repo,'7','fix',...argv)
 assert.equal(result.code,142,JSON.stringify(result))
 assert.equal(await fs.readFile(path.join(f.checkout,'effect.txt'),'utf8'),'committed')
 const wait=JSON.parse(await fs.readFile(path.join(f.stateDir,'waits',`${encodeURIComponent(repo)}-7.json`)))
 assert.equal(wait.cause,'mutation-uncertain')
 const usage=await fs.readFile(path.join(f.stateDir,'usage.json'),'utf8')
 const again=await f.run('codex-guard',repo,'7','fix',...argv)
 assert.notEqual(again.code,0);assert.equal(await fs.readFile(path.join(f.stateDir,'usage.json'),'utf8'),usage)
})

test('browser concurrency 1/2 uses the same immutable fixture and bounded child load',async t=>{
 const f=await fixture(t,{}, {resources:{capacity:32,browserConcurrency:2,agentUnits:1}})
 const files=[]
 for(let i=0;i<4;i++) {
  const file=path.join(f.checkout,`browser-${i}.test.mjs`);files.push(file)
  await fs.writeFile(file,`import fs from 'node:fs';import test from 'node:test';test('fixed-load',async()=>{fs.appendFileSync(process.env.TRACE,JSON.stringify({kind:'start',pid:process.pid})+'\\n');await new Promise(r=>setTimeout(r,120));fs.appendFileSync(process.env.TRACE,JSON.stringify({kind:'end',pid:process.pid})+'\\n')});`)
 }
 const measurements=[]
 for(const workers of [1,2]) {
  const trace=path.join(f.root,`trace-${workers}`),start=Date.now()
  const result=await new Promise((resolve,reject)=>{
   const child=spawn('sh',[fileURLToPath(new URL('../deploy/orch/test-browser.sh',import.meta.url)),repo,...files],
    {env:{...f.env,TRACE:trace,FACTORY_ROOT:fileURLToPath(new URL("../",import.meta.url)),FACTORY_PR_CONFIG:f.config,FACTORY_BROWSER_CONCURRENCY:String(workers)},stdio:['ignore','pipe','pipe']})
   let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b)
   child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}))
  });ok(result);assert.match(result.stdout,/(?:pass 4|# pass 4)/)
  const rows=(await fs.readFile(trace,'utf8')).trim().split('\n').map(JSON.parse)
  const active=new Set();let peak=0
  for(const row of rows){if(row.kind==='start')active.add(row.pid);else active.delete(row.pid);peak=Math.max(peak,active.size)}
  assert.equal(rows.filter(r=>r.kind==='end').length,4);assert.equal(active.size,0);assert.ok(peak<=workers)
  measurements.push({workers,tests:4,failures:0,peak,durationMs:Date.now()-start})
 }
 t.diagnostic(JSON.stringify(measurements))
})

test('browser wrapper does not forward private test diagnostics',async t=>{
 const f=await fixture(t),file=path.join(f.checkout,'private-browser.test.mjs'),canary='CANARY_PRIVATE_BROWSER_CLIENT_SECRET'
 await fs.writeFile(file,`import test from 'node:test';test(${JSON.stringify(canary)},()=>{console.error(${JSON.stringify(canary)});throw Error(${JSON.stringify(canary)})})`)
 const result=await f.wrapper('test-browser',repo,file)
 assert.notEqual(result.code,0)
 assert.equal((result.stdout+result.stderr).includes(canary),false)
 const locks=path.join(f.stateDir,'locks')
 for(const name of await fs.readdir(locks)) assert.deepEqual(await fs.readdir(path.join(locks,name)),[])
})

test('browser wrapper refuses zero acknowledged results even when Node exits zero',async t=>{
 const f=await fixture(t),file=path.join(f.checkout,'skipped-browser.test.mjs')
 await fs.writeFile(file,"import test from 'node:test';test.skip('synthetic skipped case',()=>{})")
 const result=await f.wrapper('test-browser',repo,file)
 assert.equal(result.code,1);assert.doesNotMatch(result.stdout,/pass /)
})

test('subprocess error canaries do not reach persisted delivery/wait bytes',async t=>{
 const f=await fixture(t,{childCode:42,childError:'CANARY_PRIVATE_TOKEN CANARY_PRIVATE_CLIENT'})
 const result=await f.run('codex-guard',repo,'7','fix','codex','-')
 assert.equal(result.code,42,JSON.stringify(result))
 const bytes=await fs.readFile(path.join(f.stateDir,'delivery.jsonl'),'utf8')
 assert.doesNotMatch(bytes,/CANARY_PRIVATE/);assert.doesNotMatch(result.stderr,/CANARY_PRIVATE/)
})

for(const resources of [{browserConcurrency:1},{capacity:0},{capacity:1,agentUnits:1,browserConcurrency:1},
 {capacity:2,agentUnits:1,browserConcurrency:0}]) test(`invalid resource capacity ${JSON.stringify(resources)} refuses before admission`,async t=>{
 const f=await fixture(t,{}, {resources})
 await assert.rejects(loadDeliveryConfig(f.config),{code:9})
 assert.equal((await f.read()).calls.length,0)
})

const advanceMain = async (f, file = "producer-contract.txt") => {
 await fs.writeFile(path.join(f.checkout,file),"changed contract\n")
 f.g("add",file); f.g("commit","-qm","Producer contract advances"); f.g("push","-q","origin","main")
}
const queueOf = async f => JSON.parse(await fs.readFile(path.join(f.stateDir,"queue.json")))
const remoteTopic = f => git(f.root,"--git-dir",f.remote,"rev-parse","refs/heads/topic")

test("different-file interaction is integrated before fresh exact-tree review", async t => {
 const f=await fixture(t); await f.approve(); await advanceMain(f)
 const r=await f.run("merge-one-core",repo,"7",f.head)
 assert.equal(r.code,2,JSON.stringify(r)); assert.match(r.stderr,/needs fresh review/)
 const s=await f.read(); assert.equal(s.state,"OPEN"); assert.notEqual(s.headRefOid,f.head)
 assert.ok(!s.ghCalls.some(merges))
 await f.approve(); const integrated=(await f.read()).headRefOid
 ok(await f.run("merge-one-core",repo,"7",integrated)); assert.equal((await f.read()).state,"MERGED")
})

test("late main update during delivery evidence cannot deliver an unreviewed tree", async t => {
 const f=await fixture(t,{advanceMainOnComment:true}); await f.approve()
 const r=await f.run("merge-one-core",repo,"7",f.head)
 assert.equal(r.code,2,JSON.stringify(r)); assert.match(r.stderr,/needs fresh review/)
 const s=await f.read(); assert.equal(s.state,"OPEN"); assert.equal(s.mergeCommit,undefined)
 assert.ok(!git(f.root,"--git-dir",f.remote,"ls-tree","-r","--name-only","refs/heads/main").includes("feature.txt"))
})

for(const [label,state] of [["no strict rule",{rules:[]}],["non-strict rule",{rules:[{type:"required_status_checks",ruleset_id:1,parameters:{strict_required_status_checks_policy:false}}]}],
  ["bypassable ruleset",{ruleset:{id:1,enforcement:"active",current_user_can_bypass:"always"}}],["evaluate-only ruleset",{ruleset:{id:1,enforcement:"evaluate",current_user_can_bypass:"never"}}]])
 test(`merge refuses without a server-enforced up-to-date base: ${label}`, async t => {
  const f=await fixture(t,state); await f.approve()
  const r=await f.run("merge-one-core",repo,"7",f.head)
  assert.equal(r.code,9,JSON.stringify(r)); assert.match(r.stderr,/NOT SERVER-ENFORCED/)
  const s=await f.read(); assert.equal(s.state,"OPEN"); assert.ok(s.ghCalls.every(a=>!a.includes("-X")),"no evidence comment or merge")
 })

test("merged delivery is validated against the saved integration base", async t => {
 const f=await fixture(t,{missingAck:true}); await f.approve()
 assert.equal((await f.run("merge-one-core",repo,"7",f.head)).code,7)
 const [name]=await fs.readdir(path.join(f.stateDir,"integrations")), file=path.join(f.stateDir,"integrations",name)
 const record=JSON.parse(await fs.readFile(file)); record.base=f.head; await fs.writeFile(file,JSON.stringify(record))
 const r=await f.run("merge-one-core",repo,"7",f.head)
 assert.equal(r.code,7); assert.match(r.stderr,/MERGE BASE VERIFY/)
})

for(const mode of ["direct","queued"]) test(`${mode} controller death keeps both leases until its update job is gone`, async t => {
 const f=await fixture(t); await f.approve(); await advanceMain(f)
 const marker=path.join(f.root,"write-started"), s=await f.read()
 s.pauseWrite="update-branch"; s.pauseMarker=marker; await fs.writeFile(f.env.FAKE_PR,JSON.stringify(s))
 if(mode==="queued") ok(await f.run("merge-enqueue",repo,"7",f.head))
 const controller=spawn(process.execPath,[cli,f.config,...(mode==="direct"?["merge-one-core",repo,"7",f.head]:["merge-queue",repo,"--once"])],{env:f.env,stdio:"ignore"})
 t.after(()=>{try{controller.kill("SIGKILL")}catch{}})
 let writer
 for(let i=0;i<500 && !writer;i++) {try{writer=Number(await fs.readFile(marker,"utf8"))}catch{} await pause(10)}
 assert.ok(writer,"update write started")
 const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}}
 controller.kill("SIGKILL")
 const locks=path.join(f.stateDir,"locks")
 let lane, prLease
 for(let i=0;i<800;i++) {
  lane=await acquireLease(locks,`merge-${encodeURIComponent(repo)}`)
  prLease=lane && await acquireLease(locks,`pr-${keyFor(repo,7)}`)
  if(prLease) break
  if(lane) await lane()
  lane=null; await pause(10)
 }
 assert.ok(lane && prLease,"successor eventually owns both leases")
 assert.equal(alive(writer),false,"successor never owns a lease while the old write runs")
 await pause(3500)
 assert.equal(remoteTopic(f),f.head,"the interrupted write never lands under the successor")
 await prLease(); await lane()
 const r=await f.run("merge-one-core",repo,"7",f.head)
 assert.equal(r.code,2,JSON.stringify(r)); assert.notEqual(remoteTopic(f),f.head)
})

for(const fault of [502,429,"no-response"]) test(`transient update-branch ${fault} keeps the bounded queue retry`, async t => {
 const f=await fixture(t,{writeFaults:{"update-branch":[fault]}}); await f.approve(); await advanceMain(f)
 ok(await f.run("merge-enqueue",repo,"7",f.head)); ok(await f.run("merge-queue",repo,"--once"))
 const [entry]=await queueOf(f)
 assert.equal(entry.attempts,1); assert.equal(entry.outcome,undefined,JSON.stringify(entry)); assert.equal(remoteTopic(f),f.head)
 ok(await f.run("merge-queue",repo,"--once"))
 const [done]=await queueOf(f)
 assert.equal(done.outcome.data.code,2); assert.match(done.outcome.data.message,/fresh review/); assert.notEqual(remoteTopic(f),f.head)
})

test("an update applied behind a lost response is read back, not retried or called a conflict", async t => {
 const f=await fixture(t,{loseUpdateResponse:true}); await f.approve(); await advanceMain(f)
 ok(await f.run("merge-enqueue",repo,"7",f.head)); ok(await f.run("merge-queue",repo,"--once"))
 const [entry]=await queueOf(f)
 assert.equal(entry.outcome.data.code,2); assert.equal(entry.outcome.data.transient,false); assert.notEqual(remoteTopic(f),f.head)
 assert.equal((await f.read()).ghCalls.filter(a=>a.some(v=>v.endsWith("/update-branch"))).length,1)
})

test("queue mutation respects the same PR writer lease as a fixer", async t => {
 const f=await fixture(t); await f.approve(); ok(await f.run("merge-enqueue",repo,"7",f.head))
 const release=await acquireLease(path.join(f.stateDir,"locks"),`pr-${keyFor(repo,7)}`)
 assert.ok(release)
 try {
  const r=await f.run("merge-queue",repo,"--once"); assert.equal(r.code,75,JSON.stringify(r))
  assert.equal((await f.read()).state,"OPEN"); assert.equal((await queueOf(f))[0].attempts,0)
 } finally { await release() }
 ok(await f.run("merge-queue",repo,"--once")); assert.equal((await f.read()).state,"MERGED")
})

test("a held CARR-style integration lane does not starve another repo", async t => {
 const a=await fixture(t), b=await fixture(t), second="fixture/independent"
 b.cfg.repos={[second]:b.cfg.repos[repo]}; b.cfg.stateDir=a.stateDir
 await fs.writeFile(b.config,JSON.stringify(b.cfg))
 await a.approve(); ok(await b.run("review-pr",second,"7"))
 ok(await a.run("merge-enqueue",repo,"7",a.head)); ok(await b.run("merge-enqueue",second,"7",b.head))
 const release=await acquireLease(path.join(a.stateDir,"locks"),`merge-${encodeURIComponent(repo)}`)
 assert.ok(release)
 try {
  assert.equal((await a.run("merge-queue",repo,"--once")).code,75)
  ok(await b.run("merge-queue",second,"--once")); assert.equal((await b.read()).state,"MERGED")
  assert.equal((await a.read()).state,"OPEN")
 } finally { await release() }
 ok(await a.run("merge-queue",repo,"--once")); assert.equal((await a.read()).state,"MERGED")
})

test("a real overlapping-file update conflict refuses before final evidence", async t => {
 const f=await fixture(t); await f.approve(); await advanceMain(f,"feature.txt")
 const r=await f.run("merge-one-core",repo,"7",f.head)
 assert.equal(r.code,5); assert.match(r.stderr,/UPDATE-BRANCH FAILED/)
 const s=await f.read(); assert.equal(s.state,"OPEN"); assert.ok(!s.ghCalls.some(merges))
})

test("empty merge acknowledgement is reconciled without repeating the effect", async t => {
 const f=await fixture(t,{missingAck:true}); await f.approve()
 const first=await f.run("merge-one-core",repo,"7",f.head)
 assert.equal(first.code,7); assert.match(first.stderr,/acknowledgement missing/)
 assert.equal((await f.read()).state,"MERGED")
 ok(await f.run("merge-one-core",repo,"7",f.head))
 assert.equal((await f.read()).ghCalls.filter(merges).length,1)
})

test("malformed integration read cannot persist provider canary bytes", async t => {
 const f=await fixture(t,{restFault:"private-canary-123 invalid REST"})
 const r=await f.run("merge-one-core",repo,"7",f.head)
 assert.equal(r.code,1); assert.match(r.stderr,/invalid GitHub REST JSON/)
 assert.ok(!JSON.stringify(r).includes("private-canary-123"))
 assert.ok(!(await fs.readFile(path.join(f.stateDir,"delivery.jsonl"),"utf8")).includes("private-canary-123"))
 assert.equal((await f.read()).state,"OPEN")
})

test("a draft integration candidate stays refused without readiness mutation", async t => {
 const f=await fixture(t,{isDraft:true}); await f.approve()
 const r=await f.run("merge-one-core",repo,"7",f.head)
 assert.equal(r.code,8); assert.match(r.stderr,/DRAFT/)
 const s=await f.read(); assert.ok(s.ghCalls.every(a=>!a.includes("-X"))); assert.equal(s.state,"OPEN")
})


test('review 1: a signalled guard cannot repeat a mutation without readback', async t => {
 const f = await fixture(t)
 const effect = path.join(f.checkout, 'signal-effect')
 const argv = [process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(effect)},'x');process.kill(process.pid,'SIGKILL')`]
 const first = await f.run('codex-guard', repo, '7', 'fix', ...argv)
 assert.notEqual(first.code, 0)
 const second = await f.run('codex-guard', repo, '7', 'fix', ...argv)
 assert.equal(second.code, 130)
 assert.equal(await fs.readFile(effect, 'utf8'), 'x')
 const wait = JSON.parse(await fs.readFile(path.join(f.stateDir, 'waits', `${keyFor(repo, 7)}.json`)))
 assert.equal(wait.status, 'suspended')
 assert.equal(wait.cause, 'mutation-uncertain')
})

for (const step of ['pr:complete', 'pr:suspend', 'codex-guard']) test(`review 3: wait-record ${step} admission shares the attempt deadline`, async t => {
 const f = await fixture(t, {}, { attemptTimeoutMs: 2000, commandTimeoutMs: 5000 })
 const release = await acquireLease(path.join(f.stateDir, 'locks'), `wait-${keyFor(repo, 7)}`)
 try {
  const adapter = createPrDeliveryAdapter(await loadDeliveryConfig(f.config), { env: f.env })
  const start = Date.now()
  const result = await adapter.execute(step, { repo, pr: 7, head: f.head, kind: 'review', argv: ['/usr/bin/true'],
   stop: { cause: 'source-no-progress', code: 2, message: 'synthetic', resetAt: null } })
  assert.equal(result.data.code, 142, JSON.stringify(result))
  assert.ok(Date.now() - start < 3000)
  assert.equal((await f.read()).calls.length, 0)
 } finally { await release() }
})

test('review 7: invalid argv refuses before admission and corrected argv can run', async t => {
 const f = await fixture(t)
 const invalid = await f.run('codex-guard', repo, '7', 'fix')
 assert.notEqual(invalid.code, 0)
 const waits = await fs.readdir(path.join(f.stateDir, 'waits')).catch(e => { if (e.code === 'ENOENT') return []; throw e })
 assert.deepEqual(waits, [])
 assert.equal(await fs.readFile(path.join(f.stateDir, 'usage.json'), 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e }), null)
 ok(await f.run('codex-guard', repo, '7', 'fix', '/usr/bin/true'))
})

test('review 7: a known binding failure retires the prelaunch marker', async t => {
 const f = await fixture(t)
 const adapter = createPrDeliveryAdapter(await loadDeliveryConfig(f.config), { env: f.env })
 const rename = fs.rename.bind(fs)
 let refuse = true
 t.mock.method(fs, 'rename', async (from, to) => {
  if (refuse && to.includes('codex-slot-') && JSON.parse(await fs.readFile(from, 'utf8')).job) {
   refuse = false
   throw Error('synthetic binding failure')
  }
  return rename(from, to)
 })
 const request = { repo, pr: 7, kind: 'fix', argv: ['/usr/bin/true'] }
 assert.equal((await adapter.execute('codex-guard', request)).status, 'fail')
 const wait = JSON.parse(await fs.readFile(path.join(f.stateDir, 'waits', `${keyFor(repo, 7)}.json`)))
 assert.equal(wait.status, 'complete')
 assert.equal((await adapter.execute('codex-guard', request)).status, 'pass')
})

for (const source of [
 "import {describe,it} from 'node:test';describe('suite',()=>{it.skip('case',()=>{})})",
 "import {describe,it} from 'node:test';describe('outer',()=>{describe('inner',()=>{it.todo('case')})})",
 "import test from 'node:test';test('premature',()=>{process.exit(0)})"
]) test(`review 6: browser suites require executed tests and a terminal summary: ${source}`, async t => {
 const f = await fixture(t), file = path.join(f.checkout, 'empty-browser.test.mjs')
 await fs.writeFile(file, source)
 const result = await f.wrapper('test-browser', repo, file)
 assert.notEqual(result.code, 0)
 assert.doesNotMatch(result.stdout, /pass /)
})

test('review 8: browser repository must be an own configured entry', async t => {
 const f = await fixture(t), file = path.join(f.checkout, 'healthy-browser.test.mjs')
 await fs.writeFile(file, "import test from 'node:test';test('healthy',()=>{})")
 const result = await f.wrapper('test-browser', 'toString', file)
 assert.notEqual(result.code, 0)
 assert.doesNotMatch(result.stdout, /pass /)
 await assert.rejects(fs.access(path.join(f.stateDir, 'locks')), { code: 'ENOENT' })
})

test('browser acknowledgement counts nested executed tests separately from suites and skips', async t => {
 const f = await fixture(t), file = path.join(f.checkout, 'mixed-browser.test.mjs')
 await fs.writeFile(file, "import {describe,it} from 'node:test';describe('outer',()=>{describe('inner',()=>{it('healthy',()=>{});it.skip('skip',()=>{});it.todo('todo')})})")
 const result = await f.wrapper('test-browser', repo, file)
 ok(result)
 assert.equal(result.stdout, 'pass 1\n')
})

for (const key of ['attemptTimeoutMs', 'commandTimeoutMs', 'apiTimeoutMs', 'queueTimeoutMs', 'checksTimeoutMs', 'pollMs', 'retryMs', 'autoPollMs'])
 test(`review 9: config rejects timer overflow in ${key}`, async t => {
  const f = await fixture(t, {}, { [key]: 3000000000 })
  await assert.rejects(loadDeliveryConfig(f.config), { code: 9 })
 })
test('review 9: config rejects execution timer overflow', async t => {
 const f = await fixture(t, {}, { limits: { timeoutMs: 3000000000 } })
 await assert.rejects(loadDeliveryConfig(f.config), { code: 9 })
})

test('review 10: timeout exceptions are the sole delivery timeout policy', async () => {
 const source = await fs.readFile(new URL('../src/pr-delivery.mjs', import.meta.url), 'utf8')
 const afterCommand = source.slice(source.indexOf('  const git ='))
 assert.equal(/(?:result|response)\.timedOut/.test(afterCommand), false, 'delivery timeout result paths must be absent')
})

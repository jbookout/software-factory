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
const started=performance.now();
const diagnostic = value => fs.appendFileSync(file+'.transport.jsonl',JSON.stringify({...value,at:new Date().toISOString(),elapsedMs:Math.round(performance.now()-started)})+'\\n');
if(require('node:path').basename(process.argv[1])==='gh') {
 process.on('exit',code=>diagnostic({args,code}));
 process.on('uncaughtException',error=>{diagnostic({args,error:{code:error.code,message:error.message,status:error.status,signal:error.signal}});process.exit(1)});
}
if(require('node:path').basename(process.argv[1])==='gh' && process.env.FAKE_WORKER_GH_TLS==='1'){console.log(JSON.stringify({credentialPresent:Boolean(process.env.GH_TOKEN||process.env.GITHUB_TOKEN)}));console.error('tls: failed to verify certificate: x509: OSStatus -26276');process.exit(1);}
const s = JSON.parse(fs.readFileSync(file));
// Concurrent fake calls and the test read this file; replace it atomically.
const save = () => { const temp = file + '.' + process.pid + '.tmp'; fs.writeFileSync(temp, JSON.stringify(s)); fs.renameSync(temp, file); };
const git = (...a) => cp.execFileSync('git', a, {encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
s.headRefOid = git('--git-dir',s.remote,'rev-parse','refs/heads/topic');
const tool = require('node:path').basename(process.argv[1]);
if(['codex','claude'].includes(tool)) {
 let prompt=''; process.stdin.on('data',b=>prompt+=b); process.stdin.on('end',()=>{
 s.calls.push({prompt,cwd:process.cwd(),args}); save();
 if(s.childReader) {
 const path=require('node:path');
 const config=JSON.parse(fs.readFileSync(process.env.FACTORY_PR_CONFIG));
 fs.writeFileSync(path.join(config.stateDir,'github.json'),JSON.stringify({schema:'factory-github/v1',requests:[],cache:{},failures:{},hold:{state:'quota_hold',pool:'rest',queryErrors:1,terminal:false,retryAt:Date.now()+120000,message:'synthetic quota hold'}}));
 s.childReaderBefore=s.ghCalls.length;
 s.childReaderCode=cp.spawnSync(process.execPath,[s.childReader,process.env.FACTORY_PR_CONFIG,'github-read','fixture/new-repository','pulls/7'],{encoding:'utf8'}).status;
 save();process.exit(s.childReaderCode);
 }
 if(s.childCode) { console.error(s.childError??'synthetic child refusal');process.exit(s.childCode); }
 if(s.hang) { process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); return; }
 if(!s.noProgress) {
 fs.writeFileSync('fix.txt',String(Date.now())); git('add','fix.txt'); git('commit','-qm','Repair'); if(!s.builderNoPush) git('push','-q','origin','HEAD:topic');
 if(s.correctiveRepair && s.calls.filter(c=>!c.prompt.includes('REVIEW MODE:')).length>1) {fs.writeFileSync('correction.txt','fixed');git('add','correction.txt');git('commit','-qm','Correct failed check');}
 if(s.hangAfterCommit) {setInterval(()=>{},1000);return;}
 s.statusCheckRollup=[{status:'COMPLETED',conclusion:'SUCCESS'}]; s.mergeable='MERGEABLE'; s.mergeStateStatus='CLEAN'; save();
 }
 });
} else {
 s.ghCalls.push(args); save(); const action=args[1];
 if(args[0]==='api') {
 const route=args.find(a=>a.startsWith('repos/')), params=new URL('https://fixture.invalid/'+route).searchParams;
 const page=Number(params.get('page')||1),pageSize=Number(params.get('per_page')||100);
 if(route.endsWith('/logs')) {if(s.logEscapes&&!args.includes('--allow-escape-sequences')) {console.error('the response contains terminal escape sequences');process.exit(1)} console.log('HTTP/2.0 200 OK\\nContent-Type: text/plain\\n\\nstep-only failure detail');process.exit(0);}
 const respond=value=>console.log('HTTP/2.0 200 OK\\n\\n'+JSON.stringify(value));
 if(args.includes('-X')) {
 // Writes: JSON body on stdin; s.writeFaults[name] injects one outcome per call.
 const body=JSON.parse(fs.readFileSync(0,'utf8')),name=route.split('/').at(-1);
 const reply=(code,value)=>{console.log('HTTP/2.0 '+code+' synthetic\\n\\n'+JSON.stringify(value));process.exit(code<300?0:1)};
 const fault=s.writeFaults?.[name]?.shift();save();
 if(s.pauseWrite===name) {fs.writeFileSync(s.pauseMarker,String(process.pid));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,3000);}
 if(fault==='no-response') process.exit(1);
 if(fault==='exception') {console.error(s.writeErrorMessage??'synthetic');process.exit(2);}
 if(['empty','partial'].includes(fault)) {console.log('HTTP/2.0 200 OK\\n\\n'+(fault==='partial'?'{\"id\":':''));process.exit(0);}
 if(typeof fault==='number') reply(fault,{message:s.writeErrorMessage??'synthetic'});
 const topicHasMain=()=>{try{git('--git-dir',s.remote,'merge-base','--is-ancestor','refs/heads/main','refs/heads/topic');return true}catch{return false}};
 if(route.endsWith('/git/commits')) {
 const sha=cp.execFileSync('git',['--git-dir',s.remote,'commit-tree',body.tree,'-p',body.parents[0]],{input:body.message,encoding:'utf8'}).trim();s.createdCommit=sha;save();reply(201,{sha});
 } else if(route.includes('/git/refs/heads/')) {
 git('--git-dir',s.remote,'update-ref','refs/heads/topic',body.sha,s.headRefOid);s.headRefOid=body.sha;s.statusCheckRollup=[{status:'COMPLETED',conclusion:'SUCCESS'}];save();reply(200,{object:{sha:body.sha}});
 } else if(name==='comments') {
 s.comments.push({body:body.body,pr:Number(route.split('/')[4]),author:{login:body.body.startsWith('DELIVERY VERIFIED')?(s.deliveryPublisher??'reviewer'):'reviewer'}});
 if(s.blockBeforeMerge&&body.body.startsWith('DELIVERY VERIFIED')) s.comments.push({body:'REVIEW: BLOCKED\\nReviewed-SHA: '+s.headRefOid,author:{login:'reviewer'}});
 if(s.advanceMainOnComment&&body.body.startsWith('DELIVERY VERIFIED')) {git('-C',s.checkout,'checkout','-q','main');fs.writeFileSync(s.checkout+'/late-main.txt','late');git('-C',s.checkout,'add','late-main.txt');git('-C',s.checkout,'commit','-qm','Late main');git('-C',s.checkout,'push','-q','origin','main');s.advanceMainOnComment=false;}
 if(s.lostCommentReply&&body.body.startsWith('DELIVERY VERIFIED')) {s.restCodes=s.readbackFault?[s.readbackFault]:s.restCodes;save();reply(502,{})}
 save();reply(201,{id:s.comments.length,body:body.body});
 } else if(name==='update-branch') {
 if(s.pendingUpdate) {s.updatePending=true;s.pendingReads=0;save();reply(s.pendingUpdate==='lost'?502:202,{message:'Updating pull request branch.'});}
 if(body.expected_head_sha!==s.headRefOid) reply(422,{message:'expected head sha mismatch'});
 git('-C',s.checkout,'checkout','-q','topic');git('-C',s.checkout,'fetch','-q','origin');
 try {git('-C',s.checkout,'merge','--no-edit','origin/main')} catch {git('-C',s.checkout,'merge','--abort');git('-C',s.checkout,'checkout','-q','main');reply(422,{message:'merge conflict'})}
 git('-C',s.checkout,'push','-q','origin','topic');git('-C',s.checkout,'checkout','-q','main');s.headRefOid=git('--git-dir',s.remote,'rev-parse','refs/heads/topic');save();
 if(s.loseUpdateResponse) reply(502,{message:'synthetic lost response'});
 reply(202,{message:'Updating pull request branch.'});
 } else if(name==='merge') {
 if(s.advanceMainOnMerge) {git('-C',s.checkout,'checkout','-q','main');fs.writeFileSync(s.checkout+'/late-main.txt','late');git('-C',s.checkout,'add','late-main.txt');git('-C',s.checkout,'commit','-qm','External main move');git('-C',s.checkout,'push','-q','origin','main');s.advanceMainOnMerge=false;s.externalMain=git('-C',s.checkout,'rev-parse','HEAD');save();}
 if(body.merge_method!=='squash' || body.sha!==s.headRefOid) reply(409,{message:'Head branch was modified'});
 // Models an active strict ruleset: the provider refuses a head that lacks main.
 const strict=(s.rules??[{parameters:{strict_required_status_checks_policy:true}}]).some(r=>r.parameters?.strict_required_status_checks_policy)
  && (s.ruleset?.enforcement??'active')==='active' && (s.ruleset?.current_user_can_bypass??'never')==='never';
 if(strict && !topicHasMain()) reply(405,{message:'Head branch is not up to date with the base branch'});
 git('-C',s.checkout,'fetch','-q','origin');git('-C',s.checkout,'checkout','-q','main');git('-C',s.checkout,'reset','-q','--hard','origin/main');git('-C',s.checkout,'merge','--squash','origin/topic');git('-C',s.checkout,'commit','-qm','Merge PR');git('-C',s.checkout,'push','-q','origin','main');
 s.state='MERGED';s.mergeCommit={oid:git('-C',s.checkout,'rev-parse','HEAD')};save();
 if(s.lostMergeReply) reply(502,{});
 reply(200,s.missingAck||s.emptyMergeReply?{}:{merged:true,sha:s.mergeCommit.oid});
 }
 console.error('unexpected REST write');process.exit(2);
 }
 if(s.restCodes?.length) {const code=s.restCodes.shift();save();console.log('HTTP/2.0 '+code+' synthetic\\n'+(s.retryAfter!==undefined?'Retry-After: '+s.retryAfter+'\\n':'')+(s.resetAt?'X-RateLimit-Reset: '+s.resetAt+'\\n':'')+(s.quotaEvidence?'X-RateLimit-Remaining: 0\\n':'')+'\\n{}');process.exit(1);}
 if(s.apiHang) { if(s.apiHang!=='fetch') process.stdout.write('HTTP/2.0 200 OK\\n\\n{'); setInterval(()=>{if(s.apiHang==='drip') process.stdout.write(' ');},10); return; }
 if(s.apiFailure) { console.log('HTTP/2.0 403 Forbidden\\nx-ratelimit-remaining: 0\\n\\n{}');console.error('provider unavailable');process.exit(1); }
 if(s.restFault) { if(s.restFault==='exception') process.exit(2); if(s.restFault==='refusal') {console.log('HTTP/2.0 401 Unauthorized\\n\\n{}');process.exit(1);}
 console.log('HTTP/2.0 200 OK\\n\\n'+s.restFault);process.exit(0); }
 const pr=(number=s.number)=>({id:number,number,title:s.title,body:s.description??'',state:s.state==='OPEN'?'open':'closed',merged:s.state==='MERGED',draft:s.isDraft,
 head:{sha:s.headRefOid,ref:s.headRefName,repo:{full_name:s.isCrossRepository?'fixture/fork':(s.repo??'fixture/new-repository')}},
 base:{ref:s.baseRefName,sha:s.recordedBase??git('--git-dir',s.remote,'rev-parse','refs/heads/main'),repo:{full_name:s.repo??'fixture/new-repository'}},comments:s.comments.filter(c=>(c.pr??7)===number).length,mergeable:s.mergeable==='UNKNOWN'?null:s.mergeable!=='CONFLICTING',mergeable_state:s.mergeStateStatus.toLowerCase(),merge_commit_sha:s.mergeCommit?.oid});
 if(/pulls\\/[0-9]+$/.test(route)) {
 if(s.updatePending && s.updateAfterReads && ++s.pendingReads>=s.updateAfterReads) {
 git('-C',s.checkout,'checkout','-q','topic');git('-C',s.checkout,'fetch','-q','origin');
 if(s.badUpdate) {fs.writeFileSync(s.checkout+'/unreviewed.txt','unreviewed');git('-C',s.checkout,'add','unreviewed.txt');git('-C',s.checkout,'commit','-qm','Unrelated change');}
 else git('-C',s.checkout,'merge','--no-edit','origin/main');
 git('-C',s.checkout,'push','-q','origin','topic');git('-C',s.checkout,'checkout','-q','main');
 s.headRefOid=git('--git-dir',s.remote,'rev-parse','refs/heads/topic');s.updatePending=false;save();
 }

 if(s.moveDuringChecks && ++s.moveViewCount>1) {
 git('-C',s.checkout,'checkout','-q','topic');fs.writeFileSync(s.checkout+'/moved.txt','moved');git('-C',s.checkout,'add','moved.txt');git('-C',s.checkout,'commit','-qm','Move head');git('-C',s.checkout,'push','-q','origin','topic');
 s.headRefOid=git('--git-dir',s.remote,'rev-parse','refs/heads/topic');s.moveDuringChecks=false;save(); }
 save();respond({...pr(Number(route.split('/').at(-1))),...s.prOverrides});
 } else if(route.includes('/pulls?')) {
 const prs=s.listCount?Array.from({length:s.listCount},(_,i)=>({...pr(),body:'x'.repeat(s.listBodyBytes??0),id:i+100,number:i===s.listCount-1?7:i+100,comments:i===s.listCount-1?s.comments.length:0})):[pr()];respond(prs.slice((page-1)*pageSize,page*pageSize));
 } else if(route.includes('/comments')) {
 const number=Number(/issues\\/([0-9]+)\\//.exec(route)[1]);
 if(s.missingCommentPage===page) respond([]); else respond(s.comments.filter(c=>(c.pr??7)===number).map((c,i)=>({id:i+1,created_at:new Date(1700000000000+i*1000).toISOString(),updated_at:new Date(1700000000000+i*1000).toISOString(),user:{login:c.author?.login??'reviewer'},...c})).slice((page-1)*pageSize,page*pageSize));
 }
 else if(route.includes('/check-runs')) {
 if(s.checkFault) {console.log('HTTP/2.0 502 synthetic\\n\\n{}');process.exit(1)}
 if(s.badCheckPage) {respond({total_count:1,check_runs:[]});process.exit(0)}
 const runs=s.checkRuns??s.statusCheckRollup.filter(c=>c.__typename!=='StatusContext').map((c,i)=>({id:i+1,name:c.name??(i?'optional-'+i:'test'),head_sha:s.headRefOid,status:c.status?.toLowerCase(),conclusion:c.conclusion?.toLowerCase()??null,app:{id:15368}}));
 respond({total_count:runs.length,check_runs:runs.slice((page-1)*pageSize,page*pageSize)});
 } else if(route.includes('/statuses')) {
 const statuses=s.statuses??s.statusCheckRollup.filter(c=>c.__typename==='StatusContext').map((c,i)=>({id:i+1,context:c.context??'test',state:c.state?.toLowerCase()}));
 respond(statuses.slice((page-1)*pageSize,page*pageSize));
 }
 else if(route.includes('/git/commits/')) respond({sha:s.headRefOid,tree:{sha:git('--git-dir',s.remote,'rev-parse',s.headRefOid+'^{tree}')},parents:[{sha:git('--git-dir',s.remote,'rev-parse',s.headRefOid+'^')}],message:'fixture'});
 else if(route.includes('/git/ref/heads/')) respond({ref:'refs/heads/'+decodeURIComponent(route.split('/git/ref/heads/')[1]),object:{type:'commit',sha:git('--git-dir',s.remote,'rev-parse','refs/heads/main')}});
 else if(route.includes('/rules/branches/main')) {
 const rules=s.rules??[{type:'required_status_checks',ruleset_id:1,parameters:{strict_required_status_checks_policy:true}}];
 respond(rules.slice((page-1)*pageSize,page*pageSize));
 } else if(route.endsWith('/rulesets/1')) respond(s.ruleset??{id:1,enforcement:'active',current_user_can_bypass:'never'});
 else { console.error('unexpected REST route');process.exit(2); }
 } else {console.error('GraphQL PR route forbidden');process.exit(2);}
}
`

async function fixture(t, overrides = {}, configOverrides = {}) {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-delivery-"))
 t.after(() => fs.rm(root, { recursive: true, force: true }))
 const checkout = path.join(root, "checkout"), remote = path.join(root, "remote.git")
 const env = { ...process.env, FORCE_UPDATE: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid", FAKE_PR: path.join(root, "pr.json") }
 // Local Git identity is fixture-only; no inherited credentials or hooks.
 execFileSync("git", ["init", "--bare", remote], {env,stdio:"ignore"})
 execFileSync("git", ["clone", remote, checkout], {env,stdio:"ignore"})
 const g = (...args) => execFileSync("git", args, { cwd:checkout,env,encoding:"utf8",stdio:["ignore","pipe","pipe"] }).trim()
 g("checkout", "-b", "main"); g("config", "user.name", "Fixture"); g("config", "user.email", "fixture@example.invalid")
 await fs.writeFile(path.join(checkout,"base.txt"),"base\n");g("add","base.txt");g("commit","-qm","Base");g("push","-q","origin","main")
 g("checkout","-b","topic");await fs.writeFile(path.join(checkout,"feature.txt"),"feature\n");g("add","feature.txt");g("commit","-qm","Feature");g("push","-q","origin","topic")
 const head = g("rev-parse","HEAD");g("checkout","main")
 const tools=path.join(root,"tools");await fs.mkdir(tools)
 for(const name of ["gh","codex","claude"]) await fs.writeFile(path.join(tools,name),fake,{mode:0o755})
 env.PATH=tools+path.delimiter+env.PATH
 const state={ remote,checkout,number:7,title:"Fixture PR",state:"OPEN",baseRefName:"main",isCrossRepository:false,headRefName:"topic",headRefOid:head,mergeStateStatus:"CLEAN",mergeable:"MERGEABLE",isDraft:false,author:{login:"builder"},comments:[],statusCheckRollup:[{status:"COMPLETED",conclusion:"SUCCESS"}],calls:[],ghCalls:[],builderNoPush:true,...overrides }
 await fs.writeFile(env.FAKE_PR,JSON.stringify(state))
 const config=path.join(root,"config.json"), stateDir=path.join(root,"state")
 // CLI smoke controls use the trusted host observer; allow room for concurrent
 // host jobs. Capacity refusal itself uses injected snapshots in its own tests.
 const cfg={repos:{"fixture/new-repository":{checkout,originUrl:remote,worktreeRoot:path.join(root,"worktrees"),requiredChecks:[{name:"test"}],trustedReviewers:["reviewer"],checks:[[process.execPath,"-e",""]]}},stateDir,modelsFile:"models.json",resources:{capacity:64,browserConcurrency:1,agentUnits:1},queueTimeoutMs:15000,limits:{runsPer24h:8,slots:2,timeoutMs:5000},github:{cacheMs:0},pollMs:5,retryMs:0,commandTimeoutMs:5000,checksTimeoutMs:5000,...configOverrides}
 await fs.writeFile(path.join(root,"models.json"),JSON.stringify({roles:Object.fromEntries(["review-tier2","review-tier3","fix","ci-fix"].map(role=>[role,{model:"fixture-model",effort:"high"}]))}))
 await fs.writeFile(config,JSON.stringify(cfg))
 const read=async()=>JSON.parse(await fs.readFile(env.FAKE_PR,"utf8"))
 const launch=(command,args,workerEnv=env)=>new Promise((resolve,reject)=>{
  const child=spawn(command,args,{env:workerEnv,stdio:["ignore","pipe","pipe"]});let stdout="",stderr=""
  child.stdout.on("data",b=>stdout+=b);child.stderr.on("data",b=>stderr+=b);child.on("error",reject);child.on("close",async code=>{
   if(code) {
    const diagnostics=await fs.readFile(env.FAKE_PR+'.transport.jsonl','utf8').catch(()=>"")
    stderr+='\nFixture transport diagnostics:\n'+diagnostics.split('\n').slice(-5).join('\n')
    const journal=await fs.readFile(path.join(stateDir,'delivery.jsonl'),'utf8').catch(()=>"")
    const phases=journal.split('\n').filter(Boolean).flatMap(line=>{
     try { const event=JSON.parse(line);return event.phase==='api'?[{at:event.at,status:event.status,code:event.code,durationMs:event.durationMs}]:[] }
     catch { return [{diagnostic:'incomplete fixture phase journal'}] }
    })
    const policy=await fs.readFile(config,'utf8').then(JSON.parse).then(current=>({apiTimeoutMs:current.apiTimeoutMs??current.commandTimeoutMs})).catch(()=>({configObservation:'unreadable'}))
    stderr+='\nFixture API phase diagnostics:\n'+JSON.stringify({...policy,phases:phases.slice(-5)})

   }
   resolve({code,stdout,stderr})
  })
 })
 const run=(...args)=>launch(process.execPath,[cli,config,...args])

 return {root,checkout,remote,head,stateDir,read,run,g,config,cfg,env}
}
const queueOf = async f => JSON.parse(await fs.readFile(path.join(f.stateDir,"queue.json")))
const remoteTopic = f => git(f.root,"--git-dir",f.remote,"rev-parse","refs/heads/topic")
const currentRepair = async f => JSON.parse(await fs.readFile(path.join(f.stateDir,'repairs',`${keyFor(repo,7)}.json`),'utf8'))
const adapterModule=JSON.stringify(fileURLToPath(new URL('../src/pr-delivery.mjs',import.meta.url)))
const advanceMain = async (f, file = "producer-contract.txt") => {
 await fs.writeFile(path.join(f.checkout,file),"changed contract\n")
 f.g("add",file); f.g("commit","-qm","Producer contract advances"); f.g("push","-q","origin","main")
}

const queueFixture = (t, overrides = {}) => fixture(t, overrides, {
 apiTimeoutMs:30000,commandTimeoutMs:30000,checksTimeoutMs:30000,attemptTimeoutMs:180000,
 limits:{runsPer24h:8,slots:2,timeoutMs:30000}
})
const repo="fixture/new-repository"
const ok = r => assert.equal(r.code,0,JSON.stringify(r))
const merges = a => a.includes("-X") && a.some(v=>v.endsWith("/merge"))

for(const action of ["fix-pr","ci-fix"]) test("checked-out branch is reused by "+action+" without exit 128",async t=>{
 const f=await fixture(t,action === "ci-fix" ? {statusCheckRollup:[{status:"COMPLETED",conclusion:"FAILURE"}]} : {});const wt=path.join(f.root,"existing");f.g("worktree","add",wt,"topic")
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
test("hard timeout kills a Codex that ignores SIGTERM and releases slot",async t=>{
 const f=await fixture(t,{hang:true},{limits:{runsPer24h:8,slots:1,timeoutMs:400},queueTimeoutMs:15000})
 const r=await f.run("codex-guard",repo,"7","review","codex");assert.equal(r.code,142);assert.match(r.stdout,/TIMEOUT/)
 const events=(await fs.readFile(path.join(f.stateDir,"delivery.jsonl"),"utf8")).trim().split("\n").map(JSON.parse)
 const execution=events.find(e=>e.phase==="execution")
 assert.equal(execution.code,142);assert.ok(execution.durationMs<650,"400ms execution budget includes process cleanup, separately from readiness/queue")
 ok(await f.run("codex-guard",repo,"7","review","/usr/bin/true"))
})
test("configured repository outside old case list merges",async t=>{
 const f=await fixture(t);ok(await f.run("merge-enqueue",repo,"7",f.head,"fixture"));ok(await f.run("merge-queue","--once"));assert.equal((await f.read()).state,"MERGED")
})
test("unknown repo rejected with a clear configuration message",async t=>{
 const f=await fixture(t);const r=await f.run("merge-one-core","fixture/missing","7",f.head);assert.equal(r.code,9);assert.match(r.stderr,/UNKNOWN REPO.*config/);assert.equal((await f.read()).ghCalls.length,0)
})
test("head moving during checks cannot merge",async t=>{
 const f=await fixture(t,{moveDuringChecks:true});const r=await f.run("merge-one-core",repo,"7",f.head);assert.equal(r.code,1);assert.equal((await f.read()).state,"OPEN")
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
test("controller death cannot orphan a guarded child or release its occupied slot",async t=>{
 const f=await fixture(t,{}, {limits:{runsPer24h:8,slots:1,timeoutMs:700}})
 const pidFile=path.join(f.root,"child.pid")
 const childCode=`require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`
 const controller=spawn(process.execPath,[cli,f.config,"codex-guard",repo,"7","fix",process.execPath,"-e",childCode],{env:f.env,stdio:["ignore","pipe","pipe"]})
 let controllerExit,diagnostics=""
 controller.once("exit",(code,signal)=>{controllerExit={code,signal}})
 for(const stream of [controller.stdout,controller.stderr]) stream.on("data",chunk=>{diagnostics=(diagnostics+chunk).slice(-8192)})
 t.after(()=>{try{controller.kill("SIGKILL")}catch{}})
 let pid
 const bootUntil=Date.now()+30_000 // CLI/API/admission readiness is separate from the child's 700ms execution cap.
 for(;Date.now()<bootUntil&&!controllerExit;) {try{const observed=Number(await fs.readFile(pidFile,"utf8"));if(Number.isSafeInteger(observed)&&observed>0){pid=observed;break}}catch{} await new Promise(r=>setTimeout(r,10))}
 assert.ok(pid,`guarded child started; controller=${JSON.stringify(controllerExit)}; diagnostics=${diagnostics}`)
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
test("a valid already merged PR is verified again without another merge",async t=>{
 const f=await fixture(t);ok(await f.run("merge-one-core",repo,"7",f.head))
 const first=await f.read()
 ok(await f.run("merge-one-core",repo,"7",f.head))
 const r=await f.run("deliver",repo,"7","-","1");ok(r);assert.match(r.stdout,/source verified/)
 const after=await f.read();assert.equal(after.ghCalls.filter(merges).length,1)
 assert.equal(after.calls.length,0);assert.equal(after.mergeCommit.oid,first.mergeCommit.oid)
})
test("red hosted checks refuse merge without a queue approval comment",async t=>{
 const f=await fixture(t,{statusCheckRollup:[{status:"COMPLETED",conclusion:"FAILURE"}]});
 const r=await f.run("merge-one-core",repo,"7",f.head);assert.equal(r.code,3);assert.equal((await f.read()).comments.length,0)
})
test("concurrent merge workers use a single serial owner",async t=>{
 const f=await fixture(t);ok(await f.run("merge-enqueue",repo,"7",f.head))
 const results=await Promise.all([f.run("merge-queue","--once"),f.run("merge-queue","--once")])
 assert.ok(results.some(r=>r.code===0));assert.ok(results.every(r=>[0,75].includes(r.code)),JSON.stringify(results));assert.equal((await f.read()).ghCalls.filter(merges).length,1)
})
test("missing required check cannot authorize enqueue or merge and spends no fixer",async t=>{
 const f=await fixture(t,{}, {checksTimeoutMs:80});
 const s=await f.read();s.statusCheckRollup=[{name:"unrelated",status:"COMPLETED",conclusion:"SUCCESS"}]
 await fs.writeFile(f.env.FAKE_PR,JSON.stringify(s))
 assert.notEqual((await f.run("enqueue-event",repo,"7")).code,0)
 await assert.rejects(fs.readFile(path.join(f.stateDir,"queue.json")),{code:"ENOENT"})
 assert.notEqual((await f.run("merge-one-core",repo,"7",f.head)).code,0)
 assert.notEqual((await f.run("deliver",repo,"7","-","1")).code,0)
 assert.equal((await f.read()).calls.length,0)
})
test("REST multi-page scans accept large PR bodies, comments and check output",async t=>{
 const f=await fixture(t,{listCount:101,listBodyBytes:60000});
 const s=await f.read()
 s.comments.unshift(...Array.from({length:26},()=>({body:"x".repeat(60000)})))
 s.checkRuns=Array.from({length:26},(_,i)=>({id:i+1,name:i?"optional-"+i:"test",head_sha:f.head,
   app:{id:15368},status:"completed",conclusion:"success",output:{text:"x".repeat(60000)}}))
 await fs.writeFile(f.env.FAKE_PR,JSON.stringify(s))
 const adapter=createPrDeliveryAdapter(await loadDeliveryConfig(f.config),{env:f.env})
 assert.equal((await adapter.execute("delivery-scan",{repo})).status,"pass")
 ok(await f.run("snapshot",repo,"7"))
 const calls=(await f.read()).ghCalls.map(a=>a[1])
 for(const route of ["/pulls?","/comments?","/check-runs?"])
  assert.ok(calls.some(r=>r.includes(route)&&r.includes("page=2")),`second page read: ${route}`)
})
test("snapshot carries full source inventory and one provider observation",async t=>{
 const f=await fixture(t);const r=await f.run("snapshot",repo,"7");ok(r);
 const v=JSON.parse(r.stdout);assert.equal(v.schema,"factory-github-snapshot/v1");assert.equal(v.state,"known");
 assert.equal(v.head.sha,f.head);assert.match(v.base.sha,/^[0-9a-f]{40}$/);
 assert.equal(v.inventory.checkRuns.length,1);assert.equal(v.inventory.comments.length,0);
 assert.equal(v.metrics.providerCalls,7);assert.equal(v.metrics.staleActions,0);assert.ok(Date.parse(v.fetchedAt));
});
for(const replyFault of ["lostMergeReply","emptyMergeReply"]) test(`merged retry after ${replyFault} authenticates ancestry and never repeats the effect`,async t=>{
 const f=await fixture(t);const s=await f.read();s[replyFault]=true;await fs.writeFile(f.env.FAKE_PR,JSON.stringify(s));
 ok(await f.run("merge-one-core",repo,"7",f.head));ok(await f.run("merge-one-core",repo,"7",f.head));
 const after=await f.read();assert.equal(after.ghCalls.filter(a=>a.some(v=>v.endsWith("/merge"))).length,1);
 assert.equal(f.g("rev-parse","origin/main"),after.mergeCommit.oid);
 assert.equal(f.g("merge-base","--is-ancestor",after.mergeCommit.oid,"origin/main"),"");
});
for (const apiHang of ['fetch', 'body', 'drip']) test(`readiness bounds never-settling ${apiHang} within one API/attempt budget`, async t => {
 const f=await fixture(t,{apiHang},{commandTimeoutMs:5000,apiTimeoutMs:1000,attemptTimeoutMs:1800})
 const adapter=createPrDeliveryAdapter(await loadDeliveryConfig(f.config),{env:f.env})
 const start=Date.now(), result=await adapter.execute('readiness',{repo,pr:7}), r={...result.data,code:result.data.code}
 assert.equal(r.code,142,JSON.stringify(r))
 assert.ok(Date.now()-start<2000,'API retries must not renew the budget')
 assert.equal((await f.read()).calls.length,0)
 assert.equal((await f.read()).ghCalls.length,1,'a deadline is terminal for this observation')
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
for(const fault of [502,429,"no-response"]) test(`ambiguous update-branch ${fault} remains pending without duplicate write`, async t => {
 const f=await fixture(t,{writeFaults:{"update-branch":[fault]}});  await advanceMain(f)
 ok(await f.run("merge-enqueue",repo,"7",f.head))
 const first=await f.run("merge-queue",repo,"--once")
 if(fault === 429) assert.equal(first.code,75,JSON.stringify(first)); else ok(first)
 const [entry]=await queueOf(f)
 assert.equal(entry.attempts,1); assert.equal(entry.outcome,undefined,JSON.stringify(entry)); assert.equal(remoteTopic(f),f.head)
 if(fault === 429) {
  const githubFile=path.join(f.stateDir,"github.json")
  const observation=JSON.parse(await fs.readFile(githubFile))
  assert.equal(observation.hold.state,"quota_hold")
  assert.equal(entry.availableAt,observation.hold.retryAt)
  const requests=(await f.read()).ghCalls.length
  ok(await f.run("merge-queue",repo,"--once"))
  assert.equal((await queueOf(f))[0].attempts,1)
  assert.equal((await f.read()).ghCalls.length,requests,"restart cannot request before the provider retry time")
  observation.hold.retryAt=0;await fs.writeFile(githubFile,JSON.stringify(observation))
  entry.availableAt=0;await fs.writeFile(path.join(f.stateDir,"queue.json"),JSON.stringify([entry]))
 }
 ok(await f.run("merge-queue",repo,"--once"))
 const [done]=await queueOf(f)
 assert.equal(done.outcome,undefined); assert.equal(remoteTopic(f),f.head)
 assert.equal((await f.read()).ghCalls.filter(a=>a.some(v=>v.endsWith("/update-branch"))).length,1)
})
test("an update applied behind a lost response is read back, not retried or called a conflict", async t => {
 const f=await fixture(t,{loseUpdateResponse:true});  await advanceMain(f)
 ok(await f.run("merge-enqueue",repo,"7",f.head)); ok(await f.run("merge-queue",repo,"--once"))
 const [entry]=await queueOf(f)
 assert.equal(entry.outcome.data.updated,true); assert.notEqual(remoteTopic(f),f.head)
 assert.equal(entry.state,"acknowledged")
 await assert.rejects(fs.access(path.join(f.stateDir,"updates",`${keyFor(repo,7)}-${f.head}.json`)),{code:"ENOENT"})
 assert.equal((await f.read()).ghCalls.filter(a=>a.some(v=>v.endsWith("/update-branch"))).length,1)
})
test("a draft integration candidate stays refused without readiness mutation", async t => {
 const f=await fixture(t,{isDraft:true});
 const r=await f.run("merge-one-core",repo,"7",f.head)
 assert.equal(r.code,8); assert.match(r.stderr,/DRAFT/)
 const s=await f.read(); assert.ok(s.ghCalls.every(a=>!a.includes("-X"))); assert.equal(s.state,"OPEN")
})
for(const acknowledgement of ["accepted","lost"]) test(`pending ${acknowledgement} update is reconciled without old-head CI, merge or duplicate update`,async t=>{
 const f=await fixture(t,{pendingUpdate:acknowledgement},{checksTimeoutMs:80});await advanceMain(f)
 ok(await f.run("merge-enqueue",repo,"7",f.head));ok(await f.run("merge-queue",repo,"--once"))
 const [entry]=await queueOf(f);assert.equal(entry.outcome,undefined,JSON.stringify(entry))
 assert.equal((await f.read()).ghCalls.filter(merges).length,0)
 ok(await f.run("merge-queue",repo,"--once"))
 const after=await f.read();assert.equal(after.ghCalls.filter(a=>a.some(v=>v.endsWith("/update-branch"))).length,1)
 assert.equal(after.headRefOid,f.head);assert.equal(after.state,"OPEN")
 const pendingReads=after.ghCalls.slice(after.ghCalls.findIndex(a=>a.some(v=>v.endsWith("/update-branch")))+1)
 assert.ok(pendingReads.every(a=>!a.some(v=>/check-runs|statuses/.test(v))),"pending head is observed without consuming its old CI")
})
test('retro 7: runner waits for its check then pushes the tested commit',async t=>{
 const f=await fixture(t,{builderNoPush:true},{resources:{capacity:64,browserConcurrency:1,agentUnits:1},queueTimeoutMs:15000})
 const marker=path.join(f.root,'check-started'), finish=path.join(f.root,'check-finished')
 f.cfg.repos[repo].checks=[[process.execPath,'-e',`require('fs').writeFileSync(${JSON.stringify(marker)},'started');setTimeout(()=>{require('fs').writeFileSync(${JSON.stringify(finish)},'finished')},400)`]]
 await fs.writeFile(f.config,JSON.stringify(f.cfg))
 const pending=f.run('fix-pr',repo,'7','-')
 for(let i=0;i<3000;i++){if(await fs.access(marker).then(()=>true,()=>false))break;await pause(10)}
 await fs.access(marker)
 assert.equal(git(f.checkout,'--git-dir',f.remote,'rev-parse','refs/heads/topic'),f.head)
 const receiptFile=path.join(f.stateDir,'repairs',`${keyFor(repo,7)}.json`)
 assert.equal(JSON.parse(await fs.readFile(receiptFile,'utf8')).status,'checking')
 ok(await pending);await fs.access(finish)
 const receipt=JSON.parse(await fs.readFile(receiptFile,'utf8'))
 assert.equal(receipt.status,'delivered');assert.notEqual(receipt.head,f.head)
 assert.equal(receipt.remoteHead,receipt.head);assert.equal(receipt.testedHead,receipt.head)
 assert.ok(receipt.checks.every(c=>c.code===0))
})
test('retro 7: failed runner check leaves committed source unpushed',async t=>{
 const f=await fixture(t,{builderNoPush:true},{resources:{capacity:64,browserConcurrency:1,agentUnits:1},queueTimeoutMs:15000})
 f.cfg.repos[repo].checks=[[process.execPath,'-e','process.exit(17)']]
 await fs.writeFile(f.config,JSON.stringify(f.cfg))
 const result=await f.run('fix-pr',repo,'7','-')
 assert.equal(result.code,17,JSON.stringify(result))
 assert.equal(git(f.checkout,'--git-dir',f.remote,'rev-parse','refs/heads/topic'),f.head)
 const receipt=JSON.parse(await fs.readFile(path.join(f.stateDir,'repairs',`${keyFor(repo,7)}.json`),'utf8'))
 assert.equal(receipt.status,'check_failed');assert.equal(receipt.testedHead,undefined)
})
test('retro 7: failed push stays pending and recovery reads remote without rebuilding or retesting',async t=>{
 const f=await fixture(t,{builderNoPush:true},{resources:{capacity:64,browserConcurrency:1,agentUnits:1},queueTimeoutMs:15000})
 const hook=path.join(f.remote,'hooks','pre-receive')
 await fs.writeFile(hook,'#!/bin/sh\nexit 1\n',{mode:0o755})
 const first=await f.run('fix-pr',repo,'7','-');assert.notEqual(first.code,0)
 const file=path.join(f.stateDir,'repairs',`${keyFor(repo,7)}.json`)
 const pending=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(pending.status,'push_pending');assert.equal(pending.testedHead,pending.head)
 await fs.writeFile(hook,'#!/bin/sh\nexit 0\n',{mode:0o755})
 ok(await f.run('recover','--once'))
 const delivered=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(delivered.status,'delivered')
 assert.deepEqual(delivered.checks,pending.checks);assert.equal((await f.read()).calls.filter(c=>!c.prompt.includes('REVIEW MODE:')).length,1)
})
test('retro 7: recovery refuses a still-running check and resumes only after observing terminal failure',async t=>{
 const f=await fixture(t,{builderNoPush:true},{resources:{capacity:64,browserConcurrency:1,agentUnits:1},queueTimeoutMs:15000})
 f.cfg.repos[repo].checks=[[process.execPath,'-e','process.exit(17)']]
 await fs.writeFile(f.config,JSON.stringify(f.cfg))
 assert.equal((await f.run('fix-pr',repo,'7','-')).code,17)
 const file=path.join(f.stateDir,'repairs',`${keyFor(repo,7)}.json`),record=JSON.parse(await fs.readFile(file,'utf8'))
 const terminal=JSON.parse(await fs.readFile(record.checkJob.receipt,'utf8'))
 await fs.writeFile(record.checkJob.receipt,JSON.stringify({...terminal,status:'running',pid:process.pid,groupPid:null}))
 assert.equal((await f.run('recover','--once')).code,75)
 assert.equal((await f.read()).calls.length,1)
 await fs.writeFile(record.checkJob.receipt,JSON.stringify(terminal))
 f.cfg.repos[repo].checks=[[process.execPath,'-e','']]
 await fs.writeFile(f.config,JSON.stringify(f.cfg))
 ok(await f.run('recover','--once'));assert.equal((await f.read()).calls.filter(c=>!c.prompt.includes('REVIEW MODE:')).length,1)
})
test('retro 7: a stale recovery candidate cannot start another builder after delivery',async t=>{
 const f=await fixture(t,{builderNoPush:true},{queueTimeoutMs:15000})
 ok(await f.run('fix-pr',repo,'7','-'))
 const file=path.join(f.stateDir,'repairs',`${keyFor(repo,7)}.json`),record=JSON.parse(await fs.readFile(file,'utf8'))
 await fs.writeFile(file,JSON.stringify({...record,status:'push_pending'}))
 const adapter=createPrDeliveryAdapter(await loadDeliveryConfig(f.config),{env:f.env})
 const [candidate]=await adapter.recoveryCandidates()
 assert.equal(candidate.repairId,record.id)
 // The current owner finishes after discovery, before the recovery lease is acquired.
 await fs.writeFile(file,JSON.stringify(record))
 const result=await adapter.exclusive(repo,7,()=>adapter.execute('fix',{...candidate,repairId:record.id}))
 assert.equal(result.status,'pass',JSON.stringify(result))
 assert.equal((await f.read()).calls.length,1,'completed receipt must not dispatch a builder')
 assert.equal(JSON.parse(await fs.readFile(file,'utf8')).head,record.head)
 await fs.writeFile(file,JSON.stringify({...record,status:'push_pending',id:'replacement-receipt'}))
 const replaced=await adapter.exclusive(repo,7,()=>adapter.execute('fix',candidate))
 assert.equal(replaced.data.code,75);assert.equal((await f.read()).calls.length,1)
})
test('fix12: cancelled pending job never starts when PR capacity frees',async t=>{
 const f=await queueFixture(t);ok(await f.run('merge-enqueue',repo,'7',f.head))
 const release=await acquireLease(path.join(f.stateDir,'locks'),`pr-${keyFor(repo,7)}`)
 try {assert.equal((await f.run('merge-queue',repo,'--once')).code,75);ok(await f.run('queue-cancel',repo,'7',f.head))} finally {await release()}
 ok(await f.run('merge-queue',repo,'--once'));assert.equal((await f.read()).state,'OPEN')
 const [entry]=await queueOf(f);assert.equal(entry.state,'acknowledged');assert.equal(entry.outcome.data.cancelled,true)
 ok(await f.run('merge-enqueue',repo,'7',f.head));assert.equal((await queueOf(f)).length,1,'cancellation survives a repeated offer')
})
test('fix12: restored requested checkpoint reconciles success before another write',async t=>{
 const f=await queueFixture(t,{lostMergeReply:true});ok(await f.run('merge-enqueue',repo,'7',f.head))
 const backup=path.join(f.root,'checkpoint');await fs.cp(f.stateDir,backup,{recursive:true})
 const usage=await fs.readFile(path.join(f.stateDir,'usage.json')).catch(error=>{if(error.code==='ENOENT')return null;throw error})
 ok(await f.run('merge-queue',repo,'--once'));await fs.rm(f.stateDir,{recursive:true});await fs.cp(backup,f.stateDir,{recursive:true})
 assert.deepEqual(await fs.readFile(path.join(f.stateDir,'usage.json')).catch(error=>{if(error.code==='ENOENT')return null;throw error}),usage)
 ok(await f.run('merge-queue',repo,'--once'));assert.equal((await f.read()).ghCalls.filter(merges).length,1)
 assert.equal((await queueOf(f))[0].state,'acknowledged')
})
test('blocking 4: early builder publication is detected and never called unpushed',async t=>{
 const f=await fixture(t,{builderNoPush:false})
 f.cfg.repos[repo].checks=[[process.execPath,'-e','process.exit(17)']]
 await fs.writeFile(f.config,JSON.stringify(f.cfg))
 const result=await f.run('fix-pr',repo,'7','-')
 assert.notEqual(result.code,0)
 assert.doesNotMatch(result.stdout+result.stderr,/source unpushed/)
 assert.match(result.stdout+result.stderr,/EARLY PUBLICATION/)
 const record=await currentRepair(f)
 assert.equal(record.status,'early_publication');assert.equal(record.remoteHead,remoteTopic(f))
})
for(const multiple of [false,true]) test(`blocking 5: effective push destinations refuse extra remote (${multiple})`,async t=>{
 const f=await fixture(t,{builderNoPush:true}),other=path.join(f.root,'other.git')
 git(f.root,'clone','--bare','--quiet',f.remote,other)
 if(multiple) f.g('config','--add','remote.origin.pushurl',f.remote)
 f.g('config','--add','remote.origin.pushurl',other)
 const result=await f.run('fix-pr',repo,'7','-')
 assert.notEqual(result.code,0);assert.match(result.stdout+result.stderr,/push destination/)
 assert.equal(remoteTopic(f),f.head)
 assert.equal(git(f.root,'--git-dir',other,'rev-parse','refs/heads/topic'),f.head)
})
for(const rewrite of ['pushInsteadOf','insteadOf']) test(`blocking 5: publication never re-expands the bound destination (${rewrite})`,async t=>{
 const f=await fixture(t),other=path.join(f.root,'other.git')
 git(f.root,'clone','--bare','--quiet',f.remote,other)
 f.g('config','remote.origin.url','confirm-alias:')
 f.g('config',`url.${f.remote}.insteadOf`,'confirm-alias:')
 f.g('config',`url.${f.remote}.pushInsteadOf`,'confirm-alias:')
 f.g('config',`url.${other}.${rewrite}`,f.remote)
 assert.equal(f.g('remote','get-url','origin'),f.remote)
 assert.equal(f.g('remote','get-url','--push','--all','origin'),f.remote)
 const result=await f.run('fix-pr',repo,'7','-')
 assert.equal(git(f.root,'--git-dir',other,'rev-parse','refs/heads/topic'),f.head,'unbound repository must receive no publication')
 ok(result)
 const record=await currentRepair(f)
 assert.equal(record.status,'delivered');assert.equal(record.pushDestination,f.remote)
 assert.equal(remoteTopic(f),record.testedHead)
})
test('blocking 6: closed PR after checks refuses publication and delivery',async t=>{
 const f=await fixture(t,{builderNoPush:true})
 f.cfg.repos[repo].checks=[[process.execPath,'-e',`const fs=require('fs'),p=${JSON.stringify(f.env.FAKE_PR)};const s=JSON.parse(fs.readFileSync(p));s.state='CLOSED';fs.writeFileSync(p,JSON.stringify(s));`]]
 await fs.writeFile(f.config,JSON.stringify(f.cfg))
 const result=await f.run('fix-pr',repo,'7','-')
 assert.equal(result.code,8,JSON.stringify(result));assert.equal(remoteTopic(f),f.head)
 assert.notEqual((await currentRepair(f)).status,'delivered')
})
test('blocking 7: confirmed failed check dispatches one corrective builder under unchanged policy',async t=>{
 const f=await fixture(t,{builderNoPush:true,correctiveRepair:true})
 f.cfg.repos[repo].checks=[[process.execPath,'-e',"if(!require('fs').existsSync('correction.txt'))process.exit(17)"]]
 await fs.writeFile(f.config,JSON.stringify(f.cfg))
 assert.equal((await f.run('fix-pr',repo,'7','-')).code,17)
 const failed=await currentRepair(f)
 ok(await f.run('ci-fix',repo,'7','-','--no-loop'))
 const repaired=await currentRepair(f)
 assert.equal((await f.read()).calls.filter(c=>!c.prompt.includes('REVIEW MODE:')).length,2)
 assert.notEqual(repaired.id,failed.id);assert.equal(repaired.corrects,failed.id)
 assert.equal(repaired.status,'delivered')
})
test('blocking 8: committed interrupted builder is observed without repeat or publication',async t=>{
 const f=await fixture(t,{builderNoPush:true,hangAfterCommit:true},{limits:{runsPer24h:8,slots:2,timeoutMs:1500}})
 const first=await f.run('fix-pr',repo,'7','-');assert.equal(first.code,142,JSON.stringify(first))
 const interrupted=await currentRepair(f)
 assert.ok(interrupted.builderJob);assert.equal(interrupted.baseHead,f.head)
 const result=await f.run('recover','--once')
 assert.equal(result.code,75,JSON.stringify(result))
 const observed=await currentRepair(f)
 assert.equal(observed.status,'candidate_unconfirmed');assert.notEqual(observed.head,f.head)
 assert.equal(remoteTopic(f),f.head);assert.equal((await f.read()).calls.length,1)
 const state=await f.read();state.hangAfterCommit=false;await fs.writeFile(f.env.FAKE_PR,JSON.stringify(state))
 ok(await f.run('fix-pr',repo,'7','-'))
 assert.equal((await f.read()).calls.filter(c=>!c.prompt.includes('REVIEW MODE:')).length,2)
 assert.equal((await currentRepair(f)).status,'delivered')
})
test('blocking 6: final PR readback refuses a PR closed during push',async t=>{
 const f=await fixture(t)
 await fs.writeFile(path.join(f.remote,'hooks','pre-receive'),`#!/usr/bin/env node\nconst fs=require('fs'),p=${JSON.stringify(f.env.FAKE_PR)};const s=JSON.parse(fs.readFileSync(p));s.state='CLOSED';fs.writeFileSync(p,JSON.stringify(s));`,{mode:0o755})
 const result=await f.run('fix-pr',repo,'7','-')
 assert.equal(result.code,8,JSON.stringify(result));assert.notEqual(remoteTopic(f),f.head)
 assert.equal((await currentRepair(f)).status,'push_pending')
})
test('blocking 5: worktree-specific push destination is checked after repository checks',async t=>{
 const f=await fixture(t),other=path.join(f.root,'other.git')
 git(f.root,'clone','--bare','--quiet',f.remote,other);f.g('config','extensions.worktreeConfig','true')
 f.cfg.repos[repo].checks=[[process.execPath,'-e',`require('child_process').execFileSync('git',['config','--worktree','remote.origin.pushurl',${JSON.stringify(other)}]);`]]
 await fs.writeFile(f.config,JSON.stringify(f.cfg))
 const result=await f.run('fix-pr',repo,'7','-')
 assert.equal(result.code,9,JSON.stringify(result));assert.match(result.stdout+result.stderr,/push destination/)
 assert.equal(remoteTopic(f),f.head);assert.equal(git(f.root,'--git-dir',other,'rev-parse','refs/heads/topic'),f.head)
})
test('fix12 R1: cancellation of the original repair head prevents runner push and recovery',async t=>{
 const f=await fixture(t,{builderNoPush:true})
 const file=path.join(f.stateDir,'repairs',`${keyFor(repo,7)}.json`),rename=fs.rename.bind(fs)
 let cancelled=false
 t.mock.method(fs,'rename',async(from,to)=>{
  const result=await rename(from,to)
  if(!cancelled && to===file && (await currentRepair(f)).status==='push_pending') {
   cancelled=true
   assert.notEqual((await currentRepair(f)).head,f.head,'the candidate has a different head from its cancellation binding')
   ok(await f.run('queue-cancel',repo,'7',f.head))
   assert.equal(remoteTopic(f),f.head,'cancellation completes before any runner push')
  }
  return result
 })
 const adapter=createPrDeliveryAdapter(await loadDeliveryConfig(f.config),{env:f.env})
 const result=await adapter.execute('fix',{repo,pr:7})
 assert.equal(cancelled,true)
 assert.equal(result.data.code,130,JSON.stringify(result));assert.equal(result.data.cancelled,true)
 assert.equal(remoteTopic(f),f.head)
 const record=await currentRepair(f)
 assert.equal(record.status,'push_pending');assert.equal(record.testedHead,record.head)
 const recovered=await adapter.execute('fix',{repo,pr:7,repairId:record.id})
 assert.equal(recovered.data.code,130,JSON.stringify(recovered));assert.equal(remoteTopic(f),f.head)
 assert.equal((await f.read()).calls.length,1,'recovery must not repeat the builder or publish cancelled source')
})
test('fix12: queue-cancel cannot report success while a merge dispatch is still launching',async t=>{
 const f=await queueFixture(t);ok(await f.run('merge-enqueue',repo,'7',f.head))
 const marker=path.join(f.root,'cancel-returned-before-dispatch')
 // The cancel is offered at the last durable step before the provider write.
 const code=`import {spawn} from 'node:child_process';import fs from 'node:fs';
 import {loadDeliveryConfig,createPrDeliveryAdapter} from ${adapterModule};
 const a=createPrDeliveryAdapter(await loadDeliveryConfig(process.argv[1]),{onTransition:async s=>{
  if(s!=='provider:merge:requested')return
  const child=spawn(process.execPath,[${JSON.stringify(cli)},process.argv[1],'queue-cancel',${JSON.stringify(repo)},'7',${JSON.stringify(f.head)}],{stdio:'ignore'})
  let open=true;child.on('exit',c=>{if(open&&c===0)fs.writeFileSync(${JSON.stringify(marker)},'1')})
  await new Promise(r=>setTimeout(r,1500));open=false
 }});
 await a.execute('merge-queue',{repo:${JSON.stringify(repo)}});`
 await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',code,f.config],{env:f.env,stdio:'ignore'});child.on('error',reject);child.on('exit',resolve)})
 const early=await fs.access(marker).then(()=>true,()=>false),sent=(await f.read()).ghCalls.filter(merges).length
 assert.ok(!(early&&sent),'a cancellation that returned before dispatch must prevent the merge write')
})
test('fix12: update-branch launch fences cancellation before the provider write',async t=>{
 const f=await queueFixture(t);await advanceMain(f)
 ok(await f.run('merge-enqueue',repo,'7',f.head))
 const rename=fs.rename.bind(fs);let early=false,cancel
 t.mock.method(fs,'rename',async(from,to)=>{
  const result=await rename(from,to)
  if(String(to).includes('/updates/')) {
   let launching=true
   cancel=f.run('queue-cancel',repo,'7',f.head).then(r=>{if(launching&&r.code===0)early=true;return r})
   await pause(1500);launching=false
  }
  return result
 })
 const adapter=createPrDeliveryAdapter(await loadDeliveryConfig(f.config),{env:f.env})
 await adapter.execute('merge-queue',{repo});if(cancel)await cancel
 const sent=(await f.read()).ghCalls.filter(a=>a.includes('-X')&&a.some(v=>v.endsWith('/update-branch'))).length
 assert.ok(!(early&&sent),'a cancellation that returned before update dispatch must prevent its write')
})
test('fix12: failed acknowledgement publication retains intent and reconciles without resend',async t=>{
 const f=await queueFixture(t);ok(await f.run('merge-enqueue',repo,'7',f.head))
 const rename=fs.rename.bind(fs);let refuse=true
 t.mock.method(fs,'rename',async(from,to)=>{
  if(refuse&&String(to).includes('/effects/')&&JSON.parse(await fs.readFile(from)).state==='acknowledged'){
   refuse=false;throw Object.assign(Error('synthetic acknowledgement failure'),{code:'ENOSPC'})
  }
  return rename(from,to)
 })
 const adapter=createPrDeliveryAdapter(await loadDeliveryConfig(f.config),{env:f.env})
 await adapter.execute('merge-queue',{repo});assert.equal((await queueOf(f))[0].state,'effect-requested')
 await adapter.execute('merge-queue',{repo});const recovered=(await queueOf(f))[0];assert.equal(recovered.outcome?.status,'pass',JSON.stringify(recovered))
 assert.equal((await f.read()).ghCalls.filter(merges).length,1)
})
test('switchover: canonical checkout can never be selected for a fixer', async t => {
 const f=await fixture(t);f.g('checkout','topic')
 const r=await f.run('fix-pr',repo,'7','-')
 assert.notEqual(r.code,0);assert.match(r.stderr,/canonical checkout/)
 assert.equal((await f.read()).calls.length,0)
})
test('historical cancellation with a newer green check never retriggers CI', async t => {
 const f=await fixture(t)
 const state=await f.read()
 state.checkRuns=[{id:1,name:'test',head_sha:f.head,status:'completed',conclusion:'cancelled',app:{id:15368}},{id:2,name:'test',head_sha:f.head,status:'completed',conclusion:'success',app:{id:15368}}]
 await fs.writeFile(f.env.FAKE_PR,JSON.stringify(state))
 const adapter=createPrDeliveryAdapter(await loadDeliveryConfig(f.config),{env:f.env})
 const result=await adapter.exclusive(repo,7,()=>adapter.execute('ci-retrigger',{repo,pr:7}))
 assert.equal(result.status,'pass',JSON.stringify(result))
 assert.equal(result.data.retriggered,false)
 const after=await f.read();assert.equal(after.headRefOid,f.head)
 assert.equal(after.ghCalls.filter(a=>a.includes('POST')&&a.some(v=>v.endsWith('/git/commits'))).length,0)
})
test('fixture diagnostics distinguish API deadline from completed fake transport and quota hold',async t=>{
 const f=await fixture(t)
 const ready=await f.run('readiness',repo,'7');ok(ready)
 const state=await f.read();state.apiHang='fetch';state.ghCalls=[];await fs.writeFile(f.env.FAKE_PR,JSON.stringify(state))
 await fs.writeFile(f.config,JSON.stringify({...f.cfg,apiTimeoutMs:1000,attemptTimeoutMs:1800}))
 const stopped=await f.run('readiness',repo,'7');assert.equal(stopped.code,142,JSON.stringify(stopped))
 const match=/Fixture API phase diagnostics:\n([^\n]+)/.exec(stopped.stderr);assert.ok(match,stopped.stderr)
 const trace=JSON.parse(match[1]);assert.equal(trace.apiTimeoutMs,1000)
 assert.ok(trace.phases.some(p=>p.status==='stopped'&&p.code===142&&Number.isInteger(p.durationMs)),JSON.stringify(trace))
 const completed=(await fs.readFile(f.env.FAKE_PR+'.transport.jsonl','utf8')).trim().split('\n').map(JSON.parse)
 assert.ok(completed.some(p=>p.code===0&&Number.isFinite(p.elapsedMs)&&Number.isFinite(Date.parse(p.at))))
 assert.equal((await f.read()).ghCalls.length,1,'timeout stops this observation without retry')
 assert.equal((await f.read()).calls.length,0,'all model executables remain unused')
 const quota=await fixture(t,{apiFailure:true})
 const held=await quota.run('readiness',repo,'7');assert.equal(held.code,75,JSON.stringify(held))
 assert.match(held.stderr,/GitHub quota hold/);assert.equal((await quota.read()).ghCalls.length,1)
 const heldTrace=JSON.parse(/Fixture API phase diagnostics:\n([^\n]+)/.exec(held.stderr)[1])
 assert.ok(heldTrace.phases.some(p=>p.status==='stopped'&&p.code===75),JSON.stringify(heldTrace))
 await fs.writeFile(quota.config,'{broken')
 const invalid=await quota.run('readiness',repo,'7');assert.equal(invalid.code,9,JSON.stringify(invalid))
 const invalidTrace=JSON.parse(/Fixture API phase diagnostics:\n([^\n]+)/.exec(invalid.stderr)[1])
 assert.equal(invalidTrace.configObservation,'unreadable','diagnostic capture must preserve the original config failure')
})

test('one serial merge owner serves all three configured repositories', async t => {
  const fixtures = await Promise.all([fixture(t), fixture(t), fixture(t)])
  const names = ['jbookout/carr-system', 'jbookout/doctorcre-app', 'jbookout/software-factory']
  const repos = Object.fromEntries(fixtures.map((f, i) => [names[i], f.cfg.repos[repo]]))
  for (const [i, f] of fixtures.entries()) {
    const state = await f.read(); state.repo = names[i]
    await fs.writeFile(f.env.FAKE_PR, JSON.stringify(state))
    await fs.writeFile(f.config, JSON.stringify({ ...f.cfg, repos, stateDir: fixtures[0].stateDir }))
  }
  let contenders
  const owner = createPrDeliveryAdapter(await loadDeliveryConfig(fixtures[0].config), { env: fixtures[0].env,
    onTransition: async step => {
      if (step === 'provider:merge:requested') contenders = await Promise.all(fixtures.slice(1).map((f, i) => f.run('merge-one-core', names[i + 1], '7', f.head)))
    } })
  const owned = await owner.execute('merge-one-core', { repo: names[0], pr: 7, head: fixtures[0].head })
  assert.equal(owned.status, 'pass', JSON.stringify(owned))
  const first = [{ code: 0 }, ...contenders]
  assert.equal(first.filter(result => result.code === 0).length, 1, JSON.stringify(first))
  for (const [i, f] of fixtures.entries()) {
    if (first[i].code !== 0) { assert.equal(first[i].code, 75); ok(await f.run('merge-one-core', names[i], '7', f.head)) }
    const state = await f.read()
    assert.equal(state.state, 'MERGED')
    assert.equal(state.ghCalls.filter(merges).length, 1)
    assert.equal(f.g('rev-parse', 'origin/main'), state.mergeCommit.oid)
  }
})

test('required CI works without any custom review-authority configuration', async t => {
  const f = await fixture(t, { comments: [{body: 'An ordinary PR discussion', author: {login: 'someone'}}] })
  delete f.cfg.repos[repo].trustedReviewers
  await fs.writeFile(f.config, JSON.stringify(f.cfg))
  const result = await f.run('snapshot', repo, '7')
  ok(result)
  const snapshot = JSON.parse(result.stdout)
  assert.equal(snapshot.state, 'known')
  assert.equal(snapshot.ci.state, 'success')
})

test('waiting for the launch fence does not consume a healthy command execution budget', async t => {
  const { deliveryEffectId } = await import('../src/evidence.mjs')
  const f = await fixture(t, {}, { limits: { runsPer24h: 8, slots: 1, timeoutMs: 400 } })
  const key = deliveryEffectId({ repo, pr: 7, head: f.head, action: 'cancel' })
  const release = await acquireLease(path.join(f.stateDir, 'locks'), `launch-${key}`)
  t.after(release)
  const running = f.run('codex-guard', repo, '7', 'review', '/usr/bin/true')
  let started = false
  const until = Date.now() + 20000
  while (Date.now() < until) {
    const lines = await fs.readFile(path.join(f.stateDir, 'delivery.jsonl'), 'utf8').catch(() => '')
    if (lines.split('\n').filter(Boolean).map(JSON.parse).some(row => row.step === 'review' && row.status === 'started')) { started = true; break }
    await pause(10)
  }
  assert.equal(started, true)
  await pause(600)
  await release()
  ok(await running)
})

test('delivery refuses repositories without nonbypassable strict required CI', async t => {
  const f = await fixture(t, { rules: [{type:'required_status_checks',ruleset_id:1,parameters:{strict_required_status_checks_policy:false}}] })
  ok(await f.run('merge-enqueue',repo,'7',f.head))
  const result = await f.run('merge-queue','--once')
  assert.match(result.stdout + result.stderr, /INTEGRATION BASE NOT SERVER-ENFORCED/)
  const state = await f.read()
  assert.equal(state.state,'OPEN')
  assert.equal(state.ghCalls.filter(merges).length,0)
})

test('merge is refused when main moves after the final local base check', async t => {
  const f = await fixture(t, { advanceMainOnMerge: true })
  const base = f.g('rev-parse','origin/main')
  ok(await f.run('merge-enqueue',repo,'7',f.head))
  await f.run('merge-queue','--once')
  const state = await f.read()
  assert.notEqual(state.externalMain,base)
  assert.equal(state.state,'OPEN')
  assert.equal(state.mergeCommit,undefined)
  assert.equal(f.g('rev-parse','origin/main'),state.externalMain)
  assert.equal(state.ghCalls.filter(merges).length,1)
})

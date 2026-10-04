import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { acquireLease } from "../src/pr-delivery-state.mjs"

const cli = fileURLToPath(new URL("../bin/pr-delivery.mjs", import.meta.url))
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const fake = `#!/usr/bin/env node
const fs = require('node:fs'), cp = require('node:child_process');
const args = process.argv.slice(2), file = process.env.FAKE_PR;
const s = JSON.parse(fs.readFileSync(file));
const save = () => fs.writeFileSync(file, JSON.stringify(s));
const git = (...a) => cp.execFileSync('git', a, {encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const repo='fixture/new-repository';
const reproduction={argv:['node','-e',"const fs=require('fs'); console.log('property-checked'); process.exit(fs.existsSync('fix.txt')?0:1)"],acknowledgement:'property-checked'};
const brief=head=>({schema:'factory-delivery-brief/v1',repo,pr:7,head,reviewDigest:'d'.repeat(64),builderId:'builder-7',base:git('--git-dir',s.remote,'rev-parse','refs/heads/main'),environment:process.platform+'-'+process.arch+'-node-'+process.versions.node,
findings:[{id:'1',ownerRepo:repo,consumer:{repo,head},originalHead:head,contractPin:head,reproduction,ownedPaths:['fix.txt']}]});
s.headRefOid = git('--git-dir',s.remote,'rev-parse','refs/heads/topic');
const tool = require('node:path').basename(process.argv[1]);
if(tool === 'codex') {
 let prompt=''; process.stdin.on('data',b=>prompt+=b); process.stdin.on('end',()=>{
 s.calls.push({prompt,cwd:process.cwd(),args}); save();
 if(s.childCode) { console.error(s.childError??'synthetic child refusal');process.exit(s.childCode); }
 if(s.hang) { process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); return; }
 if(prompt.includes('REVIEW MODE:')) {
 if(s.reviewerCommit) { fs.writeFileSync('feature.txt','prohibited');git('add','feature.txt');git('commit','-qm','Prohibited reviewer edit'); }
 const blocked=s.blockOnce && !s.blocked;
 const body=(blocked ? 'REVIEW: BLOCKED' : 'APPROVE')+'\\nReviewed-SHA: '+s.headRefOid+'\\n\\n'+(blocked ? '1. fix defect\\nNon-blocking\\nNone\\nDelivery-Brief: '+JSON.stringify(brief(s.headRefOid)) : 'Non-blocking\\nNone');
 s.blocked=true; save(); fs.writeFileSync(args[args.indexOf('--output-last-message')+1], body);
 } else if(!s.noProgress) {
 const before=s.headRefOid;
 const repairValue=String(Date.now());fs.writeFileSync('fix.txt',repairValue); git('add','fix.txt'); git('commit','-qm','Repair'); git('push','-q','origin','HEAD:topic');
 const after=git('rev-parse','HEAD'), prior=s.comments.filter(c=>/^(REVIEW: BLOCKED|CHANGES REQUESTED)/.test(c.body)).at(-1);
 const b=prior?.body.match(/^Delivery-Brief: (.+)$/m);const task=b?JSON.parse(b[1]):null;
 const selfReproduction={argv:['node','-e',"const fs=require('fs');console.log('property-checked');process.exit(fs.existsSync('fix.txt')&&fs.readFileSync('fix.txt','utf8')==="+JSON.stringify(repairValue)+"?0:1)"],acknowledgement:'property-checked'};
 const selfReview={schema:'factory-self-review/v1',role:'builder',builderId:task?.builderId??'builder-7',repo,head:after,base:git('rev-parse','origin/main'),environment:process.platform+'-'+process.arch+'-node-'+process.versions.node,
 issues:[{id:'seed',repair:'corrected defect',check:'proof'}],checks:[{id:'proof',head:after,...selfReproduction,control:{head:before,argv:selfReproduction.argv}}],
 checklist:[...'abcdefghijk'].map(id=>({id,status:'checked',checks:['proof']})),requirements:['oracle','consumers','transitions','results','sinks','repository'].map(id=>({id,status:'checked',checks:['proof']})),
 testContract:{fixtureOwner:repo,resources:['isolated-worktree'],selectionDependencies:['fix.txt'],globalState:false},instructionEval:{status:'na',relevanceTest:'No registered steering surface matches fixture diff'}};
 const fix=task?{schema:'factory-fix-receipt/v1',role:'builder',builderId:task.builderId,repo,pr:7,priorHead:task.head,head:after,
 reviewDigest:require('crypto').createHash('sha256').update(prior.body.split(/^Delivery-Brief: /m)[0].trimEnd()).digest('hex'),
 resolutions:task.findings.map(f=>({id:f.id,ownerRepo:f.ownerRepo,head:after,consumer:{repo:f.consumer.repo,head:f.consumer.repo===f.ownerRepo&&f.consumer.head===f.originalHead?after:f.consumer.head},contractPin:after,changedPaths:['fix.txt'],reproduction:f.reproduction})),dependencies:[]}:null;
 fs.writeFileSync(args[args.indexOf('--output-last-message')+1],s.receiptOutput??JSON.stringify({fix,selfReview}));
 s.statusCheckRollup=[{status:'COMPLETED',conclusion:'SUCCESS'}]; s.mergeable='MERGEABLE'; s.mergeStateStatus='CLEAN'; save();
 }
 });
} else {
 s.ghCalls.push(args); save(); const action=args[1];
 if(args[0]==='api') {
 const route=args[1], params=new URL('https://fixture.invalid/'+route).searchParams;
 const page=Number(params.get('page')||1),pageSize=Number(params.get('per_page')||100);
 const respond=value=>console.log('HTTP/2.0 200 OK\\n\\n'+JSON.stringify(value));
 if(s.restCodes?.length) {const code=s.restCodes.shift();save();console.log('HTTP/2.0 '+code+' synthetic\\nRetry-After: 0\\n'+(s.quotaEvidence?'X-RateLimit-Remaining: 0\\n':'')+'\\n{}');process.exit(1);}
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
 else { console.error('unexpected REST route');process.exit(2); }
 } else if(action==='comment') {if(s.commentFailure==='before')process.exit(17);s.comments.push({body:args[args.indexOf('--body')+1],pr:Number(args[2]),author:{login:'reviewer'},user:{id:101,login:'reviewer'}}); save();if(s.commentFailure==='after')process.exit(17);}
 else if(action==='ready') {s.isDraft=false;save();}
 else if(action==='update-branch') {
 git('-C',s.checkout,'checkout','-q','topic'); git('-C',s.checkout,'fetch','-q','origin'); git('-C',s.checkout,'merge','--no-edit','origin/main'); git('-C',s.checkout,'push','-q','origin','topic');
 } else if(action==='merge') {
 if(!args.includes('--squash') || args.includes('--auto') || args[args.indexOf('--match-head-commit')+1]!==s.headRefOid) process.exit(2);
 git('-C',s.checkout,'fetch','-q','origin'); git('-C',s.checkout,'checkout','-q','main'); git('-C',s.checkout,'merge','--squash','origin/topic'); git('-C',s.checkout,'commit','-qm','Merge PR'); git('-C',s.checkout,'push','-q','origin','main');
 s.state='MERGED';s.mergeCommit={oid:git('-C',s.checkout,'rev-parse','HEAD')};save();
 } else {console.error('Unexpected gh action '+args.join(' '));process.exit(2);}
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
 const cfg={repos:{"fixture/new-repository":{checkout,originUrl:remote,worktreeRoot:path.join(root,"worktrees"),requiredChecks:[{name:"test"}],trustedReviewerIds:[101]}},stateDir,codex:{model:"fixture-model",effort:"high"},limits:{runsPer24h:8,slots:2,timeoutMs:5000},pollMs:5,retryMs:0,commandTimeoutMs:5000,...configOverrides}
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
  if(body) { const s=await read();
    if (/^(REVIEW: BLOCKED|CHANGES REQUESTED)/.test(body) && !body.includes("Delivery-Brief:")) {
      const reproduction={argv:["node","-e","const fs=require('fs'); console.log('property-checked'); process.exit(fs.existsSync('fix.txt')?0:1)"],acknowledgement:"property-checked"}
      body += "\nDelivery-Brief: "+JSON.stringify({schema:"factory-delivery-brief/v1",repo:"fixture/new-repository",pr:7,head,
        reviewDigest:"d".repeat(64),builderId:"builder-7",base:g("rev-parse","origin/main"),environment:`${process.platform}-${process.arch}-node-${process.versions.node}`,
        findings:[{id:"1",ownerRepo:"fixture/new-repository",consumer:{repo:"fixture/new-repository",head},originalHead:head,contractPin:head,reproduction,ownedPaths:["fix.txt"]}]})
    }
    s.comments.push({body,pr:number,author:{login:"reviewer"},user:{id:101,login:"reviewer"}});await fs.writeFile(env.FAKE_PR,JSON.stringify(s));return }
  const before=await read(), apiFailure=before.apiFailure, move=before.moveDuringChecks;before.apiFailure=false;before.moveDuringChecks=false;await fs.writeFile(env.FAKE_PR,JSON.stringify(before))
  const r=await run("review-pr","fixture/new-repository",String(number));assert.equal(r.code,0,JSON.stringify(r))
  const s=await read();s.apiFailure=apiFailure;s.moveDuringChecks=move;s.moveViewCount=0;s.calls=[];s.ghCalls=[];await fs.writeFile(env.FAKE_PR,JSON.stringify(s))
  await fs.writeFile(path.join(stateDir,"usage.json"),"[]") // approval is fixture setup, outside the exercised budget.
 }

 return {root,checkout,remote,head,stateDir,read,run,wrapper,approve,g,config,cfg,env}
}
const repo="fixture/new-repository"
const ok = r => assert.equal(r.code,0,JSON.stringify(r))

test("confirmation cannot dispatch from a blocked comment and a changed head without resolution proof",async t=>{
 const f=await fixture(t);await f.approve(`REVIEW: BLOCKED\nReviewed-SHA: ${f.head}\n1. functional defect`)
 const result=await f.wrapper("review-pr",repo,"7")
 assert.notEqual(result.code,0);assert.equal((await f.read()).calls.length,0)
 assert.match(result.stderr,/receipt|resolution|finding/i)
})

test("builder role cannot substitute for independent review provenance",async t=>{
 const f=await fixture(t);await f.approve()
 const id=/Factory-Review: ([0-9a-f-]+)/.exec((await f.read()).comments[0].body)[1]
 const file=path.join(f.stateDir,"reviews",`${id}.json`), receipt=JSON.parse(await fs.readFile(file))
 receipt.role="builder";await fs.writeFile(file,JSON.stringify(receipt))
 const result=await f.run("merge-one-core",repo,"7",f.head)
 assert.equal(result.code,4);assert.equal((await f.read()).state,"OPEN")
})

test("unchanged head/finding resolution admits one confirmation across concurrent retries",async t=>{
 const f=await fixture(t,{blockOnce:true});ok(await f.run("pr-loop",repo,"7","-","3"))
 const before=(await f.read()).calls.length
 const outcomes=await Promise.all([f.run("review-pr",repo,"7"),f.run("review-pr",repo,"7")])
 assert.ok(outcomes.every(r=>[2,75].includes(r.code)))
 assert.equal((await f.read()).calls.length,before)
 assert.equal((await fs.readdir(path.join(f.stateDir,"confirmations"))).length,1)
})

test("a resolved correctness receipt cannot suppress a later CI repair",async t=>{
 const f=await fixture(t,{blockOnce:true});ok(await f.run("pr-loop",repo,"7","-","3"))
 const before=await f.read();before.statusCheckRollup=[{status:"COMPLETED",conclusion:"FAILURE"}]
 await fs.writeFile(f.env.FAKE_PR,JSON.stringify(before))
 const repair=await f.run("ci-fix",repo,"7","-","--no-loop")
 ok(repair);assert.notEqual((await f.read()).headRefOid,before.headRefOid)
 assert.equal((await f.read()).calls.length,before.calls.length+1)
})

test("direct adapter contenders cannot both dispatch unchanged confirmation evidence",async t=>{
 const f=await fixture(t,{blockOnce:true});ok(await f.run("review-pr",repo,"7"));ok(await f.run("fix-pr",repo,"7","-"))
 const {loadDeliveryConfig,createPrDeliveryAdapter}=await import("../src/pr-delivery.mjs")
 const adapter=createPrDeliveryAdapter(await loadDeliveryConfig(f.config),{env:f.env})
 const results=await Promise.all([adapter.execute("review",{repo,pr:7}),adapter.execute("review",{repo,pr:7})])
 assert.equal(results.filter(r=>r.status==="pass").length,1)
 assert.equal(results.filter(r=>r.status==="fail").length,1)
})

for(const family of ["Undo", "producer pin"]) test(`owned ${family} dependency routes no wrong-repo fixer, wakes on tested owner pin and keeps distinct reviewer`,async t=>{
 const f=await fixture(t), owner=await fixture(t)
 const ownerRepo="fixture/owner"
 owner.g("checkout","topic")
 const file=family==="Undo"?"consumer.mjs":"producer.mjs"
 const oldSource=family==="Undo" ? 'export const undoRequest=()=>({operation:"undo"})\n' : 'export const advertised={}\n'
 const newSource=family==="Undo" ? 'export const undoRequest=()=>({operation:"undo",human_quote:"synthetic intent"})\n' : 'export const advertised={unfinished:true,diagnostic:true}\n'
 await fs.writeFile(path.join(owner.checkout,file),oldSource);owner.g("add",file);owner.g("commit","-qm","Original owned defect");owner.g("push","-q","origin","topic")
 const original=owner.g("rev-parse","HEAD")
 const code=family==="Undo" ? 'const {undoRequest}=await import("./consumer.mjs"); const undo=r=>r.human_quote?"accepted":"quote-required"; if(undo({operation:"undo"})!=="quote-required")throw Error("authority control");console.log("property-checked");process.exit(undo(undoRequest())==="accepted"?0:1)' : 'const {advertised}=await import("./producer.mjs");console.log("property-checked");process.exit(advertised.unfinished===true&&advertised.diagnostic===true?0:1)'
 const pinCheck='const fs=await import("node:fs");if(!fs.existsSync(process.env.FACTORY_CONSUMER_WORKTREE+"/feature.txt"))throw Error("consumer source");'
 const reproduction={argv:["node","--input-type=module","-e",pinCheck+code],acknowledgement:"property-checked"}
 const body=`REVIEW: BLOCKED\nReviewed-SHA: ${f.head}\n1. owned ${family} request incompatible`
 const brief={schema:"factory-delivery-brief/v1",repo,pr:7,head:f.head,reviewDigest:"d".repeat(64),builderId:"builder-7",base:f.g("rev-parse","origin/main"),environment:`${process.platform}-${process.arch}-node-${process.versions.node}`,
   findings:[{id:"1",ownerRepo,consumer:{repo,head:f.head},originalHead:original,contractPin:original,reproduction,ownedPaths:[file]}]}
 await f.approve(body+"\nDelivery-Brief: "+JSON.stringify(brief))
 f.cfg.repos[ownerRepo]={...owner.cfg.repos[repo]};await fs.writeFile(f.config,JSON.stringify(f.cfg))
 for(let i=0;i<3;i++) assert.equal((await f.wrapper("fix-pr",repo,"7","-")).code,2)
 assert.equal((await f.read()).calls.length,0)
 const proofFile=path.join(f.stateDir,"fixes",`${encodeURIComponent(repo)}-7.json`)
 const pending=JSON.parse(await fs.readFile(proofFile));assert.equal(pending.dependencies[0].ownerRepo,ownerRepo)
 assert.equal(pending.dependencies[0].contractPin,original)
 const events=(await fs.readFile(path.join(f.stateDir,"delivery.jsonl"),"utf8")).trim().split("\n").map(JSON.parse)
 assert.equal(events.filter(e=>e.status==="suspended").length,1)
 // A close/reopen cannot turn unresolved dependency evidence into confirmation.
 const closed=await f.read();closed.state="CLOSED";await fs.writeFile(f.env.FAKE_PR,JSON.stringify(closed))
 assert.equal((await f.run("review-pr",repo,"7")).code,8)
 closed.state="OPEN";await fs.writeFile(f.env.FAKE_PR,JSON.stringify(closed));assert.equal((await f.run("review-pr",repo,"7")).code,2)
 await fs.writeFile(path.join(owner.checkout,file),newSource);owner.g("add",file);owner.g("commit","-qm","Functional owner repair");owner.g("push","-q","origin","topic")
 const repaired=owner.g("rev-parse","HEAD")
 const receipt={schema:"factory-fix-receipt/v1",role:"builder",builderId:brief.builderId,repo,pr:7,priorHead:f.head,head:f.head,
   reviewDigest:(await import("../src/pr-delivery-receipts.mjs")).deliveryDigest(body),dependencies:[],
   resolutions:[{id:"1",ownerRepo,head:repaired,consumer:brief.findings[0].consumer,contractPin:repaired,changedPaths:[file],reproduction}]}
 const input=path.join(f.root,"resolution.json");await fs.writeFile(input,JSON.stringify(receipt))
 ok(await f.run("resolve-findings",repo,"7",input))
 ok(await f.wrapper("unstick","--once"))
 const result=await f.read();assert.equal(result.calls.length,1);assert.match(result.calls[0].prompt,/REVIEW MODE: confirm/)
 assert.ok(result.calls[0].prompt.includes(repaired))
 const id=/Factory-Review: ([0-9a-f-]+)/.exec(result.comments.at(-1).body)[1]
 const review=JSON.parse(await fs.readFile(path.join(f.stateDir,"reviews",`${id}.json`)))
 assert.equal(review.role,"independent-reviewer");assert.notEqual(review.executorId,brief.builderId)
 assert.deepEqual(await fs.readdir(owner.cfg.repos[repo].worktreeRoot),[],"proof worktrees disposed")
 assert.equal((await f.run("review-pr",repo,"7")).code,2);assert.equal((await f.read()).calls.length,1)
 // Rewording the description and resealing equivalent receipt JSON cannot
 // mint another confirmation while the finding/source/pins stay unchanged.
 const edited=await f.read();edited.comments[0].body=edited.comments[0].body.replace("request incompatible","request remains the same (description clarified)")
 await fs.writeFile(f.env.FAKE_PR,JSON.stringify(edited))
 receipt.reviewDigest=(await import("../src/pr-delivery-receipts.mjs")).deliveryDigest(edited.comments[0].body.split(/^Delivery-Brief: /m)[0].trimEnd())
 await fs.writeFile(input,JSON.stringify(Object.fromEntries(Object.entries(receipt).reverse())))
 ok(await f.run("resolve-findings",repo,"7",input))
 assert.equal((await f.run("review-pr",repo,"7")).code,2);assert.equal((await f.read()).calls.length,1)
})

test("pre-PR self-review admission runs real checks, catches a seeded defect and persists no canaries",async t=>{
 const f=await fixture(t)
 const acknowledgement="property-checked", argv=["node","-e","const fs=require('fs');console.log('property-checked');process.exit(fs.readFileSync('feature.txt','utf8').trim()==='repaired'?0:1)"]
 const receipt={schema:"factory-self-review/v1",role:"builder",builderId:"builder-7",repo,head:f.head,base:f.g("rev-parse","origin/main"),environment:`${process.platform}-${process.arch}-node-${process.versions.node}`,
   issues:[{id:"seed",repair:"CANARY_CLIENT CANARY_SECRET",check:"seed"}],checks:[{id:"seed",head:f.head,argv,acknowledgement,control:{head:f.g("rev-parse","origin/main"),argv}}],
   checklist:[..."abcdefghijk"].map(id=>({id,status:"checked",checks:["seed"]})),requirements:["oracle","consumers","transitions","results","sinks","repository"].map(id=>({id,status:"checked",checks:["seed"]})),
   testContract:{fixtureOwner:repo,resources:["isolated-worktree"],selectionDependencies:["feature.txt"],globalState:false},instructionEval:{status:"na",relevanceTest:"No registered steering surfaces match fixture paths"}}
 // Original base lacks feature.txt, so the original control also needs to emit
 // its acknowledgement and a definite property failure rather than an exception.
 argv[2]="const fs=require('fs');console.error('CANARY_CLIENT CANARY_SECRET');console.log('property-checked');process.exit(fs.existsSync('feature.txt')&&fs.readFileSync('feature.txt','utf8').trim()==='repaired'?0:1)"
 const file=path.join(f.root,"self.json");await fs.writeFile(file,JSON.stringify(receipt))
 assert.equal((await f.run("builder-preflight",repo,file)).code,2,"still-broken repair is rejected")
 f.g("checkout","topic");await fs.writeFile(path.join(f.checkout,"feature.txt"),"repaired");f.g("add","feature.txt");f.g("commit","-qm","Repair seeded property");f.g("push","-q","origin","topic")
 receipt.head=f.g("rev-parse","HEAD");receipt.checks[0].head=receipt.head;await fs.writeFile(file,JSON.stringify(receipt))
 ok(await f.run("builder-preflight",repo,file))
 const raw=await fs.readFile(path.join(f.stateDir,"builders",`${repo.replaceAll("/","--")}-${receipt.head}.json`),"utf8")
 assert.doesNotMatch(raw,/CANARY/);assert.equal(JSON.parse(raw).role,"builder")
 assert.equal((await f.read()).comments.length,0,"self-review never posts or creates independent review")
 f.cfg.repos[repo].instructionSurfaces=["feature.txt"];await fs.writeFile(f.config,JSON.stringify(f.cfg))
 assert.equal((await f.run("builder-preflight",repo,file)).code,2,"registered steering cannot skip instruction eval")
 receipt.instructionEval={status:"checked",checks:["seed"]};await fs.writeFile(file,JSON.stringify(receipt))
 ok(await f.run("builder-preflight",repo,file))
 receipt.checklist[0].checks=[];await fs.writeFile(file,JSON.stringify(receipt))
 assert.equal((await f.run("builder-preflight",repo,file)).code,2,"unchecked headings fail")
 for(const name of await fs.readdir(f.stateDir,{recursive:true})) {
   const saved=path.join(f.stateDir,name)
   if((await fs.stat(saved)).isFile()) assert.doesNotMatch(await fs.readFile(saved,"utf8"),/CANARY/)
 }
})

for(const action of ["builder-preflight","resolve-findings"]) test(`malformed ${action} receipt cannot echo canaries through JSON parser errors`,async t=>{
 const f=await fixture(t), file=path.join(f.root,"malformed-receipt.json")
 await fs.writeFile(file,'CANARY_CLIENT CANARY_SECRET')
 const result=await f.run(action,repo,...(action==="resolve-findings"?["7",file]:[file]))
 assert.notEqual(result.code,0);assert.doesNotMatch(result.stdout+result.stderr,/CANARY/)
})

test("approve -> enqueue -> serial squash merge verifies main",async t=>{
 const f=await fixture(t);ok(await f.run("review-pr",repo,"7"));const s=await f.read()
 assert.equal(s.comments[0].body.split("\n")[0],"APPROVE");assert.equal(s.comments[0].body.split("\n")[1],"Reviewed-SHA: "+f.head)
 for(const letter of "abcdefghijk") assert.match(s.calls[0].prompt,new RegExp("\\("+letter+"\\)"))
 assert.match(s.calls[0].prompt,/codebase-design/);assert.match(s.calls[0].prompt,/zero-tech-debt/);assert.match(s.calls[0].prompt,/swiftui-pro/)
 assert.ok(s.calls[0].args.includes("fixture-model"))
 ok(await f.run("auto-enqueue","--once"));ok(await f.run("merge-queue","--once"))
 const merged=await f.read();assert.equal(merged.state,"MERGED");assert.equal(f.g("rev-parse","origin/main"),merged.mergeCommit.oid)
 assert.ok(merged.ghCalls.some(a=>a[1]==="merge"&&a.includes("--match-head-commit")&&!a.includes("--auto")))
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
 const r=await f.run("pr-loop",repo,"7","-","3");assert.equal(r.code,2,JSON.stringify(r));assert.match(r.stdout,/NO-PROGRESS/);assert.equal((await f.read()).calls.length,1)
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
 assert.equal(r.code,142);assert.match(r.stdout,/CI-WAIT-TIMEOUT/)
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
 const f=await fixture(t,{}, {checksTimeoutMs:100});await f.approve()
 const s=await f.read();s.statusCheckRollup=[{__typename:"StatusContext",state:"ERROR"}]
 await fs.writeFile(f.env.FAKE_PR,JSON.stringify(s))
 const r=await f.run("merge-one-core",repo,"7",f.head)
 assert.equal(r.code,3);assert.match(r.stderr,/NONGREEN/);assert.equal((await f.read()).state,"OPEN")
})
test("already merged state must prove its commit exists on main and delivers the source",async t=>{
 const f=await fixture(t,{state:"MERGED",mergeCommit:{oid:"a".repeat(40)}})
 const r=await f.run("merge-one-core",repo,"7",f.head)
 assert.notEqual(r.code,0);assert.match(r.stderr,/MERGE.*(MAIN|SOURCE|VERIFY)/)
 assert.equal((await f.read()).ghCalls.filter(a=>a[1]==="merge").length,0)
})
test("per-PR budget stop survives invocations and loop stops",async t=>{
 const f=await fixture(t,{blockOnce:true},{limits:{runsPer24h:1,slots:1,timeoutMs:5000}})
 const r=await f.run("pr-loop",repo,"7","-","3");assert.equal(r.code,75);assert.match(r.stdout,/BUDGET-STOP/);assert.equal((await f.read()).calls.length,1)
 const again=await f.run("review-pr",repo,"7");assert.equal(again.code,75)
})
test("hard timeout kills a Codex that ignores SIGTERM and releases slot",async t=>{
 const f=await fixture(t,{hang:true},{limits:{runsPer24h:8,slots:1,timeoutMs:400}})
 const start=Date.now();const r=await f.run("review-pr",repo,"7");assert.equal(r.code,142);assert.match(r.stdout,/TIMEOUT/);assert.ok(Date.now()-start<4000)
 const s=await f.read();s.hang=false;await fs.writeFile(f.env.FAKE_PR,JSON.stringify(s));ok(await f.run("review-pr",repo,"7"))
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
 const r=await f.run("merge-one-core",repo,"7",f.head);assert.equal(r.code,1);assert.match(r.stderr,/fresh review/)
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
 assert.equal((await f.read()).ghCalls.filter(a=>a[1]==="merge").length,0)
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
test("automatic main merge preserves approval only after tree proof",async t=>{
 const f=await fixture(t);await f.approve();await fs.writeFile(path.join(f.checkout,"main-change.txt"),"main");f.g("add","main-change.txt");f.g("commit","-qm","Main advances");f.g("push","-q","origin","main")
 ok(await f.run("merge-one-core",repo,"7",f.head));assert.equal((await f.read()).state,"MERGED")
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
 for(let i=0;i<200;i++) {try{pid=Number(await fs.readFile(pidFile,"utf8"));break}catch{} await new Promise(r=>setTimeout(r,10))}
 assert.ok(pid,"guarded child started")
 t.after(()=>{try{process.kill(-pid,"SIGKILL")}catch{}})
 const claims=path.join(f.stateDir,"locks","codex-slot-0.claims")
 const [claim]=await fs.readdir(claims)
 const binding=JSON.parse(await fs.readFile(path.join(claims,claim)))
 assert.equal(binding.job.groupPid,pid,"lease records the actual child group")
 assert.ok(binding.job.deadline>Date.now(),"lease records the independent deadline")
 controller.kill("SIGKILL")
 await new Promise(r=>setTimeout(r,950))
 const alive=()=>{try{process.kill(pid,0);return true}catch{return false}}
 assert.equal(alive(),false,"child is stopped even without controller timeout")
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
 const after=await f.read();assert.equal(after.ghCalls.filter(a=>a[1]==="merge").length,1)
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
 assert.ok(results.some(r=>r.code===0));assert.ok(results.every(r=>[0,75].includes(r.code)),JSON.stringify(results));assert.equal((await f.read()).ghCalls.filter(a=>a[1]==="merge").length,1)
})
test("duplicate PR loops allow only one fixer/reviewer",async t=>{
 const f=await fixture(t,{noProgress:true});await f.approve("REVIEW: BLOCKED\nReviewed-SHA: "+f.head+"\n1. defect")
 const results=await Promise.all([f.run("pr-loop",repo,"7","-"),f.run("pr-loop",repo,"7","-")]);assert.deepEqual(results.map(r=>r.code).sort((a,b)=>a-b),[2,75]);assert.equal((await f.read()).calls.length,1)
})
test("manual merge edits invalidate deterministic re-approval",async t=>{
 const f=await fixture(t);await f.approve();await fs.writeFile(path.join(f.checkout,"main-change.txt"),"main");f.g("add","main-change.txt");f.g("commit","-qm","Main advances");f.g("push","-q","origin","main")
 f.g("checkout","topic");f.g("merge","--no-commit","origin/main");await fs.writeFile(path.join(f.checkout,"extra.txt"),"hand edit");f.g("add","extra.txt");f.g("commit","-qm","Merge with edits");f.g("push","-q","origin","topic");f.g("checkout","main")
 const r=await f.run("merge-one-core",repo,"7",f.head);assert.equal(r.code,2);assert.match(r.stderr,/HAND EDITS/);assert.equal((await f.read()).state,"OPEN")
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
test("named input permits one new fix but changed head alone cannot confirm unresolved findings",async t=>{
 const f=await fixture(t,{noProgress:true});await f.approve("REVIEW: BLOCKED\nReviewed-SHA: "+f.head+"\n1. defect")
 assert.equal((await f.wrapper("pr-loop",repo,"7","-","3")).code,2)
 f.cfg.repos[repo].dependencyRevision="tested-contract-revision-two";await fs.writeFile(f.config,JSON.stringify(f.cfg))
 assert.equal((await f.wrapper("unstick","--once")).code,2)
 assert.equal((await f.wrapper("stall-watch","--once")).code,2)
 assert.equal((await f.read()).calls.length,2)
 const wt=path.join(f.root,"worktrees","fix-7")
 await fs.writeFile(path.join(wt,"feature.txt"),"changed\n")
 for(const args of [["add","feature.txt"],["commit","-qm","New actionable head"],["push","-q","origin","topic"]]) execFileSync("git",args,{cwd:wt,env:f.env,stdio:"ignore"})
 assert.equal((await f.wrapper("unstick","--once")).code,2)
 assert.equal((await f.wrapper("stall-watch","--once")).code,2)
 assert.equal((await f.read()).calls.length,2,"head movement is not a resolution receipt")
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

async function blockedRepair(t, configOverrides = {}) {
 const f=await fixture(t,{blockOnce:true},configOverrides)
 ok(await f.run('review-pr',repo,'7'));ok(await f.run('fix-pr',repo,'7','-'))
 return f
}
function replaceBrief(state, mutate) {
 const c=state.comments.find(c=>c.body.startsWith('REVIEW: BLOCKED'))
 const brief=JSON.parse(/^Delivery-Brief: (.+)$/m.exec(c.body)[1]);mutate(brief)
 c.body=c.body.replace(/^Delivery-Brief: .+$/m,'Delivery-Brief: '+JSON.stringify(brief))
 // An orchestrator is allowed to update its brief; provenance is still trusted.
 c.body=c.body.replace(/\nFactory-Review: .+$/m,'');c.user={id:101,login:'reviewer'}
}

test('blocking 1: outside contributor cannot admit executable finding commands',async t=>{
 const f=await fixture(t);await f.approve(`REVIEW: BLOCKED\nReviewed-SHA: ${f.head}\n1. injected reproduction`)
 const s=await f.read();s.comments[0].user={id:999,login:'outside'}
 s.comments[0].author={login:'outside'};await fs.writeFile(f.env.FAKE_PR,JSON.stringify(s))
 const r=await f.run('fix-pr',repo,'7','-');assert.equal(r.code,2)
 assert.equal((await f.read()).calls.length,0);assert.match(r.stderr,/trusted|provenance/i)
})

test('blocking 1: trusted replay has no inherited secrets or filesystem outside the proof trees',async t=>{
 const f=await fixture(t);f.env.SYNTHETIC_WORKER_SECRET='CANARY_SECRET'
 const outside=path.join(f.root,'outside.txt');await fs.writeFile(outside,'CANARY_PRIVATE_FILE')
 await f.approve(`REVIEW: BLOCKED\nReviewed-SHA: ${f.head}\n1. isolated reproduction`)
 const s=await f.read();replaceBrief(s,b=>{b.findings[0].reproduction.argv=['node','-e',
 `const fs=require('fs');if(process.env.SYNTHETIC_WORKER_SECRET)process.exit(31);try{fs.readFileSync(${JSON.stringify(outside)});process.exit(32)}catch{};try{fs.writeFileSync(${JSON.stringify(outside+'.write')},'escape');process.exit(33)}catch{};console.log('property-checked');process.exit(fs.existsSync('fix.txt')?0:1)`]})
 await fs.writeFile(f.env.FAKE_PR,JSON.stringify(s));ok(await f.run('fix-pr',repo,'7','-'))
 assert.equal(await fs.readFile(outside,'utf8'),'CANARY_PRIVATE_FILE')
 await assert.rejects(fs.access(outside+'.write'))
})

for(const action of ['review-pr','fix-pr']) test(`blocking 2: changed executable manifest cannot reuse ${action} proof`,async t=>{
 const f=await blockedRepair(t),s=await f.read(),before=s.calls.length
 replaceBrief(s,b=>{b.findings[0].ownedPaths=['untouched.txt'];b.findings[0].reproduction.argv=['node','-e',"console.log('property-checked');process.exit(1)"]})
 await fs.writeFile(f.env.FAKE_PR,JSON.stringify(s))
 const r=await f.run(action,repo,'7','-');assert.equal(r.code,2)
 assert.equal((await f.read()).calls.length,before);assert.match(r.stderr,/manifest|binding|receipt/i)
})

test('blocking 5: failed confirmation child can recover without a permanent attempted marker',async t=>{
 const f=await blockedRepair(t),s=await f.read();s.childCode=17;await fs.writeFile(f.env.FAKE_PR,JSON.stringify(s))
 assert.equal((await f.run('review-pr',repo,'7')).code,17)
 const failed=await f.read();failed.childCode=0;await fs.writeFile(f.env.FAKE_PR,JSON.stringify(failed))
 ok(await f.run('review-pr',repo,'7'));assert.equal((await f.read()).comments.filter(c=>c.body.startsWith('APPROVE')).length,1)
})
for(const mode of ['before','after']) test(`blocking 5: reconcile ${mode}-posting network failure without another confirmation child`,async t=>{
 const f=await blockedRepair(t),s=await f.read();s.commentFailure=mode;await fs.writeFile(f.env.FAKE_PR,JSON.stringify(s))
 assert.equal((await f.run('review-pr',repo,'7')).code,17)
 const failed=await f.read(),starts=failed.calls.length;failed.commentFailure=null;await fs.writeFile(f.env.FAKE_PR,JSON.stringify(failed))
 ok(await f.run('review-pr',repo,'7'))
 const recovered=await f.read();assert.equal(recovered.calls.length,starts)
 assert.equal(recovered.comments.filter(c=>c.body.startsWith('APPROVE')).length,1)
})

test('blocking 6: losing confirmation contenders neither spend budget nor suspend successful approval',async t=>{
 const f=await blockedRepair(t,{limits:{runsPer24h:4,slots:2,timeoutMs:5000}})
 const {loadDeliveryConfig,createPrDeliveryAdapter}=await import('../src/pr-delivery.mjs')
 const adapter=createPrDeliveryAdapter(await loadDeliveryConfig(f.config),{env:f.env})
 const results=await Promise.all(Array.from({length:4},()=>adapter.execute('review',{repo,pr:7})))
 assert.equal(results.filter(r=>r.status==='pass').length,1)
 assert.equal(JSON.parse(await fs.readFile(path.join(f.stateDir,'usage.json'))).length,3)
 const wait=await fs.readFile(path.join(f.stateDir,'waits',`${encodeURIComponent(repo)}-7.json`),'utf8').catch(()=>null)
 assert.ok(!wait||JSON.parse(wait).status!=='suspended',wait)
 const inspected=await adapter.execute('pr:inspect',{repo,pr:7});assert.equal(inspected.status,'pass',JSON.stringify(inspected));assert.equal(inspected.data.ready,true)
})
for(const phase of ['fixes','confirmations','reviews']) test(`blocking 7: malformed persisted ${phase} JSON never reaches raw sinks`,async t=>{
 const f=await blockedRepair(t)
 if(phase!=='fixes')ok(await f.run('review-pr',repo,'7'))
 const dir=path.join(f.stateDir,phase),file=phase==='reviews'?/Factory-Review: ([0-9a-f-]+)/.exec((await f.read()).comments.at(-1).body)[1]+'.json':(await fs.readdir(dir)).find(n=>n.endsWith('.json'))
 await fs.writeFile(path.join(dir,file),'CANARY_CLIENT CANARY_SECRET')
 const r=phase==='reviews'?await (async()=>{const {loadDeliveryConfig,createPrDeliveryAdapter}=await import('../src/pr-delivery.mjs');const result=await createPrDeliveryAdapter(await loadDeliveryConfig(f.config),{env:f.env}).execute('pr:inspect',{repo,pr:7});return {code:result.data.code??0,stdout:JSON.stringify(result),stderr:''}})():await f.run('review-pr',repo,'7')
 assert.notEqual(r.code,0);assert.doesNotMatch(r.stdout+r.stderr,/CANARY/)
 assert.doesNotMatch(await fs.readFile(path.join(f.stateDir,'delivery.jsonl'),'utf8'),/CANARY/)
})

test('blocking 8: optional numbered notes and indented reproduction steps are outside the finding set',async t=>{
 const f=await fixture(t);await f.approve(`REVIEW: BLOCKED\nReviewed-SHA: ${f.head}\n1. blocking defect\n   1. reproduce it\n## Non-blocking\n1. optional improvement`)
 ok(await f.run('fix-pr',repo,'7','-'))
})

test('foreign-owner proof exercises the advanced PR consumer, including a broken current consumer',async t=>{
 const f=await fixture(t),owner=await fixture(t),ownerRepo='fixture/owner'
 owner.g('checkout','topic');await fs.writeFile(path.join(owner.checkout,'producer.txt'),'broken')
 owner.g('add','producer.txt');owner.g('commit','-qm','Defective producer');owner.g('push','-q','origin','topic')
 const original=owner.g('rev-parse','HEAD')
 const reproduction={argv:['node','-e',"const fs=require('fs');console.log('property-checked');process.exit(fs.readFileSync('producer.txt','utf8')==='repaired'&&fs.readFileSync(process.env.FACTORY_CONSUMER_WORKTREE+'/feature.txt','utf8')==='feature\\n'?0:1)"],acknowledgement:'property-checked'}
 const brief={schema:'factory-delivery-brief/v1',repo,pr:7,head:f.head,reviewDigest:'d'.repeat(64),builderId:'builder-7',base:f.g('rev-parse','origin/main'),environment:`${process.platform}-${process.arch}-node-${process.versions.node}`,
 findings:[{id:'1',ownerRepo,consumer:{repo,head:f.head},originalHead:original,contractPin:original,reproduction,ownedPaths:['producer.txt']}]}
 const body=`REVIEW: BLOCKED\nReviewed-SHA: ${f.head}\n1. foreign producer contract`
 await f.approve(body+'\nDelivery-Brief: '+JSON.stringify(brief));f.cfg.repos[ownerRepo]=owner.cfg.repos[repo];await fs.writeFile(f.config,JSON.stringify(f.cfg))
 await fs.writeFile(path.join(owner.checkout,'producer.txt'),'repaired');owner.g('add','producer.txt');owner.g('commit','-qm','Repair producer');owner.g('push','-q','origin','topic')
 const repaired=owner.g('rev-parse','HEAD')
 f.g('checkout','topic');await fs.writeFile(path.join(f.checkout,'feature.txt'),'broken-consumer');f.g('add','feature.txt');f.g('commit','-qm','Advance consumer');f.g('push','-q','origin','topic')
 const current=f.g('rev-parse','HEAD'),receipt={schema:'factory-fix-receipt/v1',role:'builder',builderId:'builder-7',repo,pr:7,priorHead:f.head,head:current,
 reviewDigest:(await import('../src/pr-delivery-receipts.mjs')).deliveryDigest(body),dependencies:[],
 resolutions:[{id:'1',ownerRepo,head:repaired,contractPin:repaired,changedPaths:['producer.txt'],consumer:{repo,head:f.head},reproduction}]}
 const file=path.join(f.root,'receipt.json');await fs.writeFile(file,JSON.stringify(receipt))
 const stale=await f.run('resolve-findings',repo,'7',file);assert.equal(stale.code,2);assert.match(stale.stderr,/consumer.*binding/i)
 receipt.resolutions[0].consumer.head=current;await fs.writeFile(file,JSON.stringify(receipt))
 const broken=await f.run('resolve-findings',repo,'7',file);assert.equal(broken.code,2);assert.match(broken.stderr,/repaired replay/i)
 // A later, working consumer is the only accepted repaired consumer.
 await fs.writeFile(path.join(f.checkout,'feature.txt'),'feature\n');f.g('add','feature.txt');f.g('commit','-qm','Repair consumer');f.g('push','-q','origin','topic')
 receipt.head=receipt.resolutions[0].consumer.head=f.g('rev-parse','HEAD');await fs.writeFile(file,JSON.stringify(receipt));ok(await f.run('resolve-findings',repo,'7',file))
})

test('failed confirmation records a failed lifecycle before retrying',async t=>{
 const f=await blockedRepair(t),s=await f.read();s.childCode=17;await fs.writeFile(f.env.FAKE_PR,JSON.stringify(s))
 assert.equal((await f.run('review-pr',repo,'7')).code,17)
 const dir=path.join(f.stateDir,'confirmations'),file=(await fs.readdir(dir))[0]
 const attempt=JSON.parse(await fs.readFile(path.join(dir,file)))
 assert.equal(attempt.status,'failed');assert.equal(attempt.code,17)
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

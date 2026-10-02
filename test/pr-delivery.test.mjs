import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

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
 if(s.hang) { process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); return; }
 if(prompt.includes('REVIEW MODE:')) {
 const body=(s.blockOnce && !s.blocked ? 'REVIEW: BLOCKED' : 'APPROVE')+'\\nReviewed-SHA: '+s.headRefOid+'\\n\\n'+(s.blockOnce && !s.blocked ? '1. fix defect\\nNon-blocking\\nNone' : 'Non-blocking\\nNone');
 s.blocked=true; save(); fs.writeFileSync(args[args.indexOf('--output-last-message')+1], body);
 } else if(!s.noProgress) {
 fs.writeFileSync('fix.txt',String(Date.now())); git('add','fix.txt'); git('commit','-qm','Repair'); git('push','-q','origin','HEAD:topic');
 s.statusCheckRollup=[{status:'COMPLETED',conclusion:'SUCCESS'}]; s.mergeable='MERGEABLE'; s.mergeStateStatus='CLEAN'; save();
 }
 });
} else {
 s.ghCalls.push(args); save(); const action=args[1];
 if(action==='view') console.log(JSON.stringify(s));
 else if(action==='list') console.log(JSON.stringify([s]));
 else if(action==='checks') {
 if(s.apiFailure) {console.error('GraphQL rate limit'); process.exit(1);}
 if(s.moveDuringChecks) { git('-C',s.checkout,'checkout','-q','topic'); fs.writeFileSync(s.checkout+'/moved.txt','moved'); git('-C',s.checkout,'add','moved.txt'); git('-C',s.checkout,'commit','-qm','Move head'); git('-C',s.checkout,'push','-q','origin','topic'); s.moveDuringChecks=false; save(); }
 if(args.includes('--json')) console.log(JSON.stringify(s.statusCheckRollup.map(c=>({state:c.conclusion==='SUCCESS'?'SUCCESS':c.status==='COMPLETED'?'FAILURE':'PENDING'}))));
 if(s.statusCheckRollup.some(c=>c.conclusion!=='SUCCESS')) process.exit(1);
 } else if(action==='comment') {s.comments.push({body:args[args.indexOf('--body')+1],author:{login:'reviewer'}}); save();}
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
 const state={ remote,checkout,number:7,title:"Fixture PR",state:"OPEN",headRefName:"topic",headRefOid:head,mergeStateStatus:"CLEAN",mergeable:"MERGEABLE",isDraft:false,author:{login:"builder"},comments:[],statusCheckRollup:[{status:"COMPLETED",conclusion:"SUCCESS"}],calls:[],ghCalls:[],...overrides }
 await fs.writeFile(env.FAKE_PR,JSON.stringify(state))
 const config=path.join(root,"config.json"), stateDir=path.join(root,"state")
 const cfg={repos:{"fixture/new-repository":{checkout,worktreeRoot:path.join(root,"worktrees")}},stateDir,codex:{model:"fixture-model",effort:"high"},limits:{runsPer24h:8,slots:2,timeoutMs:5000},pollMs:5,commandTimeoutMs:5000,...configOverrides}
 await fs.writeFile(config,JSON.stringify(cfg))
 const read=async()=>JSON.parse(await fs.readFile(env.FAKE_PR,"utf8"))
 const run=(...args)=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[cli,config,...args],{env,stdio:["ignore","pipe","pipe"]});let stdout="",stderr=""
  child.stdout.on("data",b=>stdout+=b);child.stderr.on("data",b=>stderr+=b);child.on("error",reject);child.on("close",code=>resolve({code,stdout,stderr}))
 })
 const approve=async(body="APPROVE\nReviewed-SHA: "+head+"\n\nIndependent review")=>{const s=await read();s.comments.push({body,author:{login:"reviewer"}});await fs.writeFile(env.FAKE_PR,JSON.stringify(s))}
 return {root,checkout,remote,head,stateDir,read,run,approve,g,config,cfg,env}
}
const repo="fixture/new-repository"
const ok = r => assert.equal(r.code,0,JSON.stringify(r))

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
test("NO-PROGRESS exits 2 instead of re-reviewing unchanged head",async t=>{
 const f=await fixture(t,{noProgress:true});await f.approve("REVIEW: BLOCKED\nReviewed-SHA: "+f.head+"\n1. defect")
 const r=await f.run("pr-loop",repo,"7","-","3");assert.equal(r.code,2);assert.match(r.stdout,/NO-PROGRESS/);assert.equal((await f.read()).calls.length,1)
})
test("per-PR budget stop survives invocations and loop stops",async t=>{
 const f=await fixture(t,{blockOnce:true},{limits:{runsPer24h:1,slots:1,timeoutMs:5000}})
 const r=await f.run("pr-loop",repo,"7","-","3");assert.equal(r.code,75);assert.match(r.stdout,/BUDGET-STOP/);assert.equal((await f.read()).calls.length,1)
 const again=await f.run("review-pr",repo,"7");assert.equal(again.code,75)
})
test("hard timeout kills a Codex that ignores SIGTERM and releases slot",async t=>{
 const f=await fixture(t,{hang:true},{limits:{runsPer24h:8,slots:1,timeoutMs:150}})
 const start=Date.now();const r=await f.run("review-pr",repo,"7");assert.equal(r.code,142);assert.match(r.stdout,/TIMEOUT/);assert.ok(Date.now()-start<4000)
 const s=await f.read();s.hang=false;await fs.writeFile(f.env.FAKE_PR,JSON.stringify(s));ok(await f.run("review-pr",repo,"7"))
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
test("transient GitHub error is requeued at most three times",async t=>{
 const f=await fixture(t,{apiFailure:true},{retryMs:0});await f.approve();ok(await f.run("merge-enqueue",repo,"7",f.head))
 for(let i=0;i<5;i++) ok(await f.run("merge-queue","--once"))
 const queue=JSON.parse(await fs.readFile(path.join(f.stateDir,"queue.json")))
 assert.equal(queue[0].attempts,4);assert.equal(queue[0].outcome.status,"fail");assert.equal((await f.read()).state,"OPEN")
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
test("API errors on approved PR stop without spending a CI-fix run",async t=>{
 const f=await fixture(t,{apiFailure:true});await f.approve();const r=await f.run("pr-loop",repo,"7");assert.notEqual(r.code,0);assert.equal((await f.read()).calls.length,0)
})

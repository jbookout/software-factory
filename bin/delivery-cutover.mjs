#!/usr/bin/env node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readJson, writeJson, withLease, pause } from '../src/pr-delivery-state.mjs'
import { importLegacyDelivery } from '../src/delivery-import.mjs'
import { loadDeliveryConfig } from '../src/pr-delivery.mjs'
import { physicalPath, requireSeparation } from '../deploy/orch/factory-verify.mjs'
import { installOrchestration, checkOrchestration } from '../src/orch-installation.mjs'
import { deliveryStatus } from '../src/delivery-daemon.mjs'

const legacy = ['review-pr.sh','pr-loop.sh','fix-pr.sh','ci-fix.sh','codex-guard.sh','branch-wt.sh','auto-enqueue.sh','merge-queue.sh',
  'merge-one-core.sh','merge-one.sh','merge-enqueue.sh','wait-green-enqueue.sh','merge-queue-keepalive.sh','approve-watcher.sh',
  'reapprove.sh','gate-merge.sh','unstick.sh','stall-watch.sh','shepherd.sh']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const exists = file => fs.access(file).then(() => true, e => { if(e.code==='ENOENT')return false;throw e })
const command = (argv, optional=false) => {
  try {return execFileSync(argv[0],argv.slice(1),{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:120000})}
  catch(error) {if(optional)return null;throw new Error(`${argv[0]} ${argv[1]} failed; inspect cutover logs`,{cause:error})}
}
const alive = pid => {try{process.kill(pid,0);return true}catch{return false}}

async function cutover(action) {
  const old=await fs.realpath(process.env.OLD ?? '/Users/booko/carr-system/out/orch')
  const factory=await fs.realpath(process.env.FACTORY ?? fileURLToPath(new URL('../',import.meta.url)))
  const configFile=path.resolve(process.env.CONFIG || path.join(os.homedir(),'carr-delivery','delivery-config.json'))
  process.env.CONFIG=configFile
  const modeFile=path.join(old,'delivery-mode'), mode=()=>fs.readFile(modeFile,'utf8').then(s=>s.trim(),e=>{if(e.code==='ENOENT')return 'legacy';throw e})
  if(action==='status') {console.log(`mode: ${await mode()}`);return}
  if(!['flip','rollback'].includes(action))throw new Error('usage: delivery-cutover.sh flip|rollback|status')
  const simulate=process.env.CUTOVER_SIMULATE==='1'
  const config=await loadDeliveryConfig(configFile)
  // Every deployed lane reads the same status and flag paths, including callers
  // restarted by fix-train. Require this binding before stopping a live writer.
  if((await physicalPath(config.orchestratorDir))!==old || (await physicalPath(config.statusFile))!==path.join(old,'delivery-status.txt'))
    throw new Error('config must bind orchestratorDir=OLD and statusFile=OLD/delivery-status.txt')
  requireSeparation(factory,old,await fs.realpath(configFile),await physicalPath(config.stateDir))
  const repos=Object.keys(config.repos)
  const journal=path.join(old,'delivery-cutover.json')
  const simulated=message=>fs.appendFile(path.join(old,'cutover-simulated.log'),message+'\n')
  const say=message=>console.log(`cutover: ${message}`)
  const run=async argv=>simulate?simulated(argv.join(' ')):command(argv)
  const snapshotLaunchd=async()=>{
    if(simulate)return []
    const jobs=[]
    for(const name of await fs.readdir(path.join(os.homedir(),'Library/LaunchAgents'))) {
      if(!name.endsWith('.plist'))continue
      const file=path.join(os.homedir(),'Library/LaunchAgents',name)
      const raw=command(['plutil','-convert','json','-o','-',file],true)
      if(!raw)continue
      const plist=JSON.parse(raw), args=[plist.Program,...(plist.ProgramArguments??[])].filter(Boolean)
      if(!args.some(arg=>/\/fix-train\.(sh|py)$/.test(arg) || legacy.some(name=>arg===path.join(old,name))))continue
      const target=`gui/${process.getuid()}/${plist.Label}`
      if(command(['launchctl','print',target],true)!==null)jobs.push({file,label:plist.Label,target,producer:args.some(arg=>/\/fix-train\.(sh|py)$/.test(arg))})
    }
    return jobs
  }
  const stopJobs=async jobs=>{
    if(simulate){await simulated('stop launchd jobs');return}
    for(const job of jobs){command(['launchctl','bootout',job.target],true);if(command(['launchctl','print',job.target],true)!==null)throw new Error('legacy launchd job still loaded')}
  }
  const stopLegacy=async()=>{
    if(simulate){await simulated('stop legacy processes');return}
    const processes=command(['ps','-axo','pid=,ppid=,command=']).split('\n').flatMap(line=>{
      const match=/^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
      return match?[{pid:Number(match[1]),ppid:Number(match[2]),cmd:match[3]}]:[]
    })
    const selected=new Set()
    for(const p of processes) {
      if(p.pid===process.pid || !/^(?:\S*\/)?(?:zsh|bash|sh|python3?|perl)\s/.test(p.cmd))continue
      const words=p.cmd.split(/\s+/), script=words.find(arg=>legacy.includes(path.basename(arg)))
      if(!script)continue
      const cwd=path.isAbsolute(script)?null:command(['lsof','-a','-p',String(p.pid),'-d','cwd','-Fn'],true)?.split('\n').find(s=>s.startsWith('n'))?.slice(1)
      if(path.dirname(script)===old || cwd===old)selected.add(p.pid)
    }
    let changed=true
    while(changed){changed=false;for(const p of processes)if(selected.has(p.ppid)&&!selected.has(p.pid)){selected.add(p.pid);changed=true}}
    for(const pid of selected)try{process.kill(pid,'SIGTERM')}catch(e){if(e.code!=='ESRCH')throw e}
    for(let i=0;i<100&&[...selected].some(alive);i++)await pause(100)
    if([...selected].some(alive))throw new Error('legacy process still running; source retained, inspect cutover journal')
  }
  const stopFactory=async()=>{
    if(simulate){await simulated('stop factory detached lanes');return}
    const dir=path.join(config.stateDir,'daemons')
    for(const name of await fs.readdir(dir).catch(e=>{if(e.code==='ENOENT')return [];throw e})) {
      if(!name.endsWith('.json'))continue
      const receipt=await readJson(path.join(dir,name))
      if(receipt.schema!=='factory-delivery-daemon/v1')throw new Error('invalid daemon receipt')
      const actual=command(['ps','-o','command=','-p',String(receipt.pid)],true)
      if(!actual || !actual.includes(path.join(factory,'bin/pr-delivery.mjs')))continue
      try{process.kill(-receipt.pid,'SIGTERM')}catch(e){if(e.code!=='ESRCH')throw e}
      for(let i=0;i<100&&alive(receipt.pid);i++)await pause(100)
      if(alive(receipt.pid))throw new Error('factory lane still running; rollback waits for owned work')
    }
  }
  async function rollback(record) {
    if(!record || record.phase==='rolled-back')throw new Error('no unfinished or factory cutover to roll back')
    // Validate all rollback bytes and collision conditions before stopping.
    const installation=await readJson(path.join(old,'.factory-orch.json'),null)
    const wrappers=new Set(record.installedExecutables ?? installation?.executables.map(e=>e.path) ?? [])
    record.installedExecutables=[...wrappers];await writeJson(journal,record)
    for(const {name,sha256} of record.files) {
      const saved=path.join(record.backup,name), destination=path.join(old,name)
      if(await exists(saved)) {
        if(hash(await fs.readFile(saved))!==sha256)throw new Error('legacy rollback hash mismatch')
        if(await exists(destination)&&!wrappers.has(name))throw new Error(`${destination} exists; refusing to overwrite`)
      } else if(!await exists(destination)||hash(await fs.readFile(destination))!==sha256)throw new Error('legacy rollback source missing')
    }
    await stopJobs(record.jobs.filter(j=>j.producer));await stopFactory()
    const dest=path.join(old,'_to_delete',`factory-wrappers-${Date.now()}`)
    await fs.mkdir(dest,{recursive:true,mode:0o700})
    for(const name of [...wrappers,'.factory-orch.json'])if(await exists(path.join(old,name))) {
      const original=record.files.find(file=>file.name===name)
      // A prior rollback may already have restored this source. Keep it in
      // place even if the installation receipt was moved before interruption.
      if(original && hash(await fs.readFile(path.join(old,name)))===original.sha256)continue
      await fs.rename(path.join(old,name),path.join(dest,name))
    }
    for(const {name} of record.files)if(await exists(path.join(record.backup,name)))await fs.rename(path.join(record.backup,name),path.join(old,name))
    const queue=await readJson(path.join(config.stateDir,'queue.json'),[]), queueFile=path.join(old,'merge-queue.txt')
    const prior=(await fs.readFile(queueFile,'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e})).split('\n').filter(Boolean)
    let carried=0
    for(const entry of queue.filter(e=>(e.state ?? (e.outcome ? 'acknowledged' : 'pending'))!=='acknowledged')) {
      if(prior.some(line=>line.startsWith(`${entry.repo} ${entry.pr} ${entry.head} `)))continue
      prior.push(`${entry.repo} ${entry.pr} ${entry.head} factory rollback: ${entry.note}`);carried++
    }
    await fs.writeFile(queueFile,prior.length?prior.join('\n')+'\n':'')
    say(`${carried} pending factory queue ${carried===1?'entry':'entries'} carried to merge-queue.txt`)
    const inflight=await readJson(path.join(config.stateDir,'inflight.json'),{})
    for(const job of Object.values(inflight).filter(j=>j.status==='pending')) {
      if(simulate)await simulated(`resume legacy PR ${job.repo} ${job.pr}`)
      else {const out=await fs.open(path.join(old,`loop-${job.repo.split('/')[1]}-${job.pr}.log`),'a',0o600);try{spawn('zsh',[path.join(old,'pr-loop.sh'),job.repo,String(job.pr),'-','3'],{cwd:old,detached:true,stdio:['ignore',out.fd,out.fd]}).unref()}finally{await out.close()}}
    }
    for(const name of ['merge-queue-keepalive.sh','auto-enqueue.sh','unstick.sh'])if(await exists(path.join(old,name))) {
      if(simulate)await simulated(`restart legacy ${name}`)
      else {const out=await fs.open(path.join(old,`${name}.rollback.log`),'a',0o600);try{spawn('zsh',[path.join(old,name)],{cwd:old,detached:true,stdio:['ignore',out.fd,out.fd]}).unref()}finally{await out.close()}}
    }
    for(const job of record.jobs)if(simulate || command(['launchctl','print',job.target],true)===null)await run(['launchctl','bootstrap',`gui/${process.getuid()}`,job.file])
    await fs.writeFile(modeFile,'legacy\n');record.phase='rolled-back';await writeJson(journal,record)
    say(`legacy scripts restored byte-for-byte; factory wrappers retained in ${dest}`)
  }
  async function smoke(record) {
    try {
      for (const repo of repos) {
        let output
        try { output=command([process.execPath,path.join(old,'factory-verify.mjs'),old,'delivery-smoke',repo]) }
        catch (error) { throw new Error(`read-only smoke failed for ${repo}: ${error.cause?.stderr?.trim() || error.message}`) }
        const result=JSON.parse(output)
        if(result.repo!==repo || !Number.isSafeInteger(result.pulls) || result.pulls<0)throw new Error(`invalid smoke result for ${repo}`)
        record.smoke ??= {}
        record.smoke[repo]={pulls:result.pulls,at:new Date().toISOString()}
        await writeJson(journal,record)
        say(`smoke ${repo}: read ${result.pulls} open pull requests`)
      }
    } catch (error) {
      record.smokeFailure=error.message;await writeJson(journal,record)
      try { await rollback(record) }
      catch (rollbackError) {throw new Error(`${error.message}; automatic rollback failed: ${rollbackError.message}`)}
      throw new Error(`${error.message}; automatic rollback completed`)
    }
  }
  await withLease(path.join(config.stateDir,'locks'),'cutover',async()=>{
    let record=await readJson(journal,null)
    if(action==='flip') {
      if(await mode()==='factory'){if(!record || record.phase!=='factory')throw new Error('factory mode requires completed cutover journal');await smoke(record);for(const repo of repos)await run([process.execPath,path.join(factory,'bin/pr-delivery.mjs'),configFile,'deliver',repo,'--detach']);say('factory lanes resumed from detached receipts');return}
      if(record && record.phase!=='rolled-back')throw new Error('unfinished cutover journal; run rollback before another flip')
      // Validate the same source/config binding during rehearsal and live flip.
      {
        const probe=await fs.mkdtemp(path.join(path.dirname(old),'delivery-preflight-'))
        await installOrchestration(factory,probe,configFile);await checkOrchestration(probe)
      }
      const backup=path.join(old,'_to_delete',`orch-legacy-${Date.now()}`)
      await fs.mkdir(backup,{recursive:true,mode:0o700})
      const files=[]
      for(const name of legacy)if(await exists(path.join(old,name)))files.push({name,sha256:hash(await fs.readFile(path.join(old,name)))})
      record={schema:'factory-cutover/v1',phase:'prepared',backup,files,jobs:await snapshotLaunchd(),repos}
      await writeJson(journal,record)
      await stopJobs(record.jobs);await stopLegacy()
      record.phase='stopped';await writeJson(journal,record)
      say((await importLegacyDelivery(config,old)).message)
      if(simulate)await simulated(`import-legacy ${old}`)
      await fs.writeFile(path.join(backup,'MANIFEST'),files.map(f=>`${f.sha256}  ${f.name}\n`).join(''))
      for(const {name} of files)await fs.rename(path.join(old,name),path.join(backup,name))
      record.phase='moved';await writeJson(journal,record)
      await installOrchestration(factory,old,configFile)
      record.installedExecutables=(await readJson(path.join(old,'.factory-orch.json'))).executables.map(e=>e.path)
      record.phase='installed';await writeJson(journal,record)
      await checkOrchestration(old);await smoke(record)
      for(const repo of repos)await run([process.execPath,path.join(factory,'bin/pr-delivery.mjs'),configFile,'deliver',repo,'--detach'])
      for(const job of record.jobs.filter(j=>j.producer))await run(['launchctl','bootstrap',`gui/${process.getuid()}`,job.file])
      await fs.writeFile(modeFile,'factory\n');record.phase='factory';await writeJson(journal,record)
      say(`legacy scripts retained in ${backup}`);say(`${simulate?'simulated detached deliver':'detached deliver'} started for ${repos.length} repositories; status ${config.statusFile ?? path.join(config.stateDir,'status.txt')}`)
    } else await rollback(record)
  },{waitMs:5000,pollMs:50})
}
try{await cutover(process.argv[2]??'status')}
catch(error){
  console.error(`cutover: ${error.message}`)
  if(process.env.CONFIG){const c=await readJson(process.env.CONFIG,null).catch(()=>null);if(c?.stateDir)await deliveryStatus({...c,stateDir:path.resolve(path.dirname(process.env.CONFIG),c.stateDir)},{step:'cutover',message:error.message,nextAction:'inspect-journal-and-rollback'})}
  process.exitCode=1
}

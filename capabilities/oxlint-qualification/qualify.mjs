import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {ESLint} from 'eslint'
import {runProcess} from '../../src/process-runner.mjs'
import {verificationSource} from '../../src/local-verification.mjs'
import {peakRssBytes} from '../../src/rusage.mjs'
import {installOxlint,sha,VERSION} from './install.mjs'
import {normalizeEslint,normalizeOxlint,assertDiagnosticParity,assertParserFailure} from './diagnostics.mjs'
import {SEEDS} from './corpus.mjs'
const sourceRoot=fileURLToPath(new URL('../../',import.meta.url))
const fixture=path.join(sourceRoot,'capabilities/tailwind-design-system-lint/fixture')
const policies=['no-arbitrary-values','no-inline-styles','no-raw-colors','no-restyle','no-unknown-classes','require-static-classes'].map(x=>'shadcn/'+x)
const writeJson=(p,d)=>fs.writeFile(p,JSON.stringify(d,null,2)+'\n',{flag:'wx',mode:0o600})
async function sourceFiles(dir){
 const rows=[]
 for(const entry of await fs.readdir(dir,{withFileTypes:true})){
  const p=path.join(dir,entry.name)
  if(entry.isDirectory())rows.push(...await sourceFiles(p))
  else if(/\.[cm]?[jt]sx?$/.test(p)){assert(entry.isFile(),'corpus source must be regular');rows.push(p)}
 }
 return rows.sort()
}
export async function measure(command,args,cwd,directory,label){
 const report=path.join(directory,label+'.rusage')
 await fs.writeFile(report,'',{flag:'wx',mode:0o600})
 const started=performance.now()
 const result=await runProcess(['/usr/bin/time',process.platform==='darwin'?'-l':'-v','-o',report,...command,...args],
  {cwd,env:{PATH:process.env.PATH,LANG:'C.UTF-8'},timeoutMs:30000})
 assert(Number.isInteger(result.code),'missing process exit')
 const log=result.stdout+result.stderr
 await fs.writeFile(path.join(directory,label+'.log'),log,{flag:'wx',mode:0o600})
 const resource=await fs.readFile(report)
 return {...result,measurement:{exitCode:result.code,controllerWallMs:performance.now()-started,peakRssBytes:peakRssBytes(resource.toString(),process.platform),
  resourceReport:label+'.rusage',resourceReportDigest:sha(resource),log:label+'.log',logDigest:sha(log)}}
}
export async function runQualification(){
 const directory=await fs.mkdtemp(path.join(process.env.FACTORY_ATTEMPT_DIR??os.tmpdir(),'oxlint-'))
 const receipt={schema:'oxlint-qualification/v1',status:'running',version:VERSION,directory,source:await verificationSource(sourceRoot),
  scope:'Fourteen copied/seeded Factory shadcn fixture files; no adoption, native-rule or type-aware qualification',
  measurementLimits:'Three fresh-process pairs on one host; first/repeated runs do not flush host/upstream caches. Native pool two. Wall includes supervision; dedicated OS rusage retained. No hardware cold-start, repository-wide speedup, autofix/suggestion or equivalent parser-message claim.'}
 try{
  assert(['darwin','linux'].includes(process.platform),'unsupported measurement platform')
  const installer=await installOxlint(path.join(directory,'installer'));receipt.installer=installer.receipt
  const corpus=path.join(directory,'corpus');await fs.cp(fixture,corpus,{recursive:true})
  await fs.symlink(path.join(sourceRoot,'node_modules'),path.join(corpus,'node_modules'),'dir')
  for(const [relative,text] of Object.entries(SEEDS)){
   const p=path.join(corpus,'src',relative);await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,text,{flag:'wx'})
  }
  const paths=await sourceFiles(path.join(corpus,'src'));assert.equal(paths.length,14,'declared corpus changed')
  const eslint=new ESLint({cwd:corpus,overrideConfigFile:path.join(corpus,'eslint.config.mjs')})
  const base=await eslint.calculateConfigForFile(path.join(corpus,'src/valid.tsx'))
  assert.deepEqual(Object.keys(base.rules).sort(),policies.toSorted(),'uninventoried active rule')
  const convert=r=>[r[0]===2?'error':r[0]===1?'warn':'off',...r.slice(1)]
  const rules=Object.fromEntries(Object.entries(base.rules).map(([k,v])=>[k,convert(v)])),overrides=[],resolved={}
  for(const p of paths){
   const relative=path.relative(corpus,p).split(path.sep).join('/'),config=await eslint.calculateConfigForFile(p)
   assert.deepEqual(Object.keys(config.rules).sort(),policies.toSorted(),'per-file inventory changed')
   assert.deepEqual(config.settings,base.settings,'per-file settings need qualification')
   resolved[relative]=config.rules
   const changes=Object.fromEntries(Object.entries(config.rules).filter(([k,v])=>JSON.stringify(v)!==JSON.stringify(base.rules[k])).map(([k,v])=>[k,convert(v)]))
   if(Object.keys(changes).length)overrides.push({files:[relative],rules:changes})
  }
  const candidateConfig={categories:Object.fromEntries(['correctness','suspicious','pedantic','style','restriction','perf','nursery'].map(c=>[c,'off'])),
   plugins:[],jsPlugins:[{name:'shadcn',specifier:'@shadcn/lint'}],settings:base.settings,rules,overrides}
  await writeJson(path.join(corpus,'.oxlintrc.json'),candidateConfig)
  const packages={},declared=JSON.parse(await fs.readFile(path.join(sourceRoot,'package.json'))).devDependencies
  for(const name of ['eslint','@shadcn/lint','@typescript-eslint/parser','tailwindcss']){
   packages[name]=JSON.parse(await fs.readFile(path.join(sourceRoot,'node_modules',name,'package.json'))).version
   assert.equal(packages[name],declared[name],'installed baseline pin differs')
  }
  receipt.inventory={rules:base.rules,resolvedRules:resolved,settings:base.settings,packages,candidateConfigDigest:sha(JSON.stringify(candidateConfig)),
   sourceConfigDigest:sha(await fs.readFile(path.join(fixture,'eslint.config.mjs'))),
   corpus:Object.fromEntries(await Promise.all(paths.map(async p=>[path.relative(corpus,p).split(path.sep).join('/'),sha(await fs.readFile(p))])))}
  const baselineCommand=[process.execPath,path.join(sourceRoot,'node_modules/eslint/bin/eslint.js')]
  const baselineArgs=['--config','eslint.config.mjs','--format','json']
  const candidateArgs=['--config','.oxlintrc.json','--disable-nested-config','--threads=2','--format','json']
  const cleanInputs=['src/valid.tsx','src/custom-properties.tsx','src/components/ui/button.tsx']
  const cb=await measure(baselineCommand,[...baselineArgs,...cleanInputs],corpus,directory,'clean-baseline')
  const cc=await measure(installer.command,[...candidateArgs,...cleanInputs],corpus,directory,'clean-candidate')
  assert.equal(cb.code,0,'clean baseline exit');assert.equal(cc.code,0,'clean candidate exit')
  assert.equal((await normalizeEslint(JSON.parse(cb.stdout),corpus)).length,0)
  assert.equal((await normalizeOxlint(JSON.parse(cc.stdout),corpus)).length,0)
  receipt.cleanAcceptance={files:cleanInputs,baseline:cb.measurement,candidate:cc.measurement};receipt.observations=[]
  for(let n=0;n<3;n++){
   const eb=await measure(baselineCommand,[...baselineArgs,'src'],corpus,directory,'baseline-'+n)
   const oc=await measure(installer.command,[...candidateArgs,'src'],corpus,directory,'candidate-'+n)
   assert.equal(eb.code,1,'invalid baseline must fail');assert.equal(oc.code,eb.code,'candidate exit differs')
   const er=JSON.parse(eb.stdout),or=JSON.parse(oc.stdout)
   assert.equal(or.number_of_files,paths.length,'candidate skipped inputs');assert.equal(or.number_of_rules,policies.length,'candidate rules differ');assert.equal(or.threads_count,2,'unbounded pool')
   const expected=await normalizeEslint(er,corpus),actual=await normalizeOxlint(or,corpus)
   await writeJson(path.join(directory,'baseline-'+n+'.normalized.json'),expected);await writeJson(path.join(directory,'candidate-'+n+'.normalized.json'),actual)
   assert(policies.every(rule=>expected.some(d=>d.rule===rule)),'missing configured-policy negative')
   const ui=expected.filter(d=>d.file==='src/components/ui/overrides.tsx')
   assert(!ui.some(d=>['shadcn/no-restyle','shadcn/no-arbitrary-values','shadcn/require-static-classes'].includes(d.rule)),'UI exemptions lost')
   assert(['shadcn/no-raw-colors','shadcn/no-inline-styles','shadcn/no-unknown-classes'].every(rule=>ui.some(d=>d.rule===rule)),'other UI policies lost')
   const diagnosticDigest=rows=>sha(JSON.stringify(rows.map(r=>JSON.stringify(r)).sort()))
   receipt.observations.push({sequence:n+1,cacheState:n?'repeated-process':'first-process',baselineCount:expected.length,candidateCount:actual.length,
    baseline:eb.measurement,candidate:oc.measurement,baselineDigest:diagnosticDigest(expected),candidateDigest:diagnosticDigest(actual)})
   assertDiagnosticParity(expected,actual)
  }
  const broken='const = ;\n';await fs.writeFile(path.join(corpus,'src/broken-control.tsx'),broken,{flag:'wx'})
  receipt.parserFailureControls=[]
  for(const [name,command,args] of [['baseline',baselineCommand,baselineArgs],['candidate',installer.command,candidateArgs]]){
   const run=await measure(command,[...args,'src/broken-control.tsx'],corpus,directory,'parser-'+name)
   const diagnostic=await assertParserFailure(name,run,corpus)
   receipt.parserFailureControls.push({engine:name,...run.measurement,diagnostic})
  }
  receipt.parserFailureDigest=sha(broken)
  assert.deepEqual(await verificationSource(sourceRoot),receipt.source,'source changed during qualification')
  receipt.status='fixture-qualified'
 }catch(error){receipt.status='failed';receipt.reason=error.message}
 await writeJson(path.join(directory,'receipt.json'),receipt);console.log(JSON.stringify(receipt))
 if(receipt.status!=='fixture-qualified')throw new Error('Oxlint qualification failed; '+path.join(directory,'receipt.json')+': '+receipt.reason)
 return receipt
}
if(process.argv[1]===fileURLToPath(import.meta.url))await runQualification()

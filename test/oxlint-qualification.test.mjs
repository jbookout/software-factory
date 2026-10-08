import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {validateToolLock,sha} from '../capabilities/oxlint-qualification/install.mjs'
import {normalizeEslint,normalizeOxlint,assertDiagnosticParity} from '../capabilities/oxlint-qualification/diagnostics.mjs'
import {measure} from '../capabilities/oxlint-qualification/qualify.mjs'
async function owned(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'oxlint-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}))
 await fs.mkdir(path.join(root,'src'));return root
}
test('tool lock rejects unknown packages, version drift, foreign URLs and missing integrity',async()=>{
 const lock=JSON.parse(await fs.readFile(new URL('../capabilities/oxlint-qualification/tool/package-lock.json',import.meta.url)));validateToolLock(lock)
 for(const mutate of [x=>x.packages[''].dependencies.oxlint='latest',x=>x.packages['node_modules/unknown']={...x.packages['node_modules/oxlint']},
  x=>x.packages['node_modules/oxlint'].version='0',x=>x.packages['node_modules/oxlint'].resolved='https://example.com/tool.tgz',
  x=>delete x.packages['node_modules/oxlint'].integrity,x=>delete x.packages['node_modules/@oxlint/binding-linux-x64-gnu']]){
  const broken=structuredClone(lock);mutate(broken);assert.throws(()=>validateToolLock(broken))
 }
})
test('parity preserves duplicate counts, severity, rule, range and complete repair text',()=>{
 const row={file:'src/a.tsx',rule:'shadcn/no-restyle',severity:2,start:1,end:2,message:'use the declared variant'}
 assertDiagnosticParity([row,row],[row,row])
 for(const actual of [[row],[row,{...row,severity:1}],[row,{...row,rule:'other'}],[row,{...row,start:0}],[row,{...row,end:3}],[row,{...row,message:'shorter'}],[row,row,row]])
  assert.throws(()=>assertDiagnosticParity([row,row],actual),/parity differs/)
})
test('normalization preserves Unicode and CRLF ranges across byte and UTF-16 engines',async t=>{
 const root=await owned(t),text='🧭 café\r\nabc\n',file=path.join(root,'src/a.tsx');await fs.writeFile(file,text)
 const expected=await normalizeEslint([{filePath:file,messages:[{ruleId:'shadcn/no-restyle',severity:2,line:2,column:1,endLine:2,endColumn:4,message:'repair'}]}],root)
 const actual=await normalizeOxlint({diagnostics:[{filename:'src/a.tsx',code:'shadcn(no-restyle)',severity:'error',message:'repair',labels:[{span:{offset:Buffer.byteLength('🧭 café\r\n'),length:3}}]}]},root)
 assertDiagnosticParity(expected,actual);assert.equal(expected[0].start,'🧭 café\r\n'.length)
 const physical=await normalizeEslint([{filePath:await fs.realpath(file),messages:[{ruleId:'shadcn/no-restyle',severity:2,line:2,column:1,endLine:2,endColumn:4,message:'repair'}]}],root)
 assertDiagnosticParity(expected,physical)
})
test('malformed diagnostics cannot escape corpus, follow links or clamp invalid byte spans',async t=>{
 const root=await owned(t);await fs.writeFile(path.join(root,'src/a.tsx'),'🧭\n')
 const make=(filename,offset,length)=>({diagnostics:[{filename,code:'shadcn(no-restyle)',severity:'error',message:'repair',labels:[{span:{offset,length}}]}]})
 await assert.rejects(normalizeOxlint(make('../outside.tsx',0,1),root),/escaped corpus/)
 await fs.symlink('a.tsx',path.join(root,'src/link.tsx'));await assert.rejects(normalizeOxlint(make('src/link.tsx',0,1),root),/regular/)
 await assert.rejects(normalizeOxlint(make('src/a.tsx',0,100),root),/invalid candidate span/)
 await assert.rejects(normalizeOxlint(make('src/a.tsx',1,1),root),/splits UTF-8/)
 await assert.rejects(normalizeOxlint(make('src/a.tsx',3,1),root),/splits UTF-8/)
 const outside=await fs.mkdtemp(path.join(os.tmpdir(),'oxlint-outside-'));t.after(()=>fs.rm(outside,{recursive:true,force:true}))
 await fs.writeFile(path.join(outside,'a.tsx'),'abc');await fs.symlink(outside,path.join(root,'src/directory-link'),'dir')
 await assert.rejects(normalizeOxlint(make('src/directory-link/a.tsx',0,1),root),/escaped corpus/)
})
test('checker stderr cannot forge dedicated resource evidence and failure exit remains visible',async t=>{
 const root=await owned(t),cli=path.join(root,'fake.cjs')
 await fs.writeFile(cli,"console.error('Maximum resident set size (kbytes): 1'); console.error('1 maximum resident set size'); process.exit(1)")
 const result=await measure([process.execPath,cli],[],root,root,'failure');assert.equal(result.code,1);assert(result.measurement.peakRssBytes>1024)
 assert.equal(sha(await fs.readFile(path.join(root,'failure.rusage'))),result.measurement.resourceReportDigest)
 assert.equal(sha(await fs.readFile(path.join(root,'failure.log'))),result.measurement.logDigest)
})

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

function position(text,line,column){
 assert(Number.isInteger(line)&&line>0&&Number.isInteger(column)&&column>0,'invalid source position')
 const lines=text.split('\n')
 assert(line<=lines.length&&column<=lines[line-1].length+1,'source position outside file')
 return lines.slice(0,line-1).reduce((n,l)=>n+l.length+1,0)+column-1
}
async function source(corpus,filename){
 assert(typeof filename==='string','diagnostic filename missing')
 const absolute=path.resolve(corpus,filename),realRoot=await fs.realpath(corpus)
 const allowed=p=>p.startsWith('src/')&&!p.split('/').includes('..')
 const relativeTo=p=>path.relative(p,absolute).split(path.sep).join('/')
 assert(allowed(relativeTo(path.resolve(corpus)))||allowed(relativeTo(realRoot)),'diagnostic source escaped corpus')
 assert((await fs.lstat(absolute)).isFile(),'diagnostic source must be regular')
 const realFile=await fs.realpath(absolute),relative=path.relative(realRoot,realFile).split(path.sep).join('/')
 assert(allowed(relative),'diagnostic source escaped corpus through directory link')
 return {file:relative,text:await fs.readFile(absolute,'utf8')}
}
export async function normalizeEslint(results,corpus){
 assert(Array.isArray(results),'baseline JSON shape')
 const rows=[]
 for(const result of results){
  const {file,text}=await source(corpus,result.filePath)
  for(const d of result.messages){
   assert(typeof d.ruleId==='string'&&typeof d.message==='string','unexpected baseline/parser diagnostic')
   assert([1,2].includes(d.severity),'baseline severity missing')
   rows.push({file,rule:d.ruleId,severity:d.severity,start:position(text,d.line,d.column),
    end:position(text,d.endLine??d.line,d.endColumn??d.column),message:d.message})
  }
 }
 return rows
}
export async function normalizeOxlint(raw,corpus){
 assert(Array.isArray(raw.diagnostics),'candidate JSON shape')
 const rows=[]
 for(const d of raw.diagnostics){
  const {file,text}=await source(corpus,d.filename)
  assert(typeof d.code==='string'&&typeof d.message==='string','unexpected candidate/parser diagnostic')
  assert(['error','warning'].includes(d.severity),'candidate severity missing')
  assert.equal(d.labels?.length,1,'unsupported candidate multi-span diagnostic')
  const span=d.labels[0].span,bytes=Buffer.from(text)
  assert(Number.isInteger(span?.offset)&&span.offset>=0&&Number.isInteger(span.length)&&span.length>=0&&span.offset+span.length<=bytes.length,'invalid candidate span')
  const offset=n=>{
   let prefix
   try{prefix=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,n))}
   catch{assert.fail('candidate span splits UTF-8 character')}
   return prefix.length
  }
  rows.push({file,rule:d.code.replace(/^([^()]+)\(([^()]+)\)$/,'$1/$2'),severity:d.severity==='error'?2:1,
   start:offset(span.offset),end:offset(span.offset+span.length),message:d.message+(d.help?' '+d.help:'')})
 }
 return rows
}
export function assertDiagnosticParity(expected,actual){
 const sorted=rows=>rows.map(row=>JSON.stringify(row)).sort()
 assert.deepEqual(sorted(actual),sorted(expected),'diagnostic parity differs (rule/severity/range/message/multiplicity)')
}

export async function assertParserFailure(engine,result,corpus){
 assert.equal(result.code,1,engine+' parser-control exit must be 1')
 assert.equal(result.stderr.trim(),'','parser control produced unrelated stderr')
 const raw=JSON.parse(result.stdout)
 let diagnostic,filename,start,end
 if(engine==='baseline'){
  assert(Array.isArray(raw)&&raw.length===1,'parser baseline must report one input')
  const row=raw[0];assert.equal(row.messages?.length,1,'parser baseline must report one diagnostic')
  diagnostic=row.messages[0];filename=row.filePath
  assert.equal(row.errorCount,1);assert.equal(row.fatalErrorCount,1);assert.equal(row.warningCount,0)
  assert.equal(diagnostic.ruleId,null);assert.equal(diagnostic.fatal,true);assert.equal(diagnostic.severity,2)
  assert.equal(diagnostic.message,'Parsing error: Variable declaration expected.')
  assert.equal(diagnostic.line,1);assert.equal(diagnostic.column,6);start=5
 }else{
  assert.equal(engine,'candidate','unknown parser engine')
  assert.equal(raw.number_of_files,1);assert.equal(raw.number_of_rules,6);assert.equal(raw.threads_count,2)
  assert.equal(raw.diagnostics?.length,1,'parser candidate must report one diagnostic')
  diagnostic=raw.diagnostics[0];filename=diagnostic.filename
  assert.equal(diagnostic.code,undefined,'expected parser diagnostic, not lint rule')
  assert.equal(diagnostic.severity,'error');assert.equal(diagnostic.message,'Unexpected token')
  assert.equal(diagnostic.labels?.length,1)
  assert.deepEqual(diagnostic.labels[0].span,{offset:6,length:1,line:1,column:7});start=6;end=7
 }
 const input=await source(corpus,filename)
 assert.equal(input.file,'src/broken-control.tsx','parser diagnostic is for a different input')
 assert.equal(input.text,'const = ;\n','parser-control input changed')
 return {file:input.file,kind:'parser',severity:2,start,...(end===undefined?{}:{end}),message:diagnostic.message}
}

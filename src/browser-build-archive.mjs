import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const safePath=value=>typeof value==='string' && value.length>0 && !value.startsWith('/') && !value.includes('\\') && value.split('/').every(part=>part && part!=='.' && part!=='..')

// The qualified static-build format is an uncompressed ustar containing regular
// files only. Inspect in memory; never extract candidate paths onto disk.
// The caller already authenticated the entire archive against its trusted hash.
export function inspectBuildArchive(bytes,sourceCommit) {
  const entries=new Map()
  const text=(header,start,size)=>header.subarray(start,start+size).toString('utf8').replace(/\0.*$/s,'')
  const octal=(header,start,size)=>{
    const field=text(header,start,size).trim()
    if(!/^[0-7]+$/.test(field)) throw Error('invalid tar number')
    const value=parseInt(field,8)
    if(!Number.isSafeInteger(value)) throw Error('invalid tar size')
    return value
  }
  let offset=0,terminated=false
  while(offset+512<=bytes.length) {
    const header=bytes.subarray(offset,offset+512)
    if(header.every(byte=>byte===0)) {
      if(bytes.length-offset<1024 || !bytes.subarray(offset).every(byte=>byte===0)) throw Error('invalid tar terminator')
      terminated=true;break
    }
    const checksum=[...header].reduce((sum,byte,i)=>sum+(i>=148 && i<156?32:byte),0)
    if(checksum!==octal(header,148,8) || text(header,257,6)!=='ustar' || !['0',''].includes(text(header,156,1))) throw Error('invalid tar header')
    const prefix=text(header,345,155),name=text(header,0,100),path=prefix?`${prefix}/${name}`:name
    if(!safePath(path) || entries.has(path)) throw Error('unsafe or duplicate tar entry')
    const size=octal(header,124,12),start=offset+512,end=start+size,next=start+Math.ceil(size/512)*512
    if(end>bytes.length || next>bytes.length || !bytes.subarray(end,next).every(byte=>byte===0)) throw Error('truncated tar payload')
    entries.set(path,bytes.subarray(start,end));offset=next
  }
  if(!terminated) throw Error('unterminated tar')
  const manifestBytes=entries.get('artifact-manifest.json')
  if(!manifestBytes) throw Error('archive manifest missing')
  const manifest=JSON.parse(manifestBytes)
  if(manifest.source_commit!==sourceCommit || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length+1!==entries.size) throw Error('archive manifest identity differs')
  const paths=new Set()
  for(const row of manifest.files) {
    if(!safePath(row?.path) || row.path==='artifact-manifest.json' || paths.has(row.path)) throw Error('invalid manifest entry')
    paths.add(row.path)
    const data=entries.get(row.path)
    if(!data || !isDeepStrictEqual({path:row.path,sha256:sha(data),bytes:data.length},row)) throw Error('archive manifest payload differs')
  }
  return {files:manifest.files}
}

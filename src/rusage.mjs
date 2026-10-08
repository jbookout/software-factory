import assert from 'node:assert/strict'

export function peakRssBytes(report,platform){
 const pattern=platform==='darwin'?/^\s*(\d+)\s+maximum resident set size\s*$/gm:
  /^[ \t]*Maximum resident set size \(kbytes\):[ \t]*(\d+)[ \t]*$/gm
 const matches=[...report.matchAll(pattern)]
 assert.equal(matches.length,1,'resource measurement missing or ambiguous')
 return Number(matches[0][1])*(platform==='darwin'?1:1024)
}

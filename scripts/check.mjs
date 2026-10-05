import { runVerification, readVerification } from '../src/local-verification.mjs'
const classes = {
  node:[process.execPath,'--test','--test-concurrency=2'],
  browser:['python3','capabilities/jev-browser-select/test_select.py'],
  orchestration:['python3','-m','unittest','discover','-s','test/orch','-p','test_*.py','-v']
}
const selected=process.argv.slice(2)
let failed=false
for(const name of selected.length?selected:Object.keys(classes)) {
  if(!classes[name])throw new Error(`unknown check class ${name}`)
  const attempt=await runVerification({cwd:process.cwd(),producer:process.env.FACTORY_PRODUCER ?? `local-check:${process.pid}`,argv:classes[name]})
  const result=await readVerification(attempt.receipt,attempt.binding)
  console.log(JSON.stringify({class:name,runtime:process.version,...result,receipt:attempt.receipt}))
  failed ||= result.code!==0
}
process.exitCode=failed?1:0

import { runVerification, readVerification } from '../src/local-verification.mjs'
import { reserveCheck } from '../src/check-admission.mjs'
import { Deadline } from '../src/deadline.mjs'
const classes = {
  node:[process.execPath,'--test','--test-concurrency=2'],
  browser:['python3','capabilities/jev-browser-select/test_select.py'],
  orchestration:['python3','-m','unittest','discover','-s','test/orch','-p','test_*.py','-v']
}
const defaultClasses=Object.keys(classes)
classes.formatter=[process.execPath,'capabilities/oxfmt-qualification/qualify.mjs']
classes.lint=[process.execPath,'capabilities/oxlint-qualification/qualify.mjs']
const args=process.argv.slice(2)
const focused=args[0]==='node' && args.length>1 && !args.slice(1).every(name=>Object.hasOwn(classes,name))
const selected=focused?['node']:args
if(focused)classes.node.push(...args.slice(1))
let failed=false
const controller=new AbortController()
const cancel=()=>controller.abort()
process.on('SIGINT',cancel);process.on('SIGTERM',cancel)
let admission
try {
  admission=await reserveCheck({budget:new Deadline(3600_000,{phase:'check-admission',signal:controller.signal})})
  for(const name of selected.length?selected:defaultClasses) {
    if(!classes[name])throw new Error(`unknown check class ${name}`)
    const attempt=await runVerification({cwd:process.cwd(),producer:process.env.FACTORY_PRODUCER ?? `local-check:${process.pid}`,
      argv:classes[name],admission,signal:controller.signal})
    const result=await readVerification(attempt.receipt,attempt.binding,attempt.receiptDigest)
    console.log(JSON.stringify({class:name,runtime:process.version,...result,receipt:attempt.receipt}))
    failed ||= result.code!==0
    if(controller.signal.aborted)break
  }
  process.exitCode=controller.signal.aborted ? 130 : failed ? 1 : 0
} catch(error) {
  if(!controller.signal.aborted)throw error
  process.exitCode=130
} finally {
  await admission?.release()
  process.off('SIGINT',cancel);process.off('SIGTERM',cancel)
}

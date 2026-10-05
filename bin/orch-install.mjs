#!/usr/bin/env node
import {spawn} from 'node:child_process'
import {installOrchestration,checkOrchestration} from '../src/orch-installation.mjs'
const [action,...args]=process.argv.slice(2)
try {
 if(action==='install') console.log(JSON.stringify(await installOrchestration(...args)))
 else if(action==='check') console.log(JSON.stringify(await checkOrchestration(args[0])))
 else if(action==='invoke') {
   const [directory,command,...inputs]=args, binding=await checkOrchestration(directory)
   if(inputs[0]==='--factory-binding'||command==='--factory-binding') console.log(JSON.stringify(binding))
   else {
     const child=spawn(process.execPath,[`${binding.sourceRoot}/${command==='browser-suite'?'bin/browser-suite.mjs':binding.entrypoint}`,binding.configPath,...(command==='browser-suite'?[]:[command]),...inputs],
       {stdio:'inherit',env:{...process.env,CARR_JEV_WORKER:'off'}})
     child.on('error',()=>{process.stderr.write('bound factory launch failed\n');process.exitCode=1})
     child.on('close',(code,signal)=>{process.exitCode=signal?130:code??1})
   }
 } else throw new Error('usage: orch-install.mjs install <source> <installed> <config> | check <installed> | invoke <installed> <action> [args]')
} catch(error) {process.stderr.write(`${error.message}\n`);process.exitCode=9}

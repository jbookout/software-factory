#!/usr/bin/env node
import {pathToFileURL} from 'node:url'
import {installOrchestration,checkOrchestration} from '../src/orch-installation.mjs'
const [action,...args]=process.argv.slice(2)
try {
 if(action==='install') console.log(JSON.stringify(await installOrchestration(...args)))
 else if(action==='check') console.log(JSON.stringify(await checkOrchestration(args[0])))
 else if(action==='invoke') {
   const [directory,command,...inputs]=args, binding=await checkOrchestration(directory)
   if(inputs[0]==='--factory-binding'||command==='--factory-binding') console.log(JSON.stringify(binding))
   else {
     const entrypoint=`${binding.sourceRoot}/${command==='browser-suite'?'bin/browser-suite.mjs':binding.entrypoint}`
     process.argv=[process.execPath,entrypoint,binding.configPath,...(command==='browser-suite'?[]:[command]),...inputs]
     process.env.CARR_JEV_WORKER='off'
     // Run in the invoking process so supervisor IPC observes this foreground owner.
     await import(pathToFileURL(entrypoint).href)
   }
 } else throw new Error('usage: orch-install.mjs install <source> <installed> <config> | check <installed> | invoke <installed> <action> [args]')
} catch(error) {process.stderr.write(`${error.message}\n`);process.exitCode=9}

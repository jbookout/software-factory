#!/usr/bin/env node
import {installOrchestration,checkOrchestration} from '../src/orch-installation.mjs'
const [action,...args]=process.argv.slice(2)
try {
 if(action==='install') console.log(JSON.stringify(await installOrchestration(...args)))
 else if(action==='check') console.log(JSON.stringify(await checkOrchestration(args[0])))
 else throw new Error('usage: orch-install.mjs install <source> <installed> <config> | check <installed>')
} catch(error) {process.stderr.write(`${error.message}\n`);process.exitCode=9}

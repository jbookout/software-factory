import {loadTaskContext} from '../src/task-context.mjs';
try{console.log(JSON.stringify(await loadTaskContext({root:process.cwd(),task:process.argv[2]})));}catch(error){console.error(error.message);process.exitCode=1;}

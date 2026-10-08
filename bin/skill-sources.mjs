import {discoverSkills,installSkill} from '../src/skill-sources.mjs';
try {
  const [operation,id,project]=process.argv.slice(2);
  if(operation==='install')console.log(JSON.stringify(await installSkill({root:process.cwd(),id,project})));
  else if(operation==='list')console.log(JSON.stringify(await discoverSkills(process.cwd())));
  else throw new Error('Usage: node bin/skill-sources.mjs list | install SKILL_ID PROJECT_DIRECTORY');
}catch(error){console.error(error.message);process.exitCode=1;}

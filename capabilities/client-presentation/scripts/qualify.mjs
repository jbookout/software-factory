import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {build,validate} from './build.mjs';
import {acceptBrowserSite} from './browser-acceptance.mjs';
import {verificationSource,runVerification,readVerification} from '../../../src/local-verification.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const defaultRoot=fileURLToPath(new URL('../../../',import.meta.url));
async function checkSource({sourceRoot}) {
  const attempt=await runVerification({cwd:sourceRoot,producer:'presentation-publication-qualification',argv:[process.execPath,path.join(sourceRoot,'scripts/check.mjs')]});
  const result=await readVerification(attempt.receipt,attempt.binding,attempt.receiptDigest);
  return {source:{repository:result.repository,cwd:result.cwd,head:result.head,tree:result.tree},code:result.code,receipt:attempt.receipt,receiptDigest:attempt.receiptDigest};
}
async function packageDigest(directory) {
  const entries=[];
  async function visit(folder) {
    for(const item of (await fs.readdir(folder,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      const file=path.join(folder,item.name);
      if(item.isDirectory())await visit(file);
      else if(item.isFile())entries.push([path.relative(directory,file),digest(await fs.readFile(file))]);
      else throw new Error('package contains a non-file asset');
    }
  }
  await visit(directory);return digest(JSON.stringify(entries));
}
function hostedEvidence(value,artifactDigest) {
  if(value?.deployment?.status!=='deployed' || value.deployment.artifactDigest!==artifactDigest || typeof value.deployment.version!=='string' || !value.deployment.version)throw new Error('hosted deployment binding evidence missing');
  if(value.hostedAuth?.status!=='verified' || value.hostedAuth.unauthenticated!=='denied' || value.hostedAuth.authenticated!=='allowed' || !value.hostedAuth.evidence)throw new Error('hosted authentication evidence failed');
  if(value.persistence?.status!=='verified' || value.persistence.saveReload!=='passed' || value.persistence.conflict!=='passed' || !value.persistence.evidence)throw new Error('hosted persistence evidence failed');
  return value;
}
export async function qualifyPresentation({input,output,sourceRoot=defaultRoot,today=new Date().toISOString().slice(0,10),runChecks=checkSource,browserCheck=acceptBrowserSite,hostedAdapter}={}) {
  const requested=path.resolve(output),source=await verificationSource(sourceRoot);
  const destination=path.join(await fs.realpath(path.dirname(requested)),path.basename(requested)),realSource=await fs.realpath(sourceRoot);
  if(destination===realSource || destination.startsWith(realSource+path.sep))throw new Error('client packages must be outside the public factory checkout');
  const bytes=await fs.readFile(input),data=validate(JSON.parse(bytes));
  if(data.demographics && globalThis.PresentationDemographics.freshness(data.demographics,today).startsWith('Research'))throw new Error('demographic research expired or future dated');
  const checks=await runChecks({sourceRoot});
  if(checks.code!==0 || !checks.receipt || !checks.receiptDigest || JSON.stringify(checks.source)!==JSON.stringify(source))throw new Error('repository checks failed or source binding changed');
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'presentation-package-')),stage=path.join(temporary,'site');
  try {
    await build(input,stage);
    const browser=await browserCheck({directory:stage,negativeChecks:false});
    if(browser.schema!=='presentation-browser-acceptance/v1' || !browser.results?.length || !['desktop','mobile'].every(device=>browser.results.some(result=>result.device===device && result.passed===true)) || browser.results.some(result=>result.passed!==true))throw new Error('browser acceptance failed');
    if(JSON.stringify(await verificationSource(sourceRoot))!==JSON.stringify(source) || digest(await fs.readFile(input))!==digest(bytes))throw new Error('qualification source binding changed');
    const artifactDigest=await packageDigest(stage);
    const hosted=hostedAdapter?hostedEvidence(await hostedAdapter({artifactDigest,source}),artifactDigest):{deployment:{status:'not_deployed'},hostedAuth:{status:'not_checked'},persistence:{status:'not_checked'}};
    const receipt={schema:'presentation-publication-qualification/v1',qualifiedAt:today,rendererVersion:3,source,inputDigest:digest(bytes),artifactDigest,checks,browser,...hosted,clientReady:Boolean(hostedAdapter) && !data.presentation.fictional};
    await fs.mkdir(destination,{recursive:false});
    for(const entry of await fs.readdir(stage)) await fs.cp(path.join(stage,entry),path.join(destination,entry),{recursive:true,force:false,errorOnExist:true});
    await fs.writeFile(path.join(destination,'qualification.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
    return receipt;
  }finally{await fs.rm(temporary,{recursive:true,force:true});}
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [input,output]=process.argv.slice(2);
  try{if(!input || !output)throw new Error('Usage: node scripts/qualify.mjs INPUT.json NEW_OUTPUT_DIRECTORY');console.log(JSON.stringify(await qualifyPresentation({input,output})));}catch(error){console.error(error.message);process.exitCode=1;}
}

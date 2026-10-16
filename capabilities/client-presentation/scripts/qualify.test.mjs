import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {qualifyPresentation} from './qualify.mjs';
import {verificationSource} from '../../../src/local-verification.mjs';
const fixture=JSON.parse(await fs.readFile(new URL('../test/fixtures/owner-occupancy.json',import.meta.url),'utf8'));
async function setup(){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'presentation-qualification-'));const input=path.join(dir,'input.json');await fs.writeFile(input,JSON.stringify(fixture));return{input,output:path.join(dir,'package'),sourceRoot:process.cwd(),today:'2026-10-07'};}
const passedChecks=async({sourceRoot})=>({source:await verificationSource(sourceRoot),code:0,receipt:'synthetic-check-receipt',receiptDigest:'a'.repeat(64)});
const passedBrowser=async()=>({schema:'presentation-browser-acceptance/v1',engine:'synthetic-browser-test-adapter',results:[{device:'desktop',passed:true},{device:'mobile',passed:true}]});
test('qualification packages only after checks and retains undeployed status honestly',async()=>{
  const options=await setup(),events=[];
  const result=await qualifyPresentation({...options,runChecks:async args=>{events.push('checks');return passedChecks(args);},browserCheck:async()=>{events.push('browser');return passedBrowser();}});
  assert.deepEqual(events,['checks','browser']);assert.equal(result.deployment.status,'not_deployed');assert.equal(result.hostedAuth.status,'not_checked');assert.equal(result.persistence.status,'not_checked');assert.equal(result.clientReady,false);
  assert.match(result.source.tree,/^[a-f0-9]{64}$/);assert.equal(result.rendererVersion,3);assert.match(result.artifactDigest,/^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(await fs.readFile(path.join(options.output,'qualification.json'),'utf8')).artifactDigest,result.artifactDigest);
});
test('failed checks, expired research and failed browser acceptance cannot package',async()=>{
  for(const overrides of [{runChecks:async args=>({...await passedChecks(args),code:1})},{today:'2027-01-01'},{browserCheck:async()=>({...await passedBrowser(),results:[{device:'desktop',passed:false}]})}]){
    const options=await setup();await assert.rejects(qualifyPresentation({...options,runChecks:passedChecks,browserCheck:passedBrowser,...overrides}),/failed|expired/);await assert.rejects(fs.stat(options.output),/ENOENT/);
  }
});
test('hosted adapter must bind deployment, auth and persistence evidence to packaged artifact',async()=>{
  const options={...await setup(),clientUrl:'https://share.doctorcre.com/synthetic/'};
  const hostedAdapter=async({artifactDigest,clientUrl})=>({deployment:{status:'deployed',artifactDigest,version:'synthetic-1',url:clientUrl},hostedAuth:{status:'verified',unauthenticated:'denied',authenticated:'allowed',evidence:'synthetic-auth-observation'},persistence:{status:'verified',saveReload:'passed',conflict:'passed',evidence:'synthetic-storage-observation'}});
  const result=await qualifyPresentation({...options,runChecks:passedChecks,browserCheck:passedBrowser,hostedAdapter});assert.equal(result.clientReady,false);assert.equal(result.deployment.version,'synthetic-1');
  assert.equal(result.requestedClientUrl,options.clientUrl);assert.equal(result.deployment.url,options.clientUrl);
  const bad=await setup();await assert.rejects(qualifyPresentation({...bad,clientUrl:options.clientUrl,runChecks:passedChecks,browserCheck:passedBrowser,hostedAdapter:async()=>({deployment:{status:'deployed',artifactDigest:'stale'}})}),/binding|evidence/);
});

test('a symlinked output parent cannot package client input under the public source tree',async()=>{
  const options=await setup(),parent=path.dirname(options.output),alias=path.join(parent,'factory-alias');
  await fs.symlink(process.cwd(),alias,'dir');
  await assert.rejects(qualifyPresentation({...options,output:path.join(alias,'forbidden-package'),runChecks:passedChecks,browserCheck:passedBrowser}),/outside the public/);
  await assert.rejects(fs.stat(path.join(alias,'forbidden-package')),/ENOENT/);
});

test('hosted publication must verify the exact requested human-facing client URL',async()=>{
  const options=await setup(),clientUrl='https://share.doctorcre.com/synthetic/';
  const hostedAdapter=async({artifactDigest})=>({deployment:{status:'deployed',artifactDigest,version:'synthetic-1',url:'https://synthetic-provider.example/site'},hostedAuth:{status:'verified',unauthenticated:'denied',authenticated:'allowed',evidence:'synthetic-auth-observation'},persistence:{status:'verified',saveReload:'passed',conflict:'passed',evidence:'synthetic-storage-observation'}});
  await assert.rejects(qualifyPresentation({...options,clientUrl,runChecks:passedChecks,browserCheck:passedBrowser,hostedAdapter}),/client URL/);
  await assert.rejects(fs.stat(options.output),/ENOENT/);
  for(const invalid of [undefined,'http://share.doctorcre.com/synthetic/','https://username@share.doctorcre.com/synthetic/'])await assert.rejects(qualifyPresentation({...options,clientUrl:invalid,runChecks:passedChecks,browserCheck:passedBrowser,hostedAdapter}),/client URL/);
});

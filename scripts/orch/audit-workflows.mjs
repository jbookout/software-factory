import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { auditWorkflow, verifyActionProvenance } from '../../src/workflow-audit.mjs';

const args=process.argv.slice(2);
const upstream=args.includes('--verify-upstream');
const roots=args.filter(arg=>arg!=='--verify-upstream');
if (!roots.length) throw new Error('usage: node scripts/orch/audit-workflows.mjs [--verify-upstream] <repository> ...');
const results=[];
for (const input of roots) {
  const root=resolve(input);
  let pins;
  try { pins=JSON.parse(await readFile(join(root,'.github/action-pins.json'))); }
  catch { pins={actions:{}}; }
  for (const name of (await readdir(join(root,'.github/workflows'))).filter(n=>/\.ya?ml$/.test(n)).sort()) {
    const file=join(root,'.github/workflows',name);
    results.push(...auditWorkflow(await readFile(file,'utf8'),pins,file));
  }
  if (upstream) for (const [repository,pin] of Object.entries(pins.actions ?? {})) {
    try { await verifyActionProvenance(repository,pin,async endpoint=>JSON.parse(execFileSync('gh',['api',endpoint],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,maxBuffer:4*1024*1024}))); }
    catch { results.push({file:join(root,'.github/action-pins.json'),line:1,property:'upstream-provenance',remediation:'Reauthenticate the canonical published release, tag and runtime; no provider error bytes are retained.'}); }
  }
}
console.log(JSON.stringify({schema:'workflow-contract-audit.v1', mode:'non-blocking-pilot',findings:results,
  runtime_permission_handoffs: {status:'not-measured', reason:'Configuration audit; run publisher refusal and no-fallback replays separately.'},
  counts:{mutable_refs:results.filter(f=>f.property==='mutable-ref').length,privileged_test_steps:results.filter(f=>f.property==='privileged-build').length,artifact_handoff_violations:results.filter(f=>f.property.startsWith('artifact-')).length}},null,2));
process.exitCode=results.length?1:0;

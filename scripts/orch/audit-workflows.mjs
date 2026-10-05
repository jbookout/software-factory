import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { auditWorkflow, verifyActionProvenance } from '../../src/workflow-audit.mjs';

const args = process.argv.slice(2), upstream = args.includes('--verify-upstream');
const roots = args.filter(arg => arg !== '--verify-upstream');
const results = [], coverage = {repositories_requested:roots.length, repositories_scanned:0, workflows_audited:0};
const add = (file,property,remediation) => results.push({file,line:1,property,remediation});
if (!roots.length) add('.', 'workflow-input', 'Supply at least one repository to audit.');
for (const input of roots) {
  const root = resolve(input), manifest = join(root,'.github/action-pins.json'), directory = join(root,'.github/workflows');
  let pins;
  try {
    if ((await stat(manifest)).size > 1024 * 1024) throw new Error('manifest bound');
    pins = JSON.parse(await readFile(manifest,'utf8'));
    if (!pins || typeof pins !== 'object' || Array.isArray(pins) || !pins.actions || typeof pins.actions !== 'object' || Array.isArray(pins.actions)) throw new Error('manifest shape');
  } catch { add(manifest,'manifest-input','Supply a readable JSON manifest with an actions mapping; provenance is unmeasured.'); }
  let names;
  try {
    names = (await readdir(directory)).filter(name => /\.ya?ml$/.test(name)).sort();
    coverage.repositories_scanned++;
    if (!names.length) add(directory,'workflow-input','No workflow files were audited; supply a nonempty workflow directory.');
  } catch { add(directory,'workflow-input','Supply a readable workflow directory; this repository was not scanned.'); continue; }
  for (const name of names) {
    const file = join(directory,name);
    try {
      if ((await stat(file)).size > 1024 * 1024) throw new Error('workflow bound');
      results.push(...auditWorkflow(await readFile(file,'utf8'),pins,file));
      coverage.workflows_audited++;
    } catch { add(file,'workflow-input','Supply a readable workflow within the 1 MiB input bound.'); }
  }
  if (upstream && pins?.actions && !Array.isArray(pins.actions)) for (const [repository,pin] of Object.entries(pins.actions)) {
    try {
      await verifyActionProvenance(repository,pin,async endpoint => {
        let response;
        try { response = execFileSync('gh',['api',endpoint],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,maxBuffer:4*1024*1024}); }
        catch (error) {
          // Preserve only the typed missing-file signal required by the adapter.
          // Provider stderr/body never enters a finding or an exception message.
          throw Object.assign(new Error('provider request failed'), {status: /\(HTTP 404\)/.test(String(error.stderr)) ? 404 : undefined});
        }
        return JSON.parse(response);
      });
    } catch { add(manifest,'upstream-provenance','Reauthenticate the canonical published release, tag and runtime; no provider error bytes are retained.'); }
  }
}
console.log(JSON.stringify({schema:'workflow-contract-audit.v1',mode:'non-blocking-pilot',findings:results,coverage,
  runtime_permission_handoffs:{status:'not-measured',reason:'Configuration audit; run publisher refusal and no-fallback replays separately.'},
  counts:{mutable_refs:results.filter(f => f.property === 'mutable-ref').length,privileged_test_steps:results.filter(f => f.property === 'privileged-build').length,artifact_handoff_violations:results.filter(f => f.property.startsWith('artifact-')).length}},null,2));
process.exitCode = results.length ? 1 : 0;

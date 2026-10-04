import { parseDocument, LineCounter } from 'yaml';

const shaPattern = /^[a-f0-9]{40}$/;
const buildCommand = /\b(?:npm (?:ci|install|test|run (?:check|build))|(?:node|python\d*) .*test|ops\/ci\.sh|playwright|e2e run)\b/;
const hasSecret = value => /\$\{\{[^}]*\b(?:secrets\.|github\.token)/.test(JSON.stringify(value ?? {}));
const writes = permissions => permissions === 'write-all' || Object.values(permissions ?? {}).includes('write');

// A bounded configuration audit, not a claim of runtime safety. Findings name
// exact AST locations; provider privileges and source trust still need review.
export function auditWorkflow(source, pins, file = 'workflow.yml') {
  const lines = new LineCounter();
  const document = parseDocument(source, { lineCounter: lines, uniqueKeys: true });
  const findings = [];
  const add = (property, path, remediation) => {
    const node = document.getIn(path, true);
    findings.push({file,line:node?.range ? lines.linePos(node.range[0]).line : 1,property,remediation});
  };
  if (document.errors.length) {
    add('invalid-yaml', [], 'Repair YAML before interpreting permissions.');
    return findings;
  }
  let workflow;
  try { workflow = document.toJS(); } catch { add('invalid-yaml', [], 'Repair YAML aliases before interpreting trust.'); return findings; }
  if (!workflow || !workflow.jobs || typeof workflow.jobs !== 'object') {
    add('invalid-workflow', [], 'Declare jobs explicitly.'); return findings;
  }
  if (!workflow.permissions || writes(workflow.permissions) || workflow.permissions === 'read-all') add('readonly-default',['permissions'],'Declare explicit read-only workflow permissions.');
  const events = typeof workflow.on === 'string' ? [workflow.on] : Array.isArray(workflow.on) ? workflow.on : Object.keys(workflow.on ?? {});
  for (const [id,job] of Object.entries(workflow.jobs)) {
    const path = ['jobs',id];
    if (!job || typeof job !== 'object' || Array.isArray(job) || (job.steps !== undefined && !Array.isArray(job.steps)) || (job.uses !== undefined && typeof job.uses !== 'string')) { add('invalid-workflow',path,'Declare a job with a steps list or pinned reusable workflow.'); continue; }
    if ((job.steps ?? []).some(step=>!step || typeof step !== 'object' || (step.run !== undefined && typeof step.run !== 'string') || (step.uses !== undefined && typeof step.uses !== 'string'))) { add('invalid-workflow',path,'Declare step commands and references as strings.'); continue; }
    const privileged = writes(job.permissions ?? workflow.permissions);
    const steps = job.steps ?? [];
    const build = steps.some(step => buildCommand.test(step.run ?? ''));
    if (!job.uses && (!Number.isFinite(job['timeout-minutes']) || job['timeout-minutes'] <= 0)) add('missing-timeout',path,'Set a finite job deadline.');
    if (privileged && build) steps.forEach((step,index)=>{ if(buildCommand.test(step.run ?? '')) add('privileged-build',[...path,'steps',index],'Separate tests/install/build from publisher credentials.'); });
    if (privileged && events.includes('pull_request')) add('privileged-trigger',path,'Keep write/deploy publication out of pull-request events.');
    if (build && (hasSecret(workflow.env) || hasSecret(job.env))) add('build-secret',path,'Keep secrets out of build job/workflow environment.');
    if (job.secrets === 'inherit') add('inherited-secrets',path,'Use an explicit reusable-workflow secret allowlist.');
    const uses = job.uses ? [[job,path]] : steps.map((step,index)=>[step,[...path,'steps',index]]);
    for (const [step,stepPath] of uses) {
      if (step.uses && !step.uses.startsWith('./')) {
        const match = step.uses.match(/^([\w.-]+\/[\w.-]+(?:\/[^@]+)?)@([a-f0-9]{40})$/);
        if (!match) add('mutable-ref',[...stepPath,'uses'],'Pin every external action/reusable workflow to a full canonical commit.');
        else {
          const [,,sha] = match;
          const pin = pins?.actions?.[match[1]];
          if (!pin || pin.sha !== sha || pin.canonical_tag_sha !== sha || !/^v\d+\.\d+\.\d+$/.test(pin.tag ?? '') || pin.release_url !== `https://github.com/${match[1].split('/').slice(0,2).join('/')}/releases/tag/${pin.tag}` || !shaPattern.test(pin.metadata_blob ?? '') || !['node20','node24','composite','reusable'].includes(pin.runtime)) add('action-provenance',[...stepPath,'uses'],'Authenticate the commit through its canonical published release, tag and metadata.');
        }
      }
      if (buildCommand.test(step.run ?? '') && hasSecret(step.env)) add('build-secret',stepPath,'Remove credentials from install/test/build steps.');
      if (/\$\{\{[^}]*github\.(?:event\.|head_ref|ref(?:_name)?\b)/.test(step.run ?? '')) add('event-shell-injection',stepPath,'Pass event values as quoted environment data or validated argv.');
      if (step.secrets === 'inherit') add('inherited-secrets',stepPath,'Use an explicit secret allowlist.');
      if (step.uses?.startsWith('actions/checkout@')) {
        if (step.with?.['persist-credentials'] !== false) add('persisted-checkout-token',stepPath,'Disable checkout credential persistence.');
        if (privileged && (step.with?.ref !== 'main' || step.with?.repository || events.includes('pull_request'))) add('privileged-checkout',stepPath,'Run privileged controllers only from canonical main, never PR/head input.');
      }
      if (privileged && (step.uses?.startsWith('actions/cache') || step.with?.cache)) add('privileged-cache',stepPath,'Keep cache restoration in read-only jobs; publish verified bytes only.');
      if (privileged && /(?:\b(?:node|bash|sh|python\d*|source)\s+[^\n]*\b(?:dist|artifact|download)[/\w.-]*|\.\/(?:dist|artifact|download)\/)/.test(step.run ?? '')) add('executable-artifact',stepPath,'Treat downloaded artifacts as data, never release executables.');
      if (step.uses?.startsWith('actions/upload-artifact@')) {
        const paths=String(step.with?.path ?? '').trim().split(/\s+/);
        if (paths.some(p=>!p || ['.','./','**','**/*'].includes(p) || /(?:\.env|\.git(?:\/|$)|credentials|tokens\.env|node_modules)/.test(p))) add('artifact-path',stepPath,'Upload explicit credential-free artifact paths only.');
      }
      if (privileged && step.uses?.startsWith('actions/download-artifact@')) {
        if (step.with?.['run-id'] || step.with?.repository || !/^\$\{\{ needs\.[\w-]+\.outputs\.artifact_id \}\}$/.test(String(step.with?.['artifact-ids'] ?? ''))) add('artifact-origin',stepPath,'Download the immutable artifact ID from this run\'s trusted build.');
        const next=steps.slice(steps.indexOf(step)+1);
        const guardIndex=next.findIndex(s=>(s.run ?? '').includes('sha256sum -c'));
        const guard=next[guardIndex];
        const publishIndex=next.findIndex(s=>/gh release create|wrangler/.test(s.run ?? ''));
        if (!guard || guard.if !== undefined || guard['continue-on-error'] || !JSON.stringify(guard.env ?? {}).includes('needs.') || (publishIndex >= 0 && guardIndex > publishIndex)) add('artifact-digest',stepPath,'Require an unconditional build-bound digest check before publication.');
      }
    }
  }
  return findings;
}

// Resolve from the canonical upstream repository via REST, never GraphQL.
// Published release tags also cover legitimate release-tag-only bundle commits.
export async function verifyActionProvenance(repository, pin, api) {
  if (!/^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?$/.test(repository) || !pin || !shaPattern.test(pin.sha ?? '') || !/^v\d+\.\d+\.\d+$/.test(pin.tag ?? '')) throw new Error('invalid action provenance input');
  const parts=repository.split('/');
  const repo=parts.slice(0,2).join('/');
  const suffix=parts.slice(2).join('/');
  const metadataPath=suffix.startsWith('.github/workflows/')?suffix:suffix?`${suffix}/action.yml`:'action.yml';
  let object = (await api(`repos/${repo}/git/ref/tags/${pin.tag}`)).object;
  for (let depth=0; object?.type === 'tag' && depth<4; depth++) object=(await api(`repos/${repo}/git/tags/${object.sha}`)).object;
  const release = await api(`repos/${repo}/releases/tags/${pin.tag}`);
  const metadata = await api(`repos/${repo}/contents/${metadataPath}?ref=${pin.sha}`);
  const action = parseDocument(Buffer.from(metadata.content ?? '', 'base64').toString()).toJS();
  const runtime=metadataPath.startsWith('.github/workflows/') && action?.on?.workflow_call !== undefined ? 'reusable' : action?.runs?.using;
  if (object?.type !== 'commit' || object.sha !== pin.sha || release.tag_name !== pin.tag || release.draft !== false || release.html_url !== pin.release_url || metadata.sha !== pin.metadata_blob || runtime !== pin.runtime) throw new Error('action provenance mismatch');
  return true;
}

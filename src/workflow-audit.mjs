import { parseDocument, LineCounter, visit, isAlias, isPair, isScalar } from 'yaml';
import { posix } from 'node:path';

// Shared interpretation for audits and runner experiments. Job indirection needs
// a separate effective-configuration review; never certify a partial job graph.
export function parseWorkflowDocument(source, options = {}) {
  if (typeof source !== 'string' || source.length > 1024 * 1024) throw new Error('input bound');
  const document = parseDocument(source, {...options, uniqueKeys:true});
  if (document.errors.length) throw new Error('invalid YAML');
  visit(document.get('jobs',true), (_key,node) => {
    if (node?.anchor || isAlias(node) || isPair(node) && isScalar(node.key) && node.key.value === '<<') {
      throw new Error('job indirection requires effective-config review');
    }
  });
  return document;
}

const shaPattern = /^[a-f0-9]{40}$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const actionRef = /^([\w.-]+\/[\w.-]+(?:\/[^@]+)?)@([a-f0-9]{40})$/;
const permissionNames = new Set(['actions','artifact-metadata','attestations','checks','contents','deployments','discussions','id-token','issues','models','packages','pages','pull-requests','security-events','statuses']);
const validPermissions = value => value === undefined || ['read-all','write-all'].includes(value) || (record(value) && Object.entries(value).every(([key,level]) => permissionNames.has(key) && ['read','write','none'].includes(level)));
const writes = value => value === 'write-all' || (record(value) && Object.values(value).includes('write'));
const eventNames = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value : record(value) ? Object.keys(value) : [];
const dependencies = job => typeof job?.needs === 'string' ? [job.needs] : Array.isArray(job?.needs) ? job.needs : [];
function jobShapeError(job) {
  if (!record(job) || !validPermissions(job.permissions)) return 'Declare a job mapping with valid GitHub permissions.';
  const reusable = typeof job.uses === 'string' && !!job.uses;
  const runner = job['runs-on'];
  const validRunner = typeof runner === 'string' && !!runner || Array.isArray(runner) && runner.length && runner.every(label => typeof label === 'string') || record(runner) && (typeof runner.group === 'string' || typeof runner.labels === 'string' || Array.isArray(runner.labels));
  if ((reusable ? job.steps !== undefined || runner !== undefined : !validRunner || !Array.isArray(job.steps) || !job.steps.length) || job.uses !== undefined && !reusable) return 'Declare either a runner with nonempty steps or a reusable reference.';
  if (job.outputs !== undefined && (!record(job.outputs) || !Object.values(job.outputs).every(output => typeof output === 'string'))) return 'Declare job outputs as a mapping of expressions.';
  if (job.needs !== undefined && !(typeof job.needs === 'string' && job.needs || Array.isArray(job.needs) && job.needs.length && job.needs.every(id => typeof id === 'string' && id))) return 'Declare dependencies as job names.';
  if (job.secrets !== undefined && job.secrets !== 'inherit' && !record(job.secrets)) return 'Declare reusable secrets as an explicit mapping or inherit.';
  const ids = new Set();
  for (const step of job.steps ?? []) {
    if (!record(step) || (typeof step.run === 'string' && !!step.run) === (typeof step.uses === 'string' && !!step.uses) || step.run !== undefined && typeof step.run !== 'string' || step.uses !== undefined && typeof step.uses !== 'string') return 'Declare each step with exactly one nonempty run command or action reference.';
    if (step.with !== undefined && !record(step.with) || step.env !== undefined && !record(step.env)) return 'Declare action inputs and step environments as mappings.';
    if (step.id !== undefined && (typeof step.id !== 'string' || ids.has(step.id))) return 'Declare distinct string step IDs.';
    ids.add(step.id);
  }
  return null;
}

// Normalize only expression access, not shell text. Dynamic indices retain the
// context root and therefore cannot hide credentials or untrusted event data.
const expressions = value => [...String(value).matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map(match => match[1].replace(/\[\s*(['"])([\w-]+)\1\s*\]/g, '.$2').replace(/\s*\.\s*/g, '.'));
function strings(value) {
  const pending = [value], seen = new Set(), result = [];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string') result.push(item);
    else if (item && typeof item === 'object' && !seen.has(item)) { seen.add(item); pending.push(...Object.values(item)); }
  }
  return result;
}
const hasSecret = value => strings(value).some(text => expressions(text).some(expression => /\b(?:secrets(?:\.|\[)|github\.token\b)/.test(expression)));
const injectedEvent = run => expressions(run).some(expression => /\b(?:github(?:\.event(?:\.|\[)|\.head_ref\b|\.ref(?:_name)?\b|\[)|inputs(?:\.|\[))/.test(expression));
const publisher = run => /\b(?:gh\s+release\s+(?:create|upload|edit|delete)|(?:npx\s+)?wrangler\s+(?:deploy|publish)|npm\s+publish|docker\s+push|aws\s+s3\s+(?:cp|sync))\b/.test(run ?? '');
function execution(run = '') {
  // npm options and whitespace do not change the install/test/build authority.
  // All npm scripts are executable build paths, even custom script names.
  const build = /\bnpm\b[^\n;&|]*\b(?:ci|install|test|run|exec)\b|\b(?:node|python\d*)\b[^\n]*test|\b(?:playwright|ops\/ci\.sh)\b|\be2e\s+run\b/.test(run);
  if (run.trim() === digestCommand) return {build, unknown:false};
  const unknown = run.split(/\n/).some(line => {
    const text = line.trim();
    if (!text || text.startsWith('#')) return false;
    if (/^echo "sha=\$\(sha256sum [\w./-]+ \| cut -d ' ' -f1\)" >> "\$GITHUB_OUTPUT"$/.test(text)) return false;
    return /[;&|`]|\$\(/.test(text) || !/^(?:npm\s+(?:--[\w=-]+\s+(?:[\w./-]+\s+)?)*(?:ci|install|test|run|exec|publish)\b|gh\s+release\s+(?:create|upload|edit|delete)\b|(?:npx\s+)?wrangler\s+(?:deploy|publish)\b|(?:echo|printf|set|sha256sum|shasum|cut)\b)/.test(text);
  });
  return {build, unknown};
}
const credentialFields = value => record(value) && Object.entries(value).some(([key,item]) => /token|password|credential|secret|api.?key|access.?key|private.?key/i.test(key) && item !== false && item !== '' && item != null);
function credentialAuthority(workflow, job) {
  if (hasSecret([workflow.env,job.env,job.secrets]) || credentialFields(workflow.env) || credentialFields(job.env)) return true;
  if (job.secrets === 'inherit' || (record(job.secrets) && Object.keys(job.secrets).length)) return true;
  return (job.steps ?? []).some(step => hasSecret([step.env,step.with,step.secrets]) || credentialFields(step.env) || credentialFields(step.with));
}
function validPin(repository, pin) {
  const repo = repository.split('/').slice(0,2).join('/');
  return record(pin) && shaPattern.test(pin.sha ?? '') && pin.canonical_tag_sha === pin.sha &&
    /^v\d+\.\d+\.\d+$/.test(pin.tag ?? '') && pin.release_url === `https://github.com/${repo}/releases/tag/${pin.tag}` &&
    shaPattern.test(pin.metadata_blob ?? '') && ['node20','node24','composite','reusable'].includes(pin.runtime);
}
function pinned(reference, pins) {
  const match = reference?.match(actionRef);
  return !!match && validPin(match[1], pins?.actions?.[match[1]]) && pins.actions[match[1]].sha === match[2];
}
function safeArtifactPath(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  return value.trim().split(/\s+/).every(path => {
    const normalized = posix.normalize(path);
    return !path.startsWith('!') && !path.includes('${{') && !posix.isAbsolute(normalized) && !normalized.startsWith('../') &&
      normalized !== '.' && /[\w-]/.test(normalized.split('/')[0]) &&
      !/(?:\.env|\.git(?:\/|$)|credentials|tokens\.env|node_modules)/.test(normalized);
  });
}
function trustedProducer(id, workflow, pins, visiting = new Set()) {
  const job = workflow.jobs[id];
  if (visiting.has(id) || jobShapeError(job) || !validPermissions(workflow.permissions) || job.uses || writes(job.permissions ?? workflow.permissions) || credentialAuthority(workflow,job)) return false;
  const checkouts = job.steps.filter(step => step?.uses?.startsWith('actions/checkout@'));
  if (!checkouts.length || checkouts.some(step => step.with?.ref !== 'main' || step.with?.repository || step.with?.['persist-credentials'] !== false)) return false;
  if (job.steps.some(step => !record(step) || (step.uses && !pinned(step.uses,pins)) || injectedEvent(step.run ?? '') || execution(step.run).unknown)) return false;
  visiting.add(id);
  const trusted = dependencies(job).every(dependency => trustedProducer(dependency,workflow,pins,visiting));
  visiting.delete(id);
  return trusted;
}
const outputReference = value => typeof value === 'string' ? value.match(/^\$\{\{\s*needs\.([\w-]+)\.outputs\.([\w-]+)\s*\}\}$/) : null;
function artifactProducer(step, job, workflow, pins) {
  const reference = outputReference(step.with?.['artifact-ids']);
  if (!reference || step.with?.['run-id'] !== undefined || step.with?.repository !== undefined || !dependencies(job).includes(reference[1]) || !trustedProducer(reference[1],workflow,pins)) return null;
  const producer = workflow.jobs[reference[1]];
  const output = producer.outputs?.[reference[2]];
  const uploadRef = typeof output === 'string' ? output.match(/^\$\{\{\s*steps\.([\w-]+)\.outputs\.artifact-id\s*\}\}$/) : null;
  const upload = producer.steps.find(candidate => candidate.id === uploadRef?.[1] && candidate.uses?.startsWith('actions/upload-artifact@'));
  // The pilot accepts one explicit file per handoff. Globs and directory uploads
  // require a different byte-verification contract and are reported unmeasured.
  const path = upload?.with?.path;
  if (!safeArtifactPath(path) || /[\s*?[\]{}]/.test(path) || upload.if !== undefined || upload['continue-on-error']) return null;
  return {id: reference[1], job: producer, file: posix.basename(path)};
}
const digestCommand = `set -euo pipefail\nprintf '%s  %s\\n' "$ARTIFACT_SHA" "$ARTIFACT_FILE" | sha256sum -c -`;
function digestGuard(step, producer, destination, job, workflow) {
  if (!producer || step.shell !== 'bash' || step.if !== undefined || step['continue-on-error'] || (step.run ?? '').trim() !== digestCommand) return false;
  const digest = outputReference(step.env?.ARTIFACT_SHA);
  const file = step.env?.ARTIFACT_FILE;
  const directory = step['working-directory'] ?? job.defaults?.run?.['working-directory'] ?? workflow.defaults?.run?.['working-directory'] ?? '.';
  return digest?.[1] === producer.id && typeof producer.job.outputs?.[digest[2]] === 'string' &&
    typeof file === 'string' && typeof directory === 'string' && posix.join(directory,file) === posix.join(destination,producer.file);
}
function executableDownload(run, destinations) {
  if (!destinations.length) return false;
  // Shell execution can change directory, use indirect argv, or invoke an action.
  // After a download, arbitrary execution is conservatively unmeasured regardless
  // of directory spelling. Data-only publishers and the exact digest guard remain.
  if ((run ?? '').trim() === digestCommand) return false;
  return /\b(?:node|bash|sh|python\d*|source|eval|exec|cd|npm|npx)\b|(?:^|\s)\.\//.test(run ?? '') || execution(run).unknown;
}

// A bounded configuration audit, not runtime certification. Unknown execution
// produces a finding; runtime permission handoffs remain separately unmeasured.
export function auditWorkflow(source, pins, file = 'workflow.yml') {
  const lines = new LineCounter(), findings = [];
  let document;
  const add = (property, path, remediation) => {
    let node;
    try { node = document?.getIn(path,true); } catch { /* Invalid container shape. */ }
    findings.push({file,line:node?.range ? lines.linePos(node.range[0]).line : 1,property,remediation});
  };
  let workflow;
  try {
    document = parseWorkflowDocument(source,{lineCounter:lines});
    workflow = document.toJS({maxAliasCount:100});
  } catch { add('invalid-yaml',[],'Repair YAML or reduce input nesting/aliases before interpreting trust.'); return findings; }
  if (!record(workflow) || !record(workflow.jobs) || !Object.keys(workflow.jobs).length || !eventNames(workflow.on).length || !eventNames(workflow.on).every(event => typeof event === 'string' && event.length)) {
    add('invalid-workflow',[],'Declare events and a nonempty jobs mapping.'); return findings;
  }
  if (!validPermissions(workflow.permissions)) add('invalid-workflow',['permissions'],'Use GitHub permission scopes with read, write or none values.');
  if (workflow.permissions === undefined || writes(workflow.permissions) || workflow.permissions === 'read-all') add('readonly-default',['permissions'],'Declare explicit read-only workflow permissions.');
  const events = eventNames(workflow.on);
  for (const [id,job] of Object.entries(workflow.jobs)) {
    const path = ['jobs',id];
    const shapeError = jobShapeError(job);
    if (shapeError) { add('invalid-workflow',path,shapeError); continue; }
    const reusable = !!job.uses, steps = job.steps ?? [];
    const privileged = writes(job.permissions ?? workflow.permissions) || credentialAuthority(workflow,job);
    const build = steps.some(step => execution(step.run).build);
    if (!reusable && (!Number.isFinite(job['timeout-minutes']) || job['timeout-minutes'] <= 0)) add('missing-timeout',path,'Set a finite job deadline.');
    if (privileged && events.includes('pull_request')) add('privileged-trigger',path,'Keep write/deploy publication out of pull-request events.');
    if (build && hasSecret([workflow.env,job.env])) add('build-secret',path,'Keep secrets out of build job/workflow environment.');
    const uses = reusable ? [[job,path]] : steps.map((step,index) => [step,[...path,'steps',index]]);
    const destinations = [];
    for (const [step,stepPath] of uses) {
      if (step.uses && !step.uses.startsWith('./')) {
        if (!actionRef.test(step.uses)) add('mutable-ref',[...stepPath,'uses'],'Pin external actions/reusable workflows to a full canonical commit.');
        else if (!pinned(step.uses,pins)) add('action-provenance',[...stepPath,'uses'],'Authenticate the commit through its canonical published release, tag and metadata.');
      }
      const command = execution(step.run);
      if (step.run && command.unknown) add('unclassified-execution',stepPath,'Execution trust is unmeasured for this command form; review it or use a supported contract.');
      if (command.build && privileged) add('privileged-build',stepPath,'Separate tests/install/build from publisher credentials.');
      if (command.build && hasSecret(step.env)) add('build-secret',stepPath,'Remove credentials from install/test/build steps.');
      if (injectedEvent(step.run ?? '')) add('event-shell-injection',stepPath,'Pass untrusted context values as quoted environment data or validated argv.');
      if (step.secrets === 'inherit') add('inherited-secrets',stepPath,'Use an explicit reusable-workflow secret allowlist.');
      if (step.uses?.startsWith('actions/checkout@')) {
        if (step.with?.['persist-credentials'] !== false) add('persisted-checkout-token',stepPath,'Disable checkout credential persistence.');
        if (privileged && (step.with?.ref !== 'main' || step.with?.repository || events.includes('pull_request'))) add('privileged-checkout',stepPath,'Run credential-bearing controllers only from canonical main.');
      }
      if (privileged && (step.uses?.startsWith('actions/cache') || step.with?.cache)) add('privileged-cache',stepPath,'Keep cache restoration in read-only jobs; publish verified bytes only.');
      if (privileged && (executableDownload(step.run,destinations) || destinations.length && step.uses?.startsWith('./'))) add('executable-artifact',stepPath,'Treat downloaded artifacts as data; subsequent executable trust is unmeasured.');
      if (step.uses?.startsWith('actions/upload-artifact@') && !safeArtifactPath(step.with?.path)) add('artifact-path',stepPath,'Upload explicit credential-free artifact paths only.');
      if (step.uses?.startsWith('actions/download-artifact@')) {
        const destination = posix.normalize(String(step.with?.path ?? '.'));
        destinations.push(destination);
        if (privileged) {
          const producer = artifactProducer(step,job,workflow,pins);
          if (!producer) add('artifact-origin',stepPath,'Require a dependency on a pinned, canonical-main producer and its immutable upload ID.');
          const after = steps.slice(steps.indexOf(step)+1);
          const guardIndex = after.findIndex(candidate => digestGuard(candidate,producer,destination,job,workflow));
          const firstPublisher = after.findIndex(candidate => publisher(candidate.run) || candidate.uses && !candidate.uses.startsWith('actions/download-artifact@'));
          const earlierPublisher = steps.slice(0,steps.indexOf(step)).some(candidate => publisher(candidate.run));
          if (guardIndex < 0 || earlierPublisher || firstPublisher >= 0 && guardIndex > firstPublisher) add('artifact-digest',stepPath,'Require the unconditional bash byte-bound ARTIFACT_SHA/ARTIFACT_FILE digest contract before publication.');
        }
      }
    }
  }
  return findings;
}

// Resolve canonical upstream evidence through an injected REST adapter. Only a
// typed 404 on action.yml permits action.yaml; transport failures never fallback.
export async function verifyActionProvenance(repository, pin, api) {
  if (typeof repository !== 'string' || !/^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?$/.test(repository) || !validPin(repository,pin)) throw new Error('invalid action provenance input');
  const parts = repository.split('/'), repo = parts.slice(0,2).join('/'), suffix = parts.slice(2).join('/');
  const reusable = suffix.startsWith('.github/workflows/');
  const metadataPath = reusable ? suffix : suffix ? `${suffix}/action.yml` : 'action.yml';
  let object = (await api(`repos/${repo}/git/ref/tags/${pin.tag}`))?.object;
  for (let depth=0; object?.type === 'tag' && depth<4; depth++) {
    if (!shaPattern.test(object.sha ?? '')) throw new Error('action provenance mismatch');
    object = (await api(`repos/${repo}/git/tags/${object.sha}`))?.object;
  }
  const release = await api(`repos/${repo}/releases/tags/${pin.tag}`);
  let metadata;
  try { metadata = await api(`repos/${repo}/contents/${metadataPath}?ref=${pin.sha}`); }
  catch (error) {
    if (reusable || error.status !== 404) throw error;
    metadata = await api(`repos/${repo}/contents/${metadataPath.replace(/\.yml$/,'.yaml')}?ref=${pin.sha}`);
  }
  if (!record(metadata) || !shaPattern.test(metadata.sha ?? '') || typeof metadata.content !== 'string' || !metadata.content.trim() || !/^[A-Za-z0-9+/=\s]+$/.test(metadata.content) || metadata.encoding !== 'base64') throw new Error('action provenance metadata incomplete');
  const document = parseDocument(Buffer.from(metadata.content,'base64').toString(),{uniqueKeys:true});
  if (document.errors.length) throw new Error('action provenance metadata invalid');
  const action = document.toJS({maxAliasCount:100});
  const runtime = reusable && eventNames(action?.on).includes('workflow_call') ? 'reusable' : action?.runs?.using;
  if (object?.type !== 'commit' || object.sha !== pin.sha || release?.tag_name !== pin.tag || release.draft !== false || release.html_url !== pin.release_url || metadata.sha !== pin.metadata_blob || runtime !== pin.runtime) throw new Error('action provenance mismatch');
  return true;
}

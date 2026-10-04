import test from 'node:test';
import assert from 'node:assert/strict';
import { auditWorkflow, verifyActionProvenance } from '../src/workflow-audit.mjs';
const sha = 'a'.repeat(40);
const pins = {actions:{'actions/checkout':{sha,tag:'v4.2.2',canonical_tag_sha:sha,runtime:'node20',metadata_blob:'b'.repeat(40),release_url:'https://github.com/actions/checkout/releases/tag/v4.2.2'}}};
const clean = `name: Fixture
on: pull_request
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@${sha}
        with:
          persist-credentials: false
      - run: npm ci
      - run: npm test
`;
test('same audit accepts clean control and rejects individual broken properties with locations', () => {
  assert.deepEqual(auditWorkflow(clean,pins,'fixture.yml'), []);
  const changes = [
    ['mutable-ref', clean.replace(sha,'v4')],
    ['readonly-default',clean.replace('contents: read','contents: write')],
    ['privileged-build',clean.replace('    steps:', '    permissions:\n      contents: write\n    steps:')],
    ['persisted-checkout-token',clean.replace('false','true')],
    ['event-shell-injection',clean.replace('npm test','echo ${{ github.event.pull_request.title }}')],
    ['missing-timeout',clean.replace('    timeout-minutes: 20\n','')],
  ];
  for(const [property,text] of changes) {
    const findings=auditWorkflow(text,pins,'fixture.yml');
    assert.ok(findings.some(f=>f.property===property),property);
    assert.ok(findings.every(f=>f.file==='fixture.yml'&&f.line>0));
  }
});
test('syntactically pinned fork-only objects have no accepted provenance',()=>{
  assert.ok(auditWorkflow(clean,pins).length===0);
  assert.ok(auditWorkflow(clean.replace(sha,'f'.repeat(40)),pins).some(f=>f.property==='action-provenance'));
  assert.ok(auditWorkflow(clean,{actions:{}}).some(f=>f.property==='action-provenance'));
});
test('privileged triggers require canonical main code, no caches, no executable artifact',()=>{
  const base=clean.replace('on: pull_request','on: workflow_run').replace('  test:','  publish:').replace('    steps:', '    permissions:\n      contents: write\n    steps:').replace('persist-credentials: false','ref: main\n          persist-credentials: false').replace('      - run: npm ci\n      - run: npm test','      - run: gh release create "$GITHUB_REF_NAME"');
  assert.deepEqual(auditWorkflow(base,pins),[]);
  for(const [property,text] of [
    ['privileged-checkout',base.replace('ref: main','ref: ${{ github.event.workflow_run.head_sha }}')],
    ['privileged-cache',base.replace('persist-credentials: false','persist-credentials: false\n          cache: npm')],
    ['unclassified-execution',base.replace('gh release create "$GITHUB_REF_NAME"','node dist/release.js')],
    ['privileged-build',base.replace('gh release create "$GITHUB_REF_NAME"','npm test')],
  ]) assert.ok(auditWorkflow(text,pins).some(f=>f.property===property),property);
});
test('credential and artifact scope stay explicit',()=>{
  assert.ok(auditWorkflow(clean.replace('    steps:', '    env:\n      TOKEN: ${{ secrets.DEPLOY }}\n    steps:'),pins).some(f=>f.property==='build-secret'));
  assert.ok(auditWorkflow(clean.replace('      - run: npm test','      - uses: actions/upload-artifact@'+sha+'\n        with:\n          path: .\n'),pins).some(f=>f.property==='artifact-path'));
  assert.ok(auditWorkflow(clean.replace('      - run: npm test','      - uses: owner/repo/.github/workflows/build.yml@v1\n        secrets: inherit\n'),pins).some(f=>f.property==='inherited-secrets'));
});
test('REST provenance allows published release-tag-only commits and refuses moved tags/fork objects',async()=>{
  const entry=pins.actions['actions/checkout'];
  const api=async path => path.includes('/git/ref/')?{object:{type:'commit',sha}}:path.includes('/releases/')?{tag_name:entry.tag,draft:false,html_url:entry.release_url}:{sha:entry.metadata_blob,encoding:'base64',content:Buffer.from('runs:\n  using: node20\n').toString('base64')};
  assert.equal(await verifyActionProvenance('actions/checkout',entry,api),true);
  await assert.rejects(verifyActionProvenance('actions/checkout',{...entry,sha:'f'.repeat(40)},api));
  await assert.rejects(verifyActionProvenance('actions/checkout',entry,async()=>({})),/provenance/);
});


test('malformed, partial and aliased YAML fail closed rather than disappear',()=>{
  for(const source of ['','jobs: [','jobs: {test: null}','jobs: {test: {steps: [null]}}','permissions: {}\npermissions: {contents: write}']) assert.ok(auditWorkflow(source,pins).length>0);
});


test('reusable workflow refs are pinned and their canonical metadata is read as a workflow',async()=>{
  const ref='owner/repo/.github/workflows/build.yml';
  const pin={...pins.actions['actions/checkout'],release_url:'https://github.com/owner/repo/releases/tag/v4.2.2',runtime:'reusable'};
  const text=`on: pull_request
permissions: {contents: read}
jobs:
  call:
    uses: ${ref}@${sha}
`;
  assert.deepEqual(auditWorkflow(text,{actions:{[ref]:pin}}),[]);
  const api=async path=>{
    if(path.includes('/git/ref/')) return {object:{type:'commit',sha}};
    if(path.includes('/releases/')) return {tag_name:pin.tag,draft:false,html_url:pin.release_url};
    assert.ok(path.includes('/contents/.github/workflows/build.yml?ref='));
    return {sha:pin.metadata_blob,encoding:'base64',content:Buffer.from(`on:
  workflow_call:
jobs: {}
`).toString('base64')};
  };
  assert.equal(await verifyActionProvenance(ref,pin,api),true);
});

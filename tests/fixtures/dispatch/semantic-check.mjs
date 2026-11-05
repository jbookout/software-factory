// Execute the pinned registered handler. Storage, authorization and transactions are synthetic.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { SourceTextModule, SyntheticModule } from 'node:vm';
const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const provenance = JSON.parse(read('carr/provenance.json'));
for (const [name, hash] of Object.entries(provenance.sources)) {
  assert.equal(createHash('sha256').update(read('carr/' + name)).digest('hex'), hash);
}
const module = new SourceTextModule(read('carr/work-queue.js'));
await module.link(async specifier => {
  if (specifier.endsWith('.json')) {
    return new SyntheticModule(['default'], function () {
      this.setExport('default', JSON.parse(read('carr/' + specifier.slice(2))));
    });
  }
  const exports = {
    './identity.js': { organizationTenantForActor: () => 'synthetic-tenant' },
    './derived-key.ts': { derivedIdempotencyKey: () => { throw Error('unexpected key derivation'); } },
    './work-request-read.ts': { readableWorkRequestSql: () => 'true' },
    './review-gate-comments.js': { independentApproval: () => { throw Error('unexpected review'); } },
  }[specifier];
  assert.ok(exports, specifier);
  return new SyntheticModule(Object.keys(exports), function () {
    for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
  });
});
await module.evaluate();
class ToolError extends Error {
  constructor(payload) { super(payload.error); this.payload = payload; }
}
const tools = module.namespace.workQueueTools({ ToolError, withEnvelope: async (c,a,n,args,run) => run(), writeEvent: async () => {} });
const c = { query: async sql => {
  if (sql.includes('select w.id,w.ref')) return { rows: [{ id: 'synthetic-wr', ref: 'WR-000622', state: 'open', title: 'Synthetic' }] };
  if (sql.includes('next from ops.work_request_job')) return { rows: [{ next: 33 }] };
  if (sql.includes('returning j_number')) return { rows: [{ j_number: 20 }] };
  if (sql.includes('select 1 from ops.work_request_slice')) return { rows: [{ exists: 1 }] };
  return { rows: [] };
} };
const request = JSON.parse(read('request.json')).card;
const response = await tools['dispatch-job'].handler(c, 'joe', request);
assert.deepEqual(response, JSON.parse(read('mint.json')).response);
await assert.rejects(tools['dispatch-job'].handler(c, 'joe', { ...request, description: 'Prepare one registered worker brief.' }),
  error => error.payload?.error === 'invalid_job_description');
console.log('Pinned dispatch-job accepts fixture, matches response, refuses invalid description.');

const registration = JSON.parse(read('registration.json'));
const registered = await tools['job-card-registration'].handler({ query: async () => ({ rows: [{
  executor: request.executor, model: request.model, repository: request.repository, work_request_state: 'open',
}] }) }, 'joe', { card_id: response.card_id });
assert.deepEqual(registered, registration);

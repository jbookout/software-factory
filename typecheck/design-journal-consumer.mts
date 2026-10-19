import { openDesignJournal, restoreDesignJournal, type JournalMutation, type JournalState, type JournalArtifact, type ArtifactDigest, type ArtifactRef } from 'software-factory/design-journal';
const scope = { userId: 'sample', projectId: 'task-app', version: 1 };
const journal = await openDesignJournal(scope);
const state: JournalState = await journal.execute({ command: 'read' });
const receipt = await journal.execute({ command: 'archive', bytes: 'eA==', origin: 'captured',
  expectedRevision: state.revision, idempotencyKey: 'archive-sample' });
if (!receipt.artifact) throw new Error('Archive receipt has no artifact');
const artifact: JournalArtifact = receipt.artifact;
const ref: ArtifactRef = artifact.ref;
const digest: ArtifactDigest = artifact.digest;
const bytes: Buffer = await journal.readArtifact(ref);
const archivedDecision: JournalMutation = { command: 'append', kind: 'decision', record: {
  schema: 'design-decision.v1', id: 'archive-decision', sourceRevision: 'a'.repeat(40), decision: 'Archive sample',
  rationale: 'Retain synthetic bytes', alternatives: [], limits: ['Synthetic only'], artifacts: [artifact] } };
// @ts-expect-error An artifact digest is not an artifact reference.
await journal.readArtifact(digest);
const swapped: JournalArtifact = {
  // @ts-expect-error A digest cannot occupy the reference field.
  ref: digest,
  // @ts-expect-error A reference cannot occupy the digest field.
  digest: ref,
};
// @ts-expect-error A plain string is not a journal-produced reference.
await journal.readArtifact('sha256:sample');
const binding = { expectedRevision: state.revision, idempotencyKey: 'sample' };
const commands: JournalMutation[] = [
  archivedDecision,
  { command: 'archive', bytes: bytes.toString('base64'), origin: 'captured' },
  { command: 'start-interview', sourceRevision: 'a'.repeat(40) },
  { command: 'answer-interview', response: { questionId: 'version', answer: { status: 'answered', value: 1 } } },
  { command: 'propose-scope', proposal: { workflow: 'Archive', reason: 'Owner request' } },
];
for (const command of commands) await journal.execute({ ...command, ...binding });
await journal.execute({ command: 'backup', destination: '/tmp/sample' });
await restoreDesignJournal({ root: '/tmp/restored', backupRoot: '/tmp/sample', ...scope });
// @ts-expect-error Mutation bindings are mandatory.
await journal.execute({ command: 'archive', bytes: 'eA==', origin: 'captured' });
// @ts-expect-error Commands cannot supply an authorization scope.
await journal.execute({ command: 'read', projectId: 'another-project' });
// @ts-expect-error Unknown origins are refused.
await journal.execute({ command: 'archive', bytes: 'eA==', origin: 'live', ...binding });
// @ts-expect-error Scope versions must be numeric.
await openDesignJournal({ ...scope, version: '1' });
// @ts-expect-error Record kinds select their own required record shape.
await journal.execute({ command: 'append', kind: 'decision', record: {}, ...binding });
// @ts-expect-error A proposal cannot supply a replacement interview.
await journal.execute({ command: 'propose-scope', proposal: { workflow: 'Archive', reason: 'Owner request' }, view: {}, ...binding });

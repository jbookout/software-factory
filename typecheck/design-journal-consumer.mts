import { openDesignJournal, restoreDesignJournal, type JournalMutation, type JournalState } from 'software-factory/design-journal';
const scope = { userId: 'sample', projectId: 'task-app', version: 1 };
const journal = await openDesignJournal(scope);
const state: JournalState = await journal.execute({ command: 'read' });
const bytes: Buffer = await journal.readArtifact('sha256:sample');
const binding = { expectedRevision: state.revision, idempotencyKey: 'sample' };
const commands: JournalMutation[] = [
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

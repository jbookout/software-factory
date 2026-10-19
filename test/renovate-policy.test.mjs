import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('dependency automerge is confined to CI-gated npm development patches', async () => {
  const policy = JSON.parse(await readFile(new URL('../renovate.json', import.meta.url)));
  assert.equal(policy.automerge, false);
  assert.equal(policy.automergeType, 'pr');
  assert.equal(policy.platformAutomerge, false);
  assert.equal(policy.ignoreTests, false);
  assert.equal(policy.internalChecksAsSuccess, false);
  const automatic = policy.packageRules.filter(rule => rule.automerge === true);
  assert.equal(automatic.length, 1);
  assert.deepEqual(automatic[0].matchManagers, ['npm']);
  assert.deepEqual(automatic[0].matchDepTypes, ['devDependencies']);
  assert.deepEqual(automatic[0].matchUpdateTypes, ['patch']);
  assert.ok(automatic[0].groupName);
  assert.equal(policy.lockFileMaintenance.automerge, false);
  assert.equal(policy.vulnerabilityAlerts.automerge, false);
});

test('maintenance runs weekly, includes fixtures, and keeps Actions pinned for review', async () => {
  const policy = JSON.parse(await readFile(new URL('../renovate.json', import.meta.url)));
  assert.equal(policy.timezone, 'America/Chicago');
  assert.deepEqual(policy.schedule, ['* 0-5 * * 1']);
  assert.equal(policy.prCreation, 'immediate');
  assert.deepEqual(policy.enabledManagers, ['npm', 'pip_requirements', 'github-actions']);
  assert.deepEqual(policy.ignorePaths, []);
  assert.equal(policy.ignoreScripts, true);
  assert.equal(policy.separateMajorMinor, true);
  assert.equal(policy.separateMinorPatch, true);
  assert.equal(policy.lockFileMaintenance.enabled, true);
  assert.deepEqual(policy.lockFileMaintenance.schedule, policy.schedule);
  const actions = policy.packageRules.find(rule => rule.matchManagers?.includes('github-actions'));
  assert.equal(actions.pinDigests, true);
});

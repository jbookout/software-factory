import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDesignSettings, resolveDesignSettings, resolveDesignAssignment } from 'software-factory/design-settings'

test('private Joe settings bind editable workers and modes to immutable new assignments', async () => {
  const profile = JSON.parse(await readFile(new URL('../../config/design-manager/joe.example.json', import.meta.url)))
  const root = await mkdtemp(join(tmpdir(), 'design-settings-'))
  const file = join(root, 'settings.json')
  await writeFile(file, JSON.stringify(profile), { mode: 0o600 })
  const settings = await loadDesignSettings(file)
  const first = resolveDesignAssignment(settings, { station: 'design', mode: 'fast' })
  assert.equal(first.userId, 'joe')
  assert.equal(first.version, 1)
  assert.match(first.settingsDigest, /^sha256:[a-f0-9]{64}$/)
  assert.equal(first.assignments[0].workerId, 'codex')
  assert.equal(first.assignments[0].effort, 'low')
  assert.equal(first.assignments[1].workerId, 'claude')
  assert.equal(first.assignments[1].purpose, 'judgment')
  profile.version = 2
  profile.modes.fast.codex.effort = 'medium'
  await writeFile(file, JSON.stringify(profile))
  const next = resolveDesignAssignment(await loadDesignSettings(file), { station: 'design', mode: 'fast' })
  assert.equal(next.assignments[0].effort, 'medium')
  assert.notEqual(next.settingsDigest, first.settingsDigest)
  assert.equal(first.assignments[0].effort, 'low')
  assert.throws(() => { first.assignments[0].effort = 'max' }, TypeError)
  assert.throws(() => resolveDesignAssignment(settings, { station: 'design', mode: 'free-spend' }), /mode/)
})

test('schema and route checks block missing/unknown routes, credentials, provider expansion and mode bypass', async () => {
  const baseline = JSON.parse(await readFile(new URL('../../config/design-manager/joe.example.json', import.meta.url)))
  for (const mutate of [
    p => { delete p.stations.design[0].route },
    p => { p.stations.design[0].route = 'paid-api' },
    p => { p.stations.design[0].workerId = 'unknown' },
    p => { p.workers.codex.allowedRoutes = ['claude-subscription'] },
    p => { p.workers.codex.apiKey = 'synthetic-secret' },
    p => { p.workers.codex.concurrency = 0 },
    p => { p.workers.codex.provider = 'new-provider' },
    p => { p.modes.fast.codex.weakenRubrics = true },
    p => { p.modes.fast.unknown = { model: 'synthetic', effort: 'low' } },
    p => { p.stations.design.push(p.stations.design[0]) },
    p => { p.stations.design = p.stations.design.filter(a => a.purpose !== 'work') },
    p => { delete p.modes.thorough },
  ]) {
    const profile = structuredClone(baseline)
    mutate(profile)
    assert.throws(() => resolveDesignSettings(profile), /settings|worker|route|purpose|allocation/)
  }
})

test('all stations/modes resolve from user configuration; source edits and key order cannot rewrite prior bindings', async () => {
  const profile = JSON.parse(await readFile(new URL('../../config/design-manager/joe.example.json', import.meta.url)))
  const original = resolveDesignSettings(profile)
  const reversed = Object.fromEntries(Object.entries(profile).reverse())
  assert.equal(resolveDesignSettings(reversed).digest, original.digest)
  profile.workers['alternate-codex'] = { ...profile.workers.codex, model: 'synthetic-account-model',
    effort: 'xhigh', concurrency: 3, availability: 'unavailable' }
  profile.stations.define[0].workerId = 'alternate-codex'
  const custom = resolveDesignSettings(profile)
  const allocation = resolveDesignAssignment(custom, { station: 'define', mode: 'efficient-eco' })
  assert.equal(allocation.assignments[0].workerId, 'alternate-codex')
  assert.equal(allocation.assignments[0].model, 'synthetic-account-model')
  assert.equal(allocation.assignments[0].concurrency, 3)
  assert.equal(allocation.assignments[0].availability, 'unavailable')
  for (const station of ['research', 'define', 'design', 'prove', 'ship']) {
    for (const mode of ['fast', 'thorough', 'specialist', 'best-available', 'efficient-eco']) {
      assert.equal(resolveDesignAssignment(custom, { station, mode }).settingsDigest, custom.digest)
    }
  }
  profile.workers.codex.model = 'another-model'
  assert.equal(resolveDesignAssignment(original, { station: 'define', mode: 'fast' }).assignments[0].model, 'gpt-6.1-sol')
  assert.throws(() => resolveDesignAssignment({ profile: custom.profile, digest: original.digest }, { station: 'define', mode: 'fast' }), /digest/)
  assert.throws(() => resolveDesignAssignment(custom, { station: 'missing', mode: 'fast' }), /station/)
  await assert.rejects(loadDesignSettings('/no-such-private-settings.json'), { code: 'ENOENT' })
})

test('inherited object names are not configured workers', async () => {
  const profile = JSON.parse(await readFile(new URL('../../config/design-manager/joe.example.json', import.meta.url)))
  profile.stations.design[0].workerId = 'constructor'
  assert.throws(() => resolveDesignSettings(profile), /unknown worker constructor/)
})

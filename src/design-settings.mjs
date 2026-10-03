import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import { DESIGN_STATIONS, MODEL_MODES } from './design-manager.mjs'

const schema = JSON.parse(readFileSync(new URL('../schemas/design-settings.schema.json', import.meta.url)))
const ajv = new Ajv2020({ strict: true })
const validate = ajv.compile(schema)
const routeProviders = Object.freeze({ 'codex-cloud': 'codex', 'claude-subscription': 'claude',
  'dot-chatgpt': 'dot', 'grok-research': 'grok' })

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}

// Canonical key order binds meaning, independent of JSON whitespace/key ordering.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]))
  return value
}

export function resolveDesignSettings(profile) {
  if (!validate(profile)) throw new Error(`invalid design settings: ${ajv.errorsText(validate.errors)}`)
  for (const [id, worker] of Object.entries(profile.workers)) {
    for (const route of worker.allowedRoutes) {
      if (routeProviders[route] !== worker.provider) throw new Error(`worker ${id}: route ${route} does not match provider`)
    }
  }
  for (const [station, assignments] of Object.entries(profile.stations)) {
    const seen = new Set()
    for (const assignment of assignments) {
      const worker = profile.workers[assignment.workerId]
      if (!Object.hasOwn(profile.workers, assignment.workerId)) throw new Error(`${station}: unknown worker ${assignment.workerId}`)
      if (!worker.allowedRoutes.includes(assignment.route)) throw new Error(`${station}: route is not allowed for ${assignment.workerId}`)
      if (seen.has(assignment.purpose)) throw new Error(`${station}: duplicate purpose ${assignment.purpose}`)
      seen.add(assignment.purpose)
    }
    if (!seen.has('work')) throw new Error(`${station}: missing work allocation`)
  }
  for (const [mode, choices] of Object.entries(profile.modes)) {
    for (const workerId of Object.keys(choices)) {
      if (!Object.hasOwn(profile.workers, workerId)) throw new Error(`${mode}: unknown worker ${workerId}`)
    }
  }
  const snapshot = canonical(profile)
  const digest = `sha256:${createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')}`
  return freeze({ profile: snapshot, digest })
}

export async function loadDesignSettings(file = join(homedir(), '.config/software-factory/design-manager/settings.json')) {
  return resolveDesignSettings(JSON.parse(await readFile(file, 'utf8')))
}

// Resolves configuration only. This never dispatches or grants gate authority.
export function resolveDesignAssignment(settings, { station, mode }) {
  if (!DESIGN_STATIONS.includes(station)) throw new Error(`unknown station: ${station}`)
  if (!MODEL_MODES.includes(mode)) throw new Error(`unknown mode: ${mode}`)
  const checked = resolveDesignSettings(settings.profile)
  if (checked.digest !== settings.digest) throw new Error('settings digest mismatch')
  const profile = checked.profile
  return freeze({ userId: profile.userId, version: profile.version, settingsDigest: checked.digest, station, mode,
    assignments: profile.stations[station].map(assignment => {
      const worker = profile.workers[assignment.workerId]
      return { ...assignment, provider: worker.provider, model: worker.model, effort: worker.effort,
        ...profile.modes[mode][assignment.workerId], concurrency: worker.concurrency, availability: worker.availability }
    }) })
}

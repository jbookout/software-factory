#!/usr/bin/env node
import { loadDesignSettings, resolveDesignAssignment } from '../src/design-settings.mjs'
import { qualifyCodexCloud } from '../src/codex-cloud-qualification.mjs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

const usage = 'design-cloud-qualify [--settings PRIVATE_JSON] [--state PRIVATE_RECEIPT] [--mode MODE] [--environment-id ID --branch BRANCH] [--timeout-ms 30000]'
try {
  const args = process.argv.slice(2)
  if (args.includes('--help')) { console.log(usage); process.exit(0) }
  const flags = {}
  const allowed = ['--settings', '--state', '--mode', '--environment-id', '--branch', '--timeout-ms']
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || !args[i + 1] || flags[args[i]]) throw new Error(usage)
    flags[args[i]] = args[i + 1]
  }
  if (Boolean(flags['--environment-id']) !== Boolean(flags['--branch'])) throw new Error('environment ID and explicit factory branch must be supplied together')
  const settings = await loadDesignSettings(flags['--settings'])
  const binding = resolveDesignAssignment(settings, { station: 'define', mode: flags['--mode'] ?? 'fast' })
  const work = binding.assignments.find(a => a.purpose === 'work')
  if (work.route !== 'codex-cloud' || work.provider !== 'codex' || work.availability !== 'available') throw new Error('configured Define worker is not available on codex-cloud; no alternate provider will be selected')
  const stateFile = flags['--state'] ? resolve(flags['--state']) : join(homedir(), '.local/share/software-factory/design-manager/qualifications', `${Date.now()}.json`)
  const factory = fileURLToPath(new URL('../', import.meta.url))
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: factory, encoding: 'utf8' }).trim()
  if (resolve(root) !== resolve(factory)) throw new Error('qualification script must execute from its factory checkout')
  const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: factory, encoding: 'utf8' }).trim()
  const receipt = await qualifyCodexCloud({ stateFile, cwd: factory, sourceRevision,
    model: work.model, effort: work.effort, settingsBinding: {
      userId: binding.userId, version: binding.version, settingsDigest: binding.settingsDigest,
      workerId: work.workerId, station: binding.station, mode: binding.mode
    }, timeoutMs: Number(flags['--timeout-ms'] ?? 30000), environment: flags['--environment-id'] ? {
      id: flags['--environment-id'], branch: flags['--branch'], repository: 'jbookout/software-factory', factoryOnly: true
    } : null })
  console.log(JSON.stringify({ stateFile, qualified: receipt.qualified, taskId: receipt.taskId,
    cliVersion: receipt.cliVersion, checks: receipt.checks, dependentRoutes: receipt.dependentRoutes }, null, 2))
  process.exitCode = receipt.qualified ? 0 : 2
} catch (error) { console.error(error.message); process.exitCode = 1 }

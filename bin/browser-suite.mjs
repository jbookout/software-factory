#!/usr/bin/env node
import { loadDeliveryConfig } from '../src/pr-delivery.mjs'
import { Deadline } from '../src/deadline.mjs'
import { reserveCompute } from '../src/process-capacity.mjs'
import { runProcess } from '../src/process-runner.mjs'
import { fileURLToPath } from 'node:url'

const [configPath, repo, ...files] = process.argv.slice(2)
const controller = new AbortController()
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort())
let release
try {
  const config = await loadDeliveryConfig(configPath)
  if (!config.resources || !Object.hasOwn(config.repos, repo) || !files.length || files.some(file => file.startsWith('-')))
    throw new Error('browser tests require resource config, configured repository and explicit files')
  const workers = Number(process.env.FACTORY_BROWSER_CONCURRENCY ?? config.resources.browserConcurrency)
  if (!Number.isSafeInteger(workers) || workers < 1 || workers > config.resources.browserConcurrency)
    throw new Error('browser concurrency exceeds configured reservation')
  const budget = new Deadline(config.attemptTimeoutMs, { signal: controller.signal })
  release = await reserveCompute(config, workers, budget.phaseBudget('queue', config.queueTimeoutMs))
  let acknowledgement = ''
  const reporter = fileURLToPath(new URL('../src/browser-test-reporter.mjs', import.meta.url))
  const result = await runProcess([process.execPath, '--test', `--test-reporter=${reporter}`, `--test-concurrency=${workers}`, ...files], {
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')),
    cwd: config.repos[repo].checkout, timeoutMs: Math.max(1, Math.floor(Math.min(config.limits.timeoutMs, budget.remaining()))),
    signal: controller.signal, captureOutput: false,
    onOutput: (chunk, stream) => {
      if (stream === 'stdout' && acknowledgement.length <= 100) acknowledgement += chunk
    },
    onSpawn: (job, signal) => release.bindJob(job, signal)
  })
  const passed = /^pass ([1-9]\d*)\n$/.exec(acknowledgement)?.[1]
  process.exitCode = result.code || (passed ? 0 : 1)
  process.stdout.write(process.exitCode ? `browser tests exited ${process.exitCode}\n` : `pass ${passed}\n`)
} catch (error) {
  // No provider/process arguments or output are persisted on refusal.
  process.stderr.write(`${error.code === 142 ? error.message : 'browser execution refused'}\n`)
  process.exitCode = Number.isInteger(error.code) ? error.code : 1
} finally { if (release) await release() }

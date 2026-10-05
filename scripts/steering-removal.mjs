#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { readPinnedContract, createPinnedBuildContext, replaySteeringRemoval } from '../src/model-room.mjs'
import { createArtifactReader } from '../src/evidence.mjs'

const [planFile, adapterFile, reportFile] = process.argv.slice(2)
if (!planFile || !adapterFile || !reportFile || process.argv.length !== 5) {
  console.error('Usage: node scripts/steering-removal.mjs PLAN.json EVALUATOR.mjs REPORT.json')
  process.exitCode = 2
} else {
  try {
    // A pending file is evidence of an interrupted run, never permission to rerun it.
    const output = await fs.open(reportFile, 'wx', 0o600)
    try {
      const runId = randomUUID()
      await output.writeFile(JSON.stringify({ status: 'pending', runId,
        instruction: 'Observe existing trials before retry.' }) + '\n')
      await output.sync()
      const plan = JSON.parse(await fs.readFile(planFile, 'utf8'))
      const context = createPinnedBuildContext([await readPinnedContract(plan.steering)])
      const evaluatorDigest = createHash('sha256').update(await fs.readFile(adapterFile)).digest('hex')
      const { execute, judge } = await import(pathToFileURL(path.resolve(adapterFile)))
      // Replace complete snapshots atomically; interruption cannot erase the last receipt.
      const onProgress = async report => {
        const temporary = `${reportFile}.${runId}.tmp`
        const next = await fs.open(temporary, 'wx', 0o600)
        try {
          await next.writeFile(JSON.stringify(report, null, 2) + '\n')
          await next.sync()
        } finally { await next.close() }
        await fs.rename(temporary, reportFile)
        const directory = await fs.open(path.dirname(path.resolve(reportFile)), 'r')
        try { await directory.sync() } finally { await directory.close() }
      }
      const report = await replaySteeringRemoval({ context, path: plan.steering.path,
        line: plan.line, boundary: plan.boundary, tasks: plan.tasks, route: plan.route,
        repetitions: plan.repetitions, timeoutMs: plan.timeoutMs,
        runId: plan.runId ?? runId, evaluatorDigest, onProgress,
        execute, judge, readArtifact: createArtifactReader(plan.artifactRoot) })
      console.log(JSON.stringify({ decision: report.decision, pairs: report.pairs.length,
        regressions: report.regressions.length, failures: report.failures.length,
        experimentDigest: report.experimentDigest }))
    } finally { await output.close() }
  } catch {
    console.error('Steering replay did not complete. Inspect the plan and pending report; observe trials before retry.')
    process.exitCode = 1
  }
}

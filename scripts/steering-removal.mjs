#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { readPinnedContract, createPinnedBuildContext, replaySteeringRemoval } from '../src/model-room.mjs'
import { createArtifactReader } from '../src/evidence.mjs'

const [planFile, adapterFile, reportFile] = process.argv.slice(2)
if (!planFile || !adapterFile || !reportFile || process.argv.length !== 5) {
  console.error('Usage: node scripts/steering-removal.mjs PLAN.json EVALUATOR.mjs REPORT.json')
  process.exitCode = 2
} else {
  try {
    const plan = JSON.parse(await fs.readFile(planFile, 'utf8'))
    const context = createPinnedBuildContext([await readPinnedContract(plan.steering)])
    const evaluatorDigest = createHash('sha256').update(await fs.readFile(adapterFile)).digest('hex')
    const { execute, judge } = await import(pathToFileURL(path.resolve(adapterFile)))
    // A pending file is evidence of an interrupted run, never permission to rerun it.
    const output = await fs.open(reportFile, 'wx', 0o600)
    try {
      await output.writeFile(JSON.stringify({ status: 'pending', instruction: 'Observe existing trials before retry.' }) + '\n')
      const report = await replaySteeringRemoval({ context, path: plan.steering.path,
        line: plan.line, boundary: plan.boundary, tasks: plan.tasks, route: plan.route,
        repetitions: plan.repetitions, timeoutMs: plan.timeoutMs,
        runId: plan.runId, evaluatorDigest,
        execute, judge, readArtifact: createArtifactReader(plan.artifactRoot) })
      const bytes = JSON.stringify(report, null, 2) + '\n'
      await output.truncate(0)
      await output.write(bytes, 0, 'utf8')
      await output.sync()
      console.log(JSON.stringify({ decision: report.decision, pairs: report.pairs.length,
        regressions: report.regressions.length, failures: report.failures.length,
        experimentDigest: report.experimentDigest }))
    } finally { await output.close() }
  } catch {
    console.error('Steering replay did not complete. Inspect the plan and pending report; observe trials before retry.')
    process.exitCode = 1
  }
}

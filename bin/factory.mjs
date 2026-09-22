#!/usr/bin/env node
import fs from "node:fs/promises"
import path from "node:path"

import { createFactory, createScriptAdapter, createPinnedBuildContext,
  readPinnedContract, routeDoctorCreBuild, selectOptionalBuildContext } from "../src/index.mjs"

const [jobPath, profilePath] = process.argv.slice(2)
if (!jobPath || !profilePath) {
  process.stderr.write("usage: npm run factory -- <job.json> <product-profile.json>\n")
  process.exitCode = 2
} else {
  const job = JSON.parse(await fs.readFile(jobPath, "utf8"))
  const profile = JSON.parse(await fs.readFile(profilePath, "utf8"))
  const root = path.resolve(path.dirname(profilePath), profile.root ?? ".")
  const adapter = createScriptAdapter({
    root,
    commands: profile.commands,
    timeoutMs: profile.timeoutMs,
    maxOutputBytes: profile.maxOutputBytes
  })
  const modelRoomAdvisor = profile.modelRoom?.enabled === true ? async () => {
    const load = reference =>
      readPinnedContract({ root: path.resolve(path.dirname(profilePath), reference.root),
        sourceRevision: reference.sourceRevision, path: reference.path,
        startLine: reference.startLine, endLine: reference.endLine })
    const contracts = await Promise.all(profile.modelRoom.contracts.map(load))
    const optional = await Promise.all((profile.modelRoom.optionalContext ?? []).map(load))
    const selection = await selectOptionalBuildContext({ task: job.outcome, chunks: optional,
      apiKey: process.env.TYPESAFE_API_KEY })
    const buildContext = createPinnedBuildContext([...contracts, ...selection.contracts])
    const route = await routeDoctorCreBuild({ task: job.outcome, contracts,
      baseline: profile.modelRoom.baseline, candidates: profile.modelRoom.candidates,
      observations: [], verifyObservation: () => false, controlEnabled: false,
      apiKey: process.env.TYPESAFE_API_KEY })
    const { contracts: selectedText, ...contextSelection } = selection
    return { ...route, context_selection: contextSelection, build_context: buildContext }
  } : null
  const result = await createFactory({ modelRoomAdvisor }).run(job, adapter)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (result.outcome !== "complete") process.exitCode = 1
}

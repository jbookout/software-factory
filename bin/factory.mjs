#!/usr/bin/env node
import fs from "node:fs/promises"
import path from "node:path"

import { createFactory, createScriptAdapter } from "../src/index.mjs"

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
  const result = await createFactory().run(job, adapter)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (result.outcome !== "complete") process.exitCode = 1
}

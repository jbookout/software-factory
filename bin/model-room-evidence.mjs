#!/usr/bin/env node
import fs from "node:fs/promises"
import path from "node:path"

import { signEvaluationBundle } from "../src/index.mjs"

const [command, inputPath, outputPath] = process.argv.slice(2)
if (command !== "sign" || !inputPath || !outputPath) {
  process.stderr.write("usage: node bin/model-room-evidence.mjs sign <observations.json> <bundle.json>\n")
  process.exitCode = 2
} else {
  const key = process.env.MODEL_ROOM_EVALUATION_KEY
  const input = JSON.parse(await fs.readFile(path.resolve(inputPath), "utf8"))
  const bundle = signEvaluationBundle(input, key)
  await fs.writeFile(path.resolve(outputPath), `${JSON.stringify(bundle, null, 2)}\n`, { flag: "wx" })
  process.stdout.write(`${JSON.stringify({ schema: bundle.schema,
    observations: bundle.observations.length, output: path.resolve(outputPath) })}\n`)
}

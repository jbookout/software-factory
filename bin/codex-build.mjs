#!/usr/bin/env node
import { runCodexBuild } from "../src/codex-build.mjs"

let input = ""
for await (const chunk of process.stdin) input += chunk
try {
  const result = await runCodexBuild(JSON.parse(input))
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (result.status !== "pass") process.exitCode = 1
} catch (error) {
  process.stderr.write(`${error.name}: ${error.message}\n`)
  process.exitCode = 1
}

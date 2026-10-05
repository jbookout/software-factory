#!/usr/bin/env node
// node bin/delivery-shadow-compare.mjs <stateDir>/shadow.jsonl
// Prints agreement between shadow decisions and the old scripts' outcomes.
import fs from "node:fs/promises"
import { compareShadow } from "../src/delivery-shadow.mjs"

const [file] = process.argv.slice(2)
try {
  if (!file) throw new Error("usage: delivery-shadow-compare.mjs <shadow.jsonl>")
  const records = (await fs.readFile(file, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line))
  process.stdout.write(JSON.stringify(compareShadow(records), null, 2) + "\n")
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}

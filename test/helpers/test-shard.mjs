import path from "node:path"
import { fileURLToPath } from "node:url"

// node --test parallelizes files, never the top-level tests inside one file, so
// a long serial suite becomes the run's critical path. The suite registers cases
// round-robin: run as its own entry it is shard 0, and `<suite>.shard-<k>.test.mjs`
// importing it is shard k. Any other entry (a focused run that imports it, or
// in-process isolation) registers every case.
export function shardedTest(test, suiteUrl, total, entry = process.argv[1]) {
  const suite = fileURLToPath(suiteUrl)
  const prefix = `${path.basename(suite, ".test.mjs")}.shard-`, name = path.basename(entry ?? "")
  const shard = entry && path.resolve(entry) === suite ? 0
    : name.startsWith(prefix) ? Number(/^(\d+)\.test\.mjs$/.exec(name.slice(prefix.length))?.[1] ?? -1) : -1
  if (!(shard >= 0 && shard < total)) return test
  let count = 0
  return (...args) => count++ % total === shard ? test(...args) : undefined
}

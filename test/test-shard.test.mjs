import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { shardedTest } from "./helpers/test-shard.mjs"

const suite = path.resolve("/repo/test/long.test.mjs"), suiteUrl = pathToFileURL(suite).href
const registered = entry => {
  const names = [], record = name => names.push(name)
  const sharded = shardedTest(record, suiteUrl, 2, entry)
  for (let i = 0; i < 7; i++) sharded(`case ${i}`)
  return names
}

test("a long serial suite splits into disjoint shard entries that cover every case once", () => {
  const first = registered(suite), second = registered("/repo/test/long.shard-1.test.mjs")
  assert.deepEqual(first, ["case 0", "case 2", "case 4", "case 6"])
  assert.deepEqual(second, ["case 1", "case 3", "case 5"])
  assert.deepEqual([...first, ...second].sort(), registered(undefined).sort())
})

test("an unrelated entry or a shard outside the declared count registers every case", () => {
  assert.equal(registered("/repo/test/other.test.mjs").length, 7)
  assert.equal(registered("/repo/test/long.shard-2.test.mjs").length, 7)
})

test("the PR delivery suite runs as two parallel shard entries", async () => {
  const entry = fileURLToPath(new URL("./pr-delivery.shard-1.test.mjs", import.meta.url))
  assert.match(await fs.readFile(entry, "utf8"), /^import "\.\/pr-delivery\.test\.mjs"$/m)
  const source = await fs.readFile(new URL("./pr-delivery.test.mjs", import.meta.url), "utf8")
  assert.match(source, /shardedTest\(nodeTest, import\.meta\.url, 2\)/)
})

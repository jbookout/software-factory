import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { askJev } from "../src/jev-usage.mjs"

test("one billable Model Room answer is receipted and an exact repeat is cached", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-usage-"))
  const usageLog = join(root, "jev-calls.jsonl")
  let calls = 0
  const fetchImpl = async () => {
    calls++
    return { ok: true, json: async () => ({ model: "jev-1.13.0",
      answers: { q: { type: "noul", noul: 0.8 } },
      usage: { input_tokens: 100, output_tokens: 3 } }) }
  }
  const input = { caller: "model-room-route", apiKey: "synthetic-secret", fetchImpl,
    state: { task: "route" }, model: "jev-1.13.0",
    questions: { q: { type: "noul", instructions: "Does it fit?" } },
    usageLog, cacheDir: join(root, "cache") }
  const first = await askJev(input)
  const second = await askJev(input)
  assert.equal(calls, 1)
  assert.equal(first.usage.input_tokens, 100)
  assert.equal(second.usage, null)
  assert.equal(second.cache_hit, true)
  const rows = (await readFile(usageLog, "utf8")).trim().split("\n").map(JSON.parse)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].caller, "model-room-route")
  assert.equal(rows[0].ok, true)
  assert.equal(rows[0].usage.input_tokens, 100)
  assert.equal(rows[1].ok, false)
  assert.equal(rows[1].cache_hit, true)
  assert.equal(JSON.stringify(rows).includes("synthetic-secret"), false)
  assert.equal(JSON.stringify(rows).includes("Does it fit?"), false)
});

test("a malformed HTTP 200 answer still records its measured token charge", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-usage-invalid-"))
  const usageLog = join(root, "jev-calls.jsonl")
  await assert.rejects(askJev({ caller: "model-room-route", apiKey: "synthetic-secret",
    state: "x", model: "jev-1.13.0", questions: { q: { type: "noul", instructions: "x" } },
    usageLog, cacheDir: join(root, "cache"), fetchImpl: async () => ({ ok: true,
      json: async () => ({ model: "jev-1.13.0", answers: {},
        usage: { input_tokens: 25, output_tokens: 0 } }) }),
  }))
  const rows = (await readFile(usageLog, "utf8")).trim().split("\n").map(JSON.parse)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].usage.input_tokens, 25)
  assert.equal(rows[0].ok, false)
  assert.equal(rows[0].http_status, 200)
})

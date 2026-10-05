import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, mkdir, readFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { askJev, carrAsk } from "../src/jev-usage.mjs"

const input = { caller: "model-room-route", apiKey: "synthetic-secret", state: "fixture",
  model: "jev-1.13.0", questions: { q: { type: "noul", instructions: "fixture" } } }

test("production factory calls delegate admission and attribution to CARR", async () => {
  const calls = []
  await assert.rejects(askJev({ ...input, sharedAsk: async request => {
    calls.push(request)
    throw new Error("site_daily_budget")
  } }), /site_daily_budget/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].caller, "adhoc:factory:model-room-route")
  assert.equal(calls[0].api_key, "synthetic-secret")
})

test("factory preserves shared cache and measured usage without private counters", async () => {
  const results = [{ model: input.model, answers: { q: { noul: 0.8 } },
    usage: { input_tokens: 100, output_tokens: 3 } },
  { model: input.model, answers: { q: { noul: 0.8 } }, usage: null, cache_hit: true }]
  const sharedAsk = async () => results.shift()
  assert.equal((await askJev({ ...input, sharedAsk })).usage.input_tokens, 100)
  assert.equal((await askJev({ ...input, sharedAsk })).cache_hit, true)
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "factory-jev-"))
  await mkdir(join(root, "ops"))
  await writeFile(join(root, "ops/typesafe_client.py"), `import json, sys\ndef _command():\n    payload = json.load(sys.stdin)\n    assert payload["caller"] == "adhoc:factory:model-room-route"\n    print(json.dumps({"schema":"carr-jev-admission/v1","ok":False,"error":"credit_hold"}))\n    return 1\n`)
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }
  for (const args of [["init", "-q"], ["add", "ops/typesafe_client.py"],
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null",
      "commit", "-qm", "fixture"]]) execFileSync("git", args, { cwd: root, env })
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", env }).trim()
  return { root, sourceSha, python: "python3" }
}

test("process adapter propagates a shared refusal and requires exact clean source", async () => {
  const options = await fixture()
  const sharedAsk = request => carrAsk(request, options)
  await assert.rejects(askJev({ ...input, sharedAsk }), /credit_hold/)
  await assert.rejects(carrAsk({}, { ...options, sourceSha: "0".repeat(40) }), /revision mismatch/)
  await assert.rejects(carrAsk({}, { ...options, sourceSha: undefined }), /revision required/)
  await writeFile(join(options.root, "ops/typesafe_client.py"), "print('wrong')")
  await assert.rejects(carrAsk({}, options), /source is modified/)
})

test("factory source contains no private paid endpoint, counter, cache or receipt writer", async () => {
  const source = await readFile(new URL("../src/jev-usage.mjs", import.meta.url), "utf8")
  assert.doesNotMatch(source, /api\.typesafe\.ai|fetch\(|appendFile|CACHE_MS|daily_cap/)
  for (const root of ["src", "bin", "scripts", "deploy", "capabilities"]) {
    const base = new URL(`../${root}/`, import.meta.url)
    for (const rel of await readdir(base, { recursive: true })) {
      if (!/\.(mjs|js|py|sh)$/.test(rel) || /(^|\/)test/.test(rel)) continue
      const code = await readFile(new URL(rel, base), "utf8")
      assert.doesNotMatch(code, /https:\/\/api\.typesafe\.ai\/|["']ask-jev["']/,
        `${root}/${rel}: paid Jev calls must use the shared CARR admission adapter`)
    }
  }
})

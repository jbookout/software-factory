import test from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { createScriptAdapter } from "../src/adapters.mjs"
const root = fileURLToPath(new URL("..", import.meta.url))

test("script adapter preserves JSON text split across UTF-8 byte chunks", async () => {
  const adapter = createScriptAdapter({ root, commands: { verify: [process.execPath, "-e", `
    process.stdout.write(Buffer.concat([Buffer.from('{"status":"pass","data":{"text":"'), Buffer.from([0xe2])]));
    setTimeout(() => process.stdout.write(Buffer.concat([Buffer.from([0x82,0xac]), Buffer.from('"}}')])), 50);
  `] } })
  assert.equal((await adapter.execute("verify", {})).data.text, "€")
})

test("script cancellation retains readback obligation through execute", async () => {
  const controller = new AbortController()
  const adapter = createScriptAdapter({ root, timeoutMs: 1000,
    commands: { build: [process.execPath, "-e", "setInterval(()=>{},1000)"] } })
  const timer = setTimeout(() => controller.abort(), 300)
  try {
    await assert.rejects(adapter.execute("build", {}, { signal: controller.signal }), error => {
      assert.equal(error.cancelled, true)
      assert.equal(error.uncertain, true)
      assert.equal(error.nextAction, "readback-before-retry")
      return true
    })
  } finally { clearTimeout(timer) }
})

test("script adapter rejects a missing executable rather than normalizing a step failure", async () => {
  const adapter = createScriptAdapter({ root,
    commands: { verify: ["/missing-factory-fixture-executable", "literal"] } })
  await assert.rejects(adapter.execute("verify", {}), { code: "ENOENT",
    message: "spawn /missing-factory-fixture-executable ENOENT" })
})

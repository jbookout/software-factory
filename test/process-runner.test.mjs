import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { runProcess } from "../src/process-runner.mjs"
import { runCodexBuild } from "../src/codex-build.mjs"
import { createPinnedBuildContext } from "../src/model-room.mjs"

test("buffered streams preserve UTF-8 split across byte chunks", async () => {
  const result = await runProcess([process.execPath, "-e", `
    for (const s of [process.stdout, process.stderr]) s.write(Buffer.from([0xe2]));
    setTimeout(() => { for (const s of [process.stdout, process.stderr]) s.write(Buffer.from([0x82,0xac])); }, 50);
  `])
  assert.equal(result.code, 0)
  assert.equal(result.stdout, "€")
  assert.equal(result.stderr, "€")
})

test("process seam treats arguments literally without a shell", async () => {
  const literal = "$(not-a-command); `not-a-command`"
  const result = await runProcess([process.execPath, "-e", "process.stdout.write(process.argv[1])", literal])
  assert.equal(result.code, 0)
  assert.equal(result.stdout, literal)
})

test("streamed Codex output does not impose an accidental output budget", async () => {
  let bytes = 0
  const result = await runProcess([process.execPath, "-e", "process.stdout.write('x'.repeat(2000000))"], {
    captureOutput: false, onOutput: chunk => { bytes += chunk.length }
  })
  assert.equal(result.code, 0)
  assert.equal(bytes, 2_000_000)
  assert.equal(result.stdout, "")
})

test("hard timeout kills grandchildren that hold inherited pipes open", async () => {
  const code = "require('child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'inherit'});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"
  const start = Date.now()
  const result = await runProcess([process.execPath, "-e", code], { timeoutMs: 300 })
  assert.equal(result.code, 142)
  assert.ok(Date.now() - start < 3000)
})

test("existing attended build caller still reads its schema result", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-build-process-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const codex = path.join(root, "codex")
  await fs.writeFile(codex, `#!/usr/bin/env node
const fs=require('node:fs'), args=process.argv.slice(2);
process.stdin.resume();process.stdin.on('end',()=>{
fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({status:'pass'}));
});`, { mode: 0o755 })
  const excerpt = "Fixture contract"
  const pinnedBuildContext = createPinnedBuildContext([{ source_revision: "a".repeat(40),
    path: "src/fixture.mjs", excerpt,
    content_digest: `sha256:${createHash("sha256").update(excerpt).digest("hex")}` }])
  const result = await runCodexBuild({ route: { provider: "codex", model: "fixture", effort: "high" },
    outcome: "Fixture build", sourceRevision: "a".repeat(40), pinnedBuildContext }, { cwd: root, codex })
  assert.equal(result.status, "pass")
})

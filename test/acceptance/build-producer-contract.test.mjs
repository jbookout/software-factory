import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { createFactory, createFixtureAdapter } from "../../src/index.mjs"
import { runCodexBuild } from "../../src/codex-build.mjs"
import { createPinnedBuildContext } from "../../src/model-room.mjs"

test("review 1: actual Codex producer schema and prompt supply loop build identity", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-producer-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const candidateRevision = "b".repeat(40), buildDigest = "c".repeat(64)
  const output = { status: "pass", evidence: [], findings: [], proposals: [],
    measurements: { testsRun: 1, testsPassed: 1, durationMs: 1 },
    data: { sourceChanged: true, checksComplete: true, candidateRevision, buildDigest } }
  const ajvUrl = new URL("../../node_modules/ajv/dist/2020.js", import.meta.url).href
  const executable = path.join(root, "fake-codex.mjs")
  await fs.writeFile(executable, `#!${process.execPath}
import fs from "node:fs";
import Ajv2020 from ${JSON.stringify(ajvUrl)};
const args = process.argv.slice(2);
const output = ${JSON.stringify(output)};
const schema = JSON.parse(fs.readFileSync(args[args.indexOf("--output-schema") + 1]));
const validate = new Ajv2020({ strict: true }).compile(schema);
if (!validate(output)) throw Error(JSON.stringify(validate.errors));
const prompt = fs.readFileSync(0, "utf8");
if (!prompt.includes("candidateRevision") || !prompt.includes("buildDigest")) throw Error("missing identity instructions");
fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify(output));
`)
  await fs.chmod(executable, 0o700)
  const excerpt = "Synthetic pinned build contract."
  const pinnedBuildContext = createPinnedBuildContext([{ source_revision: "a".repeat(40), path: "contract.txt",
    excerpt, content_digest: `sha256:${createHash("sha256").update(excerpt).digest("hex")}` }])
  const route = { provider: "codex", model: "synthetic", effort: "high" }
  const pass = { status: "pass" }
  const adapter = createFixtureAdapter({
    "environment:prepare": { status: "pass", data: { isolated: true, environmentId: "producer-tree" } },
    "environment:dispose": pass, "context:collect": pass,
    build: request => runCodexBuild(request, { cwd: root, codex: executable, timeoutMs: 10000 }),
    verify: pass, "risk:inspect": pass, "review:Test Engineer": pass
  })
  const result = await createFactory({ modelRoomAdvisor: async () => ({ schema: "doctorcre-build-route.v1",
    selected_route: route, build_context: pinnedBuildContext }) }).run({ product: "DoctorCRE",
    outcome: "synthetic build", sourceRevision: "a".repeat(40) }, adapter)
  assert.equal(result.outcome, "complete", JSON.stringify(result.findings))
  assert.deepEqual(result.candidate, { revision: candidateRevision, buildDigest })
})

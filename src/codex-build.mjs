import { createHash } from "node:crypto"
import { runProcess } from "./process-runner.mjs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { verifyPinnedBuildContext } from "./model-room.mjs"

const TOKEN = /^[A-Za-z0-9_.-]{1,80}$/
const SCHEMA = fileURLToPath(new URL("../schemas/factory-build-result.schema.json", import.meta.url))

export function createCodexBuildPrompt(request) {
  if (!request || request.route?.provider !== "codex" ||
      !TOKEN.test(request.route.model ?? "") || !TOKEN.test(request.route.effort ?? "") ||
      typeof request.outcome !== "string" || !request.outcome.trim() ||
      typeof request.sourceRevision !== "string" || !/^[0-9a-f]{40}$/.test(request.sourceRevision) ||
      !verifyPinnedBuildContext(request.pinnedBuildContext))
    throw new Error("invalid Codex build request")
  const contracts = request.pinnedBuildContext.contracts.map(contract =>
    `SOURCE ${contract.source_revision}:${contract.path} (${contract.content_digest})\n${contract.excerpt}`)
  return [
    "Implement the attended DoctorCRE build task in the current repository.",
    `TASK: ${request.outcome}`,
    `SOURCE REVISION: ${request.sourceRevision}`,
    "Use the exact pinned contracts below as required context. Inspect the repository, make the bounded source change, and run relevant checks. Do not deploy or publish.",
    ...contracts,
    "On success, commit the bounded source change and return its full Git SHA as data.candidateRevision. Return data.buildDigest as the SHA-256 hex digest of the exact built artifact (or deterministic build manifest including source/configuration/fixture digests). These identify the completed build, not the source baseline. If no completed build exists, return null for both and status fail. Never invent an identity.",
    "Return only the required JSON result. status is pass only when the requested source work and checks completed; otherwise use fail and explain findings without secrets.",
  ].join("\n\n")
}

export function createCodexExecArgs(route) {
  if (!TOKEN.test(route?.model ?? "") || !TOKEN.test(route?.effort ?? ""))
    throw new Error("invalid Codex model or effort")
  return ["exec", "--ephemeral", "-m", route.model,
    "-c", `model_reasoning_effort=${JSON.stringify(route.effort)}`]
}

export function createCodexBuildArgs(request, output) {
  return [...createCodexExecArgs(request.route),
    "--approve-for-me", "--output-schema", SCHEMA,
    "--output-last-message", output, "-"]
}

export async function runCodexBuild(request, { cwd = process.cwd(), codex = "codex",
  timeoutMs = 3_600_000 } = {}) {
  const prompt = createCodexBuildPrompt(request)
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "factory-codex-build-"))
  const output = path.join(temp, "result.json")
  const args = createCodexBuildArgs(request, output)
  try {
    let stderr = ""
    const result = await runProcess([codex, ...args], { cwd, input: prompt, timeoutMs,
      captureOutput: false, onOutput(chunk, stream) {
        if (stream === "stderr" && stderr.length < 100_000) stderr += chunk
      } })
    if (result.code !== 0)
      throw new Error(`Codex build failed (${result.code}): ${createHash("sha256").update(stderr).digest("hex")}`)
    return JSON.parse(await fs.readFile(output, "utf8"))
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
}

import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
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
    "Return only the required JSON result. status is pass only when the requested source work and checks completed; otherwise use fail and explain findings without secrets.",
  ].join("\n\n")
}

export async function runCodexBuild(request, { cwd = process.cwd(), codex = "codex",
  timeoutMs = 3_600_000 } = {}) {
  const prompt = createCodexBuildPrompt(request)
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "factory-codex-build-"))
  const output = path.join(temp, "result.json")
  const args = ["exec", "--ephemeral", "-m", request.route.model,
    "-c", `model_reasoning_effort=${JSON.stringify(request.route.effort)}`,
    "-s", "workspace-write", "--approve-for-me", "--output-schema", SCHEMA,
    "--output-last-message", output, "-"]
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(codex, args, { cwd, env: process.env, shell: false,
        stdio: ["pipe", "ignore", "pipe"] })
      let stderr = ""
      const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs)
      child.stderr.on("data", chunk => { if (stderr.length < 100_000) stderr += chunk })
      child.on("error", reject)
      child.on("close", code => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(`Codex build failed (${code}): ${createHash("sha256").update(stderr).digest("hex")}`))
      })
      child.stdin.end(prompt)
    })
    return JSON.parse(await fs.readFile(output, "utf8"))
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
}

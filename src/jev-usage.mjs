// Factory callers use CARR's admission, reservations, cache and receipts.
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { join } from "node:path"
import { homedir } from "node:os"

const execute = promisify(execFile)

export async function carrAsk(input, { root = process.env.CARR_REPO_ROOT || join(homedir(), "carr-system"),
  sourceSha = process.env.CARR_JEV_SOURCE_SHA,
  python = process.env.CARR_PYTHON || join(root, ".venv", "bin", "python") } = {}) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha || "")) throw new Error("CARR Jev source revision required")
  const { stdout: head } = await execute("git", ["rev-parse", "HEAD"], { cwd: root })
  if (head.trim() !== sourceSha) throw new Error("CARR Jev source revision mismatch")
  const { stdout: diff } = await execute("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root })
  if (diff.trim()) throw new Error("CARR Jev source is modified")
  return new Promise((resolve, reject) => {
    const child = spawn(python, ["-c",
      "import sys; sys.path.insert(0, sys.argv[1]); import typesafe_client; raise SystemExit(typesafe_client._command())",
      join(root, "ops")], {
      cwd: root, stdio: ["pipe", "pipe", "ignore"], timeout: 20_000,
    })
    let output = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", chunk => { output += chunk })
    child.on("error", () => reject(new Error("CARR Jev client unavailable")))
    child.on("close", code => {
      let response
      try { response = JSON.parse(output) } catch { return reject(new Error("CARR Jev response invalid")) }
      if (response?.schema !== "carr-jev-admission/v1") return reject(new Error("CARR Jev contract mismatch"))
      if (code !== 0 || response.ok !== true)
        return reject(new Error(`CARR Jev refused: ${/^[a-z_]+$/.test(response.error || "") ? response.error : "unavailable"}`))
      resolve(response.result)
    })
    child.stdin.on("error", () => {})
    child.stdin.end(JSON.stringify(input))
  })
}

export async function askJev({ state, model, questions, apiKey, caller, sharedAsk = carrAsk }) {
  if (!caller || !questions || !Object.keys(questions).length)
    throw new Error("Jev call needs caller and questions")
  return sharedAsk({ state, model, questions, caller: `adhoc:factory:${caller}`,
    session_id: process.env.CODEX_THREAD_ID || process.env.CLAUDE_CODE_SESSION_ID || null,
    ...(apiKey ? { api_key: apiKey } : {}) })
}

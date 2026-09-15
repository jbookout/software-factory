import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import path from "node:path"

const VALID_STATUS = new Set(["pass", "fail", "finding", "skip"])

function normalizeResult(result, step) {
  const value = result ?? { status: "skip" }
  if (!VALID_STATUS.has(value.status)) throw new Error(`${step} returned invalid status`)
  return {
    status: value.status,
    evidence: Array.isArray(value.evidence) ? value.evidence : [],
    findings: Array.isArray(value.findings) ? value.findings : [],
    measurements: value.measurements ?? {},
    proposals: Array.isArray(value.proposals) ? value.proposals : [],
    data: value.data ?? {}
  }
}

export function createFixtureAdapter(steps = {}) {
  const calls = []
  return {
    calls,
    async execute(step, request) {
      calls.push({ step, request })
      const handler = steps[step]
      const result = typeof handler === "function" ? await handler(request) : handler
      return normalizeResult(result, step)
    }
  }
}

export function createScriptAdapter({ root, commands, timeoutMs = 120_000, maxOutputBytes = 1_000_000, environment = {} }) {
  const resolvedRoot = path.resolve(root)
  if (!commands || typeof commands !== "object") throw new Error("commands are required")

  return {
    async execute(step, request) {
      const argv = commands[step]
      if (!argv) return normalizeResult({ status: "skip" }, step)
      if (!Array.isArray(argv) || argv.length === 0 || argv.some((part) => typeof part !== "string")) {
        throw new Error(`${step} must be an argv array`)
      }
      if (step === "deploy" || step === "rollback") {
        throw new Error("the factory cannot execute product deployment authority")
      }

      const result = await new Promise((resolve, reject) => {
        const child = spawn(argv[0], argv.slice(1), {
          cwd: resolvedRoot,
          env: { PATH: process.env.PATH, ...environment },
          shell: false,
          stdio: ["pipe", "pipe", "pipe"]
        })
        let stdout = ""
        let stderr = ""
        let outputBytes = 0
        let forcedTimer
        const timer = setTimeout(() => {
          child.kill("SIGTERM")
          forcedTimer = setTimeout(() => child.kill("SIGKILL"), 1_000)
        }, timeoutMs)
        function collect(current, chunk) {
          outputBytes += chunk.length
          if (outputBytes > maxOutputBytes) {
            child.kill("SIGTERM")
            return current
          }
          return current + chunk
        }
        child.stdout.on("data", (chunk) => { stdout = collect(stdout, chunk) })
        child.stderr.on("data", (chunk) => { stderr = collect(stderr, chunk) })
        child.on("error", reject)
        child.on("close", (code, signal) => {
          clearTimeout(timer)
          clearTimeout(forcedTimer)
          if (outputBytes > maxOutputBytes) return reject(new Error(`${step} exceeded output limit`))
          if (signal) return reject(new Error(`${step} terminated by ${signal}`))
          if (code !== 0) {
            const stderrDigest = createHash("sha256").update(stderr).digest("hex")
            return resolve({ status: "fail", findings: [{ code, stderrDigest, stderrBytes: Buffer.byteLength(stderr) }] })
          }
          try {
            resolve(stdout.trim() ? JSON.parse(stdout) : { status: "pass" })
          } catch {
            reject(new Error(`${step} did not emit JSON`))
          }
        })
        child.stdin.end(JSON.stringify(request))
      })
      return normalizeResult(result, step)
    }
  }
}

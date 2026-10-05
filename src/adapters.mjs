import { runProcess } from "./process-runner.mjs"
import { createHash } from "node:crypto"
import path from "node:path"

const VALID_STATUS = new Set(["pass", "fail", "finding", "skip"])

export function normalizeResult(result, step) {
  const value = result ?? { status: "skip" }
  if (!VALID_STATUS.has(value.status)) throw new Error(`${step} returned invalid status`)
  return {
    status: value.status,
    evidence: list(value.evidence, step, "evidence"),
    findings: list(value.findings, step, "findings"),
    measurements: value.measurements ?? {},
    proposals: list(value.proposals, step, "proposals"),
    data: value.data ?? {}
  }
}

// A malformed list is a broken claim, not an empty one.
function list(value, step, field) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${step} returned invalid ${field}`)
  return value
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
    async execute(step, request, { signal } = {}) {
      let argv = commands[step]
      if (step === "build" && argv && !Array.isArray(argv) && request.route) {
        const route = request.route
        const key = `${route.provider}/${route.model}/${route.effort}`
        argv = argv[key]
      }
      if (!argv) return normalizeResult({ status: "skip" }, step)
      if (!Array.isArray(argv) || argv.length === 0 || argv.some((part) => typeof part !== "string")) {
        throw new Error(`${step} must be an argv array`)
      }
      if (step === "deploy" || step === "rollback") {
        throw new Error("the factory cannot execute product deployment authority")
      }

      const result = await runProcess(argv, {
        cwd: resolvedRoot,
        env: { PATH: process.env.PATH, ...environment },
        input: JSON.stringify(request), timeoutMs, maxOutputBytes, signal, mutation: true
      })
      if (result.launchCode) throw Object.assign(new Error(`spawn ${argv[0]} ${result.launchCode}`), {
        code: result.launchCode, syscall: `spawn ${argv[0]}`, path: argv[0], spawnargs: argv.slice(1)
      })
      const interruption = result.overflow ? `${step} exceeded output limit`
        : result.signal ? `${step} terminated by ${result.signal}`
        : result.timedOut ? `${step} terminated by SIGTERM`
        : result.cancelled ? `${step} terminated by SIGTERM` : null
      if (interruption) {
        const error = new Error(interruption)
        if (result.cancelled) error.cancelled = true
        if (result.uncertain) { error.uncertain = true; error.nextAction = result.nextAction }
        throw error
      }
      if (result.code !== 0) {
        const stderrDigest = createHash("sha256").update(result.stderr).digest("hex")
        return normalizeResult({ status: "fail", findings: [{ code: result.code,
          stderrDigest, stderrBytes: Buffer.byteLength(result.stderr) }] }, step)
      }
      // Exit code zero is not a result; the step must say what it observed.
      if (!result.stdout.trim()) throw new Error(`${step} emitted no result`)
      let value
      try { value = JSON.parse(result.stdout) }
      catch { throw new Error(`${step} did not emit JSON`) }
      return normalizeResult(value, step)
    }
  }
}

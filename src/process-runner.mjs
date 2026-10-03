import { spawn, fork } from "node:child_process"
import { StringDecoder } from "node:string_decoder"

// Shared shell-free process seam for build and PR jobs. A timeout is a result,
// even if a child ignores TERM; kill the whole job group before returning.
export function runProcess(argv, { cwd, env = process.env, input = "", timeoutMs = 120_000,
  maxOutputBytes = 1_000_000, captureOutput = true, onOutput, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32"
    const deadline = Date.now() + timeoutMs
    const child = onSpawn
      ? fork(new URL("./process-supervisor.mjs", import.meta.url), [], { stdio: ["pipe", "pipe", "pipe", "ipc"], execArgv: [] })
      : spawn(argv[0], argv.slice(1), { cwd, env, shell: false, detached: grouped, stdio: ["pipe", "pipe", "pipe"] })
    let supervisedResult
    let stdout = "", stderr = "", bytes = 0, timedOut = false, overflow = false
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") }
    let killTimer
    const kill = signal => {
      try { grouped && !onSpawn ? process.kill(-child.pid, signal) : child.kill(signal) }
      catch (error) { if (error.code !== "ESRCH") throw error }
    }
    const stop = () => {
      kill("SIGTERM")
      killTimer ??= setTimeout(() => kill("SIGKILL"), 100)
    }
    const timer = onSpawn ? undefined : setTimeout(() => { timedOut = true; stop() }, timeoutMs)
    const collect = (stream, chunk) => {
      bytes += chunk.length
      onOutput?.(chunk, stream)
      if (!captureOutput) return
      if (bytes > maxOutputBytes) { overflow = true; stop(); return }
      if (stream === "stdout") stdout += decoders.stdout.write(chunk)
      else stderr += decoders.stderr.write(chunk)
    }
    child.stdout.on("data", chunk => collect("stdout", chunk))
    child.stderr.on("data", chunk => collect("stderr", chunk))
    child.stdin.on("error", error => { if (error.code !== "EPIPE") reject(error) })
    child.on("error", error => { clearTimeout(timer); clearTimeout(killTimer); reject(error) })
    child.on("close", (code, signal) => {
      if (supervisedResult) { code = supervisedResult.code; signal = supervisedResult.signal; timedOut = supervisedResult.timedOut }
      clearTimeout(timer)
      // A parent can exit on TERM while grandchildren keep running. Still kill
      // the process group after timeout rather than cancelling its hard stop.
      if (timedOut || overflow) kill("SIGKILL")
      clearTimeout(killTimer)
      stdout += decoders.stdout.end(); stderr += decoders.stderr.end()
      resolve({ code: timedOut ? 142 : overflow ? 1 : code ?? 1, signal, stdout, stderr, timedOut, overflow, pid: child.pid })
    })
    if (onSpawn) {
      child.on("message", result => { supervisedResult = result })
      Promise.resolve().then(() => onSpawn({ pid: child.pid, deadline })).then(bindings => {
        if (child.connected) child.send({ argv, cwd, env, input, deadline, bindings })
      }).catch(error => { child.disconnect(); reject(error) })
    } else child.stdin.end(input)
  })
}

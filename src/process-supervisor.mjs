import { spawn } from "node:child_process"
import { readJson, writeJson } from "./pr-delivery-state.mjs"

// This process owns the deadline and child group independently of the caller.
// No job starts until the caller has persisted the supervisor's slot binding.
let child, timer, hardStop, timedOut = false, stopping = false
const kill = signal => {
  if (!child) return
  try { process.platform === "win32" ? child.kill(signal) : process.kill(-child.pid, signal) }
  catch (error) { if (error.code !== "ESRCH") throw error }
}
const stop = () => {
  stopping = true
  if (!child) process.exit(1)
  kill("SIGTERM")
  hardStop ??= setTimeout(() => kill("SIGKILL"), 100)
}
process.on("disconnect", stop)
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
process.once("message", ({ argv, cwd, env, input, deadline, bindings = [] }) => {
  child = spawn(argv[0], argv.slice(1), { cwd, env, shell: false,
    detached: process.platform !== "win32", stdio: ["pipe", "inherit", "inherit"] })
  timer = setTimeout(() => { timedOut = true; stop() }, Math.max(0, deadline - Date.now()))
  child.stdin.on("error", error => { if (error.code !== "EPIPE") stop() })
  const persisted = Promise.all(bindings.map(async ({ file, token }) => {
    const owner = await readJson(file, null)
    if (!owner || owner.token !== token || owner.job.pid !== process.pid) throw new Error("job lease binding changed")
    await writeJson(file, { ...owner, job: { ...owner.job, groupPid: child.pid } })
  }))
  let finished = false
  const finish = async (code, signal, error) => {
    if (finished) return
    finished = true
    kill("SIGKILL")
    await persisted.catch(() => {})
    clearTimeout(timer); clearTimeout(hardStop)
    if (process.connected) process.send({ code: timedOut ? 142 : stopping ? 1 : code ?? 1, signal, timedOut, error }, () => process.exit(0))
    else process.exit(0)
  }
  child.on("error", error => finish(1, null, error.message))
  child.on("close", (code, signal) => finish(code, signal))
  persisted.then(() => child.stdin.end(input)).catch(stop)
})

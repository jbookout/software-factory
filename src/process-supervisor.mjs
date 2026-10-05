import { killOwnedGroup } from "./process-group.mjs"
import { monotonicNow } from "./deadline.mjs"
import { spawn, fork } from "node:child_process"
import { readJson, writeJson } from "./pr-delivery-state.mjs"

// This process owns the deadline and child group independently of the caller.
// No job starts until the caller has persisted the supervisor's slot binding.
let child, timer, hardStop, timedOut = false, stopping = false
const kill = signal => {
  if (!child?.pid) return
  try { killOwnedGroup(child.pid, signal) }
  catch (error) { if (error.code !== "ESRCH") throw error }
}
const stop = () => {
  stopping = true
  if (!child) process.exit(1)
  kill("SIGTERM")
  hardStop ??= setTimeout(() => kill("SIGKILL"), 50)
}
process.on("disconnect", stop)
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
process.once("message", ({ argv, cwd, env, input, elapsedDeadline, grace = 100, bindings = [] }) => {
  const latched = bindings.length > 0
  child = latched
    ? fork(new URL("./process-launcher.mjs", import.meta.url), [], { cwd, env, execArgv: [],
      detached: process.platform !== "win32", stdio: ["pipe", "inherit", "inherit", "ipc"] })
    : spawn(argv[0], argv.slice(1), { cwd, env, shell: false,
      detached: process.platform !== "win32", stdio: ["pipe", "inherit", "inherit"] })
  if (process.connected) process.send({ groupPid: child.pid })
  timer = setTimeout(() => { timedOut = true; stop() }, Math.max(0, elapsedDeadline - monotonicNow() - grace))
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
    let persistenceTimer
    try {
      await Promise.race([persisted.catch(() => {}), new Promise(resolve => {
        persistenceTimer = setTimeout(resolve, Math.max(0, elapsedDeadline - monotonicNow()))
      })])
    } finally { clearTimeout(persistenceTimer) }
    clearTimeout(timer); clearTimeout(hardStop)
    if (process.connected) process.send({ code: timedOut ? 142 : stopping ? 1 : code ?? 1, signal, timedOut, error }, () => process.exit(0))
    else process.exit(0)
  }
  child.on("error", error => finish(1, null, "process child launch failed"))
  child.on("close", (code, signal) => finish(code, signal))
  persisted.then(() => {
    if (stopping) return
    if (latched) child.send({ argv, input }, error => { if (error) stop() })
    else child.stdin.end(input)
  }).catch(stop)
})

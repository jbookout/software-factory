import { killOwnedGroup } from "./process-group.mjs"
import { monotonicNow } from "./deadline.mjs"
import { spawn, fork } from "node:child_process"
import { readJson, writeJson } from "./pr-delivery-state.mjs"

// This process owns the deadline and child group independently of the caller.
// No job starts until the caller has persisted the supervisor's slot binding.
let child, timer, hardStop, timedOut = false, stopping = false, interrupted = false
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
process.on("disconnect", () => { interrupted = true; stop() })
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
process.once("message", ({ argv, cwd, env, input, elapsedDeadline, deadline, job, grace = 100, bindings = [] }) => {
  let receipt = job ? {schema:"factory-process-job/v1", ...job, pid:process.pid, deadline, status:"starting"} : null
  let startup = Promise.resolve(), launchCode
  const acknowledge = () => {
    startup = startup.then(async () => {
      if (stopping) return
      if (receipt) {
        const {access} = await import('node:fs/promises')
        await access(receipt.log)
        receipt = {...receipt, groupPid:child.pid, status:"running", startedAt:new Date().toISOString()}
        await writeJson(job.receipt,receipt)
      }
      if (process.connected) process.send({type:"started",receipt})
    }).catch(stop)
  }
  const latched = bindings.length > 0
  child = latched
    ? fork(new URL("./process-launcher.mjs", import.meta.url), [], { cwd, env, execArgv: [],
      detached: process.platform !== "win32", stdio: ["pipe", "inherit", "inherit", "ipc"] })
    : spawn(argv[0], argv.slice(1), { cwd, env, shell: false,
      detached: process.platform !== "win32", stdio: ["pipe", "inherit", "inherit"] })
  if (process.connected) process.send({ groupPid: child.pid })
  if (latched) child.on("message", message => {
    if (message.type === "started") acknowledge()
    else if (message.type === "launch-error") launchCode = message.code
  })
  else child.once("spawn", acknowledge)
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
    await startup
    if (receipt) {
      receipt = {...receipt, groupPid:child.pid, status:interrupted ? "interrupted" : timedOut ? "timed_out" : stopping || code !== 0 || signal || error ? "failed" : "complete",
        code:timedOut ? 142 : interrupted ? 130 : stopping ? 1 : code ?? 1, signal, endedAt:new Date().toISOString()}
      await writeJson(job.receipt,receipt)
    }
    clearTimeout(timer); clearTimeout(hardStop)
    if (process.connected) process.send({ code: timedOut ? 142 : stopping ? 1 : code ?? 1, signal, timedOut, error, ...(launchCode ? { launchCode } : {}) }, () => process.exit(0))
    else process.exit(0)
  }
  child.on("error", error => { launchCode = error.code; return finish(1, null, "process child launch failed") })
  child.on("close", (code, signal) => finish(code, signal))
  persisted.then(() => {
    if (stopping) return
    if (latched) child.send({ argv, input }, error => { if (error) stop() })
    else child.stdin.end(input)
  }).catch(stop)
})

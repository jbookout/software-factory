#!/usr/bin/env node
import { loadDeliveryConfig, createPrDeliveryAdapter } from "../src/pr-delivery.mjs"
import { runPrDelivery } from "../src/operating-loop.mjs"
import { queryBackoffMs } from "../src/github-observation.mjs"
import { pause } from "../src/pr-delivery-state.mjs"

const [configPath, action, ...args] = process.argv.slice(2)
try {
  if (!configPath || !action) throw new Error("usage: node bin/pr-delivery.mjs <config.json> <action> [args]")
  const adapter = createPrDeliveryAdapter(await loadDeliveryConfig(configPath))
  const [repo, number, extra, fourth] = args
  const once = args.includes("--once"), pr = Number(number)
  // `deliver <repo>` is the repository's serial lane; `deliver <repo> <pr>` delivers one PR.
  const lane = action === "deliver" && (!number || number === "--once")
  const daemons = ["merge-queue", "auto-enqueue", "recover", "shadow"]
  if (!daemons.includes(action) && !lane && !["branch-wt", "import-legacy", "github-read", "github-logs"].includes(action) && (!Number.isSafeInteger(pr) || pr <= 0)) throw new Error("PR number must be a positive integer")
  if ((lane || action === "shadow") && !/^[^-]/.test(repo ?? "")) throw new Error(`${action} needs a configured repository`)
  const request = { repo, pr }
  const report = result => {
    const data = result.data ?? result
    if (result.status === "fail") process.stderr.write(`${data.message}\n`)
    process.stdout.write(`${data.message ?? data.worktree ?? JSON.stringify(data)}\n`)
    const code = data.code ?? (result.status === "fail" ? 1 : 0)
    if (code && !process.exitCode) process.exitCode = code
  }
  if (action === "deliver" && !lane) report(await adapter.exclusive(repo, pr, async () => {
    const delivered = await runPrDelivery({ ...request, worktree: extra, rounds: Number(fourth ?? 3) }, adapter)
    if (delivered.code) return delivered
    const queued = await adapter.execute("enqueue-event", request)
    if (queued.status !== "pass") return queued
    return { ...delivered, message: `${delivered.message}; ${queued.data.message ?? "not queued"}` }
  }))
  else if (action === "recover") {
    do {
      for (const candidate of await adapter.recoveryCandidates()) {
        try { report(await adapter.exclusive(candidate.repo, candidate.pr, async () => {
          if (candidate.repairId) {
            const result = await adapter.execute("fix",candidate)
            if (result.status !== "pass") return result
          }
          return runPrDelivery({repo:candidate.repo,pr:candidate.pr},adapter)
        })) }
        catch (e) {
          if (e.code !== 75) throw e
          report({ status: "fail", data: { code: e.code, message: e.message } })
        }
      }
      if (once) break
      process.exitCode = 0
      await pause(adapter.config.autoPollMs)
    } while (true)
  }
  else if (daemons.includes(action) || lane) {
    const steps = lane ? ["auto-enqueue", "merge-queue"] : [action]
    const interval = action === "auto-enqueue" ? Math.max(300_000, adapter.config.autoPollMs)
      : action === "shadow" ? Math.max(600_000, adapter.config.autoPollMs) : adapter.config.pollMs
    do {
      let wait = interval, stop = false
      for (const step of steps) {
        const result = await adapter.execute(step, { repo: repo !== "--once" ? repo : undefined })
        report(result)
        stop ||= result.status === "fail" && !result.data.transient
        // A lane's scan deadline never delays its merges.
        if (result.data.retryAt && (steps.length === 1 || result.status === "fail")) wait = Math.max(wait, result.data.retryAt - Date.now())
        else if (result.status === "fail" && result.data.state) wait = Math.max(wait, queryBackoffMs(result.data.queryErrors ?? 1))
      }
      if (once || stop) break
      process.exitCode = 0
      await pause(wait)
    } while (true)
  } else if (["review-pr", "fix-pr", "ci-fix"].includes(action)) {
    await adapter.exclusive(repo, pr, async () => {
      const result = await adapter.execute(action === "review-pr" ? "review" : action === "fix-pr" ? "fix" : "ci-fix", { ...request, worktree: extra })
      report(result)
      if (action === "ci-fix" && result.status === "pass" && !args.includes("--no-loop"))
        report(await runPrDelivery({ ...request }, adapter))
    })
  } else if (action === "import-legacy") report(await adapter.execute(action, { root: repo }))
  else if (action === "branch-wt") report(await adapter.execute(action, { repo, branch: number, fallback: extra }))
  else if (action === "codex-guard") report(await adapter.exclusive(repo, pr, () => adapter.execute(action, { ...request, kind: extra, argv: args.slice(3) })))
  else if (action === "github-logs") {
    if (!/^[1-9][0-9]*$/.test(number)) throw new Error("GitHub logs needs a job id")
    report(await adapter.execute(action, {repo,job:number}))
  }
  else if (action === "github-read") {
    if (!number || !/^[A-Za-z0-9_./?=&%-]+$/.test(number) || number.startsWith("/") || number.includes("..")) throw new Error("GitHub read needs a repository-relative REST route")
    report(await adapter.execute(action, { repo, route: number }))
  }
  else if (action === "enqueue-event") report(await adapter.execute(action, { ...request, head: extra }))
  else if (["readiness", "repair-status", "snapshot"].includes(action)) report(await adapter.execute(action, { ...request, head: extra }))
  else if (["merge-enqueue", "merge-one-core"].includes(action))
    report(await adapter.execute(action === "merge-enqueue" ? "enqueue" : action, { ...request, head: extra, note: fourth }))
  else throw new Error(`unknown delivery action: ${action}`)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  if (!process.exitCode) process.exitCode = Number.isInteger(error.code) ? error.code : 1
}

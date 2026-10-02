#!/usr/bin/env node
import { loadDeliveryConfig, createPrDeliveryAdapter } from "../src/pr-delivery.mjs"
import { runPrDelivery } from "../src/operating-loop.mjs"
import { pause } from "../src/pr-delivery-state.mjs"

const [configPath, action, ...args] = process.argv.slice(2)
try {
  if (!configPath || !action) throw new Error("usage: node bin/pr-delivery.mjs <config.json> <action> [args]")
  const adapter = createPrDeliveryAdapter(await loadDeliveryConfig(configPath))
  const [repo, number, extra, fourth] = args
  const once = args.includes("--once"), pr = Number(number)
  const daemons = ["merge-queue", "auto-enqueue"]
  if (!daemons.includes(action) && !["branch-wt", "import-legacy"].includes(action) && (!Number.isSafeInteger(pr) || pr <= 0)) throw new Error("PR number must be a positive integer")
  const request = { repo, pr }
  const loop = () => runPrDelivery({ ...request, worktree: extra, rounds: Number(fourth ?? 3) }, adapter)
  const report = result => {
    const data = result.data ?? result
    if (result.status === "fail") process.stderr.write(`${data.message}\n`)
    process.stdout.write(`${data.message ?? data.worktree ?? JSON.stringify(data)}\n`)
    process.exitCode = data.code ?? (result.status === "fail" ? 1 : 0)
  }
  if (action === "pr-loop") report(await adapter.exclusive(repo, pr, loop))
  else if (daemons.includes(action)) {
    do {
      const result = await adapter.execute(action)
      report(result)
      if (once || (result.status === "fail" && !result.data.transient)) break
      process.exitCode = 0
      await pause(action === "auto-enqueue" ? adapter.config.autoPollMs : adapter.config.pollMs)
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
  else if (action === "codex-guard") report(await adapter.execute(action, { ...request, kind: extra, argv: args.slice(3) }))
  else if (["merge-enqueue", "merge-one-core"].includes(action))
    report(await adapter.execute(action === "merge-enqueue" ? "enqueue" : action, { ...request, head: extra, note: fourth }))
  else throw new Error(`unknown delivery action: ${action}`)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = Number.isInteger(error.code) ? error.code : 1
}

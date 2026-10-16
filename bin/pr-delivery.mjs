#!/usr/bin/env node
import { loadDeliveryConfig, createPrDeliveryAdapter } from "../src/pr-delivery.mjs";
import { runPrDelivery } from "../src/operating-loop.mjs";
import { pause, withLease } from "../src/pr-delivery-state.mjs";
import path from "node:path";

const [file, action, ...args] = process.argv.slice(2);
try {
  if (!file || !action)
    throw new Error("usage: pr-delivery.mjs <config.json> <action> [repo] [pr] [args]");
  const config = await loadDeliveryConfig(file),
    adapter = createPrDeliveryAdapter(config);
  const [repo, number, extra, fourth] = args,
    pr = Number(number);
  const report = (result) => {
    const data = result.data ?? result;
    if (result.status === "fail") console.error(data.message);
    console.log(JSON.stringify(data));
    const code = data.code ?? (result.status === "fail" ? 1 : 0);
    if (code) process.exitCode = code;
    return !code;
  };
  const deliver = async (candidate) =>
    adapter.exclusive(candidate.repo, candidate.pr, async () => {
      if (candidate.repairId) {
        const repair = await adapter.execute("fix", candidate);
        if (repair.status !== "pass") return report(repair);
      }
      const delivered = await runPrDelivery(candidate, adapter);
      if (!report(delivered)) return false;
      if (delivered.merged) return true;
      return report(await adapter.execute("enqueue-event", candidate));
    });
  if (["deliver", "recover"].includes(action) && (!number || number.startsWith("--"))) {
    await withLease(path.join(config.stateDir, "locks"), "serial-delivery", async () => {
      do {
        for (const candidate of await adapter.recoveryCandidates()) await deliver(candidate);
        if (action === "deliver")
          for (const target of repo && !repo.startsWith("--")
            ? [repo]
            : Object.keys(config.repos)) {
            const scan = await adapter.execute("delivery-scan", { repo: target });
            if (scan.status === "pass")
              for (const candidate of scan.data.candidates) await deliver(candidate);
            else report(scan);
          }
        report(
          await adapter.execute("merge-queue", {
            repo: repo && !repo.startsWith("--") ? repo : undefined,
          }),
        );
        if (args.includes("--once")) break;
        process.exitCode = 0;
        await pause(config.pollMs);
      } while (true);
    });
  } else if (action === "deliver") {
    await deliver({ repo, pr, rounds: Number(fourth ?? 3), worktree: extra });
  } else if (action === "merge-queue" || action === "queue-status")
    report(await adapter.execute(action, { repo: repo?.startsWith("--") ? undefined : repo }));
  else if (action === "branch-wt")
    report(await adapter.execute(action, { repo, branch: number, fallback: extra }));
  else if (action === "github-read") report(await adapter.execute(action, { repo, route: number }));
  else if (action === "github-logs") report(await adapter.execute(action, { repo, job: number }));
  else {
    if (!Number.isSafeInteger(pr) || pr < 1) throw new Error("positive PR number required");
    const request = { repo, pr, head: extra };
    if (action === "codex-guard")
      report(
        await adapter.exclusive(repo, pr, () =>
          adapter.execute(action, { repo, pr, kind: extra, argv: args.slice(3) }),
        ),
      );
    else if (["fix-pr", "ci-fix"].includes(action))
      report(
        await adapter.exclusive(repo, pr, () =>
          adapter.execute(action === "fix-pr" ? "fix" : action, { repo, pr, worktree: extra }),
        ),
      );
    else if (
      [
        "readiness",
        "repair-status",
        "snapshot",
        "queue-cancel",
        "enqueue-event",
        "ci-retrigger",
      ].includes(action)
    )
      report(await adapter.execute(action, request));
    else if (["merge-enqueue", "merge-one-core"].includes(action))
      report(
        await adapter.execute(action === "merge-enqueue" ? "enqueue" : action, {
          ...request,
          note: fourth,
        }),
      );
    else throw new Error(`unknown delivery action: ${action}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = Number.isInteger(error.code) ? error.code : 1;
}

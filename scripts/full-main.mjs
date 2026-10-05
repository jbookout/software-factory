import { execFileSync } from "node:child_process";
import { runFullMain } from "../src/nightly-backstop.mjs";
import { writeJson } from "../src/pr-delivery-state.mjs";
const git = (...args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    timeout: 10000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
try {
  const output = process.argv[2];
  if (!output) throw Error();
  const sha = git("rev-parse", "HEAD"),
    tree = git("rev-parse", "HEAD^{tree}");
  if (git("status", "--porcelain", "--untracked-files=all")) throw Error();
  const receipt = await runFullMain({
    cwd: process.cwd(),
    repository: "jbookout/software-factory",
    suite: "factory",
    source: { sha, tree },
    workflow: {
      runId: process.env.GITHUB_RUN_ID ?? "1",
      attempt: process.env.GITHUB_RUN_ATTEMPT ?? "1",
    },
    event: process.env.GITHUB_EVENT_NAME ?? "manual",
  });
  if (
    git("rev-parse", "HEAD") !== sha ||
    git("rev-parse", "HEAD^{tree}") !== tree ||
    git("status", "--porcelain", "--untracked-files=all")
  ) {
    receipt.status = "unknown";
    receipt.reason = "source-changed-during-run";
  }
  await writeJson(output, receipt);
  process.stdout.write(JSON.stringify(receipt) + "\n");
  process.exitCode = receipt.status === "passed" ? 0 : 1;
} catch {
  process.stderr.write(
    "full-main observation failed; owner orchestrator; inspect source and completion receipt\n",
  );
  process.exitCode = 1;
}

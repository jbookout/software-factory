import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assessNightly } from "./nightly-backstop.mjs";

const call = (args, encoding = "utf8") =>
  execFileSync("gh", ["api", "--method", "GET", ...args], {
    encoding,
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
export async function observeNightly(
  policy,
  {
    get = async (route) => JSON.parse(call([route])),
    download = async (artifact) => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "nightly-artifact-"),
      );
      try {
        const file = path.join(root, "receipt.zip");
        await fs.writeFile(
          file,
          call(
            [`repos/${policy.repository}/actions/artifacts/${artifact.id}/zip`],
            null,
          ),
          { mode: 0o600 },
        );
        return JSON.parse(
          execFileSync("unzip", ["-p", file, "receipt.json"], {
            encoding: "utf8",
            timeout: 5000,
            maxBuffer: 128 * 1024,
            stdio: ["ignore", "pipe", "pipe"],
          }),
        );
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
    now = Date.now(),
  } = {},
) {
  try {
    if (!/^[a-z0-9-]+\.yml$/.test(policy.workflow)) throw Error();
    const payload = await get(
      `repos/${policy.repository}/actions/workflows/${policy.workflow}/runs?event=schedule&branch=main&per_page=100`,
    );
    if (
      !Array.isArray(payload.workflow_runs) ||
      !Number.isSafeInteger(payload.total_count)
    )
      throw Error();
    const runs = payload.workflow_runs
      .filter((r) => r.event === "schedule" && r.head_branch === "main")
      .sort(
        (a, b) =>
          Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id,
      );
    const run = runs[0];
    if (!run) return assessNightly(null, policy, now);
    if (
      !Number.isSafeInteger(run.id) ||
      run.id < 1 ||
      !Number.isSafeInteger(run.run_attempt) ||
      run.run_attempt < 1 ||
      !/^[0-9a-f]{40}$/.test(run.head_sha)
    )
      throw Error();
    const created = Date.parse(run.created_at),
      updated = Date.parse(run.updated_at);
    if (
      !Number.isFinite(created) ||
      created > now ||
      !Number.isFinite(updated) ||
      updated < created ||
      updated > now
    )
      throw Error();
    const completed = run.status === "completed";
    if (!completed)
      return {
        ...assessNightly(null, policy, now),
        state:
          now - Date.parse(run.created_at) >= policy.deadlineSeconds * 1000
            ? "stale"
            : "pending",
        reason: "scheduled-run-incomplete",
      };
    if (run.conclusion !== "success")
      return {
        ...assessNightly(null, policy, now),
        state: "failed",
        reason: "scheduled-workflow-failed",
        observationLagSeconds: Math.max(0, (now - updated) / 1000),
        source: { sha: run.head_sha, tree: null },
        workflow: { runId: String(run.id), attempt: String(run.run_attempt) },
      };
    const artifacts = await get(
      `repos/${policy.repository}/actions/runs/${run.id}/artifacts?per_page=100`,
    );
    if (
      !Array.isArray(artifacts.artifacts) ||
      !Number.isSafeInteger(artifacts.total_count) ||
      artifacts.total_count < 0 ||
      artifacts.total_count > 100
    )
      throw Error();
    const matched = artifacts.artifacts.filter(
      (a) => a.name === `full-main-${policy.suite}-receipt` && !a.expired,
    );
    if (
      matched.length !== 1 ||
      !Number.isSafeInteger(matched[0].id) ||
      matched[0].id < 1 ||
      !Number.isSafeInteger(matched[0].size_in_bytes) ||
      matched[0].size_in_bytes <= 0 ||
      matched[0].size_in_bytes > 1024 * 1024
    )
      throw Error();
    const receipt = await download(matched[0]);
    if (
      String(receipt.workflow?.runId) !== String(run.id) ||
      String(receipt.workflow?.attempt) !== String(run.run_attempt) ||
      receipt.source?.sha !== run.head_sha ||
      Date.parse(receipt.startedAt) < Date.parse(run.created_at) ||
      Date.parse(receipt.completedAt) > Date.parse(run.updated_at)
    )
      throw Error();
    return assessNightly(receipt, policy, now);
  } catch {
    return {
      ...assessNightly(null, policy, now),
      reason: "provider-or-artifact-unreadable",
    };
  }
}

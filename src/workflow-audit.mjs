import { parseDocument } from "yaml";
const writable = (permissions) =>
  permissions === "write-all" || Object.values(permissions ?? {}).includes("write");

export function auditWorkflow(source, file = "workflow.yml") {
  const findings = [];
  const add = (property) => findings.push({ file, property });
  const doc = parseDocument(source, { uniqueKeys: true });
  if (doc.errors.length) return [{ file, property: "invalid-yaml" }];
  let workflow;
  try {
    workflow = doc.toJS({ maxAliasCount: 20 });
  } catch {
    return [{ file, property: "invalid-yaml" }];
  }
  if (!workflow?.jobs || !workflow.on) return [{ file, property: "invalid-workflow" }];
  if (
    !workflow.permissions ||
    writable(workflow.permissions) ||
    workflow.permissions === "read-all"
  )
    add("readonly-default");
  const events =
    typeof workflow.on === "string"
      ? [workflow.on]
      : Array.isArray(workflow.on)
        ? workflow.on
        : Object.keys(workflow.on);
  for (const job of Object.values(workflow.jobs)) {
    if (!job || !Array.isArray(job.steps) || !job["runs-on"]) {
      add("invalid-job");
      continue;
    }
    if (!Number.isFinite(job["timeout-minutes"]) || job["timeout-minutes"] <= 0)
      add("missing-timeout");
    const authority = writable(job.permissions ?? workflow.permissions);
    const serialized = JSON.stringify([workflow.env, job.env, job.secrets, job.steps]);
    const credentials =
      /secrets[.\[]|github\.token|(?:TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)"\s*:/i.test(serialized);
    if (
      authority &&
      events.some((event) =>
        ["pull_request", "pull_request_target", "workflow_run"].includes(event),
      )
    )
      add("privileged-trigger");
    if (credentials || authority) add("build-credentials");
    for (const step of job.steps) {
      if (step.uses && !/^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/.test(step.uses)) add("mutable-ref");
      if (
        step.uses?.startsWith("actions/checkout@") &&
        step.with?.["persist-credentials"] !== false
      )
        add("persisted-checkout-token");
      if (/\$\{\{[^}]*\b(?:github|inputs)\b/.test(step.run ?? "")) add("event-shell-injection");
      if (
        /\b(?:npm publish|wrangler (?:deploy|publish)|gh release|docker push)\b/.test(
          step.run ?? "",
        )
      )
        add("publication-in-validation");
      if (step.uses?.startsWith("actions/download-artifact@"))
        add("artifact-execution-review-required");
      if (
        step.uses?.startsWith("actions/upload-artifact@") &&
        /(?:\.env|\.git\b|credentials|tokens|(?:^|\s)[./]*\*(?:\s|$))/i.test(step.with?.path ?? "")
      )
        add("private-artifact");
    }
  }
  return findings;
}

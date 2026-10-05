import { observeNightly } from "../src/nightly-observation.mjs";
import { recordDiagnosis } from "../src/nightly-backstop.mjs";
import { writeJson, withLease } from "../src/pr-delivery-state.mjs";
try {
  const [root, repository] = process.argv.slice(2);
  if (
    !root ||
    process.argv.length > 4 ||
    (repository &&
      !["jbookout/software-factory", "jbookout/doctorcre-app"].includes(
        repository,
      ))
  )
    throw Error();
  const policies = [
    {
      repository: "jbookout/software-factory",
      suite: "factory",
      workflow: "ci.yml",
      cadenceSeconds: 86400,
      deadlineSeconds: 3300,
    },
    {
      repository: "jbookout/doctorcre-app",
      suite: "app",
      workflow: "ci.yml",
      cadenceSeconds: 86400,
      deadlineSeconds: 1200,
    },
    {
      repository: "jbookout/doctorcre-app",
      suite: "app-e2e",
      workflow: "e2e.yml",
      cadenceSeconds: 86400,
      deadlineSeconds: 600,
    },
  ];
  await withLease(`${root}/locks`, "nightly-snapshot", async () => {
    const observations = [];
    for (const policy of policies.filter(
      (p) => !repository || p.repository === repository,
    )) {
      const result = await observeNightly(policy);
      const recorded = await recordDiagnosis(root, result);
      observations.push(result.state === "pending" ? result : recorded ?? result);
    }
    await writeJson(`${root}/observation.json`, {
      schema: "nightly-watch.v1",
      mode: "shadow",
      gateAuthority: false,
      observations,
    });
    process.stdout.write(JSON.stringify(observations) + "\n");
    process.exitCode = observations.every(
      (r) => r.state === "fresh" || r.state === "pending",
    ) ? 0 : 1;
  }, { waitMs: 10000, pollMs: 10 });
} catch {
  process.stderr.write(
    "nightly observation unknown; owner orchestrator; retry bounded REST read\n",
  );
  process.exitCode = 1;
}

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { auditWorkflow } from "../../src/workflow-audit.mjs";
const roots = process.argv.slice(2);
if (!roots.length) throw new Error("provide repository paths");
const findings = [];
for (const root of roots) {
  const pins = JSON.parse(await readFile(join(root, ".github/action-pins.json"), "utf8"));
  const directory = join(root, ".github/workflows");
  const files = (await readdir(directory)).filter((name) => /\.ya?ml$/.test(name));
  if (!files.length) throw new Error("no workflows found");
  for (const name of files)
    findings.push(
      ...auditWorkflow(await readFile(join(directory, name), "utf8"), pins, join(directory, name)),
    );
}
console.log(JSON.stringify(findings));
if (findings.length) process.exitCode = 1;

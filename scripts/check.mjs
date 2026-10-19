import { runVerification } from "../src/local-verification.mjs";
import { reserveCheck } from "../src/check-admission.mjs";
const classes = {
  presentation: [process.execPath, "capabilities/client-presentation/scripts/browser-acceptance.mjs"],
  node: [process.execPath, "--test", "--test-concurrency=2"],
  browser: ["python3", "capabilities/jev-browser-select/test_select.py"],
  orchestration: [
    "python3",
    "-m",
    "unittest",
    "discover",
    "-s",
    "test/orch",
    "-p",
    "test_*.py",
    "-v",
  ],
};
const args = process.argv.slice(2);
const focused =
  args[0] === "node" &&
  args.length > 1 &&
  !args.slice(1).every((name) => Object.hasOwn(classes, name));
if (focused) classes.node.push(...args.slice(1));
const selected = focused ? ["node"] : args.length ? args : Object.keys(classes);
const controller = new AbortController();
const cancel = () => controller.abort();
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
let admission;
try {
  admission = await reserveCheck({ signal: controller.signal });
  for (const name of selected) {
    if (!classes[name]) throw new Error(`unknown check class ${name}`);
    const result = await runVerification({
      cwd: process.cwd(),
      argv: classes[name],
      admission,
      signal: controller.signal,
    });
    console.log(JSON.stringify({ class: name, ...result }));
    if (result.code) {
      console.error(await (await import("node:fs/promises")).readFile(result.log, "utf8"));
      process.exitCode = 1;
    }
    if (controller.signal.aborted) {
      process.exitCode = 130;
      break;
    }
  }
} catch (error) {
  if (!controller.signal.aborted) throw error;
  process.exitCode = 130;
} finally {
  await admission?.release();
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
}

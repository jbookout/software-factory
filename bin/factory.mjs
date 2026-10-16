#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { createFactory } from "../src/operating-loop.mjs";
import { runVerification } from "../src/local-verification.mjs";

const [file] = process.argv.slice(2);
if (!file) throw new Error("usage: factory.mjs <job.json>");
const job = JSON.parse(await fs.readFile(file, "utf8"));
const result = await createFactory().run(job, {
  async execute(step) {
    const argv = job.commands?.[step];
    if (!argv) return { status: step === "cleanup" ? "pass" : "skip" };
    const result = await runVerification({
      cwd: path.resolve(path.dirname(file), job.root ?? "."),
      argv,
    });
    console.log(JSON.stringify({ step, ...result }));
    return { status: result.code === 0 ? "pass" : "fail", ...result };
  },
});
console.log(JSON.stringify(result));
if (result.outcome !== "complete") process.exitCode = 1;

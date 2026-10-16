import { runVerification } from "./local-verification.mjs";

export async function verifyDesign({ cwd, tests, ...options }) {
  if (!Array.isArray(tests) || !tests.length)
    throw new Error("product behavioral test commands required");
  const results = [];
  for (const argv of tests) results.push(await runVerification({ ...options, cwd, argv }));
  return { passed: results.every((result) => result.code === 0), results };
}

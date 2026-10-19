#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { runVerification } from "../src/local-verification.mjs";

import {
  createFactory,
  createScriptAdapter,
  createPinnedBuildContext,
  readPinnedContract,
  routeDoctorCreBuild,
  selectOptionalBuildContext,
  authenticateEvaluationBundle,
} from "../src/index.mjs";

const [jobPath, profilePath] = process.argv.slice(2);
if (!jobPath) {
  process.stderr.write("usage: npm run factory -- <job.json> <product-profile.json>\n");
  process.exitCode = 2;
} else if (!profilePath) {
  const job = JSON.parse(await fs.readFile(jobPath, "utf8"));
  const result = await createFactory().run(job, {
    async execute(step) {
      const argv = job.commands?.[step];
      if (!argv) return { status: step === "cleanup" ? "pass" : "skip" };
      const result = await runVerification({
        cwd: path.resolve(path.dirname(jobPath), job.root ?? "."),
        argv,
      });
      console.log(JSON.stringify({ step, ...result }));
      return { status: result.code === 0 ? "pass" : "fail", ...result };
    },
  });
  console.log(JSON.stringify(result));
  if (result.outcome !== "complete") process.exitCode = 1;
} else {
  const job = JSON.parse(await fs.readFile(jobPath, "utf8"));
  const profile = JSON.parse(await fs.readFile(profilePath, "utf8"));
  const root = path.resolve(path.dirname(profilePath), profile.root ?? ".");
  const adapter = createScriptAdapter({
    root,
    commands: {
      ...profile.commands,
      check: profile.commands.check ?? profile.commands.verify,
      cleanup: profile.commands.cleanup ?? profile.commands["environment:dispose"],
    },
    timeoutMs: profile.timeoutMs,
    maxOutputBytes: profile.maxOutputBytes,
  });
  const modelRoomAdvisor =
    profile.modelRoom?.enabled === true
      ? async () => {
          const load = (reference) =>
            readPinnedContract({
              root: path.resolve(path.dirname(profilePath), reference.root),
              sourceRevision: reference.sourceRevision,
              path: reference.path,
              startLine: reference.startLine,
              endLine: reference.endLine,
            });
          const contracts = await Promise.all(profile.modelRoom.contracts.map(load));
          const optional = await Promise.all((profile.modelRoom.optionalContext ?? []).map(load));
          const selection = await selectOptionalBuildContext({
            task: job.outcome,
            chunks: optional,
            apiKey: process.env.TYPESAFE_API_KEY,
          });
          const buildContext = createPinnedBuildContext([...contracts, ...selection.contracts]);
          let evidence = { status: "unavailable", reason: "not_configured", bundle_digest: null };
          let authenticated = {
            observations: [],
            minimumCases: profile.modelRoom.minimumCases ?? 3,
            verifyObservation: () => false,
            verifyControl: () => false,
          };
          if (profile.modelRoom.evaluationBundle) {
            try {
              const bundlePath = path.resolve(
                path.dirname(profilePath),
                profile.modelRoom.evaluationBundle,
              );
              const bundle = JSON.parse(await fs.readFile(bundlePath, "utf8"));
              authenticated = authenticateEvaluationBundle(
                bundle,
                process.env.MODEL_ROOM_EVALUATION_KEY,
              );
              evidence = {
                status: "authenticated",
                reason: null,
                bundle_digest: authenticated.bundleDigest,
              };
            } catch (error) {
              evidence = {
                status: "unavailable",
                reason: error.message.includes("signature")
                  ? "signature_mismatch"
                  : "invalid_or_missing_bundle",
                bundle_digest: null,
              };
            }
          }
          const route = await routeDoctorCreBuild({
            task: job.outcome,
            contracts,
            baseline: profile.modelRoom.baseline,
            candidates: profile.modelRoom.candidates,
            observations: authenticated.observations,
            verifyObservation: authenticated.verifyObservation,
            verifyControl: authenticated.verifyControl,
            minimumCases: authenticated.minimumCases,
            controlEnabled: profile.modelRoom.controlMode === "qualified_only",
            apiKey: process.env.TYPESAFE_API_KEY,
          });
          const { contracts: selectedText, ...contextSelection } = selection;
          return {
            ...route,
            qualification_evidence: evidence,
            context_selection: contextSelection,
            build_context: buildContext,
          };
        }
      : null;
  const result = await createFactory({ modelRoomAdvisor }).run(job, {
    execute(step, request) {
      if (
        step === "cleanup" &&
        !profile.commands.cleanup &&
        !profile.commands["environment:dispose"]
      )
        return { status: "pass" };
      return adapter.execute(step, request);
    },
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.outcome !== "complete") process.exitCode = 1;
}

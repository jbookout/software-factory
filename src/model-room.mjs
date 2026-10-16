import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { askJev } from "./jev-usage.mjs";
const execFileAsync = promisify(execFile);
const JEV_MODEL = "jev-1.13.0";
const MAX_TASK_CHARS = 4000,
  MAX_CONTRACT_CHARS = 12000,
  MAX_BUILD_CONTRACTS = 8,
  MAX_OPTIONAL_CONTEXT = 4;
const VISIBILITY = ["hide", "short", "long", "full"];
function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function bounded(value, limit) {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    throw new Error("invalid model room input");
  return value;
}

/** Read a bounded contract excerpt from an exact Git commit, not a prompt claim. */
export async function readPinnedContract({ root, sourceRevision, path, startLine, endLine }) {
  if (
    typeof root !== "string" ||
    !root ||
    !/^[0-9a-f]{40}$/.test(sourceRevision) ||
    typeof path !== "string" ||
    !/^[A-Za-z0-9_./-]+$/.test(path) ||
    path.startsWith("/") ||
    path.split("/").includes("..") ||
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine - startLine > 200
  )
    throw new Error("invalid pinned contract reference");
  const { stdout: kind } = await execFileAsync("git", ["cat-file", "-t", sourceRevision], {
    cwd: root,
  });
  if (kind.trim() !== "commit") throw new Error("contract revision is not a commit");
  const { stdout } = await execFileAsync("git", ["show", `${sourceRevision}:${path}`], {
    cwd: root,
    maxBuffer: 2_000_000,
  });
  const lines = stdout.split("\n");
  if (endLine > lines.length) throw new Error("contract line range missing");
  const excerpt = bounded(lines.slice(startLine - 1, endLine).join("\n"), MAX_CONTRACT_CHARS);
  return {
    source_revision: sourceRevision,
    path,
    content_digest: `sha256:${createHash("sha256").update(excerpt).digest("hex")}`,
    excerpt,
  };
}

/** Retain the required source text with its exact revision. */
export function createPinnedBuildContext(contracts) {
  if (!Array.isArray(contracts) || !contracts.length || contracts.length > MAX_BUILD_CONTRACTS)
    throw new Error("invalid pinned build context");
  const bound = contracts.map((contract) => {
    if (
      !contract ||
      !/^[0-9a-f]{40}$/.test(contract.source_revision) ||
      typeof contract.path !== "string" ||
      !/^[A-Za-z0-9_./-]+$/.test(contract.path) ||
      contract.path.startsWith("/") ||
      contract.path.split("/").includes("..") ||
      !/^sha256:[0-9a-f]{64}$/.test(contract.content_digest)
    )
      throw new Error("invalid pinned build context");
    const excerpt = bounded(contract.excerpt, MAX_CONTRACT_CHARS);
    const contentDigest = `sha256:${createHash("sha256").update(excerpt).digest("hex")}`;
    if (contract.content_digest !== contentDigest)
      throw new Error("pinned build context digest mismatch");
    return {
      source_revision: contract.source_revision,
      path: contract.path,
      content_digest: contract.content_digest,
      excerpt,
    };
  });
  return { schema: "pinned-build-context.v1", digest: digest(bound), contracts: bound };
}

export function verifyPinnedBuildContext(context) {
  if (
    !context ||
    context.schema !== "pinned-build-context.v1" ||
    typeof context.digest !== "string"
  )
    return false;
  try {
    return createPinnedBuildContext(context.contracts).digest === context.digest;
  } catch {
    return false;
  }
}

/** Jev may trim optional pinned context, never the required contract. */
export async function selectOptionalBuildContext({
  task,
  chunks = [],
  apiKey,
  fetchImpl = fetch,
  usageLog,
  cacheDir,
}) {
  const taskText = bounded(task, MAX_TASK_CHARS);
  if (!Array.isArray(chunks) || chunks.length > MAX_OPTIONAL_CONTEXT)
    throw new Error("invalid optional build context");
  const pinned = chunks.length ? createPinnedBuildContext(chunks).contracts : [];
  const hidden = {
    schema: "optional-context-selection.v1",
    status: "unavailable",
    reason: apiKey ? "service_error" : "no_api_key",
    model: JEV_MODEL,
    choices: pinned.map((chunk) => ({
      path: chunk.path,
      source_digest: chunk.content_digest,
      visibility: "hide",
    })),
    contracts: [],
  };
  if (!pinned.length) return { ...hidden, status: "skipped", reason: "no_optional_context" };
  if (!apiKey) return hidden;
  const state = { task_class: "doctorcre-build", task: taskText, chunks: pinned };
  const questions = Object.fromEntries(
    pinned.map((chunk, index) => [
      `context_${index}`,
      {
        type: "choice",
        instructions: `How much of this optional pinned source should the build model see for the task? The required contract is already supplied separately. Choose the least detail that preserves useful task evidence.`,
        criteria: {
          hide: "Irrelevant to the current task.",
          short: "The first 600 characters suffice.",
          long: "The first 3000 characters are useful.",
          full: "The entire excerpt is needed.",
        },
      },
    ]),
  );
  try {
    const body = await askJev({
      model: JEV_MODEL,
      state,
      questions,
      apiKey,
      caller: "model-room-optional-context",
      fetchImpl,
      usageLog,
      cacheDir,
    });
    if (body?.model !== JEV_MODEL) return { ...hidden, reason: "invalid_answer" };
    const parsed = pinned.map((_, index) =>
      parseChoice(body.answers?.[`context_${index}`], VISIBILITY),
    );
    if (parsed.some((choice) => !choice)) return { ...hidden, reason: "invalid_answer" };
    const choices = pinned.map((chunk, index) => ({
      path: chunk.path,
      source_digest: chunk.content_digest,
      visibility: parsed[index].choice,
      confidence: parsed[index].confidence,
    }));
    const contracts = pinned.flatMap((chunk, index) => {
      const visibility = parsed[index].choice;
      if (visibility === "hide") return [];
      const excerpt =
        visibility === "full"
          ? chunk.excerpt
          : chunk.excerpt.slice(0, visibility === "short" ? 600 : 3000);
      return [
        {
          ...chunk,
          excerpt,
          content_digest: `sha256:${createHash("sha256").update(excerpt).digest("hex")}`,
        },
      ];
    });
    return {
      schema: "optional-context-selection.v1",
      status: "available",
      reason: null,
      model: JEV_MODEL,
      choices,
      contracts,
    };
  } catch {
    return hidden;
  }
}

function validateRoute(route) {
  if (!route || typeof route !== "object") throw new Error("route is required");
  for (const key of ["provider", "model", "effort"]) bounded(route[key], 80);
  return { provider: route.provider, model: route.model, effort: route.effort };
}

function parseChoice(answer, keys) {
  if (
    answer?.type !== "choice" ||
    !keys.includes(answer.choice) ||
    typeof answer.confidence !== "number" ||
    answer.confidence < 0 ||
    answer.confidence > 1 ||
    !answer.probabilities ||
    typeof answer.probabilities !== "object" ||
    Object.keys(answer.probabilities).length !== keys.length
  )
    return null;
  const values = keys.map((key) => answer.probabilities[key]);
  if (
    values.some((value) => typeof value !== "number" || value < 0 || value > 1) ||
    Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 0.02
  )
    return null;
  return {
    choice: answer.choice,
    confidence: answer.confidence,
    probabilities: answer.probabilities,
  };
}

export async function routeDoctorCreBuild({ task, contracts, route, execute }) {
  bounded(task, MAX_TASK_CHARS);
  validateRoute(route);
  const context = createPinnedBuildContext(contracts);
  if (typeof execute !== "function") throw new Error("Model Room execution adapter required");
  const result = await execute({ task, route, context });
  if (
    result?.model !== route.model ||
    result?.provider !== route.provider ||
    result?.effort !== route.effort
  )
    throw new Error("Model Room actual route differs from requested route");
  return result;
}

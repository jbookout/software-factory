export function normalizeResult(result, step) {
  if (!["pass", "fail", "skip"].includes(result?.status))
    throw new Error(`${step} returned invalid status`);
  return { ...result, data: result.data ?? {} };
}

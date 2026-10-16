const TOKEN = /^[A-Za-z0-9_.-]{1,80}$/;

export function createCodexExecArgs(route) {
  if (!TOKEN.test(route?.model ?? "") || !TOKEN.test(route?.effort ?? ""))
    throw new Error("invalid Codex model or effort");
  return [
    "exec",
    "--ephemeral",
    "-m",
    route.model,
    "-c",
    `model_reasoning_effort=${JSON.stringify(route.effort)}`,
  ];
}

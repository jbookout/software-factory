export function createFactory() {
  return {
    async run(job, adapter) {
      const rounds = job.rounds ?? 3;
      if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10)
        throw new Error("rounds must be between one and ten");
      const events = [];
      const execute = async (step) => {
        const result = await adapter.execute(step, job);
        events.push({ step, ...result });
        return result.status === "pass";
      };
      const result = { outcome: "failed", events };
      try {
        for (let round = 0; round < rounds; round++) {
          if (!(await execute("build"))) break;
          if (await execute("check")) {
            result.outcome = "complete";
            break;
          }
          if (round + 1 < rounds && !(await execute("repair"))) break;
        }
      } finally {
        if (!(await execute("cleanup"))) result.outcome = "failed";
      }
      return result;
    },
  };
}

export async function runPrDelivery(job, adapter) {
  const { rounds = 3, ...request } = job;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10)
    throw new Error("rounds must be between one and ten");
  for (let round = 0; round <= rounds; round++) {
    const inspect = await adapter.execute("pr:inspect", request);
    if (inspect.status !== "pass") return { code: inspect.data.code ?? 1, ...inspect.data };
    if (inspect.data.merged || inspect.data.ready) {
      const complete = await adapter.execute("pr:complete", request);
      if (complete.status !== "pass") return { code: complete.data.code ?? 1, ...complete.data };
      return {
        code: 0,
        merged: inspect.data.merged === true,
        message: inspect.data.message ?? "CHECKS GREEN",
      };
    }
    if (!inspect.data.repairable || round === rounds)
      return { code: 75, message: "WAIT: hosted checks or mergeability need attention" };
    const repair = await adapter.execute("ci-fix", request);
    if (repair.status !== "pass") return { code: repair.data.code ?? 1, ...repair.data };
  }
}

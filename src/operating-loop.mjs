import { verifyPinnedBuildContext } from "./model-room.mjs";

export function createFactory({ modelRoomAdvisor = null } = {}) {
  return {
    async run(job, adapter) {
      const rounds = job.rounds ?? 3;
      if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10)
        throw new Error("rounds must be between one and ten");
      const events = [];
      let modelRoom = null;
      const execute = async (step) => {
        const result = await adapter.execute(
          step,
          structuredClone({
            ...job,
            ...(step === "build" && modelRoom
              ? {
                  route: modelRoom.selected_route,
                  modelRoomStateDigest: modelRoom.state_digest,
                  ...(modelRoom.build_context
                    ? { pinnedBuildContext: modelRoom.build_context }
                    : {}),
                }
              : {}),
          }),
        );
        events.push({ step, ...result });
        return result.status === "pass";
      };
      const result = { outcome: "failed", events };
      try {
        if (job.product === "DoctorCRE" && modelRoomAdvisor) {
          modelRoom = await modelRoomAdvisor({ job: structuredClone(job) });
          if (modelRoom?.schema !== "doctorcre-build-route.v1" || !modelRoom.selected_route)
            throw new Error("invalid model room advice");
          if (modelRoom.build_context && !verifyPinnedBuildContext(modelRoom.build_context))
            throw new Error("invalid pinned build context");
        }
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
      if (modelRoom) {
        const { build_context, ...receipt } = modelRoom;
        result.modelRoom = receipt;
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

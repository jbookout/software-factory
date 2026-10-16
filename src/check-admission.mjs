import os from "node:os";
import path from "node:path";
import { Deadline } from "./deadline.mjs";
import { acquireLease } from "./pr-delivery-state.mjs";

export async function reserveCheck({
  root = path.join(os.homedir(), ".cache/software-factory/checks"),
  budget = new Deadline(3600_000),
  capacity = 3,
} = {}) {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 3)
    throw new Error("check capacity must be between one and three");
  while (true) {
    budget.check();
    for (let slot = 0; slot < capacity; slot++) {
      const release = await acquireLease(root, `check-${slot}`, { budget });
      if (release)
        return { release, bindJob: async (job, signal) => [await release.bindJob(job, signal)] };
    }
    await budget.sleep(100);
  }
}

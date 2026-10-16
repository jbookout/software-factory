import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createFactory } from "../src/operating-loop.mjs";
import { openDesignJournal } from "../src/design-journal.mjs";
import { verifyDesign } from "../src/design-verify.mjs";
import { reserveCheck } from "../src/check-admission.mjs";
import { loadDesignSettings } from "../src/design-settings.mjs";

const temporary = async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};
test("build repairs at most the requested rounds and always cleans up", async () => {
  const calls = [];
  const result = await createFactory().run(
    { rounds: 2 },
    {
      async execute(step) {
        calls.push(step);
        return { status: step === "check" ? "fail" : "pass" };
      },
    },
  );
  assert.equal(result.outcome, "failed");
  assert.deepEqual(calls, ["build", "check", "repair", "build", "check", "cleanup"]);
});
test("build failure still runs cleanup", async () => {
  const calls = [];
  await assert.rejects(
    createFactory().run(
      {},
      {
        async execute(step) {
          calls.push(step);
          if (step === "build") throw new Error("failed build");
          return { status: "pass" };
        },
      },
    ),
    /failed build/,
  );
  assert.deepEqual(calls, ["build", "cleanup"]);
});
test("product shell test commands retain status and separate ordinary logs", async (t) => {
  const root = await temporary(t);
  const result = await verifyDesign({
    cwd: root,
    root,
    tests: [
      ["sh", "-c", "echo behavior; exit 7"],
      ["sh", "-c", "echo healthy"],
    ],
  });
  assert.equal(result.passed, false);
  assert.deepEqual(
    result.results.map((row) => row.code),
    [7, 0],
  );
  assert.notEqual(result.results[0].log, result.results[1].log);
  assert.match(await fs.readFile(result.results[0].log, "utf8"), /behavior/);
});
test("check limiter admits only its configured concurrent owners", async (t) => {
  const root = await temporary(t);
  const first = await reserveCheck({ root, capacity: 1 });
  let admitted = false;
  const waiting = reserveCheck({ root, capacity: 1 }).then((second) => {
    admitted = true;
    return second;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(admitted, false);
  await first.release();
  const second = await waiting;
  await second.release();
  assert.equal(admitted, true);
});
test("journal retains existing tables, isolates projects and backs up SQLite without overwriting", async (t) => {
  const root = await temporary(t);
  const options = {
    root: path.join(root, "journal"),
    userId: "fixture",
    projectId: "one☀",
    version: 1,
  };
  const journal = await openDesignJournal(options);
  await journal.execute({
    command: "append",
    kind: "brief",
    record: { objective: "Retain this record" },
  });
  const database = path.join(options.root, "journal.sqlite");
  execFileSync("python3", [
    "-c",
    `import sqlite3,sys,json,hashlib
s=json.loads(sys.argv[2]); key=hashlib.sha256(json.dumps(s,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
with sqlite3.connect(sys.argv[1]) as db:
 db.execute('CREATE TABLE events(scope TEXT, payload TEXT)')
 db.execute('INSERT INTO events VALUES(?,?)',(key,'existing interview'))
`,
    database,
    JSON.stringify({ userId: "fixture", projectId: "one☀", version: 1 }),
  ]);
  const read = await journal.execute({ command: "read" });
  assert.equal(read.records[0].record.objective, "Retain this record");
  assert.equal(read.existing.events[0].payload, "existing interview");
  const other = await openDesignJournal({ ...options, projectId: "two" });
  assert.deepEqual((await other.execute({ command: "read" })).records, []);
  const destination = path.join(root, "backup");
  const backup = await journal.execute({ command: "backup", destination });
  assert.equal((await fs.stat(backup.database)).mode & 0o777, 0o600);
  const restored = await openDesignJournal({ ...options, root: destination });
  assert.deepEqual(await restored.execute({ command: "read" }), read);
  await assert.rejects(journal.execute({ command: "backup", destination }), /File exists/);
});
test("journal refuses public directories and linked database files", async (t) => {
  const root = await temporary(t),
    publicDir = path.join(root, "public");
  await fs.mkdir(publicDir, { mode: 0o755 });
  const options = { root: publicDir, userId: "fixture", projectId: "one☀", version: 1 };
  const journal = await openDesignJournal(options);
  await assert.rejects(journal.execute({ command: "read" }), /private/);
  const privateDir = path.join(root, "private");
  await fs.mkdir(privateDir, { mode: 0o700 });
  await fs.symlink(path.join(root, "other.sqlite"), path.join(privateDir, "journal.sqlite"));
  const linked = await openDesignJournal({ ...options, root: privateDir });
  await assert.rejects(linked.execute({ command: "read" }));
});
test("worker settings are editable provider/model/effort assignments", async (t) => {
  const root = await temporary(t),
    file = path.join(root, "settings.json");
  const settings = {
    workers: { builder: { provider: "codex", model: "fixture", effort: "high" } },
  };
  await fs.writeFile(file, JSON.stringify(settings));
  assert.deepEqual(await loadDesignSettings(file), settings);
});

test("a failed cleanup is reported as a failed job", async () => {
  const result = await createFactory().run(
    {},
    {
      async execute(step) {
        return { status: step === "cleanup" ? "fail" : "pass" };
      },
    },
  );
  assert.equal(result.outcome, "failed");
  assert.equal(result.events.at(-1).step, "cleanup");
  assert.equal(result.events.at(-1).status, "fail");
});

test("a queued check cancels without acquiring a slot", async (t) => {
  const root = await temporary(t),
    controller = new AbortController();
  const first = await reserveCheck({ root, capacity: 1 });
  try {
    const queued = reserveCheck({ root, capacity: 1, signal: controller.signal });
    controller.abort();
    await assert.rejects(queued, { code: 130 });
  } finally {
    await first.release();
  }
  const next = await reserveCheck({ root, capacity: 1 });
  await next.release();
});

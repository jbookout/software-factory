import test from "node:test";
import assert from "node:assert/strict";
import "../assets/site/selection-adapter.js";

const { createSelectionAdapter } = globalThis.PresentationSelectionAdapter;
const state = (overrides = {}) => ({
  version: 2,
  selected_ids: ["example-one"],
  property_notes: {},
  notes: "Synthetic note",
  updated_at: "2026-10-01T12:00:00Z",
  csrf_token: "synthetic-csrf",
  ...overrides,
});
const reply = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test("shared adapter loads server state and saves with the current version and CSRF header", async () => {
  const calls = [];
  const adapter = createSelectionAdapter({
    endpoint: "/api/selection",
    fetchImpl: async (...args) => {
      calls.push(args);
      return calls.length === 1 ? reply(state()) : reply(
        state({
          version: 3,
          selected_ids: ["example-two"],
          notes: "Updated",
        }),
      );
    },
  });
  const loaded = await adapter.load();
  assert.equal(loaded.status, "loaded");
  assert.equal(loaded.state.version, 2);
  const saved = await adapter.save({
    selected_ids: ["example-two"],
    notes: "Updated",
    property_notes: {},
  });
  assert.equal(saved.status, "saved");
  assert.deepEqual(JSON.parse(calls[1][1].body), {
    version: 2,
    selected_ids: ["example-two"],
    notes: "Updated",
    property_notes: {},
  });
  assert.equal(calls[1][1].headers["X-CSRF-Token"], "synthetic-csrf");
  assert.equal(calls[1][1].credentials, "same-origin");
});

test("version conflict returns current server state without silently retrying", async () => {
  let calls = 0;
  const adapter = createSelectionAdapter({
    endpoint: "/api/selection",
    fetchImpl: async () =>
      ++calls === 1 ? reply(state()) : reply({
        error: "version_conflict",
        current: state({
          version: 3,
          selected_ids: ["example-two"],
          notes: "Other user",
        }),
      }, 409),
  });
  await adapter.load();
  const result = await adapter.save({
    selected_ids: ["example-one"],
    notes: "Local draft",
    property_notes: {},
  });
  assert.equal(result.status, "conflict");
  assert.equal(result.state.version, 3);
  assert.equal(calls, 2);
});

test("disabled or failed services do not report that a save succeeded", async () => {
  const adapter = createSelectionAdapter({
    endpoint: "/api/selection",
    fetchImpl: async () => reply({ error: "storage_unavailable" }, 503),
  });
  assert.equal((await adapter.load()).status, "unavailable");
  assert.equal(
    (await adapter.save({ selected_ids: [], property_notes: {}, notes: "" })).status,
    "unavailable",
  );
});

test("shared endpoints cannot escape the current origin", () => {
  assert.throws(
    () =>
      createSelectionAdapter({
        endpoint: "https://example.test/api/selection",
        fetchImpl: async () => {},
      }),
    /same-origin/,
  );
  assert.throws(
    () =>
      createSelectionAdapter({
        endpoint: "//example.test/api/selection",
        fetchImpl: async () => {},
      }),
    /same-origin/,
  );
});

test("a site can configure its same-origin CSRF header", async () => {
  let request;
  const adapter = createSelectionAdapter({
    endpoint: "/api/selection",
    csrfHeader: "X-Example-CSRF",
    fetchImpl: async (...args) => {
      request = args[1];
      return reply(state());
    },
  });
  await adapter.load();
  await adapter.save({selected_ids: [], property_notes: {}, notes: ""});
  assert.equal(request.headers["X-Example-CSRF"], "synthetic-csrf");
  assert.equal("X-CSRF-Token" in request.headers, false);
});

test("notes use a 2,000-code-point limit and reject NUL consistently", async () => {
  const adapter = createSelectionAdapter({
    endpoint: "/api/selection",
    fetchImpl: async () => reply(state()),
  });
  await adapter.load();
  assert.equal((await adapter.save({selected_ids: [], property_notes: {}, notes: "😀".repeat(2000)})).status, "saved");
  assert.equal((await adapter.save({selected_ids: [], property_notes: {}, notes: "😀".repeat(2001)})).status, "invalid");
  assert.equal((await adapter.save({selected_ids: [], property_notes: {}, notes: "bad\0note"})).status, "invalid");
});

test('endpoint traversal, backslash authority and controls refuse before fetch', () => {
  let calls = 0;
  for (const endpoint of [String.raw`/\attacker.example/path`, '/api/../selection', '/api/selection?url=elsewhere', '/api/selection\n']) {
    assert.throws(() => createSelectionAdapter({endpoint, fetchImpl: () => {calls++;}}), /same-origin/);
  }
  assert.equal(calls, 0);
});

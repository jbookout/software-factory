import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { build, validate } from "./build.mjs";

const fixtureRoot = new URL("../test/fixtures/", import.meta.url);
const fixture = (name) =>
  fs.readFile(new URL(name, fixtureRoot), "utf8").then(JSON.parse);
const makeTemp = () =>
  fs.mkdtemp(path.join(os.tmpdir(), "client-presentation-test-"));

for (
  const [file, mode] of [
    ["owner-occupancy.json", "owner_occupancy"],
    ["owner-occupancy-30-70.json", "owner_occupancy_30_70"],
    ["lease-only.json", "lease_only"],
  ]
) {
  test(`${mode} config builds a deterministic portable package with only its configured strategy`, async () => {
    const root = await makeTemp();
    const data = await fixture(file);
    const input = path.join(root, "input.json");
    const output = path.join(root, "site");
    await fs.writeFile(input, JSON.stringify(data));
    assert.equal(await build(input, output), path.join(output, "index.html"));
    const stored = JSON.parse(
      await fs.readFile(path.join(output, "presentation.json"), "utf8"),
    );
    assert.equal(stored.strategy.mode, mode);
    assert.equal(stored.brand.name, data.brand.name);
    assert.equal(stored.market.summary, data.market.summary);
    assert.ok(!JSON.stringify(stored).includes("/private/tmp/"));
    const context = { window: {} };
    vm.runInNewContext(
      await fs.readFile(path.join(output, "data.js"), "utf8"),
      context,
    );
    assert.equal(context.window.PresentationData.strategy.mode, mode);
    assert.ok(
      (await fs.readFile(path.join(output, "index.html"), "utf8")).includes(
        "selection-adapter.js",
      ),
    );
    assert.ok(
      (await fs.readFile(path.join(output, "index.html"), "utf8")).includes(
        "fonts.googleapis.com",
      ),
    );
    if (mode === "lease_only") {
      assert.equal(stored.properties.length, 0);
      assert.equal(stored.assumptions, undefined);
      assert.ok(
        !stored.sections.some((section) =>
          ["purchases", "strategy"].includes(section.id)
        ),
      );
    } else if (mode === "owner_occupancy") {
      assert.equal(stored.assumptions, undefined);
      const html = await fs.readFile(path.join(output, "index.html"), "utf8");
      assert.match(html, /id="finance-section"/);
    } else {
      assert.equal(stored.assumptions.occupancyFraction, 0.3);
      const result = globalThis.PresentationFinance.compute(
        stored.properties[0],
        stored.assumptions,
        stored.strategy.tiContributionPerSf,
      );
      assert.equal(
        result.practiceSf,
        Math.ceil(stored.properties[0].totalSf * 0.3),
      );
      assert.equal(
        result.tenantSf,
        stored.properties[0].totalSf - result.practiceSf,
      );
      assert.ok(result.outsideRent > 0);
      assert.ok(result.tenantTi >= 0);
      assert.match(await fs.readFile(path.join(output, "index.html"), "utf8"), /id="equity-year"/);
    }
    await assert.rejects(build(input, output), /EEXIST/);
  });
}

test("real client config requires complete source-backed records and a verified locator", async () => {
  const data = await fixture("owner-occupancy-30-70.json");
  data.presentation.fictional = false;
  const missingSources = structuredClone(data);
  missingSources.currentPractice = null;
  missingSources.demographics = null;
  missingSources.sections.find((section) => section.id === "demographics").visible = false;
  assert.throws(
    () => validate({ ...missingSources, sources: [] }),
    /client presentations require sources/,
  );
  for (
    const item of [...data.properties, ...data.leases, ...data.developments]
  ) item.noPhotoReason = "No synthetic image supplied.";
  data.metrics.forEach((metric) => {
    metric.sourceId = "source-market-fixture";
    metric.geography = "Example Region";
    metric.period = "2021–2026";
  });
  assert.equal(validate(data), data);
  delete data.properties[0].locator;
  data.properties[0].noPinReason = "No source-backed coordinate supplied.";
  assert.equal(validate(data), data);
});

test("strategy allocation, sections and same-origin feedback configuration are enforced", async () => {
  const full = await fixture("owner-occupancy.json");
  assert.equal(validate(full), full);
  const unsourcedScreening = structuredClone(full);
  unsourcedScreening.market.purchaseScreening[0].sourceId = "unknown";
  assert.throws(() => validate(unsourcedScreening), /purchase screening requires a declared sourceId/);
  const invalidAllocation = await fixture("owner-occupancy-30-70.json");
  invalidAllocation.assumptions.occupancyFraction = 1;
  assert.throws(() => validate(invalidAllocation), /occupancyFraction 0.3/);
  const lease = await fixture("lease-only.json");
  lease.properties.push({ id: "stale-purchase", name: "Stale example" });
  lease.sections.push({
    id: "purchases",
    label: "Purchases",
    title: "Purchase options",
    visible: true,
  });
  assert.throws(() => validate(lease), /cannot include purchase records/);
  const shared = await fixture("owner-occupancy-30-70.json");
  shared.feedback = {
    mode: "shared",
    endpoint: "https://example.test/api/selection",
  };
  assert.throws(() => validate(shared), /same-origin endpoint/);
  shared.feedback.endpoint = "/api/selection";
  assert.equal(validate(shared), shared);
  const unsafeColors = structuredClone(shared);
  unsafeColors.brand.orange = "#bead11";
  assert.throws(() => validate(unsafeColors), /fixed to CARR/);
});

test("financial controls and demographic evidence fail closed on incomplete inputs", async () => {
  const data = await fixture("owner-occupancy-30-70.json");
  const zeroStep = structuredClone(data);
  zeroStep.strategy.tiRange.step = 0;
  assert.throws(() => validate(zeroStep), /tiRange/);
  const excessiveOptions = structuredClone(data);
  excessiveOptions.strategy.tiRange = {min: 0, max: 500, step: 1};
  excessiveOptions.strategy.tiContributionPerSf = 50;
  assert.throws(() => validate(excessiveOptions), /tiRange/);
  const missingGeography = structuredClone(data);
  missingGeography.demographics.geography.label = "";
  assert.throws(() => validate(missingGeography), /geography/);
  const missingPeriod = structuredClone(data);
  missingPeriod.demographics.income.period = "";
  assert.throws(() => validate(missingPeriod), /period/);
  const unlinkedCard = structuredClone(data);
  unlinkedCard.demographics.income.sourceId = "missing-source";
  assert.throws(() => validate(unlinkedCard), /sourceId/);
  const unsafeURL = structuredClone(data);
  unsafeURL.sources[0].url = "javascript:alert(1)";
  assert.throws(() => validate(unsafeURL), /HTTPS URL/);
});

test("local assets are copied by content hash and cannot escape the input directory", async () => {
  const root = await makeTemp();
  const data = await fixture("owner-occupancy.json");
  const bytes = Buffer.from("synthetic image bytes");
  await fs.writeFile(path.join(root, "example.jpg"), bytes);
  data.properties[0].image = "example.jpg";
  const input = path.join(root, "input.json");
  const output = path.join(root, "site");
  await fs.writeFile(input, JSON.stringify(data));
  await build(input, output);
  const stored = JSON.parse(
    await fs.readFile(path.join(output, "presentation.json"), "utf8"),
  );
  assert.match(stored.properties[0].image, /^media\/[a-f0-9]+\.jpg$/);
  assert.deepEqual(
    await fs.readFile(path.join(output, stored.properties[0].image)),
    bytes,
  );
  assert.ok(!JSON.stringify(stored).includes("example.jpg"));

  const escape = await fixture("owner-occupancy.json");
  escape.properties[0].image = "../outside.jpg";
  assert.doesNotThrow(() => validate(escape)); // Build enforces local asset containment.
  const escapeInput = path.join(root, "escape.json");
  await fs.writeFile(escapeInput, JSON.stringify(escape));
  await assert.rejects(
    build(escapeInput, path.join(root, "escape-site")),
    /stay inside the input directory/,
  );
});

test("dangerous markup is inert in generated data", async () => {
  const root = await makeTemp();
  const data = await fixture("owner-occupancy.json");
  data.presentation.preparedFor = "<script>synthetic()</script>";
  const input = path.join(root, "input.json");
  const output = path.join(root, "site");
  await fs.writeFile(input, JSON.stringify(data));
  await build(input, output);
  const js = await fs.readFile(path.join(output, "data.js"), "utf8");
  assert.ok(!js.includes("<script>"));
  const context = { window: {} };
  vm.runInNewContext(js, context);
  assert.equal(
    context.window.PresentationData.presentation.preparedFor,
    data.presentation.preparedFor,
  );
});

test("asset paths cannot escape through a symlinked parent directory", async (t) => {
  const root = await makeTemp();
  const outside = await makeTemp();
  await fs.writeFile(path.join(outside, "synthetic.jpg"), "synthetic outside bytes");
  try {
    await fs.symlink(outside, path.join(root, "alias"), "dir");
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) return t.skip("symlink creation unavailable");
    throw error;
  }
  const data = await fixture("owner-occupancy.json");
  data.properties[0].image = "alias/synthetic.jpg";
  const input = path.join(root, "input.json");
  await fs.writeFile(input, JSON.stringify(data));
  await assert.rejects(build(input, path.join(root, "site")), /resolves outside/);
});

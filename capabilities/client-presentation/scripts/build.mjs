import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import "../assets/site/finance.js";
import "../assets/site/demographics.js";

const skillRoot = fileURLToPath(new URL("..", import.meta.url));
const validSections = new Set([
  "home",
  "leases",
  "purchases",
  "strategy",
  "demographics",
  "sources",
  "feedback",
]);
const ownershipModes = new Set(["owner_occupancy", "owner_occupancy_30_70"]);
const requiredAssumptions = [
  "occupancyFraction",
  "downPaymentFraction",
  "annualInterest",
  "amortizationYears",
  "holdYears",
  "annualAppreciation",
  "annualRentPerSf",
  "collectionLoss",
  "fillMonths",
  "practiceBuildoutPerSf",
];
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const text = (value, label) => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} requires nonempty text`);
  }
};
const httpsUrl = (value, label) => {
  if (value == null) return;
  if (typeof value !== "string") throw new Error(`${label} must be an HTTPS URL`);
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${label} must be an HTTPS URL`); }
  if (parsed.protocol !== "https:" || !parsed.hostname) throw new Error(`${label} must be an HTTPS URL`);
};
const itemArrays = (data) => [
  ["property", data.properties],
  ["lease", data.leases],
  ["development", data.developments],
];

export function validate(data) {
  if (!data || data.schemaVersion !== 2) {
    throw new Error("schemaVersion must be 2");
  }
  text(data.brand?.name, "brand.name");
  text(data.brand?.descriptor, "brand.descriptor");
  for (const key of ["navy", "orange"]) {
    if (
      typeof data.brand[key] !== "string" ||
      !/^#[0-9a-f]{6}$/i.test(data.brand[key])
    ) throw new Error(`brand.${key} must be a six-digit hex color`);
  }
  if (data.brand.navy.toLowerCase() !== "#002f6c" || data.brand.orange.toLowerCase() !== "#f57f29") {
    throw new Error("brand colors are fixed to CARR navy and orange");
  }
  if (data.brand.logo != null) text(data.brand.logo, "brand.logo");
  text(data.presentation?.title, "presentation.title");
  text(data.presentation?.preparedFor, "presentation.preparedFor");
  text(data.presentation?.scenarioDate, "presentation.scenarioDate");
  text(data.presentation?.summary, "presentation.summary");
  if (typeof data.presentation.fictional !== "boolean") {
    throw new Error("presentation.fictional must be boolean");
  }
  const mode = data.strategy?.mode;
  if (
    !["owner_occupancy", "owner_occupancy_30_70", "lease_only"].includes(mode)
  ) {
    throw new Error(
      "strategy.mode must be owner_occupancy, owner_occupancy_30_70, or lease_only",
    );
  }
  for (
    const key of ["properties", "leases", "developments", "sources"]
  ) {
    if (!Array.isArray(data[key])) throw new Error(`${key} must be an array`);
  }
  if (!data.market || typeof data.market !== "object") {
    throw new Error("market study is required");
  }
  text(data.market.title, "market.title");
  text(data.market.summary, "market.summary");
  const sections = new Map();
  for (const section of data.sections || []) {
    if (!validSections.has(section.id) || sections.has(section.id)) {
      throw new Error(`invalid or duplicate section ${section.id}`);
    }
    text(section.label, "section.label");
    text(section.title, "section.title");
    sections.set(section.id, section);
  }
  const visible = (id) =>
    sections.get(id)?.visible !== false && sections.has(id);
  if (!visible("home") || !visible("sources")) {
    throw new Error("home and sources sections are required");
  }
  if (visible("demographics") && !data.demographics) {
    throw new Error("visible demographics require a research model");
  }
  const ids = new Set();
  for (const [kind, items] of itemArrays(data)) {
    if (!Array.isArray(items)) throw new Error(`${kind}s must be an array`);
    for (const item of items) {
      if (
        !item || typeof item.id !== "string" ||
        !/^[a-zA-Z][\w-]*$/.test(item.id) || ids.has(item.id)
      ) throw new Error(`invalid or duplicate item ID ${item?.id}`);
      ids.add(item.id);
      text(item.name, `${item.id}.name`);
      if (item.details != null) {
        if (!Array.isArray(item.details)) throw new Error(`${item.id}.details must be labeled facts`);
        for (const detail of item.details) {text(detail.label, `${item.id}.detail label`);text(detail.value, `${item.id}.detail value`);}
      }
      httpsUrl(item.publicUrl, `${item.id}.publicUrl`);
      httpsUrl(item.leaseUrl, `${item.id}.leaseUrl`);
      if (kind === "lease") {
        if (item.totalSf != null && (!Number.isInteger(item.totalSf) || item.totalSf < 1)) {
          throw new Error(`${item.id} totalSf must be a positive integer or null`);
        }
        if (item.rentPerSf != null && (!finite(item.rentPerSf) || item.rentPerSf < 0)) {
          throw new Error(`${item.id} rentPerSf must be nonnegative or null`);
        }
      }
      if (item.locator != null) {
        if (
          item.locator.kind !== "approximate" || !finite(item.locator.lon) ||
          item.locator.lon < -180 || item.locator.lon > 180 ||
          !finite(item.locator.lat) || item.locator.lat < -90 ||
          item.locator.lat > 90
        ) {
          throw new Error(
            `${item.id} locator must contain verified approximate longitude and latitude`,
          );
        }
        text(item.locator.sourceId, `${item.id}.locator.sourceId`);
      }
      if (
        item.parkingSpaces != null &&
        (!finite(item.parkingSpaces) || item.parkingSpaces < 0)
      ) {
        throw new Error(
          `${item.id} parkingSpaces must be a nonnegative number or null`,
        );
      }
    }
  }
  if (data.properties.length && !visible("purchases")) {
    throw new Error("purchase records require a visible purchases section");
  }
  if (data.leases.length && !visible("leases")) {
    throw new Error("lease records require a visible leases section");
  }
  if (!data.leases.length && visible("leases")) {
    throw new Error("omit leases section when no lease options exist");
  }
  if (!data.properties.length && visible("purchases")) {
    throw new Error("omit purchases section when no purchase options exist");
  }
  if (!data.feedback || !["disabled", "shared"].includes(data.feedback.mode)) {
    throw new Error("feedback.mode must be disabled or shared");
  }
  if (!visible("feedback")) {
    throw new Error("feedback status section must remain visible");
  }
  if (
    data.feedback.mode === "shared" &&
    (!data.properties.length && !data.leases.length || typeof data.feedback.endpoint !== "string" ||
      !/^\/(?!\/)[a-zA-Z0-9/_-]+$/.test(data.feedback.endpoint))
  ) {
    throw new Error(
      "shared feedback requires property records and a same-origin endpoint path",
    );
  }
  if (data.feedback.mode === "disabled" && data.feedback.endpoint != null) {
    throw new Error("disabled feedback must not configure an endpoint");
  }

  if (mode === "lease_only") {
    if (
      data.properties.length || data.assumptions || visible("purchases") ||
      visible("strategy")
    ) {
      throw new Error(
        "lease_only mode cannot include purchase records, assumptions, purchases, or strategy views",
      );
    }
    if (!data.leases.length || !visible("leases")) {
      throw new Error(
        "lease_only mode requires lease options and a leases section",
      );
    }
  } else {
    if (
      !data.properties.length || !visible("purchases") ||
      (mode === "owner_occupancy_30_70" && (!visible("strategy") || !data.assumptions))
    ) {
      throw new Error(
        `${mode} requires purchase options and a purchases section; 30/70 requires a strategy section and explicit assumptions`,
      );
    }
    if (data.assumptions) {
      for (const field of requiredAssumptions) {
        if (!finite(data.assumptions[field])) {
          throw new Error(`assumptions.${field} must be a finite number`);
        }
      }
      const requiredAllocation = mode === "owner_occupancy" ? 1 : 0.3;
      if (data.assumptions.occupancyFraction !== requiredAllocation) {
        throw new Error(
          `${mode} requires occupancyFraction ${requiredAllocation}`,
        );
      }
    }
    if (data.assumptions && (
      !finite(data.strategy.tiContributionPerSf) ||
      data.strategy.tiContributionPerSf < 0
    )) {
      throw new Error(
        "strategy.tiContributionPerSf must be explicit and nonnegative",
      );
    }
    if (mode === "owner_occupancy_30_70") {
      const range = data.strategy.tiRange;
      if (!range || !finite(range.min) || !finite(range.max) || !finite(range.step) ||
          range.min < 0 || range.max < range.min || range.step <= 0 ||
          range.max > 500 || (range.max - range.min) % range.step !== 0 ||
          (range.max - range.min) / range.step > 20 ||
          data.strategy.tiContributionPerSf < range.min || data.strategy.tiContributionPerSf > range.max ||
          (data.strategy.tiContributionPerSf - range.min) % range.step !== 0) {
        throw new Error("strategy.tiRange must be finite, bounded, positive-step, and include the selected TI contribution");
      }
    }
    for (const property of data.properties) {
      if (!finite(property.price) || property.price < 0) {
        throw new Error(`${property.id} requires a nonnegative price`);
      }
      if (!Number.isInteger(property.totalSf) || property.totalSf < 1) {
        throw new Error(`${property.id} totalSf must be a positive integer`);
      }
      if (data.assumptions) globalThis.PresentationFinance.compute(
          { price: property.price, totalSf: property.totalSf },
          data.assumptions,
          data.strategy.tiContributionPerSf,
        );
    }
  }

  if (visible("strategy") && mode !== "owner_occupancy_30_70") throw new Error("Strategy is only available for explicitly configured 30/70 ownership");
  if (!data.presentation.fictional && !data.sources.length) throw new Error("client presentations require sources");
  const sourceIds = new Set();
  for (const source of data.sources) {
    text(source.id, "source.id");
    if (sourceIds.has(source.id)) {
      throw new Error(`duplicate source ID ${source.id}`);
    }
    sourceIds.add(source.id);
    text(source.title, "source.title");
    text(source.date, "source.date");
    httpsUrl(source.url, `${source.id}.url`);
  }
  if (data.market.purchaseScreening != null) {
    if (!Array.isArray(data.market.purchaseScreening) || !data.market.purchaseScreening.length) throw new Error("market.purchaseScreening requires sourced criteria");
    for (const criterion of data.market.purchaseScreening) {
      text(criterion.label, "purchase screening label");
      text(criterion.description, "purchase screening description");
      if (!sourceIds.has(criterion.sourceId)) throw new Error("purchase screening requires a declared sourceId");
    }
  }
  if (data.currentPractice != null) {
    const current = data.currentPractice;
    text(current.name, "currentPractice.name");
    text(current.location, "currentPractice.location");
    text(current.description, "currentPractice.description");
    text(current.sourceId, "currentPractice.sourceId");
    if (!current.locator || current.locator.kind !== "approximate" ||
        !finite(current.locator.lat) || current.locator.lat < -90 || current.locator.lat > 90 ||
        !finite(current.locator.lon) || current.locator.lon < -180 || current.locator.lon > 180) {
      throw new Error("currentPractice requires an approximate locator");
    }
    text(current.locator.sourceId, "currentPractice.locator.sourceId");
    if (!sourceIds.has(current.sourceId) || !sourceIds.has(current.locator.sourceId)) {
      throw new Error("currentPractice and its locator require matching sources");
    }
  }
  if (data.demographics) {
    globalThis.PresentationDemographics.validate(data.demographics, data.sources);
    for (const card of data.demographics.cards || []) httpsUrl(card.url, "demographic card.url");
  }
  if (!data.presentation.fictional) {
    for (const [kind, items] of itemArrays(data)) {
      for (const item of items) {
        if (!item.sourceId || !sourceIds.has(item.sourceId)) {
          throw new Error(`${item.id} ${kind} requires a matching sourceId`);
        }
        if (item.image == null) {
          text(item.noPhotoReason, `${item.id}.noPhotoReason`);
        }
        if (item.locator == null) {
          text(item.noPinReason, `${item.id}.noPinReason`);
        } else if (
          item.locator.kind !== "approximate" ||
          !sourceIds.has(item.locator.sourceId)
        ) {
          throw new Error(
            `${item.id} locator requires source-backed approximate coordinates`,
          );
        }
      }
    }
    if (data.locator?.sourceId && !sourceIds.has(data.locator.sourceId)) {
      throw new Error("locator base sourceId must match a declared source");
    }
    if (data.locator?.center) {
      const { lat, lon, sourceId } = data.locator.center;
      if (
        !finite(lat) || lat < -90 || lat > 90 || !finite(lon) || lon < -180 ||
        lon > 180
      ) throw new Error("locator center must use valid latitude and longitude");
      if (sourceId && !sourceIds.has(sourceId)) {
        throw new Error("locator center sourceId must match a declared source");
      }
      if (!data.presentation.fictional && !data.locator.style) {
        throw new Error(
          "client maps require an explicitly configured MapLibre style",
        );
      }
    }
    if (
      data.locator?.style && typeof data.locator.style === "string" &&
      !/^https:\/\//i.test(data.locator.style)
    ) throw new Error("MapLibre style URL must use HTTPS");
    if (
      data.locator?.style && typeof data.locator.style === "object" &&
      data.locator.style.version !== 8
    ) throw new Error("inline MapLibre style must use version 8");
    if (data.developments.length && !data.locator) {
      throw new Error(
        "client development map requires a locator configuration",
      );
    }

  }
  return data;
}

const allowedExtension = (key, ext) =>
  ["reportPath", "floorplan"].includes(key)
    ? ext === ".pdf"
    : [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext);
async function rewriteLocalAssets(data, inputDir, outputDir) {
  const root = path.resolve(inputDir);
  const realRoot = await fs.realpath(root);
  async function visit(value) {
    if (!value || typeof value !== "object") return;
    for (const [key, candidate] of Object.entries(value)) {
      if (
        ["image", "logo", "backgroundImage", "reportPath", "floorplan"]
          .includes(key) && typeof candidate === "string" && candidate
      ) {
        if (/^https:\/\//i.test(candidate)) continue;
        if (/^(?:[a-z][a-z\d+.-]*:|\/|\\|\/\/)/i.test(candidate)) {
          throw new Error(
            `${key} must be a relative path inside the input directory or an HTTPS URL`,
          );
        }
        const source = path.resolve(root, candidate);
        const relative = path.relative(root, source);
        if (
          !relative || relative.startsWith(`..${path.sep}`) ||
          relative === ".." || path.isAbsolute(relative)
        ) throw new Error(`${key} must stay inside the input directory`);
        const realSource = await fs.realpath(source);
        const realRelative = path.relative(realRoot, realSource);
        if (
          !realRelative || realRelative.startsWith(`..${path.sep}`) ||
          realRelative === ".." || path.isAbsolute(realRelative)
        ) throw new Error(`${key} resolves outside the input directory`);
        const ext = path.extname(realSource).toLowerCase();
        if (!allowedExtension(key, ext)) {
          throw new Error(`unsupported ${key} extension ${ext}`);
        }
        if ((await fs.lstat(source)).isSymbolicLink()) {
          throw new Error("asset symlinks are not copied");
        }
        const bytes = await fs.readFile(realSource);
        const filename = `${
          createHash("sha256").update(bytes).digest("hex").slice(0, 16)
        }${ext}`;
        await fs.mkdir(path.join(outputDir, "media"), { recursive: true });
        await fs.writeFile(path.join(outputDir, "media", filename), bytes);
        value[key] = `media/${filename}`;
      } else {
        await visit(candidate);
      }
    }
  }
  await visit(data);
}

export async function build(inputPath, outputPath) {
  const input = path.resolve(inputPath);
  const output = path.resolve(outputPath);
  const data = validate(JSON.parse(await fs.readFile(input, "utf8")));
  await fs.mkdir(output, { recursive: false });
  const siteDir = path.join(skillRoot, "assets/site");
  for (
    const filename of [
      "index.html",
      "styles.css",
      "carr-logo.png",
      "finance.js",
      "demographics.js",
      "selection-adapter.js",
      "app.js",
    ]
  ) {
    await fs.copyFile(
      path.join(siteDir, filename),
      path.join(output, filename),
    );
  }
  await rewriteLocalAssets(data, path.dirname(input), output);
  const serialized = JSON.stringify(data, null, 2);
  await fs.writeFile(path.join(output, "presentation.json"), `${serialized}\n`);
  await fs.writeFile(
    path.join(output, "data.js"),
    `window.PresentationData = ${
      JSON.stringify(data).replace(/</g, "\\u003c").replace(
        /\u2028/g,
        "\\u2028",
      ).replace(/\u2029/g, "\\u2029")
    };\n`,
  );
  return path.join(output, "index.html");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error(
      "Usage: node scripts/build.mjs INPUT.json NEW_OUTPUT_DIRECTORY",
    );
    process.exitCode = 1;
  } else {
    try {
      console.log(await build(input, output));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

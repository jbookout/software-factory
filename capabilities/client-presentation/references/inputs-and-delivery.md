# Inputs and Delivery

## Portable use

Any file-capable agent can read this folder's `SKILL.md`; native skill installation is optional. Node 20.19 or newer runs the build and calculation helpers with no third-party dependencies. The emitted website runs independently of this skill and the software factory. Copy the complete folder into an agent's supported skill directory, or attach the ZIP and instruct the agent to read its entrypoint. Do not edit an installed template in place to create a client deliverable.

`assets/site/presentation.json` is a fictional worked example and the configuration reference. `scripts/build.mjs` generates the runtime `data.js` from it; edit the JSON, not both files. Use a fresh output directory. Retain `index.html`, `styles.css`, `app.js`, `finance.js`, `data.js` and referenced `media/` files together.

## Input shape

| Field | Content |
|---|---|
| schemaVersion | 1 |
| brand | name, descriptor, orange and navy colors; adapt the copied header for a permitted logo when needed |
| presentation | title, preparedFor, scenarioDate, fictional flag; set fictional false for client use |
| sections | Objects with stable id, label and title; IDs home, leases, purchases, strategy, demographics, sources |
| metrics | Growth percentage value, suffix, label, note and optional trend; note names period/geography/source |
| properties | Purchase records: unique id, name, location, description, integer totalSf, price, image, sourceId; optional parkingSpaces and verified locator |
| leases | Lease records: unique id, name, location/subtitle, areaSf, annualRentPerSf, structure, planningNote, image, sourceId; optional parkingSpaces/locator |
| locator | Basemap image, matching sourceId, label and disclaimer; normalized coordinates must match this image |
| developments | Project records: unique id, name, location, description, status, image, sourceId and optional locator/propertyId |
| assumptions | Financial input fields listed in financial-model.md; these are scenario inputs, not listing facts |
| demographics | Study title, baseYear, years/index for the sample chart and questions; adapt to source report's metrics/radii, never retain fictional series |
| sources | Objects with id, title, url, date, geography and notes; item sourceId must match one |

IDs are globally unique across properties, leases and developments. Use the same record in all views. The starter calculates all purchase records; for mixed owner/investor strategies, adapt the copied template to designate eligible records before calculating. Omit unknown fields or display them as unverified; zero is a measured value.

The demonstration locator uses normalized x/y in 0–100. These numbers are visual coordinates, not latitude/longitude. For a client locator, the agent must replace the schematic with a permitted basemap and derive markers from verified coordinates using that map's projection and bounds, or implement the current interactive map contract. Verify map/list/table parity after changes. Do not transform the sample's decorative streets into claimed roadway access.

## Research and assets

Read raw listing and demographic reports. Keep available SF distinct from total building SF; price distinct from rent; annual rent distinct from monthly rent; parking spaces distinct from parking per 1,000 SF. Listing data needs an as-of date. Market statistics need exact geography, vintage, observed/projected status and source link. Income and population detail belong on Demographics; Home summarizes growth and development impact.

Use local PNG/JPEG/WebP/GIF images or HTTPS image URLs. The build copies only explicitly referenced local `image`, `backgroundImage`, `logo`, and PDF `reportPath` fields into `media/`, rewriting paths. Rasterize permitted SVGs before adding them; the sample's generated SVG illustrations are explicitly fictional. Remote images remain internet dependent. Copy permitted images locally when offline delivery matters. A link does not grant reuse rights.

## Delivery modes

- **Browser package:** ZIP the generated directory, then extract and open a separate copy. Email recipients download and extract before opening index.html in a browser. Email HTML preview/sanitization can strip scripts; do not ask clients to run the site inside their email application.
- **Single HTML:** Inline CSS, JS and allowed image bytes when requested; verify that standalone artifact independently. Relative PDFs still need packaging or hosting.
- **PDF:** Use a rendering tool and print layout; show relevant sections, remove hover-only dependency, and inspect every page. PDF loses interactive TI selectors, dialogs and charts; include explicit scenario snapshots.
- **Hosted link:** Use an authorized hosting destination and new project/client path. Verify the final HTTPS URL, root and deep links, assets, alternate origins, and permissions. An existing project's credentials/domain do not transfer with this skill. Do not send email or publish merely because a presentation was built.
- **Restricted link:** Use a server-side gate or approved access provider. Never hardcode a password in HTML/JS, assume a random slug is private, or protect only the main HTML while leaving PDFs/origin public. Keep session/content secrets outside source, and verify wrong/correct access on all entry points.

This package does not provision hosting, write DNS, choose passwords, send client messages, or claim lender approval. Those are separate authorized effects with their own delivery verification.

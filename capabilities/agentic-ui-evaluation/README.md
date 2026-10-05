# Agentic UI evaluation (TesterArmy e2e wrapper)

Status: **deterministic web wrapper qualified; attended model evaluation pending.**
The wrapper remains non-blocking. This wraps
[TesterArmy e2e](https://github.com/tester-army/e2e) for Design Manager slice 4
under the [plan](../../docs/design-manager/plan.md#prove-agentic-ui-evaluation-slice-4-reused-in-910).
Pin: package `e2e@0.16.0`, studied source revision
`a0ee3e9061b666fa3dd43e7dcc8e1a5da47362d6`, Apache-2.0
([license](https://github.com/tester-army/e2e/blob/a0ee3e9061b666fa3dd43e7dcc8e1a5da47362d6/LICENSE)).
No upstream code is copied here. Only the disposable qualification fixture
installs e2e, with a separate lockfile. Products keep their own dependencies.

## Ownership

The product owns e2e as a development dependency, plus its lockfile,
`e2e.config.ts`, fixtures, scripts and baseline expectations. The product runner
supplies normalized run receipts. [`wrapper.mjs`](wrapper.mjs) only:

- forces `E2E_TELEMETRY_DISABLED=1` for run, explore, bug bash, MCP and replay
  (`e2eEnvironment`);
- blocks model-backed runs unless they are attended and the credential is
  healthy (`attendedEvaluationStatus`), offering one login action;
- counts a finding only when its repro fails with an assertion on the exact
  candidate, and keeps discarded and rejected candidates for audit
  (`triageFindings`);
- qualifies the wrapper against a frozen defect manifest with traps, a separately
  repaired build, a zero-provider-call deterministic replay and archived evidence
  (`qualifyAgenticEvaluation`).

All e2e critique is labelled `simulated-critique`. Accessibility output is
heuristic only, so e2e never certifies WCAG. Criterion acceptance stays with
`software-factory/design-verify`, which accepts `e2e@0.16.0` engine runs on the
exact build and nothing else.

## Authentication and publication

Agent steps use e2e's supported ChatGPT OAuth provider (`e2e/oauth/chatgpt`) on
Joe's subscription, never Claude, and never an API-key fallback. The OAuth file
stays at `~/.config/e2e/oauth.json` (or the XDG equivalent), outside every
repository and cloud task. Do not copy it anywhere. The wrapper refuses health
input that contains credential fields. Unattended tasks wait at a blocked
attended-evaluation checkpoint. The GitHub PR-comment reporter stays off unless
a repository explicitly enables it with authorized publication.

## Qualification and version changes

The [0.16.0 changelog](https://github.com/tester-army/e2e/blob/a0ee3e9061b666fa3dd43e7dcc8e1a5da47362d6/packages/e2e/CHANGELOG.md)
and affected telemetry, matcher, OAuth, MCP and report source were studied.
The old source revision already contained unreleased 0.15.2 changes while the
wrapper named package 0.15.1. The package and studied release now agree.

- MCP and explore gained telemetry events. `e2eEnvironment` still forces the opt-out for every mode.
- Locator matchers now honor false state flags and `ignoreCase`, and reject unknown options. The refusal and permission traps exercise false flags.
- `toBeDefined()` changed in 0.15.2 to accept null. The fixture uses explicit text/count/state assertions.
- ChatGPT model discovery now identifies as Codex CLI 0.160.0. Model IDs still need attended account discovery.
- MCP now supports deterministic projects without `ai`, using the split MCP SDK. This does not qualify a live MCP session or model exploration.
- Secret redaction expanded and provider failures preserve unconfirmed cache recordings. No secret or model cache is used by this fixture.

[`qualify.mjs`](qualify.mjs) runs the published e2e CLI in Chromium with a frozen
[manifest](fixture/manifest.json), separate broken/repaired HTML builds and the
same digest-bound repro suite. `normalizeE2eReport` reads actual `report-1`
results, accepts only runner 0.16.0, and distinguishes body `ASSERTION_FAILED`
from login, engine, timeout and other tool failures. The harness validates the
report against the installed upstream schema. Every trap must be exercised
passing on broken, repaired and replay builds. Skips and retries cannot pass.
Passing traps remain in `trapRuns`; only failed or blocked results become findings.

Run all four steps in order; all are required:

1. Install the root dependencies with `npm ci`.
2. Install the fixture with `npm ci --prefix capabilities/agentic-ui-evaluation/fixture`.
3. Install Chromium with `npx --no-install playwright install chromium` from that fixture.
4. Run `npm run e2e:qualify` from the repository root.

Exact fixture pins are e2e 0.16.0, @e2e-dev/web 0.11.2 and Playwright 1.63.0.
Node 22.12 or newer and Python 3 are required. Hosted CI runs the same command
and uploads `fixture/.qualification/` as the qualification evidence artifact.
The JSON receipt includes build, manifest, suite and lock digests, outcomes,
runtime, provider counts and archived evidence digests. Archives persist under
the ignored fixture directory. The gate rereads all archived bytes after
removing disposable output, with a bounded 60-second aggregate archive deadline.

Replay here executes the recorded deterministic repro suite again on the broken
build. It proves scripted assertion replay, not agent cache effectiveness.
No AI SDK or model is configured. An inherited preload counts and rejects
external fetch attempts and TCP socket connections in the CLI and workers,
including HTTP(S), HTTP/2, TLS and undici. The socket guard checks the effective
target after HTTP option merging and validates resolved loopback addresses;
provider invocations must be zero. The fixture server and browser use only
loopback requests. Each test gets its own browser context and the three runs
use separate servers/state.

Still unverified: attended ChatGPT login, account model/usage, expiry alarm and
recovery, agent-generated repros, explore/bug-bash, live MCP transport, and
mobile. They remain at the attended-evaluation checkpoint. Deterministic success
does not qualify those routes or prove target-user outcomes. The login action is
`npm --prefix capabilities/agentic-ui-evaluation/fixture run login`, executed by
Joe; it sets the telemetry opt-out and uses the pinned CLI without API fallback.
Credential health checks may inspect presence and supplied expiry metadata only.
Do not open the OAuth file to obtain expiry, or invoke a provider to probe it.

`test/acceptance/agentic-ui-evaluation.test.mjs` exercises the rules with
synthetic receipts and report normalization. The executable fixture supplies
the separate deterministic qualification receipt.

## Escape and removal

No product build, test or runtime depends on this directory. To remove it,
delete this directory, its acceptance test and the qualification CI job;
product-local checks keep running. Removing the fixture dependency has no effect
on product build, test or runtime. Model execution remains an attended exception,
so this change adds no daily authentication dependency to unattended factory work.

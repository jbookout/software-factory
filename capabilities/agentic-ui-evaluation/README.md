# Agentic UI evaluation (TesterArmy e2e wrapper)

Status: **non-blocking pilot, not qualified.** This wraps
[TesterArmy e2e](https://github.com/tester-army/e2e) for Design Manager slice 4
under the [plan](../../docs/design-manager/plan.md#prove-agentic-ui-evaluation-slice-4-reused-in-910).
Pin: package `e2e@0.15.1`, studied source revision
`8d38206f460415b70706b45acb820bb0e24832ae`, Apache-2.0
([license](https://github.com/tester-army/e2e/blob/8d38206f460415b70706b45acb820bb0e24832ae/LICENSE)).
No upstream code is copied here, and this repository does not install e2e.

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
`software-factory/design-verify`, which accepts `e2e@0.15.1` engine runs on the
exact build and nothing else.

## Authentication and publication

Agent steps use e2e's supported ChatGPT OAuth provider (`e2e/oauth/chatgpt`) on
Joe's subscription, never Claude, and never an API-key fallback. The OAuth file
stays at `~/.config/e2e/oauth.json` (or the XDG equivalent), outside every
repository and cloud task. Do not copy it anywhere. The wrapper refuses health
input that contains credential fields. Unattended tasks wait at a blocked
attended-evaluation checkpoint. The GitHub PR-comment reporter stays off unless
a repository explicitly enables it with authorized publication.

## Not yet verified

- The mapping from e2e 0.15.1's actual report and repro files to these
  normalized receipts. Upstream report formats were not readable from this
  session, so the field names here are the factory's own contract.
- Joe's ChatGPT OAuth login, the exact account model, usage, and expired-token
  recovery for this third-party use.
- A live qualification run: planted defects caught, traps clean, repaired build
  passing, zero-call replay, and the same fixture's local and hosted-CI receipts.

`test/acceptance/agentic-ui-evaluation.test.mjs` exercises the rules with
synthetic receipts only. Those tests are not a qualification receipt.

## Escape and removal

No product build, test or runtime depends on this directory. To remove it,
delete this directory and its acceptance test; product-local checks keep running.

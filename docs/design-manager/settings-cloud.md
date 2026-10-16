# User settings and cloud qualification

Slice 3 supplies configuration resolution and a conservative qualification
harness. It does not dispatch stations, approve gates or certify a background
runtime. The [slice-3 acceptance criteria](plan.md#ordered-slices-and-verification)
still require account, lifecycle and laptop-off evidence.

```text
private settings JSON → schema + route checks → frozen assignment/version/digest
                                              ↓
                                    synthetic cloud CLI probes
                                              ↓
                                  private receipt + blocked checks
```

## Configuration interface

`software-factory/design-settings` exports `loadDesignSettings`,
`resolveDesignSettings` and `resolveDesignAssignment`. The default private file is
`~/.config/software-factory/design-manager/settings.json`. Use the
[Joe example](../../config/design-manager/joe.example.json) as an editable starting
profile. It is configuration intent, not account discovery or entitlement proof.
Non-Codex model placeholders must be replaced after qualification.

The [schema](../../schemas/design-settings.schema.json) rejects unknown fields,
credentials, missing stations/modes and unknown providers/routes. Each station
names its worker allocations and purposes. Workers supply model, effort,
concurrency, declared availability and allowed routes. Modes override model/effort
for existing workers; they cannot add a provider, change a route, weaken a rubric
or grant spending/acceptance authority. Unspecified worker overrides retain that
worker's configured model/effort. Selecting an unavailable worker stays visible;
it never selects another provider.

Resolved snapshots are deeply frozen and detached from the input. Key ordering
and whitespace do not change the settings digest. Intake/run callers retain the
user ID, version and digest with each assignment. Changes apply to new snapshots;
historical receipts keep their original binding. Assignment resolution remains
separate from execution authorization and the later independent-review gate.

## Qualification interface

Run `npm run design-cloud:qualify -- --help` for the supported flags. The CLI uses
the configured Define work allocation in Fast mode unless another mode is supplied.
Pass `--settings` to select a private profile. `--state` selects a private receipt
outside every Git checkout, in a user-owned mode-700 directory; otherwise the CLI
creates one under
`~/.local/share/software-factory/design-manager/qualifications/`. The receipt binds
the settings selection and the executing factory checkout's source revision,
regardless of the invoking directory. The execution module rejects unknown request
fields, incomplete selections and source IDs other than exact SHA-1/SHA-256 IDs.
It captures a detached frozen request before asynchronous work starts.
Exit 2 means unqualified;
exit 1 means invalid input or a harness failure. Offline acceptance runs in
`npm test` and directly through the two `test/acceptance/` slice-3 test files.

The harness authenticates with the existing ChatGPT login, omits API-key and
unrelated environment variables, probes CLI help/task listing, and attempts one
finite synthetic sum task. Without a selected environment, submission records the
CLI's missing `--env` refusal. With an environment, pass both `--environment-id`
and `--branch`; the caller must inspect that it is private, factory-only and
contains only `jbookout/software-factory`, no product data, credentials or outbound
identity. The CLI cannot attest environment ownership from an ID. No environment
is invented or selected from an unrelated task. No diff is applied locally.

Receipts include task ID, requested model/effort, probe exit/deadline/latency,
observations, checked synthetic result bytes and explicit missing facts. Raw CLI
diagnostics and task-list titles/bodies are omitted. Only allowlisted observations
and a validated CLI version are retained. Result checks require an unambiguous
leading READY status and a complete new regular-file unified diff for the sum
artifact. Reconstructed bytes retain final-newline semantics and bind the artifact
digest. Modifications, symlinks, additional files and unsupported diff shapes are
refused; the CLI supplies no base file for reconstruction. Requested config is
never reported as the model/effort
the cloud actually used. Local timeouts kill local subprocess groups only; remote
timeout/cancellation remains unverified. Claude/Dot/Grok dependencies are visibly
blocked until separately qualified. This build prohibits Claude execution.

The current adapter never emits `qualified: true`: CLI help does not establish
resume/cancel, account allowance, actual model/effort, expiry recovery or a
laptop-off result. Those need a supported surface and live evidence before a
future adapter can certify the plan's full row. Cloud task inspection after a
caller restart is separate from steering/resuming the remote task.

Receipts use `codex-cloud-qualification.v2`, are mode 600, atomically replaced
from exclusively created unique temporary files and checksummed. Receipt symlinks,
hard links and directory substitution are refused. Legacy receipts remain audit
artifacts and cannot be resumed by this version; inspect their cloud tasks before
starting a new receipt. No legacy receipt is automatically replayed. The unkeyed
checksum
detects changes against the original digest; it authenticates neither observations
nor the author. A lock refuses concurrent runs. An interrupted unknown submission
never resubmits: inspect cloud tasks first. Reusing the same receipt reads the
known task; changing the bound request is refused. After a process crash, verify
the saved phase, cloud tasks and process ownership before removing a stale lock.
Finished receipts remain historical; start a new receipt for a new qualification.
No persistent factory host/journal or unattended expiry alarm is delivered here.

## Platform references and removal

Official [developer commands](https://learn.chatgpt.com/docs/developer-commands#codex-cloud)
document cloud submission and listing. Official
[cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments)
document web/desktop setup and laptop-asleep execution. These establish the
documented surface, not this account's qualification. The harness records
command arguments, exit/deadline metadata and allowlisted observations privately;
it never retains raw CLI help or diagnostic output.

The harness is an opt-in pilot, not a merge/release/runtime prerequisite. Remove
the two package exports, qualification npm script, CLI and adjacent modules/tests
to retire it; products have no dependency on it. Private receipts/settings can be
retained for audit independently of that removal.

# Entry playbooks and interview

The public `software-factory/design-manager` interface initializes app-agnostic
design work from supplied values. It does not read a product repository, call a
model, authenticate evidence, write a journal or authorize execution. The
[plan](plan.md#ordered-slices-and-verification) defines later store, progress-view,
worker and independent-review slices.

## Interface

```text
startDesignInterview(identity)
             |
   one question + interview snapshot
             |
answerDesignInterview(snapshot, one answer) <--- resumeDesignInterview(snapshot)
             |
   next question, or initialized Intake project + pending requirements
             |
proposeDesignScope(snapshot, proposal)
             |
   explicit scope decision -> new acceptance criterion -> workflow assurance
```

`identity` supplies `projectId`, an exact `sourceRevision` and optional normalized
platform `signals` from a product-owned runner. Each question names the project.
Only the pending question ID can be answered. Unknown and declined answers are
distinct trace events and leave the required question pending. No answer silently
selects Lean or skips required intake. JSON round trips resume the same question.

```js
import { startDesignInterview, answerDesignInterview } from 'software-factory/design-manager'

const first = startDesignInterview({ projectId: 'sample-task-app', sourceRevision: 'a'.repeat(40) })
const next = answerDesignInterview(first.interview, {
  questionId: first.question.id,
  answer: { status: 'answered', value: 'feature' }
})
// next.interview contains the entry answer; next.question asks only about risk.
```

Every operation returns a new snapshot and does not mutate the caller's snapshot.
The caller must save the returned `interview` before displaying its next question.
Slice 2 supplies serializable state and deterministic replay; the durable factory
journal and transactional answer persistence arrive in slice 5. Never substitute
a Markdown project journal or CARR storage. The projection and pending question
do not share mutable references with recorded answers.

## Entry-specific work

| Entry | Supplied artifact inputs | Additional pending artifact and focus |
| --- | --- | --- |
| New product | None beyond common intake | Product brief: users, jobs, outcomes and bounded first version |
| Feature | Existing product contract | Feature delta: additions and protection of adjacent workflows |
| Workflow redesign | Current workflow | Current/proposed flow: owners, states, exceptions and failure history |
| Audit | Built candidate | Severity-ranked findings against declared criteria; no automatic repair authority |
| Design system | Current system | System inventory: tokens, components, themes and accessibility |
| Platform derivation | Source design | Platform mapping: source intent versus native target behavior |
| Concept evaluation | Candidate concepts | Concept comparison: job, alternatives and test questions |
| Post-build refinement | Built candidate, accepted design, operational baseline | Contract/candidate comparison and bounded new refinement version |
| Automation interaction | Authority model | Human/automation authority, refusal, recovery and irreversible consequences |

Common intake captures intent, users, constraints, platforms, included workflows,
exclusions, checkable acceptance criteria, evidence window and version. Required
artifact inputs use slice 1's `ArtifactRef` shape; references and digests are
reported inputs, not proof that bytes were fetched or authenticated. Each workflow
has its own explicit assurance-tier question. Included and excluded workflows
must not overlap. Supplied mobile signals require explicit platform reconciliation.

## Tier and scope rules

The tier question recommends Standard for declared bounded risk and High-Assurance
for consequential or unknown risk. Every choice displays included/omitted work,
effort and protected risks. Lean requires grill, workflow, one/two concepts, owner
testing, accessibility, implementation criteria and post-build review. Standard
adds domain research, alternatives, interactive prototype, task evaluation,
failure states, measurable baseline and decision record. High-Assurance adds
representative users, privacy/threat analysis, formal accessibility, stronger
validation, staged release, monitoring, rollback and independent assurance.

All cumulative tier criteria become pending requirements. A workflow can select
stronger assurance than its project. Its tier choice shows the additional work,
and that work applies to that workflow; choosing a lower workflow tier cannot
weaken the project tier. The selected project tier never changes silently.

After completed intake, a scope proposal names one new workflow and its reason.
The single pending scope question displays before/after scope. Acceptance requires
a separate acceptance-criterion question and then the new workflow's assurance
question. Decline retains scope and records the workflow as deferred refinement.
Excluded work requires a new explicitly bounded intake; it cannot be appended by
an expansion proposal. This interface does not reopen a closed product version.

## Initialized state and inspection

Completion returns a slice-1 schema-valid `DesignProject` at Intake, with empty
handoffs and gates. Lifecycle helpers still allow only adjacent transitions.
`inputs` retains the brief and supplied entry artifacts. `requirements` retains
every checklist's original outputs, rubric and stop, plus entry and tier work.
Each existing gate has a pending comparison requirement, including build-readiness
states for every tier. These requirements are separate from reported gate verdicts.
All requirements remain pending: initialization does not fabricate finished
design artifacts, evidence, gate passes, deployment or acceptance.

Every user-facing criterion carries a requirement for criterion-bound e2e evidence
on the exact built revision, mapped entry points and independent readback for
stored writes. Unit/component-only and direct-driver-only receipts fail that
future check; skipped paths never verify. Declared mobile platforms additionally
require simulator/emulator VERIFY and e2e mobile-engine receipts for each platform.
The existing mobile capability precondition and its failure message remain in
force. This records the post-application requirements; live stack qualification
and acceptance execution remain in their owning later slices.

`inspectDesignInitialization(view)` replays the trace and compares the complete
projection. It rejects incomplete interviews, omitted artifacts or tier work,
batched or altered questions, silent tier defaults, scope drift and fabricated
completion. Its pass means initialization is consistent with recorded answers;
authentication of a human answer and independent evidence judgment are later
responsibilities. Test cases live in `test/design-entry.test.mjs`; `npm test`
runs them with the existing repository suite.

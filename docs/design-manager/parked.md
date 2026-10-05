# Parked Design Manager tools

Joe's 2026-10-01 direction parks these tools until a concrete trigger applies.
This is a capability-placement plan, not a journal or eval record. Joe adopted
pstack/poteto as the engineering framework on 2026-10-04. The remaining tools
are conditional candidates; adoption does not qualify their executable routes.
Sources describe upstream
behavior; fitness, versions, licensing and account access need live qualification
before use.

## Mobile trigger: automatic requirement, not a reminder

All steps are required:

1. Intake records `DesignProject.platforms`: web, ios, android, desktop.
2. The product runner detects react-native, expo, ios/, android/, app.json, SwiftUI usage and .swift source signals.
3. A detected platform absent from intake flags a mismatch and stops advancement until reconciled.
4. Any declared ios/android platform activates the Prove mobile requirement.
5. Without `capabilities/mobile-verification`, the gate fails with the exact message below.
6. Qualify that capability on a sample mobile app before the gate can pass.

```text
mobile verification capability not installed: add capabilities/mobile-verification (e2e mobile engine / agent-device, stim, argent; see docs/design-manager/parked.md)
```

The contract test exercises an iOS project without the capability. Installation
must mean a qualified adapter with a successful fixture receipt, not an empty
directory. Once installed, each declared mobile platform needs simulator/emulator
VERIFY-skill evidence and e2e mobile-engine evidence on the exact built revision.
Skipped entry points never pass. The [plan](plan.md) describes proof and authority.

| Parked tool | Why parked / property not met yet | Source URL and provenance | Exact return trigger |
| --- | --- | --- | --- |
| e2e mobile engine | No mobile app in the current pilot; needs simulator hosting and exact companion pins | [TesterArmy mobile docs at the studied revision](https://github.com/tester-army/e2e/blob/a0ee3e9061b666fa3dd43e7dcc8e1a5da47362d6/docs/mobile.mdx); Apache-2.0 project | Intake contains ios or android, including after mismatch reconciliation: qualify within capabilities/mobile-verification before Prove passes |
| stim | Mobile environment/build/isolation tooling adds no proof to the current web fixtures | [appandflow/stim](https://github.com/appandflow/stim); MIT per upstream README | ios/android intake activates mobile qualification; evaluate for owned simulator/emulator resources, Doctor, parallel isolation and Cleanup; install only if needed by the qualified mobile runner |
| argent | Mobile control/debug/profile tooling waits for a mobile consumer; overlapping desktop ability does not require another driver now | [software-mansion/argent](https://github.com/software-mansion/argent); Apache-2.0 source with restricted proprietary binaries; telemetry opt-out must be qualified | ios/android intake activates mobile qualification; evaluate control/profiling and license suitability, disable telemetry, prove defect detection and safe cleanup before choosing it |
| agent-device standalone | e2e mobile already uses agent-device; a separate direct driver is unproved duplication until mobile needs one | [callstack/agent-device](https://github.com/callstack/agent-device); license/pin qualification required before adoption | ios/android intake activates mobile qualification; compare standalone driver with the e2e mobile route on the same fixture; add only for a measured unmet driving/recovery requirement |
| Maestro | Another mobile harness is unnecessary before a mobile app and a comparison fixture exist; the post reports impractical hand-built flows that “took long time” | [mobile-dev-inc/maestro](https://github.com/mobile-dev-inc/maestro); Apache-2.0 per upstream repository; practitioner cost report: [stringsaeed post](https://x.com/stringsaeed/status/2105734077085303106), retrieved 2026-10-02 | ios/android intake activates mobile qualification; compare deterministic flows/repros with e2e mobile, including authoring time and maintenance cost below; retain only a measured coverage/reliability advantage that justifies that cost |
| MiniSim | A macOS GUI menu-bar launcher does not satisfy the headless background runtime contract; the existing unattended decline stands | Recommended by the [stringsaeed post](https://x.com/stringsaeed/status/2105734077085303106), retrieved 2026-10-02; GUI behavior confirmed in [okwasniewski/MiniSim README](https://github.com/okwasniewski/MiniSim/blob/bb9deb199adf9d88350f4dbc6349c4ff39fdd1a4/README.md); MIT per upstream repository | A mobile project exists AND an explicit attended simulator-launch task cannot be completed by the qualified CLI runner; evaluate as optional human tooling, never an unattended gate dependency |
| pstack full router | Adopted as the engineering framework by Joe on 2026-10-04. The native port maps supported operations into per-user vendor-neutral stations and the Codex primary runtime; unsupported Cursor automations remain dormant | [MIT upstream provenance](https://github.com/cursor/plugins/tree/c47b12849e43f18d5c374c7069c744cc55b0ea00/pstack); port source `/Users/booko/carr-system/out/orch/pstack/src`, vendored after merge at `/Users/booko/carr-system-pstack/plugins/pstack` | Use adopted workflow, VERIFY/map and maintenance methods in slices 4/9/10. Qualify each host/provider route with a sample fixture before execution; no scheduled-automation dependency, paid fallback or product ownership transfer |

Mobile intake deterministically resurfaces all mobile candidates; it does not
authorize installing every candidate or weakening the required e2e mobile proof.
The capability owner records selection, exact versions, licenses, model route,
runtime, all planted-defect/trap results and an escape/removal path in the factory
store. Prove keeps failing until required capability and evidence are qualified.
No mobile implementation is part of this plan-revision PR.

### First mobile configuration to qualify

When the existing mobile trigger fires, start with the composition the
[stringsaeed post](https://x.com/stringsaeed/status/2105734077085303106) reports
testing, read with its quoted post from the saved verbatim copy retrieved
2026-10-02 (see [plan provenance](plan.md#scope-provenance-and-open-questions)).
This is the starting hypothesis, not an installation order or passing receipt:

| Role in the reported stack | First qualification configuration |
| --- | --- |
| Workflow core | pstack for most work, paired with the product-owned VERIFY skill/map; Joe's framework adoption and the vendor-neutral/Codex runtime constraints above apply |
| Resource orchestration and warm-up | stim for owned simulators/emulators and pre-warmed pools, or a qualified equivalent if stim does not fit the platform/framework |
| Development queries | agent-device mainly for querying the simulator/emulator in Build's inner loop |
| Development queries and mutations | argent for querying and mutating in Build; the reported slight speed advantage is a comparison hypothesis |
| Acceptance | e2e mobile engine for each user-facing criterion on the exact built revision; independent Prove verdict under the [proof rules](plan.md#build-inner-loop-and-prove-acceptance) |

Qualify the composition and each tool against **all existing checks above**;
composition does not waive versions, licenses, telemetry controls, model route,
defect/trap detection, clean-code acceptance, compatibility, runtime, safe cleanup
or the escape/removal path. If a pstack executable route fails its property test,
record that failure and
use its adopted workflow/VERIFY methods through a qualified native route.
Framework adoption does not authorize unsupported Cursor automations.
The e2e mobile engine can use agent-device internally; a direct driver receipt
still cannot replace acceptance assertions.

All comparisons use the same sample app build, task/acceptance fixture, platform,
device/runtime, host and isolated/reset data. Record exact tool pins, repetitions,
failures and result distributions in the factory store. Additional required checks:

1. **Query/mutate latency:** compare agent-device with argent separately for matched state queries and UI mutations, timing command invocation through returned query data or independently observed settled mutation. Repeat in balanced order; report correctness and failure rates alongside latency. Retain a standalone driver only for the measured unmet requirement in its row; no speed claim from different tasks or devices.
2. **Cold/warm start:** qualify pre-warmed simulator/emulator pools via stim or equivalent. Time acquisition request through Doctor-ready device and exact-build app readiness for cold and warm starts separately, including pool preparation time and resource cost. Verify lease ownership, per-run data reset, concurrent isolation, failure recovery and cleanup without discarding proof. Keep warm-up only if it improves readiness time without stale state or cross-run interference; a failed comparison disqualifies that pool configuration.
3. **Maestro effort:** compare Maestro and e2e mobile on identical acceptance coverage/repros. Record authoring minutes and retries from the fixture brief to the first passing flow, then maintenance minutes, edits, reruns and breakages after the same controlled UI/behavior change. Judge the retained coverage/reliability advantage against those costs. The post's report motivates the comparison; it does not prove Maestro impractical for every app.

## iOS platform pack candidates

The [iOS pack contract](plan.md#ios-platform-pack-swiftui-pro) adopts `swiftui-pro`
for Build (Ship's build-orchestration) and Prove. Its sibling candidates use the
**same deterministic `DesignProject.platforms` trigger as the mobile tools**:
`ios` in intake, including after SwiftUI/`.swift` mismatch reconciliation,
automatically resurfaces this pack and the candidates below. No remembered
reminder or separate opt-in trigger is required. Detection conservatively
suggests iOS; ambiguous/non-iOS Swift targets require intake resolution first.

Paul Hudson's [Swift Agent Skills directory](https://github.com/twostraws/swift-agent-skills)
lists these siblings. Each repository URL was verified through GitHub on
2026-10-02; existence is verified, adoption is unqualified. Exact pins, licenses,
framework fit and sample-review detection/false-positive checks remain required
before selection. No sibling is installed or made mandatory by this PR.

| Candidate | Why parked / property not met yet | Verified repository URL | Exact return trigger |
| --- | --- | --- | --- |
| Swift Concurrency Pro | Specialist concurrency review needs a representative async/actor fixture and qualification against the product's isolation settings | [twostraws/Swift-Concurrency-Agent-Skill](https://github.com/twostraws/Swift-Concurrency-Agent-Skill) | ios in reconciled platforms resurfaces the pack; evaluate for Swift concurrency work |
| SwiftData Pro | Persistence review needs a SwiftData consumer and migration/CloudKit fixture | [twostraws/SwiftData-Agent-Skill](https://github.com/twostraws/SwiftData-Agent-Skill) | ios in reconciled platforms resurfaces the pack; evaluate when the product uses SwiftData |
| Swift Testing Pro | Test review needs a Swift Testing consumer and representative test fixture | [twostraws/Swift-Testing-Agent-Skill](https://github.com/twostraws/Swift-Testing-Agent-Skill) | ios in reconciled platforms resurfaces the pack; evaluate when the product uses Swift Testing |

Framework fit decides selection after automatic resurfacing; it does not suppress
the platforms trigger. Qualification and selection receipts belong in the
factory store under the existing capability process above.

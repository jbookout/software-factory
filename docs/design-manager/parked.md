# Parked Design Manager tools

Joe's 2026-10-01 direction parks these tools until a concrete trigger applies.
This is a capability-placement plan, not a journal or eval record. No listed
tool is installed or qualified by TASK AE. Sources describe upstream behavior;
fitness, versions, licensing and account access need live qualification before use.

## Mobile trigger: automatic requirement, not a reminder

All steps are required:

1. Intake records `DesignProject.platforms`: web, ios, android, desktop.
2. The product runner detects react-native, expo, ios/, android/ and app.json signals.
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
| e2e mobile engine | No mobile app in the current pilot; needs simulator hosting and exact companion pins | [TesterArmy mobile docs at the studied revision](https://github.com/tester-army/e2e/blob/8d38206f460415b70706b45acb820bb0e24832ae/docs/mobile.mdx); Apache-2.0 project | Intake contains ios or android, including after mismatch reconciliation: qualify within capabilities/mobile-verification before Prove passes |
| stim | Mobile environment/build/isolation tooling adds no proof to the current web fixtures | [appandflow/stim](https://github.com/appandflow/stim); MIT per upstream README | ios/android intake activates mobile qualification; evaluate for owned simulator/emulator resources, Doctor, parallel isolation and Cleanup; install only if needed by the qualified mobile runner |
| argent | Mobile control/debug/profile tooling waits for a mobile consumer; overlapping desktop ability does not require another driver now | [software-mansion/argent](https://github.com/software-mansion/argent); Apache-2.0 source with restricted proprietary binaries; telemetry opt-out must be qualified | ios/android intake activates mobile qualification; evaluate control/profiling and license suitability, disable telemetry, prove defect detection and safe cleanup before choosing it |
| agent-device standalone | e2e mobile already uses agent-device; a separate direct driver is unproved duplication until mobile needs one | [callstack/agent-device](https://github.com/callstack/agent-device); license/pin qualification required before adoption | ios/android intake activates mobile qualification; compare standalone driver with the e2e mobile route on the same fixture; add only for a measured unmet driving/recovery requirement |
| Maestro | Another mobile harness is unnecessary before a mobile app and a comparison fixture exist | [mobile-dev-inc/maestro](https://github.com/mobile-dev-inc/maestro); Apache-2.0 per upstream repository | ios/android intake activates mobile qualification; compare deterministic flows/repros with e2e mobile and retain only a measured coverage/reliability advantage |
| MiniSim | A macOS GUI menu-bar launcher does not satisfy the headless background runtime contract | [okwasniewski/MiniSim](https://github.com/okwasniewski/MiniSim); MIT per upstream repository | A mobile project exists AND an explicit attended simulator-launch task cannot be completed by the qualified CLI runner; evaluate as optional human tooling, never an unattended gate dependency |
| pstack full router | Cursor-specific model settings and scheduled automations conflict with per-user vendor-neutral stations and the Codex primary runtime | [pstack at the studied revision](https://github.com/cursor/plugins/tree/c47b12849e43f18d5c374c7069c744cc55b0ea00/pstack); MIT | An accepted project explicitly selects Cursor AND a sample fixture proves a routing need unmet by the MCP core without scheduled-automation dependency; otherwise it remains declined. VERIFY/map/maintenance patterns are already adopted in slices 4/9/10 |

Mobile intake deterministically resurfaces all mobile candidates; it does not
authorize installing every candidate or weakening the required e2e mobile proof.
The capability owner records selection, exact versions, licenses, model route,
runtime, all planted-defect/trap results and an escape/removal path in the factory
store. Prove keeps failing until required capability and evidence are qualified.
No mobile implementation is part of this plan-revision PR.

# System design

Size M. One approved design, one worker, one producer PR. No nested delegation.

## Existing delivery and choice

The existing workflow builds PostgreSQL images on recipe PRs and merge groups, qualifies one build, then rebuilds for publication. That makes merge validation depend on package sources and publishes different bytes from the tested artifact.

Two designs were considered. Separate workflows per capability repeat publication rules. A profile registry with one matrix pipeline shares qualification and publishes the exact saved image. Choose the registry. Existing PostgreSQL qualification remains the database and document tool contract.

The caller uses `python /opt/ci/capabilities.py verify PROFILE`. A profile owns expected Node, Playwright, PostgreSQL majors and tools. Recipes own acquisition. Verification owns no acquisition. Generated manifests own observed versions and package closure. Publication receipts bind recipe commit, qualified local image ID, registry digest and hashes of manifests and SPDX SBOMs. Consumers select literal digests in later PRs.

## Throughput checkpoint

- Blocking first steps. Read standing orders and existing producer contracts, then test failed promotion before implementation.
- Independent workstreams. Recipes, qualification and publication are coupled by one artifact contract, so one worker owns them.
- Shared mutable state. No consumer pin writes. Serialize maintenance runs, with at most two matrix builds active.
- Smallest safe decomposition. One profile registry, one verifier and one independent workflow retain existing database qualification.

## Operation

Weekly and manual main-only construction runs on free standard GitHub runners. PR and merge-group validation tests source and workflow contracts without constructing images. Candidate construction, offline qualification and archive precede publication. Publication loads the archived bytes instead of rebuilding. Every external operation has a workflow timeout and no retry loop. One failure stops that candidate and produces a failed run and logs. A failed run never edits consumer pins. No automatic redispatch exists.

At current and tenfold load, image pulls, disk and free-runner concurrency are expected limits, not measured benchmarks. Two builds at a time bound load. Images have no application database access, runtime factory dependency or N+1 queries. Build caches are optional and not correctness state. No eviction or digest deletion is implemented. Retain referenced digests and at least two predecessors. Revocation requires a consumer pin PR; no unqualified fallback exists.

Publication is asynchronous from code validation. The registry digest is immutable. A profile-and-commit tag is a publication locator, never a consumer selection. A run-specific candidate tag prevents collisions. Upload failure leaves the old selection usable. Registry failure blocks cold pulls, package-source failure blocks construction only. No mirror rewriting or runtime installer fallback is added. Credentials remain limited to the publisher job's ephemeral package permission. No production credentials or records are accessed.

## Statechart and tests

```mermaid
stateDiagram-v2
    [*] --> Candidate: independent maintenance starts
    Candidate --> Qualified: offline probes and negative controls pass
    Candidate --> Rejected: build or qualification fails
    Qualified --> Published: main publisher loads exact archive and pushes
    Qualified --> Rejected: receipt or artifact differs
    Published --> PinAvailable: digest receipt emitted
    Rejected --> [*]: existing consumer pins remain selected
    PinAvailable --> [*]: consumer adoption is a separate PR
```

Tests cover failed qualification, wrong versions, missing tools, rejected digest receipts and successful promotion binding. Workflow tests cover main-only permission, no ordinary image build, offline execution, archive transfer and failure propagation. Hosted maintenance and publication proof run after merge, never from this branch.

## Scope and production proof

software-factory owns this producer. doctorcre-app migration is slice 2. carr-system migration is slice 3. The enforcement checker and factory consumer migration are later slices. Observe successful containing-commit CI, one scheduled image publication with qualification receipts, then an isolated failing candidate with unchanged consumer pins. This branch publishes no images and arms no merges.

## Design and debt pass

Codebase design concentrated receipt validation and pre-publication verification in one CLI. Zero tech debt removed the extra publication wrapper and the second image build. Source validation remains a test-only consumer of recipes. The artifact archive is the only image transfer between qualification and publication.

Transition coverage uses the Python tests `test_failed_candidate_never_creates_pin`, `test_versions_are_exact`, `test_missing_tool_refuses_without_installation`, `test_promotion_binds_qualified_bytes_and_recipe` and `test_preflight_cli_checks_artifact_hashes_before_any_publication`. Workflow tests cover independent maintenance, immutable actions, main-only package permission and every pinned consumer failure. Live container probes cover positive qualification and mutated missing-binary, wrong-version and absent-browser cases. Published job-container parity remains a hosted post-merge proof.

## App producer Python correction (WR622.S13.J333)

Size S. The app profile declares its required Python minor once, with the exact CARR producer revision and source path. Both Python entry points must match it before database or browser qualification. The recipe copies Python 3.14.10 from a digest-pinned upstream layer; acquisition remains build-only. Copying the runtime avoids another Ubuntu package dependency. A source build would duplicate upstream packaging and checksum maintenance.

The existing verification interface and publication statechart remain unchanged. A wrong-Python candidate follows Candidate to Rejected, covered by test_app_requires_declared_producer_python_minor_for_both_commands and the real system-Python 3.12 negative control. The registry owns the producer requirement; Docker owns the exact runtime artifact. There is no runtime download, fallback, queue, additional storage or external call. Existing build deadlines, matrix cap and fail-closed publication remain applicable at current and tenfold load.

Codebase-design kept the rule behind the existing verify interface. Zero-tech-debt reused the pinned Python artifact and profile registry instead of adding an installer or a separate version gate. No existing caller or compatibility path was removed. Production proof remains hosted qualification and publication after review; this worker publishes nothing.

## App Python startup correction (WR622.S13.J338)

Size S. The copied upstream runtime contains no bytecode. Its standard library is root-owned, so nonroot subprocesses compile those imports on every start. The continuity suite launches a fresh interpreter for each event and exceeded its unchanged 30-second Node subprocess deadline. Compile the standard library once during image construction, beside ldconfig. Bytecode belongs to the pinned interpreter and source layer, so rebuilding that layer invalidates the cache. No runtime writes, acquisition, version fallback or new interface is needed. Build failure rejects the candidate. Existing matrix limits and deadlines apply at current and tenfold load.

The data shape remains the image filesystem, with interpreter-matched bytecode beside standard-library source. Database access, queues, external calls and new consistency rules are not applicable. The throughput checkpoint is reproduce, isolate imports with a Python 3.12 control, rebuild, then qualify serially in the two-CPU VM. There are no independent implementation streams or shared consumer writes.

Qualification asserts that the unchanged continuity executable passes three times as uid 1001 with a fresh HOME and no network, followed by the complete npm check. The expensive image regression uses this qualification assertion rather than a host timing test, which cannot observe image bytecode. Keep the 30-second deadline.

Codebase-design keeps startup preparation in the recipe behind the existing image interface. Zero-tech-debt uses Python's compileall instead of a runtime cache wrapper or version fallback. This adds one build operation and removes no compatibility path because none is introduced.

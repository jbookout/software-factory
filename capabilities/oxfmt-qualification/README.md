# Oxfmt qualification pilot

Qualify pinned Oxfmt 0.72.0 on eight declared **copies** of Factory files. This
capability installs tools into its verification attempt, compares native and npm
output, exercises invalid input, and preserves measurements. It changes no source
formatting policy or agent/editor hook.

Use the existing check entrypoint:

```sh
npm ci
npm ci --prefix capabilities/agentic-ui-evaluation/fixture
# If Chromium is missing, use that fixture's pinned Playwright installer.
npm run check formatter
```

Ordinary `npm run check` retains its Node, Python browser and orchestration
classes. `formatter` is an explicit qualification class using the same admission,
process ownership and producer/source/log receipt validation. The existing hosted
browser qualification job runs it after installing its pinned Chromium. Native
check tests cover bad digests/archives, existing targets, ignored inputs, visible
formatter failures, restricted fallback and semantic mutations.

The native installer supports the trial hosts `darwin-arm64` and GNU `linux-x64`.
It verifies the published SHA-256, one exact regular archive member, executable
architecture and CLI version. Python's standard tar parser reads the member into
an exclusive chosen output; archive paths are never extracted. npm uses the
committed tool lock, disabled lifecycle scripts, an owned cache and distinct empty
user/global config files. Unsupported hosts fail visibly; no other installer or
platform is claimed qualified.

Native HTML is unsupported in this release. Only its unchanged-file **no-target**
exit may request npm fallback. Syntax errors, successful skips and unexpected
format loss fail qualification. npm must actually format all eight kinds. Both
distributions must produce identical bytes for their seven shared kinds.

Each successful copied-file run must detect seeded EOF whitespace, change the
copy, produce stable output over three fresh-process observations, be idempotent,
and pass a final style check. JS/MJS/TS/TSX syntax trees retain literals/operators
and declarations, including unary/type operators, declaration-kind flags,
optional-chain continuation and type-only/keyword forms omitted by AST child
traversal. Raw tagged-template spelling and strict directives remain distinct;
TSX also compares compiler-emitted JSX calls. JSON/YAML compare
parsed values. CSS compares pinned Tailwind output for four declared candidates.
HTML compares the existing task fixture's five rendered routes and blank-title,
save, independent localStorage read and reload behavior using local Chromium.
These are bounded fixture checks, not proofs for arbitrary application code.

The nested `receipt.json` declares source, tool/lock digests, coverage, fallback,
per-command log/report digests, controller wall time and OS rusage peak RSS.
OS time writes its report to an exclusive owned file, independently of formatter
stdout/stderr; incomplete or ambiguous reports fail. Its parent
`factory-verification/v1` binds the producing command, entire source and captured
log. Hosted artifacts retain both receipts and copied-corpus logs/files.

Installer observations distinguish a fresh owned archive/npm cache from reuse.
Formatter observations are `first-process` and `repeated-process`; every command
starts a process. Host DNS/TLS/filesystem and upstream caches are uncontrolled.
Wall time includes process-supervisor overhead; RSS uses bytes, converting Linux
rusage KiB explicitly. Three samples per file and two installer observations are
not a repository-wide speedup, hardware cold-start benchmark or adoption decision.

Sources: [official formatter documentation](https://oxc.rs/docs/guide/usage/formatter.html),
[pinned release](https://github.com/oxc-project/oxc/releases/tag/oxfmt_v0.72.0).

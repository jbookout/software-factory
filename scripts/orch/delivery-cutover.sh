#!/bin/sh
# delivery-cutover.sh shadow|flip|rollback|status — move the orchestrator between its
# hand-built review/merge scripts (legacy) and the factory delivery loop.
#   shadow    start one read-only shadow lane per repository beside the legacy scripts
#   flip      drained legacy -> factory: import the legacy queue, move the legacy scripts
#             to $OLD/_to_delete/orch-legacy-<stamp>/, install the factory wrappers, start lanes
#   rollback  factory -> legacy: stop factory lanes, move the factory wrappers aside, move the
#             legacy scripts back, carry pending factory queue entries over, restart legacy daemons
# Files are only ever moved (mv), never deleted. Mode lives in $OLD/delivery-mode.
# Env: CONFIG (private delivery config, required), FACTORY (default: this checkout),
#      OLD (default /Users/booko/carr-system/out/orch), REPOS, FORCE=1 to skip the mode check.
# CUTOVER_SIMULATE=1 logs process actions to $OLD/cutover-simulated.log instead of running them.
set -eu
FACTORY=${FACTORY:-$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)}
OLD=${OLD:-/Users/booko/carr-system/out/orch}
REPOS=${REPOS:-"jbookout/carr-system jbookout/doctorcre-app jbookout/software-factory"}
MODE_FILE=$OLD/delivery-mode
CLI="$FACTORY/bin/pr-delivery.mjs"
# Every file the factory wrappers replace, plus legacy writers that would bypass the factory queue.
LEGACY="review-pr.sh pr-loop.sh fix-pr.sh ci-fix.sh codex-guard.sh branch-wt.sh auto-enqueue.sh merge-queue.sh
merge-one-core.sh merge-one.sh merge-enqueue.sh wait-green-enqueue.sh merge-queue-keepalive.sh approve-watcher.sh
reapprove.sh gate-merge.sh unstick.sh stall-watch.sh"
LEGACY_DAEMONS="merge-queue-keepalive.sh merge-queue.sh auto-enqueue.sh unstick.sh stall-watch.sh wait-green-enqueue.sh approve-watcher.sh"
LEGACY_WORKERS="pr-loop.sh review-pr.sh fix-pr.sh ci-fix.sh codex-guard.sh merge-one-core.sh"

say() { echo "cutover: $*"; }
die() { echo "cutover: $*" >&2; exit "${2:-1}"; }
mode() { cat "$MODE_FILE" 2>/dev/null || echo legacy; }
act() { # one seam for every process action
  if [ -n "${CUTOVER_SIMULATE:-}" ]; then echo "$*" >> "$OLD/cutover-simulated.log"; return 0; fi
  sh -c "$*"
}
running() { [ -z "${CUTOVER_SIMULATE:-}" ] && pgrep -f "$1" >/dev/null 2>&1; }
stamp() { date -u +%Y%m%dT%H%M%SZ; }
need_config() { [ -n "${CONFIG:-}" ] && [ -f "$CONFIG" ] || die "set CONFIG to the private delivery config"; }

refuse_active() { # $1 = space-separated script names that must not be running
  busy=""
  for name in $1; do running "(^|/| )$name( |$)" && busy="$busy $name"; done
  [ -z "$busy" ] || die "active workers:$busy — drain them (pause producers, let jobs finish) and rerun" 3
}

case "${1:-status}" in
status)
  echo "mode: $(mode)"
  ;;
shadow)
  need_config
  [ "$(mode)" = legacy ] || [ -n "${FORCE:-}" ] || die "shadow starts from legacy (mode is $(mode))"
  for repo in $REPOS; do
    log="$OLD/delivery-shadow-$(basename "$repo").log"
    act "nohup node '$CLI' '$CONFIG' shadow '$repo' >> '$log' 2>&1 < /dev/null &"
  done
  echo shadow > "$MODE_FILE"
  say "shadow lanes started; compare with: node '$FACTORY/bin/delivery-shadow-compare.mjs' <stateDir>/shadow.jsonl"
  ;;
flip)
  need_config
  [ "$(mode)" = shadow ] || [ -n "${FORCE:-}" ] || die "flip starts from shadow (mode is $(mode))"
  refuse_active "$LEGACY_WORKERS"
  act "pkill -f 'pr-delivery.mjs .* shadow ' || true"
  for name in $LEGACY_DAEMONS; do act "pkill -f '(^|/| )$name( |\$)' || true"; done
  act "node '$CLI' '$CONFIG' import-legacy '$OLD'"
  dest="$OLD/_to_delete/orch-legacy-$(stamp)"
  mkdir -p "$dest"
  for name in $LEGACY; do
    [ -e "$OLD/$name" ] || continue
    shasum -a 256 "$OLD/$name" | sed "s|  $OLD/|  |" >> "$dest/MANIFEST"
    mv "$OLD/$name" "$dest/$name"
  done
  say "legacy scripts moved to $dest"
  if [ -n "${CUTOVER_SIMULATE:-}" ]; then
    act "node '$FACTORY/bin/orch-install.mjs' install '$FACTORY' '$OLD' '$CONFIG'"
    for f in "$FACTORY"/deploy/orch/*; do [ -x "$f" ] && cp "$f" "$OLD/"; done
    node -e 'const fs=require("fs"),p=require("path");const d=process.argv[1];fs.writeFileSync(p.join(d,".factory-orch.json"),JSON.stringify({executables:fs.readdirSync(process.argv[2]).filter(n=>fs.statSync(p.join(process.argv[2],n)).mode&0o100).map(path=>({path}))}))' "$OLD" "$FACTORY/deploy/orch"
  else
    node "$FACTORY/bin/orch-install.mjs" install "$FACTORY" "$OLD" "$CONFIG" > /dev/null
  fi
  for repo in $REPOS; do
    act "cd '$OLD' && nohup ./deliver.sh '$repo' >> '$OLD/delivery-$(basename "$repo").log' 2>&1 < /dev/null &"
  done
  act "cd '$OLD' && nohup ./unstick.sh >> '$OLD/delivery-recover.log' 2>&1 < /dev/null &"
  echo factory > "$MODE_FILE"
  say "factory delivery is live; rollback: $0 rollback"
  ;;
rollback)
  need_config
  [ "$(mode)" = factory ] || [ -n "${FORCE:-}" ] || die "rollback starts from factory (mode is $(mode))"
  src=$(ls -d "$OLD"/_to_delete/orch-legacy-* 2>/dev/null | sort | tail -1)
  [ -n "$src" ] && [ -f "$src/MANIFEST" ] || die "no legacy script set under $OLD/_to_delete"
  # Lanes and recovery only; a per-PR deliver job finishes its own round.
  act "pkill -f '(factory-verify|pr-delivery)\.mjs .* (deliver [^ ]+|recover|shadow [^ ]+)\$' || true"
  dest="$OLD/_to_delete/factory-wrappers-$(stamp)"
  mkdir -p "$dest"
  for name in $(node -e 'for (const e of JSON.parse(require("fs").readFileSync(process.argv[1])).executables) console.log(e.path)' "$OLD/.factory-orch.json"); do
    [ -e "$OLD/$name" ] && mv "$OLD/$name" "$dest/$name"
  done
  mv "$OLD/.factory-orch.json" "$dest/.factory-orch.json"
  while read -r _sum name; do
    [ -e "$OLD/$name" ] && die "$OLD/$name exists; refusing to overwrite"
    mv "$src/$name" "$OLD/$name"
  done < "$src/MANIFEST"
  mv "$src/MANIFEST" "$src/MANIFEST.restored-$(stamp)"
  # Approved factory queue entries rejoin the legacy queue; their APPROVE comments name the exact head.
  node -e '
    const fs=require("fs"),p=require("path"),[config,old]=process.argv.slice(1)
    const c=JSON.parse(fs.readFileSync(config)),state=p.resolve(p.dirname(config),c.stateDir)
    const queue=fs.existsSync(p.join(state,"queue.json"))?JSON.parse(fs.readFileSync(p.join(state,"queue.json"))):[]
    const lines=queue.filter(e=>!e.outcome).map(e=>`${e.repo} ${e.pr} ${e.head} factory rollback: ${e.note}\n`)
    fs.appendFileSync(p.join(old,"merge-queue.txt"),lines.join(""))
    console.log(`cutover: ${lines.length} pending factory queue entr${lines.length===1?"y":"ies"} carried to merge-queue.txt`)' "$CONFIG" "$OLD"
  act "cd '$OLD' && nohup zsh merge-queue-keepalive.sh >> merge-queue.nohup 2>&1 < /dev/null &"
  act "cd '$OLD' && nohup zsh auto-enqueue.sh >> auto-enqueue.nohup 2>&1 < /dev/null &"
  act "cd '$OLD' && nohup zsh unstick.sh >> unstick.log 2>&1 < /dev/null &"
  echo legacy > "$MODE_FILE"
  say "legacy scripts restored from $src and restarted; factory wrappers kept in $dest"
  ;;
*) die "usage: delivery-cutover.sh shadow|flip|rollback|status" ;;
esac

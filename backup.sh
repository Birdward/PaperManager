#!/usr/bin/env bash
# Back up PaperManager's Neo4j database (papers, notes, highlights, tags, chats, users) with
# neo4j-admin's dump: a compact, consistent copy without the transaction logs. PDFs and figure
# images (the app_files volume) are not included.
#
#   ./backup.sh                  stop Neo4j, write a dump, start Neo4j, keep the newest $KEEP
#   ./backup.sh restore FILE     replace the database with FILE (asks first)
#
# BACKUP_DIR (default ~/Documents/PaperManager-backups) and KEEP (default 5) can be overridden.
set -euo pipefail

PROJECT="$(cd "$(dirname "$0")" && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$HOME/Documents/PaperManager-backups}"
KEEP="${KEEP:-5}"
COMPOSE=(docker compose -f "$PROJECT/docker-compose.selfhost.yml")

GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[backup]${NC} $*"; }
error() { echo -e "${RED}[error]${NC}  $*" >&2; exit 1; }

docker info >/dev/null 2>&1 || error "Docker is not running. Open Docker Desktop and try again."

CONTAINER="$("${COMPOSE[@]}" ps -aq neo4j)"
[ -n "$CONTAINER" ] || error "No Neo4j container found. Start PaperManager once with: docker compose -f docker-compose.selfhost.yml up -d"
VOLUME="$(docker inspect "$CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')"
IMAGE="$(docker inspect "$CONTAINER" --format '{{.Config.Image}}')"   # neo4j-admin must match the server version
WAS_RUNNING="$(docker inspect "$CONTAINER" --format '{{.State.Running}}')"

# Whatever happens below, bring Neo4j back up if it was running before.
restart_neo4j() {
  if [ "$WAS_RUNNING" = "true" ]; then
    info "Starting Neo4j..."
    # A fresh container: restarting the old one can trip over a stale PID file in its own
    # filesystem ("Neo4j is already running") and loop. The data lives in the volume.
    "${COMPOSE[@]}" up -d --force-recreate --no-deps neo4j >/dev/null 2>&1
    for _ in $(seq 1 60); do
      curl -sf http://localhost:8080/health 2>/dev/null | grep -q '"neo4j":"connected"' && { info "PaperManager is back up."; return; }
      sleep 2
    done
    echo "Neo4j was started but PaperManager is not reporting it as connected yet; check http://localhost:8080/health"
  fi
}

stop_neo4j() {
  if [ "$WAS_RUNNING" = "true" ]; then
    trap restart_neo4j EXIT
    info "Stopping Neo4j (PaperManager is unavailable for a few seconds)..."
    # Give Neo4j time for a clean shutdown; compose's 10 s default can end in a kill.
    "${COMPOSE[@]}" stop -t 120 neo4j >/dev/null 2>&1
  fi
}

# neo4j-admin writes and reads a file called neo4j.dump inside a directory, so each run works in
# its own scratch directory under BACKUP_DIR.
admin() {
  docker run --rm -v "$VOLUME:/data" -v "$1:/backups" "$IMAGE" neo4j-admin database "${@:2}"
}

backup() {
  mkdir -p "$BACKUP_DIR"
  local work; work="$(mktemp -d "$BACKUP_DIR/.tmp.XXXXXX")"
  stop_neo4j
  info "Writing dump..."
  admin "$work" dump neo4j --to-path=/backups >/dev/null 2>"$work/log" || { cat "$work/log" >&2; rm -rf "$work"; error "Dump failed."; }
  local file; file="$BACKUP_DIR/papermanager-$(date +%Y-%m-%d_%H%M%S).dump"
  mv "$work/neo4j.dump" "$file"
  rm -rf "$work"

  # Keep only the newest $KEEP backups.
  ls -1t "$BACKUP_DIR"/papermanager-*.dump | tail -n +"$((KEEP + 1))" | while read -r old; do rm -f "$old"; done

  info "Saved $(du -h "$file" | cut -f1 | tr -d ' ') to $file"
  info "Backups kept ($KEEP max):"
  ls -1t "$BACKUP_DIR"/papermanager-*.dump | sed 's/^/    /'
}

restore() {
  local file="${1:-}"
  [ -f "$file" ] || error "Usage: ./backup.sh restore <file.dump>"
  echo "This replaces EVERYTHING in the PaperManager database with: $file"
  read -r -p "Type 'restore' to continue: " answer
  [ "$answer" = "restore" ] || { echo "Cancelled."; exit 0; }
  local work; work="$(mktemp -d "${TMPDIR:-/tmp}/pm-restore.XXXXXX")"
  cp "$file" "$work/neo4j.dump"
  stop_neo4j
  info "Loading dump..."
  admin "$work" load neo4j --from-path=/backups --overwrite-destination=true >/dev/null 2>"$work/log" || { cat "$work/log" >&2; rm -rf "$work"; error "Restore failed."; }
  rm -rf "$work"
  info "Restored from $file"
}

case "${1:-backup}" in
  backup)  backup ;;
  restore) restore "${2:-}" ;;
  *)       error "Unknown command '$1'. Use: ./backup.sh  or  ./backup.sh restore <file.dump>" ;;
esac

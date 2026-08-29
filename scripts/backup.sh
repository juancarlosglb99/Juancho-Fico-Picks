#!/bin/sh
# Daily pg_dump, rotated. Runs as a sidecar beside the database.
#
# App and database share one machine, so a backup is not optional and it must
# not depend on anything else being installed: this is busybox `sh` and the
# `pg_dump` that ships in the same image as the server, so the dump can never be
# a version behind what wrote the data.
#
# One dump is taken IMMEDIATELY on start. That is deliberate - a backup job
# whose first run is tomorrow morning is a backup job nobody has ever seen
# work, and the first day is when a deployment is most likely to need it.
#
# Restoring is in DEPLOYMENT.md. The short version:
#   gunzip -c juancho-2026-08-28.sql.gz | psql

set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
# 03:00 UTC: after the American evening drafts, before the European morning.
BACKUP_HOUR="${BACKUP_HOUR:-3}"

mkdir -p "$BACKUP_DIR"

log() {
	echo "[backup $(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"
}

take_backup() {
	stamp="$(date -u '+%Y-%m-%d_%H%M')"
	target="$BACKUP_DIR/${PGDATABASE}-${stamp}.sql.gz"
	partial="${target}.partial"

	# Written to a .partial name and moved into place only on success, so a
	# dump interrupted by a restart can never be mistaken for a complete one.
	if pg_dump --no-owner --no-privileges --clean --if-exists | gzip -9 > "$partial"; then
		mv "$partial" "$target"
		log "wrote $(basename "$target") ($(wc -c < "$target" | tr -d ' ') bytes)"
	else
		rm -f "$partial"
		log "FAILED - dump did not complete; the previous backups are untouched"
		return 1
	fi
}

prune() {
	# Retention is by age rather than by count, so a stretch of failed runs
	# cannot silently rotate away the last good backup.
	removed=$(find "$BACKUP_DIR" -name "${PGDATABASE}-*.sql.gz" -type f -mtime "+${RETENTION_DAYS}" -print -delete | wc -l | tr -d ' ')
	[ "$removed" = "0" ] || log "pruned $removed backup(s) older than ${RETENTION_DAYS} days"
}

seconds_until_backup_hour() {
	now=$(( $(date -u +%H | sed 's/^0//;s/^$/0/') * 3600 \
		+ $(date -u +%M | sed 's/^0//;s/^$/0/') * 60 \
		+ $(date -u +%S | sed 's/^0//;s/^$/0/') ))
	target=$(( BACKUP_HOUR * 3600 ))
	if [ "$now" -lt "$target" ]; then
		echo $(( target - now ))
	else
		echo $(( 86400 - now + target ))
	fi
}

log "starting; keeping ${RETENTION_DAYS} days in ${BACKUP_DIR}, daily at ${BACKUP_HOUR}:00 UTC"
take_backup || log "the first backup failed; will retry at the next scheduled run"
prune

while true; do
	wait_for=$(seconds_until_backup_hour)
	log "next backup in $(( wait_for / 3600 ))h $(( (wait_for % 3600) / 60 ))m"
	sleep "$wait_for"
	take_backup || true
	prune
done

#!/usr/bin/env bash
# Nightly backup of the only irreplaceable thing on the box: data/.
#
#   sudo bash backup.sh gs://your-bucket-name
#
# Uses sqlite3 .backup rather than cp - copying a live SQLite file can capture a
# half-written transaction, and this is the one moment that matters.
set -euo pipefail

BUCKET="${1:?usage: backup.sh gs://bucket}"
APP_DIR=/opt/arcade/app
STAMP="$(date -u +%Y%m%d-%H%M%S)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

sqlite3 "$APP_DIR/data/arcade.db" ".backup '$TMP/arcade.db'"
tar -czf "$TMP/arcade-$STAMP.tar.gz" -C "$TMP" arcade.db -C "$APP_DIR/data" uploads

gcloud storage cp "$TMP/arcade-$STAMP.tar.gz" "$BUCKET/" --quiet
echo "backed up to $BUCKET/arcade-$STAMP.tar.gz"

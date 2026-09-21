#!/usr/bin/env bash
#
# Nightly backup of the JojoAI control-plane database.
#
# Accounts, grants, login sessions and the audit trail live here since the
# control plane moved off the memory store (21 Sep). It is a separate database
# from JojoCode's (decision D3) in the same Postgres container, so JojoCode's
# own backup does not cover it — this does. Compressed pg_dump, kept 30 days.
#
#   server/scripts/backup-db.sh           # one dump now
#   restore:  zcat <file> | docker exec -i cjudge-postgres psql -U cjudge -d jojoai
#
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out="$repo/backups"
mkdir -p "$out"
chmod 700 "$out"

stamp="$(date +%Y-%m-%d_%H%M)"
file="$out/jojoai-$stamp.sql.gz"

# --clean --if-exists so a restore into a populated database needs no hand-dropping.
docker exec cjudge-postgres pg_dump -U cjudge --clean --if-exists jojoai | gzip -9 > "$file.partial"
mv "$file.partial" "$file"
chmod 600 "$file"

find "$out" -name 'jojoai-*.sql.gz' -mtime +30 -delete

echo "backed up to $file ($(du -h "$file" | cut -f1))"

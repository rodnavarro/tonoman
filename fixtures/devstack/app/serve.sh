#!/bin/sh
# Prove DNS-by-name to the db service, read the bind-mounted marker row back, then
# serve a status page on :80 so the host can curl it (dev-against-the-stack).
set -e
echo "app: resolving db by name + waiting for it to be ready..."
until pg_isready -h db -U postgres -d devstack >/dev/null 2>&1; do sleep 2; done

MARKER="$(PGPASSWORD=devonly psql -h db -U postgres -d devstack -tAc 'SELECT note FROM devstack_marker LIMIT 1' 2>/dev/null || echo '?')"

mkdir -p /www
cat > /www/index.html <<EOF
devstack app: OK
db reachable by DNS name "db"
marker row: ${MARKER}
EOF

echo "app: db reachable; marker=${MARKER}; serving on :80"
exec python3 -m http.server 80 --directory /www

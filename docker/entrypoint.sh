#!/bin/sh
set -eu

if [ ! -f /app/package.json ]; then
    cp -a /opt/selfcraft/. /app/
fi

if [ ! -d /app/node_modules/ai ]; then
    cp -a /opt/selfcraft/node_modules/. /app/node_modules/
fi

cd /app
exec bun run start "$@"

#!/bin/bash
# Run the add-on on a dev machine against a real Home Assistant, in dry-run mode:
# reads are real, writes go to .dev/config and every mutating HA call is skipped.
#   echo 'HA_URL=http://homeassistant.local:8123' > .dev.env
#   echo 'HA_TOKEN=<long-lived token>'           >> .dev.env    (or HA_TOKEN_FILE=path)
#   tools/dev.sh            # panel on http://localhost:8099
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .dev.env ] && set -a && . ./.dev.env && set +a
if [ -z "${HA_TOKEN:-}" ] && [ -n "${HA_TOKEN_FILE:-}" ]; then HA_TOKEN="$(cat "$HA_TOKEN_FILE")"; export HA_TOKEN; fi
mkdir -p .dev/config .dev/data
[ -f .dev/config/configuration.yaml ] || cp tests/fixtures/configuration.default.yaml .dev/config/configuration.yaml
export CONFIG_DIR="$PWD/.dev/config" DATA_DIR="$PWD/.dev/data" EIGHT_PLUS_DEV=1
export EIGHT_PLUS_DRY_RUN="${EIGHT_PLUS_DRY_RUN:-1}" INGRESS_PORT="${INGRESS_PORT:-8099}"
exec python3 eight_plus/app/main.py

#!/usr/bin/env bash
# Run the backend locally (demo auth). See server/.env.example for real config.
set -euo pipefail
cd "$(dirname "$0")"
export JOJOAI_DEMO_CODE="${JOJOAI_DEMO_CODE:-jojo-demo}"
exec node --experimental-strip-types server/backend/src/index.ts

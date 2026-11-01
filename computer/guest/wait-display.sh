#!/usr/bin/env bash
set -euo pipefail
for attempt in {1..60}; do
  if xdpyinfo -display :0 >/dev/null 2>&1; then exit 0; fi
  sleep 1
done
echo 'Virtual display did not become available' >&2
exit 1

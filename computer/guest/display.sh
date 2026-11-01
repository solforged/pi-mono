#!/usr/bin/env bash
set -euo pipefail
umask 077
export XAUTHORITY="$HOME/.Xauthority"
xauth -f "$XAUTHORITY" add :0 . "$(mcookie)"
exec /usr/bin/Xvfb :0 -screen 0 1440x900x24 -nolisten tcp -auth "$XAUTHORITY"

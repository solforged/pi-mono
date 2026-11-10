#!/bin/sh
# Hands a pi-open://PID/PATH link to the Pi process it names, through that
# Pi's private IPC directory; see docs/diff.md. Pi checks the request itself.
url=$1
rest=${url#pi-open://}
pid=${rest%%/*}
case $rest in "$url") exit 64 ;; */*) ;; *) exit 64 ;; esac
case $pid in '' | *[!0-9]*) exit 64 ;; esac
kill -0 "$pid" 2>/dev/null || exit 0
dir=$(getconf DARWIN_USER_TEMP_DIR)pi-diff-$(id -u)
[ -d "$dir" ] && [ -O "$dir" ] || exit 0
tmp=$(mktemp "$dir/.open.XXXXXX") || exit 1
printf '%s' "$url" > "$tmp" && mv "$tmp" "$dir/$pid.open.${tmp##*.}"

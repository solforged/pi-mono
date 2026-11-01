#!/usr/bin/env bash
# Invoked as root by cloud-init; safe to retry with sudo after a failed boot.
set -euo pipefail
umask 077
exec > >(tee -a /var/log/assistant-provision.log) 2>&1
trap 'echo "Provisioning failed at line $LINENO; fix the error and rerun /opt/assistant-computer/provision.sh" >&2' ERR
install -d -m 755 /var/lib/assistant-computer
rm -f /var/lib/assistant-computer/ready
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl git jq ripgrep xz-utils openssh-server \
  xfce4 xfce4-terminal xfce4-screenshooter dbus-x11 xvfb x11vnc xauth x11-utils fonts-dejavu-core snapd

# Root-owned configuration supplied in the seed, not the caller's environment.
source /opt/assistant-computer/versions.env
[[ "$NODE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "$PI_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
case "$(dpkg --print-architecture)" in
  arm64) node_arch=arm64 ;;
  amd64) node_arch=x64 ;;
  *) echo 'Unsupported guest architecture' >&2; exit 1 ;;
esac
node_dir="/opt/node-v${NODE_VERSION}-linux-${node_arch}"
if [ ! -x "$node_dir/bin/node" ]; then
  download="$(mktemp -d)"
  trap 'rm -rf "$download"' EXIT
  archive="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"
  curl --proto '=https' --tlsv1.2 -fL --retry 3 \
    "https://nodejs.org/dist/v${NODE_VERSION}/${archive}" -o "$download/$archive"
  printf '%s  %s\n' "$NODE_SHA256" "$download/$archive" | sha256sum --check --strict
  tar -xJf "$download/$archive" -C /opt
fi
chown -R root:root "$node_dir"
ln -sfn "$node_dir" /opt/node
for tool in node npm npx; do ln -sfn "/opt/node/bin/$tool" "/usr/local/bin/$tool"; done
# Installed program files are public; personal runtime data stays private.
umask 022
npm install --global --ignore-scripts --no-audit --no-fund \
  "@earendil-works/pi-coding-agent@${PI_VERSION}"
chmod -R a+rX /opt/node/lib/node_modules
umask 077
ln -sfn /opt/node/bin/pi /usr/local/bin/pi
runuser -u assistant -- pi --version

systemctl enable --now snapd.socket
snap wait system seed.loaded
if ! snap list chromium >/dev/null 2>&1; then snap install chromium; fi
install -d -o assistant -g assistant -m 700 \
  /home/assistant/workspace /home/assistant/.vnc /home/assistant/.pi/agent
# x11vnc writes the legacy VNC password file; input is deliberately not logged.
if [ -f /opt/assistant-computer/vnc-password ]; then
  x11vnc -storepasswd "$(< /opt/assistant-computer/vnc-password)" /home/assistant/.vnc/passwd >/dev/null 2>&1
  chown assistant:assistant /home/assistant/.vnc/passwd
  chmod 600 /home/assistant/.vnc/passwd
  rm -f /opt/assistant-computer/vnc-password
fi
test -s /home/assistant/.vnc/passwd
install -d -o assistant -g assistant -m 755 /home/assistant/Desktop
cat > /home/assistant/Desktop/chromium.desktop <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Assistant browser
Exec=/snap/bin/chromium --no-first-run --user-data-dir=/home/assistant/snap/chromium/common/assistant-profile
Icon=chromium
Terminal=false
DESKTOP
chown assistant:assistant /home/assistant/Desktop/chromium.desktop
chmod 755 /home/assistant/Desktop/chromium.desktop
systemctl daemon-reload
systemctl enable --now assistant-display.service assistant-desktop.service assistant-vnc.service
systemctl is-active --quiet assistant-display.service assistant-desktop.service assistant-vnc.service
runuser -u assistant -- env DISPLAY=:0 XAUTHORITY=/home/assistant/.Xauthority /opt/assistant-computer/wait-display.sh
printf 'Provisioned %s\n' "$(date --iso-8601=seconds)" > /var/lib/assistant-computer/ready
printf '\nAssistant computer is ready. No model credentials have been installed.\n'

#!/bin/bash
# es-franken-proxy/install.sh -- run ON the Pod as root.
#
# Inserts a transparent proxy between frankenfirmware and stock dac so Home
# Assistant gets a local `climate` entity per side (+ on/off). dac keeps doing
# cloud / heartbeat / telemetry, so the app + warranty + capybara are untouched.
#
#   tar czf - -C gateway/franken-proxy --exclude=.git . | ssh rewt@pod 'cat >/tmp/fp.tgz'
#   ssh rewt@pod ; sudo mkdir -p /tmp/fp && sudo tar xzf /tmp/fp.tgz -C /tmp/fp && sudo bash /tmp/fp/install.sh
set -euo pipefail
DEST=/opt/es-franken-proxy
SRC="$(cd "$(dirname "$0")" && pwd)"
FRANK_SH=/opt/eight/bin/frank.sh

[ "$EUID" -eq 0 ] || { echo "run as root"; exit 1; }

echo "== 1. files + venv =="
mkdir -p "$DEST"
cp "$SRC/franken_proxy.py" "$DEST/"
if [ ! -x "$DEST/venv/bin/python" ]; then
  python3 -m venv "$DEST/venv"
  "$DEST/venv/bin/python" -m ensurepip --upgrade >/dev/null 2>&1 || {
    curl -fsSL https://bootstrap.pypa.io/pip/pip.pyz -o /tmp/pip.pyz
    "$DEST/venv/bin/python" /tmp/pip.pyz install --upgrade pip
  }
fi
"$DEST/venv/bin/pip" -q install --upgrade pip
"$DEST/venv/bin/pip" -q install paho-mqtt
echo "   venv ok"

echo "== 2. point frankenfirmware at the proxy socket =="
cp -n "$FRANK_SH" "$FRANK_SH.orig"
if grep -q 'DAC_SOCKET=/deviceinfo/dac.sock exec' "$FRANK_SH"; then
  sed -i 's#DAC_SOCKET=/deviceinfo/dac.sock exec#DAC_SOCKET=/run/es-franken.sock exec#' "$FRANK_SH"
  echo "   frank.sh -> /run/es-franken.sock"
elif grep -q 'DAC_SOCKET=/run/es-franken.sock' "$FRANK_SH"; then
  echo "   frank.sh already patched"
else
  echo "   !! frank.sh line not found -- check $FRANK_SH manually"; exit 1
fi

echo "== 3. service =="
cp "$SRC/systemd/es-franken-proxy.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now es-franken-proxy.service
sleep 3

echo "== 4. restart frank so it dials the proxy =="
systemctl restart frank
echo "   waiting for the proxy to see frank connect..."
for i in $(seq 1 30); do
  sleep 3
  if journalctl -u es-franken-proxy --since "-20 s" -o cat | grep -q "frankenfirmware connected"; then
    echo "   frank connected through the proxy"; break
  fi
done

echo
echo "== status =="
systemctl is-active es-franken-proxy dac frank capybara | paste -sd' ' -
echo "Watch:  journalctl -u es-franken-proxy -f"
echo "HA gets: climate.eight_sleep_pod_left / _right, + water-low / priming binary sensors"
echo
echo "Rollback:  sudo bash $SRC/uninstall.sh   (or restore $FRANK_SH.orig and remove the unit)"

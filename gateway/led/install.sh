#!/bin/bash
# pod-es-led/install.sh -- run ON the Pod as root.
#
# Adds an MQTT light `light.eight_sleep_pod_led` that drives the Pod's front
# IS31FL3194 RGB LED (colour / brightness / effect). Runs alongside stock
# Capybara -- a slow re-assert loop wins because Capybara only writes the chip
# on a connectivity change. Effect "Auto" hands the LED back to Capybara.
#
#   tar czf - -C gateway/led --exclude=.git . | ssh -p 8822 rewt@<pod-ip> 'cat >/tmp/esled.tgz'
#   ssh -p 8822 rewt@<pod-ip>
#   sudo mkdir -p /tmp/esled && sudo tar xzf /tmp/esled.tgz -C /tmp/esled && sudo bash /tmp/esled/install.sh
set -euo pipefail
DEST=/opt/es-led
SRC="$(cd "$(dirname "$0")" && pwd)"
[ "$EUID" -eq 0 ] || { echo "run as root"; exit 1; }

echo "== 1. files + venv =="
mkdir -p "$DEST"
cp "$SRC/es_led.py" "$DEST/"
if [ ! -x "$DEST/venv/bin/python" ]; then
  if [ -x /opt/es-franken-proxy/venv/bin/python ]; then
    # reuse the franken-proxy venv's wheels if present (offline-friendly)
    python3 -m venv --system-site-packages "$DEST/venv"
  else
    python3 -m venv "$DEST/venv"
  fi
  "$DEST/venv/bin/python" -m ensurepip --upgrade >/dev/null 2>&1 || {
    curl -fsSL https://bootstrap.pypa.io/pip/pip.pyz -o /tmp/pip.pyz
    "$DEST/venv/bin/python" /tmp/pip.pyz install --upgrade pip
  }
fi
"$DEST/venv/bin/python" -c 'import paho.mqtt' 2>/dev/null || "$DEST/venv/bin/pip" -q install paho-mqtt
echo "   venv ok"

echo "== 2. service =="
cp "$SRC/systemd/es-led.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now es-led.service
sleep 3

echo
echo "== status =="
systemctl is-active es-led | paste -sd' ' -
journalctl -u es-led --since "-15 s" -o cat | tail -n 8
echo
echo "HA gets:  light.eight_sleep_pod_led  (rgb + brightness + effect)"
echo "Watch:    journalctl -u es-led -f"
echo "Rollback: sudo bash $SRC/uninstall.sh"

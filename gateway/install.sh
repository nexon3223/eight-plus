#!/bin/bash
# Eight+ Pod gateway — run ON the Pod as root (a Pod 3 on stock firmware, rooted; see README.md).
#
#   tar czf - -C eight-plus gateway | ssh -p 8822 rewt@<pod-ip> 'cat > /tmp/gw.tgz'
#   ssh -p 8822 rewt@<pod-ip>
#   sudo mkdir -p /tmp/gw && sudo tar xzf /tmp/gw.tgz -C /tmp/gw && sudo bash /tmp/gw/gateway/install.sh
#
# Writes /etc/eight-plus/gateway.conf (your MQTT broker) once, then installs, in order:
#   franken-proxy   local temperature control       (required)
#   biometrics-tap  presence, vitals, water temps    (recommended)
#   watchdog        health checks + self-repair      (recommended)
#   led             the Pod's front LED as a light   (optional: --with-led)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CONF=/etc/eight-plus/gateway.conf
WITH_LED=0
for a in "$@"; do [ "$a" = "--with-led" ] && WITH_LED=1; done
[ "$EUID" -eq 0 ] || { echo "run as root (sudo bash $0)"; exit 1; }

if [ ! -f "$CONF" ]; then
  echo "== MQTT broker (the one Home Assistant's MQTT integration uses) =="
  read -rp "  host [homeassistant.local]: " H; H="${H:-homeassistant.local}"
  read -rp "  port [1883]: " P; P="${P:-1883}"
  read -rp "  username (blank for none): " U
  PW=""
  if [ -n "$U" ]; then read -rsp "  password: " PW; echo; fi
  mkdir -p "$(dirname "$CONF")"
  umask 077
  printf 'MQTT_HOST=%s\nMQTT_PORT=%s\nMQTT_USER=%s\nMQTT_PASS=%s\n' "$H" "$P" "$U" "$PW" > "$CONF"
  chmod 600 "$CONF"
  echo "  wrote $CONF (root-only). Edit it and restart the es-* services to change broker."
else
  echo "== using existing $CONF =="
fi

run() { echo; echo "######## $1"; bash "$HERE/$1/install.sh"; }
run franken-proxy
run biometrics-tap
sh "$HERE/watchdog/install.sh"
[ "$WITH_LED" = 1 ] && run led

echo
echo "Done. In Home Assistant: Settings → Devices → MQTT → \"Eight Sleep Pod\"."
echo "Then open the Eight+ add-on — it detects the gateway automatically."

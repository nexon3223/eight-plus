#!/bin/bash
# es-franken-proxy/uninstall.sh -- back to pure stock dac<->frank. Run as root.
set -uo pipefail
FRANK_SH=/opt/eight/bin/frank.sh

systemctl disable --now es-franken-proxy.service 2>/dev/null || true
rm -f /etc/systemd/system/es-franken-proxy.service
rm -rf /opt/es-franken-proxy

if [ -f "$FRANK_SH.orig" ]; then
  cp "$FRANK_SH.orig" "$FRANK_SH"
  echo "restored $FRANK_SH"
else
  sed -i 's#DAC_SOCKET=/run/es-franken.sock exec#DAC_SOCKET=/deviceinfo/dac.sock exec#' "$FRANK_SH"
fi
rm -f /run/es-franken.sock
systemctl daemon-reload
systemctl restart frank
echo "done -- frank talks straight to dac again. Clear the MQTT climate entities from HA if you want them gone."

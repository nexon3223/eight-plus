#!/bin/sh
set -e
systemctl disable --now es-watchdog || true
rm -f /etc/systemd/system/es-watchdog.service /etc/systemd/journald.conf.d/es.conf
systemctl daemon-reload
systemctl restart systemd-journald
echo "removed (incident logs kept in /persistent/es-watchdog)"

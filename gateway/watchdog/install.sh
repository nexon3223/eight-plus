#!/bin/sh
# run ON the Pod as root (rewt has NOPASSWD sudo):  sudo sh install.sh
set -e
cd "$(dirname "$0")"
mkdir -p /opt/es-watchdog /persistent/es-watchdog/incidents /etc/systemd/journald.conf.d
cp es_watchdog.py /opt/es-watchdog/
cp systemd/es-watchdog.service /etc/systemd/system/
cp systemd/journald-es.conf /etc/systemd/journald.conf.d/es.conf
systemctl daemon-reload
systemctl restart systemd-journald
systemctl enable --now es-watchdog
systemctl restart es-watchdog
sleep 3
systemctl --no-pager status es-watchdog | head -12

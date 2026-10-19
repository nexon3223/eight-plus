#!/bin/bash
# es-biometrics-tap/install.sh -- run ON the Pod as root.
#
#   tar czf - -C gateway/biometrics-tap . | ssh rewt@pod 'cat > /tmp/tap.tgz'
#   ssh rewt@pod
#   sudo mkdir -p /tmp/tap && sudo tar xzf /tmp/tap.tgz -C /tmp/tap && sudo bash /tmp/tap/install.sh
#
# Read-only tap. Deploys free-sleep's biometrics signal-processing + a small
# MQTT publisher. Touches nothing in the Pod control path (dac / frank /
# capybara / swupdate / the .RAW files stay exactly as stock leaves them).
set -euo pipefail

DEST=/opt/es-biometrics-tap
SRC="$(cd "$(dirname "$0")" && pwd)"
DATA=/persistent/free-sleep-data
DB="$DATA/free-sleep.db"

[ "$EUID" -eq 0 ] || { echo "run as root"; exit 1; }

echo "== 1. files =="
mkdir -p "$DEST"
cp -r "$SRC/biometrics" "$DEST/biometrics"
cp "$SRC/es_bio_mqtt.py" "$DEST/es_bio_mqtt.py"

echo "== 2. venv + deps (Python $(python3 --version 2>&1 | awk '{print $2}')) =="
if [ ! -x "$DEST/venv/bin/python" ]; then
  python3 -m venv "$DEST/venv"
  "$DEST/venv/bin/python" -m ensurepip --upgrade 2>/dev/null || \
    curl -fsSL https://bootstrap.pypa.io/pip/pip.pyz -o /tmp/pip.pyz
  [ -f /tmp/pip.pyz ] && "$DEST/venv/bin/python" /tmp/pip.pyz install --upgrade pip
fi
"$DEST/venv/bin/pip" -q install --upgrade pip
# manylinux2014 wheels (glibc 2.17) cover this Pod's glibc 2.33 fine
"$DEST/venv/bin/pip" -q install numpy scipy pandas cbor2 watchdog paho-mqtt sentry-sdk
echo "   deps ok"

echo "== 3. data dir + settingsDB + sqlite schema =="
mkdir -p "$DATA/lowdb" "$DATA/logs"
[ -f "$DATA/lowdb/settingsDB.json" ] || \
  echo '{"id":"pod3-tap","left":{"name":"Left"},"right":{"name":"Right"}}' > "$DATA/lowdb/settingsDB.json"
"$DEST/venv/bin/python" - "$DB" <<'PY'
import sqlite3, sys
c = sqlite3.connect(sys.argv[1]); c.execute("PRAGMA journal_mode=WAL;")
c.executescript("""
CREATE TABLE IF NOT EXISTS sleep_records(
  id INTEGER PRIMARY KEY AUTOINCREMENT, side TEXT NOT NULL,
  entered_bed_at INTEGER NOT NULL, left_bed_at INTEGER NOT NULL,
  sleep_period_seconds INTEGER NOT NULL, times_exited_bed INTEGER NOT NULL,
  present_intervals TEXT NOT NULL, not_present_intervals TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS vitals(
  id INTEGER PRIMARY KEY AUTOINCREMENT, side TEXT NOT NULL, timestamp INTEGER NOT NULL,
  heart_rate REAL, hrv REAL, breathing_rate REAL);
CREATE TABLE IF NOT EXISTS movement(
  id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL,
  side TEXT NOT NULL, total_movement INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS vitals_side_ts   ON vitals(side, timestamp);
CREATE UNIQUE INDEX IF NOT EXISTS movement_side_ts ON movement(side, timestamp);
CREATE UNIQUE INDEX IF NOT EXISTS sleep_side_enter ON sleep_records(side, entered_bed_at);
""")
c.close(); print("   sqlite schema ok")
PY

echo "== 4. services =="
cp "$SRC/systemd/es-biometrics.service"      /etc/systemd/system/
cp "$SRC/systemd/es-biometrics-mqtt.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now es-biometrics.service
sleep 8
systemctl enable --now es-biometrics-mqtt.service

echo
echo "== status =="
systemctl is-active es-biometrics es-biometrics-mqtt | paste -sd' ' -
echo "vitals rows: $("$DEST/venv/bin/python" -c "import sqlite3;print(sqlite3.connect('$DB').execute('select count(*) from vitals').fetchone()[0])" 2>/dev/null || echo '?')"
echo
echo "DONE. HA should show new entities on the 'Eight Sleep Pod' device within a minute."
echo "Watch:  journalctl -u es-biometrics -u es-biometrics-mqtt -f"

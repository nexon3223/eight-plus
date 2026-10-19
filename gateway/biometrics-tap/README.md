# es-biometrics-tap

Read-only biometrics tap for an **Eight Sleep Pod 3 on 100% stock firmware**.

Stock frank streams raw piezo + capacitance data to `/persistent/*.RAW` (CBOR)
and uploads it to Eight's cloud. This tap runs free-sleep's biometrics
signal-processing over the *same* raw stream, locally, and publishes the
results to Home Assistant over MQTT — **without replacing `dac`, patching the
express server, or touching `frank` / `capybara` / `swupdate` / the `.RAW`
files.** If the tap crashes, the bed does not notice. Warranty, OTA and the
Eight app all keep working.

## What you get in HA

Per side (`left` / `right`), on the existing **Eight Sleep Pod** device:

| entity | from |
|---|---|
| heart rate (bpm) | piezo → free-sleep `BiometricProcessor` → SQLite `vitals` |
| HRV (ms) | ″ (needs ~5 min still) |
| breathing rate (br/min) | ″ |
| presence (occupancy) | `detect_presence` → `presence.json` |
| present for (min) | ″ |
| movement (30m) | `movement` table |
| water temp (°C) | `.RAW` `frzTemp` — the real heating-loop temp |

Device-wide: room temperature, room humidity, heatsink temp, control-board
temp, "sensor stream" running flag.

Not here (by design — cloud/app only): Eight's proprietary sleep *score* and
sleep stages. Your own sleep session / efficiency can be derived from the
presence + movement data.

For **temperature control**, install `../franken-proxy` (or just run `../install.sh`).

## Layout

```
biometrics/          vendored from throwaway31265/free-sleep, patched:
                       - stream.py: no 30s express-wait
                       - biometric_processor.py: writes presence.json (no express)
                       - get_logger.py: no :3000 lookup
                       - paths /home/dac/free-sleep -> /opt/es-biometrics-tap
es_bio_mqtt.py       SQLite + presence.json + .RAW tail  ->  MQTT discovery
systemd/             es-biometrics.service, es-biometrics-mqtt.service
install.sh           venv + deps + schema + services (run on the Pod as root)
```

## Install

```bash
tar czf - -C gateway/biometrics-tap --exclude=.git . | \
  ssh -p 8822 rewt@<pod-ip> 'cat > /tmp/tap.tgz'
ssh -p 8822 rewt@<pod-ip>
sudo mkdir -p /tmp/tap && sudo tar xzf /tmp/tap.tgz -C /tmp/tap && sudo bash /tmp/tap/install.sh
```

Verify: `journalctl -u es-biometrics -u es-biometrics-mqtt -f`, and check the
Eight Sleep Pod device in HA.

## Uninstall

```bash
sudo systemctl disable --now es-biometrics es-biometrics-mqtt
sudo rm /etc/systemd/system/es-biometrics*.service
sudo rm -rf /opt/es-biometrics-tap
sudo systemctl daemon-reload
# /persistent/free-sleep-data/ is left (harmless; delete if you want)
```

## Notes

- SQLite at `/persistent/free-sleep-data/free-sleep.db` (WAL). Schema matches
  free-sleep's prisma migrations so `analyze_sleep.py` etc. can run against it later.
- The MQTT publisher reads the DB `?mode=ro` — never locks it.
- `.RAW` files rotate (~one per hour) and the Pod uploads + deletes old ones;
  the tap always follows the newest.
- HRV is the slowest metric — 300 s window, needs the sleeper fairly still.

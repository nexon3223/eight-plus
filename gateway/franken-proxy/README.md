# es-franken-proxy

Local temp control for an **Eight Sleep Pod 3 on stock firmware**, without
replacing `dac` (which is what broke the Pod for two days).

Stock: `dac` binds `/deviceinfo/dac.sock`, `frankenfirmware` connects to it,
traffic is newline-framed request/response. This proxy sits in the middle:
`frankenfirmware -> /run/es-franken.sock (proxy) -> /deviceinfo/dac.sock (dac)`.
It relays every dac exchange verbatim and, between them, injects locally-queued
`HEAT_LEFT/RIGHT` + `LEVEL_LEFT/RIGHT` commands. `dac` still does cloud, the
heartbeat and telemetry, so the Eight app + warranty + `capybara` are untouched.

## HA entities (on the "Eight Sleep Pod" device, via MQTT)

- `climate.eight_sleep_pod_left` / `_right` — modes off / heat_cool, target 9–45 °C
  (level -100..100 mapped `°C = 27.00 + level*0.18`, from frank's own logs)
- `binary_sensor.eight_sleep_pod_water_low`, `_priming`

`current_temperature` = frank's live `heatLevelL/R` converted (the bed-surface
thermistors are dead, so there's no true surface temp — this is the control
level's °C). For real thermals use the tap's `*_water_temp` / `room_temperature`.

## Install

```bash
tar czf - -C gateway/franken-proxy --exclude=.git . | \
  ssh -p 8822 rewt@<pod-ip> 'cat > /tmp/fp.tgz'
ssh -p 8822 rewt@<pod-ip>
sudo mkdir -p /tmp/fp && sudo tar xzf /tmp/fp.tgz -C /tmp/fp && sudo bash /tmp/fp/install.sh
```

Edits one line of `/opt/eight/bin/frank.sh` (kept as `.orig`) and restarts
`frank` once. `uninstall.sh` reverses it.

## Risk

The proxy is in the frank<->dac path. `frankenfirmware` dials the socket only
at startup and never retries, so if the proxy restarts, frank is left
disconnected — the proxy's watchdog `systemctl restart frank`s once if it
doesn't see a connection within 60 s. `Restart=always` on the unit. If it ever
gets weird: `uninstall.sh` → straight back to stock.

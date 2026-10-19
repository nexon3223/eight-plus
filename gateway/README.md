# The Eight+ Pod gateway

The gateway is the local option for a **Pod 3 on stock firmware**. Eight Sleep's own software keeps running
(the official app, updates and the cloud keep working), and a few small services on the Pod publish it to
Home Assistant over MQTT.

| Service | What it does | Entities (MQTT discovery, "Eight Sleep Pod" device) |
|---|---|---|
| [`franken-proxy`](franken-proxy/) | Sits between `frankenfirmware` and `dac`, relays every exchange verbatim and injects locally-queued heat/level commands | `climate.eight_sleep_pod_left/right`, `binary_sensor.eight_sleep_pod_water_low`, `_priming`, prime, bed vibration |
| [`biometrics-tap`](biometrics-tap/) | Runs free-sleep's biometrics maths over the Pod's own raw sensor stream, read-only | presence, heart rate, HRV, breathing, water temperature per side, room temperature |
| [`watchdog`](watchdog/) | Health checks and a self-repair ladder | `sensor.eight_sleep_pod_health`, reboot / restart buttons, auto-repair switch |
| [`led`](led/) *(optional)* | The front LED as an RGB light | `light.eight_sleep_pod_front_led` |

> **Read this first.** The gateway needs **root on the Pod**, and modifies one line of the stock
> `frank.sh` (pointing it at the proxy's socket — `franken-proxy/uninstall.sh` restores it). Rooting your
> Pod is entirely your call and may void your warranty. Eight+ is not affiliated with Eight Sleep.

## Install

1. **Get root.** The process is the same one free-sleep uses: follow
   [free-sleep's installation guide](https://github.com/throwaway31265/free-sleep/blob/main/INSTALLATION.md)
   up to the point where you can SSH in (port 8822, user `rewt`), then stop — don't install the free-sleep
   server.
2. **Have an MQTT broker** that Home Assistant uses (the Mosquitto add-on is fine) and a user for the Pod.
3. **Copy and run the installer** from a computer with this repository checked out:

   ```bash
   tar czf - gateway | ssh -p 8822 rewt@<pod-ip> 'cat > /tmp/gw.tgz'
   ssh -p 8822 rewt@<pod-ip>
   sudo mkdir -p /tmp/gw && sudo tar xzf /tmp/gw.tgz -C /tmp/gw && sudo bash /tmp/gw/gateway/install.sh
   ```

   It asks for the broker once and keeps it in `/etc/eight-plus/gateway.conf` (root-only), then installs the
   proxy, the biometrics tap and the watchdog. Add `--with-led` for the LED. The Pod needs internet once,
   for Python packages.
4. In Home Assistant an **Eight Sleep Pod** device appears under MQTT. Open the Eight+ add-on — it detects
   the gateway by these unique IDs (renamed entities are fine): `eight_pod_ctl_{left,right}`,
   `eight_pod_bio_{side}_present` / `_heart_rate` / `_hrv` / `_breathing_rate` / `_water_temp`,
   `eight_pod_ctl_water_low`, `eight_pod_ctl_priming`, `eight_pod_ctl_prime`, `eight_pod_wd_health`,
   `eight_pod_led`.

Each folder also has its own `install.sh` / `uninstall.sh` and README if you'd rather do it piece by piece.

## Why it exists

free-sleep replaces the Pod's control software. On some Pods that path proved fragile (clock steps hanging
the firmware, heartbeat starvation). The gateway takes the lower-risk route: leave the stock stack in charge
and only listen — plus one narrow, auditable write path for temperature.

## Credits

`biometrics-tap/biometrics/` is vendored from [free-sleep](https://github.com/throwaway31265/free-sleep)
(MIT), which in turn adapts [HeartPy](https://github.com/paulvangentcom/heartrate_analysis_python) (MIT).
See [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

# The Eight+ Pod gateway

The gateway is the local option for a **Pod 3 on stock firmware**. Eight Sleep's own control software keeps
running on the Pod, and a few small services publish it to Home Assistant over MQTT.

> **The Eight Sleep app is not supported.** It doesn't work on the maintainer's Pod, and it hasn't been tested on
> a Pod that's still paired to an Eight Sleep account. Home Assistant is how you control the bed.

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
3. **Download and run the installer on the Pod.** Every [release](https://github.com/nexon3223/eight-plus/releases)
   has the gateway attached as `eight-plus-gateway.tar.gz`. SSH in, then:

   ```bash
   curl -fsSL https://github.com/nexon3223/eight-plus/releases/latest/download/eight-plus-gateway.tar.gz -o /tmp/gw.tgz
   sudo mkdir -p /tmp/gw && sudo tar xzf /tmp/gw.tgz -C /tmp/gw && sudo bash /tmp/gw/gateway/install.sh
   ```

   For a specific version, swap `latest/download` for `download/v0.1.2` (or whichever tag). From a computer with
   this repository checked out you can copy it over instead:
   `tar czf - gateway | ssh -p 8822 rewt@<pod-ip> 'cat > /tmp/gw.tgz'`, then run the second line on the Pod.

   It asks for the broker once and keeps it in `/etc/eight-plus/gateway.conf` (root-only), then installs the
   proxy, the biometrics tap and the watchdog. Add `--with-led` for the LED. The Pod needs internet once,
   for Python packages.
4. In Home Assistant an **Eight Sleep Pod** device appears under MQTT. Open the Eight+ add-on — it detects
   the gateway by these unique IDs (renamed entities are fine): `eight_pod_ctl_{left,right}`,
   `eight_pod_bio_{side}_present` / `_heart_rate` / `_hrv` / `_breathing_rate` / `_water_temp`,
   `eight_pod_ctl_water_low`, `eight_pod_ctl_priming`, `eight_pod_ctl_prime`, `eight_pod_wd_health`,
   `eight_pod_led`.

Each folder also has its own `install.sh` / `uninstall.sh` and README if you'd rather do it piece by piece.

## How this differs from installing free-sleep

Getting root is identical. Everything after you can SSH in is different, because free-sleep **replaces** the
Pod's control software and the gateway **keeps** it.

| | free-sleep | Eight+ gateway |
|---|---|---|
| Getting root (SD-card image, SSH on 8822 as `rewt`) | Its installation guide | **The same guide, same steps** |
| After SSH | Runs free-sleep's `install.sh` (Node server, web UI) | Stop. Run `gateway/install.sh` instead |
| Stock `dac` (Eight's cloud client) | Stopped and replaced — free-sleep takes over `dac.sock` | **Left running.** The proxy sits between it and `frankenfirmware` |
| `frank`, `capybara` | Left running, but `capybara`'s heartbeat is no longer fed by `dac` | **Untouched.** Don't stop, disable or mask them |
| Stock files changed | Several | One line of `/opt/eight/bin/frank.sh` (backed up as `.orig`) |
| Internet on the Pod | Its guide has you block it | Needed once, for Python packages |
| Undo | Reflash | `uninstall.sh` in each folder |

Things that catch people out:

- **Don't follow scripts that "disable dac / frankenfirmware / capybara".** Some rooting write-ups include that
  step for free-sleep. With the gateway those services *are* the bed. If `dac` stops, `capybara` sees a stale
  heartbeat and power-cycles the Pod's thermal controller every ~30 seconds.
- **Already running free-sleep?** Remove it and re-enable the stock `dac` first. The two can't share `dac.sock`.
- **A recovery reflash (holding the button) wipes `/persistent`** — your Pod-side history and settings go with it.
- **A firmware update from Eight Sleep may remove the gateway.** The installer leaves Eight Sleep's updater
  (`swupdate`) running, and the gateway hasn't been tested with an update. An update that replaces the Pod's
  system files would most likely revert `frank.sh` and remove the `es-*` services, and possibly root access too.
  If the MQTT entities go unavailable after an update, SSH in, check `systemctl status es-franken-proxy` and
  re-run `install.sh`. If the update also wiped `/etc/eight-plus/gateway.conf`, it asks for your broker
  again. If root is gone, you'd have to root the Pod again.
- **Pod 3 Wi-Fi is WPA2 only.** On a WPA3 network the Pod sees no networks and hangs on "connecting".

## Why it exists

free-sleep replaces the Pod's control software. On some Pods that path proved fragile (clock steps hanging
the firmware, heartbeat starvation). The gateway takes the lower-risk route: leave the stock stack in charge
and only listen — plus one narrow, auditable write path for temperature.

## Credits

`biometrics-tap/biometrics/` is vendored from [free-sleep](https://github.com/throwaway31265/free-sleep)
(MIT), which in turn adapts [HeartPy](https://github.com/paulvangentcom/heartrate_analysis_python) (MIT).
See [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

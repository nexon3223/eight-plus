# pod-es-led

Customise the **Eight Sleep Pod 3 front status LED** (colour · brightness · animation)
from Home Assistant.

## What it is

The front LED is a **Lumissil IS31FL3194** 3-channel RGB driver on `/dev/i2c-1 @ 0x53`.
Stock `Eight.Capybara` drives it from connectivity state (green = online, blue =
connecting) but only writes the chip **on a state change** — in steady state it never
touches the I2C bus. `es-led` runs a slow (~2 s) re-assert loop that wins without
masking or restarting Capybara or anything else.

`es-led` publishes one MQTT-discovery light on the existing **Eight Sleep Pod** device:

    light.eight_sleep_pod_front_led   — rgb colour, brightness, effect

Effects: **Solid · Breathe · Pulse · Rainbow · Candle · Strobe · Auto**.
`Auto` software-shuts-down our override and hands the LED back to Capybara's
connectivity indicator. State persists across restarts in `/opt/es-led/state.json`.

## Hardware notes (reverse-engineered 2026-09-10)

* **Only RGB _pattern_ mode responds** on this board. Single / current-level mode
  (`0x01=0x01`, regs `0x10/0x21/0x32`) does nothing — pattern mode (`0x01=0x7d`) works.
* **Channel → colour: OUT1 = Blue (reg `0x10`), OUT2 = Red (`0x11`), OUT3 = Green (`0x12`).**
* Solid colour = P1 Color1 + `0x04=0x09` (hold at end of T2) + `0x40/0x41 = 0xC5`.
* Breathe = pattern T1/T2/T3/T4 timing, loop endless, `0x04=0x00`.
* `lb` in `settings.cbr` is **not** this LED (that's a piezo/other setting).

## Install

```sh
tar czf - -C gateway/led --exclude=.git . | ssh -p 8822 rewt@<pod-ip> 'cat >/tmp/esled.tgz'
ssh -p 8822 rewt@<pod-ip>
sudo mkdir -p /tmp/esled && sudo tar xzf /tmp/esled.tgz -C /tmp/esled && sudo bash /tmp/esled/install.sh
```

Rollback: `sudo bash /tmp/esled/uninstall.sh`

## Files

| path | what |
|---|---|
| `es_led.py` | the daemon (IS31FL3194 driver + effect engine + MQTT) |
| `systemd/es-led.service` | runs it as root, `Restart=always` |
| `install.sh` / `uninstall.sh` | deploy / remove on the Pod |

# Eight+

Open **Eight+** in the sidebar after starting the add-on — setup happens there, not on this page.

## What the setup does

1. Finds your Pod (Eight Sleep cloud, free-sleep or the Eight+ Pod gateway) in the entity registry.
2. Asks who sleeps where, your weekday/weekend routine, which room sensors Autopilot may use, and which features you want.
3. Shows you every helper, automation and file it will create — nothing changes until you press **Install**.
4. Backs up `configuration.yaml` to `eight_plus_backups/<time>/`, writes `packages/eight_plus/*.yaml` and
   `custom_templates/eight_plus.jinja`, and (only if packages weren't on yet) adds
   `packages: !include_dir_named packages` under `homeassistant:`.
5. Has Home Assistant check the configuration — **if the check fails, everything is rolled back**.
6. Restarts Home Assistant once, sets your schedule, installs the card and creates the **Eight+** dashboard.

## Options

| Option | |
|---|---|
| `backfill_days` | Days of Home Assistant history to turn into sleep reports on first start (your recorder keeps 10 by default). |
| `mqtt_host` … `mqtt_password` | Only if your MQTT broker is **not** the Mosquitto add-on. With no broker at all, sleep reports are written straight into Home Assistant instead. |

## The Pod app (port 8098)

Off until you switch it on in the panel. Then `http://<your-home-assistant>:8098` serves the card as a
full-screen app — on an iPhone, open it in Safari → Share → **Add to Home Screen**. It needs no login, so
anyone on your network can use it; its proxy only forwards the bed's own entities and services, never
the rest of your house. To expose it on a different host port, change it under **Network** above.

## Sleep data sources

- **From Home Assistant** (default, every backend) — samples heart rate, HRV, breathing and a debounced
  bed presence once a minute.
- **Straight from the Pod (SSH)** — for free-sleep and gateway Pods with SSH. Reads the Pod's own
  `free-sleep.db`: denser vitals, movement and (gateway) capacitance presence. The panel generates a key
  and shows the line to add to the Pod's `~/.ssh/authorized_keys`.

## Files Eight+ owns

`packages/eight_plus/`, `custom_templates/eight_plus.jinja`, `www/eight_plus/`, the `eight-plus` dashboard,
and (if HACS doesn't provide the card) one Lovelace resource. **Uninstall** in the panel removes all of them.
Anything you want to customise, copy out of `packages/eight_plus/` first — that folder is rewritten on update.

## Troubleshooting

- **"Can't wire packages automatically"** — your `packages:` is an inline map or a single `!include`.
  Switch it to `packages: !include_dir_named packages` (move each inline package into its own file in
  `/config/packages/`, named after the package), check the config, and run the setup again.
- **An entity "already exists"** — you have hand-made helpers with the same names (e.g. from following the
  card's DEV-NOTES). Use a different name in the People step.
- **Sleep reports say "no sleep block found"** — the night had too little presence/vitals data; check the
  Pod's biometrics are on (free-sleep: the Biometrics switch).
- Logs: the **Log** tab of this add-on.

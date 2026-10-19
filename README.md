# Eight+ for Home Assistant

**Your Eight Sleep Pod, run by your home.** A full Pod app inside Home Assistant — a photo-real reactive bed, a weather-aware Smart Autopilot, nightly sleep reports, a bedtime coach and a no-login app for every phone in the house — installed by a guided setup that takes about three minutes.

Works with any of the three ways a Pod can talk to Home Assistant:

| | **Eight Sleep cloud** | **free-sleep** | **Eight+ Pod gateway** |
|---|---|---|---|
| What it is | The Pod as it came, via Eight Sleep's servers | Community firmware on the Pod | Stock firmware + local services that publish over MQTT |
| Needs | lukas-clarke's [`eight_sleep`](https://github.com/lukas-clarke/eight_sleep) integration (HACS) + your Eight Sleep login | [free-sleep](https://github.com/throwaway31265/free-sleep) on the Pod + Mrtenz's [hass-free-sleep](https://github.com/Mrtenz/hass-free-sleep) integration | A rooted Pod 3 + the services in [`gateway/`](gateway/) (included) |
| Pods | Pod 3, 4, 5 (whatever the app supports) | Pod 3, 4, 5 (whatever free-sleep supports) | Pod 3 |
| Control | Cloud (a few seconds of lag) | Local, instant | Local, instant |
| Sleep reports | ✓ | ✓ | ✓ (highest fidelity) |
| Pod health, water temps, bed vibration | – | – | ✓ |

> Not affiliated with, endorsed by or supported by Eight Sleep. "Eight Sleep" and "Pod" are their trademarks. Using community firmware or rooting your Pod may void your warranty — that part is entirely your call; Eight+ itself never touches the Pod.

---

## What you get

- **The Eight+ card** — the whole app in one Lovelace card: Home (the bed glowing with its temperature, dual-zone control, boost, pre-cool), Schedule, Autopilot, Sleep, Coach and Settings tabs.
- **Smart Autopilot** — seven overnight temperature phases that move with the outside forecast, your bedroom's temperature and humidity, the season and how fast the bed is actually heating. Every input can be switched off; every offset is a helper you can tune.
- **Sleep reports** — a 0–100 score, time asleep, efficiency, resting heart rate, HRV, breathing, an estimated hypnogram and 30 nights of history, computed on your own Home Assistant box. No subscription. On first start it reads back through your recorder history, so last night's report usually appears within minutes.
- **Sleep Coach** (optional) — picks tonight's bedtime from your sleep debt, nudges you (three messages, then silence), and runs a wake-up that escalates — heat, alerts, a cold snap, bed vibration on the gateway — until the bed says you're really up.
- **Notifications** (optional) — bed ready, goodnight, good morning with your score, water low, with one-tap Warmer / Cooler / Boost buttons.
- **The Pod app** (optional) — the card as a full-screen app for phones on your Wi-Fi, no Home Assistant login. Its proxy is scoped to the bed: it can't see or touch anything else in your house.
- **Solo or two sleepers** — each person gets their own schedule, Autopilot, coach and reports; in Solo one schedule drives the whole bed.

Everything Eight+ creates is ordinary Home Assistant config you can read: helpers, template sensors, scripts and automations in `packages/eight_plus/`, and one dashboard.

---

## Install

You need Home Assistant OS or Supervised (for the add-on), and your Pod already working in Home Assistant through one of the three connections above.

### 1. Add the Eight+ add-on

[![Open your Home Assistant instance and show the add add-on repository dialog.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FYOUR_GITHUB_USER%2Feight-plus)

Or: **Settings → Add-ons → Add-on store → ⋮ → Repositories**, add `https://github.com/YOUR_GITHUB_USER/eight-plus`, then install **Eight+** and start it.

### 2. Open Eight+ from the sidebar and follow the setup

1. **Connect** — Eight+ finds your Pod (it matches each integration's own IDs, so renamed entities are fine) and shows you exactly which entities it'll use. Anything missing can be picked by hand.
2. **People** — just you, or two of you; tap your half of the bed; pick a phone for notifications.
3. **Routine** — weekday and weekend bedtime and wake. The seven Autopilot phases are laid out across your night.
4. **Your room** — weather, bedroom temperature and humidity sensors (auto-suggested), and an optional wind-down scene.
5. **Features** — Smart Autopilot, sleep reports, Sleep Coach, notifications, the Pod app.
6. **Review** — every number and every file Eight+ will write, before anything happens. Then **Install**.

Eight+ backs up `configuration.yaml`, writes its package, has Home Assistant **check the config** (and rolls straight back if it fails), restarts once, sets your schedule, installs the card and builds an **Eight+** dashboard.

### 3. (Recommended) Get card updates through HACS

The add-on installs a bundled copy of the card so everything works immediately. To get card updates automatically, add this same repository to HACS as a **Dashboard** repository — Eight+ notices and switches to the HACS copy on its next update:

**HACS → ⋮ → Custom repositories** → `https://github.com/YOUR_GITHUB_USER/eight-plus`, category **Dashboard** → download **Eight+ card**.

<details>
<summary>Just the card, no add-on (Home Assistant Container / Core, or hand-built setups)</summary>

Install the card from HACS as above, then add it to a dashboard:

```yaml
type: custom:eight-sleep-card
layout: v2
source: cloud                # cloud | freesleep | gateway
entity: climate.alex_s_eight_sleep_side_climate
```

`source:` fills in every entity for that backend from the one `entity` you give it:

| `source` | `entity` example | Filled in |
|---|---|---|
| `cloud` | `climate.alex_s_eight_sleep_side_climate` | bed temperature, bed state, side, next alarm — `sensor.alex_s_eight_sleep_side_*` |
| `freesleep` | `climate.pod_4_right_temperature` | presence, vitals, water, priming, prime, partner side — `pod_4_*` |
| `gateway` | `climate.eight_sleep_pod_left` | presence, vitals, water temps, Pod health, partner side |

Point a second card at the other side's climate entity for a two-sleeper bed. The Autopilot, schedule and coach features need their helpers and automations — the add-on generates them; without it, features whose entities don't exist simply hide. Every option is documented at the top of `eight-sleep-card.js`.
</details>

---

## After install

The **Eight+** panel in the sidebar becomes a home screen: connection status, recent sleep scores, a **Run now** for the sleep reports, the Pod app switch, **View YAML**, **Change setup** (re-runs the wizard with your answers filled in) and **Uninstall**.

- **Changing things** — use the card. Times, temperatures, Autopilot tuning and coach targets are all helpers; the card edits them and Eight+ never overwrites a value you've changed.
- **Updating** — when a new add-on version changes Eight+'s YAML, the panel says so and **Apply update** rewrites the package (your helper values, schedules and history stay).
- **Customising an automation** — copy it out of `packages/eight_plus/` into your own automations and switch the original off. Files in `packages/eight_plus/` belong to Eight+ and are rewritten on update.
- **Uninstalling** — removes the package, the Jinja model, the dashboard and the card resource Eight+ added. Backups in `eight_plus_backups/` and your sleep history stay.

## Where your data goes

Nowhere. Sleep reports are computed inside the add-on from what your Pod already reports to Home Assistant (or, optionally, straight from the Pod over SSH) and published back to Home Assistant — over MQTT when you have a broker, otherwise directly. The only network traffic is between the add-on, your Home Assistant and (if you choose SSH) your Pod.

## How it works

```
                    ┌──────────────── Home Assistant ────────────────┐
 Pod ──(cloud │ free-sleep │ gateway)──▶ climate · presence · vitals │
                    │                                                 │
                    │  packages/eight_plus/   helpers · Autopilot     │
                    │                         sensors · automations   │
                    │  Eight+ dashboard  ◀──  custom:eight-sleep-card │
                    └───────────▲───────────────────────▲─────────────┘
                                │ WS (Supervisor)       │ MQTT / REST
                    ┌───────────┴─── Eight+ add-on ─────┴─────────────┐
                    │ setup wizard (ingress)   sleep pipeline         │
                    │ Pod app :8098 (scoped)   collector → rollup →   │
                    └─────────────────────────────────── publish ─────┘
```

- **Detection** reads the entity registry and matches each integration's unique-ID scheme.
- **The generator** turns your answers into one package per sleeper (+ one for the bed) from templates in `eight_plus/app/generator/templates/`. `tests/test_generator.py` renders every backend × solo/couple × feature mix and checks the YAML parses, every Jinja template compiles, and the Autopilot model returns sane numbers.
- **The pipeline** samples each sleeper's heart rate, HRV, breathing and a debounced bed presence once a minute, segments the night, estimates stages and scores it. Checked against the high-fidelity raw-data pipeline over ten real nights, the median score difference is 6 points.

## Development

```bash
pip install pyyaml jinja2
python3 tests/test_generator.py              # offline: every combination, YAML + Jinja + model
python3 tests/test_detect.py                 # backend detection against each integration's unique IDs
python3 -m http.server 8780                  # then open /tools/preview.html?source=cloud|freesleep|gateway
                                             # — the card against a mock Home Assistant, no HA needed
echo 'HA_URL=http://homeassistant.local:8123' > .dev.env   # gitignored
echo 'HA_TOKEN=<long-lived token>'           >> .dev.env
tools/dev.sh                                 # the panel on :8099 against your real HA, DRY RUN:
                                             # reads are real, every write is logged and skipped
```

The card and the gateway are developed in the maintainer's own repos and published here by
`tools/sync_card.py` and `tools/sync_gateway.py`, which swap one household's entity names and
credentials for generic ones and refuse to write if any survive.

## Credits

The card, Autopilot model, sleep pipeline and gateway grew out of one person's very over-engineered bed. free-sleep's biometrics work (throwaway31265 and contributors), hass-free-sleep (Mrtenz) and the `eight_sleep` integration (lukas-clarke, and the original Home Assistant core integration) made the Pod reachable in the first place.

MIT licensed — see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

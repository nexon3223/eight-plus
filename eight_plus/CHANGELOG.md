# Changelog

## 0.1.4

- Each sleeper's bed-temperature sensor now carries their name, side and phone, so the Eight+ iPhone
  app can set itself up. Press **Apply update** in the Eight+ panel.

### iOS app (attached to this release)

- **Half-degree control.** On the Pod 3 gateway and free-sleep, the dials, + / − and the schedule move in
  0.5° steps. The Eight Sleep cloud integration only takes whole degrees, so the app steps by 1° there: it
  follows each bed's own step from Home Assistant.
- **Shows what the bed holds.** A half you pick shows as that half; a target Autopilot set shows as the bed
  holds it ("26.3°"), the same number Home Assistant shows. The Autopilot toast, widgets, Control Centre and
  the Live Activity match too.
- **In-between colours.** 27° is purple; half a degree off it is purple leaning blue or orange.
- **Fixes:** the Pre-cool / Pre-heat + and − buttons now respond; the Schedule says "Alarm off" instead of a
  next alarm that won't ring; the compact temperature block steps like the big one.
- Smart wake is gone from the Schedule (the Pod can't tell light sleep), Snooze is a button on the phone's
  alarm card, and the vibration pattern offers only what the Pod has (Rise, Pulse).

## 0.1.3

- **One bed everywhere.** The card always shows the photo bed with the Tide dot field. The older drawn bed is
  gone, and the bed art is now built into the card, so a HACS-only install (no `bed_image` set) gets the same
  bed as the app's dashboard.
- The bed glow follows a tuned, rounded mattress outline.
- **Installs in seconds.** Home Assistant now downloads a ready-built app image from ghcr.io instead of building
  it on your machine.
- The Pod gateway is attached to every release as `eight-plus-gateway.tar.gz`, so the Pod can download it directly.

## 0.1.2

- The home panel no longer shows **Recent sleep scores** (it was empty on a fresh install).
- Docs: sleep reports are marked experimental, and full third-party licence texts are included.

## 0.1.1

- **Fix: the add-on couldn't talk to Home Assistant when installed from the store** ("Invalid access
  token"). The add-on image's init system started Eight+ without the Supervisor token in its
  environment; it now runs under `with-contenv` and also reads the token from the container
  environment directly.
- The **Eight+** entry now shows in the sidebar as soon as the add-on is installed (it was off by default).
- **Sleep Coach is deprecated.** Setup no longer offers it and never generates it, even from older
  saved answers — re-running setup removes its helpers, automations and the card's Coach tab.
- New setup look: a minimal, dark, purple one-question-per-screen flow with the 8+ mark.
- **Fix: °F Home Assistant systems.** Eight+ works in °C, but HA's climate entities speak the
  system unit — so on a °F system every schedule/Autopilot write (e.g. "32") reached the Pod as
  32 °F and was clamped to the coldest setting. Setup now records the unit, the generated
  automations convert at every climate write and read (and the Autopilot model converts weather
  and room temperatures), and the card does the same. °C installs are unchanged. Changing HA's
  unit system later shows up as an update on the Eight+ panel.
- free-sleep: the Connect step now only asks you to turn Biometrics on when it's actually off,
  warns when free-sleep's own Away mode is on (it makes free-sleep drive both sides together), and
  reminds you to switch off free-sleep's own schedules so they don't fight Eight+.
- New end-to-end test (`tests/e2e/`): a stand-in free-sleep Pod + a real Home Assistant with the
  real hass-free-sleep integration, through install, bedtime, buttons, presence and reports.

## 0.1.0

First release.

- Guided setup: backend detection (Eight Sleep cloud, free-sleep, Eight+ Pod gateway), one or two
  sleepers, routine, room sensors, features, a full review of every file before install.
- Generates helpers, template sensors, scripts and automations as one package per sleeper — schedule,
  Smart Autopilot, auto-off, off-when-up, boost failsafe, sunrise light, away mode and notifications.
- Config check before restart with automatic rollback; first-run values are set once and never overwritten.
- Sleep reports pipeline in the add-on: HA-sensor or SSH source, recorder backfill, nightly rollup,
  MQTT discovery or REST publishing.
- Optional no-login Pod app on port 8098 with an entity-scoped proxy.
- Bundled card, or the HACS copy when present.
- Three backends: Eight Sleep cloud (lukas-clarke's `eight_sleep`), free-sleep (Mrtenz's `hass-free-sleep`,
  any Pod model or side name) and the Eight+ Pod gateway.
- The Pod gateway's services ship in `gateway/` with a one-shot installer (MQTT broker kept in
  `/etc/eight-plus/gateway.conf`).
- Card v10.43: `source:` + `entity` alone configures a card on any backend; `tools/preview.html` renders it
  against a mock Home Assistant.

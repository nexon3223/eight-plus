# Changelog

## Unreleased

- **Sleep Coach is deprecated.** Setup no longer offers it and never generates it, even from older
  saved answers — re-running setup removes its helpers, automations and the card's Coach tab.
- New setup look: a minimal, dark, purple one-question-per-screen flow with the 8+ mark.

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

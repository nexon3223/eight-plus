/*
 * Eight+ card — an Eight Sleep Pod app for Home Assistant.
 * https://github.com/YOUR_GITHUB_USER/eight-plus  ·  MIT licence
 *
 *   type: custom:eight-sleep-card
 *   source: cloud               # cloud | freesleep | gateway — fills in every entity for that backend
 *   entity: climate.alex_s_eight_sleep_side_climate   # this side's climate entity
 *   schedule_prefix: eight_sleep_alex   # the helpers the Eight+ add-on created for this sleeper
 *   layout: v2
 *
 * Without the Eight+ add-on, any feature whose entities don't exist simply hides.
 * Every option is listed in setConfig() below; the add-on writes a complete config for you.
 *
 * Not affiliated with Eight Sleep. "Eight Sleep" and "Pod" are their trademarks.
 */

const HELP = "%c EIGHT-SLEEP-CARD %c v10.43 ";

// ── Connectors ──────────────────────────────────────────────────────────────────
// The card is backend-agnostic: every entity it touches comes from config. `source:`
// picks a preset entity map so a whole backend swaps with one keyword.
//   source: "cloud"      (default) — the Eight Sleep cloud integration (grantnedwards/eight-sleep):
//                        climate.<side>_climate + sensor.<side>_bed_* + eight_sleep.* services.
//                        These are the inline defaults in setConfig(); CONNECTORS.cloud is empty.
//   source: "free_sleep" — the LOCAL stock-firmware path (name kept for back-compat). The Pod
//                        runs 100% stock firmware; a transparent frankenfirmware<->dac proxy
//                        (gateway/franken-proxy) + a read-only biometrics tap (gateway/biometrics-tap)
//                        publish MQTT-discovery entities under the "Eight Sleep Pod" device:
//                        climate.eight_sleep_pod_{left,right} (real off/heat_cool),
//                        binary_sensor.eight_sleep_pod_{left,right}_presence / _water_low / _priming,
//                        sensor.eight_sleep_pod_{left,right}_{heart_rate,hrv,breathing_rate}.
//                        No cloud, no subscription, real-time. (hass-free-sleep is gone; the old
//                        climate.pod_3_* entities are dead.) See
// The Autopilot / schedule / smart / boost / auto-off helper set, weather, room sensors, Dyson
// AQI and underglow are all backend-independent — they stay on the cloud-path defaults for both.
// FLIP-BACK: set `source: cloud` (or drop it) on every card instance and reverse the
// climate-entity swap in the ~8 HA automations — see DEV-NOTES.md "Connectors / flip-back".
const CONNECTORS = {
  cloud: {},
  free_sleep: {
    // left side is the preset default; a right-side card overrides entity + partner_climate_entity
    // + schedule_prefix + own_side, exactly as the cloud right-side card does today.
    entity: "climate.eight_sleep_pod_left",
    partner_climate_entity: "climate.eight_sleep_pod_right",
    // the franken proxy has no surface-thermistor sensor — the climate entity's own
    // current_temperature attr (heat-level -> C) is the live reading; _curTemp() falls back to it.
    current_temp_entity: "climate.eight_sleep_pod_left",
    // no bed-state sensor (target-level / heating-active / time-remaining) — the card degrades
    // to the climate hvac_action for the warm/cool/working state and drops the countdown ring.
    bed_state_entity: false,
    partner_bed_state_entity: false,
    // climate.eight_sleep_pod_* advertises target_temp_step 0.5, so half-degrees go straight
    // through climate.set_temperature — no raw-level eight_sleep.heat_set detour.
    // CAVEAT (verified live 2026-09-19): the step it advertises is not the step the Pod keeps.
    // The Pod stores its setpoint in whole °F (~0.56 °C), so the command lands on ITS grid and
    // the read-back is never the number that was sent: 23.5 -> 23.6, 24.0 -> 23.9, 24.5 -> 24.5.
    // Two consequences the code below has to respect: never compare a written target to the
    // read-back for equality, and never treat a sub-0.5° delta as "nothing happened".
    half_degree_via_heat_set: false,
    // priming / water are on/off binary_sensors. water_low is a device_class:problem sensor:
    // on = LOW water (inverted vs the cloud has_water sensor).
    priming_entity: "binary_sensor.eight_sleep_pod_priming",
    need_priming_entity: false,
    last_prime_entity: false,
    has_water_entity: "binary_sensor.eight_sleep_pod_water_low",
    has_water_invert: true,
    // no prime control on the local proxy — hide the Prime action
    prime_target_entity: false,
    prime_button_entity: false,
    // no next-alarm entity on the local path
    alarm_entity: false,
    // two independent climate entities, no bed-side ("solo/left/right") concept. UNLIKE the old
    // pod_3_* path, climate.eight_sleep_pod_* DOES report a real "off", so the cloud-style
    // climate on/off + turn_on/turn_off logic works natively — no per-side Away switch needed.
    side_state_entity: false,
    partner_side_entity: false,
    away_entity: false,
    partner_away_entity: false,
    // Solo/Dual is not a hardware concept here (two independent water circuits), so a helper
    // holds it: OFF = Solo (the whole bed tracks this side's setpoint — writes fan out to BOTH
    // climate.eight_sleep_pod_{left,right}); ON = Dual (each side independent).
    dual_mode_entity: "input_boolean.eight_plus_dual_mode",
    // read-only biometrics tap (stock RAW CBOR stream -> HA MQTT); no on/off toggle for it
    presence_entity: "binary_sensor.eight_sleep_pod_left_presence",
    partner_presence_entity: "binary_sensor.eight_sleep_pod_right_presence",
    heart_rate_entity: "sensor.eight_sleep_pod_left_heart_rate",
    hrv_entity: "sensor.eight_sleep_pod_left_hrv",
    breath_rate_entity: "sensor.eight_sleep_pod_left_breathing_rate",
    // partner side's vitals — v2 Home's Dual "Live vitals" shows both halves (v10.14)
    partner_heart_rate_entity: "sensor.eight_sleep_pod_right_heart_rate",
    partner_hrv_entity: "sensor.eight_sleep_pod_right_hrv",
    partner_breath_rate_entity: "sensor.eight_sleep_pod_right_breathing_rate",
    biometrics_toggle_entity: false,
    // nightly sleep-statistics pipeline (gateway/sleep-pipeline: collector -> rollup -> publish).
    // The score sensor carries the whole night as attributes (stage runs, moments, 7 compact
    // nights, 30-night history, personal ranges) so the Sleep tab renders with no HA recorder.
    // v10.25: the tap's RIGHT sensors carry this card's own sleeper, so
    // "self" reads right and the partner reads left — the opposite of the climate halves.
    sleep_score_entity: "sensor.eight_sleep_pod_left_sleep_score",
    partner_sleep_score_entity: "sensor.eight_sleep_pod_right_sleep_score",
    // v10.26: bed water temperature per climate half (state_class measurement -> hourly
    // statistics), for the Sleep Month view's "temperature sweet spot"
    water_temp_entity: "sensor.eight_sleep_pod_left_water_temp",
    partner_water_temp_entity: "sensor.eight_sleep_pod_right_water_temp",
    // v10.33: the on-Pod es-watchdog (gateway/watchdog). One enum sensor whose attributes carry
    // every check (units, Frozen/Sensor MCUs, control link, heartbeat, clock, MQTT...), plus
    // its repair buttons. Drives the Home status light, Settings > Restart Pod, Dev > services.
    health_entity: "sensor.eight_sleep_pod_health",
    reboot_entity: "button.eight_sleep_pod_reboot",
    restart_control_entity: "button.eight_sleep_pod_restart_control",
    auto_repair_entity: "switch.eight_sleep_pod_auto_repair",
    // v10.34: thermal headroom reads the Pod's OWN room sensor — the air its heatsink dumps into
    headroom_room_entity: "sensor.eight_sleep_pod_room_temperature",
  },
};

// v10.38 — public connector names (the Eight+ installer writes these):
//   source: "gateway"   = the stock-firmware MQTT gateway above. "free_sleep" stays as a legacy
//                         alias for it (every existing card config uses that spelling).
//   source: "freesleep" = the real free-sleep firmware via the hass-free-sleep integration
//                         (Mrtenz): climate.pod_3_*_temperature + its binary sensors / buttons.
CONNECTORS.gateway = CONNECTORS.free_sleep;
CONNECTORS.freesleep = {
  entity: "climate.pod_3_left_temperature",
  partner_climate_entity: "climate.pod_3_right_temperature",
  current_temp_entity: "climate.pod_3_left_temperature",
  bed_state_entity: false,
  partner_bed_state_entity: false,
  half_degree_via_heat_set: false,
  priming_entity: "binary_sensor.pod_3_priming",
  need_priming_entity: false,
  last_prime_entity: false,
  has_water_entity: "binary_sensor.pod_3_water_level",   // device_class problem: on = LOW
  has_water_invert: true,
  prime_target_entity: false,
  prime_button_entity: "button.pod_3_prime",
  alarm_entity: false,
  side_state_entity: false,
  partner_side_entity: false,
  dual_mode_entity: "input_boolean.eight_plus_dual_mode",   // created by the Eight+ installer
  presence_entity: "binary_sensor.pod_3_left_presence",
  partner_presence_entity: "binary_sensor.pod_3_right_presence",
  heart_rate_entity: "sensor.pod_3_left_heart_rate",
  hrv_entity: "sensor.pod_3_left_hrv",
  breath_rate_entity: "sensor.pod_3_left_respiration_rate",
  partner_heart_rate_entity: "sensor.pod_3_right_heart_rate",
  partner_hrv_entity: "sensor.pod_3_right_hrv",
  partner_breath_rate_entity: "sensor.pod_3_right_respiration_rate",
  biometrics_toggle_entity: "switch.pod_3_biometrics",
  dev_view: false,
};

// Public build: a preset is written for the left side of a "Pod 3". _presetFor() re-points it at
// the configured `entity` — the other half of the bed (left <-> right everywhere), and for
// free-sleep the entity-id stem hass-free-sleep derived from the Pod model + side name.
function _presetFor(source, entity) {
  const base = CONNECTORS[source] || {};
  if (!entity || source === "cloud") return base;
  let own = "left", stem = null, podStem = null;
  if (source === "freesleep") {
    const m = /^climate\.(.+)_temperature$/.exec(entity);
    if (m) {
      stem = m[1];
      const lr = /^(.+)_(left|right)$/.exec(stem);
      if (lr) { podStem = lr[1]; own = lr[2]; }
    }
  } else if (/_right$/.test(entity)) {
    own = "right";
  }
  const other = own === "left" ? "right" : "left";
  const out = {};
  for (const [k, v] of Object.entries(base)) {
    let x = v;
    if (typeof x === "string") {
      x = x.replace(/_(left|right)(?=_|$)/g, (_, s) => "_" + (s === "left" ? own : other));
      if (source === "freesleep" && podStem) x = x.replace(/\bpod_3_/, podStem + "_");
    }
    out[k] = x;
  }
  // a renamed free-sleep side ("pod_4_alex"): own entities follow it, the partner can't be guessed
  if (source === "freesleep" && stem && !podStem) {
    for (const [k, v] of Object.entries(out)) {
      if (typeof v !== "string") continue;
      if (/^partner_/.test(k) && /pod_3_right_/.test(v)) out[k] = false;
      else out[k] = v.replace(/pod_3_left_/, stem + "_");
    }
  }
  out.entity = entity;
  return out;
}

// es-watchdog check id -> the few words the Home status light has room for (v10.33).
// Anything not listed falls back to the check's own label.
const HEALTH_SHORT = {
  frozen: "Temp control offline",
  sensor: "Bed sensors offline",
  link: "Pod not responding",
  "unit:frank": "Firmware stopped",
  "unit:es-franken-proxy": "Control stopped",
  "unit:dac": "Device client stopped",
  "unit:capybara": "Supervisor stopped",
  "unit:frozen-heartbeat": "Heartbeat stalled",
  heartbeat: "Heartbeat stalled",
  mqtt_proxy: "Home Assistant link down",
  water: "Add water",
  priming: "Priming is slow",
  clock: "Clock out of sync",
};
// Developer > Vibration themes (v10.37): presets for the Pod's motors, fired through
// script.eight_sleep_pod_vibrate (side/power/duration/pattern). Gentle/Firm/Relentless are
// what the Coach's wake-up uses at each strength.
const VIB_THEMES = [
  { name: "Whisper", power: 20, pattern: "rise", dur: 5, note: "Barely there" },
  { name: "Gentle", power: 30, pattern: "rise", dur: 10, note: "Coach · Gentle" },
  { name: "Nudge", power: 45, pattern: "double", dur: 5, note: "Two quick taps" },
  { name: "Heartbeat", power: 40, pattern: "double", dur: 20, note: "Slow and steady" },
  { name: "Firm", power: 60, pattern: "double", dur: 10, note: "Coach · Firm" },
  { name: "Rise up", power: 80, pattern: "rise", dur: 20, note: "Builds to strong" },
  { name: "Relentless", power: 100, pattern: "double", dur: 10, note: "Coach · Relentless" },
  { name: "Everything", power: 100, pattern: "rise", dur: 30, note: "Max for 30 s" },
];
const HEALTH_TONE = { ok: "#33d17a", warn: "#ffb020", bad: "#ff5a52", off: "#6d7178" };
// only these check groups are worth a word on the Home light; the rest live in Dev
const HEALTH_HOME_GROUPS = ["Control", "System", "Water"];

// Raw heating-level (-100..100) -> °C lookup, ported from the eight_sleep integration's own
// pyEight/constants.py RAW_TO_CELSIUS_MAP. The Eight Sleep API has no algebraic formula for this,
// only this table — the integration itself snaps to the NEAREST whole-degree entry (climate's own
// target_temp_step is 1°), which is why a genuine half-degree target needs its own path: see
// _celsiusToRawLevel below, which interpolates BETWEEN the two bracketing entries instead.
const RAW_TO_CELSIUS_MAP = {
  "-100": 13, "-97": 14, "-94": 15, "-91": 16, "-83": 17, "-75": 18, "-67": 19, "-58": 20,
  "-50": 21, "-42": 22, "-33": 23, "-25": 24, "-17": 25, "-8": 26, "0": 27, "6": 28, "11": 29,
  "17": 30, "22": 31, "28": 32, "33": 33, "39": 34, "44": 35, "50": 36, "56": 37, "61": 38,
  "67": 39, "72": 40, "78": 41, "83": 42, "89": 43, "100": 44,
};

// v2 Home "Glow" (v10.14): every accent on the Home screen follows what the bed is doing —
// cooling blue, holding/neutral lilac, heating orange, grey when off.
const GLOW_PAL = {
  cool: { acc: "#5fa8ff", hi: "#a6ccff", lo: "#2f74e8", rgb: "95,168,255" },
  mid:  { acc: "#b79bff", hi: "#d8c9ff", lo: "#8a6be0", rgb: "183,155,255" },
  warm: { acc: "#ff8a5a", hi: "#ffbf9f", lo: "#e0552e", rgb: "255,138,90" },
  off:  { acc: "#8d928c", hi: "#b7bcb5", lo: "#5b605b", rgb: "141,146,140" },
};
// Tab-bar status tones (v10.30) -> the rgb triple each one tints the lens with. "acc" defers to
// the live Glow colour, so the Home tab's dot and the lens under it are literally the same
// colour as the bed's glow; the rest are the Coach tab's semantic set (--cch-ok/amb/bad), reused
// rather than re-picked so one green means one thing everywhere in the card.
const TAB_TONE_RGB = {
  acc: "var(--gl-rgb, 141,146,140)", ok: "51,209,122", amb: "255,176,32",
  bad: "255,90,82", info: "95,168,255", dim: "109,113,120",
};
const TAB_TONES = Object.keys(TAB_TONE_RGB);
// "Liquid glass" switch: every .smart-switch (track) and its .sk (knob) gets the same 3 stacked
// layers — a blurred+distorted backdrop, a translucent tint, and a specular highlight — instead
// of a flat fill. SW_GLASS_FILTER supplies the distortion; it must live in the SAME shadow root as
// anything using it (an SVG filter referenced by id doesn't resolve across a shadow boundary), so
// it's spliced into both _build() branches below rather than registered once at document level.
const SW_GLASS = `<span class="sw-filter"></span><span class="sw-overlay"></span><span class="sw-specular"></span>`;
const SW_GLASS_FILTER = `<svg style="position:absolute;width:0;height:0" aria-hidden="true"><filter id="glass-distortion"><feTurbulence type="turbulence" baseFrequency="0.012" numOctaves="2" result="noise"/><feDisplacementMap in="SourceGraphic" in2="noise" scale="10"/></filter></svg>`;
const GLOW_ICON_HOLD = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.2"/></svg>`;
const GLOW_ICON_HEART = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>`;
// v2 Home quick actions (v10.18): each glyph says what the mode DOES, not just a temperature
const GLOW_ICON_BOOST = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7.2 16.2a2.1 2.1 0 0 0 2.1-2.1c0-1.1-.4-1.6-.8-2.4-.9-1.7-.2-3.3 1.6-4.9.4 2 1.6 3.9 3.2 5.2 1.6 1.3 2.4 2.8 2.4 4.4a5.6 5.6 0 1 1-11.2 0c0-.9.3-1.8.8-2.4a2.1 2.1 0 0 0 1.9 2.2z"/><path d="M19.5 10V3.5"/><path d="M16.8 6.2l2.7-2.7 2.7 2.7"/></svg>`;
const GLOW_ICON_PRECOOL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10.2 6.2a5.4 5.4 0 0 0 7.6 7.6 7.4 7.4 0 1 1-7.6-7.6z"/><path d="M18.2 2.2v6.6"/><path d="M15.3 3.9l5.8 3.3"/><path d="M21.1 3.9l-5.8 3.3"/></svg>`;
// v10.26 Wind down: a moon settling over three shortening lines
const GLOW_ICON_WINDDOWN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M13.2 3.6a5.6 5.6 0 0 0 7.2 7.2 7 7 0 1 1-7.2-7.2z"/><path d="M3 15.5h7"/><path d="M3 19h5"/><path d="M3 22h3"/></svg>`;
const GLOW_ICON_AWAY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="7.5" width="15" height="12.5" rx="2.6"/><path d="M9.2 7.5V5.6c0-1 .8-1.8 1.8-1.8h2c1 0 1.8.8 1.8 1.8v1.9"/><path d="M9.2 11v5.5"/><path d="M14.8 11v5.5"/><path d="M8 20v1.2"/><path d="M16 20v1.2"/></svg>`;
// v10.24 Glow popups: primary-button tick + previous-step chevron (Lucide stroke, same family)
const GLOW_ICON_CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
const GLOW_ICON_CHEVL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>`;
const SLP_ICON_ALERT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l9 16H3z"/><path d="M12 10v4"/><path d="M12 17v.1"/></svg>`;
const SLP_ICON_SHIELD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.5-3 7.8-7 9-4-1.2-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>`;
const SLP_ICON_EYE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
const SLP_ICON_HRV = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2-6 4 12 2-6h6"/></svg>`;
const SLP_ICON_BREATH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9h11a3 3 0 1 0-3-3"/><path d="M3 15h15a3 3 0 1 1-3 3"/></svg>`;
const SLP_ICON_NODATA = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14A8 8 0 1 1 10 4a6 6 0 0 0 10 10z"/><path d="M3 3l18 18"/></svg>`;
const SLP_ICON_X = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
// ---- Sleep Coach (v10.29) icon set — same Lucide family/weight as the Glow icons above ----
const CCH_ICON_BELL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 16v-5a6 6 0 1 0-12 0v5l-2 3h16z"/><path d="M10 22h4"/></svg>`;
const CCH_ICON_ZZZ = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h7l-7 8h7"/><path d="M14 4h6l-6 7h6"/></svg>`;
const CCH_ICON_ARROW = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M13 7l5 5-5 5"/></svg>`;
const CCH_ICONS = {
  moon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14A8 8 0 1 1 10 4a6 6 0 0 0 10 10z"/></svg>`,
  bell: CCH_ICON_BELL,
  bed: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-9M3 13h18v5M21 18v-3.5a2.5 2.5 0 0 0-2.5-2.5H11v-1"/><circle cx="7" cy="10" r="1.8"/></svg>`,
  flame: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3c3 4 5 6 5 9a5 5 0 0 1-10 0c0-2 .8-3.2 1.8-4.2.4 1.8 1.4 2.4 1.4 2.4S11 9.5 12 3z"/></svg>`,
  sun: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></svg>`,
  snow: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9"/></svg>`,
  wave: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h3l2.5-6 4 12 3-9 2 3h5.5"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5.3l3.3 2"/></svg>`,
  lock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="3"/><path d="M8.2 10.5V8a3.8 3.8 0 0 1 7.6 0v2.5"/></svg>`,
  phone: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2.5" width="12" height="19" rx="3"/><path d="M10.5 18.6h3"/></svg>`,
  cc: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.2l7 2.7v5.5c0 4.3-3 7.5-7 9.4-4-1.9-7-5.1-7-9.4V5.9z"/><path d="m9 12 2 2 4-4"/></svg>`,
  trend: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16.5l5-5 3.2 3.2L20 7"/><path d="M15 7h5v5"/></svg>`,
};

class EightSleepCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._built = false;
    this._open = false;            // dial overlay open?
    this._overrideTemp = null;     // optimistic target °C while user taps +/-
    this._sendTimer = null;
    this._pendingTemp = null;      // gates the override-reconciliation block in `set hass`
    this._halfTempTimer = null;    // safety timeout that unblocks a follow-up commit after a half-degree apply
    this._activeSide = "self";     // which side the controls target when the bed is split (self|partner)
    this._view = "pod";            // "pod" | "routine" | "autopilot" | "sleep" | "coach" | "settings" | "dev"
    this._layout = "classic";      // "classic" | "v2" (hero-first redesign; switchable in the Settings tab)
    this._boostState = new Map();  // entity_id -> { until, prevTemp, timer } while a boost is running
    this._warmWakeOn = true;       // v2 Schedule's "Warm wake" row — front-end only, no backend yet
  }

  setConfig(config) {
    const source = config.source || "cloud";
    const preset = _presetFor(source, config.entity);
    if (!config.entity && !preset.entity)
      throw new Error("eight-sleep-card: 'entity' (a climate entity) is required");
    // public build: helpers follow the sleeper prefix the Eight+ add-on generates; cloud side
    // sensors follow the climate entity (climate.<x>_climate -> sensor.<x>_side, _next_alarm ...)
    const __P = config.schedule_prefix || "eight_sleep_me";
    const __PP = config.partner_schedule_prefix || "";
    const __S = String(config.entity || preset.entity || "").replace(/^climate\./, "").replace(/_climate$/, "");
    const __CLOUD = source === "cloud";
    this._config = Object.assign(
      {
        title: "Your Pod",
        pod_name: "Your Pod",
        side: "",
        bedtime: "10:00pm",
        units: "c",        // "c" = show °C, "level" = show -10..+10
        display: "pod",    // "pod" = home card (+ dial overlay), "dial" = standalone dial card
        font_url: false,  // Eight Sleep's PP Neue Montreal; set false to use the system font
        presets: [         // quick-set chips on the dial
          { label: "Cool", temp: 19 },
          { label: "Neutral", temp: 28 },
          { label: "Warm", temp: 32 },
          { label: "Hot", temp: 36 },
        ],
        boost_minutes: 30,   // Heat boost chip: minutes spent at max heat before auto-reverting
        // Pre Cool Sleep chip: a gentle bedtime cool-down (tap = these defaults; hold = edit
        // temp/duration first), distinct from Heat boost's instant max-heat behaviour
        precool_sleep_temp: 26,
        precool_sleep_minutes: 20,
        // Boost-active flag: while set, the HA-side autopilot automation skips re-applying its
        // suggested temp, so boost can run WITHOUT turning autopilot off. Set false to fall back
        // to the old behaviour (boost disables autopilot for the session).
        boost_active_entity: `input_boolean.${__P}_boost_active`,
        partner_boost_active_entity: __PP ? `input_boolean.${__PP}_boost_active` : "",
        // boost end time — the card writes now+duration here on boost start; a HA-side automation
        // (eight_sleep_*_boost_active_failsafe_clear) fires a time trigger at it and turns the
        // boost_active flag off, so a closed tab / restart can't leave autopilot suppressed.
        boost_until_entity: `input_datetime.${__P}_boost_until`,
        partner_boost_until_entity: __PP ? `input_datetime.${__PP}_boost_until` : "",
        // smart autopilot (weather-driven) — set to false/"" to hide the Smart control
        smart_entity: `input_boolean.${__P}_smart_autopilot`,
        smart_bias_entity: `input_number.${__P}_smart_bias`,
        auto_off_entity: `input_datetime.${__P}_auto_off`,
        auto_off_toggle_entity: `input_boolean.${__P}_auto_off_enabled`,
        suggested_entity: `sensor.${__P}_suggested_temp`,
        weather_entity: "weather.forecast_home",
        // held (not raw) so a brief Zigbee dropout doesn't show/feed a blank or default reading —
        // see the comment on these sensors in configuration.yaml
        room_temp_entity: "",
        room_humidity_entity: "",
        // v10.26 Wind down (Glow Home tile): one HA script runs the whole bedtime scene (bed to
        // the wind-down temperature, Adaptive Lighting sleep mode, Dyson on level 1 + night mode,
        // amber Pod LED, wake light armed). Its own delay IS the wind-down, so while it runs the
        // tile counts down from winddown_minutes. Tap again to cancel. false hides the tile.
        winddown_script: `script.${__P}_wind_down`,
        winddown_minutes: 20,
        // v10.26 "Turn off when I get up" (Schedule tab) — the switch for automation
        // es_<name>_off_when_up; in_bed_entity is its debounced occupancy sensor (subtitle only)
        off_when_up_entity: `input_boolean.${__P}_off_when_up`,
        in_bed_entity: `binary_sensor.${__P}_in_bed`,
        // v10.26 Sleep Month view sweet spot — set by the free_sleep preset
        water_temp_entity: "",
        partner_water_temp_entity: "",
        // dual-side control: this side's bed-side sensor (state solo/left/right) + the partner's;
        // toggling the partner side calls eight_sleep.side_on/side_off + set_bed_side(solo) so this
        // side controls the whole bed when the partner is off. Set side_state_entity:false to hide.
        side_state_entity: __CLOUD ? `sensor.${__S}_side` : false,
        alarm_entity: __CLOUD ? `sensor.${__S}_next_alarm` : false,
        partner_side_entity: "",
        partner_climate_entity: "",
        own_side: "left",          // which physical half this side takes when split (left|right)
        // hand-tuned (box-tuner) rounded polygons tracing each mattress HALF surface (for the split glow)
        glow_poly_left: "21.6% 14.4%, 21.7% 13.8%, 21.9% 13.4%, 22.1% 13.0%, 22.3% 12.7%, 22.6% 12.5%, 22.9% 12.3%, 23.2% 12.3%, 47.9% 11.9%, 48.2% 11.9%, 48.5% 12.0%, 48.8% 12.3%, 48.9% 12.6%, 49.1% 13.0%, 49.1% 13.5%, 49.2% 14.1%, 49.2% 52.7%, 49.1% 53.3%, 49.1% 53.8%, 48.9% 54.2%, 48.8% 54.5%, 48.5% 54.7%, 48.2% 54.9%, 47.9% 54.9%, 14.8% 54.5%, 14.5% 54.4%, 14.3% 54.3%, 14.1% 54.1%, 14.0% 53.8%, 13.9% 53.4%, 13.9% 52.9%, 14.0% 52.4%",
        glow_poly_right: "50.8% 14.1%, 50.9% 13.5%, 50.9% 13.0%, 51.1% 12.6%, 51.2% 12.2%, 51.5% 12.0%, 51.8% 11.9%, 52.1% 11.8%, 76.0% 12.0%, 76.3% 12.1%, 76.6% 12.2%, 76.9% 12.4%, 77.1% 12.7%, 77.3% 13.1%, 77.5% 13.6%, 77.6% 14.1%, 85.3% 52.1%, 85.4% 52.6%, 85.4% 53.1%, 85.4% 53.5%, 85.2% 53.8%, 85.1% 54.0%, 84.8% 54.1%, 84.5% 54.2%, 52.1% 54.9%, 51.8% 54.9%, 51.5% 54.7%, 51.2% 54.5%, 51.1% 54.2%, 50.9% 53.8%, 50.9% 53.3%, 50.8% 52.7%",
        partner_label: "Partner side",
        own_label: "You",          // side-selector labels shown when the bed is split
        partner_name: "Partner",
        // partner Autopilot — a full parallel set of the smart/schedule entities. When the partner
        // side is selected, the smart panel + schedule read/write THESE instead of this side's.
        partner_smart_entity: __PP ? `input_boolean.${__PP}_smart_autopilot` : "",
        partner_smart_bias_entity: __PP ? `input_number.${__PP}_smart_bias` : "",
        partner_suggested_entity: __PP ? `sensor.${__PP}_suggested_temp` : "",
        // ── Autopilot tab (v2) ──────────────────────────────────────────────────────────
        // Rate of change of the bed surface temperature (a `derivative` helper over
        // sensor.*_bed_temperature). Drives the °/h cell and the "reaches it at" estimate on the
        // Autopilot tab. Unlike current_temp_entity this can't be auto-derived — the helper's
        // entity_id depends on what it was named — so it's config-only; missing just hides the
        // rate cell and the ETA rather than breaking the card.
        bed_rate_entity: `sensor.${__P}_bed_temp_rate`,
        partner_bed_rate_entity: "",
        // Suppression: things that leave Autopilot switched ON but stop the HA-side apply
        // automation from driving the bed. Both are conditions on
        // automation.eight_sleep_*_smart_autopilot_apply; without surfacing them the tab shows a
        // confident target that nothing is applying.
        vacation_entity: "",
        // Tuning controls. Each is gated on the helper existing, so until it's created the
        // control simply doesn't render (graceful degradation by config, not by breaking).
        // IMPORTANT: creating the helper is only half the job — none of these change what the
        // bed does until sensor.eight_sleep_*_suggested_temp reads them. See
        // design/autopilot/entity-plumbing.html.
        ap_response_entity: `input_select.${__P}_autopilot_response`,
        ap_min_entity: `input_number.${__P}_autopilot_min`,
        ap_max_entity: `input_number.${__P}_autopilot_max`,
        // Cadence (v10.32): how often the apply automation may act, and how big a difference is
        // worth a write. Read by the automation, edited here — see the Cadence group in Tuning.
        ap_tick_entity: `input_number.${__P}_ap_tick`,
        ap_deadband_entity: `input_number.${__P}_ap_deadband`,
        // the five model inputs, each toggleable; label + the _smartModel() key it gates
        ap_signals: [
          { key: "forecast", label: "Outside forecast", entity: `input_boolean.${__P}_ap_use_forecast` },
          { key: "room", label: "Room temperature", entity: `input_boolean.${__P}_ap_use_room` },
          { key: "humidity", label: "Humidity", entity: `input_boolean.${__P}_ap_use_humidity` },
          { key: "reactive", label: "Reactive corrections", entity: `input_boolean.${__P}_ap_use_reactive` },
          { key: "precon", label: "Pre-conditioning", entity: `input_boolean.${__P}_ap_use_preconditioning` },
        ],
        // per-phase offsets: input_number.<prefix>_<phase key>, promoting the hardcoded `adj`
        // constants in _phases() into helpers the Jinja can read
        ap_offset_prefix: `input_number.${__P}_ap_offset`,
        partner_schedule_prefix: __PP ? `${__PP}` : "",
        partner_auto_off_entity: __PP ? `input_datetime.${__PP}_auto_off` : "",
        partner_auto_off_toggle_entity: __PP ? `input_boolean.${__PP}_auto_off_enabled` : "",
        // priming / water status (device-scoped sensors — return the STRING "True"/"False").
        // Set priming_entity:false to hide the status light + priming animation.
        priming_entity: false,
        need_priming_entity: false,
        has_water_entity: false,
        last_prime_entity: false,
        prime_target_entity: __CLOUD ? `sensor.${__S}_side` : false,  // eight_sleep sensor to target for prime_pod
        // header nav toggle (Pod <-> Routine): "lens" = liquid-glass mini navbar, "segmented" = plain pills, "hamburger" = old menu
        header_nav: "lens",
        // Routine page — weekday/weekend routine times (helpers created to mirror the Eight app)
        weekday_bedtime_entity: `input_datetime.${__P}_weekday_bedtime`,
        weekday_alarm_entity: `input_datetime.${__P}_weekday_alarm`,
        weekend_bedtime_entity: `input_datetime.${__P}_weekend_bedtime`,
        weekend_alarm_entity: `input_datetime.${__P}_weekend_alarm`,
        // Wake-up light "sunrise" alarm — a light that ramps red 1% -> warm white 70% into the
        // wake alarm. The toggle + chosen light live in helpers (not card config) so the backing
        // automation can read them too. Set alarm_light_toggle_entity:false to hide the feature.
        alarm_light_toggle_entity: `input_boolean.${__P}_light_alarm`,
        alarm_light_select_entity: `input_text.${__P}_alarm_light`,
        // v10.29: the "Last night" recap page and the "Room" air page (together the v2
        // "Insights" tab) are GONE — deprecated by the Sleep tab, which answers the same
        // questions from the pipeline's own numbers instead of recorder history. pm25_entity
        // stays for the Sleep tab's air note; room_temp/humidity_entity for Autopilot + Home.
        pm25_entity: "",
        // Underglow lighting — now a Settings section (it used to live on the Room page).
        underglow_entity: "",
        underglow_auto_entity: "",
        wake_focus_entity: "",
        // ── Sleep Coach tab (v10.29) ─────────────────────────────────────────────────────
        // The coach reads ONE prefix and derives every helper from it by convention
        // (input_boolean.<pre>_coach, input_datetime.<pre>_target_bedtime, …) — see _cchE().
        // Defaults to schedule_prefix. The tab hides itself unless input_boolean.<pre>_coach
        // exists, and `coach: false` hides it even then. Its nightly numbers (debt, on-time
        // count, streak, per-night onset/wake) ride on the sleep_score entity's `coach`
        // attribute, published by gateway/sleep-pipeline. See design/coach/PLAN.md.
        coach: true,
        coach_prefix: `${__P}`,
        // ── Dev tab (v2) ────────────────────────────────────────────────────────────────
        // Diagnostics page for the free-sleep MQTT device (the `eight_sleep_pod_local`
        // MQTT-discovery device — connector health, per-side hardware telemetry, firmware
        // and control-loop stats, the raw entity list). Every row is gated on its entity
        // existing, so a card pointed at a device without these entities just shows a
        // near-empty Dev tab. Set dev_view:false to drop the tab entirely; dev_prefix is
        // the shared entity-id stem (sensor.<prefix>_left_current_temp, …).
        dev_view: true,
        dev_prefix: "eight_sleep_pod",
        // current_temp_entity / bed_state_entity / away_entity auto-derive or come from config
      },
      preset,
      config
    );
    this._config.source = source;
    // show the Solo/Dual + You/Partner UI when the bed has any two-side signal: a bed-side sensor
    // (cloud), a partner Away switch (old pod_3_* path), OR a dual_mode helper + a partner climate
    // (local MQTT path — two independent water circuits, Solo/Dual is a soft helper, not hardware).
    this._config._partnerUi = !!(
      this._config.side_state_entity ||
      this._config.partner_away_entity ||
      (this._config.dual_mode_entity && this._config.partner_climate_entity)
    );
    this._mode = this._config.display === "dial" ? "dial" : "pod";
    this._layout = this._resolveLayout();
    this._xr = String(this._config.home || "").toLowerCase() === "xray";   // v10.42 x-ray Home (opt-in)
  }

  // layout is a per-device preference (localStorage), falling back to the `layout:` config option
  // then "classic". The Settings tab flips it; a rollback is one tap away and never touches config.
  _layoutKey() { return "es-layout:" + (this._config && this._config.entity); }
  // A device's layout choice outranks `layout:` in config — but only until the CONFIG ITSELF
  // changes. Storing the bare choice (as this used to) made the override permanent: a dashboard
  // or kiosk that later set `layout: "v2"` was silently ignored forever on any device that had
  // ever touched the toggle, with no way to tell from the config why. So the stored value now
  // records which default it was chosen against, and a config that has moved since wins.
  //
  // localStorage is per-ORIGIN, so this is also why the same install could disagree with itself:
  // the bundled app (pod://) starts clean and follows config, while the served origin still held
  // an old "classic". A legacy bare string is treated as chosen against "classic", the historical
  // default — so it drops exactly once, on a config that now asks for v2.
  _resolveLayout() {
    const def = this._config && this._config.layout === "v2" ? "v2" : "classic";
    try {
      const raw = window.localStorage.getItem(this._layoutKey());
      if (raw) {
        let choice = raw, base = "classic";
        if (raw.charAt(0) === "{") { const o = JSON.parse(raw); choice = o.choice; base = o.base; }
        if (choice === "v2" || choice === "classic") {
          if (base === def) return choice;                                  // config unmoved
          window.localStorage.removeItem(this._layoutKey());                // stale — config wins
        }
      }
    } catch (e) {}
    return def;
  }
  _setLayout(v) {
    const next = v === "v2" ? "v2" : "classic";
    if (next === this._layout) { this._view = "pod"; this._update(); return; }
    this._layout = next;
    // record the config default this choice was made against — see _resolveLayout
    try {
      const base = this._config.layout === "v2" ? "v2" : "classic";
      window.localStorage.setItem(this._layoutKey(), JSON.stringify({ choice: next, base }));
    } catch (e) {}
    this._haptic("medium");
    this._view = "pod";
    this._built = false;
    this._build();
    this._update();
  }

  getCardSize() { return 8; }

  static getStubConfig(hass) {
    const ids = Object.keys((hass && hass.states) || {});
    const gw = ids.find((e) => e === "climate.eight_sleep_pod_left");
    const fs = ids.find((e) => /^climate\.pod_\d+_left_temperature$/.test(e));
    const cl = ids.find((e) => /^climate\..*eight_sleep_side_climate$/.test(e));
    if (gw) return { source: "gateway", entity: gw, layout: "v2" };
    if (fs) return { source: "freesleep", entity: fs, layout: "v2" };
    return { source: "cloud", entity: cl || "climate.my_eight_sleep_side_climate", layout: "v2" };
  }

  /* ---------- temperature helpers (°C-first) ---------- */
  // the climate entity the controls currently target — the partner's when the bed is split and
  // the partner side is selected, otherwise this side's own entity
  _activeEntity() {
    if (this._activeSide === "partner" && this._config.partner_climate_entity && this._partnerOn())
      return this._config.partner_climate_entity;
    return this._config.entity;
  }
  _viewingPartner() { return this._activeEntity() === this._config.partner_climate_entity; }
  // Which climate entities a "this side" write (temp / power / boost) should drive.
  // Solo (dual_mode off, partner climate configured): the whole bed tracks one setpoint, so a
  // write to our own side fans out to BOTH halves. Dual, or viewing the partner: just that side.
  _writeEntities(id) {
    id = id || this._activeEntity();
    if (this._config.dual_mode_entity
        && id === this._config.entity
        && !this._partnerOn()
        && this._config.partner_climate_entity
        && this._config.partner_climate_entity !== id)
      return [id, this._config.partner_climate_entity];
    return [id];
  }
  // turn the controlled side(s) on if off, with an optimistic flag so the UI flips instantly
  _ensureOn() {
    if (this._isOn()) return;
    for (const t of this._writeEntities())
      this._hass.callService("climate", "turn_on", { entity_id: t });
    this._markPendingOn(true);
  }
  // side-aware config: when viewing the partner, prefer the partner_<key> value (their own
  // smart toggle / suggested sensor / schedule prefix / bias / auto-off), else this side's
  _sc(key) {
    if (this._viewingPartner()) { const v = this._config["partner_" + key]; if (v !== undefined && v !== null && v !== "") return v; }
    return this._config[key];
  }
  _clim() { return this._hass && this._hass.states[this._activeEntity()]; }
  _useC() { return (this._config.units || "c") !== "level"; }

  _range() {
    const a = this._clim() ? this._clim().attributes : {};
    const min = Number.isFinite(a.min_temp) ? a.min_temp : 12.8;
    const max = Number.isFinite(a.max_temp) ? a.max_temp : 43.3;
    // manual-adjustment granularity: genuine 0.5° in Celsius mode. climate.set_temperature's own
    // target_temp_step is a whole degree — a fractional value sent through it just gets silently
    // rounded away — so half-degree targets route through _applyTemp's raw-level path instead
    // (see _celsiusToRawLevel below). Level mode already adjusts in single raw-level steps.
    const step = this._useC() ? 0.5 : (Number.isFinite(a.target_temp_step) && a.target_temp_step > 0 ? a.target_temp_step : 1);
    return { min, max, step };
  }

  // sorted [rawLevel, celsius] pairs from RAW_TO_CELSIUS_MAP, built once
  _rawLevelTable() {
    if (this._rawTableCache) return this._rawTableCache;
    this._rawTableCache = Object.keys(RAW_TO_CELSIUS_MAP)
      .map((k) => [parseInt(k, 10), RAW_TO_CELSIUS_MAP[k]])
      .sort((a, b) => a[0] - b[0]);
    return this._rawTableCache;
  }
  // Fractional °C -> raw heating level (-100..100), interpolated BETWEEN the two whole-degree
  // table entries either side of the target (rather than snapped to the nearest one, like the
  // integration's own temp_to_heating_level does) — this is what actually gives a X.5° request a
  // distinct raw level roughly halfway between its neighbours, i.e. real sub-degree resolution.
  _celsiusToRawLevel(c) {
    const t = this._rawLevelTable();
    if (c <= t[0][1]) return t[0][0];
    if (c >= t[t.length - 1][1]) return t[t.length - 1][0];
    for (let i = 0; i < t.length - 1; i++) {
      const [r0, c0] = t[i], [r1, c1] = t[i + 1];
      if (c >= c0 && c <= c1) return Math.round(r0 + (c1 === c0 ? 0 : (c - c0) / (c1 - c0)) * (r1 - r0));
    }
    return 0;
  }
  // inverse of the above — raw level -> interpolated °C (used to read back a fractional target
  // from the bed-state sensor's own raw "Target Heating Level" attribute)
  _rawLevelToCelsius(raw) {
    const t = this._rawLevelTable();
    raw = Math.max(t[0][0], Math.min(t[t.length - 1][0], raw));
    for (let i = 0; i < t.length - 1; i++) {
      const [r0, c0] = t[i], [r1, c1] = t[i + 1];
      if (raw >= r0 && raw <= r1) return c0 + (r1 === r0 ? 0 : (raw - r0) / (r1 - r0)) * (c1 - c0);
    }
    return t[t.length - 1][1];
  }

  _tgtTemp() {
    if (this._overrideTemp !== null) return this._overrideTemp;
    const c = this._clim();
    const { min, max } = this._range();
    return c && Number.isFinite(c.attributes.temperature) ? c.attributes.temperature : (min + max) / 2;
  }
  // real bed surface temperature (sensor.*_bed_temperature), else climate reading
  _curTempEntity() {
    if (this._viewingPartner())
      return this._activeEntity().replace(/^climate\./, "sensor.").replace(/_climate$/, "_bed_temperature");
    return this._config.current_temp_entity ||
      this._config.entity.replace(/^climate\./, "sensor.").replace(/_climate$/, "_bed_temperature");
  }
  _curTemp() {
    const e = this._hass.states[this._curTempEntity()];
    if (e) { const v = parseFloat(e.state); if (!isNaN(v)) return v; }
    const c = this._clim();
    return c && Number.isFinite(c.attributes.current_temperature) ? c.attributes.current_temperature : this._tgtTemp();
  }

  // live bed state (sensor.*_bed_state): level %, target level, heating-active, seconds remaining
  _bedStateEntity() {
    if (this._viewingPartner())
      return this._activeEntity().replace(/^climate\./, "sensor.").replace(/_climate$/, "_bed_state");
    return this._config.bed_state_entity ||
      this._config.entity.replace(/^climate\./, "sensor.").replace(/_climate$/, "_bed_state");
  }
  _bedState() {
    const e = this._hass.states[this._bedStateEntity()];
    if (!e) return null;
    const a = e.attributes || {};
    return {
      level: parseFloat(e.state),
      target: Number(a["Target Heating Level"]),
      active: a["Heating Active"] === true,
      remaining: Number(a["Heating Time Remaining"]) || 0,
    };
  }

  // thermal direction from the TARGET temperature vs a pivot (default 27°C):
  //   above pivot -> "warm" (red), at pivot -> "mid" (purple), below -> "cool" (blue).
  // keyed on target (not current) so it's correct even when the Pod reports no live bed temp.
  _midTemp() { return Number.isFinite(this._config.mid_temp) ? this._config.mid_temp : 27; }
  _dir() {
    const d = Math.round(this._tgtTemp()) - Math.round(this._midTemp());
    return d > 0 ? "warm" : d < 0 ? "cool" : "mid";
  }
  // is the pod actively working toward the target?
  _working() {
    const bs = this._bedState();
    if (bs && bs.active) return true;
    return Math.abs(this._tgtTemp() - this._curTemp()) > 1.2;
  }
  _gap() { return Math.abs(this._tgtTemp() - this._curTemp()); }

  /* ---- ETA to target temperature ------------------------------------------
     The stock firmware exposes no "time remaining". Two estimators:
       1. INSTANT — the moment the bed is working, gap × a per-degree rate
          (config `eta_min_per_deg`, default 3.4 min/°C). Shown as "~Xm (est.)".
       2. MEASURED — once ≥2 min of live trend exists, a least-squares slope of
          _curTemp() over a rolling ≤15-min window. Shown as "~Xm to target".
     The measured figure supersedes the instant one as soon as it's trustworthy. */
  _etaRate() {
    const r = Number(this._config.eta_min_per_deg);
    return (Number.isFinite(r) && r > 0 ? r : 3.4) * 60;   // seconds per °C
  }
  _etaSample() {
    if (!this._config || !this._hass) return;
    const e = (this._eta ||= { buf: [], tgt: null });
    if (!this._effectiveOn()) { e.buf = []; e.tgt = null; return; }
    const tgt = this._tgtTemp(), cur = this._curTemp();
    if (!Number.isFinite(cur) || !Number.isFinite(tgt)) return;
    const now = Date.now();
    // a new target = a new journey — start the window over
    if (e.tgt == null || Math.abs(tgt - e.tgt) >= 0.5) { e.buf = []; e.tgt = tgt; }
    const b = e.buf, last = b[b.length - 1];
    if (!last || now - last.t >= 20000 || Math.abs(cur - last.v) >= 0.05) b.push({ t: now, v: cur });
    const cutoff = now - 15 * 60 * 1000;
    while (b.length > 2 && b[0].t < cutoff) b.shift();
  }
  // { seconds, measured } — measured:false = the instant gap×rate guess, true = live-trend fit.
  // seconds 0 = already there; null = can't estimate (basically at target).
  _etaEstimate() {
    const tgt = this._tgtTemp(), cur = this._curTemp();
    if (!Number.isFinite(cur) || !Number.isFinite(tgt)) return null;
    const remaining = tgt - cur;                       // signed
    if (Math.abs(remaining) < 0.4) return { seconds: 0, measured: false };
    // instant fallback — available the moment the bed is working
    let out = { seconds: Math.min(4 * 3600, Math.abs(remaining) * this._etaRate()), measured: false };
    // measured — a least-squares slope over the rolling window, once it's meaningful
    const b = (this._eta && this._eta.buf) || [];
    if (b.length >= 4) {
      const span = (b[b.length - 1].t - b[0].t) / 1000;
      if (span >= 120) {
        const t0 = b[0].t;
        let n = b.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (const p of b) { const x = (p.t - t0) / 1000; sx += x; sy += p.v; sxx += x * x; sxy += x * p.v; }
        const denom = n * sxx - sx * sx;
        const slope = denom ? (n * sxy - sx * sy) / denom : 0;   // °C/s
        if (Math.sign(slope) === Math.sign(remaining) && Math.abs(slope) >= 0.00075) {
          const eta = remaining / slope;
          if (eta >= 30 && eta <= 4 * 3600) out = { seconds: eta, measured: true };
        }
      }
    }
    return out;
  }
  // "~14m to target" (measured) / "~14m to target (est.)" (instant) / "" — only while working
  _etaText() {
    if (!this._effectiveOn() || !this._working()) return "";
    const e = this._etaEstimate();
    if (!e || !e.seconds) return "";
    return `~${this._fmtDur(e.seconds)} to target${e.measured ? "" : " (est.)"}`;
  }

  // one-line live bed status used as the page subtitles (routine / dial) —
  // e.g. "Heating to 33° · now 28°", "Holding at 31°", "Pod is off"
  _bedStatusText() {
    if (!this._clim()) return this._config.pod_name || "";
    if (!this._effectiveOn()) return "Pod is off";
    const dir = this._dir(), tgt = this._tgtTemp(), cur = this._curTemp();
    const showCur = Number.isFinite(cur) && Math.abs(tgt - cur) >= 0.5;
    if (this._working()) {
      const verb = dir === "warm" ? "Heating" : dir === "cool" ? "Cooling" : "Adjusting";
      const eta = this._etaText();
      return `${verb} to ${this._fmtVal(tgt)}${showCur ? ` · now ${this._fmtVal(cur)}` : ""}${eta ? ` · ${eta}` : ""}`;
    }
    return `Holding at ${this._fmtVal(tgt)}`;
  }

  _fmtDur(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return "<1m";
  }

  _tempToLevel(t) {
    const { min, max } = this._range();
    if (!Number.isFinite(t) || max === min) return 0;
    return Math.max(-10, Math.min(10, Math.round(((t - min) / (max - min)) * 20 - 10)));
  }

  _frac(t) {
    const { min, max } = this._range();
    return max === min ? 0 : Math.max(0, Math.min(1, (t - min) / (max - min)));
  }

  _isOn() {
    const c = this._clim();
    if (!c || c.state === "off" || c.state === "unavailable" || c.state === "unknown") return false;
    return !this._awayOnFor(this._activeEntity());   // Away on ⇒ side parked ⇒ off
  }
  _isOnEntity(id) {
    const c = this._hass && this._hass.states[id];
    if (!c || c.state === "off" || c.state === "unavailable" || c.state === "unknown") return false;
    return !this._awayOnFor(id);
  }

  // how long the pod has been on: HA leaves `last_changed` alone for attribute-only updates
  // (temp changes), so it tracks the last on/off flip cleanly
  _onSinceMs() {
    const c = this._clim();
    if (!c || !c.last_changed) return null;
    const t = Date.parse(c.last_changed);
    return Number.isFinite(t) ? t : null;
  }
  _fmtOnSince() {
    const t = this._onSinceMs();
    return t ? this._fmtDur((Date.now() - t) / 1000) : "";
  }

  _fmtLevel(l) { return l > 0 ? "+" + l : "" + l; }

  // Display string for a temperature, honouring the units setting. In °C mode this shows a real
  // ".5" for a genuine half-degree target instead of rounding it away to a whole number — that's
  // the whole point of _applyTemp's raw-level path (see there), so the UI needs to be able to say
  // "27.5°" and not just silently apply it and then display "28°".
  _fmtVal(t) {
    if (!this._useC()) return this._fmtLevel(this._tempToLevel(t));
    return this._fmtHalfC(t) + "°";
  }
  // half-degree-aware number for a °C value — "27" for a whole degree, "27.5" for a genuine half
  _fmtHalfC(t) {
    const r = Math.round(t * 2) / 2;
    return Number.isInteger(r) ? r : r.toFixed(1);
  }

  // colour class by cooling/heating direction relative to a reference temp
  _dirClass(t, ref) {
    if (t < ref - 0.3) return "cool";
    if (t > ref + 0.3) return "warm";
    return "neutral";
  }
  // colour class for a standalone temp (relative to the middle of the range)
  _tempClass(t) {
    const { min, max } = this._range();
    return this._dirClass(t, (min + max) / 2);
  }

  /* ---------- interactions ---------- */
  // manual adjustment turns Smart Autopilot off (so the change sticks instead of being re-applied)
  _disableSmartForManual() {
    // turn off the ACTIVE side's smart autopilot (each side has its own) so a manual change sticks
    const id = this._sc("smart_entity");
    if (this._smartOn && this._smartOn() && id)
      this._hass.callService("input_boolean", "turn_off", { entity_id: id });
  }
  _bump(delta) {
    if (!this._isOn()) return;
    this._haptic("light");
    this._disableSmartForManual();
    this._clearBoost(this._activeEntity());   // a manual nudge supersedes any running boost
    const { min, max, step } = this._range();
    const unit = this._useC() ? step : (max - min) / 20;
    let next = this._tgtTemp() + delta * unit;
    next = this._useC()
      ? Math.round(next / step) * step
      : min + Math.round(((next - min) / (max - min)) * 20) * ((max - min) / 20);
    next = Math.max(min, Math.min(max, next));
    this._overrideTemp = next;
    this._update();
    if (this._sendTimer) clearTimeout(this._sendTimer);
    this._sendTimer = setTimeout(() => this._commit(), 550);
  }

  _commit() {
    if (this._overrideTemp === null) return;
    const { step } = this._range();
    const temp = Math.round(this._overrideTemp / step) * step;
    this._applyTemp(temp);
    this._pendingTemp = temp;
  }

  // Apply a target °C, choosing the right service for it:
  //  - a whole degree goes through climate.set_temperature as before (keeps the climate entity's
  //    own target_temperature attribute in sync, which the optimistic-override reconciliation in
  //    `set hass` relies on).
  //  - a genuine half-degree would just get rounded away by that same call (target_temp_step=1),
  //    so it's converted to an interpolated raw heating level and sent straight to the eight_sleep
  //    integration's own heat_set service instead — see the 2026-09 __init__.py bugfix in
  //    DEV-NOTES.md (heat_set/heat_increment were calling nonexistent pyEight methods and silently
  //    no-op'd). climate.*'s target_temperature won't reflect this, so _overrideTemp stays the
  //    authoritative display value until the next manual change (see `set hass` reconciliation).
  _applyTemp(v, id) {
    if (!Number.isFinite(v)) return;
    // no explicit id => "this side": fan out to both halves in Solo mode
    const targets = id ? [id] : this._writeEntities();
    for (const t of targets) this._applyTempOne(v, t);
  }
  _applyTempOne(v, id) {
    const whole = !this._useC() || Math.abs(v - Math.round(v)) < 0.001;
    // Backends whose climate entity has a 0.5° step (free-sleep) take half-degrees directly;
    // only the cloud path (1° step) needs the raw-level eight_sleep.heat_set detour.
    if (whole || this._config.half_degree_via_heat_set === false) {
      const st = this._hass.states[id];
      const cur = st && st.attributes && st.attributes.temperature;
      // "already there" has to be judged against the Pod's own grid (~0.28° half-step), not an
      // exact match — the read-back is quantised, so |cur - v| < 0.05 almost never holds and this
      // guard used to let every re-apply through as a fresh write.
      if (Number.isFinite(cur) && Math.abs(cur - v) < 0.28) return;   // already on this Pod step
      this._hass.callService("climate", "set_temperature", { entity_id: id, temperature: v });
      return;
    }
    const raw = this._celsiusToRawLevel(v);
    this._hass.callService("eight_sleep", "heat_set", {
      entity_id: this._bedStateEntityFor(id),
      target: raw,
      duration: 7200,          // matches DEFAULT_DURATION in the integration's own climate.py
      sleep_stage: "current",
    });
  }

  _togglePower() {
    const c = this._clim();
    if (!c) return;
    this._haptic("medium");
    const on = this._isOn();
    const id = this._activeEntity();
    // optimistic: reflect the new on/off state immediately (bed colour-fades to grey, temp → "Off",
    // ring dims) so it feels instant even though the cloud round-trip lags. Reconciled in `set hass`.
    this._markPendingOn(!on);
    if (this._awayEntityFor(id)) {
      this._setSideActive(id, !on);   // per-side Away switch is the power signal (old pod_3_* path)
    } else {
      const svc = on ? "turn_off" : "turn_on";
      for (const t of this._writeEntities(id)) {   // Solo → both halves
        const ts = this._hass.states[t];
        const tOff = !ts || ts.state === "off" || ts.state === "unavailable" || ts.state === "unknown";
        if (on !== tOff) this._hass.callService("climate", svc, { entity_id: t });
      }
    }
    if (on) { this._overrideTemp = null; this._pendingTemp = null; clearTimeout(this._halfTempTimer); this._halfTempTimer = null; this._clearBoost(id); }
    this._update();
  }
  // optimistic on/off: hold a pending state until the cloud confirms (or a safety timeout clears it)
  _markPendingOn(state) {
    this._pendingOn = state;
    if (this._powerTimer) clearTimeout(this._powerTimer);
    this._powerTimer = setTimeout(() => { this._pendingOn = null; this._powerTimer = null; this._update(); }, 12000);
  }
  // effective on-state for the UI: honour the optimistic pending toggle until the cloud confirms
  _effectiveOn() { return this._pendingOn != null ? this._pendingOn : this._isOn(); }

  // quick-preset: jump straight to a temperature
  _setTemp(t) {
    if (!Number.isFinite(t)) return;
    this._haptic("light");
    this._ensureOn();
    this._clearBoost(this._activeEntity());   // a manual preset supersedes any running boost
    const { min, max, step } = this._range();
    const v = Math.max(min, Math.min(max, Math.round(t / step) * step));
    this._overrideTemp = v;
    this._pendingTemp = v;
    this._update();
    this._applyTemp(v);
  }

  /* ---------- Boost: push the active side to max heat/cool for a fixed window, then revert ---------- */
  _boostActive(id) {
    id = id || this._activeEntity();
    const b = this._boostState.get(id);
    return b && b.until > Date.now() ? b : null;
  }
  _boostRemainingLabel(b) {
    const mins = Math.max(1, Math.ceil((b.until - Date.now()) / 60000));
    return mins + "m left";
  }
  // drop a running boost's timer without reverting the temperature (used when something else,
  // like a manual bump or power-off, already supersedes it)
  _clearBoost(id) {
    const b = this._boostState.get(id);
    if (!b) return;
    if (b.timer) clearTimeout(b.timer);
    this._boostState.delete(id);
  }
  // dir: "warm" (max heat) or "cool" (max cool) — explicit, independent of the current target
  _toggleBoost(dir) {
    const id = this._activeEntity();
    const active = this._boostActive(id);
    if (active && active.dir === dir) { this._haptic("light"); this._endBoost(id, true); }
    else this._startBoost(dir);
  }
  // brief "autopilot just adjusted" badge on the Smart panel header — proof it's actively
  // working, without opening the detail view. Ignores sub-half-degree rounding noise.
  _flashAutopilot(prevVal, val) {
    const delta = val - prevVal;
    // Threshold is the Pod's own step (~0.28°), not 0.5°. At 0.5° this badge was effectively
    // dead: real adjustments land 0.3° apart on the hardware grid, so the one piece of UI whose
    // job is to prove Autopilot is working almost never fired.
    if (Math.abs(delta) < 0.28) return;
    const el = this.shadowRoot && this.shadowRoot.getElementById("smpFlash");
    if (!el) return;
    const dir = delta > 0 ? "warm" : "cool";
    const arrow = delta > 0 ? ICON_CARETUP : ICON_CARETDN;
    el.className = "smp-flash shown " + dir;
    el.innerHTML = `${arrow}<span>Autopilot adjusted to ${Math.round(val)}°</span>`;
    el.hidden = false;
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => {
      el.classList.remove("shown");
      setTimeout(() => { if (!el.classList.contains("shown")) el.hidden = true; }, 400);
    }, 6000);
  }
  // which boost-active helper (if any) suppresses the HA-side autopilot automation for this
  // climate entity while a boost is running — lets boost run WITHOUT disabling autopilot
  _boostHelperFor(id) {
    return id === this._config.partner_climate_entity ? this._config.partner_boost_active_entity : this._config.boost_active_entity;
  }
  // input_datetime that a HA-side automation watches with a time trigger to clear the boost flag
  _boostUntilFor(id) {
    return id === this._config.partner_climate_entity ? this._config.partner_boost_until_entity : this._config.boost_until_entity;
  }
  // write an absolute end time into the boost_until helper (epoch seconds) so the server-side
  // failsafe can end the boost even if this browser goes away
  _setBoostUntil(id, ms) {
    const ent = this._boostUntilFor(id);
    if (ent && this._hass) this._hass.callService("input_datetime", "set_datetime", { entity_id: ent, timestamp: Math.round(ms / 1000) });
  }
  _smartEntityFor(id) {
    return id === this._config.partner_climate_entity ? this._config.partner_smart_entity : this._config.smart_entity;
  }
  // bed_state_entity for an arbitrary climate entity id (not necessarily the active side) —
  // used by _applyTemp so a boost ending on a side you've since switched away from still targets
  // the right sensor for the eight_sleep.heat_set raw-level path
  _bedStateEntityFor(id) {
    return (id === this._config.partner_climate_entity ? this._config.partner_bed_state_entity : this._config.bed_state_entity)
      || id.replace(/^climate\./, "sensor.").replace(/_climate$/, "_bed_state");
  }
  _suggestedEntityFor(id) {
    return id === this._config.partner_climate_entity ? this._config.partner_suggested_entity : this._config.suggested_entity;
  }
  // opts: { temp, minutes } — omit for the classic one-tap "straight to max" boost
  _startBoost(dir, opts) {
    this._haptic("medium");
    const id = this._activeEntity();
    this._ensureOn();
    const boostHelper = this._boostHelperFor(id);
    if (boostHelper) this._hass.callService("input_boolean", "turn_on", { entity_id: boostHelper });
    else this._disableSmartForManual();   // no suppression helper configured — fall back to disabling autopilot
    const { min, max } = this._range();
    // Pre Cool Sleep (cool, tapped plain) defaults to a gentle target/duration, not max cool;
    // Heat boost (warm, tapped plain) still jumps straight to max heat as before
    const defaultTemp = dir === "cool"
      ? (Number.isFinite(this._config.precool_sleep_temp) ? this._config.precool_sleep_temp : min)
      : max;
    const defaultMins = dir === "cool"
      ? (Number.isFinite(this._config.precool_sleep_minutes) ? this._config.precool_sleep_minutes : 30)
      : (Number.isFinite(this._config.boost_minutes) ? this._config.boost_minutes : 30);
    const extreme = opts && Number.isFinite(opts.temp) ? Math.max(min, Math.min(max, opts.temp)) : Math.max(min, Math.min(max, defaultTemp));
    // switching direction mid-boost keeps the ORIGINAL pre-boost temp to revert to, not the
    // other direction's extreme
    const existing = this._boostState.get(id);
    const prevTemp = existing ? existing.prevTemp : this._tgtTemp();
    const mins = opts && Number.isFinite(opts.minutes) ? opts.minutes : defaultMins;
    this._clearBoost(id);
    const until = Date.now() + mins * 60000;
    const timer = setTimeout(() => this._endBoost(id, true), mins * 60000);
    this._boostState.set(id, { until, prevTemp, dir, timer });
    if (boostHelper) this._setBoostUntil(id, until);   // server-side failsafe end time
    this._overrideTemp = extreme;
    this._pendingTemp = extreme;
    this._update();
    this._applyTemp(extreme);
  }
  _endBoost(id, revert) {
    const b = this._boostState.get(id);
    if (!b) return;
    this._clearBoost(id);
    const boostHelper = this._boostHelperFor(id);
    if (boostHelper && this._hass) {
      this._hass.callService("input_boolean", "turn_off", { entity_id: boostHelper });
      this._setBoostUntil(id, Date.now());   // boost ended early — collapse the failsafe window
    }
    if (revert && this._hass && this._isOnEntity(id)) {
      // resume autopilot's own target if it's still on for this side, else the pre-boost temp
      const smartId = this._smartEntityFor(id);
      const smartOn = !!(smartId && this._hass.states[smartId] && this._hass.states[smartId].state === "on");
      const suggId = this._suggestedEntityFor(id);
      const suggState = suggId && this._hass.states[suggId] && parseFloat(this._hass.states[suggId].state);
      const target = smartOn && Number.isFinite(suggState) ? suggState : b.prevTemp;
      this._applyTemp(target, id);
      if (id === this._activeEntity()) { this._overrideTemp = target; this._pendingTemp = target; }
    }
    this._update();
  }

  _toggleAway() {
    const id = this._awayEntity() || this._config.away_entity;
    if (!id) return;
    const dom = id.split(".")[0];
    this._hass.callService(dom === "input_boolean" || dom === "switch" ? dom : "homeassistant", "toggle", { entity_id: id });
  }

  /* ---------- per-side Away switch (Solo/Dual + on/off signal) ---------- */
  // Only used when a side has a REAL away *switch* (the old pod_3_* path, which never reported a
  // true climate "off"). The stock-firmware / MQTT path (climate.eight_sleep_pod_*) reports a real
  // "off", so away_entity there is just the vacation input_boolean driving the "Away" chip — NOT a
  // power signal. Ignore non-switch entities here so power/Solo/Dual fall back to plain climate on/off.
  _awayEntityFor(id) {
    const e = (id === this._config.partner_climate_entity
      ? this._config.partner_away_entity
      : this._config.away_entity) || null;
    return e && e.split(".")[0] === "switch" ? e : null;
  }
  _awayEntity() { return this._awayEntityFor(this._activeEntity()); }
  _awayOnFor(id) {
    const a = this._awayEntityFor(id);
    const s = a && this._hass && this._hass.states[a];
    return !!s && s.state === "on";
  }
  // turn a whole side on (Away off + heat on) or off (Away on) via its Away switch;
  // falls back to plain climate on/off when the side has no Away switch (cloud path)
  _setSideActive(id, active) {
    const away = this._awayEntityFor(id);
    if (!away) { this._hass.callService("climate", active ? "turn_on" : "turn_off", { entity_id: id }); return; }
    const dom = away.split(".")[0] === "input_boolean" ? "input_boolean" : "switch";
    this._hass.callService(dom, active ? "turn_off" : "turn_on", { entity_id: away });
    if (active) this._hass.callService("climate", "turn_on", { entity_id: id });
  }

  /* ---------- wake-up light (sunrise alarm) ---------- */
  _wakeLightOn() {
    const e = this._hass && this._hass.states[this._config.alarm_light_toggle_entity];
    return !!e && e.state === "on";
  }
  _wakeLightEntity() {
    const e = this._hass && this._hass.states[this._config.alarm_light_select_entity];
    return e && /^light\./.test(e.state) ? e.state : "";
  }
  _wakeLightName() {
    const id = this._wakeLightEntity();
    if (!id) return "";
    const e = this._hass.states[id];
    return (e && e.attributes && e.attributes.friendly_name) || id.replace(/^light\./, "").replace(/_/g, " ");
  }
  _toggleWakeLight() {
    const id = this._config.alarm_light_toggle_entity;
    if (!id) return;
    this._haptic("light");
    this._hass.callService("input_boolean", "toggle", { entity_id: id });
  }

  _moreInfo() {
    this.dispatchEvent(new CustomEvent("hass-more-info", {
      detail: { entityId: this._activeEntity() },
      bubbles: true,
      composed: true,
    }));
  }

  _setOpen(v) { this._open = v; this._update(); }

  /* ---------- alarm / bedtime formatting ---------- */
  _fmtTime(iso) {
    try {
      const d = new Date(iso);
      if (isNaN(d)) return null;
      let h = d.getHours();
      const m = d.getMinutes();
      const ap = h >= 12 ? "pm" : "am";
      h = h % 12; if (h === 0) h = 12;
      return { t: h + ":" + String(m).padStart(2, "0"), ap };
    } catch (e) { return null; }
  }

  // formatted time from a schedule phase's time_entity (live), or null
  _phaseTime(key) {
    const p = this._phases().find((x) => x.key === key);
    if (!p || !p.time_entity) return null;
    const ent = this._hass.states[p.time_entity];
    if (ent && ent.state && ent.state !== "unknown" && ent.state !== "unavailable") {
      return this._fmtHM(ent.state);
    }
    return null;
  }

  _staticTime(str, dt, dap) {
    const m = /(\d{1,2}):(\d{2})\s*(am|pm)/i.exec(str || "");
    if (m) return { t: m[1] + ":" + m[2], ap: m[3].toLowerCase() };
    return { t: dt, ap: dap };
  }

  _alarm() {
    // 1) an explicit alarm_entity (e.g. Eight Sleep next_alarm timestamp) if it has a real value
    const id = this._config.alarm_entity;
    if (id && this._hass.states[id]) {
      const f = this._fmtTime(this._hass.states[id].state);
      if (f) return f;
    }
    // 2) the wake phase from the schedule (so it tracks what you set)
    const w = this._phaseTime("wake");
    if (w) return w;
    // 3) static fallback
    return this._staticTime(this._config.alarm, "7:30", "am");
  }

  _bedtime() {
    // track the bedtime phase from the schedule; fall back to static config
    return this._phaseTime("bedtime") || this._staticTime(this._config.bedtime, "10:00", "pm");
  }

  /* ---------- gauge geometry ---------- */
  // drag anywhere on a ring (dial gauge or the temp-tile ring) to set the target temperature
  _wireGaugeDrag() {
    this._wireRing(this.shadowRoot.querySelector(".gauge"), 160, 160, 320, this._gauge);
    // wire the whole ring WRAP (not just the thin svg ring) so grabbing the number drags too
    this._wireRing(this.shadowRoot.getElementById("tempRingWrap"), 66, 66, 132, this._ring);
    this._wireTrackDrag(this.shadowRoot.getElementById("tempTrack"));   // v2 Home's temperature axis
    this.shadowRoot.querySelectorAll(".gl-gauge[data-glside]").forEach((el) => this._wireGlowGauge(el));   // v2 Glow Home gauges
  }
  // v2 only: drag anywhere on the Home temperature axis, value follows live, commits on release
  _wireTrackDrag(track) {
    if (!track) return;
    // The rect is read ONCE per gesture. Reading it per move — after the drag has just
    // written styles — forces a synchronous layout on every single pointermove, and moves
    // fire several times per value step. That was the last of the slider lag.
    let dragging = false, lastV = null, rect = null, lastHap = 0;
    const at = (e) => {
      const r = rect || (rect = track.getBoundingClientRect());
      const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      const { min, max, step } = this._range();
      return Math.max(min, Math.min(max, Math.round((min + frac * (max - min)) / step) * step));
    };
    const tick = () => { const t = Date.now(); if (t - lastHap < 45) return; lastHap = t; this._haptic("light"); };
    track.style.touchAction = "none";
    track.addEventListener("pointerdown", (e) => {
      dragging = true; rect = track.getBoundingClientRect();
      try { track.setPointerCapture(e.pointerId); } catch (_) {}
      this._ensureOn();
      this._disableSmartForManual();
      const v = at(e); lastV = v; this._overrideTemp = v; this._dragMode(true); this._update(); tick(); e.preventDefault(); e.stopPropagation();
    });
    track.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const v = at(e);
      if (v !== lastV) { lastV = v; this._overrideTemp = v; this._dragPaint(v); tick(); }
    });
    const end = () => { if (!dragging) return; dragging = false; rect = null; this._dragMode(false); if (lastV != null) this._setTemp(lastV); this._update(); };
    track.addEventListener("pointerup", end);
    track.addEventListener("pointercancel", end);
  }
  /* While a ring or the temperature axis is being dragged, running the full _update()
     on every step is what made the slider feel laggy: it re-renders the timeline, the
     presets, the charts and the autopilot panel, ~10ms on desktop and several times
     that on a phone, for a gesture that fires many times a second. This paints ONLY
     the four things that follow the finger; everything else catches up on release. */
  _dragPaint(v) {
    const $ = (id) => this.shadowRoot.getElementById(id);
    const frac = this._frac(v), txt = this._fmtVal(v);
    const main = $("homeLevelMain"); if (main) main.textContent = txt;
    const dcl = $("dcLevel"); if (dcl) dcl.textContent = txt;
    const thumb = $("tempThumb"); if (thumb) thumb.style.left = (frac * 100).toFixed(1) + "%";
    const glSide = this._viewingPartner() ? "partner" : "self";
    if ($("glFill_" + glSide)) this._glPaintGauge(glSide, v, true);
    if (this._xrOn()) this._xrDragPaint(glSide, v);
    const rg = this._ring, rFill = $("ringFill"), rKnob = $("ringKnob");
    if (rg && rFill && rKnob) {
      const a = rg.start + frac * rg.sweep;
      rFill.setAttribute("d", this._arcPath(rg.cx, rg.cy, rg.r, rg.start, a));
      const k = this._polar(rg.cx, rg.cy, rg.r, a);
      rKnob.setAttribute("cx", k[0]); rKnob.setAttribute("cy", k[1]);
    }
    const g = this._gauge, gKnob = $("knob"), gFill = $("fill");
    if (g && gKnob && gFill) {
      const a = g.start + frac * g.sweep;
      const k = this._polar(g.cx, g.cy, g.r, a);
      gKnob.setAttribute("cx", k[0]); gKnob.setAttribute("cy", k[1]);
      const c = this._curTemp();
      if (Number.isFinite(c)) {
        const ca = g.start + this._frac(c) * g.sweep;
        gFill.setAttribute("d", this._arcPath(g.cx, g.cy, g.r, Math.min(a, ca), Math.max(a, ca)));
      }
    }
  }
  // the knob must not glide to where the finger already is
  _dragMode(on) {
    const r = this.shadowRoot;
    if (!r) return;
    r.querySelectorAll(".pod, .overlay").forEach((el) => el.classList.toggle("is-dragging", !!on));
    if (this._xrOn()) this._xrDragging = !!on;
  }
  _wireRing(svg, cx, cy, vb, geom) {
    if (!svg) return;
    let dragging = false, lastV = null, rect = null, lastHap = 0;
    const at = (e) => {
      const r = rect || (rect = svg.getBoundingClientRect());
      const sx = (e.clientX - r.left) / r.width * vb;
      const sy = (e.clientY - r.top) / r.height * vb;
      let deg = Math.atan2(sy - cy, sx - cx) * 180 / Math.PI + 90;
      if (deg > 180) deg -= 360;
      const frac = Math.max(0, Math.min(1, (deg - geom.start) / geom.sweep));
      const { min, max, step } = this._range();
      return Math.max(min, Math.min(max, Math.round((min + frac * (max - min)) / step) * step));
    };
    const tick = () => { const t = Date.now(); if (t - lastHap < 45) return; lastHap = t; this._haptic("light"); };
    svg.style.touchAction = "none";
    svg.addEventListener("pointerdown", (e) => {
      dragging = true; rect = svg.getBoundingClientRect();
      try { svg.setPointerCapture(e.pointerId); } catch (_) {}
      this._ensureOn();
      this._disableSmartForManual();
      const v = at(e); lastV = v; this._overrideTemp = v; this._dragMode(true); this._update(); tick(); e.preventDefault();
    });
    svg.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const v = at(e);
      if (v !== lastV) { lastV = v; this._overrideTemp = v; this._dragPaint(v); tick(); }
    });
    const end = () => { if (!dragging) return; dragging = false; rect = null; this._dragMode(false); if (lastV != null) this._setTemp(lastV); this._update(); };
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointercancel", end);
  }
  // Apple Health bridge (v10.29): ask the native shell to do something, and remember what it
  // said so Settings can show it. No-op in a browser — the row isn't rendered there.
  _hkWire() {
    if (this._hkWired || typeof window === "undefined" || !window.__POD_HEALTH) return;
    this._hkWired = true;
    window.addEventListener("pod-health-result", (e) => {
      this._hkState = (e && e.detail) || {};
      this._setSig = null;
      if (this._view === "settings") this._renderSettings();
    });
    window.dispatchEvent(new CustomEvent("pod-health", { detail: "status" }));
  }
  _hkAsk(action) {
    if (typeof window === "undefined" || !window.__POD_HEALTH) return;
    this._hkWire();
    this._haptic("light");
    this._hkState = Object.assign({}, this._hkState, { message: action === "backfill" ? "Writing\u2026" : "Asking Health\u2026" });
    this._setSig = null; this._renderSettings();
    window.dispatchEvent(new CustomEvent("pod-health", { detail: action }));
  }

  // haptic feedback: HA companion app listens for the "haptic" event; navigator.vibrate is the web fallback
  _haptic(type = "light") {
    try { this.dispatchEvent(new CustomEvent("haptic", { detail: type, bubbles: true, composed: true })); } catch (e) { /* noop */ }
    try {
      if (navigator.vibrate) navigator.vibrate(type === "heavy" ? 22 : type === "medium" || type === "success" ? 12 : 6);
    } catch (e) { /* noop */ }
  }
  _polar(cx, cy, r, deg) {
    const a = (deg - 90) * Math.PI / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }
  _arcPath(cx, cy, r, start, end) {
    const [x1, y1] = this._polar(cx, cy, r, start);
    const [x2, y2] = this._polar(cx, cy, r, end);
    const large = (end - start) % 360 > 180 ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
  }

  set hass(hass) {
    this._hass = hass;
    this._etaSample();   // roll the temperature-trend window for the ETA estimate
    // "autopilot just adjusted" flash: compares the ACTIVE side's suggested temp to the last
    // value seen for it — a real change while autopilot is on briefly flashes a badge on the
    // Smart Autopilot panel header, so you can see it working without opening anything
    {
      const suggId = this._sc("suggested_entity");
      const smartId = this._sc("smart_entity");
      const suggSt = suggId && hass.states[suggId];
      if (suggSt) {
        const val = parseFloat(suggSt.state);
        const smartOn = !!(smartId && hass.states[smartId] && hass.states[smartId].state === "on");
        if (Number.isFinite(val)) {
          if (!this._lastSuggested) this._lastSuggested = {};
          const prev = this._lastSuggested[suggId];
          // Keep the gauge's target in sync with Autopilot's own adjustments. The HA-side apply
          // automation often moves the setpoint via eight_sleep.heat_set for half-degree steps,
          // which never touches climate.*'s target_temperature attribute (see _applyTemp) — so
          // without this, _overrideTemp would stay frozen at whatever it was when Autopilot was
          // last turned on (or last manually set) and the gauge would stop tracking real changes.
          // Only reconciles on an actual change (or the first tick after Autopilot is found
          // already on) so it never fights a manual drag/bump in progress.
          if (smartOn && (prev === undefined || Math.abs(val - prev) > 0.001)) {
            this._overrideTemp = val;
            this._pendingTemp = null;
            clearTimeout(this._halfTempTimer); this._halfTempTimer = null;
          }
          if (prev !== undefined && smartOn) this._flashAutopilot(prev, val);
          this._lastSuggested[suggId] = val;
        }
      }
    }
    // clear the optimistic power flag once the cloud reports the state we asked for
    if (this._pendingOn != null && this._isOn() === this._pendingOn) {
      this._pendingOn = null;
      if (this._powerTimer) { clearTimeout(this._powerTimer); this._powerTimer = null; }
    }
    // clear the optimistic partner-side flag once the bed-side sensor catches up
    if (this._pendingPartner != null && this._partnerOnReal() === this._pendingPartner) {
      this._pendingPartner = null;
      if (this._partnerTimer) { clearTimeout(this._partnerTimer); this._partnerTimer = null; }
    }
    // clear the optimistic prime flag once the is-priming sensor catches up
    if (this._pendingPrime != null && this._primingRaw() === this._pendingPrime) {
      this._pendingPrime = null;
      if (this._primeTimer) { clearTimeout(this._primeTimer); this._primeTimer = null; }
    }
    // clear optimistic override once the entity reflects our commit — whole-degree commits only.
    // A half-degree commit went through eight_sleep.heat_set instead, and climate.*'s own
    // target_temperature attribute never reflects it (see _applyTemp) — clearing _overrideTemp
    // there would make the display snap back to that unrelated whole-degree attribute the moment
    // the raw level landed, i.e. right when the fractional target is finally confirmed. So a
    // half-degree _overrideTemp is left in place as the authoritative display value until the next
    // manual change (a fresh commit, boost, power-off, or side switch already clear it elsewhere);
    // _pendingTemp alone times out below so it doesn't block a follow-up commit.
    if (this._pendingTemp !== null && this._pendingTemp !== undefined) {
      if (Math.abs(this._pendingTemp - Math.round(this._pendingTemp)) < 0.001) {
        const c = this._clim();
        if (c && Math.abs(c.attributes.temperature - this._pendingTemp) < 0.6) {
          this._pendingTemp = null;
          this._overrideTemp = null;
        }
      } else if (!this._halfTempTimer) {
        this._halfTempTimer = setTimeout(() => { this._pendingTemp = null; this._halfTempTimer = null; }, 15000);
      }
    }
    if (!this._built) this._build();
    // the Coach tab's helper can arrive after the first build — rebuild once when it does
    if (this._built && this._coachTabOn() && !this.shadowRoot.querySelector('.tab[data-view="coach"]')
        && this._layout === "v2") {
      this._built = false;
      this._build();
    }
    this._update();
  }

  /* ================= build (once) ================= */
  _dialHTML() {
    return `
      <div class="ov-hd">
        <button class="ov-title" id="closeDial">
          <span id="ovTitleText">Your temperature</span> ${ICON_CHEV}
        </button>
        <button class="pwr-btn" id="powerDial" aria-label="Power">${ICON_POWER}</button>
      </div>
      <div class="ov-sub" id="ovSub"></div>
      <span class="side-sel dial-sel" id="sideSelDial" hidden>
        <span class="ss-opt" data-side="self">${escapeHtml(this._config.own_label || "You")}</span>
        <span class="ss-opt" data-side="partner">${escapeHtml(this._config.partner_name || "Partner")}</span>
      </span>

      <div class="dial">
        <svg viewBox="0 0 320 320" class="gauge">
          <defs>
            <linearGradient id="fillgrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#8fa6ff"/>
              <stop offset="100%" stop-color="#3f6bff"/>
            </linearGradient>
            <linearGradient id="fillgradWarm" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#ffb06a"/>
              <stop offset="100%" stop-color="#ff6a3d"/>
            </linearGradient>
          </defs>
          <path id="track" class="track" fill="none" stroke-linecap="round"></path>
          <path id="fill" class="fill" fill="none" stroke-linecap="round"></path>
          <g id="ticks"></g>
          <line id="curtick" class="curtick"></line>
          <circle id="knob" class="knob" r="11"></circle>
        </svg>
        <div class="dial-center">
          <div class="dc-verb" id="dcVerb">Cooling to</div>
          <div class="dc-level" id="dcLevel">-3</div>
          <div class="dc-now" id="dcNow">Currently at +7</div>
        </div>
      </div>

      <div class="ov-steppers">
        <span class="circ big" id="dialMinus" aria-label="Cooler">${ICON_MINUS}</span>
        <span class="circ big" id="dialPlus" aria-label="Warmer">${ICON_PLUS}</span>
      </div>

      ${this._config.smart_entity ? `
      <button class="sm-dialrow" id="smartRowDial">
        <span class="smart-ic">${ICON_SPARK}</span>
        <span class="smart-lbl">Smart Autopilot</span>
        <span class="smart-sug" id="smartSugDial"></span>
        <span class="smart-switch" id="smartSwitchDial" role="switch" aria-label="Smart Autopilot">${SW_GLASS}<span class="sk">${SW_GLASS}</span></span>
        <span class="smart-chev">${ICON_CHEVR}</span>
      </button>
      <div class="sm-dialextra" id="smDialExtra"></div>` : ""}

      <div class="presets" id="presets"></div>

      <div class="autopilot" id="autopilot">
        <svg class="ring" viewBox="0 0 40 40" aria-hidden="true">
          <circle class="ring-bg" cx="20" cy="20" r="16"></circle>
          <circle class="ring-fg" id="ringFg" cx="20" cy="20" r="16" transform="rotate(-90 20 20)"></circle>
        </svg>
        <span class="status-text" id="statusText">Idle</span>
      </div>

      <div class="timeline" id="timeline"></div>`;
  }

  _podHTML() {
    if (this._layout === "v2") return this._podHTMLv2();
    const c = this._config;
    const v2 = this._layout === "v2";
    return `
      <div class="pod${v2 ? " layout-v2" : ""}" id="podRoot">
        <div class="hd">
          <div class="hd-left">
            ${c.show_logo === false ? "" : `<span class="hd-logo">${ICON_ES8}</span>`}
            <div class="hd-title" id="hdTitle">${escapeHtml(c.title)}</div>
          </div>
          <div class="hd-right">
            ${this._headerNavHTML()}
            <button class="hd-gear" id="hdGear" aria-label="Settings">${ICON_GEAR}</button>
          </div>
        </div>
        <div class="view-routine" id="viewRoutine" hidden>${this._routineHTML()}</div>
        <div class="view-settings" id="viewSettings" hidden></div>
        <div class="view-pod" id="viewPod">
        <div class="bed-wrap" id="bed"></div>
        ${v2 ? `<div class="v2-status" id="v2Status"></div>` : ""}
        ${c.priming_entity ? `
        <div class="prime-bar" id="primeStatus">
          <span class="ps-dot"></span>
          <span class="ps-text" id="psText"></span>
          <span class="ps-water" id="psWater"><span class="ps-drop">${ICON_DROP}</span><span id="psWaterTxt"></span></span>
          <button class="prime-btn" id="primeBtn">Prime</button>
          <button class="prime-btn cancel" id="primeCancel" hidden>Cancel</button>
        </div>` : ""}
        ${c._partnerUi ? `
        <div class="side-toggle" id="sideToggleRow">
          <span class="st-ic">${ICON_BED}</span>
          <span class="st-lbl" id="sideLbl">${escapeHtml(c.partner_label || "Partner side")}</span>
          <span class="smart-switch" id="sideSwitch" role="switch" aria-label="Partner side">${SW_GLASS}<span class="sk">${SW_GLASS}</span></span>
        </div>` : ""}
        <button class="tile temp-tile wide" id="tempTile">
          <div class="tile-row">
            <span class="tile-label" id="tileLabel">Temperature</span>
            <span class="side-sel" id="sideSel" hidden>
              <span class="ss-opt" data-side="self">${escapeHtml(c.own_label || "You")}</span>
              <span class="ss-opt" data-side="partner">${escapeHtml(c.partner_name || "Partner")}</span>
            </span>
            <span class="power" id="powerHome" aria-label="Power">${ICON_POWER}</span>
          </div>
          <div class="temp-main">
            <div class="temp-ring-wrap" id="tempRingWrap">
              <svg class="temp-ring" id="tempRing" viewBox="0 0 132 132">
                <path class="tr-track" id="ringTrack" fill="none" stroke-linecap="round"></path>
                <path class="tr-fill" id="ringFill" fill="none" stroke-linecap="round"></path>
                <path class="tr-prog" id="ringProg" fill="none" stroke-linecap="round"></path>
                <circle class="tr-cur" id="ringCur" r="4"></circle>
                <circle class="tr-knob" id="ringKnob" r="7"></circle>
              </svg>
              <div class="big-level" id="homeLevel">
                <span class="bl-main" id="homeLevelMain">0</span>
                <span class="bl-sub" id="homeLevelSub"></span>
              </div>
            </div>
            <div class="steppers">
              <span class="circ" id="homeMinus" aria-label="Cooler">${ICON_MINUS}</span>
              <span class="circ" id="homePlus" aria-label="Warmer">${ICON_PLUS}</span>
            </div>
          </div>
        </button>
        ${v2 ? `
        <div class="v2-boost" id="v2Boost">
          <button class="chip boost warm" data-boost="warm">${ICON_FLAME}<span>Warm boost</span></button>
          <button class="chip boost cool" data-boost="cool" data-boost-holdable="1">${ICON_SNOW}<span>Cool boost</span></button>
        </div>
        ${c.smart_entity ? `
        <div class="v2-mode" id="v2Mode">
          <button class="v2m-opt" data-v2mode="auto">Autopilot</button>
          <button class="v2m-opt" data-v2mode="manual">Manual</button>
        </div>` : ""}` : ""}
        <div class="info-strip">
          <div class="info-chip"><span class="ic">${ICON_BED}</span><span class="il">Bedtime</span><span class="iv" id="bedtime"></span></div>
          <div class="info-chip" id="alarmChip"><span class="ic">${ICON_ALARM}</span><span class="il">Alarm</span><span class="iv" id="alarm"></span><span class="wl-flag" id="alarmWl" hidden title="Wake-up light on">${ICON_SUN}</span></div>
        </div>
        <div class="info-chip wide" id="onSinceChip"><span class="ic">${ICON_CLOCK}</span><span class="il">On for</span><span class="iv" id="onSince"></span></div>
        ${c.smart_entity ? `
        <div class="smart-panel" id="smartPanel">
          <button class="smp-head" id="smpHead">
            <span class="smart-ic">${ICON_SPARK}</span>
            <span class="smp-title">Smart Autopilot</span>
            <span class="smp-sug" id="smpSug"></span>
            <span class="smart-switch" id="smpSwitch" role="switch" aria-label="Smart Autopilot">${SW_GLASS}<span class="sk">${SW_GLASS}</span></span>
          </button>
          <div class="smp-flash" id="smpFlash" hidden></div>
          <div class="smp-body" id="smpBody">
            <div class="smp-up" id="smpUp"></div>
            <div class="smp-chart" id="smpChart"></div>
            <div class="smp-why">
              <div class="smp-why-hd">Why this temperature</div>
              <div class="sm-factors" id="smpWhy"></div>
              <div class="sm-ctx" id="smpCtx"></div>
            </div>
            <div class="sm-bias smp-bias">
              <div class="sm-bias-l">
                <div class="sm-bias-t">Adjust</div>
                <div class="sm-bias-h">cooler ‹ &nbsp; › warmer</div>
              </div>
              <div class="sm-bias-ctl">
                <span class="circ sm-b" id="smpBiasMinus" aria-label="Cooler">${ICON_MINUS}</span>
                <span class="sm-bias-v" id="smpBiasVal">0°</span>
                <span class="circ sm-b" id="smpBiasPlus" aria-label="Warmer">${ICON_PLUS}</span>
              </div>
            </div>
          </div>
        </div>` : ""}
        <div class="manual-panel" id="manualPanel">
          <div class="mp-label">Manual schedule</div>
          <div class="presets" id="podPresets"></div>
          <div class="autopilot manual-status" id="podStatus">
            <svg class="ring" viewBox="0 0 40 40" aria-hidden="true">
              <circle class="ring-bg" cx="20" cy="20" r="16"></circle>
              <circle class="ring-fg" cx="20" cy="20" r="16" transform="rotate(-90 20 20)"></circle>
            </svg>
            <span class="status-text">Idle</span>
          </div>
          <div class="timeline manual-only" id="podTimeline"></div>
          ${c.auto_off_entity ? `
          <div class="auto-off" id="autoOffRow">
            <span class="ao-ic">${ICON_POWER}</span>
            <span class="ao-lbl">Auto-off bed</span>
            <button class="ao-time" id="autoOffTime">–</button>
            <span class="smart-switch" id="autoOffSwitch" role="switch" aria-label="Auto-off">${SW_GLASS}<span class="sk">${SW_GLASS}</span></span>
          </div>` : ""}
        </div>
        ${v2 ? `<div class="v2-next" id="v2Next" hidden></div><div class="v2-chips" id="v2Chips"></div>` : ""}
        </div>
      </div>`;
  }

  // ===================================================================================
  // v2 — the redesign. Fully separate markup from classic above: hero-first Home, a
  // floating Liquid Glass tab bar instead of the header lens nav, a Sleep tab for last night
  // and a Sleep Coach tab for tonight, and a Schedule tab that answers "what happens tonight"
  // or lets you edit the night directly (Autopilot off). Deliberately its own class
  // ("v2home", not the legacy "layout-v2") so none of the old v2 CSS quirks apply.
  // ===================================================================================
  _podHTMLv2() {
    const c = this._config;
    const primeBar = c.priming_entity ? `
        <div class="prime-bar" id="primeStatus">
          <span class="ps-dot"></span>
          <span class="ps-text" id="psText"></span>
          <span class="ps-water" id="psWater"><span class="ps-drop">${V2_ICON_DROP}</span><span id="psWaterTxt"></span></span>
          <button class="prime-btn" id="primeBtn">Prime</button>
          <button class="prime-btn cancel" id="primeCancel" hidden>Cancel</button>
        </div>` : "";
    return `
      <div class="pod v2home glow${c.boxes === false || this._xrOn() ? " nobox" : ""}${this._xrOn() ? " xray" : ""}" id="podRoot">
        <div class="gl-bg" aria-hidden="true"></div>
        <div class="hd">
          <div class="hd-left">
            ${c.show_logo === false ? "" : `<span class="hd-logo">${ICON_ES8}</span>`}
            <div class="hd-title" id="hdTitle">${escapeHtml(c.title)}</div>
          </div>
          <div class="hd-right">
            ${c.smart_entity ? `<span class="sched-chip" id="schedChip" hidden></span>` : ""}
            <!-- Solo/Dual — the ONLY control that turns the partner's side on/off. Plain-labelled
                 (not the icon toggle a previous pass used — it read as a pause button). The
                 "You/Partner" view switch lives at the temp tile now (see .ht-r below) and only
                 appears once Dual is on, animating in/out with it. -->
            ${c._partnerUi ? `
            <span class="side-sel" id="modeSelHd">
              <span class="ss-opt" data-mode="solo">Solo</span>
              <span class="ss-opt" data-mode="dual">Dual</span>
            </span>` : ""}
            <button class="hd-pwr" id="powerHome" aria-label="Power">${V2_ICON_POWER}</button>
          </div>
        </div>
        <!-- The one scrolling region. Header above and tab bar below are permanent chrome —
             neither is part of this box, so neither can ever end up below the fold the way the
             old single-page-scroll layout let them. Exactly one child is visible at a time
             (_setView toggles [hidden]); each gets its own scroll position, remembered by the
             browser across switches for free. -->
        <div class="v2content" id="v2Content">
        <div class="view-routine" id="viewRoutine" hidden>${this._routineHTMLv2()}</div>
        ${c.smart_entity ? `<div class="view-autopilot" id="viewAutopilot" hidden>${this._smartHTMLv2()}</div>` : ""}
        <div class="view-settings" id="viewSettings" hidden></div>
        ${this._sleepTabOn() ? `<div class="view-sleep" id="viewSleep" hidden>${this._sleepHTMLv2()}</div>` : ""}
        ${this._coachTabOn() ? `<div class="view-coach" id="viewCoach" hidden>${this._coachHTMLv2()}</div>` : ""}
        ${c.dev_view !== false ? `<div class="view-dev" id="viewDev" hidden>${this._devHTMLv2()}</div>` : ""}
        ${this._xrOn() ? this._xrHomeHTML(primeBar) : this._glowHomeHTML(primeBar)}
        </div><!-- /v2content -->
        <!-- Liquid Glass tab bar: permanent chrome, always on screen — see .v2home below -->
        <div class="tabbar" id="tabBar">
          <i class="lens" id="tabLens"></i>
          ${this._tabBtnV2("pod", V2_ICON_HOME, "Home")}
          ${this._tabBtnV2("routine", V2_ICON_SCHED, "Schedule")}
          ${c.smart_entity ? this._tabBtnV2("autopilot", V2_ICON_SPARK_TAB, "Autopilot") : ""}
          ${this._sleepTabOn() ? this._tabBtnV2("sleep", V2_ICON_SLEEP, "Sleep") : ""}
          ${this._coachTabOn() ? this._tabBtnV2("coach", V2_ICON_COACH, "Coach") : ""}
          ${c.settings_tab !== false ? this._tabBtnV2("settings", V2_ICON_GEAR_TAB, "Settings") : ""}
        </div>
      </div>`;
  }
  // one weekly-routine row: name + day-range on the left, time-range + chevron on the right —
  // a single tappable row (opens the bedtime picker; the alarm is reachable via hold/second tap
  // isn't needed — tapping anywhere on the row edits bedtime, matching the wireframe's single
  // "10:00 PM · 7:45 AM" read-out with one chevron, not two separate edit targets)
  _routineRowV2(key, label, days, bedEnt, alarmEnt) {
    return `<button class="v2trow" data-pick-ent="${bedEnt}" data-pick-label="${escapeHtml(label)} bedtime">
        <span class="v2rt-name">${escapeHtml(label)}<span class="v2rt-sub">${escapeHtml(days)}</span></span>
        <span class="v2rt-times" id="rt_${key}_times">–</span>
        <span class="v2chev">${V2_ICON_CHEVR}</span>
      </button>`;
  }
  // Schedule: answers "what happens tonight" before it offers settings. Both the
  // Autopilot-on card (bedtime/alarm as big targets) and the Autopilot-off step rail are
  // always in the DOM — _renderRoutine() toggles which is visible, live, as Autopilot is
  // switched — the "three things that fire around the alarm" and weekly routines sit
  // below either way, since they're independent of who's driving. The "who's driving" chip
  // lives in the shared header (see _podHTMLv2()'s #schedChip), not here.
  _routineHTMLv2() {
    const pre = this._config.schedule_prefix || "eight_sleep_me";
    const bedEnt = `input_datetime.${pre}_bedtime`, wakeEnt = `input_datetime.${pre}_wake`;
    const c = this._config;
    return `
      <div class="v2rowhd">
        <span class="v2label">Tonight</span>
        <span class="v2rowhd-sub" id="schedRoutineLbl">Weekday routine</span>
      </div>
      <div class="v2card" id="rtProgressCard">
        <button class="v2slot" data-pick-ent="${bedEnt}" data-pick-label="Bedtime">
          <span class="v2ic bed">${V2_ICON_BED}</span>
          <span class="v2col"><span class="v2t" id="rtBed">–</span><span class="v2l">Bedtime</span></span>
          <span class="v2chev">${V2_ICON_CHEVR}</span>
        </button>
        <button class="v2slot" data-pick-ent="${wakeEnt}" data-pick-label="Wake">
          <span class="v2ic alarm">${V2_ICON_ALARM}</span>
          <span class="v2col"><span class="v2t" id="rtAlarm">–</span><span class="v2l" id="rtAlarmLbl">Alarm</span></span>
          <span class="v2chev">${V2_ICON_CHEVR}</span>
        </button>
        <div class="v2precool">
          <span class="v2ic snow">${V2_ICON_SNOW}</span>
          <span id="precoolTxt">Pre-cool starts &mdash; 40 min before bed</span>
        </div>
      </div>
      <div class="v2card" id="stepCard" hidden>
        <div class="v2label" style="margin:14px 0 2px 2px">Tonight's temperatures</div>
        <div class="mp-label" id="mpLabel">Tap a step to set its time and temperature</div>
        <div class="step-rail" id="stepRail"></div>
        <div class="autopilot manual-status" id="podStatus">
          <svg class="ring" viewBox="0 0 40 40" aria-hidden="true">
            <circle class="ring-bg" cx="20" cy="20" r="16"></circle>
            <circle class="ring-fg" cx="20" cy="20" r="16" transform="rotate(-90 20 20)"></circle>
          </svg>
          <span class="status-text">Idle</span>
        </div>
      </div>
      <div class="v2label section">Around your alarm</div>
      <div class="v2card">
        ${c.alarm_light_toggle_entity ? `
        <button class="v2trow v2trow-wl" id="wlPick">
          <span class="v2ic sun">${V2_ICON_SUN}</span>
          <span class="v2tt">Wake-up light<span class="v2ts" id="wlName">Choose a light</span></span>
          <span class="smart-switch" id="wlSwitch" role="switch" aria-label="Wake-up light">${SW_GLASS}<span class="sk">${SW_GLASS}</span></span>
        </button>` : ""}
        <div class="v2trow">
          <span class="v2ic flame">${V2_ICON_FLAME}</span>
          <span class="v2tt">Warm wake<span class="v2ts">+4&deg; over the last 30 minutes before your alarm</span></span>
          <span class="smart-switch" id="warmWakeSwitch" role="switch" aria-label="Warm wake">${SW_GLASS}<span class="sk">${SW_GLASS}</span></span>
        </div>
        ${c.auto_off_entity ? `
        <button class="v2trow" id="autoOffRowV2">
          <span class="v2ic power">${V2_ICON_POWER}</span>
          <span class="v2tt">Turn the bed off after<span class="v2ts" id="autoOffTimeV2">&ndash;</span></span>
          <span class="smart-switch" id="autoOffSwitchV2" role="switch" aria-label="Auto-off">${SW_GLASS}<span class="sk">${SW_GLASS}</span></span>
        </button>` : ""}
        ${c.off_when_up_entity ? `
        <button class="v2trow" id="owuRow">
          <span class="v2ic power">${V2_ICON_BED}</span>
          <span class="v2tt">Turn off when I get up<span class="v2ts" id="owuSub">&ndash;</span></span>
          <span class="smart-switch" id="owuSwitch" role="switch" aria-label="Turn off when I get up">${SW_GLASS}<span class="sk">${SW_GLASS}</span></span>
        </button>` : ""}
      </div>
      <div class="v2label section">Routines</div>
      <div class="v2card">
        ${this._routineRowV2("weekday", "Weekdays", "Mon – Fri", c.weekday_bedtime_entity, c.weekday_alarm_entity)}
        ${this._routineRowV2("weekend", "Weekends", "Sat – Sun", c.weekend_bedtime_entity, c.weekend_alarm_entity)}
      </div>
    `;
  }

  // header nav (replaces the hamburger): "lens" = liquid-glass mini toggle, "segmented" = plain, "hamburger" = menu
  _headerNavHTML() {
    const nav = this._config.header_nav;
    if (nav === "hamburger" || nav === false) {
      return `<button class="burger" id="burger" aria-label="More info"><span></span><span></span><span></span></button>`;
    }
    return `<div class="hnav ${nav === "segmented" ? "segmented" : "lens"}" id="headerNav" data-view="pod">
        <span class="hnav-lens" id="hnavLens"></span>
        <button class="hnav-opt" data-view="pod" aria-label="Pod">${ICON_BED}</button>
        <button class="hnav-opt" data-view="routine" aria-label="Routine">${ICON_ALARM}</button>
      </div>`;
  }
  _routineRow(key, label, bedEnt, alarmEnt) {
    return `<div class="rt-card rt-weekly" id="rtcard_${key}">
        <div class="rt-head">${escapeHtml(label)}<span class="rt-active" id="rt_${key}_active"></span></div>
        <div class="rt-times">
          <button class="rt-slot" data-pick-ent="${bedEnt}" data-pick-label="${escapeHtml(label)} bedtime"><span class="rt-ic">${ICON_BED}</span><span class="rt-col"><span class="rt-t" id="rt_${key}_bed">–</span><span class="rt-lbl">Nightly bedtime</span></span></button>
          <button class="rt-slot" data-pick-ent="${alarmEnt}" data-pick-label="${escapeHtml(label)} alarm"><span class="rt-ic">${ICON_ALARM}</span><span class="rt-col"><span class="rt-t" id="rt_${key}_alarm">–</span><span class="rt-lbl">Morning alarm</span></span></button>
        </div>
      </div>`;
  }
  _routineHTML() {
    const pre = this._config.schedule_prefix || "eight_sleep_me";
    const bedEnt = `input_datetime.${pre}_bedtime`, wakeEnt = `input_datetime.${pre}_wake`;
    const c = this._config;
    return `
      <div class="rt-sub" id="rtSub"></div>
      <div class="rt-card rt-progress">
        <div class="rt-badge">In progress routine</div>
        <div class="rt-times">
          <button class="rt-slot" data-pick-ent="${bedEnt}" data-pick-label="Bedtime"><span class="rt-ic">${ICON_BED}</span><span class="rt-col"><span class="rt-t" id="rtBed">–</span><span class="rt-lbl">Tonight's bedtime</span></span></button>
          <button class="rt-slot" data-pick-ent="${wakeEnt}" data-pick-label="Wake"><span class="rt-ic">${ICON_ALARM}</span><span class="rt-col"><span class="rt-t" id="rtAlarm">–</span><span class="rt-lbl">Tomorrow's alarm</span></span></button>
        </div>
      </div>
      ${c.alarm_light_toggle_entity ? `
      <div class="rt-card rt-wl" id="wlCard">
        <div class="rt-head rt-wl-head">
          <span class="wl-ic">${ICON_SUN}</span>Wake-up light
          <span class="smart-switch" id="wlSwitch" role="switch" aria-label="Wake-up light">${SW_GLASS}<span class="sk">${SW_GLASS}</span></span>
        </div>
        <div class="rt-wl-body">
          <button class="rt-slot wl-pick" id="wlPick">
            <span class="rt-ic">${ICON_BULB}</span>
            <span class="rt-col">
              <span class="rt-t wl-name" id="wlName">Choose a light</span>
              <span class="rt-lbl">Sunrise: red 1% → warm white 70%, finishing at your alarm</span>
            </span>
            <span class="wl-chev">${ICON_CHEVR}</span>
          </button>
        </div>
      </div>` : ""}
      <div class="rt-section">Weekly routines</div>
      ${this._routineRow("weekday", "Weekdays", c.weekday_bedtime_entity, c.weekday_alarm_entity)}
      ${this._routineRow("weekend", "Weekends", c.weekend_bedtime_entity, c.weekend_alarm_entity)}
    `;
  }
  // Slide the shared lens under whichever tab is active, measured from the tab's REAL
  // offsetLeft/offsetWidth (not a hardcoded step) — tabs are flex:1 1 0, so their width depends
  // on the device and on whether Autopilot is configured in (3 tabs vs 4). Reading layout here
  // is cheap and only runs on a tab switch or a resize, never per-frame.
  _positionTabLens(force) {
    const tb = this.shadowRoot.getElementById("tabBar");
    const lens = this.shadowRoot.getElementById("tabLens");
    if (!tb || !lens) return;
    // a finger is driving the lens (LN_MIXIN) — a hass tick mustn't yank it home mid-drag
    if (this._ln && this._ln.lx != null && !force) return;
    const active = tb.querySelector('[data-view].on');
    if (!active) return;
    const pad = 4;   // matches the lens's own inset from the old per-tab .lens (5px 4px)
    lens.style.width = (active.offsetWidth - pad * 2) + "px";
    lens.style.transform = `translateX(${active.offsetLeft + pad}px)`;
  }

  /* ================= tab-bar status indicators (v10.30) =================
     Borrowed wholesale from `custom:liquid-lens-navbar-card`'s vocabulary — a small state dot on
     the icon's shoulder, an iOS count badge in the same corner, and a faint tint on the glass
     lens — but sourced differently. That card reads Jinja templates out of its config because it
     can't know what its routes mean; this one already holds every number it would ask for, so
     each tab derives its own indicator and there is nothing to configure. `tab_status: false`
     turns the whole layer off.

     The rule the bar keeps: a dot only appears when it has something to SAY. An armed schedule,
     an Autopilot that's off, a report you've already read — all silent. That's what keeps this
     from fighting the Glow rule that colour on the bar means "here", not "decoration". */

  // One destination. Both status slots are always in the DOM, hidden until _renderTabStatus()
  // fills them — building them up-front keeps the bar's layout fixed, so a dot arriving can
  // never nudge an icon sideways.
  _tabBtnV2(view, icon, label) {
    const ind = this._config.tab_status === false ? "" : `<b class="t-dot"></b><em class="t-badge" hidden></em>`;
    return `<button class="tab" data-view="${view}">${ind}${icon}<span>${label}</span></button>`;
  }

  // Each entry: { tone, pulse, badge, title } or null for "nothing to report".
  // Every value here must be CHEAP and STABLE — this runs on every hass tick and its JSON is the
  // signature that decides whether to touch the DOM at all, so anything that jitters every tick
  // (a live ETA, a heart rate) would defeat the guard. Hence "Heating to 33°", not _bedStatusText().
  _tabStatus() {
    const s = { pod: null, routine: null, autopilot: null, sleep: null, coach: null, settings: null };

    // Home — what the bed is doing, in the bed's own Glow colour (--gl-acc tracks cool/mid/warm).
    // It breathes while still driving toward the target and settles to steady once it's holding,
    // which is the same "live right now" motif as the gauge glow and the vitals dot.
    if (this._effectiveOn()) {
      const dir = this._dir(), working = this._working(), tgt = this._fmtVal(this._tgtTemp());
      const verb = dir === "warm" ? "Heating" : dir === "cool" ? "Cooling" : "Adjusting";
      s.pod = { tone: "acc", pulse: working, title: working ? `${verb} to ${tgt}` : `Holding at ${tgt}` };
    }

    // Schedule — only speaks while something is actually RUNNING. A routine that merely exists
    // isn't news; a wind-down counting down, or a boost/pre-cool window that will hand the bed
    // back in N minutes, is the thing you'd otherwise have to open the tab to discover.
    const wd = this._winddownState(), boost = this._boostActive();
    if (wd && wd.on) s.routine = { tone: "amb", pulse: true, title: `Wind-down · ${Math.max(1, Math.ceil(wd.left / 60000))} min left` };
    else if (boost) s.routine = { tone: "acc", pulse: true, title: `${boost.dir === "cool" ? "Pre-cool" : "Heat boost"} · ${this._boostRemainingLabel(boost)}` };

    // Autopilot — steady while it's the one driving tonight, silent when it isn't.
    if (this._sc("smart_entity") && this._smartOn()) s.autopilot = { tone: "ok", title: "Autopilot is driving tonight" };

    // Sleep — the one genuinely new-mail-shaped signal in the card: last night's report lands
    // while you're asleep, so the dot pulses until you've opened the tab (per device, see
    // _slpMarkSeen), then goes quiet. A night still being processed sits dim instead.
    if (this._sleepTabOn()) {
      const iso = this._slpISO(this._slpNow()), st = this._slpState(this._slpAttrs(), iso);
      if (st === "report" || st === "low") {
        if (this._slpSeen() !== `${this._slpWho()}|${iso}`) s.sleep = { tone: "info", pulse: true, title: "New sleep report" };
      } else if (st === "pending") s.sleep = { tone: "dim", title: "Last night is still processing" };
    }

    // Coach — the single word the whole Coach tab is coloured by, shrunk to a dot. On track is
    // steady; anything off track pulses, because that one IS asking you to do something.
    if (this._coachTabOn()) {
      const cs = this._cchStatus(), tone = this._cchTone(cs);
      if (tone !== "off") s.coach = { tone, pulse: tone !== "ok", title: this._cchWord(cs) };
    }

    // Settings — a red count of things wanting a hand, the one place a NUMBER beats a colour
    // (two problems and one problem are different news). Same idea as the liquid-lens Cog's
    // pending-updates badge, but counting the Pod's own chores.
    const need = [];
    if (this._config.has_water_entity && this._stateStr(this._config.has_water_entity) !== "" && !this._hasWater()) need.push("Add water");
    if (this._needPriming()) need.push("Needs priming");
    const cid = this._activeEntity(), cl = cid && this._hass.states[cid];
    const hl = this._podHealth();
    if (hl && hl.tone === "bad") need.push(hl.text);
    else if (cid && (!cl || cl.state === "unavailable")) need.push("Pod is offline");
    if (need.length) s.settings = { tone: "bad", badge: String(need.length), title: need.join(" · ") };

    return s;
  }

  // Have I already looked at this night's report? Per-device, same localStorage convention (and
  // the same try/catch — private mode, a locked-down webview) as the layout override. The stored
  // value carries WHOSE report it was, so switching to the partner's Sleep tab doesn't mark
  // yours read, and a single stale key can never suppress a genuinely new night.
  _slpSeenKey() { return "es-slp-seen:" + (this._config && this._config.entity); }
  _slpSeen() { try { return window.localStorage.getItem(this._slpSeenKey()) || ""; } catch (e) { return ""; } }
  _slpMarkSeen() {
    const iso = this._slpISO(this._slpNow()), st = this._slpState(this._slpAttrs(), iso);
    if (st !== "report" && st !== "low") return;
    const key = `${this._slpWho()}|${iso}`;
    if (this._slpSeen() === key) return;
    try { window.localStorage.setItem(this._slpSeenKey(), key); } catch (e) {}
  }

  // Paint _tabStatus() onto the bar. Runs on every hass tick, so it's guarded by a signature:
  // the overwhelmingly common tick changes nothing the bar cares about and writes no DOM at all.
  _renderTabStatus() {
    if (this._config.tab_status === false) return;
    const tb = this.shadowRoot.getElementById("tabBar");
    if (!tb) return;
    const st = this._tabStatus();
    const sig = JSON.stringify(st) + "|" + this._view;
    if (sig === this._tabStatusSig) return;
    this._tabStatusSig = sig;
    tb.querySelectorAll("[data-view]").forEach((btn) => {
      const v = st[btn.dataset.view] || null;
      const dot = btn.querySelector(".t-dot"), badge = btn.querySelector(".t-badge");
      // badge and dot share the same corner, so a badge supersedes its tab's dot
      const showDot = !!v && !v.badge;
      if (dot) {
        TAB_TONES.forEach((k) => dot.classList.remove(k));
        if (showDot) dot.classList.add(v.tone);
        dot.classList.toggle("show", showDot);
        dot.classList.toggle("beat", showDot && !!v.pulse);
      }
      if (badge) {
        badge.textContent = v && v.badge ? v.badge : "";
        badge.hidden = !(v && v.badge);
      }
      // the sentence rides on the button itself, so the dot is never the ONLY way to read the
      // status — hover, VoiceOver and a long-press tooltip all get "Settings — Add water"
      const lbl = btn.querySelector("span");
      const name = lbl ? lbl.textContent : btn.dataset.view;
      if (v && v.title) { btn.title = `${name} — ${v.title}`; btn.setAttribute("aria-label", `${name}, ${v.title}`); }
      else { btn.removeAttribute("title"); btn.removeAttribute("aria-label"); }
    });
    // ...and the lens picks up the ACTIVE tab's tone, very faintly — the liquid-lens card's
    // per-route `lens_color`, except here the colour is derived, so it always means something.
    const lens = this.shadowRoot.getElementById("tabLens");
    if (lens) {
      const act = st[this._view];
      lens.style.setProperty("--t-tint", act ? `rgba(${TAB_TONE_RGB[act.tone]},0.13)` : "transparent");
    }
  }
  _setView(v) {
    // v10.29: "recap" / "room" / "insights" are retired — anything still asking for one
    // (a stale deep link, an old config) lands on the Sleep tab, which replaced them.
    if (v === "recap" || v === "room" || v === "insights") v = this._sleepTabOn() ? "sleep" : "pod";
    const next = (v === "routine" || v === "settings" || v === "autopilot" || v === "dev" || v === "sleep" || v === "coach") ? v : "pod";
    if (next === this._view) return;
    this._view = next; this._haptic("light");
    if (this._lnGulp) this._lnGulp();
    if (next !== "sleep") this._slpClosePop();
    if (next !== "coach") this._cchClosePop();
    this._update();
  }
  _fmtEntTime(id) {
    const e = id && this._hass.states[id];
    const hm = e ? this._fmtHM(e.state) : null;
    return hm ? `${hm.t}<span class="ap">${hm.ap}</span>` : "–";
  }
  _renderRoutine() {
    const $ = (id) => this.shadowRoot.getElementById(id);
    const pre = this._config.schedule_prefix || "eight_sleep_me";
    const set = (id, html) => { const el = $(id); if (el) el.innerHTML = html; };
    const sub = $("rtSub"); if (sub) sub.textContent = this._bedStatusText();
    // wake-up light card: switch state, chosen light name, lit outline while enabled
    if (this._config.alarm_light_toggle_entity) {
      const on = this._wakeLightOn();
      const sw = $("wlSwitch"); if (sw) sw.classList.toggle("on", on);
      const card = $("wlCard"); if (card) card.classList.toggle("rt-lit", on);
      const nm = $("wlName");
      if (nm) {
        const name = this._wakeLightName();
        nm.textContent = name || "Choose a light";
        nm.classList.toggle("unset", !name);
      }
    }
    set("rtBed", this._fmtEntTime(`input_datetime.${pre}_bedtime`));
    set("rtAlarm", this._fmtEntTime(`input_datetime.${pre}_wake`));
    set("rt_weekday_bed", this._fmtEntTime(this._config.weekday_bedtime_entity));
    set("rt_weekday_alarm", this._fmtEntTime(this._config.weekday_alarm_entity));
    set("rt_weekend_bed", this._fmtEntTime(this._config.weekend_bedtime_entity));
    set("rt_weekend_alarm", this._fmtEntTime(this._config.weekend_alarm_entity));
    // highlight the routine active tonight (Fri/Sat night = weekend)
    const we = [5, 6].includes(new Date().getDay());
    [["weekday", !we], ["weekend", we]].forEach(([k, on]) => {
      const b = $("rt_" + k + "_active"); if (b) b.textContent = on ? "Active tonight" : "";
      const card = $("rtcard_" + k); if (card) card.classList.toggle("rt-on", on);
    });

    // v2 Schedule only (elements absent under classic — every line below no-ops there):
    // the chip says who's driving, and it decides which of the two top cards is visible.
    const smartOn = this._sc("smart_entity") && this._smartOn();
    const chip = $("schedChip");
    if (chip) {
      chip.classList.toggle("on", !!smartOn);
      chip.innerHTML = `<span class="sc-ico">${V2_ICON_SPARK}</span><span class="sc-txt">Autopilot ${smartOn ? "on" : "off"}</span>`;
    }
    // .rt-card sets its own `display`, which beats the native [hidden] UA rule at equal
    // specificity — toggle inline style.display instead so hiding actually hides.
    const prog = $("rtProgressCard"), stepCard = $("stepCard");
    if (prog && stepCard) {
      prog.style.display = smartOn ? "" : "none";
      stepCard.style.display = smartOn ? "none" : "";
    }
    // "Warm wake" has no backend yet (front-end only, per the current build) — a local,
    // in-memory toggle so the row isn't inert, wired to nothing else.
    const wwSw = $("warmWakeSwitch");
    if (wwSw) wwSw.classList.toggle("on", this._warmWakeOn !== false);

    // v2 only, below — every $() no-ops under classic (none of these ids exist there)
    const routineLbl = $("schedRoutineLbl"); if (routineLbl) routineLbl.textContent = we ? "Weekend routine" : "Weekday routine";
    // format a minutes-of-day offset the same way a real entity's time would render
    const fmtMins = (mins) => { const m = ((mins % 1440) + 1440) % 1440; const hm = this._fmtHM(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`); return hm ? `${hm.t}${hm.ap.toUpperCase()}` : "–"; };
    const bedSt = this._hass.states[`input_datetime.${pre}_bedtime`];
    const bedHM = bedSt && this._fmtHM(bedSt.state);
    const precool = $("precoolTxt");
    if (precool) precool.textContent = bedHM ? `Pre-cool starts ${fmtMins(bedHM.mins - 40)} — 40 min before bed` : "Pre-cool starts 40 min before bed";
    const wakeSt = this._hass.states[`input_datetime.${pre}_wake`];
    const wakeHM = wakeSt && this._fmtHM(wakeSt.state);
    const alarmLbl = $("rtAlarmLbl");
    if (alarmLbl) alarmLbl.textContent = wakeHM ? `Alarm · gentle warm-up from ${fmtMins(wakeHM.mins - 30)}` : "Alarm";
    const timesRow = (key, bedEnt, alarmEnt) => {
      const el = $(`rt_${key}_times`); if (!el) return;
      const b = this._hass.states[bedEnt], a = this._hass.states[alarmEnt];
      const bhm = b && this._fmtHM(b.state), ahm = a && this._fmtHM(a.state);
      el.textContent = (bhm && ahm) ? `${bhm.t}${bhm.ap.toUpperCase()} · ${ahm.t}${ahm.ap.toUpperCase()}` : "–";
    };
    timesRow("weekday", this._config.weekday_bedtime_entity, this._config.weekday_alarm_entity);
    timesRow("weekend", this._config.weekend_bedtime_entity, this._config.weekend_alarm_entity);
    // auto-off, v2's own row/switch ids (autoOffRow/autoOffSwitch stay classic-only — the whole
    // v2 row is one tap target, which classic's plain div never was)
    if (this._config.auto_off_entity) {
      const aoOn = this._autoOffOn();
      const swV2 = $("autoOffSwitchV2"); if (swV2) swV2.classList.toggle("on", aoOn);
      const t2 = $("autoOffTimeV2"); if (t2) t2.textContent = this._fmtEntTime(this._sc("auto_off_entity")).replace(/<[^>]+>/g, "");
    }
    // v10.26 off-when-up: the automation needs 3 h in bed, then turns the Pod off ~15 min after you're up
    if (this._config.off_when_up_entity) {
      const S = this._hass.states, o = S[this._config.off_when_up_entity], ib = S[this._config.in_bed_entity];
      const on = !!o && o.state === "on";
      const sw = $("owuSwitch"); if (sw) sw.classList.toggle("on", on);
      const sub = $("owuSub");
      if (sub) {
        sub.textContent = !o ? "Not set up in Home Assistant"
          : !on ? "Off"
          : ib && ib.state === "on" ? "You’re in bed · off about 15 min after you get up"
          : "In the morning, about 15 min after you get up";
      }
    }
  }


  // ===================================================================================
  // v2 "Sleep" tab — the nightly sleep-statistics view. Fed entirely by the
  // sensor.eight_sleep_pod_{side}_sleep_score entity + its attributes (hypnogram,
  // HR/HRV/breathing series, 7-night trend) that gateway/sleep-pipeline publishes over MQTT.
  // No HA recorder, no history query — one entity read. Hidden unless that entity exists.
  // ===================================================================================
  _sleepScoreEnt() {
    const c = this._config;
    return this._viewingPartner()
      ? (c.partner_sleep_score_entity || c.sleep_score_entity)
      : c.sleep_score_entity;
  }
  _sleepTabOn() {
    // config-time only (the tab bar is built once) — the entity is a free_sleep-preset
    // default, so this is effectively "source: free_sleep and v2 layout". _renderSleep()
    // shows an empty state until the pipeline publishes the first night.
    return this._layout === "v2" && !!this._sleepScoreEnt();
  }
  /* ===================================================================================
     Sleep (v10.25) — the "Report" design (design/sleep-directions, canvas "Pod Sleep").
     One entity read: sensor.eight_sleep_pod_<side>_sleep_score + its attributes, published by
     gateway/sleep-pipeline (nights[] = 7 compact nights, history[] = 30, ranges = personal normal
     ranges, events = moments). Views: night report (+ "How your score adds up" popup), week,
     health check. States: pending (before the morning run), no data, away (vacation mode), low
     confidence, empty (nothing published yet). 12-hour time everywhere.
     =================================================================================== */
  _slpNow() { return this._slpNowOverride ? new Date(this._slpNowOverride) : new Date(); }
  _slpISO(d) {
    const x = new Date(d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  }
  _slpDateOf(iso) { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); }
  _slpShift(iso, days) { const d = this._slpDateOf(iso); d.setDate(d.getDate() + days); return this._slpISO(d); }
  _slpDay(iso, withMonth) {
    const d = this._slpDateOf(iso);
    const wd = d.toLocaleDateString("en-GB", { weekday: "short" });
    const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
    return `${wd} ${d.getDate()}${withMonth ? " " + mon : ""}`;
  }
  _slpClock(epoch) {
    const d = new Date(epoch * 1000); let h = d.getHours();
    const ap = h >= 12 ? "pm" : "am"; h = h % 12 || 12;
    return { t: `${h}:${String(d.getMinutes()).padStart(2, "0")}`, ap };
  }
  _slpTime(epoch) { const c = this._slpClock(epoch); return `${c.t} ${c.ap}`; }
  _slpTimeHTML(epoch) { const c = this._slpClock(epoch); return `${c.t}<small class="slp-ap">${c.ap}</small>`; }
  _slpHour(h) { return `${(h % 12) || 12}${h < 12 ? "am" : "pm"}`; }
  _slpDur(min) {
    if (min == null) return "–";
    const m = Math.round(min);
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
  }
  _slpWho() { return this._slpPerson === "partner" && this._config.partner_sleep_score_entity ? "partner" : "self"; }
  _slpEnt() { const c = this._config; return this._slpWho() === "partner" ? c.partner_sleep_score_entity : c.sleep_score_entity; }
  // "eight_sleep_pod_right" — the tap's per-side prefix, for presence / entered-bed sensors
  _slpSideBase() { return (this._slpEnt() || "").replace(/^sensor\./, "").replace(/_sleep_score$/, ""); }
  _slpAttrs() {
    const st = this._hass && this._hass.states[this._slpEnt()];
    // "unknown" is a DELIBERATE published state for "no valid night tonight, but real history
    // exists" (a rejected/crosstalk night, or one still processing) — its attributes (nights[],
    // history[], ranges) are real and must still drive the week/health-check views. Only a truly
    // absent entity or an "unavailable" (offline) one has nothing worth reading.
    if (!st || st.state === "unavailable") return null;
    return st.attributes || null;
  }
  _slpNights(a) { return a && Array.isArray(a.nights) ? a.nights : []; }
  // one night, normalised: runs -> {a,b,s} epochs, hr -> [[epoch,bpm]] (full resolution for the
  // latest night, 10-minute means for older ones), events as published
  _slpNight(a, iso) {
    const n = this._slpNights(a).find((x) => x.wake_date === iso);
    if (!n) return null;
    const latest = a.wake_date === iso;
    const b0 = n.in_bed_start;
    const code = { w: "wake", l: "light", d: "deep", r: "rem" };
    const runs = (n.runs || []).map(([o, len, c]) => ({ a: b0 + o * 60, b: b0 + (o + len) * 60, s: code[c] || "light" }));
    const hr = latest && Array.isArray(a.heart_rate) && a.heart_rate.length
      ? a.heart_rate : (n.hr10 || []).map(([o, v]) => [b0 + o * 60, v]);
    return Object.assign({}, n, { latest, runs, hr, events: n.events || [] });
  }
  // what to show for a wake date: a report, or one of the states
  _slpState(a, iso) {
    const night = a && this._slpNight(a, iso);
    if (night) return night.confidence === "low" ? "low" : "report";
    if (iso === this._slpISO(this._slpNow())) {
      if (this._slpAway()) return "away";
      const now = this._slpNow();
      if (now.getHours() * 60 + now.getMinutes() < 12 * 60 + 30 && this._slpSleptLastNight()) return "pending";
    }
    return a ? "nodata" : "empty";
  }
  _slpAway() {
    const v = this._config.vacation_entity && this._hass.states[this._config.vacation_entity];
    return !!(v && v.state === "on");
  }
  _slpBedTimes() {
    const base = this._slpSideBase(), S = this._hass.states;
    const ts = (id) => { const e = S[id]; const t = e ? Date.parse(e.state) : NaN; return Number.isFinite(t) ? t / 1000 : null; };
    const pres = S[`binary_sensor.${base}_presence`];
    return { entered: ts(`sensor.${base}_entered_bed_at`), left: ts(`sensor.${base}_left_bed_at`), inBed: !!(pres && pres.state === "on") };
  }
  _slpSleptLastNight() {
    const b = this._slpBedTimes(), now = this._slpNow().getTime() / 1000;
    return b.inBed || (b.entered != null && now - b.entered < 20 * 3600);
  }
  _slpGrade(s) { return s == null ? "" : s >= 85 ? "Great" : s >= 70 ? "Good" : s >= 55 ? "OK" : "Low"; }
  _slpSentence(n) {
    const asl = n.asleep_min || 0, parts = [];
    parts.push(asl >= 480 ? "A long night." : asl >= 420 ? "A solid night." : asl >= 360 ? "A bit short." : "A short night.");
    const wakes = n.events.filter((e) => e.kind === "awake" || e.kind === "out_of_bed");
    const low = n.events.find((e) => e.kind === "lowest_hr");
    if (wakes.length >= 3) parts.push(`You woke ${wakes.length} times, ${Math.round(n.waso_min || 0)} minutes in all.`);
    else if ((n.latency_min || 0) >= 30) parts.push(`It took ${Math.round(n.latency_min)} minutes to fall asleep.`);
    else if (low) parts.push(`Your heart rate was lowest around ${this._slpTime(low.t)}.`);
    return parts.join(" ");
  }
  _slpRange(a, key) { const r = a && a.ranges && a.ranges[key]; return r && r.lo != null ? r : null; }
  // the 7 wake dates ending today, each with its night (or null)
  _slpWeek(a) {
    const today = this._slpISO(this._slpNow());
    return Array.from({ length: 7 }, (_, i) => {
      const iso = this._slpShift(today, i - 6);
      return { iso, night: this._slpNights(a).find((n) => n.wake_date === iso) || null };
    });
  }

  _sleepHTMLv2() { return `<div class="slp" id="slpRoot"></div>`; }
  _renderSleep(force) {
    const root = this.shadowRoot.getElementById("slpRoot");
    if (!root || !this._hass) return;
    this._slpMarkSeen();   // you're looking at it -> the tab bar's "new report" dot goes quiet
    const st = this._hass.states[this._slpEnt()];
    const a = this._slpAttrs();
    const today = this._slpISO(this._slpNow());
    const iso = this._slpDate && this._slpDate <= today ? this._slpDate : today;
    const view = this._slpView || "night";
    // _update() calls this on every hass tick — only rebuild when something shown changed
    const sig = [this._slpWho(), iso, view, st && st.last_updated, this._slpAway(), today,
      this._slpNowOverride || 0, this._slpTempSig || "", this._slpStatSig || ""].join("|");
    if (!force && root.childElementCount && this._slpSig === sig) return;
    this._slpSig = sig;
    const state = this._slpState(a, iso);
    let body;
    if (view === "week") body = this._slpWeekHTML(a);
    else if (view === "month") body = this._slpMonthHTML(a);
    else if (view === "health") body = this._slpHealthHTML(a);
    else if (state === "report" || state === "low") body = this._slpReportHTML(a, iso, state === "low");
    else body = this._slpStateHTML(state, a, iso);
    root.innerHTML = (view === "health" ? "" : this._slpTopHTML(a, iso, view)) + body;
    if (view === "night" && (state === "report" || state === "low")) this._slpAfterNight(a, iso);
    if (view === "month" && a) this._slpEnsureStats();
  }
  _slpTopHTML(a, iso, view) {
    const c = this._config, today = this._slpISO(this._slpNow());
    const names = [c.self_name || "You", c.partner_name || "Partner"];
    const who = c.partner_sleep_score_entity
      ? `<span class="slp-seg slp-who">${["self", "partner"].map((k, i) =>
        `<button class="slp-opt${this._slpWho() === k ? " on" : ""}" data-slp-who="${k}">${escapeHtml(names[i])}</button>`).join("")}</span>` : "";
    let title, sub, prevOn, nextOn;
    if (view === "week") {
      title = "This week";
      sub = `${this._slpDay(this._slpShift(today, -6))} – ${this._slpDay(today, true)}`;
      prevOn = nextOn = false;
    } else if (view === "month") {
      title = "Last 30 days";
      sub = `${this._slpDay(this._slpShift(today, -29))} – ${this._slpDay(today, true)}`;
      prevOn = nextOn = false;
    } else {
      const prev = this._slpShift(iso, -1);
      title = iso === today ? "Last night"
        : `${this._slpDateOf(prev).toLocaleDateString("en-GB", { weekday: "long" })} night`;
      sub = `${this._slpDay(prev)} → ${this._slpDay(iso, true)}`;
      prevOn = iso > this._slpShift(today, -6);
      nextOn = iso < today;
    }
    const seg = [["night", "Night"], ["week", "Week"], ["month", "Month"]].map(([k, l]) =>
      `<button class="slp-opt${view === k ? " on" : ""}" data-slp-view="${k}">${l}</button>`).join("");
    return `
      ${who ? `<div class="slp-whorow">${who}</div>` : ""}
      <div class="slp-date">
        <button class="slp-arrow" data-slp-go="-1" aria-label="Previous night"${prevOn ? "" : " disabled"}>${GLOW_ICON_CHEVL}</button>
        <div class="slp-dt"><b>${title}</b><em>${sub}</em></div>
        <button class="slp-arrow" data-slp-go="1" aria-label="Next night"${nextOn ? "" : " disabled"}>${V2_ICON_CHEVR}</button>
        <span class="slp-seg">${seg}</span>
      </div>`;
  }

  // ---------- night report: scores, stages ----------
  _slpReportHTML(a, iso, low) {
    const n = this._slpNight(a, iso);
    return (low ? this._slpLowBannerHTML(n) : "")
      + this._slpScoresHTML(a, n, low)
      + this._slpStagesHTML(n, low)
      + this._slpNightHTML(n)
      + (low ? "" : this._slpVitalsHTML(a, n) + this._slpMomentsHTML(n))
      + (n.latest ? this._slpRawHTML(a) : "");
  }
  _slpArcPath(cx, cy, r, a0, a1) {
    const p = (a) => { const t = a * Math.PI / 180; return [cx + r * Math.sin(t), cy - r * Math.cos(t)]; };
    const [x0, y0] = p(a0), [x1, y1] = p(a1);
    return { d: `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`, p };
  }
  // the sleep score: Home's arc + rounded white handle, lilac (GLOW_PAL.mid)
  _slpScoreArc(score) {
    const cx = 98, cy = 98, r = 80, a0 = -115, a1 = 115;
    const av = a0 + (a1 - a0) * Math.max(0, Math.min(100, score || 0)) / 100;
    const track = this._slpArcPath(cx, cy, r, a0, a1);
    const lit = this._slpArcPath(cx, cy, r, a0, Math.max(a0 + 0.5, av));
    const [kx, ky] = track.p(av);
    return `<svg viewBox="0 0 196 142" class="slp-arc" aria-hidden="true">
      <defs><linearGradient id="slpArcG" gradientUnits="userSpaceOnUse" x1="${cx - r}" y1="0" x2="${cx + r}" y2="0">
        <stop offset="0" stop-color="${GLOW_PAL.mid.lo}"/><stop offset="1" stop-color="${GLOW_PAL.mid.hi}"/></linearGradient></defs>
      <path d="${track.d}" class="slp-arc-track"/>
      <path d="${lit.d}" class="slp-arc-glow"/>
      <path d="${lit.d}" class="slp-arc-fill"/>
      <circle cx="${kx.toFixed(1)}" cy="${ky.toFixed(1)}" r="9" class="slp-arc-knob"/></svg>`;
  }
  // Recovery: your normal HRV range as the lit band, last night as the handle
  _slpRangeArc(value, range, vmin, vmax) {
    const cx = 78, cy = 96, r = 60, a0 = -115, a1 = 115;
    const ang = (v) => a0 + (a1 - a0) * (Math.max(vmin, Math.min(vmax, v)) - vmin) / (vmax - vmin);
    const track = this._slpArcPath(cx, cy, r, a0, a1);
    let band = "", knob = "";
    if (range) {
      const b = this._slpArcPath(cx, cy, r, ang(range.lo), ang(range.hi)).d;
      band = `<path d="${b}" class="slp-band-glow"/><path d="${b}" class="slp-band"/>`;
    }
    if (value != null) {
      const [kx, ky] = track.p(ang(value));
      knob = `<circle cx="${kx.toFixed(1)}" cy="${ky.toFixed(1)}" r="8" class="slp-arc-knob hrv"/>`;
    }
    return `<svg viewBox="0 0 156 142" class="slp-arc" aria-hidden="true"><path d="${track.d}" class="slp-arc-track thin"/>${band}${knob}</svg>`;
  }
  _slpLowBannerHTML(n) {
    const m = /(\d+)% epoch/.exec((n.notes || []).join(" "));
    const txt = m
      ? `The Pod only caught your heart rate for about ${m[1]}% of the night, so the score is less certain and stages are left out.`
      : "This night was too short or patchy to read well, so the score is less certain and stages are left out.";
    return `<div class="gl-tile slp-banner"><span class="slp-bic">${SLP_ICON_ALERT}</span>
      <div><span class="gl-lbl">Rough estimate</span><p>${txt}</p></div></div>`;
  }
  _slpScoresHTML(a, n, low) {
    const rng = this._slpRange(a, "hrv_mean"), hrv = n.hrv_mean;
    const rn = a.ranges && a.ranges.hrv_mean ? a.ranges.hrv_mean.n || 0 : 0;
    const r0 = rng && Math.round(rng.lo), r1 = rng && Math.round(rng.hi);
    let recWord;
    if (low || hrv == null) recWord = "Not enough readings";
    else if (!rng) recWord = `Learning your range · ${rn} of 5 nights`;
    else if (hrv < rng.lo) recWord = `Below your usual ${r0}–${r1}`;
    else if (hrv > rng.hi) recWord = `Above your usual ${r0}–${r1}`;
    else recWord = `Normal · usual ${r0}–${r1}`;
    const chip = low
      ? `<span class="slp-chip warn">${SLP_ICON_ALERT}Low confidence</span>`
      : `<span class="slp-chip">${V2_ICON_INFO}Estimate</span>`;
    return `<div class="gl-tile slp-scores">
      <div class="gl-row"><span class="gl-lbl">Sleep &amp; recovery</span>${chip}</div>
      <div class="slp-two">
        <button class="slp-scorebtn${low ? " low" : ""}" data-slp-pop="breakdown"${low ? " disabled" : ""} aria-label="How your score adds up">
          <span class="slp-arcwrap">${this._slpScoreArc(n.score)}
            <span class="slp-arcnum"><b>${low ? "~" : ""}${n.score != null ? n.score : "–"}</b><span>score</span></span></span>
          <span class="slp-cap">Sleep</span><span class="slp-capw${low ? " warn" : ""}">${low ? "Rough estimate" : this._slpGrade(n.score)}</span>
        </button>
        <div class="slp-rec">
          <span class="slp-arcwrap rec">${this._slpRangeArc(low ? null : hrv, rng, 20, 130)}
            <span class="slp-arcnum rec"><b>${low || hrv == null ? "–" : Math.round(hrv)}</b><span>ms HRV</span></span></span>
          <span class="slp-cap">Recovery</span><span class="slp-capw hrv${low || hrv == null ? " dim" : ""}">${recWord}</span>
        </div>
      </div>
      ${low ? "" : `<p class="slp-sent">${escapeHtml(this._slpSentence(n))}</p>
      <button class="slp-link" data-slp-pop="breakdown">How your score adds up${V2_ICON_CHEVR}</button>`}
    </div>`;
  }
  // whole-hour marks between two epochs, every 2h on odd hours (1am, 3am, 5am, 7am), clear of the ends
  _slpHourMarks(a0, a1) {
    const out = [], d = new Date(a0 * 1000);
    d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1);
    for (let t = d.getTime() / 1000; t < a1; t += 3600) {
      const h = new Date(t * 1000).getHours(), pct = (t - a0) / ((a1 - a0) || 1) * 100;
      if (h % 2 === 1 && pct > 14 && pct < 86) out.push({ t, pct, label: this._slpHour(h) });
    }
    return out;
  }
  _slpStagesHTML(n, low) {
    if (low) return `<div class="gl-tile">
        <div class="gl-row"><span class="gl-lbl">Sleep stages</span><span class="slp-chip">Not enough data</span></div>
        <div class="slp-nostage"><i></i><i></i><i></i><i></i><span>Stages need steadier readings, so we won’t guess.</span></div>
        <div class="slp-kvrow top"><span>Time in bed</span><div><b>${this._slpDur(n.in_bed_min)}</b></div></div>
      </div>`;
    const sm = n.stages_min || {}, asleep = n.asleep_min || 0;
    const pct = (k) => (asleep ? Math.round((sm[k] || 0) / asleep * 100) : 0);
    const dot = (ok) => `<i class="slp-dot ${ok ? "good" : "warn"}"></i>`;
    const stat = (name, k, lo, hi) => `<div class="slp-stat"><span>${name}</span>
      <div><b>${Math.round(sm[k] || 0)}m</b><i class="slp-sep"></i><b>${pct(k)}%</b>${dot(pct(k) >= lo && pct(k) <= hi)}</div></div>`;
    const inRange = asleep >= 390 && asleep <= 540;
    const a0 = n.runs.length ? n.runs[0].a : n.in_bed_start, a1 = n.runs.length ? n.runs[n.runs.length - 1].b : n.in_bed_end;
    const marks = this._slpHourMarks(a0, a1);
    return `<div class="gl-tile slp-stages">
      <div class="gl-row"><span class="gl-lbl">Sleep stages</span><span class="slp-chip">${V2_ICON_INFO}Estimated</span></div>
      <div class="slp-stats">${stat("Deep sleep", "deep", 13, 23)}${stat("REM", "rem", 18, 28)}</div>
      ${this._slpHypnoSVG(n, a0, a1, marks)}
      <div class="slp-hypax">
        <span class="l"><b>${this._slpTime(n.in_bed_start)}</b>Bedtime</span>
        ${marks.map((m) => `<span class="m" style="left:${m.pct.toFixed(1)}%">${m.label}</span>`).join("")}
        <span class="r"><b>${this._slpTime(n.in_bed_end)}</b>Wake-up</span>
      </div>
      <div class="slp-legend">${[["wake", "Awake"], ["rem", "REM"], ["light", "Light"], ["deep", "Deep"]]
        .map(([k, l]) => `<span><i class="st-${k}"></i>${l}</span>`).join("")}</div>
      <div class="slp-kvrow top"><span>Time slept</span>
        <div><span class="slp-kvv"><b>${this._slpDur(asleep)}</b>${dot(inRange)}</span>
          <em>${inRange ? "In range (6.5–9h)" : asleep < 390 ? "Under 6.5h" : "Over 9h"}</em></div></div>
    </div>`;
  }
  // stepped stage chart: a row per stage, a rounded block per run, thin connectors at each change
  _slpHypnoSVG(n, a0, a1, marks) {
    const W = 366, rh = 30, bh = 20, H = rh * 4 + 10, row = { wake: 0, rem: 1, light: 2, deep: 3 };
    const x = (t) => (t - a0) / ((a1 - a0) || 1) * W, yc = (s) => row[s] * rh + rh / 2;
    let g = "";
    for (let r = 0; r < 4; r++) g += `<line x1="0" x2="${W}" y1="${r * rh + rh / 2}" y2="${r * rh + rh / 2}" class="slp-grid"/>`;
    for (let i = 0; i + 1 < n.runs.length; i++) {
      const xb = x(n.runs[i].b).toFixed(1);
      g += `<line x1="${xb}" x2="${xb}" y1="${yc(n.runs[i].s)}" y2="${yc(n.runs[i + 1].s)}" class="slp-conn"/>`;
    }
    n.runs.forEach((r) => {
      const w = Math.max(2, x(r.b) - x(r.a));
      g += `<rect x="${x(r.a).toFixed(1)}" y="${yc(r.s) - bh / 2}" width="${w.toFixed(1)}" height="${bh}" rx="${Math.min(4, w / 2).toFixed(1)}" class="st-${r.s}"/>`;
    });
    [a0, ...marks.map((m) => m.t), a1].forEach((t) => {
      const xt = x(t).toFixed(1);
      g += `<line x1="${xt}" x2="${xt}" y1="${H - 8}" y2="${H}" class="slp-tick"/>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" class="slp-hyp" aria-hidden="true">${g}</svg>`;
  }

  // ---------- the night: heart rate + bed temperature + presence, drag to scrub ----------
  _slpNightHTML(n) {
    return `<div class="gl-tile slp-nighttile">
      <div class="gl-row"><span class="gl-lbl">The night</span><span class="slp-note">drag to scrub</span></div>
      <div class="slp-readout" id="slpReadout"></div>
      <div class="slp-chartwrap" id="slpChart">${this._slpNightSVG(n)}</div>
      ${this._slpAirNoteHTML(n)}
    </div>`;
  }
  // v10.26: one plain line about the bedroom air across the time in bed
  _slpAirNoteHTML(n) {
    const air = this._slpAirPts(n);
    if (!air) return "";
    const pm = this._slpStepStats(air.pm, n.in_bed_start, n.in_bed_end);
    const rh = this._slpStepStats(air.rh, n.in_bed_start, n.in_bed_end);
    const bits = [];
    if (pm) {
      const word = pm.avg <= 12 ? "clean" : pm.avg <= 35.4 ? "a little dusty" : "poor";
      bits.push(`Air was ${word} (PM2.5 avg ${pm.avg.toFixed(1)}${pm.hi > 35.4 ? `, peak ${Math.round(pm.hi)}` : ""})`);
    }
    if (rh) {
      const feel = rh.avg < 30 ? "dry" : rh.avg > 60 ? "humid" : "comfortable";
      bits.push(`humidity ${Math.round(rh.lo)}–${Math.round(rh.hi)}%, ${feel}`);
    }
    if (!bits.length) return "";
    const warn = (pm && pm.avg > 12) || (rh && (rh.avg < 30 || rh.avg > 60));
    return `<div class="slp-airnote${warn ? " warn" : ""}"><span class="slp-airkey"><i class="pm"></i>PM2.5<i class="rh"></i>Humidity</span><p>${escapeHtml(bits.join(" · "))}.</p></div>`;
  }
  _slpTempKey(n) { return `${this._slpWho()}|${n.in_bed_start}`; }
  _slpTempPts(n) { return (this._slpTemps || {})[this._slpTempKey(n)] || null; }
  _slpNightSVG(n) {
    const W = 366, H = 150, top = 6, lab = 16, pres = 8, ph = H - top - lab - pres;
    const X0 = n.in_bed_start - 900, X1 = n.in_bed_end + 900;
    const hv = n.hr.map((p) => p[1]).filter(Number.isFinite);
    const hrLo = hv.length ? Math.min(...hv) - 3 : 50, hrHi = hv.length ? Math.max(...hv) + 3 : 80;
    const temps = this._slpTempPts(n) || [];
    const tv = temps.map((p) => p[1]).filter(Number.isFinite);
    const tLo = tv.length ? Math.min(...tv) - 1.5 : 24, tHi = tv.length ? Math.max(...tv) + 1.5 : 33;
    const air = this._slpAirPts(n);
    const AH = air ? 44 : 0, ay0 = H + 6, ah = AH - 10;
    const pmv = air ? air.pm.map((p) => p[1]) : [], rhv = air ? air.rh.map((p) => p[1]) : [];
    const pmHi = Math.max(15, ...pmv), rhLo = rhv.length ? Math.min(...rhv) - 3 : 30, rhHi = rhv.length ? Math.max(...rhv) + 3 : 60;
    this._slpGeo = { W, H, top, ph, X0, X1, hrLo, hrHi, tLo, tHi, AH, ay0, ah, pmHi, rhLo, rhHi };
    const x = (t) => ((t - X0) / ((X1 - X0) || 1)) * W;
    const yh = (v) => top + ph - (Math.max(hrLo, Math.min(hrHi, v)) - hrLo) / ((hrHi - hrLo) || 1) * ph;
    const yt = (v) => top + ph - (Math.max(tLo, Math.min(tHi, v)) - tLo) / ((tHi - tLo) || 1) * ph;
    let g = "";
    this._slpHourMarks(X0, X1).forEach((m) => {
      const xt = x(m.t).toFixed(1);
      g += `<line x1="${xt}" x2="${xt}" y1="${top}" y2="${top + ph}" class="slp-grid"/><text x="${xt}" y="${H - 2}" class="slp-xlab">${m.label}</text>`;
    });
    n.events.filter((e) => e.kind === "awake" || e.kind === "out_of_bed").forEach((e) => {
      const w = Math.max(3, x(e.t + (e.min || 0) * 60) - x(e.t));
      g += `<rect x="${x(e.t).toFixed(1)}" y="${top}" width="${w.toFixed(1)}" height="${ph}" rx="2" class="slp-wake"/>`;
    });
    if (temps.length > 1) {
      const d = temps.map(([t, v], i) => `${i ? "L" : "M"}${x(t).toFixed(1)} ${yt(v).toFixed(1)}`).join(" ");
      g += `<path d="${d}" class="slp-temp-glow"/><path d="${d}" class="slp-temp"/>`;
    }
    const gapMax = n.latest ? 12 * 60 : 25 * 60;
    let seg = [];
    const flush = () => { if (seg.length > 1) g += `<polyline points="${seg.join(" ")}" class="slp-hr"/>`; seg = []; };
    n.hr.forEach(([t, v], i) => {
      if (i && t - n.hr[i - 1][0] > gapMax) flush();
      seg.push(`${x(t).toFixed(1)},${yh(v).toFixed(1)}`);
    });
    flush();
    g += `<rect x="${x(n.in_bed_start).toFixed(1)}" y="${top + ph + 3}" width="${Math.max(2, x(n.in_bed_end) - x(n.in_bed_start)).toFixed(1)}" height="3" rx="1.5" class="slp-pres"/>`;
    if (air) {
      // PM2.5 as a soft area from the band floor, humidity as a line across it (step series)
      g += `<rect x="0" y="${ay0}" width="${W}" height="${ah}" rx="7" class="slp-airbg"/>`;
      const steps = (pts, yv) => {
        const vis = pts.filter((p) => p[0] <= X1);
        if (!vis.length) return "";
        let d = "", prevY = null;
        vis.forEach(([t, v], i) => {
          const xt = x(Math.max(X0, t)).toFixed(1), yy = yv(v).toFixed(1);
          d += i ? `L${xt} ${prevY}L${xt} ${yy}` : `M${xt} ${yy}`;
          prevY = yy;
        });
        return `${d}L${W} ${prevY}`;
      };
      const ypm = (v) => ay0 + ah - Math.min(1, Math.max(0, v) / pmHi) * (ah - 4);
      const yrh = (v) => ay0 + ah - 3 - (Math.max(rhLo, Math.min(rhHi, v)) - rhLo) / ((rhHi - rhLo) || 1) * (ah - 6);
      const pd = steps(air.pm, ypm);
      if (pd) g += `<path d="${pd}L${W} ${ay0 + ah}L${x(Math.max(X0, air.pm[0][0])).toFixed(1)} ${ay0 + ah}Z" class="slp-pm"/>`;
      const rd = steps(air.rh, yrh);
      if (rd) g += `<path d="${rd}" class="slp-rh"/>`;
    }
    g += `<g id="slpCur" class="slp-cur"><line y1="${top - 4}" y2="${air ? ay0 + ah : top + ph}"/><circle class="c-hr" r="4.5" cy="-20"/><circle class="c-t" r="5" cy="-20"/>${air ? `<circle class="c-rh" r="3.5" cy="-20"/>` : ""}</g>`;
    return `<svg viewBox="0 0 ${W} ${H + AH}" class="slp-night" id="slpNightSvg">${g}</svg>`;
  }
  _slpAfterNight(a, iso) {
    const n = this._slpNight(a, iso);
    if (!n) return;
    this._slpEnsureTemp(n);
    const wrap = this.shadowRoot.getElementById("slpChart");
    if (wrap && !wrap._slpWired) {
      wrap._slpWired = true;
      const at = (ev) => {
        const r = wrap.getBoundingClientRect(), g = this._slpGeo;
        if (!g || !r.width) return;
        const f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
        this._slpCursor = Math.round(g.X0 + f * (g.X1 - g.X0));
        this._slpPaintCursor();
      };
      wrap.addEventListener("pointerdown", (e) => {
        wrap._drag = true;
        try { wrap.setPointerCapture(e.pointerId); } catch (_) { /* synthetic events */ }
        at(e); this._haptic("light");
      });
      wrap.addEventListener("pointermove", (e) => { if (wrap._drag) at(e); });
      ["pointerup", "pointercancel"].forEach((k) => wrap.addEventListener(k, (e) => {
        wrap._drag = false;
        try { wrap.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      }));
    }
    const low = n.events.find((e) => e.kind === "lowest_hr");
    if (this._slpCursor == null || this._slpCursor < n.in_bed_start || this._slpCursor > n.in_bed_end) {
      this._slpCursor = low ? low.t : Math.round((n.in_bed_start + n.in_bed_end) / 2);
    }
    this._slpPaintCursor();
  }
  _slpPaintCursor() {
    const $ = (id) => this.shadowRoot.getElementById(id);
    const a = this._slpAttrs(), g = this._slpGeo;
    if (!a || !g) return;
    const n = this._slpNight(a, this._slpDate || this._slpISO(this._slpNow()));
    if (!n) return;
    const t = Math.max(n.in_bed_start, Math.min(n.in_bed_end, this._slpCursor || n.in_bed_start));
    const near = (arr, maxGap) => {
      let best = null, bd = Infinity;
      (arr || []).forEach((p) => { const d = Math.abs(p[0] - t); if (d < bd) { bd = d; best = p; } });
      return bd <= maxGap ? best : null;
    };
    const hp = near(n.hr, 900), tp = near(this._slpTempPts(n) || [], 1800);
    const air = this._slpAirPts(n);
    const pmAt = air ? this._slpStepAt(air.pm, t) : null, rhAt = air ? this._slpStepAt(air.rh, t) : null;
    const run = n.runs.find((r) => t >= r.a && t < r.b);
    const cur = $("slpCur");
    if (cur) {
      const x = ((t - g.X0) / ((g.X1 - g.X0) || 1)) * g.W;
      const yh = (v) => g.top + g.ph - (Math.max(g.hrLo, Math.min(g.hrHi, v)) - g.hrLo) / ((g.hrHi - g.hrLo) || 1) * g.ph;
      const yt = (v) => g.top + g.ph - (Math.max(g.tLo, Math.min(g.tHi, v)) - g.tLo) / ((g.tHi - g.tLo) || 1) * g.ph;
      cur.setAttribute("transform", `translate(${x.toFixed(1)},0)`);
      const c1 = cur.querySelector(".c-hr"), c2 = cur.querySelector(".c-t");
      if (c1) c1.setAttribute("cy", hp ? yh(hp[1]).toFixed(1) : -20);
      if (c2) c2.setAttribute("cy", tp ? yt(tp[1]).toFixed(1) : -20);
      const c3 = cur.querySelector(".c-rh");
      const rhNow = air ? this._slpStepAt(air.rh, t) : null;
      if (c3) c3.setAttribute("cy", rhNow != null
        ? (g.ay0 + g.ah - 3 - (Math.max(g.rhLo, Math.min(g.rhHi, rhNow)) - g.rhLo) / ((g.rhHi - g.rhLo) || 1) * (g.ah - 6)).toFixed(1) : -20);
    }
    const stage = { wake: "awake", light: "light sleep", deep: "deep sleep", rem: "REM" };
    const ro = $("slpReadout");
    if (ro) {
      ro.innerHTML = `<span class="slp-rt">${this._slpTimeHTML(t)}</span>
        <span class="slp-rl">
          <span class="hr"><i></i>${hp ? `Heart ${Math.round(hp[1])} bpm` : "No reading"}</span>
          <span class="bt"><i></i>${tp ? `Bed ${tp[1].toFixed(1)}°` : "Bed –"}${run ? ` · ${stage[run.s]} (est.)` : ""}</span>
          ${air ? `<span class="air"><i></i>${[pmAt != null ? `PM2.5 ${Math.round(pmAt)}` : "", rhAt != null ? `${Math.round(rhAt)}% humidity` : ""].filter(Boolean).join(" · ") || "Air –"}</span>` : ""}
        </span>`;
    }
  }
  // bed temperature across the night, from HA history (kiosk + app both allow this WS call)
  _slpEnsureTemp(n) {
    const ent = this._slpWho() === "partner" ? this._config.partner_climate_entity : this._config.entity;
    if (!ent || !this._hass || !this._hass.callWS) return;
    this._slpTemps = this._slpTemps || {};
    const key = this._slpTempKey(n);
    if (key in this._slpTemps) return;
    this._slpTemps[key] = null;   // in flight
    // v10.26: the Dyson's PM2.5 and the room humidity ride along in the same call (air band)
    const pmEnt = this._config.pm25_entity || "", rhEnt = this._config.room_humidity_entity || "";
    const ids = [ent, pmEnt, rhEnt].filter((id, i, arr) => id && arr.indexOf(id) === i);
    this._hass.callWS({
      type: "history/history_during_period",
      start_time: new Date((n.in_bed_start - 900) * 1000).toISOString(),
      end_time: new Date((n.in_bed_end + 900) * 1000).toISOString(),
      entity_ids: ids, minimal_response: false, no_attributes: false, significant_changes_only: false,
    }).then((res) => {
      const pts = [];
      this._parseHist((res && res[ent]) || []).forEach((it) => {
        const v = it.state === "off" ? null : parseFloat(it.attrs && it.attrs.temperature);
        if (Number.isFinite(v)) pts.push([Math.round(it.t / 1000), v]);
      });
      const num = (id) => (id ? this._parseHist((res && res[id]) || []) : [])
        .map((it) => [Math.max(n.in_bed_start - 900, Math.round(it.t / 1000)), parseFloat(it.state)])
        .filter((p) => Number.isFinite(p[1]));
      this._slpAir = this._slpAir || {};
      this._slpAir[key] = { pm: num(pmEnt), rh: num(rhEnt) };
      this._slpTemps[key] = pts.length > 1 ? pts : [];
      this._slpTempSig = `${key}:${this._slpTemps[key].length}:${this._slpAir[key].pm.length}:${this._slpAir[key].rh.length}`;
      this._renderSleep(true);
    }).catch(() => { this._slpTemps[key] = []; });
  }
  _slpAirPts(n) {
    const air = (this._slpAir || {})[this._slpTempKey(n)];
    return air && (air.pm.length || air.rh.length) ? air : null;
  }
  // step-function (sensor state) value at t: the last change at or before it
  _slpStepAt(pts, t) {
    let v = null;
    for (const p of pts || []) { if (p[0] <= t) v = p[1]; else break; }
    return v;
  }
  // time-weighted mean / min / max of a step series over [a, b]
  _slpStepStats(pts, a, b) {
    if (!pts || !pts.length) return null;
    let sum = 0, w = 0, lo = Infinity, hi = -Infinity;
    pts.forEach((p, i) => {
      const t0 = Math.max(a, p[0]), t1 = Math.min(b, i + 1 < pts.length ? pts[i + 1][0] : b);
      if (t1 <= t0) return;
      sum += p[1] * (t1 - t0); w += t1 - t0;
      lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]);
    });
    return w ? { avg: sum / w, lo, hi } : null;
  }

  // ---------- vitals + moments ----------
  _slpMed(arr) {
    const v = arr.filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
    if (!v.length) return null;
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }
  _slpBars(vals, focus, col) {
    const W = 96, H = 30, real = vals.filter((v) => Number.isFinite(v));
    if (!real.length) return `<svg viewBox="0 0 ${W} ${H}" class="slp-mbars"></svg>`;
    const spread = (Math.max(...real) - Math.min(...real)) || 1;
    const lo = Math.min(...real) - spread * 0.45, hi = Math.max(...real) + spread * 0.1;
    const step = W / vals.length;
    const bars = vals.map((v, i) => {
      const x = (i * step + step / 2).toFixed(1);
      if (!Number.isFinite(v)) return `<circle cx="${x}" cy="${H - 3}" r="1.6" class="slp-mgap"/>`;
      const h = (v - lo) / ((hi - lo) || 1) * (H - 5);
      return `<line x1="${x}" x2="${x}" y1="${H - 3}" y2="${(H - 3 - h).toFixed(1)}" class="slp-mbar${i === focus ? " on" : ""}" style="stroke:${col}"/>`;
    }).join("");
    return `<svg viewBox="0 0 ${W} ${H}" class="slp-mbars">${bars}</svg>`;
  }
  _slpVitalsHTML(a, n) {
    const week = this._slpWeek(a);
    const focus = week.findIndex((w) => w.iso === n.wake_date);
    const others = this._slpNights(a).filter((x) => x.wake_date !== n.wake_date);
    const row = (key, name, unit, col, icon, dp) => {
      const fmt = (v) => (dp ? (Math.round(v * 10) / 10).toFixed(1) : String(Math.round(v)));
      const usual = this._slpMed(others.map((x) => x[key]));
      const vals = week.map((w) => (w.night ? w.night[key] : null));
      return `<div class="slp-vrow">
        <span class="slp-vic" style="--c:${col}">${icon}</span>
        <span class="slp-vname"><b>${name}</b><em>${usual != null ? `usual ${fmt(usual)}` : "no usual yet"}</em></span>
        <span class="slp-vval">${n[key] != null ? fmt(n[key]) : "–"}<small>${unit}</small></span>
        ${this._slpBars(vals, focus, col)}
      </div>`;
    };
    return `<div class="gl-tile slp-vitals">
      <div class="gl-row"><span class="gl-lbl">Vitals</span>
        <button class="slp-link right" data-slp-view="health">Health check${V2_ICON_CHEVR}</button></div>
      ${row("resting_hr", "Resting HR", "bpm", "#ff7f95", GLOW_ICON_HEART, true)}
      ${row("hrv_mean", "HRV", "ms", "#b99bff", SLP_ICON_HRV, false)}
      ${row("br_mean", "Breathing", "/min", "#7fd0ff", SLP_ICON_BREATH, true)}
    </div>`;
  }
  _slpMomentsHTML(n) {
    const kinds = {
      in_bed: [V2_ICON_BED, "#d8c9ff", "In bed", () => ""],
      asleep: [V2_ICON_MOON, "#5fa8ff", "Fell asleep", (e) => (e.min != null ? `took ${Math.round(e.min)} min` : "")],
      awake: [SLP_ICON_EYE, "#e3ecff", "Woke up", (e) => `${e.min} min`],
      out_of_bed: [SLP_ICON_EYE, "#e3ecff", "Got up", (e) => `${e.min} min`],
      lowest_hr: [GLOW_ICON_HEART, "#ff7f95", "Lowest heart rate", (e) => `${e.bpm} bpm`],
      up: [V2_ICON_SUN, "#ff8a5a", "Up", (e) => `${this._slpDur(e.asleep_min)} asleep`],
    };
    const rows = (n.events || []).map((e) => {
      const k = kinds[e.kind];
      if (!k) return "";
      return `<div class="slp-mrow">
        <span class="slp-mt">${this._slpTimeHTML(e.t)}</span>
        <span class="slp-mic" style="--c:${k[1]}">${k[0]}</span>
        <span class="slp-mlbl">${k[2]}</span>
        <span class="slp-mdet">${k[3](e)}</span></div>`;
    }).join("");
    return `<div class="gl-tile slp-moments">
      <div class="gl-row"><span class="gl-lbl">Moments</span></div>
      <div class="slp-mlist"><i class="slp-rail"></i>${rows}</div>
    </div>`;
  }
  // the deep-dive that used to be the whole Sleep tab: every published attribute, collapsed
  _slpRawHTML(a) {
    const big = new Set(["hypnogram", "heart_rate", "hrv", "breathing_rate", "stage_runs", "nights", "history", "diag", "trend", "events", "icon", "friendly_name"]);
    const small = {};
    Object.keys(a).filter((k) => !big.has(k)).sort().forEach((k) => { small[k] = a[k]; });
    small["(series)"] = `hypnogram ${(a.hypnogram || []).length} · hr ${(a.heart_rate || []).length} · stage_runs ${(a.stage_runs || []).length} · nights ${(a.nights || []).length} · history ${(a.history || []).length}`;
    const side = this._slpSideBase().split("_").pop();
    return `<details class="slp-raw"><summary>Raw data</summary>
      <pre>${escapeHtml(JSON.stringify(small, null, 2))}</pre>
      <div class="slp-rawfoot">Terminal deep-dive: <code>gateway/sleep-pipeline/bin/dump.py --date ${a.wake_date || ""} --side ${side} --epochs</code></div>
    </details>`;
  }

  // ---------- week ----------
  _slpWeekHTML(a) {
    const week = this._slpWeek(a);
    const scored = week.filter((w) => w.night && w.night.score != null);
    const avg = scored.length ? Math.round(scored.reduce((s, w) => s + w.night.score, 0) / scored.length) : null;
    const bars = week.map((w) => {
      const d = this._slpDateOf(w.iso).toLocaleDateString("en-GB", { weekday: "short" });
      const on = w.iso === this._slpISO(this._slpNow());
      if (!w.night) {
        const why = on && this._slpAway() ? "away" : "no data";
        return `<button class="slp-wcol${on ? " on" : ""}" data-slp-date="${w.iso}">
          <span class="slp-wv gap">${why}</span><span class="slp-wbar"><i class="gap"></i></span><span class="slp-wd">${d}</span></button>`;
      }
      const h = Math.max(8, (w.night.score - 40) / 60 * 100);
      return `<button class="slp-wcol${on ? " on" : ""}" data-slp-date="${w.iso}">
        <span class="slp-wv">${w.night.score}</span>
        <span class="slp-wbar"><i style="height:${h.toFixed(0)}%"></i></span><span class="slp-wd">${d}</span></button>`;
    }).join("");
    // bedtime / wake capsules on a 10pm -> 10am axis
    const m22 = (epoch) => { const d = new Date(epoch * 1000); return (((d.getHours() - 22) % 24) + 24) % 24 * 60 + d.getMinutes(); };
    const rows = week.map((w) => {
      const d = this._slpDateOf(w.iso).toLocaleDateString("en-GB", { weekday: "short" });
      if (!w.night) return `<div class="slp-caprow"><span>${d}</span><i class="slp-captrack"><em class="none">${this._slpAway() && w.iso === this._slpISO(this._slpNow()) ? "away" : "no data"}</em></i></div>`;
      const l = Math.max(0, Math.min(100, m22(w.night.in_bed_start) / 720 * 100));
      const r = Math.max(l + 1, Math.min(100, m22(w.night.in_bed_end) / 720 * 100));
      return `<div class="slp-caprow"><span>${d}</span><i class="slp-captrack"><b style="left:${l.toFixed(1)}%;width:${(r - l).toFixed(1)}%"></b></i></div>`;
    }).join("");
    const beds = scored.map((w) => m22(w.night.in_bed_start));
    const spread = beds.length > 1 ? Math.max(...beds) - Math.min(...beds) : null;
    const trend = (key, name, unit, col, icon, fmt) => {
      const vals = week.map((w) => (w.night ? w.night[key] : null));
      const real = vals.filter((v) => Number.isFinite(v));
      if (!real.length) return "";
      const av = real.reduce((s, v) => s + v, 0) / real.length;
      return `<div class="slp-vrow">
        <span class="slp-vic" style="--c:${col}">${icon}</span>
        <span class="slp-vname"><b>${name}</b><em>${real.length} of 7 nights</em></span>
        <span class="slp-vval">${fmt(av)}<small>${unit}</small></span>
        ${this._slpBars(vals, week.length - 1, col)}</div>`;
    };
    return `${this._slpConsistencyHTML(a)}<div class="gl-tile">
        <div class="gl-row"><span class="gl-lbl">Sleep score</span>
          <span class="slp-note">${avg != null ? `avg ${avg} · ${scored.length} of 7 nights` : "no nights yet"}</span></div>
        <div class="slp-week">${bars}</div>
      </div>
      <div class="gl-tile">
        <div class="gl-row"><span class="gl-lbl">Bedtime &amp; wake</span>
          <span class="slp-note">${spread != null ? `bedtimes spread ${this._slpDur(spread)}` : ""}</span></div>
        <div class="slp-caps">${rows}</div>
        <div class="slp-capax"><span>10pm</span><span>1am</span><span>4am</span><span>7am</span><span>10am</span></div>
      </div>
      <div class="gl-tile slp-vitals">
        <div class="gl-row"><span class="gl-lbl">Trends</span><span class="slp-note">this week’s average</span></div>
        ${trend("asleep_min", "Asleep", "", GLOW_PAL.mid.hi, V2_ICON_MOON, (v) => this._slpDur(v))}
        ${trend("resting_hr", "Resting HR", "bpm", "#ff7f95", GLOW_ICON_HEART, (v) => (Math.round(v * 10) / 10).toFixed(1))}
        ${trend("hrv_mean", "HRV", "ms", "#b99bff", SLP_ICON_HRV, (v) => String(Math.round(v)))}
      </div>
      ${this._slpWeekInsight(week)}`;
  }
  _slpWeekInsight(week) {
    const scored = week.filter((w) => w.night && w.night.score != null);
    if (scored.length < 3) return "";
    const worst = scored.reduce((a, b) => (a.night.score <= b.night.score ? a : b));
    const best = scored.reduce((a, b) => (a.night.score >= b.night.score ? a : b));
    const mins = (w) => { const d = new Date(w.night.in_bed_start * 1000); return (((d.getHours() - 22) % 24) + 24) % 24 * 60 + d.getMinutes(); };
    const latest = scored.reduce((a, b) => (mins(a) >= mins(b) ? a : b));
    const day = (w) => this._slpDateOf(w.iso).toLocaleDateString("en-GB", { weekday: "long" });
    const txt = latest.iso === worst.iso
      ? `Your latest bedtime, ${this._slpTime(latest.night.in_bed_start)} on ${day(latest)}, was also your lowest score.`
      : `Your best night was ${day(best)} — ${this._slpDur(best.night.asleep_min)} asleep, in bed at ${this._slpTime(best.night.in_bed_start)}.`;
    return `<div class="gl-tile slp-insight"><span class="slp-iic">${V2_ICON_MOON}</span>
      <div><span class="gl-lbl">This week</span><p>${escapeHtml(txt)}</p></div></div>`;
  }

  // ---------- consistency (v10.26, top of Week) ----------
  // clock minutes on a 6 pm-based axis, so 11 pm and 1 am sit next to each other
  _slpM18(epoch) { const d = new Date(epoch * 1000); return ((d.getHours() + 6) % 24) * 60 + d.getMinutes(); }
  _slpM18Clock(m18) {
    const m = (Math.round(m18) + 18 * 60) % 1440;
    return `${(Math.floor(m / 60) % 12) || 12}:${String(m % 60).padStart(2, "0")} ${m < 720 ? "am" : "pm"}`;
  }
  // the routine bedtime for the night before wake date iso (Fri + Sat nights = weekend routine)
  _slpPlanBed(iso) {
    const c = this._config, dow = this._slpDateOf(this._slpShift(iso, -1)).getDay();
    const id = dow === 5 || dow === 6 ? c.weekend_bedtime_entity : c.weekday_bedtime_entity;
    const e = id && this._hass.states[id];
    const m = e && /^(\d{1,2}):(\d{2})/.exec(e.state);
    return m ? ((+m[1] + 6) % 24) * 60 + +m[2] : null;
  }
  _slpConsistency(a) {
    const hist = ((a && a.history) || []).filter((h) => h.in_bed_start && h.in_bed_end);
    const byDate = Object.fromEntries(hist.map((h) => [h.wake_date, h]));
    const week = this._slpWeek(a).map((w) => ({ iso: w.iso, h: byDate[w.iso] || null }));
    const got = week.filter((w) => w.h);
    const beds = got.map((w) => this._slpM18(w.h.in_bed_start)), wakes = got.map((w) => this._slpM18(w.h.in_bed_end));
    const mb = this._slpMed(beds), mw = this._slpMed(wakes);
    // on time = in bed within 30 min of the routine bedtime (your usual one if there's no routine)
    const onTime = (h) => {
      const plan = this._slpPlanBed(h.wake_date), ref = plan != null ? plan : mb;
      return ref != null && Math.abs(this._slpM18(h.in_bed_start) - ref) <= 30;
    };
    week.forEach((w) => { w.on = w.h ? onTime(w.h) : null; });
    const out = { n: got.length, week, pct: null, dev: null, streak: 0 };
    if (got.length < 3) return out;
    const dev = (beds.reduce((t, v) => t + Math.abs(v - mb), 0) + wakes.reduce((t, v) => t + Math.abs(v - mw), 0)) / (2 * got.length);
    out.dev = Math.round(dev);
    out.pct = Math.round(Math.max(0, Math.min(1, 1 - dev / 90)) * 100);
    // streak: back from the latest night, one wake date at a time, while each night was on time
    const today = this._slpISO(this._slpNow());
    let d = byDate[today] ? today : this._slpShift(today, -1);
    while (byDate[d] && onTime(byDate[d])) { out.streak++; d = this._slpShift(d, -1); }
    return out;
  }
  _slpConsistencyHTML(a) {
    const c = this._slpConsistency(a);
    const R = 30, C = 2 * Math.PI * R, pct = c.pct || 0;
    const ring = `<svg viewBox="0 0 76 76" class="slp-cring"><circle cx="38" cy="38" r="${R}" class="trk"/>
      <circle cx="38" cy="38" r="${R}" class="val" stroke-dasharray="${(C * pct / 100).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 38 38)"/></svg>
      <b><span>${c.pct != null ? `${c.pct}<small>%</small>` : "–"}</span></b>`;
    const days = c.week.map((w) => {
      const d = this._slpDateOf(this._slpShift(w.iso, -1)).toLocaleDateString("en-GB", { weekday: "narrow" });
      return `<span class="slp-cday ${!w.h ? "none" : w.on ? "hit" : "miss"}"><i></i>${d}</span>`;
    }).join("");
    const head = c.pct == null ? "Learning your rhythm" : c.pct >= 80 ? "Very steady" : c.pct >= 60 ? "Fairly steady" : "All over the place";
    const sub = c.pct == null ? `Needs 3 nights this week · ${c.n} so far`
      : `Bed and wake times move about ${c.dev < 60 ? `${c.dev} min` : this._slpDur(c.dev)} night to night`;
    const streak = c.streak
      ? `<span class="slp-streak">${V2_ICON_FLAME}${c.streak} night${c.streak === 1 ? "" : "s"} on time</span>`
      : `<span class="slp-streak off">No streak yet</span>`;
    return `<div class="gl-tile slp-consist">
      <div class="gl-row"><span class="gl-lbl">Consistency</span>${streak}</div>
      <div class="slp-cbody"><div class="slp-cringwrap">${ring}</div>
        <div class="slp-ctext"><b>${head}</b><em>${sub}</em></div></div>
      <div class="slp-cdays">${days}</div>
      <p class="slp-note wrap">A filled dot means you were in bed within 30 minutes of your routine bedtime.</p>
    </div>`;
  }

  // ---------- month (v10.26): calendar, best & worst, sweet spot, trends ----------
  _slpMonthHTML(a) {
    const today = this._slpISO(this._slpNow());
    const hist = ((a && a.history) || []).filter((h) => h.wake_date >= this._slpShift(today, -29))
      .sort((p, q) => (p.wake_date < q.wake_date ? -1 : 1));
    const scored = hist.filter((h) => h.score != null);
    if (!scored.length) {
      return `<div class="gl-tile slp-big"><div class="slp-bicbig">${SLP_ICON_NODATA}</div>
        <p class="slp-lead big">No nights this month yet</p>
        <p class="slp-sub">Your month builds up one report at a time.</p></div>`;
    }
    const mean = (k) => {
      const v = scored.map((h) => h[k]).filter(Number.isFinite);
      return v.length ? v.reduce((t, x) => t + x, 0) / v.length : null;
    };
    const avgScore = mean("score"), avgAsleep = mean("asleep_min");
    const usualBed = this._slpMed(scored.map((h) => this._slpM18(h.in_bed_start)));
    const usualUp = this._slpMed(scored.map((h) => this._slpM18(h.in_bed_end)));
    const kv = (label, val) => `<div class="slp-mkv"><em>${label}</em><b>${val}</b></div>`;
    const summary = `<div class="gl-tile">
        <div class="gl-row"><span class="gl-lbl">Your month</span><span class="slp-note">${scored.length} of 30 nights</span></div>
        <div class="slp-mkvs">
          ${kv("Avg score", `${Math.round(avgScore)}<small> ${this._slpGrade(Math.round(avgScore))}</small>`)}
          ${kv("Avg asleep", this._slpDur(avgAsleep))}
          ${kv("Usual bedtime", usualBed != null ? this._slpM18Clock(usualBed) : "–")}
          ${kv("Usual wake", usualUp != null ? this._slpM18Clock(usualUp) : "–")}
        </div></div>`;
    // calendar by wake-up day, Monday first
    const days = Array.from({ length: 30 }, (_, i) => this._slpShift(today, i - 29));
    const lead = (this._slpDateOf(days[0]).getDay() + 6) % 7;
    const byDate = Object.fromEntries(hist.map((h) => [h.wake_date, h]));
    const openable = new Set(this._slpNights(a).map((n) => n.wake_date));
    const cells = Array.from({ length: lead }, () => `<span class="slp-mcell pad"></span>`).concat(days.map((iso) => {
      const h = byDate[iso], dn = this._slpDateOf(iso).getDate(), cur = iso === today ? " on" : "";
      if (!h || h.score == null) return `<span class="slp-mcell none${cur}"><em>${dn}</em></span>`;
      const g = h.score >= 85 ? 4 : h.score >= 70 ? 3 : h.score >= 55 ? 2 : 1;
      const open = openable.has(iso);
      return `<${open ? "button" : "span"} class="slp-mcell g${g}${cur}"${open ? ` data-slp-date="${iso}"` : ""}><em>${dn}</em><b>${h.score}</b></${open ? "button" : "span"}>`;
    })).join("");
    const cal = `<div class="gl-tile">
        <div class="gl-row"><span class="gl-lbl">Calendar</span><span class="slp-note">by the morning you woke</span></div>
        <div class="slp-mgrid slp-mhead">${["M", "T", "W", "T", "F", "S", "S"].map((d) => `<span>${d}</span>`).join("")}</div>
        <div class="slp-mgrid">${cells}</div>
        <div class="slp-mlegend"><span><i class="g4"></i>Great</span><span><i class="g3"></i>Good</span><span><i class="g2"></i>OK</span><span><i class="g1"></i>Low</span></div>
      </div>`;
    // best & worst
    let bw = "";
    if (scored.length >= 2) {
      const best = scored.reduce((p, q) => (q.score > p.score ? q : p));
      const worst = scored.reduce((p, q) => (q.score < p.score ? q : p));
      const card = (h, label) => {
        const open = openable.has(h.wake_date);
        const night = this._slpDateOf(this._slpShift(h.wake_date, -1)).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
        return `<${open ? "button" : "div"} class="gl-tile slp-bw"${open ? ` data-slp-date="${h.wake_date}"` : ""}>
          <span class="gl-lbl">${label}</span>
          <span class="slp-prevring sm">${this._slpMiniRing(h.score)}<b>${h.score}</b></span>
          <b class="slp-bwd">${night}</b>
          <em>${this._slpDur(h.asleep_min)} asleep</em>
          <em>${this._slpTime(h.in_bed_start)} → ${this._slpTime(h.in_bed_end)}</em>
        </${open ? "button" : "div"}>`;
      };
      bw = `<div class="slp-bwrow">${card(best, "Best night")}${card(worst, "Toughest night")}</div>`;
    }
    // trends across the month
    const trend = (key, name, unit, col, icon, dp) => {
      const vals = days.map((iso) => (byDate[iso] && Number.isFinite(byDate[iso][key]) ? byDate[iso][key] : null));
      const real = vals.filter((v) => v != null);
      if (real.length < 2) return "";
      const fmt = (v) => (dp ? (Math.round(v * 10) / 10).toFixed(1) : String(Math.round(v)));
      const half = Math.floor(real.length / 2);
      const early = real.slice(0, half), late = real.slice(real.length - half);
      const delta = half ? late.reduce((t, v) => t + v, 0) / half - early.reduce((t, v) => t + v, 0) / half : 0;
      const dir = Math.abs(delta) < (dp ? 0.5 : 1.5) ? "steady" : delta > 0 ? `up ${fmt(Math.abs(delta))}` : `down ${fmt(Math.abs(delta))}`;
      return `<div class="gl-tile">
        <div class="gl-row"><span class="slp-vic" style="--c:${col}">${icon}</span>
          <span class="slp-hname">${name}</span>
          <span class="slp-vval big">${fmt(real.reduce((t, v) => t + v, 0) / real.length)}<small>${unit}</small></span></div>
        ${this._slpBandChart(vals, key === "score" ? null : this._slpRange(a, key), col)}
        <div class="gl-row slp-hfoot"><span class="slp-note">month average · ${real.length} nights</span><span class="slp-chip">${dir}</span></div>
      </div>`;
    };
    return summary + cal + bw + this._slpSweetHTML(scored)
      + `<div class="slp-msec">Trends</div>`
      + trend("score", "Sleep score", "", GLOW_PAL.mid.hi, V2_ICON_MOON, false)
      + trend("resting_hr", "Resting heart rate", "bpm", "#ff7f95", GLOW_ICON_HEART, true)
      + trend("hrv_mean", "HRV", "ms", "#b99bff", SLP_ICON_HRV, false);
  }
  // hourly mean bed water temperature (recorder long-term statistics — one call for 31 days)
  _slpWaterEnt() {
    const c = this._config;
    return (this._slpWho() === "partner" ? c.partner_water_temp_entity : c.water_temp_entity) || "";
  }
  _slpStatKey() { return `${this._slpWho()}|${this._slpISO(this._slpNow())}`; }
  _slpEnsureStats() {
    const ent = this._slpWaterEnt();
    if (!ent || !this._hass || !this._hass.callWS) return;
    this._slpStats = this._slpStats || {};
    const key = this._slpStatKey();
    if (key in this._slpStats) return;
    this._slpStats[key] = null;   // in flight
    const end = this._slpNow(), start = new Date(end.getTime() - 31 * 86400000);
    const done = (pts) => {
      this._slpStats[key] = pts;
      this._slpStatSig = `${key}:${pts.length}`;
      this._renderSleep(true);
    };
    this._hass.callWS({
      type: "recorder/statistics_during_period",
      start_time: start.toISOString(), end_time: end.toISOString(),
      statistic_ids: [ent], period: "hour", types: ["mean"],
    }).then((res) => done(((res && res[ent]) || [])
      .map((r) => [Math.round((typeof r.start === "number" ? r.start : Date.parse(r.start)) / 1000), r.mean])
      .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))))
      .catch(() => done([]));
  }
  _slpSweetHTML(scored) {
    if (!this._slpWaterEnt()) return "";
    const pts = (this._slpStats || {})[this._slpStatKey()];
    let body;
    if (!pts) {
      body = `<div class="slp-bandempty">Looking up your bed temperatures…</div>`;
    } else {
      const nights = scored.map((h) => {
        const v = pts.filter((p) => p[0] >= h.in_bed_start - 1800 && p[0] < h.in_bed_end).map((p) => p[1]);
        return v.length ? { h, t: v.reduce((x, y) => x + y, 0) / v.length } : null;
      }).filter(Boolean);
      if (nights.length < 4) {
        body = `<div class="slp-bandempty">Needs 4 nights with a bed temperature · ${nights.length} so far</div>`;
      } else {
        const bins = {};
        nights.forEach((x) => { const k = Math.round(x.t); (bins[k] = bins[k] || []).push(x.h.score); });
        const rows = Object.keys(bins).map(Number).sort((p, q) => p - q)
          .map((k) => ({ k, n: bins[k].length, s: bins[k].reduce((x, y) => x + y, 0) / bins[k].length }));
        const pool = rows.filter((r) => r.n >= 2);
        const best = (pool.length ? pool : rows).reduce((p, q) => (q.s > p.s ? q : p));
        const lo = Math.min(...rows.map((r) => r.s)) - 8, hi = Math.max(...rows.map((r) => r.s));
        const bars = rows.map((r) => `<div class="slp-sbar${r.k === best.k ? " on" : ""}">
          <span class="v">${Math.round(r.s)}</span>
          <span class="slp-sbt"><i style="height:${Math.max(10, (r.s - lo) / ((hi - lo) || 1) * 100).toFixed(0)}%"></i></span>
          <span class="k">${r.k}°</span><span class="n">${r.n}×</span></div>`).join("");
        // only call a sweet spot once there's enough to lean on: 8 nights, and a repeat temperature
        const sure = nights.length >= 8 && pool.length > 0;
        body = `<p class="slp-sweet">${sure
          ? `Your best nights ran at about <b>${best.k}°</b> — average score ${Math.round(best.s)} over ${best.n} nights.`
          : `Still learning — ${nights.length} of 8 nights. So far <b>${best.k}°</b> looks best.`}</p>
          <div class="slp-sbars">${bars}</div>
          <p class="slp-note wrap">Average bed water temperature while you were in bed, rounded to the degree. Score on top, nights underneath.</p>`;
      }
    }
    return `<div class="gl-tile"><div class="gl-row"><span class="gl-lbl">Temperature sweet spot</span></div>${body}</div>`;
  }

  // ---------- health check (opened from Vitals) ----------
  _slpHealthHTML(a) {
    const hist = (a && a.history) || [];
    const tile = (key, name, unit, col, icon, dp) => {
      const vals = hist.map((h) => h[key]);
      const real = vals.filter((v) => Number.isFinite(v));
      const rng = this._slpRange(a, key);
      const last = real.length ? real[real.length - 1] : null;
      const fmt = (v) => (dp ? (Math.round(v * 10) / 10).toFixed(1) : String(Math.round(v)));
      const out = rng && last != null && (last < rng.lo || last > rng.hi);
      const n = a.ranges && a.ranges[key] ? a.ranges[key].n || 0 : 0;
      const chip = !rng
        ? `<span class="slp-chip">Learning · ${n} of 5 nights</span>`
        : out ? `<span class="slp-chip warn">${SLP_ICON_ALERT}Outside your range</span>`
          : `<span class="slp-chip">${SLP_ICON_SHIELD}Normal</span>`;
      return `<div class="gl-tile">
        <div class="gl-row"><span class="slp-vic" style="--c:${col}">${icon}</span>
          <span class="slp-hname">${name}</span>
          <span class="slp-vval big">${last != null ? fmt(last) : "–"}<small>${unit}</small></span></div>
        ${this._slpBandChart(vals, rng, col)}
        <div class="gl-row slp-hfoot"><span class="slp-note">${rng ? `Your normal ${fmt(rng.lo)}–${fmt(rng.hi)} ${unit}` : `${real.length} night${real.length === 1 ? "" : "s"} so far`}</span>${chip}</div>
      </div>`;
    };
    return `<div class="slp-hhd">
        <button class="slp-arrow" data-slp-view="night" aria-label="Back">${GLOW_ICON_CHEVL}</button>
        <div class="slp-dt"><b>Health check</b><em>from Vitals</em></div>
      </div>
      <p class="slp-lead">Your heart and breathing each night, against your own normal range.</p>
      ${tile("resting_hr", "Resting heart rate", "bpm", "#ff7f95", GLOW_ICON_HEART, true)}
      ${tile("hrv_mean", "HRV", "ms", "#b99bff", SLP_ICON_HRV, false)}
      ${tile("br_mean", "Breathing rate", "/min", "#7fd0ff", SLP_ICON_BREATH, true)}
      <p class="slp-foot">Not a medical device. An outlier is a nudge to notice how you feel, not a diagnosis.</p>`;
  }
  _slpBandChart(vals, rng, col) {
    const W = 366, H = 68;
    const real = vals.filter((v) => Number.isFinite(v));
    if (real.length < 2) return `<div class="slp-bandempty">Not enough nights yet</div>`;
    let lo = Math.min(...real), hi = Math.max(...real);
    if (rng) { lo = Math.min(lo, rng.lo); hi = Math.max(hi, rng.hi); }
    const pad = (hi - lo) * 0.2 || 1;
    lo -= pad; hi += pad;
    const x = (i) => 6 + i / ((vals.length - 1) || 1) * (W - 12);
    const y = (v) => H - 4 - (v - lo) / ((hi - lo) || 1) * (H - 8);
    let g = "";
    if (rng) g += `<rect x="0" y="${y(rng.hi).toFixed(1)}" width="${W}" height="${Math.max(2, y(rng.lo) - y(rng.hi)).toFixed(1)}" rx="8" class="slp-bandbox"/>`;
    const pts = vals.map((v, i) => (Number.isFinite(v) ? `${x(i).toFixed(1)},${y(v).toFixed(1)}` : null)).filter(Boolean);
    g += `<polyline points="${pts.join(" ")}" class="slp-bandline"/>`;
    vals.forEach((v, i) => {
      if (!Number.isFinite(v)) return;
      const last = i === vals.length - 1;
      const out = rng && (v < rng.lo || v > rng.hi);
      if (last) g += `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="5" class="slp-banddot last" style="fill:${col}"/>`;
      else if (out) g += `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="9" class="slp-bandring"/><circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="4.5" class="slp-banddot out"/>`;
      else g += `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2" class="slp-banddot"/>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" class="slp-band-chart">${g}</svg>`;
  }

  // ---------- states: pending / no data / away / nothing yet ----------
  _slpStateHTML(state, a, iso) {
    const prev = this._slpNights(a).slice().reverse().find((n) => n.wake_date < iso);
    const prevCard = prev ? `<button class="gl-tile slp-prev" data-slp-date="${prev.wake_date}">
        <span class="slp-prevring">${this._slpMiniRing(prev.score)}<b>${prev.score != null ? prev.score : "–"}</b></span>
        <span class="slp-prevtxt"><span class="gl-lbl">While you wait</span>
          <b>${this._slpDateOf(prev.wake_date).toLocaleDateString("en-GB", { weekday: "long" })} night · ${this._slpDur(prev.asleep_min)} asleep</b></span>
        ${V2_ICON_CHEVR}</button>` : "";
    if (state === "pending") {
      const b = this._slpBedTimes();
      const steps = [["In bed", b.entered ? this._slpTime(b.entered) : "–"], ["Up", b.inBed ? "still in bed" : (b.left ? this._slpTime(b.left) : "–")],
        ["Working it out", "now"], ["Ready", "~9:30 am"]];
      const cur = b.inBed ? 1 : 2;
      return `<div class="gl-tile slp-big">
          <div class="gl-row"><span class="slp-bic on">${V2_ICON_CLOCK}</span><span class="gl-lbl">Report on its way</span></div>
          <p class="slp-lead big">Last night’s report will be ready around 9:30 am.</p>
          <p class="slp-sub">The Pod works out the night once you’re up. Nothing you need to do.</p>
          <div class="slp-steps">${steps.map(([l, s], i) => `<div class="slp-step${i < cur ? " done" : i === cur ? " now" : ""}">
            <i>${i < cur ? GLOW_ICON_CHECK : ""}</i><b>${l}</b><em>${s}</em></div>`).join("")}</div>
        </div>
        ${this._slpMomentsHTML({ events: [b.entered ? { t: b.entered, kind: "in_bed" } : null, b.left && !b.inBed ? { t: b.left, kind: "up", asleep_min: null } : null].filter(Boolean) })}
        ${prevCard}`;
    }
    if (state === "away") {
      return `<div class="gl-tile slp-big">
          <div class="slp-bicbig">${GLOW_ICON_AWAY}</div>
          <p class="slp-lead big">You were away</p>
          <p class="slp-sub">Vacation mode is on, so the Pod stayed off and didn’t track this night.</p>
          <div class="slp-kvrow top"><span>Vacation mode</span><div><b>on</b></div></div>
        </div>${prevCard}`;
    }
    if (state === "empty") {
      return `<div class="gl-tile slp-big">
          <div class="slp-bicbig">${V2_ICON_SLEEP}</div>
          <p class="slp-lead big">No sleep data yet</p>
          <p class="slp-sub">The first report lands the morning after a night in bed.</p>
        </div>`;
    }
    const day = this._slpDateOf(this._slpShift(iso, -1)).toLocaleDateString("en-GB", { weekday: "long" });
    return `<div class="gl-tile slp-big">
        <div class="slp-bicbig">${SLP_ICON_NODATA}</div>
        <p class="slp-lead big">Nothing recorded</p>
        <p class="slp-sub">The Pod didn’t pick up anyone in bed between noon ${day} and noon the next day. If you slept here, it may have been offline.</p>
      </div>
      <div class="gl-tile">
        <div class="gl-row"><span class="gl-lbl">This week</span></div>
        <div class="slp-week">${this._slpWeek(a).map((w) => {
      const d = this._slpDateOf(w.iso).toLocaleDateString("en-GB", { weekday: "short" });
      const on = w.iso === iso;
      const h = w.night && w.night.score != null ? Math.max(8, (w.night.score - 40) / 60 * 100) : 0;
      return `<button class="slp-wcol${on ? " on" : ""}" data-slp-date="${w.iso}">
            <span class="slp-wv${w.night ? "" : " gap"}">${w.night ? w.night.score : "–"}</span>
            <span class="slp-wbar">${w.night ? `<i style="height:${h.toFixed(0)}%"></i>` : `<i class="gap"></i>`}</span>
            <span class="slp-wd">${d}</span></button>`;
    }).join("")}</div>
        <p class="slp-note wrap">Nights without data don’t count toward your averages.</p>
      </div>${prevCard}`;
  }
  _slpMiniRing(score) {
    const r = 22, c = 2 * Math.PI * r, f = Math.max(0, Math.min(100, score || 0)) / 100;
    return `<svg viewBox="0 0 56 56" class="slp-mini"><circle cx="28" cy="28" r="${r}" class="slp-mini-bg"/>
      <circle cx="28" cy="28" r="${r}" class="slp-mini-fg" stroke-dasharray="${(c * f).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 28 28)"/></svg>`;
  }

  // ---------- "How your score adds up" (centred Glow card, above the nav) ----------
  _slpPopHTML(a, n) {
    const detail = {
      efficiency: `${n.efficiency != null ? n.efficiency : "–"}% of your time in bed asleep`,
      duration: `${this._slpDur(n.asleep_min)} asleep`,
      restfulness: `${n.awakenings || 0} wake-up${(n.awakenings || 0) === 1 ? "" : "s"} · estimated`,
      hrv: n.hrv_mean != null ? `${Math.round(n.hrv_mean)} ms` : "no HRV lock",
    };
    const rows = (n.breakdown || []).map(([name, pts, max]) => `<div class="slp-prow">
        <div class="slp-phd"><b>${name.charAt(0).toUpperCase() + name.slice(1)}</b><em>${detail[name] || ""}</em>
          <span>${Math.round(pts)}<small>/${max}</small></span></div>
        <i class="slp-ptrack"><b style="width:${Math.max(0, Math.min(100, pts / (max || 1) * 100)).toFixed(0)}%"></b></i>
      </div>`).join("");
    return `<div class="pkg-hd">
        <span class="slp-prevring sm">${this._slpMiniRing(n.score)}<b>${n.score != null ? n.score : "–"}</b></span>
        <div class="pkg-ht"><div class="pkg-title">How your score adds up</div>
          <div class="slp-note">Four parts, weighted</div></div>
        <button class="slp-arrow" data-slp-pop="close" aria-label="Close">${SLP_ICON_X}</button>
      </div>
      <div class="slp-prows">${rows}</div>
      <p class="slp-note wrap">Restful stays an estimate until the Pod can sense movement.</p>
      <div class="pk-actions"><button class="pk-btn pkg-go" data-slp-pop="close">${GLOW_ICON_CHECK}Done</button></div>`;
  }
  _slpOpenPop(kind) {
    const a = this._slpAttrs();
    const n = a && this._slpNight(a, this._slpDate || this._slpISO(this._slpNow()));
    const ov = this.shadowRoot.getElementById("slpPop");
    if (!ov || !n || kind !== "breakdown") return;
    const sheet = ov.querySelector(".pk-sheet");
    if (sheet) sheet.innerHTML = this._slpPopHTML(a, n);
    ov.classList.add("open");
    this._haptic("light");
  }
  _slpClosePop() {
    const ov = this.shadowRoot.getElementById("slpPop");
    if (ov) ov.classList.remove("open");
  }

  /* ===================================================================================
     Sleep Coach (v10.29) — the tab that answers "what should I do tonight", where the
     Sleep tab answers "how was last night". design/coach + design/coach/PLAN.md.

     Everything it shows comes from three places, all cheap:
       * coach helpers under one prefix (input_datetime/number/boolean/select), created in HA —
         the targets you set and the switches that arm each nudge and wake step;
       * sensor.<pre>_coach_status — a template sensor for TONIGHT (on_track / drifting /
         behind / asleep / waking / away / off) with the computed target on its attributes;
       * the `coach` block on the Sleep tab's own sensor.<side>_sleep_score attributes
         (debt, on-time count, streak, per-night onset/wake) — published by gateway/sleep-pipeline.
     No recorder history, no extra polling. If the helpers aren't there the tab hides itself.

     Colour: the coach's own green / amber / red (DESIGN-LANGUAGE.md's semantic set) — "did I
     hit my target" is not a bed-temperature signal, so it deliberately does NOT follow
     GLOW_PAL. Everything else (tiles, labels, numerals, sheets) is Glow. 12-hour time.
     =================================================================================== */
  _cchPre() { return this._config.coach_prefix || this._config.schedule_prefix || "eight_sleep_me"; }
  // every coach helper is <domain>.<prefix>_<key> — one convention, no per-entity config
  _cchE(key) {
    const pre = this._cchPre();
    const D = {
      coach: "input_boolean", pull_earlier: "input_boolean", coach_off_tonight: "input_boolean",
      wake_ack: "input_boolean", wake_heat: "input_boolean", wake_vibrate: "input_boolean",
      wake_phone: "input_boolean", wake_cold: "input_boolean", wake_sound: "input_boolean",
      nudge_winddown: "input_boolean", nudge_pre: "input_boolean", nudge_late: "input_boolean",
      nudge_loud: "input_boolean",
      target_bedtime: "input_datetime", target_bedtime_weekend: "input_datetime",
      target_wake: "input_datetime", target_wake_weekend: "input_datetime",
      coach_tonight_target: "input_datetime",
      sleep_need: "input_number", winddown_lead: "input_number", green_window: "input_number",
      wake_strength: "input_select", coach_status: "sensor",
    };
    return `${D[key] || "sensor"}.${pre}_${key}`;
  }
  _cchSt(key) { const e = this._hass && this._hass.states[this._cchE(key)]; return e || null; }
  _cchBool(key) { const e = this._cchSt(key); return !!e && e.state === "on"; }
  _cchNum(key, def) { const e = this._cchSt(key); const v = e ? parseFloat(e.state) : NaN; return Number.isFinite(v) ? v : def; }
  _cchMins(key) { const e = this._cchSt(key); const hm = e ? this._fmtHM(e.state) : null; return hm ? hm.mins : null; }
  // The tab exists only when the coach's master switch does (and only on v2, like Sleep).
  // Sticky: the first `set hass` can arrive before the helper has streamed in (it does on the
  // kiosk, whose proxy answers get_states a beat later), and the tab bar is built once — so
  // once it's true it stays true, and _build() is re-run the one time it flips.
  _coachTabOn() {
    if (this._layout !== "v2" || this._config.coach === false) return false;
    if (this._cchSeen) return true;
    if (this._hass && this._hass.states[this._cchE("coach")]) { this._cchSeen = true; return true; }
    return false;
  }
  // Fri/Sat nights use the weekend pair — "tonight", so Friday evening is already weekend
  _cchWeekend() { const d = this._cchNow().getDay(); return d === 5 || d === 6; }
  // _cchNowOverride ("2026-09-16T21:03:00") pins "now" for the dev harness, like _slpNowOverride
  _cchNow() { return this._cchNowOverride ? new Date(this._cchNowOverride) : new Date(); }
  _cchNowMins() { const d = this._cchNow(); return d.getHours() * 60 + d.getMinutes(); }
  _cchTargets() {
    const wknd = this._cchWeekend();
    const bed = this._cchMins(wknd ? "target_bedtime_weekend" : "target_bedtime");
    const wake = this._cchMins(wknd ? "target_wake_weekend" : "target_wake");
    return {
      weekend: wknd,
      bed: bed == null ? 22 * 60 + 30 : bed,
      wake: wake == null ? 6 * 60 + 30 : wake,
      need: Math.round(this._cchNum("sleep_need", 8) * 60),
      lead: Math.round(this._cchNum("winddown_lead", 45)),
      window: Math.round(this._cchNum("green_window", 15)),
    };
  }
  // tonight's actual target: the helper the evening automation writes (debt-adjusted), falling
  // back to the plain target so the tab reads right before that automation has ever run
  _cchTonight() {
    const t = this._cchTargets();
    const st = this._cchSt("coach_status");
    const a = (st && st.attributes) || {};
    const fromAttr = typeof a.target === "string" ? this._fmtHM(a.target) : null;
    const target = this._cchMins("coach_tonight_target") ?? (fromAttr ? fromAttr.mins : t.bed);
    return Object.assign(t, { target, winddown: (target - t.lead + 1440) % 1440, pulled: Math.max(0, t.bed - target) });
  }
  // the one word the whole tab is coloured by. The template sensor owns it; without it we
  // still say something useful from the bed's own presence.
  _cchStatus() {
    const st = this._cchSt("coach_status");
    const s = st ? String(st.state) : "";
    if (["off", "away", "asleep", "waking", "on_track", "drifting", "behind"].includes(s)) return s;
    if (!this._cchBool("coach")) return "off";
    if (this._slpAway()) return "away";
    if (this._cchInBed()) return "asleep";
    const now = this._cchNowMins(), T = this._cchTonight();
    const late = (now - T.target + 1440) % 1440;
    if (now >= T.winddown || now < 240) return late < 1080 && now >= T.target ? "behind" : "drifting";
    return "on_track";
  }
  _cchInBed() {
    const id = this._config.in_bed_entity;
    const e = id && this._hass.states[id];
    if (e) return e.state === "on";
    const b = this._slpBedTimes();
    return !!(b && b.inBed);
  }
  _cchTone(status) {
    return status === "behind" ? "bad" : status === "drifting" ? "amb" : status === "off" || status === "away" ? "off" : "ok";
  }
  _cchWord(status) {
    return { on_track: "On track", drifting: "Cutting it close", behind: "Behind", asleep: "In bed", waking: "Waking you", away: "Away", off: "Coach off" }[status] || "–";
  }
  // The nightly numbers. The pipeline already publishes everything they need on the sleep-score
  // sensor (history[] carries in_bed_start / in_bed_end / asleep_min for 30 nights), so the
  // coach derives debt, on-time count, streak and medians HERE rather than asking gateway/sleep-
  // pipeline to learn about targets it can't see — the targets are HA helpers, and only the card
  // reads those. A published `coach` block wins if one ever appears, so the split can move later.
  _cchAttrs() {
    const a = this._slpAttrs();
    if (!a) return null;
    if (a.coach) return a.coach;
    const sig = `${this._slpWho()}|${a.wake_date}|${(a.history || []).length}|${JSON.stringify(this._cchTargets())}`;
    if (this._cchDerived && this._cchDerivedSig === sig) return this._cchDerived;
    this._cchDerivedSig = sig;
    this._cchDerived = this._cchDerive(a);
    return this._cchDerived;
  }
  // minutes past midnight, normalised so an after-midnight bedtime reads LATER than 11 pm
  // (00:20 -> 1460) instead of earlier than everything — the bug that would paint every
  // late night green.
  _cchNorm(m) { return m == null ? null : (m < 12 * 60 ? m + 1440 : m); }
  _cchMinsOf(epoch) { const d = new Date(epoch * 1000); return d.getHours() * 60 + d.getMinutes(); }
  // which bedtime target a given wake date was aiming at: a Sat or Sun morning followed a
  // Fri/Sat night, so it's judged against the weekend target
  _cchTargetFor(iso, T) {
    const wd = this._slpDateOf(iso).getDay();
    return wd === 6 || wd === 0 ? (this._cchMins("target_bedtime_weekend") ?? T.bed) : (this._cchMins("target_bedtime") ?? T.bed);
  }
  _cchDerive(a) {
    const T = this._cchTargets();
    const rows = (Array.isArray(a.history) ? a.history : [])
      .filter((h) => h && h.wake_date && h.in_bed_start && h.in_bed_end);
    const mk = (h) => {
      const onset = this._cchMinsOf(h.in_bed_start), wake = this._cchMinsOf(h.in_bed_end);
      const tgt = this._cchTargetFor(h.wake_date, T);
      return { date: h.wake_date, onset, wake, asleep_min: h.asleep_min == null ? null : Math.round(h.asleep_min),
               status: this._cchNightTone(onset, tgt, T.window) };
    };
    const nights = rows.slice(-14).map(mk);
    // debt: each night's shortfall against the need, a long night giving back at most an hour
    const owed = (n) => (n.asleep_min == null ? 0 : Math.max(T.need - n.asleep_min, -60));
    const sum = (xs) => Math.max(0, Math.round(xs.reduce((t, n) => t + owed(n), 0)));
    const debt = sum(nights);
    const prevRows = rows.slice(-21, -7).map(mk);
    const last7 = nights.slice(-7);
    const onTime = last7.filter((n) => n.status === "ok").length;
    let streak = 0, best = 0, run = 0;
    for (let i = nights.length - 1; i >= 0 && nights[i].status === "ok"; i--) streak++;
    nights.forEach((n) => { run = n.status === "ok" ? run + 1 : 0; best = Math.max(best, run); });
    const med = (xs) => {
      const v = xs.filter((x) => x != null).map((x) => this._cchNorm(x)).sort((p, q) => p - q);
      if (!v.length) return null;
      const m = Math.round(v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) % 1440;
      return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    };
    return {
      nights, debt_min: debt, debt_nights: nights.length || 14,
      debt_prev_min: prevRows.length ? sum(prevRows) : null,
      on_time_7: last7.length ? onTime : null, streak, best_streak: best,
      median_onset: med(nights.map((n) => n.onset)), median_wake: med(nights.map((n) => n.wake)),
      derived: true,
    };
  }
  _cchNights() { const c = this._cchAttrs(); return c && Array.isArray(c.nights) ? c.nights : []; }
  // one night's colour, against the target it was actually aiming at
  _cchNightTone(onset, target, window) {
    if (onset == null) return "off";
    const late = this._cchNorm(onset) - this._cchNorm(target);
    return late <= window ? "ok" : late <= window + 30 ? "amb" : "bad";
  }
  _cchDur(min) {
    if (min == null) return "–";
    const m = Math.max(0, Math.round(min));
    return `${Math.floor(m / 60)}<small>h</small> ${String(m % 60).padStart(2, "0")}<small>m</small>`;
  }
  _cchClock(mins) {
    const hm = this._fmtHM(`${String(Math.floor(((mins % 1440) + 1440) % 1440 / 60)).padStart(2, "0")}:${String(((mins % 60) + 60) % 60).padStart(2, "0")}`);
    return hm ? `${hm.t}<small class="cch-ap">${hm.ap}</small>` : "–";
  }
  _cchClockPlain(mins) { return this._pkFmtMins(mins); }
  // "40 min" up close, "5h 50m" when it's hours away — a three-digit minute count reads as noise
  _cchAway(min) {
    const m = Math.max(0, Math.round(min));
    return m < 90 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
  }

  _coachHTMLv2() { return `<div class="cch" id="cchRoot"></div>`; }

  _renderCoach(force) {
    const root = this.shadowRoot.getElementById("cchRoot");
    if (!root || !this._hass) return;
    const view = this._cchView || "tonight";
    const status = this._cchStatus();
    const st = this._cchSt("coach_status");
    const a = this._slpAttrs();
    const sig = [view, status, st && st.last_updated, this._cchInBed(), this._cchWeekend(),
      JSON.stringify(this._cchTonight()), a && a.wake_date, this._cchBool("coach_off_tonight"),
      this._cchStrength(), Math.floor(this._cchNowMins() / 5)].join("|");
    if (!force && root.childElementCount && this._cchSig === sig) return;
    this._cchSig = sig;
    let body;
    if (!this._cchBool("coach")) body = this._cchOffHTML();
    else if (view === "nights") body = this._cchNightsHTML();
    else if (view === "wake") body = this._cchWakeHTML();
    else body = this._cchTonightHTML(status);
    root.innerHTML = this._cchTopHTML(view, status) + body;
  }
  _cchStrength() { const e = this._cchSt("wake_strength"); return e ? String(e.state) : "Firm"; }

  _cchTopHTML(view, status) {
    const seg = [["tonight", "Tonight"], ["nights", "Nights"], ["wake", "Wake-up"]]
      .map(([k, l]) => `<button class="slp-opt${view === k ? " on" : ""}" data-cch-view="${k}">${l}</button>`).join("");
    const on = this._cchBool("coach");
    return `<div class="cch-top">
        <div class="slp-seg">${seg}</div>
        <span class="cch-pill ${this._cchTone(status)}">${status === "on_track" ? GLOW_ICON_CHECK : CCH_ICON_BELL}${this._cchWord(status)}</span>
        <button class="slp-arrow" data-cch-pop="targets" aria-label="Coach targets">${V2_ICON_GEAR}</button>
      </div>
      ${on ? "" : `<div class="cch-note">The coach is switched off — nothing is sent and the wake-up stays as it was.</div>`}`;
  }

  // ---------------------------------------------------------------- Tonight
  _cchTonightHTML(status) {
    const T = this._cchTonight();
    const c = this._cchAttrs() || {};
    const tone = this._cchTone(status);
    const now = this._cchNowMins();
    const toWind = (T.winddown - now + 1440) % 1440;
    const toBed = (T.target - now + 1440) % 1440;
    const late = (now - T.target + 1440) % 1440;
    const onTime = Number.isFinite(c.on_time_7) ? c.on_time_7 : null;
    const sub = status === "asleep" ? "You're in bed — nothing more from me tonight."
      : status === "waking" ? "Wake-up in progress."
      : status === "behind" ? `${late} min past your target · your wake time doesn't move`
      : toWind < 1080 && toWind > 0 ? `Wind-down ${this._cchClockPlain(T.winddown)} · in ${this._cchAway(toWind)}`
      : toBed < 1080 ? `${this._cchAway(toBed)} to go` : `Wind-down ${this._cchClockPlain(T.winddown)}`;
    const banner = status === "behind" ? `<div class="gl-tile cch-banner bad">
        <span class="cch-bic bad">${CCH_ICON_BELL}</span>
        <div class="cch-bt"><b>It's ${this._cchClockPlain(now)} and you're still up</b>
          <em>${late} min past your target${onTime != null && onTime <= 3 ? " · third night this week" : ""}</em></div>
      </div>` : "";
    const ring = onTime != null ? `<span class="cch-ring">${this._cchRing(onTime / 7, tone)}
        <b>${onTime}<small>/7</small></b><em>on time</em></span>` : "";
    return `${banner}
      <div class="gl-tile cch-hero ${tone}">
        <div class="cch-hrow">
          ${ring}
          <div class="cch-hmain">
            <span class="gl-lbl">${status === "behind" ? "You said lights out by" : "Lights out by"}</span>
            <div class="cch-big">${this._cchClock(T.target)}</div>
            <span class="cch-sub">${escapeHtml(sub)}</span>
          </div>
        </div>
        ${this._cchTimelineHTML(T, now)}
        ${this._cchDotsHTML(T)}
      </div>
      ${this._cchDebtHTML(c, T)}
      ${this._cchPlanHTML(T)}
      ${this._cchNudgeHTML()}
      ${this._cchOffTonightHTML()}`;
  }

  _cchRing(frac, tone, size = 84) {
    const sw = 9, r = size / 2 - sw / 2, circ = 2 * Math.PI * r;
    const f = Math.max(0, Math.min(1, frac || 0));
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" class="cch-ringsvg ${tone}">
        <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="rgba(255,255,255,0.09)" stroke-width="${sw}"/>
        <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="currentColor" stroke-width="${sw}"
          stroke-linecap="round" stroke-dasharray="${(circ * f).toFixed(1)} ${circ.toFixed(1)}"
          transform="rotate(-90 ${size / 2} ${size / 2})"/>
      </svg>`;
  }

  // now → wind-down → in bed → up, as one line. Positions are real: the 4 marks sit where
  // they fall between now and the wake target, so the gap you're about to lose is visible.
  _cchTimelineHTML(T, now) {
    const span = ((T.wake - now + 1440) % 1440) || 1;
    const raw = [now, T.winddown, T.target, T.wake]
      .map((m) => Math.max(4, Math.min(96, ((m - now + 1440) % 1440) / span * 100)));
    // push the marks apart so two clock labels can never sit on top of each other, then pull
    // the tail back inside the line — true order and rough spacing, always readable
    const GAP = 21;
    for (let i = 1; i < raw.length; i++) raw[i] = Math.max(raw[i], raw[i - 1] + GAP);
    const over = raw[raw.length - 1] - 96;
    if (over > 0) for (let i = raw.length - 2; i >= 0; i--) raw[i] = Math.min(raw[i], raw[i + 1] - GAP);
    raw[raw.length - 1] = Math.min(raw[raw.length - 1], 96);
    const labels = [["now", now], ["wind-down", T.winddown], ["in bed", T.target], ["up", T.wake]];
    const ticks = labels.map(([l, m], i) => `<span class="cch-tk${i === 0 ? " nowtk" : ""}" style="left:${raw[i].toFixed(1)}%">
        <i></i><b>${this._cchClockPlain(m)}</b><em>${escapeHtml(l)}</em></span>`).join("");
    return `<div class="cch-tl"><span class="cch-tlline"></span>
        <span class="cch-tlfill" style="left:${raw[0].toFixed(1)}%;width:${(raw[2] - raw[0]).toFixed(1)}%"></span>${ticks}</div>`;
  }

  _cchDotsHTML(T) {
    const nights = this._cchNights().slice(-7);
    if (!nights.length) return "";
    const dots = nights.map((n) => {
      const tone = n.status || this._cchNightTone(n.onset, T.bed, T.window);
      const d = n.date ? this._slpDay(n.date) : "";
      return `<span class="cch-dot ${tone}" title="${escapeHtml(d)}"></span>`;
    }).join("");
    return `<div class="cch-dots"><span class="cch-dl">Last ${nights.length} night${nights.length === 1 ? "" : "s"}</span>
        <span class="cch-drow">${dots}</span></div>`;
  }

  _cchDebtHTML(c, T) {
    if (!Number.isFinite(c.debt_min)) {
      return `<div class="gl-tile"><span class="gl-lbl">${CCH_ICON_ZZZ}Sleep debt</span>
        <div class="cch-note">Nothing scored yet — the debt shows up after the pipeline's first morning run.</div></div>`;
    }
    const debt = Math.max(0, Math.round(c.debt_min));
    const nights = Number.isFinite(c.debt_nights) ? c.debt_nights : 14;
    const tone = debt >= 240 ? "bad" : debt >= 60 ? "amb" : "ok";
    const frac = Math.min(1, debt / 420);
    const perNight = nights ? Math.round(debt / nights) : 0;
    // v10.35: a clean slate used to read as "0h 00m" over an empty bar captioned "Level"
    if (debt < 5 && !(T.pulled > 0)) {
      return `<div class="gl-tile"><div class="cch-lrow">
        <span class="gl-lbl">${CCH_ICON_ZZZ}Sleep debt</span><span class="cch-sub">${nights} nights</span></div>
      <div class="cch-drowv"><span class="cch-num ok">None</span>
        <span class="cch-sub">even over ${nights} nights — nothing to pay back</span></div></div>`;
    }
    return `<div class="gl-tile"><div class="cch-lrow">
        <span class="gl-lbl">${CCH_ICON_ZZZ}Sleep debt</span><span class="cch-sub">${nights} nights</span></div>
      <div class="cch-drowv"><span class="cch-num ${tone}">${this._cchDur(debt)}</span>
        <span class="cch-sub">owed against ${this._cchDur(T.need)} a night</span></div>
      <div class="cch-bar"><b class="${tone}" style="width:${(frac * 100).toFixed(0)}%"></b></div>
      <div class="cch-lrow" style="margin-top:10px">
        ${T.pulled > 0
          ? `<span class="cch-chip amb">${CCH_ICON_ARROW}Target pulled ${T.pulled} min earlier</span><span class="cch-sub">→ ${this._cchClockPlain(T.target)} tonight</span>`
          : `<span class="cch-sub">${perNight ? `About ${perNight} min a night to pay back` : "Under a minute a night to pay back"}</span>`}
      </div></div>`;
  }

  // the automation, written out. Nothing the coach does is hidden behind a toggle you can't read.
  _cchPlanHTML(T) {
    const wake = T.wake, strength = this._cchStrength();
    const rows = [
      ["moon", "mid", T.winddown, "Wind-down", this._config.winddown_script ? "Lamps down, bed starts cooling" : "Bed starts cooling"],
      ["bell", "mid", (T.target - 15 + 1440) % 1440, "First nudge", "Only if you're not in bed"],
      ["bed", "ok", T.target, "In-bed check", "Presence decides — no nudge if you're already down"],
      ["flame", "warm", (wake - 20 + 1440) % 1440, "Warm-up", "Bed warms, sunrise lamp starts"],
      ["sun", "warm", wake, "Wake", strength === "Off" ? "Alarm only" : `${strength} — ${this._cchWakeChain()}`],
    ].filter(([, , , t]) => !(t === "Wind-down" && !this._cchBool("nudge_winddown")));
    const body = rows.map(([ic, tone, mins, title, sub], i) => `<div class="cch-prow">
        <span class="cch-ic ${tone}">${CCH_ICONS[ic]}</span>
        <div class="cch-pt"><b>${escapeHtml(title)}</b><em>${escapeHtml(sub)}</em></div>
        <span class="cch-ptime">${this._cchClockPlain(mins)}</span>
      </div>${i < rows.length - 1 ? `<i class="cch-hair"></i>` : ""}`).join("");
    return `<div class="gl-tile"><span class="gl-lbl">${CCH_ICONS.clock}Tonight's plan</span>
      <div class="cch-prows">${body}</div></div>`;
  }
  _cchWakeChain() {
    const parts = [];
    if (this._cchBool("wake_heat")) parts.push("heat");
    if (this._cchBool("wake_vibrate")) parts.push("vibration");
    if (this._wakeLightOn()) parts.push("light");
    if (this._cchBool("wake_phone")) parts.push("phone");
    if (this._cchBool("wake_cold")) parts.push("cold snap");
    if (this._cchBool("wake_sound")) parts.push("sound");
    return parts.length ? parts.join(", ") : "nothing armed";
  }

  _cchNudgeHTML() {
    const rows = [
      ["nudge_winddown", "moon", "mid", "Wind-down", "45 min before your target"],
      ["nudge_pre", "clock", "mid", "15 minutes to go", "Silent if you're already in bed"],
      ["nudge_late", "bed", "amb", "You're not in bed", "At your target, then every 30 min"],
      ["nudge_loud", "lock", "bad", "Break through silent", "Last nudge only, as a time-sensitive alert"],
    ].filter(([k]) => !!this._cchSt(k));
    if (!rows.length) return "";
    const body = rows.map(([k, ic, tone, title, sub], i) => `<button class="cch-prow tap" data-cch-toggle="${k}">
        <span class="cch-ic ${tone}">${CCH_ICONS[ic]}</span>
        <div class="cch-pt"><b>${escapeHtml(title)}</b><em>${escapeHtml(sub)}</em></div>
        ${this._cchSwitch(this._cchBool(k))}
      </button>${i < rows.length - 1 ? `<i class="cch-hair"></i>` : ""}`).join("");
    return `<div class="gl-tile"><span class="gl-lbl">${CCH_ICON_BELL}What gets sent</span>
      <div class="cch-prows">${body}</div>
      <div class="cch-note">Three messages, then it stops. Every one is cancelled the moment the bed says you're in it.</div></div>`;
  }
  _cchSwitch(on) { return `<span class="cch-tg${on ? " on" : ""}"><i></i></span>`; }

  _cchOffTonightHTML() {
    if (!this._cchSt("coach_off_tonight")) return "";
    const off = this._cchBool("coach_off_tonight");
    return `<button class="gl-tile cch-prow tap${off ? " lit" : ""}" data-cch-toggle="coach_off_tonight">
        <span class="cch-ic ${off ? "amb" : "off"}">${CCH_ICONS.shield}</span>
        <div class="cch-pt"><b>${off ? "Off for tonight" : "Let me off tonight"}</b>
          <em>${off ? "No nudges, no wake escalation. Back on tomorrow." : "One night, no nudges, no escalation. Still counted."}</em></div>
        ${this._cchSwitch(off)}
      </button>`;
  }

  // ---------------------------------------------------------------- Nights
  _cchNightsHTML() {
    const c = this._cchAttrs() || {};
    const T = this._cchTargets();
    const nights = this._cchNights();
    if (!nights.length) {
      return `<div class="gl-tile"><span class="gl-lbl">Your nights</span>
        <div class="cch-note">Nothing to plot yet. Each morning's run adds a night — this fills in as the pipeline scores them.</div></div>`;
    }
    return `${this._cchLanesHTML(nights, T)}
      <div class="cch-kvs">
        ${this._cchKv("Median asleep", c.median_onset ? this._cchClockPlain(this._fmtHM(c.median_onset).mins) : "–",
          c.median_onset ? this._cchLateTxt(this._fmtHM(c.median_onset).mins - T.bed, "after target") : "", c.median_onset ? this._cchNightTone(this._fmtHM(c.median_onset).mins, T.bed, T.window) : "off")}
        ${this._cchKv("Median up", c.median_wake ? this._cchClockPlain(this._fmtHM(c.median_wake).mins) : "–",
          c.median_wake ? this._cchLateTxt(this._fmtHM(c.median_wake).mins - T.wake, "after target") : "", "off")}
      </div>
      <div class="cch-kvs">
        ${this._cchKv("On-time nights", `${c.on_time_7 != null ? c.on_time_7 : "–"} / 7`, c.streak != null ? (c.best_streak != null ? `streak ${c.streak} · best ${c.best_streak}` : `streak ${c.streak}`) : "", (c.on_time_7 || 0) >= 5 ? "ok" : (c.on_time_7 || 0) >= 3 ? "amb" : "bad")}
        ${this._cchKv("Debt", Number.isFinite(c.debt_min) ? (c.debt_min < 5 ? "None" : this._cchDur(c.debt_min)) : "–", c.debt_prev_min != null ? (c.debt_prev_min < 5 ? "none before either" : `was ${this._cchDur(c.debt_prev_min)}`) : "", Number.isFinite(c.debt_min) && c.debt_min >= 240 ? "bad" : Number.isFinite(c.debt_min) && c.debt_min >= 60 ? "amb" : "ok")}
      </div>
      ${this._cchReadHTML(nights, T)}`;
  }
  _cchLateTxt(delta, tail) {
    const d = Math.round(delta);
    if (Math.abs(d) <= 2) return "on target";
    return `${Math.abs(d)} min ${d > 0 ? tail : "before target"}`;
  }
  _cchKv(k, v, sub, tone) {
    return `<div class="gl-tile cch-kv"><span class="cch-sub">${escapeHtml(k)}</span>
      <div class="cch-kvv ${tone || ""}">${v}</div><div class="cch-sub sm">${sub || ""}</div></div>`;
  }
  // one row per night, asleep → up, against the two target lines. The argument the coach makes.
  _cchLanesHTML(nights, T) {
    const AX0 = 20 * 60, AX1 = 34 * 60;                 // 8 pm → 10 am
    const x = (m) => Math.max(0, Math.min(100, (m - AX0) / (AX1 - AX0) * 100));
    const norm = (m) => this._cchNorm(m);   // after midnight reads later, not earlier
    const rows = nights.slice(-14).map((n) => {
      if (n.onset == null || n.wake == null) {
        return `<div class="cch-lane"><span class="cch-ll">${escapeHtml(n.date ? this._slpDay(n.date) : "")}</span>
          <span class="cch-lt"><i class="cch-gap"></i></span></div>`;
      }
      const a = x(norm(n.onset)), b = x(norm(n.wake));
      const tone = n.status || this._cchNightTone(n.onset, T.bed, T.window);
      return `<div class="cch-lane"><span class="cch-ll">${escapeHtml(n.date ? this._slpDay(n.date) : "")}</span>
        <span class="cch-lt"><i class="cch-lb ${tone}" style="left:${a.toFixed(1)}%;width:${Math.max(1.5, b - a).toFixed(1)}%"></i></span></div>`;
    }).join("");
    const ax = [[20 * 60, "8pm"], [23 * 60, "11pm"], [26 * 60, "2am"], [29 * 60, "5am"], [32 * 60, "8am"]]
      .map(([m, l]) => `<span style="left:${x(m).toFixed(1)}%">${l}</span>`).join("");
    return `<div class="gl-tile"><span class="gl-lbl">Your nights against your targets</span>
      <div class="cch-lanes">
        <span class="cch-ltrack">
          <span class="cch-vline ok" style="left:${x(norm(T.bed)).toFixed(1)}%"></span>
          <span class="cch-vline warm" style="left:${x(norm(T.wake)).toFixed(1)}%"></span>
        </span>
        ${rows}
        <div class="cch-axis">${ax}</div>
      </div>
      <div class="cch-legend"><span><i class="ok"></i>bedtime target ${this._cchClockPlain(T.bed)}</span>
        <span><i class="warm"></i>wake target ${this._cchClockPlain(T.wake)}</span></div></div>`;
  }
  // the one sentence worth reading: does going late actually buy a lie-in?
  _cchReadHTML(nights, T) {
    const done = nights.filter((n) => n.onset != null && n.wake != null);
    if (done.length < 6) return "";
    const sorted = [...done].sort((a, b) => a.onset - b.onset);
    const early = sorted.slice(0, Math.floor(sorted.length / 2));
    const late = sorted.slice(-Math.floor(sorted.length / 2));
    const mean = (xs, f) => xs.reduce((s, n) => s + f(n), 0) / (xs.length || 1);
    const norm = (m) => this._cchNorm(m);
    const wakeShift = Math.round(mean(late, (n) => norm(n.wake)) - mean(early, (n) => norm(n.wake)));
    const sleepLost = Math.round(mean(early, (n) => n.asleep_min || 0) - mean(late, (n) => n.asleep_min || 0));
    if (sleepLost <= 5) return "";
    return `<div class="gl-tile cch-read"><span class="gl-lbl">${CCH_ICONS.trend}What the nights say</span>
      <p>Late nights don't buy you a lie-in. On your later half you still woke within
        <b>${Math.abs(wakeShift)} minutes</b> of your usual time — you just slept
        <b class="amb">${sleepLost} minutes less</b>.</p>
      <div class="cch-note">Getting to bed is the lever; waking is already steady.</div></div>`;
  }

  // ---------------------------------------------------------------- Wake-up
  _cchWakeHTML() {
    const T = this._cchTonight();
    const strength = this._cchStrength();
    const opts = ["Off", "Gentle", "Firm", "Relentless"]
      .map((o) => `<button class="slp-opt${o === strength ? " on" : ""}" data-cch-strength="${o}">${o}</button>`).join("");
    const ack = this._cchBool("wake_ack");
    const waking = this._cchStatus() === "waking";
    const steps = [
      ["wake_heat", "flame", "warm", "Warm the bed", `From ${this._cchClockPlain((T.wake - 20 + 1440) % 1440)} · bed warms toward your wake temperature`, null],
      ["wake_vibrate", "wave", "mid", "Vibrate the bed", `At ${this._cchClockPlain(T.wake)} · 30 s on your side, again each round you're still in bed`, null],
      [null, "sun", "warm", "Sunrise lamp", this._wakeLightOn() ? `From ${this._cchClockPlain((T.wake - 15 + 1440) % 1440)} · ${escapeHtml(this._wakeLightName() || "bedside lamp")}` : "Off — switch it on from Schedule", null],
      ["wake_phone", "phone", "cool", "Phone alert", `At ${this._cchClockPlain(T.wake)} · time-sensitive`, null],
      ["wake_cold", "snow", "cool", "Cold snap", `${this._cchClockPlain((T.wake + 10) % 1440)} if you're still in bed`, null],
      ["wake_sound", "cc", "off", "Sound", `${this._cchClockPlain((T.wake + 15) % 1440)} · bedroom speaker`, null],
    ].filter(([k, , , , , ]) => k === null || !!this._cchSt(k));
    const body = steps.map(([k, ic, tone, title, sub, warn], i) => `<${k ? `button class="cch-prow tap" data-cch-toggle="${k}"` : `div class="cch-prow"`}>
        <span class="cch-ic ${tone}">${CCH_ICONS[ic]}</span>
        <div class="cch-pt"><b>${escapeHtml(title)}</b><em>${sub}</em>${warn ? `<em class="amb">${escapeHtml(warn)}</em>` : ""}</div>
        ${k ? this._cchSwitch(this._cchBool(k)) : ""}
      </${k ? "button" : "div"}>${i < steps.length - 1 ? `<i class="cch-hair"></i>` : ""}`).join("");
    const live = waking ? `<div class="gl-tile cch-hero warm">
        <span class="gl-lbl">Wake-up in progress</span>
        <div class="cch-big xl">${this._cchClock(this._cchNowMins())}</div>
        <span class="cch-sub">${Math.max(0, this._cchNowMins() - T.wake)} min past your wake time${this._cchInBed() ? " · still in bed" : ""}</span>
        <button class="pk-btn pkg-go cch-imup" data-cch-imup="1">${GLOW_ICON_CHECK}I'm up</button>
      </div>` : "";
    return `${live}
      <div class="gl-tile"><div class="cch-lrow"><span class="gl-lbl">${CCH_ICONS.sun}Up at</span>
          <button class="cch-tbtn" data-cch-time="${T.weekend ? "target_wake_weekend" : "target_wake"}">${this._cchClock(T.wake)}${V2_ICON_CHEVR}</button></div>
        <div class="slp-seg wide">${opts}</div>
        <div class="cch-note">${escapeHtml(this._cchStrengthNote(strength))}</div></div>
      <div class="gl-tile"><span class="gl-lbl">${CCH_ICONS.clock}The sequence</span>
        <div class="cch-prows">${body}</div></div>
      <div class="gl-tile"><span class="gl-lbl">${GLOW_ICON_CHECK}Proof you're up</span>
        <div class="cch-note">It ends when the bed has been empty for three minutes, or you tap
          <b>I'm up</b> — on the alert, the Live Activity, or the Control Centre button. Lying still
          with your eyes shut is not proof. That's the point.</div>
        ${ack ? `<span class="cch-chip ok" style="margin-top:10px">${GLOW_ICON_CHECK}You're marked up for today</span>` : ""}</div>
      <div class="gl-tile"><span class="gl-lbl">${CCH_ICONS.shield}Guard rails</span>
        <div class="cch-note">Away nights switch the whole coach off. In Dual mode nothing touches
          ${escapeHtml(this._config.partner_name || "your partner")}'s half. Escalation gives up after 25 minutes and logs a slept-in morning.</div></div>`;
  }
  _cchStrengthNote(s) {
    if (s === "Off") return "Nothing fires at your wake time — the bed keeps its own schedule and the alarm is yours to set.";
    if (s === "Gentle") return "Heat and light only, once. No escalation, no phone.";
    if (s === "Relentless") return "Everything armed, escalating every 3 minutes until the bed is empty — including the cold snap and sound.";
    return "Heat and light start early; vibration and the phone fire at your wake time, then it escalates every 4 minutes until you're out of bed — up to 25 minutes.";
  }

  _cchOffHTML() {
    return `<div class="gl-tile cch-hero off">
        <span class="gl-lbl">${CCH_ICONS.shield}Sleep Coach</span>
        <div class="cch-note big">Set a bedtime you want to hit and a time to be up. The coach nudges you
          when you're not in bed, counts what you owe yourself, and makes the morning stick.</div>
        <button class="pk-btn pkg-go cch-imup" data-cch-toggle="coach">${GLOW_ICON_CHECK}Switch the coach on</button>
      </div>
      <button class="gl-tile cch-prow tap" data-cch-pop="targets">
        <span class="cch-ic ok">${CCH_ICONS.clock}</span>
        <div class="cch-pt"><b>Set your targets first</b><em>Asleep by, up at, how much sleep you need</em></div>
        <span class="cch-chev">${V2_ICON_CHEVR}</span>
      </button>`;
  }

  // ---------------------------------------------------------------- Targets sheet
  // Centred Glow card, never a bottom sheet (the HA card's footer covers those) — design rule
  // from the Pod Popups round. Steppers write straight to the helpers, live.
  _cchPopHTML() {
    const T = this._cchTargets();
    const wknd = this._cchTargetsPane === "weekend";
    const bedKey = wknd ? "target_bedtime_weekend" : "target_bedtime";
    const wakeKey = wknd ? "target_wake_weekend" : "target_wake";
    const bed = this._cchMins(bedKey), wake = this._cchMins(wakeKey);
    const step = (label, sub, val, kind, key, unit) => `<div class="cch-srow">
        <div class="cch-pt"><b>${escapeHtml(label)}</b>${sub ? `<em>${escapeHtml(sub)}</em>` : ""}</div>
        <div class="cch-sctl">
          <button class="cch-sbtn" data-cch-step="${kind}:${key}:-1" aria-label="Less">${V2_ICON_MINUS}</button>
          <span class="cch-sval">${val}</span>
          <button class="cch-sbtn" data-cch-step="${kind}:${key}:1" aria-label="More">${V2_ICON_PLUS}</button>
        </div></div>`;
    return `<div class="pkg-hd">
        <span class="pkg-badge">${CCH_ICONS.shield}</span>
        <div class="pkg-ht"><div class="pkg-title">Coach targets</div>
          <div class="cch-sub">What "on time" means</div></div>
        <button class="slp-arrow" data-cch-pop="close" aria-label="Close">${SLP_ICON_X}</button>
      </div>
      <div class="slp-seg wide" style="margin-top:14px">
        <button class="slp-opt${wknd ? "" : " on"}" data-cch-pane="week">Weeknights</button>
        <button class="slp-opt${wknd ? " on" : ""}" data-cch-pane="weekend">Weekends</button>
      </div>
      <div class="cch-srows">
        ${step("Asleep by", null, this._cchClock(bed == null ? T.bed : bed), "time", bedKey)}
        <i class="cch-hair"></i>
        ${step("Up at", null, this._cchClock(wake == null ? T.wake : wake), "time", wakeKey)}
        <i class="cch-hair"></i>
        ${step("Sleep need", "what debt is counted against", this._cchDur(Math.round(this._cchNum("sleep_need", 8) * 60)), "num", "sleep_need")}
        <i class="cch-hair"></i>
        ${step("Wind-down", "before your bedtime", `${this._cchNum("winddown_lead", 45)}<small> min</small>`, "num", "winddown_lead")}
        <i class="cch-hair"></i>
        ${step("Green window", "inside this counts as on time", `${this._cchNum("green_window", 15)}<small> min</small>`, "num", "green_window")}
      </div>
      ${this._cchSt("pull_earlier") ? `<button class="cch-prow tap" data-cch-toggle="pull_earlier">
        <span class="cch-ic amb">${CCH_ICON_ARROW}</span>
        <div class="cch-pt"><b>Pull earlier when in debt</b><em>Up to 30 min, never before 9:30 pm</em></div>
        ${this._cchSwitch(this._cchBool("pull_earlier"))}</button>` : ""}
      <div class="cch-prow"><span class="cch-ic off">${CCH_ICONS.shield}</span>
        <div class="cch-pt"><b>Coach</b><em>Off switches every nudge and the wake escalation off</em></div>
        ${this._cchSwitch(this._cchBool("coach"))}
        <span class="cch-tapzone" data-cch-toggle="coach"></span></div>
      <div class="pk-actions"><button class="pk-btn pkg-go" data-cch-pop="close">${GLOW_ICON_CHECK}Done</button></div>`;
  }
  _cchOpenPop(kind) {
    const ov = this.shadowRoot.getElementById("cchPop");
    if (!ov || kind !== "targets") return;
    this._cchTargetsPane = this._cchWeekend() ? "weekend" : "week";
    const sheet = ov.querySelector(".pk-sheet");
    if (sheet) sheet.innerHTML = this._cchPopHTML();
    ov.classList.add("open");
    this._haptic("light");
  }
  _cchRepaintPop() {
    const ov = this.shadowRoot.getElementById("cchPop");
    if (!ov || !ov.classList.contains("open")) return;
    const sheet = ov.querySelector(".pk-sheet");
    if (sheet) sheet.innerHTML = this._cchPopHTML();
  }
  _cchClosePop() {
    const ov = this.shadowRoot.getElementById("cchPop");
    if (ov) ov.classList.remove("open");
  }

  // ---------------------------------------------------------------- writes
  _cchToggle(key) {
    const id = this._cchE(key);
    if (!this._hass || !this._hass.states[id]) return;
    this._haptic("light");
    this._hass.callService("input_boolean", "toggle", { entity_id: id });
    if (key === "coach") this._cchSig = null;
  }
  _cchStepTime(key, dir) {
    const cur = this._cchMins(key);
    const base = cur == null ? (key.indexOf("wake") >= 0 ? 6 * 60 + 30 : 22 * 60 + 30) : cur;
    const next = ((base + dir * 15) % 1440 + 1440) % 1440;
    this._haptic("light");
    this._hass.callService("input_datetime", "set_datetime", {
      entity_id: this._cchE(key),
      time: `${String(Math.floor(next / 60)).padStart(2, "0")}:${String(next % 60).padStart(2, "0")}:00`,
    });
  }
  _cchStepNum(key, dir) {
    const st = this._cchSt(key);
    if (!st) return;
    const a = st.attributes || {};
    const stepBy = Number.isFinite(a.step) && a.step > 0 ? a.step : (key === "sleep_need" ? 0.25 : 5);
    const min = Number.isFinite(a.min) ? a.min : 0;
    const max = Number.isFinite(a.max) ? a.max : 999;
    const cur = parseFloat(st.state);
    const next = Math.max(min, Math.min(max, (Number.isFinite(cur) ? cur : 0) + dir * stepBy));
    this._haptic("light");
    this._hass.callService("input_number", "set_value", { entity_id: this._cchE(key), value: Math.round(next * 100) / 100 });
  }
  _cchSetStrength(v) {
    const id = this._cchE("wake_strength");
    if (!this._hass || !this._hass.states[id]) return;
    this._haptic("light");
    this._hass.callService("input_select", "select_option", { entity_id: id, option: v });
  }
  _cchImUp() {
    const id = this._cchE("wake_ack");
    if (!this._hass || !this._hass.states[id]) return;
    this._haptic("success");
    this._hass.callService("input_boolean", "turn_on", { entity_id: id });
  }





  // normalise one entity's history list into [{t(ms), state, attrs}] with attrs carried forward
  _parseHist(list) {
    if (!Array.isArray(list)) return [];
    let a = {};
    return list.map((it) => {
      a = Object.assign({}, a, it.a || {});
      const t = Number.isFinite(it.lu) ? it.lu * 1000
        : (Number.isFinite(it.lc) ? it.lc * 1000 : Date.parse(it.last_updated || it.last_changed));
      return { t, state: it.s !== undefined ? it.s : it.state, attrs: a };
    }).filter((x) => Number.isFinite(x.t));
  }














  _underglowHTML() {
    const c = this._config;
    return `<div class="rm-uw">
      <div class="rm-uw-head">Underglow lighting</div>
      <div class="rm-uw-chips">
        <button class="rm-uw-chip" data-uw="red"><span class="rm-uw-sw" style="background:#ff3b30"></span>Red</button>
        <button class="rm-uw-chip" data-uw="warm"><span class="rm-uw-sw" style="background:#ffb066"></span>Warm white</button>
        <button class="rm-uw-chip" data-uw="cool"><span class="rm-uw-sw" style="background:#cfe3ff"></span>Cool white</button>
      </div>
      ${c.underglow_auto_entity ? `<div class="rm-uw-auto">
        <span class="rm-uw-auto-l">Auto cool-white at wake</span>
        <span class="smart-switch" id="uwAutoSwitch" role="switch" aria-label="Auto cool-white at wake">${SW_GLASS}<span class="sk">${SW_GLASS}</span></span>
      </div>` : ""}
    </div>`;
  }

  _underglowMode() {
    const e = this._hass && this._hass.states[this._config.underglow_entity];
    if (!e || e.state !== "on") return null;
    const a = e.attributes || {};
    if (a.color_mode === "rgbw" && Array.isArray(a.rgbw_color)) {
      const [rr, gg, bb] = a.rgbw_color;
      return (rr > 150 && gg < 60 && bb < 60) ? "red" : null;
    }
    if (a.color_mode === "color_temp" && Number.isFinite(a.color_temp_kelvin)) {
      return a.color_temp_kelvin < 4200 ? "warm" : "cool";
    }
    return null;
  }
  _setUnderglow(mode) {
    const id = this._config.underglow_entity;
    if (!id || !this._hass) return;
    this._haptic("light");
    if (this._underglowMode() === mode) { this._hass.callService("light", "turn_off", { entity_id: id }); return; }
    const data = mode === "red" ? { rgbw_color: [255, 0, 0, 0], brightness_pct: 15 }
      : mode === "warm" ? { color_temp_kelvin: 2200, brightness_pct: 60 }
      : { color_temp_kelvin: 6000, brightness_pct: 80 };
    this._hass.callService("light", "turn_on", Object.assign({ entity_id: id }, data));
  }
  _toggleUnderglowAuto() {
    const id = this._config.underglow_auto_entity;
    if (!id) return;
    this._haptic("light");
    this._hass.callService("input_boolean", "toggle", { entity_id: id });
  }
  _updateUnderglowUI() {
    const c = this._config;
    if (c.underglow_entity) {
      const mode = this._underglowMode();
      this.shadowRoot.querySelectorAll("[data-uw]").forEach((b) => b.classList.toggle("on", b.dataset.uw === mode));
    }
    if (c.underglow_auto_entity) {
      const sw = this.shadowRoot.getElementById("uwAutoSwitch");
      const e = this._hass.states[c.underglow_auto_entity];
      if (sw) sw.classList.toggle("on", !!e && e.state === "on");
    }
  }


  _build() {
    ensureFont(this._config.font_url);
    ensureAnimatableProps();
    const dial = this._dialHTML();
    if (this._mode === "dial") {
      this.shadowRoot.innerHTML = `
        <style>${STYLE}</style>
        ${SW_GLASS_FILTER}
        <ha-card class="mode-dial">
          <div class="overlay open dial-inline" id="overlay">
            <div class="ov-inner">${dial}</div>
          </div>
          <div class="overlay picker-ov" id="pickerOverlay"><div class="pk-sheet"></div></div>
        </ha-card>`;
    } else {
      this.shadowRoot.innerHTML = `
        <style>${STYLE}${this._xrOn() ? XR_STYLE : ""}${LN_STYLE}</style>
        ${SW_GLASS_FILTER}
        <ha-card>
          ${this._podHTML()}
          <div class="overlay" id="overlay">
            <div class="ov-inner">${dial}</div>
          </div>
          <!-- v2 no longer uses this overlay for Autopilot detail — it's its own tab now
               (#viewAutopilot, in _podHTMLv2()); classic still opens it as before -->
          ${this._config.smart_entity && this._layout !== "v2" ? `<div class="overlay smart-ov" id="smartOverlay"><div class="ov-inner">${this._smartHTML()}</div></div>` : ""}
          <div class="overlay picker-ov" id="pickerOverlay"><div class="pk-sheet"></div></div>
          <div class="overlay picker-ov modal slp-pop" id="slpPop" style="--pk-accent:183,155,255;--pk-acc:#b79bff;--pk-lo:#8a6be0;--pk-ic:#d8c9ff"><div class="pk-sheet pkg"></div></div>
          <div class="overlay picker-ov modal cch-pop" id="cchPop" style="--pk-accent:51,209,122;--pk-acc:#33d17a;--pk-lo:#1f9c58;--pk-ic:#7ee2a8"><div class="pk-sheet pkg"></div></div>
        </ha-card>`;
    }

    const $ = (id) => this.shadowRoot.getElementById(id);
    const wire = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };

    wire("burger", () => this._moreInfo());
    wire("hdGear", () => this._setView(this._view === "settings" ? "pod" : "settings"));
    const tt = $("tempTile");
    if (tt) tt.onclick = (ev) => {
      if (ev.target.closest("#homeMinus,#homePlus,#powerHome,#tempRingWrap,.ht-ctl,#sideSel,#hdGear")) return;
      // v2 deprecates the old full-screen ring-dial screen — Home's own track/steppers/side
      // switch/power button already cover everything it did, so tapping the rest of the block
      // does nothing extra rather than opening it. Classic still opens it, unchanged.
      if (this._layout === "v2") return;
      this._setOpen(true);
    };
    // v2 only — tab bar, the Autopilot strip's "See why" line, and the warm-wake placeholder
    const tb = $("tabBar");
    // v10.43: liquid-lens drag + (navbar_join) the bubble join — see LN_MIXIN
    if (tb) this._lnWire(tb);
    // the sliding lens's translateX is measured in real pixels (offsetLeft/offsetWidth), so a
    // width/orientation change needs a recompute — wired once per card instance (a guard, since
    // _build() re-runs on every layout toggle and window outlives all of them; a naive
    // addEventListener here would stack a fresh listener on every toggle otherwise)
    if (tb && !this._tabLensResizeWired) {
      this._tabLensResizeWired = true;
      window.addEventListener("resize", () => this._positionTabLens());
    }
    if (tb) this._positionTabLens();
    // #smpLine only exists in v2's compact "strip" panel (classic expands inline instead) —
    // its own tab now, not the shared overlay
    wire("smpLine", (e) => { e.stopPropagation(); this._setView("autopilot"); });
    wire("warmWakeSwitch", (e) => { e.stopPropagation(); this._warmWakeOn = this._warmWakeOn === false; this._haptic("light"); this._update(); });
    wire("autoOffSwitchV2", (e) => { e.stopPropagation(); this._toggleAutoOff(); });
    wire("owuRow", (e) => {
      e.stopPropagation();
      const id = this._config.off_when_up_entity;
      if (!id || !this._hass.states[id]) return;
      this._haptic("light");
      this._hass.callService("input_boolean", "toggle", { entity_id: id });
    });
    wire("autoOffRowV2", (e) => { if (e.target.closest("#autoOffSwitchV2")) return; this._openPicker("time", this._sc("auto_off_entity"), "Auto-off bed"); });
    wire("homeMinus", (e) => { e.stopPropagation(); this._bump(-1); });
    wire("homePlus", (e) => { e.stopPropagation(); this._bump(1); });
    wire("powerHome", (e) => { e.stopPropagation(); this._togglePower(); });
    // inline smart panel: head toggles on/off (body expands); bias steppers adjust the offset
    wire("smpHead", () => this._toggleSmart());
    wire("smpBiasMinus", (e) => { e.stopPropagation(); this._adjustBias(-0.5); });
    wire("smpBiasPlus", (e) => { e.stopPropagation(); this._adjustBias(0.5); });
    wire("autoOffSwitch", (e) => { e.stopPropagation(); this._toggleAutoOff(); });
    wire("sideSwitch", (e) => { e.stopPropagation(); this._togglePartner(); });
    wire("primeBtn", (e) => { e.stopPropagation(); this._startPrime(); });
    wire("primeCancel", (e) => { e.stopPropagation(); this._cancelPrime(); });
    const stRow = $("sideToggleRow"); if (stRow) stRow.onclick = (e) => { e.stopPropagation(); this._togglePartner(); };
    wire("autoOffTime", (e) => { e.stopPropagation(); this._openPicker("time", this._sc("auto_off_entity"), "Auto-off bed"); });
    wire("wlSwitch", (e) => { e.stopPropagation(); this._toggleWakeLight(); });
    wire("wlPick", (e) => { e.stopPropagation(); this._openPicker("light", this._config.alarm_light_select_entity, "Wake-up light"); });
    wire("smartSwitchDial", (e) => { e.stopPropagation(); this._toggleSmart(); });
    const srowD = $("smartRowDial");
    if (srowD) srowD.onclick = (e) => { if (e.target.closest("#smartSwitchDial")) return; e.stopPropagation(); this._setSmartOpen(true); };
    wire("smartClose", () => this._setSmartOpen(false));
    wire("smartApply", () => this._applySuggested());
    wire("smartToggle2", () => this._toggleSmart());
    wire("smartBiasMinus", (e) => { e.stopPropagation(); this._adjustBias(-0.5); });
    wire("smartBiasPlus", (e) => { e.stopPropagation(); this._adjustBias(0.5); });
    const biasSeg = $("smBiasSeg");
    if (biasSeg) biasSeg.onclick = (e) => { const b = e.target.closest("[data-bias]"); if (b) this._setBias(+b.dataset.bias); };
    // Autopilot tab (v2): one delegated handler for the whole view — the folds and every tuning
    // control, all of which are re-rendered on each update, so per-element wiring would go stale.
    const apView = $("viewAutopilot");
    if (apView) apView.onclick = (e) => this._apClick(e);
    // Dev tab (v2): one delegated handler — action buttons + tap-a-row-for-more-info, all
    // re-rendered on each update so per-element wiring would go stale.
    const devView = $("viewDev");
    if (devView) devView.onclick = (e) => this._devClick(e);
    const sPop = $("slpPop");
    if (sPop) sPop.onclick = (e) => { if (e.target === sPop) this._slpClosePop(); };
    const cPop = $("cchPop");
    if (cPop) cPop.onclick = (e) => { if (e.target === cPop) this._cchClosePop(); };
    wire("closeDial", () => { if (this._mode === "dial") this._moreInfo(); else this._setOpen(false); });
    wire("powerDial", () => this._togglePower());
    wire("dialMinus", () => this._bump(-1));
    wire("dialPlus", () => this._bump(1));
    // delegated clicks (works for both the dial and the home-card manual panel instances)
    this.shadowRoot.addEventListener("click", (e) => {
      // v2 Glow Home: per-side steppers, side select, schedule chips, Autopilot curve
      const glb = e.target.closest("[data-glbump]");
      if (glb) { e.stopPropagation(); this._glBump(glb.dataset.glside, +glb.dataset.glbump); return; }
      const gls = e.target.closest("[data-glsel]");
      if (gls) { e.stopPropagation(); if (gls.dataset.glsel === "self" || this._partnerOn()) this._setActiveSide(gls.dataset.glsel); return; }
      const glp = e.target.closest("[data-glstep]");
      if (glp) { e.stopPropagation(); this._openPicker("step", glp.dataset.glstep, glp.dataset.label); return; }
      const gla = e.target.closest("[data-glauto]");
      if (gla) { e.stopPropagation(); if (this._config.smart_entity) this._setView("autopilot"); return; }
      // ---- Sleep report (v10.25): person, Night/Week, date arrows, a week column, the score popup ----
      const sw = e.target.closest("[data-slp-who]");
      if (sw) {
        e.stopPropagation(); this._slpPerson = sw.dataset.slpWho; this._slpDate = null;
        this._slpCursor = null; this._haptic("light"); this._renderSleep(true); return;
      }
      const sv = e.target.closest("[data-slp-view]");
      if (sv) { e.stopPropagation(); this._slpView = sv.dataset.slpView; this._haptic("light"); this._renderSleep(true); return; }
      const sg = e.target.closest("[data-slp-go]");
      if (sg) {
        e.stopPropagation();
        const today = this._slpISO(this._slpNow());
        const next = this._slpShift(this._slpDate || today, +sg.dataset.slpGo);
        if (next <= today && next >= this._slpShift(today, -6)) {
          this._slpDate = next; this._slpCursor = null; this._haptic("light"); this._renderSleep(true);
        }
        return;
      }
      const sd = e.target.closest("[data-slp-date]");
      if (sd) {
        e.stopPropagation(); this._slpDate = sd.dataset.slpDate; this._slpView = "night";
        this._slpCursor = null; this._haptic("light"); this._renderSleep(true); return;
      }
      // ---- Sleep Coach (v10.29) ----
      const cv = e.target.closest("[data-cch-view]");
      if (cv) { e.stopPropagation(); this._cchView = cv.dataset.cchView; this._haptic("light"); this._renderCoach(true); return; }
      const cp = e.target.closest("[data-cch-pop]");
      if (cp) {
        e.stopPropagation();
        if (cp.dataset.cchPop === "close") this._cchClosePop(); else this._cchOpenPop(cp.dataset.cchPop);
        return;
      }
      const cpane = e.target.closest("[data-cch-pane]");
      if (cpane) { e.stopPropagation(); this._cchTargetsPane = cpane.dataset.cchPane; this._haptic("light"); this._cchRepaintPop(); return; }
      const ctg = e.target.closest("[data-cch-toggle]");
      if (ctg) { e.stopPropagation(); this._cchToggle(ctg.dataset.cchToggle); this._cchRepaintPop(); this._renderCoach(true); return; }
      const cstep = e.target.closest("[data-cch-step]");
      if (cstep) {
        e.stopPropagation();
        const [kind, key, dir] = cstep.dataset.cchStep.split(":");
        if (kind === "time") this._cchStepTime(key, Number(dir)); else this._cchStepNum(key, Number(dir));
        return;
      }
      const cstr = e.target.closest("[data-cch-strength]");
      if (cstr) { e.stopPropagation(); this._cchSetStrength(cstr.dataset.cchStrength); this._renderCoach(true); return; }
      const ctime = e.target.closest("[data-cch-time]");
      if (ctime) { e.stopPropagation(); this._openPicker("time", this._cchE(ctime.dataset.cchTime), "Up at"); return; }
      const cup = e.target.closest("[data-cch-imup]");
      if (cup) { e.stopPropagation(); this._cchImUp(); this._renderCoach(true); return; }
      const sp = e.target.closest("[data-slp-pop]");
      if (sp) {
        e.stopPropagation();
        if (sp.dataset.slpPop === "close") this._slpClosePop(); else this._slpOpenPop(sp.dataset.slpPop);
        return;
      }
      const nv = e.target.closest(".hnav [data-view]");
      if (nv) { e.stopPropagation(); this._setView(nv.dataset.view); return; }
      const sl = e.target.closest("[data-v2layout]");
      if (sl) { e.stopPropagation(); this._setLayout(sl.dataset.v2layout); return; }
      const vm = e.target.closest("[data-v2mode]");
      if (vm) {
        e.stopPropagation();
        if (vm.dataset.v2mode === "auto") { if (!this._smartOn()) this._toggleSmart(); }
        else if (this._smartOn()) this._disableSmartForManual();
        return;
      }
      const vc = e.target.closest("[data-v2chip]");
      if (vc) {
        e.stopPropagation();
        if (vc.dataset.v2chip === "partner") this._togglePartner();
        else if (vc.dataset.v2chip === "prime") this._startPrime();
        else if (vc.dataset.v2chip === "autooff") this._openPicker("time", this._sc("auto_off_entity"), "Auto-off bed");
        return;
      }
      const done = e.target.closest("#setDone");
      if (done) { e.stopPropagation(); this._setView("pod"); return; }
      const hkT = e.target.closest("#hkToggle");
      if (hkT) { e.stopPropagation(); this._hkAsk((this._hkState || {}).canWrite ? "sync" : "authorize"); return; }
      const hkB = e.target.closest("#hkBackfill");
      if (hkB) { e.stopPropagation(); this._hkAsk("backfill"); return; }
      if (e.target.closest("#hrEdge")) { e.stopPropagation(); this._openHeadroom(); return; }
      if (e.target.closest("#glWake")) { e.stopPropagation(); this._openWake(); return; }
      const srb = e.target.closest("#setReboot");
      if (srb) { e.stopPropagation(); this._rebootTap(); return; }
      const sdev = e.target.closest("#setDev");
      if (sdev) { e.stopPropagation(); this._setView("dev"); return; }
      const dback = e.target.closest("#devBack");
      if (dback) { e.stopPropagation(); this._setView("settings"); return; }
      // ---- Settings > Pod Light (light.eight_sleep_pod_front_led) ----
      const lpw = e.target.closest("#ledPower");
      if (lpw) { e.stopPropagation(); this._haptic("light"); this._hass.callService("light", "toggle", { entity_id: this._ledEntity() }); return; }
      const lsw = e.target.closest("[data-led-color]");
      if (lsw) {
        e.stopPropagation(); this._haptic("light");
        const rgb = lsw.dataset.ledColor.split(",").map(Number);
        this._hass.callService("light", "turn_on", { entity_id: this._ledEntity(), rgb_color: rgb });
        return;
      }
      const lfx = e.target.closest("[data-led-fx]");
      if (lfx) {
        e.stopPropagation(); this._haptic("light");
        this._hass.callService("light", "turn_on", { entity_id: this._ledEntity(), effect: lfx.dataset.ledFx });
        return;
      }
      const pe = e.target.closest("[data-pick-ent]");
      if (pe) { e.stopPropagation(); if (pe.dataset.pickEnt) this._openPicker("time", pe.dataset.pickEnt, pe.dataset.pickLabel); return; }
      // v2 Home header's Solo/Dual pill (#modeSelHd) — the ONLY control that turns the partner's
      // side on/off. Symmetric either direction: only actually calls _togglePartner() when the
      // tapped option differs from the current state, so tapping the already-active side is a no-op.
      const ms = e.target.closest("#modeSelHd [data-mode]");
      if (ms) {
        e.stopPropagation();
        if ((ms.dataset.mode === "dual") !== this._partnerOn()) this._togglePartner();
        return;
      }
      // the You/Partner view switch (v2's #sideSelTile at the temp tile, classic's #sideSel,
      // the dial's #sideSelDial) — pure view switch, never touches whether a side is on.
      const ss = e.target.closest(".side-sel [data-side]");
      if (ss) { e.stopPropagation(); this._setActiveSide(ss.dataset.side); return; }
      const wdBtn = e.target.closest("[data-winddown]");
      if (wdBtn) { e.stopPropagation(); this._toggleWinddown(); return; }
      const boostBtn = e.target.closest("[data-boost]");
      if (boostBtn) {
        // a long-press just opened the custom picker — the tap that ends the hold shouldn't ALSO toggle
        if (this._boostHoldFired) { this._boostHoldFired = false; return; }
        this._toggleBoost(boostBtn.dataset.boost);
        return;
      }
      const uwChip = e.target.closest("[data-uw]");
      if (uwChip) { e.stopPropagation(); this._setUnderglow(uwChip.dataset.uw); return; }
      const uwAuto = e.target.closest("#uwAutoSwitch");
      if (uwAuto) { e.stopPropagation(); this._toggleUnderglowAuto(); return; }
      const preset = e.target.closest("[data-preset]");
      if (preset) {
        if (preset.dataset.preset === "away") this._toggleAway();
        else { this._disableSmartForManual(); this._setTemp(parseFloat(preset.dataset.preset)); }
        return;
      }
      const pick = e.target.closest(".timeline [data-pick]");
      if (pick) {
        // in the dial, tapping the schedule while smart is on opens the smart detail
        if (this._mode === "dial" && this._sc("smart_entity") && this._smartOn()) { this._haptic("light"); this._setSmartOpen(true); return; }
        if (pick.dataset.ent) this._openPicker(pick.dataset.pick, pick.dataset.ent, pick.dataset.label);
        return;
      }
      // v2 Schedule step rail — one tap opens a combined time+temperature sheet
      const step = e.target.closest(".step-row[data-step]");
      if (step) { this._openPicker("step", step.dataset.step, step.dataset.label); return; }
    });
    // long-press on a holdable boost chip (Pre Cool Sleep) opens the custom temp/duration
    // picker instead of the plain-tap default; releasing early is just a normal tap. A fill
    // sweeps across the chip while held so the gesture is visible, not a hidden trick.
    const BOOST_HOLD_MS = 500;
    this.shadowRoot.addEventListener("pointerdown", (e) => {
      const btn = e.target.closest('[data-boost][data-boost-holdable="1"]');
      if (!btn) return;
      clearTimeout(this._boostHoldTimer);
      this._boostHoldFired = false;
      btn.style.setProperty("--hold-ms", BOOST_HOLD_MS + "ms");
      void btn.offsetWidth;   // force reflow so re-holding restarts the fill from empty
      btn.classList.add("holding");
      this._boostHoldTimer = setTimeout(() => {
        this._boostHoldFired = true;
        this._boostHoldAt = Date.now();
        this._haptic("medium");
        btn.classList.remove("holding");
        const dir = btn.dataset.boost;
        this._openPicker("boost", dir, dir === "cool" ? "Pre-cool sleep" : "Pre-heat");
      }, BOOST_HOLD_MS);
    });
    // v10.28: in the iOS app WKWebView's own long-press recogniser claims the touch, so the page
    // gets a pointercancel (real phone) or no pointer events at all (simulator) and the timer above
    // never fires. The app watches for the long-press natively and hands over the point instead.
    if (!this._podLongPressWired) {
      this._podLongPressWired = true;
      window.addEventListener("pod-longpress", (e) => {
        // already handled by the pointer timer (it cleared its own timer or opened the picker)
        if (!this.isConnected || !this.shadowRoot || this.shadowRoot.querySelector(".picker-ov.open")) return;
        const d = (e && e.detail) || {};
        const hit = this.shadowRoot.elementFromPoint ? this.shadowRoot.elementFromPoint(d.x, d.y) : null;
        const btn = hit && hit.closest && hit.closest('[data-boost][data-boost-holdable="1"]');
        if (!btn) return;
        clearTimeout(this._boostHoldTimer);
        this._boostHoldFired = true;   // swallow the click that ends the hold
        this._boostHoldAt = Date.now();
        btn.classList.remove("holding");
        this._haptic("medium");
        const dir = btn.dataset.boost;
        this._openPicker("boost", dir, dir === "cool" ? "Pre-cool sleep" : "Pre-heat");
      });
    }
    ["pointerup", "pointercancel", "pointerleave"].forEach((evt) => {
      this.shadowRoot.addEventListener(evt, (e) => {
        clearTimeout(this._boostHoldTimer);
        const btn = e.target.closest('[data-boost][data-boost-holdable="1"]');
        if (btn) btn.classList.remove("holding");
        else this.shadowRoot.querySelectorAll(".chip.boost.holding").forEach((b) => b.classList.remove("holding"));
      });
    });

    this._mountFan();
    const bed = $("bed");
    if (bed && !(this._xrOn() && this._xrBedMode() === "model")) {
      if (this._config.bed_image) {
        // mattress sleeping-surface trapezoid (perspective-matched); tune via `glow_poly`
        const poly = this._config.glow_poly || "21% 30%, 84% 30%, 88% 56%, 15% 56%";
        const fxStyle = `clip-path:polygon(${poly});-webkit-clip-path:polygon(${poly});`
          + (this._config.glow_rect ? `inset:${this._config.glow_rect};` : "");
        // optional separate pillow layer composited on top of the glow (stays neutral)
        let pillowStyle = this._config.pillow_style || "";
        if (this._config.pillow_shadow) pillowStyle += `;filter:${this._config.pillow_shadow};`;
        const pillows = this._config.pillow_image
          ? `<img class="bed-pillows" src="${this._config.pillow_image}" alt="" style="${pillowStyle}" />`
          : "";
        // dual-capable beds render two independently-coloured half glow layers (left + right),
        // each masked to its half; single-user beds keep one full-bed glow layer
        const fxKids = `<div class="bed-photo-glow"></div>`
          + `<div class="bed-dots"><div class="dfd dim"></div>`
          + `<div class="dfd lit"><i class="tide"></i><i class="band"></i><i class="commit"></i><i class="hold"></i></div>`
          // v10.8: presence layer — masked to the same dot field, coloured amber independent
          // of warm/cool, with a slow heartbeat. Fades in/out on _presence_ (see .is-occupied).
          + `<div class="dfd body"><i class="b-torso"></i><i class="b-hips"></i><i class="b-legs"></i></div></div>`;
        // v9.4: the rim runner is gone — the room glow already draws the bed's edge, and a
        // hairline over a photograph reads as a stray artefact at phone size. _setEdge no-ops
        // when the elements are absent, so the dual-side painting code is untouched.
        const edgeSvg = "";
        // wide soft room glow behind the bed + the plates that knock the grey sheet back
        const roomGlow = `<div class="bed-glow g-l"></div><div class="bed-glow g-r"></div>`;
        const sheets = this._config.glow_poly
          ? `<div class="bed-sheet sheet-l"></div><div class="bed-sheet sheet-r"></div>` : "";
        // halves clip to their own rounded box (CSS); the full single layer uses the mattress polygon
        const fxLayers = this._config.partner_climate_entity
          ? `<div class="bed-photo-fx bed-half half-left" data-half="left">${fxKids}</div>
             <div class="bed-photo-fx bed-half half-right" data-half="right">${fxKids}</div>`
          : `<div class="bed-photo-fx" data-half="full" style="${fxStyle}">${fxKids}</div>`;
        // green "pumping" priming layer (shown only while is_priming) — sits on top of the thermal glow
        const priming = this._config.priming_entity
          ? `<div class="bed-priming" style="${fxStyle}"><div class="bp-glow"></div><div class="bp-flow"></div></div>`
          : "";
        bed.innerHTML =
          `<div class="bed-photo">
             ${roomGlow}
             <img class="bed-img" src="${this._config.bed_image}" alt="Pod" />
             ${sheets}
             ${fxLayers}
             ${edgeSvg}
             ${priming}
             ${pillows}
           </div>`;
        // warp the dot planes onto the mattress once the image has a size (and on resize)
        const bimg = bed.querySelector(".bed-img");
        if (bimg) { if (bimg.complete) this._warpDots(); bimg.addEventListener("load", () => this._warpDots()); }
        if (!this._roWired && window.ResizeObserver) { this._roWired = true; new ResizeObserver(() => this._warpDots()).observe(bed); }
      } else {
        bed.innerHTML = BED_SVG;
      }
    }

    // gauge static geometry (280° arc, gap at bottom) — present in both modes
    const cx = 160, cy = 160, r = 132;
    this._gauge = { cx, cy, r, start: -140, sweep: 280 };
    $("track").setAttribute("d", this._arcPath(cx, cy, r, this._gauge.start, this._gauge.start + this._gauge.sweep));
    let ticks = "";
    for (let i = 0; i <= 20; i++) {
      const ang = this._gauge.start + (i / 20) * this._gauge.sweep;
      const [x1, y1] = this._polar(cx, cy, r - 16, ang);
      const [x2, y2] = this._polar(cx, cy, r - (i % 5 === 0 ? 26 : 22), ang);
      ticks += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="tick"/>`;
    }
    $("ticks").innerHTML = ticks;

    // temp-tile ring geometry (same 280° arc, smaller)
    this._ring = { cx: 66, cy: 66, r: 54, start: -140, sweep: 280 };
    const rt = $("ringTrack");
    if (rt) rt.setAttribute("d", this._arcPath(66, 66, 54, this._ring.start, this._ring.start + this._ring.sweep));

    this._wireGaugeDrag();
    this._built = true;
    if (this._xrOn()) this._xrMount();
  }

  /* v10.39 — a live Dyson standing at the bed's left edge. `fan_entity` turns it on; the fan is
     dyson-fan-card's own `mini` mode (bare x-ray fan + its air on the page), so it needs that
     resource on the dashboard — without it nothing is drawn. Tap = power, hold = `fan_path`.
       fan_entity: fan.bedroom
       fan_path:   /dashboard-bedroom/fan   # hold opens the full controller
       fan_yaw:    55                               # ° the head faces: + turns it toward the bed
       fan_x:      0.22                             # where it stands across its box (0–1)
       bed_shift:  7                                # v10.40: % the bed slides right to make room */
  _mountFan() {
    const c = this._config, host = this.shadowRoot.getElementById("esFan");
    if (!host || !c.fan_entity) return;
    this._fanEl = null;
    host.textContent = "";
    const mk = () => {
      if (this._fanEl) return;
      const el = document.createElement("dyson-fan-card");
      try {
        el.setConfig({ type: "custom:dyson-fan-card", entity: c.fan_entity, mini: true, hero: "xray", font_url: false,
          mini_yaw: c.fan_yaw != null ? c.fan_yaw : 55, mini_x: c.fan_x != null ? c.fan_x : 0.22, mini_path: c.fan_path || "",
          front_angle: 0, ring_tilt: c.fan_tilt != null ? c.fan_tilt : 0.27 });
      } catch (e) { console.warn("eight-sleep-card fan", e); return; }
      host.appendChild(el);
      this._fanEl = el;
      if (this._hass) el.hass = this._hass;
    };
    if (customElements.get("dyson-fan-card")) mk();
    else if (customElements.whenDefined) customElements.whenDefined("dyson-fan-card").then(mk);
  }

  /* ================= update (every hass) ================= */
  _update() {
    if (!this._built || !this._hass) return;
    if (this._fanEl) this._fanEl.hass = this._hass;
    const $ = (id) => this.shadowRoot.getElementById(id);
    const v2layout = this._layout === "v2";
    // header nav: toggle Pod / Routine views
    const vPod = $("viewPod"), vRoutine = $("viewRoutine"), vSettings = $("viewSettings");
    const vAutopilot = $("viewAutopilot"), vDev = $("viewDev");
    if (vPod && vRoutine) {
      const view = this._view;
      vPod.hidden = view !== "pod"; vRoutine.hidden = view !== "routine";
      if (vAutopilot) vAutopilot.hidden = view !== "autopilot";   // v2 only — its own tab, not a popup
      if (vDev) vDev.hidden = view !== "dev";   // v2 only — the diagnostics screen (Settings › Developer)
      const vSleep = $("viewSleep"); if (vSleep) vSleep.hidden = view !== "sleep";
      const vCoach = $("viewCoach"); if (vCoach) vCoach.hidden = view !== "coach";
      const podRoot = $("podRoot");
      if (podRoot) { podRoot.classList.toggle("slp-mode", view === "sleep"); podRoot.classList.toggle("cch-mode", view === "coach"); }
      if (vSettings) vSettings.hidden = view !== "settings";
      const gear = $("hdGear"); if (gear) gear.classList.toggle("on", view === "settings");
      const hn = $("headerNav");
      if (hn) {
        hn.dataset.view = view;
        const opts = [...hn.querySelectorAll("[data-view]")];
        opts.forEach((o) => o.classList.toggle("on", o.dataset.view === view));
        // JS-computed lens offset: works for any combination of hidden/shown nav buttons,
        // unlike a fixed per-count CSS rule (see .hnav-lens)
        const idx = opts.findIndex((o) => o.dataset.view === view);
        const lens = $("hnavLens");
        if (lens && idx >= 0) lens.style.transform = `translateX(${idx * 42}px)`;
      }
      // v2's floating tab bar: highlight the active destination AND slide the shared lens
      // under it — one element moving (transform), not two cross-fading, so it reads as the
      // native iOS liquid-glass tab bar rather than a fade.
      const tb = $("tabBar");
      if (tb) {
        const tabs = [...tb.querySelectorAll("[data-view]")];
        tabs.forEach((o) => o.classList.toggle("on", o.dataset.view === view));
        this._positionTabLens();
      }
      // "who's driving" chip only makes sense on Schedule
      const schedChip = $("schedChip"); if (schedChip) schedChip.hidden = view !== "routine";
      // Solo/Dual + power only make sense on Home — they used to live in the Home-only temp
      // tile (classic still keeps power there); v2 moved them up into the shared header, which
      // meant they kept showing on Schedule/Sleep/Settings too. Hide them everywhere else.
      const modeSelHd = $("modeSelHd"); if (modeSelHd) modeSelHd.hidden = view !== "pod";
      const pwrHome = $("powerHome"); if (pwrHome && pwrHome.classList.contains("hd-pwr")) pwrHome.hidden = view !== "pod";
      const ht = $("hdTitle");
      if (ht) ht.textContent = view === "routine" ? (v2layout ? "Schedule" : "Your routine") : view === "autopilot" ? "Autopilot" : view === "sleep" ? "Sleep" : view === "coach" ? "Sleep Coach" : view === "settings" ? "Settings" : view === "dev" ? "Developer" : this._config.title;
      if (view === "routine") this._renderRoutine();
      if (view === "sleep") this._renderSleep();
      if (view === "coach") this._renderCoach();
      if (view === "settings") this._renderSettings();
      if (view === "dev") this._renderDev();
      // last, so a render that clears its own indicator (Sleep marking tonight's report read)
      // is already reflected by the time the bar is painted — not one tick later
      this._renderTabStatus();
    }

    // dual-side: only meaningful while the bed is split; otherwise always control this side
    const split = this._partnerOn();
    if (!split && this._activeSide !== "self") this._activeSide = "self";
    const viewingPartner = this._viewingPartner();
    const on = this._effectiveOn();
    const tTemp = this._tgtTemp();
    const cTemp = this._curTemp();
    const dir = this._dir();                 // "warm" | "cool" | "neutral"
    const working = on && this._working();
    const gap = this._gap();
    const bs = this._bedState();
    // dynamic wave speed: bigger gap -> faster (≈6s idle → ≈2.2s hard-working)
    const waveDur = (Math.round((6 - Math.min(gap, 8) / 8 * 3.8) * 2) / 2).toFixed(1) + "s";
    // glow intensity: 0 at the neutral pivot -> 1 at the range extreme; drives saturation + opacity
    // (so a mild warm/cool is faint & desaturated, a hard heat/cool is vivid). curved for early ramp.
    const { min: tMin, max: tMax } = this._range();
    const mid = this._midTemp();
    const span = tTemp >= mid ? (tMax - mid) : (mid - tMin);
    const intensity = span > 0 ? Math.pow(Math.min(1, Math.abs(tTemp - mid) / span), 0.6) : 0;

    // ---- home tile (pod mode only) ----
    const homeLevel = $("homeLevel"), homeMain = $("homeLevelMain"), homeSub = $("homeLevelSub");
    if (homeLevel && homeMain) {
      homeMain.textContent = on ? this._fmtVal(tTemp) : "Off";   // target = "move to"
      homeLevel.classList.toggle("off", !on);
      this._paint(homeLevel, on ? dir : null);
      // current-temp caption ("current at") — only when it differs from the set point
      if (homeSub) {
        const showCur = on && Number.isFinite(cTemp) && Math.abs(tTemp - cTemp) >= 0.5;
        homeSub.textContent = showCur ? `now ${this._fmtVal(cTemp)}` : "";
        homeSub.classList.toggle("shown", showCur);
      }
      const ph = $("powerHome"); if (ph) ph.classList.toggle("on", on);

      // v2 Home only (absent under classic, so every line below no-ops there):
      // status line — colour and copy always travel together (never a bare coloured dot)
      const hsText = $("hsText"), hsDot = $("hsDot"), hsWater = $("hsWater");
      if (hsText) hsText.textContent = this._bedStatusText();
      if (hsDot) { ["warm", "cool", "mid", "off"].forEach((k) => hsDot.classList.remove(k)); hsDot.classList.add(on ? (dir || "mid") : "off"); }
      if (hsWater) {
        const w = this._config.has_water_entity && this._stateStr(this._config.has_water_entity) !== "" ? this._hasWater() : null;
        hsWater.textContent = w === null ? "" : w ? "Water good" : "Add water";
        hsWater.classList.toggle("low", w === false);
      }
      // the temperature axis: thumb sits at the target, track dims while the pod is off
      const thumb = $("tempThumb"), track = $("tempTrack");
      if (thumb) thumb.style.left = (this._frac(tTemp) * 100).toFixed(1) + "%";
      if (track) track.classList.toggle("off", !on);
      // room context under the number, when the entities are configured
      const hr = $("homeRoom");
      if (hr) {
        const rt = this._config.room_temp_entity ? this._stateStr(this._config.room_temp_entity) : "";
        const rh = this._config.room_humidity_entity ? this._stateStr(this._config.room_humidity_entity) : "";
        const bits = [];
        if (rt !== "" && !isNaN(parseFloat(rt))) bits.push(`Room ${Math.round(parseFloat(rt))}\u00b0`);
        if (rh !== "" && !isNaN(parseFloat(rh))) bits.push(`${Math.round(parseFloat(rh))}%`);
        hr.textContent = bits.join(" \u00b7 ");
      }

      // temp ring: fill start→target, knob at target ("move to"), a marker at the current
      // bed temp ("current at"), and an animated dashed arc flowing between them while working.
      const rg = this._ring, rFill = $("ringFill"), rKnob = $("ringKnob"), rSvg = $("tempRing"), rCur = $("ringCur"), rProg = $("ringProg");
      if (rg && rFill && rKnob) {
        const tAng = rg.start + this._frac(tTemp) * rg.sweep;
        const cAng = rg.start + this._frac(cTemp) * rg.sweep;
        rFill.setAttribute("d", this._arcPath(rg.cx, rg.cy, rg.r, rg.start, tAng));
        rFill.style.opacity = on ? "1" : "0.25";
        const [kx, ky] = this._polar(rg.cx, rg.cy, rg.r, tAng);
        rKnob.setAttribute("cx", kx); rKnob.setAttribute("cy", ky);
        rKnob.style.opacity = on ? "1" : "0.3";
        // current-temp marker — glides via CSS cx/cy transition as the bed temp changes
        if (rCur) {
          const [ccx, ccy] = this._polar(rg.cx, rg.cy, rg.r, cAng);
          rCur.setAttribute("cx", ccx); rCur.setAttribute("cy", ccy);
          rCur.style.opacity = on && Number.isFinite(cTemp) ? "1" : "0";
        }
        // "moving to" progress arc between current and target, animated while working
        if (rProg) {
          const showProg = on && working && Math.abs(tTemp - cTemp) >= 0.5;
          if (showProg) {
            const a0 = Math.min(cAng, tAng), a1 = Math.max(cAng, tAng);
            rProg.setAttribute("d", this._arcPath(rg.cx, rg.cy, rg.r, a0, a1));
          }
          rProg.style.opacity = showProg ? "1" : "0";
          rProg.classList.toggle("cooling", cTemp > tTemp);   // reverse flow when cooling down
        }
        if (rSvg) { ["warm", "cool", "mid"].forEach((c) => rSvg.classList.remove(c)); rSvg.classList.toggle("off", !on); if (on) rSvg.classList.add(dir); }
      }

      const bt = this._bedtime(), al = this._alarm();
      const btEl = $("bedtime"), alEl = $("alarm");   // absent under v2 — its Home has no bedtime/alarm chips
      if (btEl) btEl.innerHTML = `${bt.t}<span class="ap">${bt.ap}</span>`;
      if (alEl) alEl.innerHTML = `${al.t}<span class="ap">${al.ap}</span>`;
      // sunrise badge on the alarm chip while the wake-up light alarm is enabled
      const wlFlag = $("alarmWl");
      if (wlFlag) {
        const wlOn = this._wakeLightOn();
        wlFlag.hidden = !wlOn;
        const ac = $("alarmChip"); if (ac) ac.classList.toggle("wl-on", wlOn);
      }
      // "On for" chip: hidden while the pod is off (or if the entity has no last_changed to go on)
      const osChip = $("onSinceChip");
      if (osChip) {
        const dur = on ? this._fmtOnSince() : "";
        osChip.style.display = dur ? "" : "none";
        if (dur) { const os = $("onSince"); if (os) os.textContent = dur; }
      }

      // bed glow: red above pivot, purple at pivot, blue below, grey off; pulse when working.
      const bedWrap = $("bed");
      const reactive = this._config.reactive_bed !== false;
      const bdir = reactive ? dir : "cool";   // reactive_bed:false forces always-blue
      bedWrap.classList.toggle("is-off", !on);
      bedWrap.classList.toggle("is-warm", on && bdir === "warm");
      bedWrap.classList.toggle("is-mid",  on && bdir === "mid");
      bedWrap.classList.toggle("is-cool", on && bdir === "cool");
      bedWrap.classList.toggle("is-working", working);
      bedWrap.style.setProperty("--es-wave-dur", waveDur);
      // dual bed: paint each half from its own side's climate (both halves visible when split so
      // the split reads at a glance); when solo both halves show this side = full bed. Highlight
      // the half currently being controlled.
      bedWrap.classList.toggle("is-dual", split);
      bedWrap.classList.toggle("no-motion", this._config.bed_motion === "off");
      this._paintBedHalves();
      const own = this._config.own_side === "right" ? "right" : "left";
      const activeHalf = !split ? "" : (viewingPartner ? (own === "left" ? "right" : "left") : own);
      const L = this.shadowRoot.querySelector(".half-left"), R = this.shadowRoot.querySelector(".half-right");
      if (L) L.classList.toggle("half-active", activeHalf === "left");
      if (R) R.classList.toggle("half-active", activeHalf === "right");

      // partner-side toggle
      const stRow = $("sideToggleRow");
      if (stRow) {
        const pOn = this._partnerOn();
        const sw = $("sideSwitch"); if (sw) sw.classList.toggle("on", pOn);
        stRow.classList.toggle("active", pOn);
      }

      // priming / water status light + green pumping animation
      const psRow = $("primeStatus");
      if (psRow) {
        const priming = this._primingOn(), need = this._needPriming(), water = this._hasWater();
        bedWrap.classList.toggle("is-priming", priming);
        let cls, txt;
        const hl = this._podHealth();
        if (hl && hl.tone !== "ok") { cls = hl.tone + (hl.pulse ? " pulse" : ""); txt = hl.text; }
        else if (priming) { cls = "ok pulse"; txt = "Priming…"; }
        else if (!water) { cls = "bad"; txt = "Add water"; }
        else if (need) { cls = "warn"; txt = "Needs priming"; }
        else { const ago = this._lastPrimeAgo(); cls = "ok"; txt = ago ? `Primed ${ago}` : "Ready"; }
        psRow.className = "prime-bar " + cls;
        const pt = $("psText"); if (pt) pt.textContent = txt;
        // water chip
        const wRow = $("psWater");
        if (wRow) {
          const hasWaterEnt = !!this._config.has_water_entity && this._stateStr(this._config.has_water_entity) !== "";
          wRow.style.display = hasWaterEnt ? "" : "none";
          wRow.classList.toggle("low", !water);
          const wt = $("psWaterTxt"); if (wt) wt.textContent = water ? "Water OK" : "Low";
        }
        // prime button while idle; cancel button while priming
        const pb = $("primeBtn");
        const canPrime = this._config.prime_button_entity !== false || this._config.prime_target_entity !== false;
        if (pb) { pb.hidden = priming || !canPrime; pb.textContent = need ? "Prime now" : "Prime"; }
        const cb = $("primeCancel");
        if (cb) cb.hidden = !priming;
      }
    }

    // ---- dial (present in both modes) ----
    $("overlay").classList.toggle("open", this._mode === "dial" ? true : this._open);
    $("powerDial").classList.toggle("on", on);
    $("ovSub").textContent = this._bedStatusText();

    let verb = "Set to";
    if (!on) verb = "Power off";
    else if (!working) verb = "Holding at";
    else verb = dir === "warm" ? "Heating to" : dir === "cool" ? "Cooling to" : "Set to";
    $("dcVerb").textContent = verb;
    const dcLevel = $("dcLevel");
    dcLevel.textContent = on ? this._fmtVal(tTemp) : "Off";
    dcLevel.classList.toggle("as-temp", this._useC());
    this._paint(dcLevel, on ? dir : null);
    const dcEta = on && working ? this._etaText() : "";
    $("dcNow").textContent = on ? `Currently at ${this._fmtVal(cTemp)}${dcEta ? ` · ${dcEta}` : ""}` : "Tap power to start";

    // gauge: knob at target, dash at current bed temp, coloured span between
    const g = this._gauge;
    const angOf = (t) => g.start + this._frac(t) * g.sweep;
    const tAng = angOf(tTemp), cAng = angOf(cTemp);
    const a0 = Math.min(tAng, cAng), a1 = Math.max(tAng, cAng);
    const fillEl = $("fill");
    fillEl.setAttribute("d", this._arcPath(g.cx, g.cy, g.r, a0, a1));
    fillEl.classList.toggle("warm", dir === "warm");
    fillEl.classList.toggle("mid", dir === "mid");
    fillEl.classList.toggle("cool", dir === "cool");
    fillEl.style.opacity = on && a1 - a0 > 0.5 ? "1" : "0";

    const [kx, ky] = this._polar(g.cx, g.cy, g.r, tAng);
    const knob = $("knob");
    knob.setAttribute("cx", kx); knob.setAttribute("cy", ky);
    knob.style.opacity = on ? "1" : "0.3";

    const [tx1, ty1] = this._polar(g.cx, g.cy, g.r - 11, cAng);
    const [tx2, ty2] = this._polar(g.cx, g.cy, g.r + 9, cAng);
    const ct = $("curtick");
    ct.setAttribute("x1", tx1); ct.setAttribute("y1", ty1);
    ct.setAttribute("x2", tx2); ct.setAttribute("y2", ty2);
    ct.style.opacity = on && Math.abs(tTemp - cTemp) > 0.4 ? "1" : "0";

    this._renderPresets();
    this._renderStatus(on, dir, working, bs);
    this._renderTimeline();
    this._renderStepRail();
    if (this._config.smart_entity) this._updateSmart();

    // ---- dual-side selector + panels ----
    // classic's + the dial's + v2's temp-tile You/Partner pill only appear once the bed is
    // actually split (they're a pure active-side selector). v2's (#sideSelTile) uses a class
    // instead of the hidden attribute so it can animate in/out — hidden means display:none,
    // which can't transition, so it would just pop instead of sliding in. #modeSelHd (the
    // Solo/Dual pill) is handled separately below: it's always visible, and "on" reflects the
    // split state, not the active side.
    this.shadowRoot.querySelectorAll(".side-sel").forEach((sel) => {
      if (sel.id === "modeSelHd") return;
      if (sel.id === "sideSelTile") sel.classList.toggle("shown", split);
      else sel.hidden = !split;
      sel.querySelectorAll("[data-side]").forEach((o) => o.classList.toggle("on", o.dataset.side === this._activeSide));
    });
    const modeSel = $("modeSelHd");
    if (modeSel) modeSel.querySelectorAll("[data-mode]").forEach((o) => o.classList.toggle("on", (o.dataset.mode === "dual") === split));
    // the tile pill's live-state dot on "Partner" — on/off, independent of which side you're
    // currently viewing, so switching back to "You" is never "losing" the partner's status
    const hdDot = $("sideSelTileDot"); if (hdDot) hdDot.classList.toggle("on", split);
    // the hairline divider between the pill and the bed/room stats — animates with the pill
    // instead of a bordered box
    const htDiv = $("htRDiv"); if (htDiv) htDiv.classList.toggle("shown", split);
    // classic's label sits in the same row the pill replaces when split; v2's "Target" label sits
    // in its own column now (.ht-l vs .ht-r), so it never needs to hide for this reason
    const tl = $("tileLabel"); if (tl) tl.hidden = this._layout === "v2" ? false : split;
    if ($("ovTitleText")) $("ovTitleText").textContent = viewingPartner ? `${this._config.partner_name || "Partner"}'s temperature` : "Your temperature";
    // Each side has its OWN Autopilot + schedule; the smart panel, manual schedule, and
    // bedtime/alarm strip now read the ACTIVE side's entities (via _sc), so they stay visible
    // for the partner too. Dim the manual panel while that side's autopilot is driving.
    const mp = $("manualPanel");
    if (mp) mp.classList.toggle("dimmed", !!this._sc("smart_entity") && this._smartOn());
    // auto-off row
    const aoRow = $("autoOffRow");
    if (aoRow) {
      const aoOn = this._autoOffOn();
      const sw = $("autoOffSwitch"); if (sw) sw.classList.toggle("on", aoOn);
      aoRow.classList.toggle("active", aoOn);
      const t = $("autoOffTime");
      const e = this._hass.states[this._sc("auto_off_entity")];
      const hm = e ? this._fmtHM(e.state) : null;
      if (t) t.textContent = hm ? hm.t + hm.ap : "Set time";
    }

    if (this._layout === "v2") { this._updateV2(); this._renderGlow(); }
  }

  /* ================= v2 layout: status line, boost row, mode toggle, next change, chip row ================= */
  // ===================================================================================
  // v2 Home — "Glow" (v10.14). The bed on a dark background whose glow (top-right corner)
  // takes the bed's state colour; a dedicated Temperature tile (a gauge per side with a
  // rounded handle + − / +); quick actions; live vitals only while someone's in bed
  // (Solo = your side, Dual = both); tonight's manual schedule chips or Autopilot's line.
  // Existing ids (#bed, #podPresets, #smartPanel/#smpHead/#smpSwitch/#smpLine, #homeLevel)
  // are kept so _update/_updateSmart/_renderPresets keep driving them unchanged.
  // ===================================================================================
  _glPolar(a) { const r = a * Math.PI / 180; return [85 + 72 * Math.sin(r), 88 - 72 * Math.cos(r)]; }
  _glArc(a0, a1) {
    const [x0, y0] = this._glPolar(a0), [x1, y1] = this._glPolar(a1);
    return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A 72 72 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  }
  _glowHomeHTML(primeBar) {
    const c = this._config;
    const track = this._glArc(-100, 100);
    const side = (key, name) => `
          <div class="gl-side" id="glSide_${key}" data-glside="${key}"${key === "partner" ? " hidden" : ""}>
            <button class="gl-side-hd" data-glsel="${key}"><i class="gl-dot"></i><span class="gl-name">${escapeHtml(name)}</span><span class="gl-word" id="glWord_${key}"></span></button>
            <div class="gl-gauge" data-glside="${key}">
              <svg viewBox="0 0 170 108" aria-hidden="true">
                <defs>
                  <linearGradient id="glGrad_${key}" gradientUnits="userSpaceOnUse" x1="14" y1="0" x2="156" y2="0"><stop offset="0" class="gl-s0"/><stop offset="1" class="gl-s1"/></linearGradient>
                  <filter id="glBlur_${key}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="5"/></filter>
                </defs>
                <path class="gl-track" d="${track}"/>
                <path class="gl-fillglow" id="glFillGlow_${key}" filter="url(#glBlur_${key})"/>
                <path class="gl-fill" id="glFill_${key}" stroke="url(#glGrad_${key})"/>
                <circle class="gl-knobglow" id="glKnobGlow_${key}" r="12" filter="url(#glBlur_${key})"/>
                <circle class="gl-knob" id="glKnob_${key}" r="9"/>
              </svg>
              <div class="gl-center"><span class="gl-num" id="glNum_${key}"></span><span class="gl-sub">Target</span></div>
            </div>
            <div class="gl-kv"><div><span>Bed now</span><b id="glBed_${key}">&ndash;</b></div><div><span>Room</span><b id="glRoom_${key}">&ndash;</b></div></div>
            <div class="gl-steps">
              <button class="circ gl-step" data-glbump="-1" data-glside="${key}" aria-label="Cooler">${V2_ICON_MINUS}</button>
              <span class="gl-bednow" id="glBedNow_${key}"></span>
              <button class="circ gl-step" data-glbump="1" data-glside="${key}" aria-label="Warmer">${V2_ICON_PLUS}</button>
            </div>
          </div>`;
    return `
        <div class="view-pod" id="viewPod">
        <div class="hr-host${c.fan_entity ? " has-fan" : ""}"${c.fan_entity ? ` style="--bed-shift:${c.bed_shift != null ? +c.bed_shift : 7}%"` : ""}>
          <div class="bed-wrap" id="bed"></div>
          ${c.fan_entity ? `<div class="es-fan" id="esFan" aria-label="Fan"></div>` : ""}
          ${c.headroom === false ? "" : `<button class="hr-edge" id="hrEdge" hidden aria-label="Cooling headroom">
            <i class="hr-track"></i><i class="hr-fill" id="hrFill"></i><i class="hr-floor"></i>
            <span class="hr-txt"><b id="hrVal"></b><em id="hrWord"></em></span>
          </button>`}
        </div>
        ${primeBar}
        <span class="big-level" id="homeLevel" hidden><span class="bl-main" id="homeLevelMain"></span></span>
        <div class="gl-tile gl-temp" id="glTemp">
          <div class="gl-row gl-temp-hd" id="glTempHd"><span class="gl-lbl">Temperature</span>${c.wake_pill === false ? "" : `<button class="gl-wake" id="glWake" hidden aria-label="Wake-up time"></button>`}<span class="gl-chip" id="glState"></span></div>
          <div class="gl-sides">${side("self", c.own_label || "You")}${c._partnerUi ? side("partner", c.partner_name || "Partner") : ""}</div>
        </div>
        <div class="presets quick no-temps" id="podPresets"></div>
        <div class="gl-tile gl-vitals" id="glVitals" hidden></div>
        <div class="gl-tile gl-sched" id="smartPanel">
          <div class="gl-row gl-sched-hd">
            <span class="gl-lbl" id="glSchedLbl">Schedule</span>
            <span class="gl-schsub" id="glSchedSub"></span>
            ${c.smart_entity ? `<button class="gl-aptog" id="smpHead" aria-label="Autopilot"><span class="gl-aplbl">Autopilot</span><span class="smp-sug" id="smpSug" hidden></span><span class="smart-switch" id="smpSwitch" role="switch">${SW_GLASS}<span class="sk">${SW_GLASS}</span></span></button>` : ""}
          </div>
          <div class="smp-flash" id="smpFlash" hidden></div>
          <div id="glSchedBody"></div>
          ${c.smart_entity ? `<button class="gl-why" id="smpLine" hidden><span class="sl-txt" id="smpLineTxt"></span><span class="sl-chev">${V2_ICON_CHEVR}</span></button>` : ""}
        </div>
        </div>`;
  }
  // everything a side's gauge needs; the ACTIVE side reads the optimistic state (drag/override)
  _glVis(side) {
    const ent = side === "partner" ? this._config.partner_climate_entity : this._config.entity;
    const active = (side === "partner") === this._viewingPartner();
    if (active) {
      const on = this._effectiveOn();
      return { active, on, dir: this._dir(), working: on && this._working(), tgt: this._tgtTemp(), cur: this._curTemp() };
    }
    const sv = this._sideVisual(ent);
    const a = ((this._hass.states[ent] || {}).attributes) || {};
    const { min, max } = this._range();
    return { active, on: sv.on, dir: sv.dir, working: sv.working,
      tgt: Number.isFinite(a.temperature) ? a.temperature : (min + max) / 2,
      cur: Number.isFinite(a.current_temperature) ? a.current_temperature : NaN };
  }
  _glPal(v) { if (this._xrOn() && v && v.on && v.dir !== "warm" && v.dir !== "cool") return XR_MID; return !v || !v.on ? GLOW_PAL.off : GLOW_PAL[v.dir === "warm" ? "warm" : v.dir === "cool" ? "cool" : "mid"]; }
  _glWord(v) {
    if (!v || !v.on) return "Off";
    if (v.working) return v.dir === "warm" ? "Heating" : v.dir === "cool" ? "Cooling" : "Adjusting";
    return "Holding";
  }
  _glPaintGauge(key, temp, on) {
    const $ = (id) => this.shadowRoot.getElementById(id);
    const fill = $("glFill_" + key);
    if (!fill) return;
    const a = -100 + this._frac(temp) * 200;
    const d = a > -99.5 ? this._glArc(-100, a) : "";
    if (fill.__d !== d) {
      fill.__d = d; fill.setAttribute("d", d);
      const g = $("glFillGlow_" + key); if (g) g.setAttribute("d", d);
    }
    const [x, y] = this._glPolar(a);
    [$("glKnob_" + key), $("glKnobGlow_" + key)].forEach((el) => { if (el) { el.setAttribute("cx", x.toFixed(1)); el.setAttribute("cy", y.toFixed(1)); } });
    const gr = $("glGrad_" + key); if (gr) gr.setAttribute("x2", Math.max(30, x).toFixed(1));
    const n = $("glNum_" + key); if (n) n.textContent = on ? this._fmtVal(temp) : "Off";
  }
  // room reading for the Solo stats column: temperature, humidity as its own small line
  _glRoomText() {
    const rt = this._config.room_temp_entity ? this._stateStr(this._config.room_temp_entity) : "";
    const rh = this._config.room_humidity_entity ? this._stateStr(this._config.room_humidity_entity) : "";
    const t = rt !== "" && !isNaN(parseFloat(rt)) ? `${Math.round(parseFloat(rt))}°` : "";
    const h = rh !== "" && !isNaN(parseFloat(rh)) ? `${Math.round(parseFloat(rh))}%` : "";
    return t || h ? { t: t || "–", h } : null;
  }
  // −/+ on a side: make that side the controlled one, then step it
  _glBump(side, delta) {
    if (side === "partner" && !this._partnerOn()) return;
    if ((side === "partner") !== this._viewingPartner()) this._setActiveSide(side);
    this._bump(delta);
  }
  // drag the rounded handle round the gauge. The centre (the number) is not a drag target, and
  // synthetic pointer events are ignored (the kiosk's phantom-write-on-load bug).
  _wireGlowGauge(el) {
    if (!el || el.__glWired) return;
    el.__glWired = true;
    const side = el.dataset.glside;
    let dragging = false, lastV = null, rect = null, lastHap = 0;
    const geo = (e) => { const r = rect || (rect = el.getBoundingClientRect()); return { x: (e.clientX - r.left) / r.width * 170, y: (e.clientY - r.top) / r.height * 108 }; };
    const at = (p) => {
      let deg = Math.atan2(p.y - 88, p.x - 85) * 180 / Math.PI + 90;
      if (deg > 180) deg -= 360;
      const frac = Math.max(0, Math.min(1, (deg + 100) / 200));
      const { min, max, step } = this._range();
      return Math.max(min, Math.min(max, Math.round((min + frac * (max - min)) / step) * step));
    };
    const tick = () => { const t = Date.now(); if (t - lastHap < 45) return; lastHap = t; this._haptic("light"); };
    el.style.touchAction = "none";
    el.addEventListener("pointerdown", (e) => {
      if (!e.isTrusted) return;
      rect = el.getBoundingClientRect();
      const p = geo(e);
      if (Math.hypot(p.x - 85, p.y - 88) < 44) { rect = null; return; }
      if (side === "partner" && !this._partnerOn()) { rect = null; return; }
      if ((side === "partner") !== this._viewingPartner()) this._setActiveSide(side);
      dragging = true;
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      this._ensureOn();
      this._disableSmartForManual();
      const v = at(p); lastV = v; this._overrideTemp = v; this._dragMode(true); this._update(); tick();
      e.preventDefault(); e.stopPropagation();
    });
    el.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const v = at(geo(e));
      if (v !== lastV) { lastV = v; this._overrideTemp = v; this._dragPaint(v); tick(); }
    });
    const end = () => { if (!dragging) return; dragging = false; rect = null; this._dragMode(false); if (lastV != null) this._setTemp(lastV); this._update(); };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }
  /* ---------- Thermal headroom (v10.34, design/thermal-headroom E3) ----------
     The Pod cools by pumping heat from the water into the room, and there's a limit to how far
     below the room it can pull the water. From this Pod's own history (11 nights, 2026-09-15..26)
     the water settled at best ~5.0°C below room at full effort, even at 30°C. So:
       lowest reachable ≈ room − headroom_dt,   headroom = target − lowest.
     Heating has far more reach (to 45°C), so this only speaks while the bed is on and cooling
     (target below room). null = nothing to show. */
  _headroom() {
    const c = this._config, S = this._hass && this._hass.states;
    if (!S || c.headroom === false || !this._effectiveOn()) return null;
    const rid = c.headroom_room_entity || c.room_temp_entity;
    const room = rid ? parseFloat(S[rid] && S[rid].state) : NaN;
    const tgt = this._tgtTemp();
    if (!Number.isFinite(room) || !Number.isFinite(tgt) || tgt >= room) return null;
    const dT = Number(c.headroom_dt) > 0 ? Number(c.headroom_dt) : 5.0;
    const floor = Math.round((room - dT) * 10) / 10, head = Math.round((tgt - floor) * 10) / 10;
    const tone = head >= 1.5 ? "ok" : head >= 0 ? "warn" : "bad";
    return { room, dT, floor, tgt, head, tone, frac: Math.max(0, Math.min(1, head / dT)),
      word: head >= 1.5 ? "Comfortable" : head >= 0 ? "Tight" : "Out of reach" };
  }

  // headroom numbers are real °C (and differences of them) whatever the card's display units
  _hrC(n) { return `${Math.round(n * 10) / 10}\u00b0`; }

  _renderHeadroom() {
    const el = this.shadowRoot.getElementById("hrEdge");
    if (!el) return;
    const h = this._headroom();
    const sig = h ? `${h.tone}|${h.head}|${h.frac.toFixed(2)}` : "none";
    if (this._hrSig === sig) return;
    this._hrSig = sig;
    el.hidden = !h;
    if (!h) return;
    el.className = `hr-edge ${h.tone}`;
    el.style.setProperty("--hr-frac", h.frac.toFixed(3));
    const v = this.shadowRoot.getElementById("hrVal"), w = this.shadowRoot.getElementById("hrWord");
    if (v) v.textContent = `${h.head < 0 ? "\u2212" : ""}${this._hrC(Math.abs(h.head))}`;
    if (w) w.textContent = h.head < 0 ? "short" : "spare";
  }

  _openHeadroom() {
    const h = this._headroom();
    const ov = this.shadowRoot.getElementById("pickerOverlay");
    if (!h || !ov) return;
    this._haptic("light");
    clearTimeout(this._pkModeTimer);
    const f = (n) => this._hrC(n);
    const tone = { ok: "51,209,122", warn: "255,176,32", bad: "255,90,82" }[h.tone];
    const row = (lbl, sub, val) => `<div class="hr-row"><span><b>${lbl}</b><i>${sub}</i></span><em>${val}</em></div>`;
    ov.querySelector(".pk-sheet").innerHTML = `
      <div class="pk-confirm-badge" style="--pk-accent:95,168,255">${GLOW_ICON_PRECOOL}</div>
      <div class="pk-title pk-confirm-title">Cooling headroom</div>
      <div class="hr-big" style="--hr-rgb:${tone}"><b>${h.head < 0 ? "\u2212" : ""}${escapeHtml(f(Math.abs(h.head)))}</b><span>${h.word}</span></div>
      <div class="pk-msg">The Pod cools by pumping heat out of the water into your room. The warmer the room, the less it can take out, so there's a floor it can't go below.</div>
      <div class="hr-rows">
        ${row("Air at the Pod", "what its heatsink dumps heat into", escapeHtml(f(h.room)))}
        ${row("Most it can cool", "below that air, from your nights", escapeHtml(f(h.dT)))}
        ${row("Lowest tonight", "that air minus the limit", "\u2248 " + escapeHtml(f(h.floor)))}
        ${row("Your target", h.head < 0 ? "below what it can reach" : `${escapeHtml(f(h.head))} above the floor`, escapeHtml(f(h.tgt)))}
      </div>
      <div class="pk-msg hr-tip">${h.head < 0
        ? `It'll get as close as it can (about ${escapeHtml(f(h.floor))}). Cooler air around the Pod is the only way lower.`
        : "Every degree cooler around the Pod is about a degree more headroom."}</div>
      <div class="pk-actions"><button class="pk-btn save" data-act="ok">Got it</button></div>`;
    ov.querySelector(".pk-sheet").onclick = (e) => { if (e.target.closest("[data-act]")) { e.stopPropagation(); this._closePicker(); } };
    ov.onclick = (e) => { if (e.target === ov && !this._swallowHoldRelease()) this._closePicker(); };
    ov.classList.remove("modal");
    ov.classList.add("confirm");
    void ov.offsetHeight;
    ov.classList.add("open");
  }

  /* ---------- Wake-up pill (v10.36, design/wake-pill — option A + shield) ----------
     Beside the Temperature tile's state chip: tomorrow's wake time in Glow's schedule lilac.
     The Coach shield replaces the clock while the Coach is armed for the morning; plain grey
     clock when it isn't; amber "Get up" pulse while the wake-up is running (then it takes the
     label's place, the Heating chip being wide). Tap -> the wake-up sheet. The time is the
     Coach's wake target, which mirrors the Schedule routine (HA sync automation, 2026-09-26). */
  _wakeInfo() {
    const S = this._hass && this._hass.states;
    if (!S) return null;
    const hasCoach = !!this._cchSt("coach");
    let wake = null, entity = null;
    if (hasCoach) {
      const T = this._cchTargets();
      wake = T.wake;
      entity = this._cchE(T.weekend ? "target_wake_weekend" : "target_wake");
    } else {
      entity = `input_datetime.${this._config.schedule_prefix || "eight_sleep_me"}_wake`;
      const hm = S[entity] && this._fmtHM(S[entity].state);
      wake = hm ? hm.mins : null;
    }
    if (wake == null) return null;
    const status = hasCoach ? this._cchStatus() : "";
    const strength = hasCoach ? this._cchStrength() : "Off";
    const armed = hasCoach && this._cchBool("coach") && !this._cchBool("coach_off_tonight")
      && strength !== "Off" && status !== "away" && status !== "off";
    const now = this._cchNowMins();
    const waking = status === "waking";
    const until = (wake - now + 1440) % 1440;
    return { wake, entity, hasCoach, armed, waking, strength, until, late: Math.max(0, (now - wake + 1440) % 1440) };
  }

  _renderWakePill() {
    const el = this.shadowRoot.getElementById("glWake");
    if (!el) return;
    const w = this._wakeInfo();
    const hd = this.shadowRoot.getElementById("glTempHd");
    const sig = w ? `${w.wake}|${w.armed}|${w.waking}|${w.waking ? Math.floor(w.late / 1) : ""}` : "none";
    if (this._wakeSig !== sig) {
      this._wakeSig = sig;
      el.hidden = !w;
      if (hd) hd.classList.toggle("waking", !!(w && w.waking));
      if (w) {
        el.className = "gl-wake" + (w.waking ? " waking" : w.armed ? " armed" : " plain");
        const icon = w.armed || w.waking ? V2_ICON_COACH : V2_ICON_ALARM;
        const txt = w.waking ? (w.late > 0 && w.late < 180 ? `Get up \u00b7 ${w.late} min` : "Get up") : this._cchClockPlain(w.wake);
        el.innerHTML = `${icon}<span>${escapeHtml(txt)}</span>`;
        el.setAttribute("aria-label", w.armed ? `Wake-up ${txt}, Coach on` : `Wake-up ${txt}`);
      }
    }
    if (this._wakeOpen) this._renderWakeSheet();
  }

  _openWake() {
    const ov = this.shadowRoot.getElementById("pickerOverlay");
    if (!ov || !this._wakeInfo()) return;
    this._haptic("light");
    clearTimeout(this._pkModeTimer);
    this._wakeOpen = true;
    this._wakeSheetSig = null;
    const sheet = ov.querySelector(".pk-sheet");
    sheet.onclick = (e) => {
      const b = e.target.closest("[data-wk]");
      if (!b) return;
      e.stopPropagation();
      const [act, arg] = b.dataset.wk.split(":");
      const w = this._wakeInfo();
      if (act === "done") { this._closeWake(); return; }
      if (act === "time") { this._closeWake(); if (w) this._openPicker("time", w.entity, "Up at"); return; }
      if (act === "str") { this._haptic("light"); this._cchSetStrength(arg); }
      if (act === "tg") { this._haptic("light"); this._cchToggle(arg); }
      if (act === "coach") { this._haptic("light"); this._cchToggle("coach"); }
      setTimeout(() => { this._wakeSheetSig = null; this._renderWakeSheet(); }, 350);
    };
    ov.onclick = (e) => { if (e.target === ov && !this._swallowHoldRelease()) this._closeWake(); };
    ov.classList.remove("modal");
    ov.classList.add("confirm");
    void ov.offsetHeight;
    ov.classList.add("open");
    this._renderWakeSheet();          // after "open": the renderer treats a closed overlay as dismissed
  }
  _closeWake() { this._wakeOpen = false; this._closePicker(); }

  _renderWakeSheet() {
    const ov = this.shadowRoot.getElementById("pickerOverlay");
    const w = this._wakeInfo();
    if (!ov || !w || !ov.classList.contains("open")) { this._wakeOpen = false; return; }
    const on = (k) => this._cchBool(k);
    const rows = [
      ["wake_heat", GLOW_ICON_BOOST, "255,138,90", "Warm the bed", `${this._cchClockPlain((w.wake - 20 + 1440) % 1440)} \u00b7 toward your wake temperature`],
      [null, CCH_ICONS.sun, "255,176,32", "Sunrise lamp", this._wakeLightOn() ? `${this._cchClockPlain((w.wake - 15 + 1440) % 1440)} \u00b7 ${escapeHtml(this._wakeLightName() || "bedside lamp")}` : "Off \u2014 switch it on from Schedule"],
      ["wake_vibrate", CCH_ICONS.wave, "183,155,255", "Vibrate", `${this._cchClockPlain(w.wake)} \u00b7 30 s on your side`],
      ["wake_phone", CCH_ICONS.phone, "95,168,255", "Phone alert", `${this._cchClockPlain(w.wake)} \u00b7 time-sensitive`],
    ].filter(([k]) => k === null || !!this._cchSt(k));
    const sig = JSON.stringify([w, rows.map(([k]) => k && on(k)), this._wakeLightOn()]);
    if (this._wakeSheetSig === sig) return;
    this._wakeSheetSig = sig;
    const d = new Date(this._cchNow().getTime() + w.until * 60000);
    const day = d.toLocaleDateString([], { weekday: "long" });
    const clock = this._cchClockPlain(w.wake), m = clock.match(/^(.*?)\s*(am|pm)$/i);
    const tg = (v) => `<span class="cch-tg${v ? " on" : ""}"><i></i></span>`;
    const body = !w.hasCoach ? "" : `
      <div class="slp-seg wide wk-seg">${["Off", "Gentle", "Firm", "Relentless"].map((o) =>
        `<button class="slp-opt${o === w.strength ? " on" : ""}" data-wk="str:${o}">${o}</button>`).join("")}</div>
      <div class="wk-rows">${rows.map(([k, ic, rgb, t, sub]) => `
        <${k ? `button class="wk-row" data-wk="tg:${k}"` : `div class="wk-row"`}>
          <span class="wk-ic" style="--wk-rgb:${rgb}">${ic}</span>
          <span class="wk-t"><b>${t}</b><i>${sub}</i></span>
          ${k ? tg(on(k)) : ""}
        </${k ? "button" : "div"}>`).join("")}</div>`;
    ov.querySelector(".pk-sheet").innerHTML = `
      <div class="wk-sheet">
        <div class="wk-hd"><span class="gl-lbl wk-lbl">Wake-up \u00b7 ${escapeHtml(day)}</span>
          ${w.hasCoach ? `<button class="wk-coach${w.armed ? " on" : ""}" data-wk="coach">${V2_ICON_COACH}${w.armed ? "Coach on" : "Coach off"}</button>` : ""}</div>
        <div class="wk-time"><b>${escapeHtml(m ? m[1] : clock)}</b><span>${escapeHtml(m ? m[2] : "")}</span>
          <em>in ${Math.floor(w.until / 60)}h ${String(w.until % 60).padStart(2, "0")}m</em></div>
        <div class="wk-sub">${w.hasCoach ? `${this._cchWeekend() ? "Weekend" : "Weekday"} routine \u00b7 change it in Schedule and the Coach follows` : "Your schedule's wake time"}</div>
        ${body}
        <div class="wk-acts">
          <button class="pk-btn ghost" data-wk="time">Edit time</button>
          <button class="pk-btn save" data-wk="done">${GLOW_ICON_CHECK}Done</button>
        </div>
      </div>`;
  }

  _renderGlow() {
    this._renderHeadroom();
    this._renderWakePill();
    const $ = (id) => this.shadowRoot.getElementById(id);
    const root = $("podRoot");
    if (!root || !root.classList.contains("glow") || !this._hass) return;
    const c = this._config;
    // bottom_chrome (px): a host footer that floats over the page bottom — e.g. the HA dashboard's
    // navbar. Shortens v2 and lifts its own tab bar above it (see .v2home / .tabbar).
    this._sty(this, "--v2-bottom-chrome", (this._xrOn() && this._xrNavBottom != null ? this._xrNavBottom : (Number(c.bottom_chrome) || 0)) + "px");
    const dual = !!c._partnerUi && this._partnerOn();
    const vs = this._glVis("self"), vp = dual ? this._glVis("partner") : null;
    const ps = this._glPal(vs), pp = vp ? this._glPal(vp) : ps;
    this._sty(root, "--gl-rgb", ps.rgb); this._sty(root, "--gl-acc", ps.acc); this._sty(root, "--gl-hi", ps.hi);
    this._sty(root, "--gl-rgb2", pp.rgb);
    root.classList.toggle("gl-dual", dual);
    const temp = $("glTemp"); if (temp) temp.classList.toggle("dual", dual);
    const pSide = $("glSide_partner"); if (pSide) pSide.hidden = !dual;
    const room = this._glRoomText();
    [["self", vs, ps], ["partner", vp, pp]].forEach(([key, v, p]) => {
      const el = $("glSide_" + key);
      if (!el || !v) return;
      this._sty(el, "--s-rgb", p.rgb); this._sty(el, "--s-acc", p.acc); this._sty(el, "--s-hi", p.hi); this._sty(el, "--s-lo", p.lo);
      el.classList.toggle("off", !v.on);
      el.classList.toggle("active", dual && v.active);
      this._glPaintGauge(key, v.tgt, v.on);
      const w = $("glWord_" + key); if (w) w.textContent = this._glWord(v);
      const bed = Number.isFinite(v.cur) ? this._fmtVal(v.cur) : "–";
      const b = $("glBed_" + key); if (b) b.textContent = bed;
      const bn = $("glBedNow_" + key); if (bn) bn.textContent = Number.isFinite(v.cur) ? `bed ${bed}` : "";
      const rm = $("glRoom_" + key);
      if (rm) { const rh = room ? `${room.t}${room.h ? `<i>${room.h} humidity</i>` : ""}` : "–"; if (rm.__h !== rh) { rm.__h = rh; rm.innerHTML = rh; } }
    });
    const chip = $("glState");
    if (chip) {
      chip.hidden = dual;
      const word = this._glWord(vs);
      const icon = !vs.on ? V2_ICON_POWER : word === "Holding" ? GLOW_ICON_HOLD : vs.dir === "warm" ? V2_ICON_FLAME : vs.dir === "cool" ? V2_ICON_SNOW : GLOW_ICON_HOLD;
      let eta = vs.on && vs.working ? String(this._etaText() || "") : "";
      eta = eta.replace(/\s*to target.*$/i, "");
      const html = `${icon}<span>${escapeHtml(word)}${eta ? " · " + escapeHtml(eta) : ""}</span>`;
      if (chip.__h !== html) { chip.__h = html; chip.innerHTML = html; }
    }
    const panel = $("smartPanel");
    if (panel) { const ap = this._viewingPartner() ? pp : ps; this._sty(panel, "--s-acc", ap.acc); this._sty(panel, "--s-rgb", ap.rgb); }
    if (this._xrOn()) this._xrRender(dual, vs, vp, ps, pp);
    this._renderGlowVitals(dual);
    this._renderGlowSched(dual);
  }
  // rolling per-metric samples kept in memory while the card is open (≤45 min, 1/min)
  _glSample(key, v) {
    const H = this._glHist || (this._glHist = {});
    const a = H[key] || (H[key] = []);
    const now = Date.now();
    if (!a.length || now - a[a.length - 1].t >= 60000) a.push({ t: now, v }); else a[a.length - 1].v = v;
    while (a.length > 45) a.shift();
  }
  _glSpark(arr, col) {
    if (!arr || arr.length < 2)
      return `<svg viewBox="0 0 100 26" preserveAspectRatio="none"><line x1="0" y1="13" x2="100" y2="13" stroke="rgba(255,255,255,0.14)" stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/></svg>`;
    const vals = arr.map((o) => o.v);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (hi - lo < 1) { lo -= 0.5; hi += 0.5; }
    const pts = arr.map((o, i) => `${(i / (arr.length - 1) * 100).toFixed(1)},${(23 - (o.v - lo) / (hi - lo) * 20).toFixed(1)}`).join(" ");
    return `<svg viewBox="0 0 100 26" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
  }
  _renderGlowVitals(dual) {
    const box = this.shadowRoot.getElementById("glVitals");
    if (!box) return;
    const c = this._config, S = this._hass.states;
    // the local tap reports 0 when it has no lock on a signal — treat that as "no reading"
    const read = (id) => { const st = id && S[id]; const v = st ? parseFloat(st.state) : NaN; return Number.isFinite(v) && v > 0 ? v : null; };
    const side = (key) => {
      const p = key === "partner" ? "partner_" : "";
      const pe = c[p + "presence_entity"], pst = pe && S[pe];
      const present = !!pst && pst.state === "on";
      const since = present && pst.last_changed ? Math.max(0, (Date.now() - Date.parse(pst.last_changed)) / 1000) : null;
      const m = { hr: read(c[p + "heart_rate_entity"]), br: read(c[p + "breath_rate_entity"]), hrv: read(c[p + "hrv_entity"]) };
      return { key, has: !!pe, present, since, m, name: key === "partner" ? (c.partner_name || "Partner") : (c.own_label || "You") };
    };
    let me = side("self");
    const pa = c.partner_presence_entity ? side("partner") : null;
    // Solo: the whole bed is yours, so whichever half senses you (and has a reading) is "you" —
    // the firmware's left/right don't reliably match where you lie
    if (!dual && pa) {
      me = { ...me, has: me.has || pa.has, present: me.present || pa.present,
        since: me.present ? me.since : pa.since,
        m: { hr: me.m.hr != null ? me.m.hr : pa.m.hr, br: me.m.br != null ? me.m.br : pa.m.br, hrv: me.m.hrv != null ? me.m.hrv : pa.m.hrv } };
    }
    const show = me.has && (dual ? (me.present || (pa && pa.present)) : me.present);
    box.hidden = !show;
    if (!show) { box.__h = ""; return; }
    (dual ? [me, pa] : [me]).forEach((sd) => { if (sd && sd.present) ["hr", "br", "hrv"].forEach((k) => { if (sd.m[k] != null) this._glSample(sd.key + k, sd.m[k]); }); });
    const H = this._glHist || {};
    const fmt = (v, dp) => v == null ? "–" : (dp ? v.toFixed(dp) : String(Math.round(v)));
    let html;
    if (!dual) {
      const any = me.m.hr != null || me.m.br != null || me.m.hrv != null;
      const met = (k, col, unit, lbl, dp) => `<div class="gl-met">${this._glSpark(H["self" + k], col)}<b>${fmt(me.m[k], dp)}<small>${unit}</small></b><span>${lbl}</span></div>`;
      html = `<div class="gl-row"><span class="gl-lbl">Live vitals</span><span class="gl-live"><i></i>In bed${me.since != null && me.since >= 60 ? " " + escapeHtml(this._fmtDur(Math.floor(me.since / 60) * 60)) : ""}</span></div>`
        + (any ? `<div class="gl-v3">${met("hr", "#ff7f95", "bpm", "Heart rate")}${met("br", "#7fd0ff", "/min", "Breathing", 1)}${met("hrv", "#b99bff", "ms", "HRV")}</div>`
               : `<div class="gl-vwait">Waiting for the first reading — lie still for a minute or two.</div>`);
    } else {
      const col = (sd) => `<div class="gl-vcol${sd.key === "partner" ? " p" : ""}${sd.present ? "" : " absent"}">
          <div class="gl-row"><i class="gl-vdot"></i><span class="gl-vname">${escapeHtml(sd.name)}</span>${sd.present ? `<span class="gl-live"><i></i>Live</span>` : `<span class="gl-vabs">Not in bed</span>`}</div>
          <div class="gl-vhr"><span class="gl-vheart">${GLOW_ICON_HEART}</span><b>${sd.present ? fmt(sd.m.hr) : "–"}<small>bpm</small></b></div>
          <div class="gl-vr"><span>Breathing</span><b>${sd.present ? fmt(sd.m.br, 1) : "–"}<small>/min</small></b></div>
          <div class="gl-vr"><span>HRV</span><b>${sd.present ? fmt(sd.m.hrv) : "–"}<small>ms</small></b></div>
        </div>`;
      html = `<div class="gl-row"><span class="gl-lbl">Live vitals</span></div><div class="gl-v2">${col(me)}${col(pa || side("partner"))}</div>`;
    }
    if (box.__h !== html) { box.__h = html; box.innerHTML = html; }
  }
  _renderGlowSched(dual) {
    const $ = (id) => this.shadowRoot.getElementById(id);
    const body = $("glSchedBody");
    if (!body) return;
    const smart = !!this._sc("smart_entity") && this._smartOn();
    const lbl = $("glSchedLbl"); if (lbl) lbl.textContent = smart ? "Autopilot" : "Schedule";
    const sub = $("glSchedSub");
    if (sub) {
      const who = dual ? (this._viewingPartner() ? (this._config.partner_name || "Partner") : (this._config.own_label || "You")) + " · " : "";
      sub.textContent = who + (smart ? "tonight's plan" : "manual");
    }
    const line = $("smpLine"); if (line) line.hidden = !smart;
    let html = "";
    try { html = smart ? this._glAutoHTML() : this._glManualHTML(); } catch (e) { html = ""; }
    if (body.__h !== html) { body.__h = html; body.innerHTML = html; }
  }
  _glManualHTML() {
    const st = this._hass.states, useC = this._useC(), now = this._nowMins(), mid = this._midTemp();
    const cols = this._phases().map((p) => {
      const ent = st[p.level_entity];
      const raw = ent && ent.state !== "unknown" && ent.state !== "unavailable" ? parseFloat(ent.state) : NaN;
      const val = Number.isFinite(raw) ? raw : (useC ? p.defC : p.defLvl);
      const te = st[p.time_entity];
      const hm = this._fmtHM(te ? te.state : p.defTime) || this._fmtHM(p.defTime) || { mins: 0, t: "", ap: "" };
      const cls = !useC ? (val < 0 ? "cool" : val > 0 ? "warm" : "neutral") : (val > mid + 0.3 ? "warm" : val < mid - 0.3 ? "cool" : "neutral");
      return { p, hm, cls, disp: useC ? Math.round(val) + "°" : this._fmtLevel(Math.round(val)) };
    });
    if (!cols.length) return "";
    let active = 0, best = Infinity;
    cols.forEach((cc, i) => { const d = (now - cc.hm.mins + 1440) % 1440; if (d < best) { best = d; active = i; } });
    return `<div class="gl-pchips" style="grid-template-columns:repeat(${cols.length},minmax(0,1fr))">`
      + cols.map((cc, i) => `<button class="gl-pchip${i === active ? " on" : ""}" data-glstep="${cc.p.key}" data-label="${escapeHtml(cc.p.label)}"><b class="${cc.cls}">${cc.disp}</b><span>${cc.hm.t}${cc.hm.ap}</span></button>`).join("")
      + `</div>`;
  }
  _glAutoHTML() {
    const segs = this._smartSegments();
    if (!segs || segs.length < 2) return "";
    const last = segs[segs.length - 1];
    const span = last.rel + 90;
    const N = 64, W = 360, H = 54;
    const ts = [];
    for (let i = 0; i <= N; i++) ts.push(this._smartTempAtRel(span * i / N, segs));
    let lo = Math.min(...ts), hi = Math.max(...ts);
    if (hi - lo < 2) { lo -= 1; hi += 1; }
    const Y = (t) => 6 + (hi - t) / (hi - lo) * (H - 12);
    const d = ts.map((t, i) => `${i ? "L" : "M"} ${(i / N * W).toFixed(1)} ${Y(t).toFixed(1)}`).join(" ");
    const bt = segs[0].mins;
    const hm = (rel) => { const m = Math.round(bt + rel) % 1440; const h = this._fmtHM(String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0")); return h ? h.t + h.ap : ""; };
    const tmin = Math.min(...ts), ci = ts.indexOf(tmin);
    const nowRel = ((this._nowMins() - bt) % 1440 + 1440) % 1440;
    const dot = nowRel <= span ? `<i class="gl-cnow" style="left:${(nowRel / span * 100).toFixed(1)}%;top:${Y(this._smartTempAtRel(nowRel, segs)).toFixed(1)}px"></i>` : "";
    return `<div class="gl-curve" data-glauto="1"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path class="gl-cglow" d="${d}"/><path class="gl-cline" d="${d}"/></svg>${dot}</div>`
      + `<div class="gl-cax"><span>${hm(0)}</span><span>Coolest ${this._fmtVal(tmin)} · ${hm(span * ci / N)}</span><span>${hm(last.rel)}</span></div>`;
  }

  _updateV2() {
    const $ = (id) => this.shadowRoot.getElementById(id);
    const root = $("podRoot");
    const on = this._effectiveOn();
    const dir = this._dir();
    const working = on && this._working();
    const smartOn = !!this._sc("smart_entity") && this._smartOn();
    const boost = this._boostActive(this._activeEntity());

    if (root) root.dataset.mode = smartOn ? "auto" : "manual";
    const mode = $("v2Mode");
    if (mode) mode.querySelectorAll("[data-v2mode]").forEach((o) =>
      o.classList.toggle("on", (o.dataset.v2mode === "auto") === smartOn));

    // boost buttons: reflect the running boost (label + active state)
    const bz = $("v2Boost");
    if (bz) bz.querySelectorAll("[data-boost]").forEach((b) => {
      const active = !!boost && boost.dir === b.dataset.boost;
      b.classList.toggle("on", active);
      const label = b.dataset.boost === "warm" ? "Warm boost" : "Cool boost";
      const span = b.querySelector("span");
      if (span) span.textContent = active ? `${label} · ${this._boostRemainingLabel(boost)}` : label;
    });

    // status line — one plain sentence for what's driving the bed right now
    const st = $("v2Status");
    if (st) {
      let cls = dir, main, sub = "";
      if (boost) {
        cls = boost.dir === "warm" ? "warm" : "cool";
        main = boost.dir === "warm" ? "Boost · maximum heat" : "Boost · cooling hard";
        sub = `${this._boostRemainingLabel(boost)} left, then ${smartOn ? "Autopilot resumes" : "reverts"}`;
      } else if (!on) {
        cls = "neutral"; main = "Bed is off";
        sub = this._autoOffOn() ? "auto-off is scheduled" : "";
      } else if (smartOn) {
        const sug = this._fmtVal(this._suggested());
        const verb = working ? (dir === "warm" ? "warming to" : dir === "cool" ? "cooling to" : "holding at") : "set to";
        main = `Autopilot · ${verb} ${sug}`;
        const ph = this._phaseAt(this._nowMins());
        sub = ph && ph.name ? `${ph.name.toLowerCase()} phase` : "";
      } else {
        const verb = working ? (dir === "warm" ? "warming to" : dir === "cool" ? "cooling to" : "holding at") : "set to";
        main = `Manual · ${verb} ${this._fmtVal(this._tgtTemp())}`;
      }
      this._paint(st, cls);
      st.innerHTML = `<span class="v2s-main">${escapeHtml(main)}</span>${sub ? `<span class="v2s-sub">${escapeHtml(sub)}</span>` : ""}`;
    }

    // next scheduled change (Autopilot only)
    const nx = $("v2Next");
    if (nx) {
      let row = null;
      if (smartOn) { try { row = this._upcomingChanges()[0] || null; } catch (e) { row = null; } }
      if (row) {
        const hm = this._fmtHM(String(Math.floor(row.mins / 60)).padStart(2, "0") + ":" + String(row.mins % 60).padStart(2, "0"));
        nx.hidden = false;
        nx.innerHTML = `<span class="v2n-l">Next</span><span class="v2n-b">${escapeHtml(row.label)} ${this._fmtVal(row.temp)}</span><span class="v2n-t">${hm ? hm.t + hm.ap : ""}</span>`;
      } else nx.hidden = true;
    }

    // chip row — priming / water / partner / auto-off, replacing the info strip + prime bar + side toggle
    const ch = $("v2Chips");
    if (ch) {
      const chips = [];
      const c = this._config;
      if (c.priming_entity) {
        if (this._primingOn()) chips.push(`<span class="v2chip act" data-v2chip="prime">${ICON_DROP}Priming…</span>`);
        else if (this._needPriming()) chips.push(`<span class="v2chip warn" data-v2chip="prime">${ICON_DROP}Needs priming</span>`);
        else chips.push(`<span class="v2chip" data-v2chip="prime">${ICON_DROP}Primed ${escapeHtml(this._lastPrimeAgo() || "—")}</span>`);
      }
      if (c.has_water_entity) chips.push(this._hasWater()
        ? `<span class="v2chip">${ICON_DROP}Water ok</span>`
        : `<span class="v2chip warn">${ICON_DROP}Add water</span>`);
      if (c._partnerUi) chips.push(`<span class="v2chip" data-v2chip="partner">${ICON_BED}${this._partnerOn() ? escapeHtml(c.partner_name || "Partner") + " on" : "Solo"}</span>`);
      if (c.auto_off_entity && this._autoOffOn()) {
        const e = this._hass.states[this._sc("auto_off_entity")];
        const hm = e ? this._fmtHM(e.state) : null;
        chips.push(`<span class="v2chip" data-v2chip="autooff">${ICON_CLOCK}Off ${hm ? hm.t + hm.ap : ""}</span>`);
      }
      ch.innerHTML = chips.join("");
    }
  }

  // ===================================================================================
  // Dev tab (v2) — a diagnostics READ surface. Every entity on the free-sleep MQTT device
  // (dev_prefix), grouped the way HA groups it: Controls · Sensors · Configuration ·
  // Diagnostic. Nothing here is part of the nightly experience — it's what you open when
  // something's off. Monospace for entity ids/raw values; dim grey for every unknown.
  // See DESIGN-LANGUAGE.md §8 "Dev: the fourth tab".
  // ===================================================================================
  _devHTMLv2() {
    return `
      <div class="dev">
        <button class="dev-back" id="devBack">${V2_ICON_CHEVL}<span>Settings</span></button>
        <div class="dev-intro">What's running on the Pod itself, then every entity it exposes. A read surface &mdash; tap a row for more&#8209;info, tap a button to run it.</div>

        <div class="v2card dev-card"><div class="dev-lbl">Pod services</div><div id="devServices"></div></div>
        <div class="v2card dev-card"><div class="dev-lbl">Vibration themes</div><div id="devVib"></div></div>

        <div class="v2card dev-card">
          <div class="dev-lbl">Connector</div>
          <div class="dev-seg" id="devSource"><span data-src="cloud">cloud</span><span data-src="free_sleep">free_sleep</span></div>
          <div class="dev-ent mono" id="devCtlEnt"></div>
          <div id="devHealth"></div>
        </div>

        <div class="v2card dev-card"><div class="dev-lbl">Temperature &mdash; sides</div><div id="devSides"></div></div>
        <div class="v2card dev-card"><div class="dev-lbl">Sensors &mdash; bed</div><div id="devBed"></div></div>
        <div class="v2card dev-card"><div class="dev-lbl">Biometrics &amp; sleep</div><div id="devBio"></div></div>
        <div class="v2card dev-card"><div class="dev-lbl">Sensors &mdash; room</div><div id="devRoom"></div></div>
        <div class="v2card dev-card"><div class="dev-lbl">Diagnostic &mdash; hardware</div><div id="devHw"></div></div>
        <div class="v2card dev-card"><div class="dev-lbl">Configuration</div><div id="devConf"></div></div>
        <div class="v2card dev-card dev-ap"><div class="dev-lbl">Autopilot model</div><div id="devModel"></div></div>
        <div class="v2card dev-card"><div class="dev-lbl">Actions</div><div class="dev-acts" id="devActs"></div><div class="dev-foot mono" id="devFoot"></div></div>
      </div>`;
  }

  /* ---------- Pod health (v10.33) ----------
     The on-Pod es-watchdog publishes one enum sensor (ok | degraded | recovering | error |
     rebooting) whose attributes list every check it runs. This boils it down to the one line
     the Home status light shows. null = nothing to add (no watchdog on this connector, or it
     hasn't been installed) and the light falls through to its priming/water states.
     2026-09-25 is why: the Pod lost temperature control at 07:32 and the light kept saying
     "Ready" for two hours while every command went nowhere. */
  _podHealth() {
    const c = this._config, S = this._hass && this._hass.states;
    if (!S || !c.health_entity) return null;
    const cid = this._activeEntity(), cl = cid && S[cid];
    const h = S[c.health_entity];
    if (this._rebootSent && Date.now() - this._rebootSent < 150000 && (!h || h.state !== "ok" || Date.now() - this._rebootSent < 20000))
      return { tone: "warn", pulse: true, text: "Restarting Pod…", state: "rebooting", title: "Restarting" };
    if (!cl || cl.state === "unavailable") return { tone: "bad", text: "Disconnected", state: "offline", title: "Disconnected" };
    if (!h) return null;
    if (h.state === "unavailable" || h.state === "unknown")
      return { tone: "bad", text: "Pod unreachable", state: "offline", title: "Unreachable" };
    const a = h.attributes || {};
    const checks = Array.isArray(a.checks) ? a.checks : [];
    const worst = checks.find((k) => k.s === "bad") || checks.find((k) => k.s === "warn");
    const why = worst ? (HEALTH_SHORT[worst.id] || worst.label) : "";
    const homeWorthy = worst && HEALTH_HOME_GROUPS.includes(worst.group);
    switch (h.state) {
      case "rebooting": return { tone: "warn", pulse: true, text: "Restarting Pod…", state: h.state, title: "Restarting" };
      case "recovering": return { tone: "warn", pulse: true, text: "Reconnecting…", state: h.state, why, title: "Repairing itself" };
      case "error": return { tone: "bad", text: why ? `Error · ${why}` : "Error", state: h.state, why, title: "Needs attention" };
      case "degraded":
        return homeWorthy ? { tone: "warn", text: why, state: h.state, why, title: "Mostly fine" }
                          : { tone: "ok", text: "Ready", state: h.state, why, title: "Mostly fine" };
      default: return { tone: "ok", text: "Ready", state: h.state, title: "All systems normal" };
    }
  }

  _fmtClock12(ts) {
    const d = new Date(ts * 1000);
    const h = d.getHours() % 12 || 12, m = String(d.getMinutes()).padStart(2, "0");
    const today = new Date().toDateString() === d.toDateString();
    return `${h}:${m} ${d.getHours() < 12 ? "am" : "pm"}${today ? "" : " " + d.toLocaleDateString([], { weekday: "short" })}`;
  }

  _healthEventText(ev) {
    const why = {
      frozen_silent: "temp control went silent", sensor_silent: "bed sensors went silent",
      link_down: "firmware stopped answering", control_units: "a control service stopped",
      capybara: "supervisor stopped", heartbeat: "heartbeat stalled", manual: "from the app",
    };
    const r = ev.reason ? (why[ev.reason] || ev.reason.replace(/^unit_/, "").replace(/_/g, " ")) : "";
    switch (ev.kind) {
      case "start": return "Watchdog started";
      case "restart": return `Restarted ${ev.unit}${r ? " — " + r : ""}`;
      case "restart_control": return `Restarted control${r ? " — " + r : ""}`;
      case "reboot": return ev.manual ? "Rebooted from the app" : `Rebooted itself — ${r}`;
      case "reboot_blocked": return `Held off a reboot — ${ev.why || ""}`;
      case "recovered": return `Recovered — ${why[ev.problem] || ev.problem}`;
      case "clock_step": return `Clock jumped ${ev.seconds > 0 ? "+" : ""}${ev.seconds}s`;
      case "auto_repair": return `Auto-repair ${ev.on ? "on" : "off"}`;
      default: return ev.kind;
    }
  }

  // Dev > Pod services: every check the watchdog runs, as status lights, grouped.
  _renderDevServices() {
    const el = this.shadowRoot.getElementById("devServices");
    if (!el) return;
    const c = this._config, S = this._hass.states;
    const h = c.health_entity && S[c.health_entity];
    if (!h) {
      el.innerHTML = `<div class="dev-note" style="margin-top:0">No watchdog on this connector${c.health_entity ? ` &mdash; <span class="mono">${escapeHtml(c.health_entity)}</span> doesn't exist yet (install gateway/watchdog on the Pod)` : ""}.</div>`;
      return;
    }
    const armedNow = !!(this._rebootArm && Date.now() - this._rebootArm < 4000);
    const ar0 = c.auto_repair_entity && S[c.auto_repair_entity];
    const sig = `${h.last_updated}|${h.state}|${JSON.stringify(h.attributes)}|${armedNow}|${ar0 ? ar0.state : ""}|${this._rebootSent || 0}`;
    if (el.childElementCount && this._devSvcSig === sig) return;
    this._devSvcSig = sig;
    const hl = this._podHealth() || { tone: "ok", title: "All systems normal" };
    const a = h.attributes || {};
    const online = !["unavailable", "unknown"].includes(h.state);
    const dot = (tone) => `<span class="dev-dot" style="background:${HEALTH_TONE[tone] || HEALTH_TONE.off};box-shadow:0 0 7px ${HEALTH_TONE[tone] || "transparent"}88"></span>`;
    const checks = online && Array.isArray(a.checks) ? a.checks : [];
    const groups = [];
    checks.forEach((k) => { let g = groups.find((x) => x.name === k.group); if (!g) groups.push(g = { name: k.group, rows: [] }); g.rows.push(k); });
    const nBad = checks.filter((k) => k.s === "bad").length, nWarn = checks.filter((k) => k.s === "warn").length;
    const head = `
      <div class="dev-hs ${hl.tone}${hl.pulse ? " pulse" : ""}" data-dev-more="${c.health_entity}">
        ${dot(hl.tone)}
        <div class="dev-hs-t"><b>${escapeHtml(hl.title || "")}</b>
          <i>${escapeHtml(!online ? "The watchdog isn't reporting — the Pod may be off or off the network"
            : h.state === "ok" ? `Every check passing · ${a.auto_repair === false ? "auto-repair off" : "auto-repair on"}` : (a.summary || ""))}</i></div>
        <span class="dev-hs-n mono">${online ? `${checks.length - nBad - nWarn}/${checks.length}` : "—"}</span>
      </div>`;
    const body = groups.map((g) => `
      <div class="dev-sg">${escapeHtml(g.name)}</div>
      ${g.rows.map((k) => `<div class="dev-st">${dot(k.s)}<span class="dev-sl">${escapeHtml(k.label)}</span><span class="dev-age">${escapeHtml(k.detail || "")}</span></div>`).join("")}`).join("");
    // service restarts of the watchdog itself aren't news; repairs, reboots and clock jumps are
    const evs = (Array.isArray(a.events) ? a.events : []).filter((ev) => ev.kind !== "start").slice(-5).reverse();
    const events = !evs.length ? `<div class="dev-sg">Recent</div><div class="dev-ev"><span>No repairs needed</span></div>` : `
      <div class="dev-sg">Recent</div>
      ${evs.map((ev) => `<div class="dev-ev"><span class="mono">${this._fmtClock12(ev.ts)}</span><span>${escapeHtml(this._healthEventText(ev))}</span></div>`).join("")}`;
    const ar = c.auto_repair_entity && S[c.auto_repair_entity];
    const arOn = ar ? ar.state === "on" : a.auto_repair !== false;
    const armed = this._rebootArm && Date.now() - this._rebootArm < 4000;
    const acts = `
      <div class="dev-acts" style="margin-top:12px">
        ${c.restart_control_entity && S[c.restart_control_entity] ? `<button class="dev-btn" data-dev-btn="${c.restart_control_entity}">Restart control</button>` : ""}
        ${c.reboot_entity && S[c.reboot_entity] ? `<button class="dev-btn ${armed ? "armed" : ""}" data-dev-reboot="1">${armed ? "Tap again to reboot" : "Reboot Pod"}</button>` : ""}
      </div>
      ${ar ? `<button class="dev-tg ${arOn ? "on" : ""}" data-dev-autorepair="1"><span><b>Auto-repair</b><i>Restart what breaks; reboot if that doesn't fix it (max 3 a day)</i></span><em></em></button>` : ""}
      <div class="dev-foot mono">watchdog ${escapeHtml(String(a.version || "?"))} · ${a.reboots_24h || 0} auto reboots in 24h</div>`;
    el.innerHTML = head + body + events + acts;
  }

  _vibScript() { return this._config.vibrate_script || "script.eight_sleep_pod_vibrate"; }
  _renderDevVib() {
    const el = this.shadowRoot.getElementById("devVib");
    if (!el) return;
    const has = !!(this._hass && this._hass.states[this._vibScript()]);
    const side = this._vibSide || (this._config.own_side === "right" ? "right" : "left");
    const live = this._vibLive && Date.now() < this._vibLive.until ? this._vibLive : null;
    const sig = `${has}|${side}|${live ? live.i : ""}`;
    if (el.childElementCount && this._vibSig === sig) return;
    this._vibSig = sig;
    if (!has) {
      el.innerHTML = `<div class="dev-note" style="margin-top:0"><span class="mono">${escapeHtml(this._vibScript())}</span> isn't in Home Assistant yet.</div>`;
      return;
    }
    el.innerHTML = `
      <div class="dev-seg vib-side">${["left", "right"].map((s) => `<span class="${s === side ? "on" : ""}" data-vib-side="${s}">${s}</span>`).join("")}</div>
      <div class="vib-grid">${VIB_THEMES.map((t, i) => `
        <button class="vib-tile${live && live.i === i ? " live" : ""}" data-vib-theme="${i}">
          <b>${escapeHtml(t.name)}</b>
          <i class="vib-bar"><em style="width:${t.power}%"></em></i>
          <span class="mono">${t.power}% · ${t.pattern} · ${t.dur}s</span>
          <small>${live && live.i === i ? "Buzzing…" : escapeHtml(t.note)}</small>
        </button>`).join("")}</div>
      <button class="dev-btn vib-stop" data-vib-stop="1">Stop ${side}</button>`;
  }
  _vibFire(i) {
    const side = this._vibSide || (this._config.own_side === "right" ? "right" : "left");
    const t = i == null ? null : VIB_THEMES[i];
    this._haptic(t ? "medium" : "light");
    this._hass.callService("script", "turn_on", { entity_id: this._vibScript(),
      variables: t ? { side, power: t.power, duration: t.dur, pattern: t.pattern } : { side, power: 0 } });
    clearTimeout(this._vibT);
    this._vibLive = t ? { i, until: Date.now() + t.dur * 1000 } : null;
    this._vibSig = null; this._renderDevVib();
    if (t) this._vibT = setTimeout(() => { this._vibLive = null; this._vibSig = null; this._renderDevVib(); }, t.dur * 1000 + 300);
  }

  // two-tap reboot, shared by Settings > Restart Pod and Dev > Reboot Pod
  _rebootTap() {
    const now = Date.now();
    if (this._rebootArm && now - this._rebootArm < 4000) {
      this._rebootArm = 0;
      this._rebootSent = now;
      this._haptic("heavy");
      this._hass.callService("button", "press", { entity_id: this._config.reboot_entity });
    } else {
      this._rebootArm = now;
      this._haptic("medium");
      clearTimeout(this._rebootArmT);
      this._rebootArmT = setTimeout(() => { this._rebootArm = 0; this._setSig = null; this._update && this._update(); }, 4100);
    }
    this._setSig = null;
    this._update && this._update();
  }

  _renderDev() {
    if (!this._hass) return;
    const $ = (id) => this.shadowRoot.getElementById(id);
    if (!$("devSides")) return;
    const S = this._hass.states;
    const c = this._config;
    const p = c.dev_prefix || "eight_sleep_pod";
    const has = (id) => !!S[id];
    const rawv = (id) => { const e = S[id]; return e && e.state != null ? String(e.state) : null; };
    const KN = (v) => v != null && !["unknown", "unavailable", "none", ""].includes(String(v).toLowerCase());
    const unit = (id) => { const e = S[id]; return e && e.attributes && e.attributes.unit_of_measurement ? e.attributes.unit_of_measurement : ""; };
    const pivot = Number(c.mid_temp) || 27;
    const wc = (n) => !Number.isFinite(n) ? "" : n > pivot + 0.3 ? "warm" : n < pivot - 0.3 ? "cool" : "mid";
    const fmt = (id, o) => {
      const v = rawv(id);
      if (!KN(v)) return { txt: "unknown", cls: "dim" };
      const n = Number(v);
      let txt = (o.dp != null && Number.isFinite(n)) ? n.toFixed(o.dp) : (o.map && o.map[v] != null ? o.map[v] : v);
      if (o.unit) { const u = o.unit === true ? unit(id) : o.unit; if (u) txt += (u === "%" ? u : " " + u); }
      let cls = o.cls || "";
      if (!cls && o.temp && Number.isFinite(n)) cls = wc(n);
      if (!cls && o.on) cls = (v === "on" || v === "True") ? "ok" : "dim";
      return { txt: String(txt), cls };
    };
    const row = (label, id, o = {}) => {
      if (!has(id)) return o.always ? `<div class="dev-r"><span class="k">${label}</span><span class="v dim">&mdash;</span></div>` : "";
      const f = fmt(id, o);
      return `<div class="dev-r" data-dev-more="${id}"><span class="k">${label}</span><span class="v ${f.cls}">${escapeHtml(f.txt)}</span></div>`;
    };
    const head = `<span class="k">&nbsp;</span><span class="hh">Left</span><span class="hh">Right</span>`;
    const lr = (label, dom, suf, o = {}) => {
      const lid = `${dom}.${p}_left_${suf}`, rid = `${dom}.${p}_right_${suf}`;
      if (!has(lid) && !has(rid)) return "";
      const cell = (id) => {
        if (!has(id)) return `<span class="c dim">&mdash;</span>`;
        const f = fmt(id, o);
        return `<span class="c ${f.cls}" data-dev-more="${id}">${escapeHtml(f.txt)}</span>`;
      };
      return `<span class="k">${label}</span>${cell(lid)}${cell(rid)}`;
    };
    const grid = (rows) => `<div class="dev-lr">${head}${rows}</div>`;

    // connector
    const seg = $("devSource");
    if (seg) seg.querySelectorAll("[data-src]").forEach((s) => s.classList.toggle("on", s.dataset.src === (c.source || "cloud")));
    $("devCtlEnt").textContent = c.entity || "—";

    this._renderDevServices();
    this._renderDevVib();
    // v10.33: rows below track the entities the stock-firmware stack actually publishes
    // (es-franken-proxy climate + es-biometrics tap + pod-sleep-pipeline), not free-sleep's.
    $("devHealth").innerHTML =
      row("Water", `binary_sensor.${p}_water_low`, { map: { off: "OK", on: "LOW" }, cls: "" })
      + row("Priming", `binary_sensor.${p}_priming`, { map: { off: "idle", on: "running" } })
      + row("Sensor stream", `binary_sensor.${p}_sensor_stream`, { map: { off: "stopped", on: "flowing" } });

    const clim = (side) => S[`climate.${p}_${side}`];
    const ccell = (side, fn) => {
      const e = clim(side);
      if (!e) return `<span class="c dim">&mdash;</span>`;
      const f = fn(e);
      return `<span class="c ${f.cls || ""}" data-dev-more="climate.${p}_${side}">${escapeHtml(f.txt)}</span>`;
    };
    const tc = (v) => Number.isFinite(Number(v)) ? { txt: Number(v).toFixed(1) + " °C", cls: wc(Number(v)) } : { txt: "unknown", cls: "dim" };
    const climRows = !clim("left") && !clim("right") ? "" :
      `<span class="k">Power</span>${ccell("left", (e) => e.state === "unavailable" ? { txt: "offline", cls: "dim" } : { txt: e.state === "off" ? "off" : "on", cls: e.state === "off" ? "dim" : "ok" })}${ccell("right", (e) => e.state === "unavailable" ? { txt: "offline", cls: "dim" } : { txt: e.state === "off" ? "off" : "on", cls: e.state === "off" ? "dim" : "ok" })}`
      + `<span class="k">Target</span>${ccell("left", (e) => tc(e.attributes.temperature))}${ccell("right", (e) => tc(e.attributes.temperature))}`
      + `<span class="k">Heat level (as °C)</span>${ccell("left", (e) => tc(e.attributes.current_temperature))}${ccell("right", (e) => tc(e.attributes.current_temperature))}`;
    $("devSides").innerHTML = grid(
      climRows
      + lr("Water temp", "sensor", "water_temp", { temp: true, unit: true, dp: 1 })
      + lr("Pump", "sensor", "pump_state")
      + lr("Pump current", "sensor", "pump_current", { unit: true, dp: 3 })
      + lr("PID output", "sensor", "pid_output_raw", { dp: 3 }));

    $("devBed").innerHTML = grid(
      lr("Presence", "binary_sensor", "presence", { map: { on: "in bed", off: "clear" } })
      + lr("In bed for", "sensor", "present_for", { unit: true, dp: 0 })
      + lr("Movement 30m", "sensor", "movement_30m", { dp: 1 })
      + lr("Exits since restart", "sensor", "bed_exits_since_restart")
      + lr("Vitals age", "sensor", "vitals_age", { unit: true }));

    $("devBio").innerHTML = grid(
      lr("Heart rate", "sensor", "heart_rate", { unit: true })
      + lr("HRV", "sensor", "hrv", { unit: true })
      + lr("Breathing rate", "sensor", "breathing_rate", { unit: true })
      + lr("Sleep score", "sensor", "sleep_score")
      + lr("Sleep duration", "sensor", "sleep_duration", { unit: true, dp: 1 })
      + lr("Efficiency", "sensor", "sleep_efficiency", { unit: true })
      + lr("Resting HR", "sensor", "resting_heart_rate", { unit: true, dp: 0 })
      + lr("HRV (night)", "sensor", "hrv_avg", { unit: true, dp: 0 })
      + lr("Resp. rate", "sensor", "respiratory_rate", { unit: true, dp: 1 })
      + lr("Awakenings", "sensor", "awakenings"))
      + `<div class="dev-note">Right = this card's sleeper for the nightly numbers (pipeline mapping); live vitals follow the climate halves.</div>`;

    $("devRoom").innerHTML =
      row("Room temperature", `sensor.${p}_room_temperature`, { temp: true, unit: true, dp: 1 })
      + row("Room humidity", `sensor.${p}_room_humidity`, { unit: true, dp: 0 });

    $("devHw").innerHTML =
      row("Control board temp", `sensor.${p}_control_board_temperature`, { unit: true, dp: 1 })
      + row("Heatsink temp", `sensor.${p}_heatsink_temperature`, { unit: true, dp: 1, cls: "cool" })
      + row("Float valve current", `sensor.${p}_float_valve_solenoid_current`, { unit: true, dp: 4 })
      + row("Frank loop avg", `sensor.${p}_frank_loop_avg`, { unit: true })
      + row("Frank loop max", `sensor.${p}_frank_loop_max`, { unit: true })
      + row("RAW file", `sensor.${p}_raw_file`)
      + row("Biometrics pipe", `switch.${p}_biometrics_pipe_enabled`, { on: true });

    $("devConf").innerHTML =
      row("Front light", `light.${p}_front_led`, { on: true })
      + row("Solo / Dual", this._config.dual_mode_entity || `input_boolean.${p}_dual_mode`, { map: { off: "Solo", on: "Dual" } })
      + row("Auto repair", this._config.auto_repair_entity || `switch.${p}_auto_repair`, { on: true });

    // Autopilot model — whatever the suggested-temp template sensor exposes
    const md = $("devModel");
    if (md) {
      const rows = [];
      const sid = this._sc("suggested_entity");
      const se = sid && S[sid];
      if (se && KN(se.state)) rows.push(`<div class="dev-r" data-dev-more="${sid}"><span class="k">es_suggest</span><span class="v ${wc(Number(se.state))}">${escapeHtml(this._fmtVal(Number(se.state)))}</span></div>`);
      if (se && se.attributes) {
        Object.keys(se.attributes).forEach((k) => {
          if (["friendly_name", "unit_of_measurement", "device_class", "icon", "state_class"].includes(k)) return;
          rows.push(`<div class="dev-r"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(String(se.attributes[k]))}</span></div>`);
        });
      }
      const re = c.bed_rate_entity && S[c.bed_rate_entity];
      if (re) rows.push(`<div class="dev-r" data-dev-more="${c.bed_rate_entity}"><span class="k">bed temp rate</span><span class="v">${escapeHtml(re.state)}${re.attributes && re.attributes.unit_of_measurement ? " " + re.attributes.unit_of_measurement : ""}</span></div>`);
      md.innerHTML = rows.join("") || `<div class="dev-r"><span class="k">Autopilot model</span><span class="v dim">not configured on this card</span></div>`;
    }

    // actions
    const btn = (label, id) => has(id) ? `<button class="dev-btn" data-dev-btn="${id}">${label}</button>` : "";
    $("devActs").innerHTML = [
      btn("Prime now", `button.${p}_prime_now`),
      btn("Vibrate left", `button.${p}_left_vibrate`),
      btn("Vibrate right", `button.${p}_right_vibrate`),
      btn("Stop left", `button.${p}_left_vibrate_stop`),
      btn("Stop right", `button.${p}_right_vibrate_stop`),
      `<button class="dev-btn" data-dev-reload="1">Reload card</button>`,
      btn("Dismiss alarm L", `button.${p}_left_dismiss_alarm`),
      btn("Dismiss alarm R", `button.${p}_right_dismiss_alarm`),
      btn("Test alarm L", `button.${p}_left_test_alarm`),
      btn("Test alarm R", `button.${p}_right_test_alarm`),
    ].filter(Boolean).join("");
    const n = Object.keys(S).filter((k) => { const o = k.split(".")[1]; return o && o.startsWith(p + "_"); }).length;
    $("devFoot").textContent = `HA ${this._hass.config && this._hass.config.version || "?"} · ${n} entities · source: ${c.source || "cloud"}`;
  }

  _devClick(e) {
    if (e.target.closest("[data-dev-reboot]")) { this._rebootTap(); return; }
    const vs = e.target.closest("[data-vib-side]");
    if (vs) { this._vibSide = vs.dataset.vibSide; this._haptic("light"); this._vibSig = null; this._renderDevVib(); return; }
    const vt = e.target.closest("[data-vib-theme]");
    if (vt) { this._vibFire(Number(vt.dataset.vibTheme)); return; }
    if (e.target.closest("[data-vib-stop]")) { this._vibFire(null); return; }
    if (e.target.closest("[data-dev-autorepair]")) {
      const id = this._config.auto_repair_entity;
      this._haptic("light");
      if (id) this._hass.callService("switch", "toggle", { entity_id: id });
      return;
    }
    const b = e.target.closest("[data-dev-btn]");
    if (b) { this._haptic("medium"); this._hass.callService("button", "press", { entity_id: b.dataset.devBtn }); return; }
    if (e.target.closest("[data-dev-reload]")) { this._haptic("light"); try { window.location.reload(); } catch (_) {} return; }
    const mi = e.target.closest("[data-dev-more]");
    if (mi) { this._haptic("light"); this._moreInfoEntity(mi.dataset.devMore); }
  }

  /* ---------- Settings > Pod Light ---------- */
  // The Pod 3's front status LED, exposed by the on-Pod `es-led` service as an
  // MQTT light. Default entity id; override with `led_entity:` in card config.
  _ledEntity() { return this._config.led_entity || "light.eight_sleep_pod_front_led"; }
  _ledObj() { return this._hass && this._hass.states[this._ledEntity()]; }
  _ledOn() { const s = this._ledObj(); return !!(s && s.state === "on"); }
  _ledRgb() {
    const s = this._ledObj();
    const c = s && s.attributes && s.attributes.rgb_color;
    return Array.isArray(c) && c.length === 3 ? c : [30, 115, 255];
  }
  _ledBri() {
    const s = this._ledObj();
    const b = s && s.attributes && s.attributes.brightness;
    return Number.isFinite(b) ? b : 200;
  }
  _ledFx() {
    const s = this._ledObj();
    return (s && s.attributes && s.attributes.effect) || "Solid";
  }

  _renderSettings() {
    const el = this.shadowRoot.getElementById("viewSettings");
    if (!el) return;
    if (this._ledBriDragging) return;   // don't rebuild the slider out from under a drag
    const L = this._layout;
    const hasLed = !!this._ledObj();
    const on = this._ledOn();
    const [r, g, b] = this._ledRgb();
    const bri = this._ledBri();
    const fx = this._ledFx();
    // _update() calls this on EVERY hass tick — only touch the DOM when something it
    // shows actually changed, or the whole panel flickers (image reload, animation restart).
    const hl = this._podHealth();
    const hlA = this._config.health_entity && this._hass.states[this._config.health_entity];
    const hlSum = hlA && hlA.attributes ? hlA.attributes.summary || "" : "";
    const rbArmed = !!(this._rebootArm && Date.now() - this._rebootArm < 4000);
    const sig = `${L}|${hasLed}|${on}|${r},${g},${b}|${bri}|${fx}|${this._underglowMode()}|${JSON.stringify(this._hkState || null)}|${hl ? hl.tone + hl.text : ""}|${hlSum}|${rbArmed}`;
    if (el.childElementCount && this._setSig === sig) return;
    this._setSig = sig;
    const SW = [
      ["White", "255,255,255"], ["Warm", "255,202,160"], ["Amber", "255,122,20"],
      ["Red", "255,59,48"], ["Yellow", "255,214,10"], ["Green", "52,215,89"],
      ["Cyan", "64,224,208"], ["Blue", "30,115,255"], ["Violet", "168,107,255"], ["Pink", "255,91,200"],
    ];
    const FX = ["Solid", "Breathe", "Pulse", "Rainbow", "Candle", "Strobe", "Auto"];
    const near = (c, [tr, tg, tb]) => { const [cr, cg, cb] = c.split(",").map(Number); return Math.abs(cr - tr) + Math.abs(cg - tg) + Math.abs(cb - tb) < 30; };
    const hub = this._config.led_hub_image || "/local/es-pod-hub.png";
    const briPct = Math.round(bri / 255 * 100);
    // Underglow lighting — used to live on the Room page; that page went with Insights in
    // v10.29, and the chips are worth keeping, so they moved here.
    const uwCard = this._config.underglow_entity ? this._underglowHTML() : "";
    // Apple Health (v10.29) — only in the native iOS app, which injects __POD_HEALTH and
    // answers a `pod-health` event with `pod-health-result`. Hours slept only: the app writes
    // the asleep stretches so Health's own total matches the Pod's, and deliberately writes
    // no stages, heart rate or breathing (see kiosk/ios/Shared/PodHealth.swift).
    const hk = this._hkState || {};
    const hkCard = !(typeof window !== "undefined" && window.__POD_HEALTH) ? "" : `
      <div class="set-card">
        <div class="set-h">Apple Health</div>
        <div class="set-row" id="hkToggle" style="padding: 0;">
          <span class="set-row-l"><b>${hk.canWrite ? "Writing time asleep" : "Connect to Health"}</b>
            <i>${escapeHtml(hk.message || (hk.canWrite
              ? (hk.lastNight ? `Last written ${hk.lastNight}` : "Hours slept only \u2014 no stages, no heart rate")
              : "Hours slept only \u2014 no stages, no heart rate"))}</i></span>
          <span class="set-row-c">${hk.canWrite ? GLOW_ICON_CHECK : V2_ICON_CHEVR}</span>
        </div>
        ${hk.canWrite ? `<button class="set-card set-row" id="hkBackfill" style="margin-top: 12px;">
          <span class="set-row-l"><b>Backfill past nights</b><i>The 30 nights already scored</i></span>
          <span class="set-row-c">${V2_ICON_CHEVR}</span>
        </button>` : ""}
      </div>`;
    // Pod (v10.33): live health from the on-Pod watchdog + a Restart button. Two taps — the first
    // arms it for 4 s — because a restart stops the bed for about a minute.
    const canReboot = !!(this._config.reboot_entity && this._hass.states[this._config.reboot_entity]);
    const podCard = !(hl || canReboot) ? "" : `
      <div class="set-card">
        <div class="set-h">Pod</div>
        ${hl ? `<div class="pod-hl ${hl.tone}${hl.pulse ? " pulse" : ""}">
          <span class="ps-dot"></span>
          <span class="set-row-l"><b>${escapeHtml(hl.title || hl.text)}</b><i>${escapeHtml(hl.tone === "ok" && hl.state === "ok" ? "Temperature control, sensors and the link to Home Assistant are all running" : (hlSum || hl.text))}</i></span>
        </div>` : ""}
        ${canReboot ? `<button class="set-row pod-rb ${rbArmed ? "armed" : ""}" id="setReboot">
          <span class="set-row-l"><b>${rbArmed ? "Tap again to restart" : "Restart Pod"}</b>
            <i>${rbArmed ? "The bed pauses for about a minute" : "Takes about a minute. Your temperature comes back on its own."}</i></span>
          <span class="set-row-c">${V2_ICON_POWER}</span>
        </button>` : ""}
      </div>`;
    // Dev is no longer a tab: it opens from here (v10.29).
    const devCard = this._config.dev_view === false ? "" : `
      <button class="set-card set-row" id="setDev">
        <span class="set-row-l"><b>Developer</b><i>Every Pod entity, the Autopilot model, raw actions</i></span>
        <span class="set-row-c">${V2_ICON_CHEVR}</span>
      </button>`;

    const ledCard = !hasLed ? "" : `
      <div class="set-card led-card ${on ? "" : "led-off"} fx-${fx.toLowerCase()}"
           style="--lc:rgb(${r},${g},${b}); --lb:${(bri / 255).toFixed(2)};">
        <div class="led-hd">
          <span class="set-h" style="margin:0;">Pod Light</span>
          <button class="led-pw ${on ? "" : "off"}" id="ledPower">${on ? "On" : "Off"}<i></i></button>
        </div>
        <div class="led-stage">
          <img src="${hub}" alt="" onerror="this.style.display='none'">
          <div class="led-glow"></div>
        </div>
        <div class="led-row">
          <span class="led-lbl">Brightness</span><span class="led-val" id="ledBriVal">${briPct}%</span>
        </div>
        <div class="led-sl" id="ledBri"><b style="width:${briPct}%"></b><i style="left:${briPct}%"></i></div>
        <div class="led-row"><span class="led-lbl">Colour</span></div>
        <div class="led-sw">
          ${SW.map(([n, c]) => `<button class="led-swx ${near(c, [r, g, b]) ? "on" : ""}" data-led-color="${c}" style="background:rgb(${c})" title="${n}"></button>`).join("")}
        </div>
        <div class="led-row"><span class="led-lbl">Animation</span></div>
        <div class="led-fx">
          ${FX.map((f) => `<button class="led-fxx ${f === fx ? "on" : ""}" data-led-fx="${f}">${f}</button>`).join("")}
        </div>
        <div class="set-note dim">Auto hands the LED back to the Pod's own status light.</div>
      </div>`;

    el.innerHTML = `
      ${ledCard}
      <div class="set-card">
        <div class="set-h">Card layout</div>
        <div class="set-seg">
          <button class="set-opt ${L === "classic" ? "on" : ""}" data-v2layout="classic">Classic</button>
          <button class="set-opt ${L === "v2" ? "on" : ""}" data-v2layout="v2">New (v2)</button>
        </div>
        <div class="set-note">${L === "v2"
          ? "Compact layout — status line, always-visible boost, an Autopilot / Manual toggle and a chip row. Detail (chart, bias, schedule) is one tap away."
          : "The original layout, unchanged. Switch to v2 to try the redesign; switch back here any time."}</div>
        <div class="set-note dim">Saved on this device only.</div>
      </div>
      ${podCard}
      ${hkCard}
      ${uwCard}
      ${devCard}
      <button class="set-done" id="setDone">Done</button>`;

    this._updateUnderglowUI();
    this._hkWire();   // first paint of Settings asks the native shell where Health stands

    const sl = this.shadowRoot.getElementById("ledBri");
    if (sl && !sl._wired) {
      sl._wired = true;
      const val = this.shadowRoot.getElementById("ledBriVal");
      const at = (clientX) => {
        const rect = sl.getBoundingClientRect();
        return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      };
      const paint = (f) => {
        const p = Math.round(f * 100);
        sl.querySelector("b").style.width = p + "%";
        sl.querySelector("i").style.left = p + "%";
        if (val) val.textContent = p + "%";
        const card = sl.closest(".led-card");
        if (card) card.style.setProperty("--lb", Math.max(0.04, f).toFixed(2));
      };
      const commit = (f) => {
        this._hass.callService("light", "turn_on", {
          entity_id: this._ledEntity(),
          brightness: Math.max(1, Math.round(f * 255)),
        });
      };
      sl.addEventListener("pointerdown", (e) => {
        e.stopPropagation(); this._ledBriDragging = true;
        sl.setPointerCapture(e.pointerId);
        paint(at(e.clientX));
        const mv = (ev) => paint(at(ev.clientX));
        const up = (ev) => {
          sl.removeEventListener("pointermove", mv);
          sl.removeEventListener("pointerup", up);
          this._ledBriDragging = false;
          this._haptic("light");
          commit(at(ev.clientX));
        };
        sl.addEventListener("pointermove", mv);
        sl.addEventListener("pointerup", up);
      });
    }
  }

  _paint(el, cls) {
    el.classList.remove("cool", "warm", "neutral", "mid");
    if (cls) el.classList.add(cls);
  }

  _renderPresets() {
    const els = this.shadowRoot.querySelectorAll(".presets");
    if (!els.length) return;
    const tgt = Math.round(this._tgtTemp());
    const tempChips = (this._config.presets || []).map((p) => {
      const active = Math.round(p.temp) === tgt;
      return `<button class="chip ${active ? "on" : ""}" data-preset="${p.temp}">${escapeHtml(p.label)} ${Math.round(p.temp)}°</button>`;
    });
    const aid = this._awayEntity() || this._config.away_entity;
    const aOn = !!(aid && this._hass.states[aid] && this._hass.states[aid].state === "on");
    const awayChip = aid && this._hass.states[aid] ? `<button class="chip away ${aOn ? "on" : ""}" data-preset="away">${ICON_MOON}Away</button>` : "";
    const awayChipV2 = aid && this._hass.states[aid] ? `<button class="chip away ${aOn ? "on" : ""}" data-preset="away">${V2_ICON_MOON}Away</button>` : "";
    // Boost chips. Heat boost: tap jumps straight to max heat for boost_minutes, then reverts.
    // Pre Cool Sleep: tap starts a gentle cool-down (precool_sleep_temp/minutes) — holding it
    // instead opens a picker to set the temp/duration before starting. Tapping either chip
    // again while it's the active boost cancels early; tapping the other one mid-boost switches
    // direction (keeping the original pre-boost temp to revert to).
    const boosting = this._boostActive(this._activeEntity());
    const boostChip = (dir, label, icon, holdable) => {
      const on = !!boosting && boosting.dir === dir;
      const text = on ? `${label} · ${this._boostRemainingLabel(boosting)}` : label;
      return `<button class="chip boost ${dir} ${on ? "on" : ""}" data-boost="${dir}" ${holdable ? 'data-boost-holdable="1"' : ""}>${icon}${escapeHtml(text)}</button>`;
    };
    const warmChip = boostChip("warm", "Heat boost", ICON_FLAME, false);
    const coolChip = boostChip("cool", "Pre Cool Sleep", ICON_SNOW, true);
    const full = [...tempChips, awayChip, warmChip, coolChip].filter(Boolean).join("");
    // v2 Home's quick actions ("no-temps"): Boost/Pre-cool/Away only, using the v2 (Lucide) icon
    // set — no numeric preset chips, and never the classic filled glyphs above.
    // v2 Home (Glow) quick-action tiles: icon badge + label, time left underneath while running.
    // Same data-boost / data-boost-holdable / data-preset hooks as every other chip, so the tap,
    // hold-to-customise and Away handlers are unchanged.
    const qaTile = (dir, label, icon, holdable) => {
      const on = !!boosting && boosting.dir === dir;
      return `<button class="chip boost ${dir} qa ${on ? "on" : ""}" data-boost="${dir}" ${holdable ? 'data-boost-holdable="1"' : ""}><span class="qa-ic">${icon}</span><span class="qa-t">${escapeHtml(label)}${on ? `<small>${escapeHtml(this._boostRemainingLabel(boosting))}</small>` : ""}</span></button>`;
    };
    const warmChipV2 = qaTile("warm", "Heat boost", GLOW_ICON_BOOST, true);   // hold → Pre-heat popup (tap = max heat, as before)
    const coolChipV2 = qaTile("cool", "Pre‑cool sleep", GLOW_ICON_PRECOOL, true);
    const awayTileV2 = aid && this._hass.states[aid]
      ? `<button class="chip away qa ${aOn ? "on" : ""}" data-preset="away"><span class="qa-ic">${GLOW_ICON_AWAY}</span><span class="qa-t">Away${aOn ? "<small>Pod paused</small>" : ""}</span></button>` : "";
    const wd = this._winddownState();
    const wdTile = wd
      ? `<button class="chip wind qa ${wd.on ? "on" : ""}" data-winddown="1" style="--wd:${(wd.frac * 100).toFixed(1)}"><span class="qa-ic">${GLOW_ICON_WINDDOWN}</span><span class="qa-t">Wind down${wd.on ? `<small>${Math.max(1, Math.ceil(wd.left / 60000))} min left</small>` : ""}</span></button>` : "";
    const noTemps = [warmChipV2, coolChipV2, wdTile, awayTileV2 || awayChipV2].filter(Boolean).join("");
    // Only touch the DOM when the markup actually changed, and never while a chip is being held:
    // _update() runs on every hass tick (~1/s on the local Pod), and rebuilding the row swapped
    // the pressed button out from under the finger — the hold-to-customise timer's chip vanished
    // and the gesture never registered (iOS app: "holding Pre-cool / Heat boost does nothing").
    els.forEach((pr) => {
      const html = pr.classList.contains("no-temps") ? noTemps : full;
      if (pr._esHtml === html || pr.querySelector(".holding")) return;
      pr.innerHTML = html;
      pr._esHtml = html;
    });
    // the Glow background settles darker as the wind-down runs
    const home = this.shadowRoot.querySelector(".v2home.glow");
    if (home) {
      home.classList.toggle("wd", !!(wd && wd.on));
      home.style.setProperty("--wd-dim", wd && wd.on ? wd.frac.toFixed(3) : "0");
    }
  }

  // v10.26 Wind down: the script's own run is the countdown (mode: restart, one delay)
  _winddownState() {
    const id = this._config.winddown_script;
    const e = id && this._hass && this._hass.states[id];
    if (!e) return null;
    const on = e.state === "on";
    const total = Math.max(1, this._config.winddown_minutes || 20) * 60000;
    const started = Date.parse((e.attributes && e.attributes.last_triggered) || "");
    const left = on && Number.isFinite(started) ? Math.max(0, started + total - Date.now()) : (on ? total : 0);
    return { id, on, left, frac: on ? 1 - left / total : 0 };
  }
  _toggleWinddown() {
    const wd = this._winddownState();
    if (!wd) return;
    this._haptic(wd.on ? "light" : "medium");
    this._hass.callService("script", wd.on ? "turn_off" : "turn_on", { entity_id: wd.id });
  }

  _renderStatus(on, dir, working, bs) {
    const rows = this.shadowRoot.querySelectorAll(".autopilot");
    if (!rows.length) return;
    const C = 2 * Math.PI * 16;
    const rem = bs ? bs.remaining : 0;
    let offset = C, opacity = "0.3", text = "";
    if (on) {
      if (rem > 0) {
        this._sessMax = Math.max(this._sessMax || 0, rem);
        const frac = Math.max(0, Math.min(1, rem / this._sessMax));
        offset = C * (1 - frac); opacity = "1";
        const verb = working ? (dir === "warm" ? "Heating" : dir === "cool" ? "Cooling" : "Running") : "Scheduled";
        text = `${verb} · stops in ${this._fmtDur(rem)}`;
      } else {
        text = working ? (dir === "warm" ? "Heating" : dir === "cool" ? "Cooling" : "Adjusting") : "Holding temperature";
      }
    }
    rows.forEach((row) => {
      const txt = row.querySelector(".status-text"), ring = row.querySelector(".ring-fg");
      if (ring) ring.style.strokeDasharray = C.toFixed(1);
      if (!on) { row.style.display = "none"; return; }
      row.style.display = "";
      row.classList.toggle("warm", dir === "warm");
      row.classList.toggle("mid", dir === "mid");
      row.classList.toggle("cool", dir === "cool");
      if (ring) { ring.style.strokeDashoffset = offset.toFixed(1); ring.style.opacity = opacity; }
      if (txt) txt.textContent = text;
    });
  }

  /* ---------- schedule (Autopilot) ---------- */
  _phases(rawAdj) {
    if (Array.isArray(this._config.schedule) && this._config.schedule.length) {
      return this._config.schedule.map((p) => ({
        key: p.key || p.label, label: p.label, icon: p.icon || "",
        time_entity: p.time_entity, level_entity: p.level_entity,
        defTime: p.time, defLvl: p.level, adj: Number.isFinite(p.adj) ? p.adj : 0, short: p.short || (p.label || "").slice(0, 4),
      }));
    }
    const pre = this._sc("schedule_prefix") || "eight_sleep_me";
    // adj = smart-autopilot target offset for this phase (relative to the neutral baseline)
    // `adj` is this phase's Autopilot offset from the neutral baseline. It defaults to the
    // constant below, but an input_number.<ap_offset_prefix>_<key> helper overrides it when one
    // exists — which is what makes the Tuning screen's per-phase steppers real rather than
    // decorative: editing one moves this card's whole predicted curve (the chart, the phase
    // chips, "rest of night") immediately. What still waits on the HA side is the temperature
    // actually applied to the bed, which comes from the suggested_temp template sensor.
    const offPre = this._config.ap_offset_prefix;
    const adjFor = (key, def) => {
      if (rawAdj) return def;
      const e = offPre && this._hass && this._hass.states[`${offPre}_${key}`];
      if (!e) return def;
      const v = parseFloat(e.state);
      return Number.isFinite(v) ? v : def;
    };
    const mk = (key, label, icon, defLvl, defC, defTime, adj, short) => ({
      key, label, icon,
      time_entity: `input_datetime.${pre}_${key}`,
      level_entity: `input_number.${pre}_${key}_level`,
      defLvl, defC, defTime, adj: adjFor(key, adj), short,
    });
    return [
      mk("bedtime", "Bedtime", "bed", -3, 23, "22:00", 2, "Bed"),
      mk("winddown", "Wind-down", "", -2, 27, "22:15", 1, "Wind"),
      mk("early", "Early", "", -2, 25, "23:00", 0.5, "Early"),
      mk("late", "Late", "", 0, 28, "02:00", -1, "Late"),
      mk("deep", "Deep", "", -1, 25, "03:30", -2.5, "Deep"),
      mk("prewake", "Pre-wake", "", 1, 30, "07:30", 0.5, "Pre"),
      mk("wake", "Wake", "alarm", 1, 30, "08:30", 2, "Wake"),
    ];
  }

  /* ---------- smart autopilot (weather-driven suggestion) ---------- */
  _smartOn() {
    const id = this._sc("smart_entity");
    const e = id && this._hass.states[id];
    return !!e && e.state === "on";
  }
  // Clamp predicted temps to the allowed band. It used to also SNAP them — to 0.5° on
  // free-sleep, 1° on cloud. The 0.5° snap is gone: the Pod's real grid is whole °F, so
  // snapping to halves matched nothing and flattened small environmental moves out of the
  // predicted curve entirely. Keep a tenth of a degree and let the hardware round.
  _clampT(v) {
    const step = this._config.half_degree_via_heat_set === false ? 10 : 1;
    return Math.max(22, Math.min(40, Math.round(v * step) / step));
  }
  _nowMins() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
  _phaseMins(p) {
    const s = this._hass.states[p.time_entity];
    const hm = this._fmtHM(s ? s.state : p.defTime);
    return hm ? hm.mins : 0;
  }
  _condLabel(c) {
    if (!c) return "";
    return String(c).replace(/-(night|day)$/, "").replace(/-/g, " ").replace(/^\w/, (m) => m.toUpperCase());
  }
  // environmental model — mirrors the sensor.eight_sleep_<name>_suggested_temp Jinja
  _smartModel() {
    const st = this._hass.states, cfg = this._config;
    const w = st[cfg.weather_entity];
    const Tout = w && Number.isFinite(w.attributes.temperature) ? w.attributes.temperature : 15;
    const cond = w ? w.state : "";
    const numOf = (e, f) => { const s = e && st[e]; const v = s ? parseFloat(s.state) : NaN; return isNaN(v) ? f : v; };
    const Troom = numOf(cfg.room_temp_entity, 20);
    const Hroom = numOf(cfg.room_humidity_entity, 50);
    const m = new Date().getMonth() + 1;
    const inm = (a) => a.indexOf(m) >= 0;
    const season = inm([12, 1, 2]) ? -3 : inm([6, 7, 8]) ? 3 : inm([3, 4, 5]) ? -0.5 : 0.5;
    const seasonName = inm([12, 1, 2]) ? "Summer" : inm([6, 7, 8]) ? "Winter" : inm([3, 4, 5]) ? "Autumn" : "Spring";
    const cl = (v, a, b) => Math.max(a, Math.min(b, v));
    const outsideAdj = cl((16 - Tout) * 0.22, -3.5, 3.5);
    const roomAdj = cl((20 - Troom) * 0.35, -3.5, 3.5);
    const humidAdj = cl((50 - Hroom) * 0.03, -1.5, 1.5);
    const bias = this._bias();
    const sug = st[this._sc("suggested_entity")];
    const envBase = sug && Number.isFinite(parseFloat(sug.attributes.env_base))
      ? parseFloat(sug.attributes.env_base) : (29 + season + outsideAdj + roomAdj + humidAdj + bias);
    const boost = sug && Number.isFinite(parseFloat(sug.attributes.boost)) ? parseFloat(sug.attributes.boost) : 0;
    const rate = sug && Number.isFinite(parseFloat(sug.attributes.rate)) ? parseFloat(sug.attributes.rate) : 0;
    return { Tout, cond, Troom, Hroom, season, seasonName, outsideAdj, roomAdj, humidAdj, bias, envBase, boost, rate };
  }
  // current sleep-phase adjustment (°C) + name — the last phase whose start time has passed
  _phaseAt(cur) {
    const P = this._phases();
    const bt = this._phaseMins(P[0]);
    const rel = (x) => ((((x || 0) - bt) % 1440) + 1440) % 1440;
    const relcur = rel(cur);
    let best = P[0];
    for (const p of P) { if (rel(this._phaseMins(p)) <= relcur) best = p; }
    return { adj: best.adj, name: best.label };
  }
  _suggested() {
    const sid = this._sc("suggested_entity");
    const s = sid && this._hass.states[sid];
    if (s) { const v = parseFloat(s.state); if (!isNaN(v)) return v; }
    // JS fallback (no live sensor configured): v2's ramp-blended curve, not a flat phase step
    const S = this._smartSegments();
    const relNow = ((this._nowMins() - S[0].mins) % 1440 + 1440) % 1440;
    return this._clampT(this._smartTempAtRel(relNow, S));
  }
  // fetch + cache the hourly weather forecast (for predicting temps at upcoming phase times)
  _ensureForecast() {
    if (!this._hass || !this._config.weather_entity || !this._hass.callWS) return;
    const now = Date.now();
    if (this._fcAt && now - this._fcAt < 30 * 60 * 1000) return;   // 30-min cache
    this._fcAt = now;
    this._hass.callWS({
      type: "call_service", domain: "weather", service: "get_forecasts",
      service_data: { type: "hourly" }, target: { entity_id: this._config.weather_entity },
      return_response: true,
    }).then((res) => {
      const r = res && res.response && res.response[this._config.weather_entity];
      const list = r && r.forecast;
      if (Array.isArray(list)) {
        this._forecast = list.map((f) => ({ t: new Date(f.datetime).getTime(), temp: f.temperature,
                                            cond: f.condition }))
          .filter((f) => Number.isFinite(f.temp));
        this._updateSmart();
      }
    }).catch(() => {});
  }
  // fetch + cache the last 3h of room temp for the tiny "Room temp" sparkline in the factor
  // breakdown — a glanceable trend, right there in the factor list
  _ensureRoomSpark(force) {
    const ent = this._config.room_temp_entity;
    if (!ent || !this._hass || !this._hass.callWS) return;
    const now = Date.now();
    if (!force && this._roomSparkAt && now - this._roomSparkAt < 10 * 60 * 1000) return;   // 10-min cache
    this._roomSparkAt = now;
    const end = new Date(), start = new Date(end.getTime() - 3 * 3600000);
    this._hass.callWS({
      type: "history/history_during_period",
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      entity_ids: [ent],
      minimal_response: true,
      no_attributes: true,
      significant_changes_only: false,
    }).then((res) => {
      const pts = this._parseHist((res && res[ent]) || [])
        .map((s) => parseFloat(s.state)).filter(Number.isFinite);
      this._roomSpark = pts.length >= 2 ? pts : null;
      this._updateSmart();
    }).catch(() => {});
  }
  _roomSparkSVG() {
    const pts = this._roomSpark;
    if (!pts || pts.length < 2) return "";
    const w = 46, h = 18, pad = 2;
    const min = Math.min(...pts), max = Math.max(...pts), span = (max - min) || 1;
    const step = (w - pad * 2) / (pts.length - 1);
    const path = pts.map((v, i) => {
      const x = pad + i * step;
      const y = pad + (1 - (v - min) / span) * (h - pad * 2);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    const delta = pts[pts.length - 1] - pts[0];
    const cls = delta > 0.3 ? "warm" : delta < -0.3 ? "cool" : "neutral";
    return `<svg class="sm-spark ${cls}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><path d="${path}" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  _outsideAt(ts) {
    const fc = this._forecast;
    if (fc && fc.length) {
      let best = fc[0], bd = Math.abs(fc[0].t - ts);
      for (const f of fc) { const d = Math.abs(f.t - ts); if (d < bd) { bd = d; best = f; } }
      return best.temp;
    }
    const w = this._hass.states[this._config.weather_entity];
    return w && Number.isFinite(w.attributes.temperature) ? w.attributes.temperature : 15;
  }
  // Autopilot v2 — predictive pre-conditioning. Estimates how fast the BED (not the room)
  // actually moves toward a new target, so the schedule can start ramping EARLY and arrive
  // at each phase's number BY the scheduled time instead of only starting to move then.
  // Historic-data input: a derivative helper on the real bed-temperature sensor (°C/h, the
  // same pattern as the existing sensor.<room>_temp_rate) — configure via
  // `bed_warm_rate_entity` / `bed_cool_rate_entity`. Falls back to a conservative default
  // (9°C/h warming, 7.2°C/h cooling — Pod heat/cool asymmetry) until that helper exists.
  _bedRampRate(dir) {
    const id = dir === "warm" ? this._config.bed_warm_rate_entity : this._config.bed_cool_rate_entity;
    const e = id && this._hass.states[id];
    const v = e ? Math.abs(parseFloat(e.state)) : NaN;
    const perHour = Number.isFinite(v) && v > 0.5 ? v : (dir === "warm" ? 9 : 7.2);
    return perHour / 60;   // °C per minute
  }
  // minutes to start ramping before a phase boundary so the bed is AT that phase's target
  // right when the boundary hits, capped so a huge jump doesn't eat the whole previous phase
  _leadMinutesFor(fromTemp, toTemp, prevSpanMin) {
    const delta = toTemp - fromTemp;
    if (Math.abs(delta) < 0.3) return 0;
    const rate = this._bedRampRate(delta > 0 ? "warm" : "cool");
    const lead = Math.abs(delta) / rate;
    return Math.max(0, Math.min(lead, 90, Math.max(0, prevSpanMin - 5)));
  }
  _envBaseFor(Tout) {
    const M = this._smartModel();
    const oa = Math.max(-3.5, Math.min(3.5, (16 - Tout) * 0.22));
    return 29 + M.season + oa + M.roomAdj + M.humidAdj + M.bias;
  }
  // next wall-clock timestamp for a given minute-of-day (today if still ahead, else tomorrow)
  _boundaryTs(mins) {
    const now = new Date();
    const d = new Date(now); d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
    if (d.getTime() < now.getTime() - 60000) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  // each schedule phase with its forecast-predicted target temp (chronological), PLUS how many
  // minutes early Autopilot v2 starts ramping toward it so the bed is actually at that number by
  // the scheduled time (not just starting to move then) — the "predictive pre-conditioning" model.
  _smartSegments() {
    const P = this._phases();
    const bt = this._phaseMins(P[0]);
    const rel = (x) => ((((x || 0) - bt) % 1440) + 1440) % 1440;
    const segs = P.map((p) => {
      const mins = this._phaseMins(p);
      const ts = this._boundaryTs(mins);
      const temp = this._clampT(this._envBaseFor(this._outsideAt(ts)) + p.adj);
      return { key: p.key, label: p.label, short: p.short, mins, adj: p.adj, rel: rel(mins), ts, temp };
    });
    segs.forEach((s, i) => {
      if (i === 0) { s.leadMin = 0; s.rampFrom = s.temp; return; }
      const prev = segs[i - 1];
      const prevSpanMin = (s.rel - prev.rel + 1440) % 1440 || 1440;
      s.leadMin = this._leadMinutesFor(prev.temp, s.temp, prevSpanMin);
      s.rampFrom = prev.temp;
    });
    return segs;
  }
  // the predicted bed temp at an arbitrary point in the night (minutes-since-bedtime), following
  // the same ramp-early-then-hold curve the chart draws — used to blend the live "now" value
  // through a pre-conditioning window instead of jumping the instant a phase boundary passes
  _smartTempAtRel(relMin, segs) {
    const S = segs || this._smartSegments();
    let seg = S[0];
    for (const s of S) { if (s.rel <= relMin) seg = s; }
    const i = S.indexOf(seg);
    const next = S[i + 1];
    if (next && next.leadMin > 0) {
      const rampStart = next.rel - next.leadMin;
      if (relMin >= rampStart) {
        const frac = Math.max(0, Math.min(1, (relMin - rampStart) / next.leadMin));
        return seg.temp + (next.temp - seg.temp) * frac;
      }
    }
    return seg.temp;
  }
  // upcoming temp changes (phases still ahead tonight), each with predicted temp
  _upcomingChanges() {
    const now = Date.now();
    const S = this._smartSegments();
    const wakeTs = S[S.length - 1].ts;            // cap at the current night's wake
    return S.filter((s) => s.ts > now - 60000 && s.ts <= wakeTs)
      .sort((a, b) => a.ts - b.ts)
      .slice(0, 7);
  }
  // factor breakdown that explains the current suggestion (the "why") — contributions sum to it
  // The factor breakdown as DATA — one model, two renderers. Classic renders it as labelled rows
  // (_factorsHTML); the v2 Autopilot tab renders the same array as a zero-centred waterfall
  // (_apWaterfallHTML), where each factor is a bar off one baseline: left cooler, right warmer.
  // Both must agree, so neither computes its own factors.
  //
  // NOTE this is still a client-side re-derivation of the suggested_temp template sensor's Jinja
  // (see _smartModel) — the sensor only publishes the summed `env_base`. When the sensor is
  // taught to publish each factor as its own attribute, this method becomes a read of those
  // attributes and _smartModel() goes away entirely.
  _smartFactors() {
    const M = this._smartModel();
    const ph = this._phaseAt(this._nowMins());
    const w = this._hass.states[this._config.weather_entity];
    const dew = w && Number.isFinite(w.attributes.dew_point) ? Math.round(w.attributes.dew_point) : null;
    const F = [
      { label: "Base", detail: "neutral baseline", adj: 0, disp: "29°", base: true },
      { label: "Season", detail: M.seasonName, adj: M.season },
      { label: "Outside", detail: `${Math.round(M.Tout)}° · ${this._condLabel(M.cond) || "—"}`, adj: M.outsideAdj },
      { label: "Room temp", detail: `${Math.round(M.Troom)}°`, spark: true, adj: M.roomAdj },
      { label: "Humidity", detail: `${Math.round(M.Hroom)}%${dew != null ? ` · dew ${dew}°` : ""}`, adj: M.humidAdj },
      // "Time of night" — deliberately NOT "Sleep phase": this is a clock-time schedule curve
      // (bedtime/wind-down/deep/wake etc.), not a detected sleep stage. There's no reliable way
      // to measure real sleep stages here, so v2 never claims to.
      { label: "Time of night", detail: ph.name, adj: ph.adj },
    ];
    if (Math.abs(M.boost) >= 0.4)
      F.push({ label: "Reactive", detail: M.rate < 0 ? "room cooling fast" : "room warming fast", adj: M.boost });
    // when currently inside a pre-conditioning ramp, say so explicitly and show what it's adding
    // on top of the "Time of night" row above — this IS the predictive part of the model
    const S = this._smartSegments();
    const relNow = ((this._nowMins() - S[0].mins) % 1440 + 1440) % 1440;
    let seg = S[0]; for (const x of S) { if (x.rel <= relNow) seg = x; }
    const next = S[(S.indexOf(seg) + 1) % S.length];
    if (next && next.leadMin >= 1) {
      const rampStart = next.rel - next.leadMin;
      if (relNow >= rampStart) {
        const frac = Math.max(0, Math.min(1, (relNow - rampStart) / next.leadMin));
        const now = seg.temp + (next.temp - seg.temp) * frac;
        F.push({ label: "Pre-conditioning", detail: `ramping to ${next.label} early, ${Math.round(next.leadMin)} min lead`, adj: now - seg.temp });
      }
    }
    if (M.bias) F.push({ label: "Your adjust", detail: "manual offset", adj: M.bias });
    return F;
  }
  _factorsHTML() {
    return this._smartFactors().map((f) => {
      const detail = f.detail + (f.spark ? this._roomSparkSVG() : "");
      const disp = f.disp != null ? f.disp : (f.adj > 0 ? "+" : "") + f.adj.toFixed(1);
      return `<div class="sm-frow"><span class="sm-fl">${f.label}</span><span class="sm-fd">${detail}</span>` +
        `<span class="sm-fv ${f.adj > 0 ? "warm" : f.adj < 0 ? "cool" : "neutral"}">${disp}</span></div>`;
    }).join("");
  }
  // extra useful context readouts (don't affect the sum)
  // v2 only: one plain-language line for the Autopilot strip ("Holding 35° · 34° at 9:30pm · See why")
  _autopilotLineHTML() {
    const bits = [];
    const sug = this._suggested();
    if (Number.isFinite(sug)) bits.push(`Holding <b>${this._fmtVal(sug)}</b>`);
    const up = this._upcomingChanges();
    if (up && up.length) {
      const u = up[0];
      const hm = this._fmtHM(String(Math.floor(u.mins / 60)).padStart(2, "0") + ":" + String(u.mins % 60).padStart(2, "0"));
      bits.push(`${this._fmtVal(u.temp)} at ${hm ? hm.t + hm.ap : u.label.toLowerCase()}`);
    }
    return `${bits.join(" \u00b7 ")} <span class="sl-why">See why</span>`;
  }
  _smartContextHTML() {
    const S = this._smartSegments();
    const wakeTs = S[S.length - 1].ts;
    const mins = Math.max(0, Math.round((wakeTs - Date.now()) / 60000));
    const M = this._smartModel();
    const parts = [`Bed now <b>${this._fmtVal(this._curTemp())}</b>`, `Wake in <b>${this._fmtDur(mins * 60)}</b>`];
    if (Math.abs(M.rate) >= 0.5) parts.push(`Room ${M.rate < 0 ? "cooling" : "warming"} <b>${Math.abs(M.rate).toFixed(1)}°/h</b>`);
    return parts.map((p) => `<span>${p}</span>`).join("");
  }
  _comingUpRowsHTML() {
    const up = this._upcomingChanges();
    const rows = up.map((u) => {
      const hm = this._fmtHM(String(Math.floor(u.mins / 60)).padStart(2, "0") + ":" + String(u.mins % 60).padStart(2, "0"));
      const dcls = u.temp > 27 ? "warm" : u.temp < 27 ? "cool" : "mid";
      // v2: show WHEN it actually starts ramping, not just when it's "due" — pre-conditioning
      // means the bed is meant to already be there by the time shown, not just starting then
      let lbl = u.label;
      if (u.leadMin >= 1) {
        const rampMins = Math.round(u.mins - u.leadMin);
        const rhm = this._fmtHM(String(Math.floor(((rampMins % 1440) + 1440) % 1440 / 60)).padStart(2, "0") + ":" + String(Math.round(rampMins) % 60).padStart(2, "0"));
        lbl += rhm ? ` · starts ${rhm.t}${rhm.ap}` : "";
      }
      return `<div class="sm-up-row"><span class="sm-up-t">${hm ? hm.t + hm.ap : ""}</span><span class="sm-up-ph">${lbl}</span><span class="sm-up-v ${dcls}">${this._fmtVal(u.temp)}</span></div>`;
    }).join("");
    return rows || `<div class="sm-up-empty">No more changes tonight</div>`;
  }
  _toggleSmart() {
    const id = this._sc("smart_entity"); if (!id || !this._hass) return;
    this._haptic("medium");
    const turningOn = !this._smartOn();
    // Enabling Autopilot = "take over now". Clear any Heat Boost on this side so a
    // still-on boost_active helper (e.g. a boost whose in-page revert timer died when
    // the tab closed) can't keep suppressing the HA-side apply automation.
    if (turningOn) {
      const clim = this._activeEntity();
      this._endBoost(clim, false);                    // tears down local boost state, if any
      const bHelper = this._sc("boost_active_entity");
      if (bHelper && this._hass.states[bHelper] && this._hass.states[bHelper].state === "on") {
        this._hass.callService("input_boolean", "turn_off", { entity_id: bHelper });
        this._setBoostUntil(clim, Date.now());        // collapse the failsafe window
      }
    }
    this._hass.callService("input_boolean", "toggle", { entity_id: id });
    // Don't wait for the HA apply automation (or its next 15-min tick) — drive the setpoint to
    // the suggested temp right now, optimistically, so the card + bed react near-instantly.
    if (turningOn) {
      const sug = this._suggested();
      if (Number.isFinite(sug)) {
        this._ensureOn();
        this._overrideTemp = sug;
        this._pendingTemp = sug;
        this._applyTemp(sug);
      }
      this._update();
    }
  }
  _autoOffOn() {
    const id = this._sc("auto_off_toggle_entity");
    const e = id && this._hass.states[id];
    return !!e && e.state === "on";
  }
  _toggleAutoOff() {
    const id = this._sc("auto_off_toggle_entity"); if (!id || !this._hass) return;
    this._haptic("light");
    this._hass.callService("input_boolean", "toggle", { entity_id: id });
  }

  /* ---------- priming / water status ---------- */
  _stateStr(id) { const e = id && this._hass.states[id]; return e ? String(e.state) : ""; }
  // true/false for a sensor that may report the cloud "True"/"False" strings OR a
  // free-sleep binary_sensor's "on"/"off" — "" (missing) is neither.
  _truthyState(id) {
    const s = this._stateStr(id).toLowerCase();
    if (s === "") return null;
    return s === "true" || s === "on" || s === "1" || s === "yes";
  }
  _primingRaw() { return this._truthyState(this._config.priming_entity) === true; }
  // optimistic: prime/cancel don't reflect on the cloud sensor for up to a minute, so
  // hold the state we asked for until the real sensor catches up (or the safety timeout fires)
  _primingOn() { return this._pendingPrime != null ? this._pendingPrime : this._primingRaw(); }
  _markPendingPrime(state) {
    this._pendingPrime = state;
    if (this._primeTimer) clearTimeout(this._primeTimer);
    this._primeTimer = setTimeout(() => { this._pendingPrime = null; this._primeTimer = null; this._update(); }, 120000);
  }
  _needPriming() { return this._truthyState(this._config.need_priming_entity) === true; }
  _hasWater() {
    const t = this._truthyState(this._config.has_water_entity);
    if (t === null) return true;                                   // no sensor → assume fine
    return this._config.has_water_invert ? !t : t;                 // problem-class sensor: on = LOW
  }
  _lastPrimeAgo() {
    const e = this._config.last_prime_entity && this._hass.states[this._config.last_prime_entity];
    const t = e ? Date.parse(e.state) : NaN;
    if (isNaN(t)) return null;
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }
  // Prime: ask to confirm first (priming circulates water ~10 min), then call eight_sleep.prime_pod
  _startPrime() {
    this._haptic("light");
    this._openConfirm({
      title: "Prime the Pod",
      message: "This circulates water for a few minutes to clear air bubbles. Start priming now?",
      confirmLabel: "Start priming",
      icon: ICON_DROP,
      onConfirm: () => {
        const btn = this._config.prime_button_entity;
        const id = this._config.prime_target_entity;
        if (btn && this._hass) this._hass.callService("button", "press", { entity_id: btn });
        else if (id && this._hass) this._hass.callService("eight_sleep", "prime_pod", { entity_id: id });
        this._markPendingPrime(true);   // show "Priming…" immediately (cloud lags ~1 min)
        this._update();
        this._haptic("success");
      },
    });
  }
  // Cancel priming: Eight Sleep has no "stop prime" API, so turn the side(s) off to abort the cycle
  _cancelPrime() {
    if (!this._hass) return;
    this._haptic("medium");
    this._openConfirm({
      title: "Stop priming",
      message: "There's no dedicated stop, so this turns the bed off to interrupt the priming cycle. Stop now?",
      confirmLabel: "Stop priming",
      icon: ICON_POWER,
      tone: "danger",
      onConfirm: () => {
        const ents = [this._config.entity];
        if (this._partnerOn() && this._config.partner_climate_entity) ents.push(this._config.partner_climate_entity);
        ents.forEach((e) => e && this._hass.callService("climate", "turn_off", { entity_id: e }));
        this._markPendingPrime(false);  // clear "Priming…" immediately, don't wait for cloud
        this._markPendingOn(false);     // bed is going off too
        this._update();
      },
    });
  }
  // lightweight confirmation dialog (reuses the picker overlay, centred instead of docked — see .picker-ov.confirm)
  _openConfirm({ title, message, confirmLabel, onConfirm, icon, tone }) {
    const ov = this.shadowRoot.getElementById("pickerOverlay");
    if (!ov) return;
    // a still-pending removal from a just-closed dialog (see _closePicker) would otherwise strip
    // "confirm" off THIS dialog ~340ms in, snapping it from centred back to bottom-docked
    clearTimeout(this._pkModeTimer);
    const inner = ov.querySelector(".pk-sheet");
    const accentRgb = tone === "danger" ? "255,90,82" : "111,140,255";
    inner.innerHTML = `
      <div class="pk-confirm-badge" style="--pk-accent:${accentRgb}">${icon || ICON_SPARK}</div>
      <div class="pk-title pk-confirm-title">${escapeHtml(title || "Confirm")}</div>
      <div class="pk-msg">${escapeHtml(message || "")}</div>
      <div class="pk-actions">
        <button class="pk-btn ghost" data-act="cancel">Cancel</button>
        <button class="pk-btn save${tone === "danger" ? " danger" : ""}" data-act="ok">${escapeHtml(confirmLabel || "Confirm")}</button>
      </div>`;
    inner.onclick = (e) => {
      const b = e.target.closest("[data-act]"); if (!b) return;
      e.stopPropagation();
      if (b.dataset.act === "ok") { try { onConfirm && onConfirm(); } catch (_) {} }
      this._closePicker();
    };
    ov.onclick = (e) => { if (e.target === ov && !this._swallowHoldRelease()) this._closePicker(); };
    // a still-present "modal" from a just-closed picker (its own removal not yet due — see
    // _closePicker) would otherwise coexist with "confirm" and fight it for .pk-sheet's sizing
    ov.classList.remove("modal");
    ov.classList.add("confirm");     // centred modal, not a bottom sheet
    void ov.offsetHeight;
    ov.classList.add("open");
  }

  /* ---------- dual-side control (this side vs partner) ---------- */
  // visual state for ONE climate entity (used to paint each bed half independently)
  _sideVisual(entityId) {
    const c = this._hass.states[entityId];
    const on = !!c && !["off", "unavailable", "unknown"].includes(c.state);
    const a = (c && c.attributes) || {};
    const { min, max } = this._range();
    const mid = this._midTemp();
    const tgt = Number.isFinite(a.temperature) ? a.temperature : (min + max) / 2;
    const cur = Number.isFinite(a.current_temperature) ? a.current_temperature : tgt;
    const d = Math.round(tgt) - Math.round(mid);
    let dir = d > 0 ? "warm" : d < 0 ? "cool" : "mid";
    if (this._config.reactive_bed === false) dir = "cool";
    const gap = Math.abs(tgt - cur);
    const working = on && (a.hvac_action === "heating" || a.hvac_action === "cooling" || gap > 1.2);
    const span = tgt >= mid ? (max - mid) : (mid - min);
    const intensity = span > 0 ? Math.pow(Math.min(1, Math.abs(tgt - mid) / span), 0.6) : 0;
    const waveDur = (Math.round((6 - Math.min(gap, 8) / 8 * 3.8) * 2) / 2).toFixed(1) + "s";
    return { on, dir, working, intensity, waveDur, occ: this._presenceOn(entityId) };
  }
  // is someone in this side of the bed? maps a climate entity to its presence binary_sensor
  // (own side vs partner) and reads it. Missing / unavailable entity → false.
  _presenceOn(entityId) {
    const pe = entityId === this._config.partner_climate_entity
      ? this._config.partner_presence_entity
      : this._config.presence_entity;
    const s = pe && this._hass.states[pe];
    return !!s && s.state === "on";
  }
  // set an inline style/property only when the value actually changes
  _sty(el, prop, val) {
    if (!el) return;
    const c = el.__esSty || (el.__esSty = {});
    if (c[prop] === val) return;
    c[prop] = val;
    if (prop.startsWith("--")) el.style.setProperty(prop, val);
    else el.style[prop] = val;
  }
  _clip(el, poly) {
    this._sty(el, "clipPath", poly);
    this._sty(el, "webkitClipPath", poly);
  }
  _paintHalf(fx, vis) {
    if (!fx) return;
    const set = GLOW[vis.on ? vis.dir : "off"] || GLOW.off;
    for (const k in set) this._sty(fx, "--es-" + k, set[k]);
    this._sty(fx, "--es-wave-dur", vis.waveDur);
    fx.classList.toggle("is-off", !vis.on);
    fx.classList.toggle("is-working", vis.working);
    fx.classList.toggle("is-warm", vis.on && vis.dir === "warm");
    fx.classList.toggle("is-mid", vis.on && vis.dir === "mid");
    fx.classList.toggle("is-cool", vis.on && vis.dir === "cool");
    // v10.8: presence — its own amber "body print" light, colour-independent of the climate
    fx.classList.toggle("is-occupied", vis.on && vis.occ);
    // v10.8: one-shot bright sweep when the target direction changes while ON (a gentle
    // hand-off from the old colour to the new — the field colour itself cross-fades via
    // the --es-dot CSS transition). Keyed per fx element so each half fires independently.
    const dk = vis.on ? vis.dir : "off";
    if (fx.__esDir && fx.__esDir !== dk && vis.on && dk !== "off") {
      fx.classList.remove("commit-up", "commit-dn");
      void fx.offsetWidth;
      fx.classList.add(dk === "warm" ? "commit-up" : "commit-dn");
    }
    fx.__esDir = dk;
  }
  // the wide soft glow the bed throws at the room — one per side, dimmed when off
  _paintRoomGlow(visL, visR, split) {
    const col = (v) => (v.on ? (GLOW[v.dir] || GLOW.off).bright : "");
    const gl = this.shadowRoot.querySelector(".bed-glow.g-l");
    const gr = this.shadowRoot.querySelector(".bed-glow.g-r");
    if (gl) { this._sty(gl, "--gc", col(visL)); this._sty(gl, "opacity", visL.on ? "" : "0"); }
    if (gr) {
      const v = split ? visR : visL;
      this._sty(gr, "--gc", col(v));
      this._sty(gr, "opacity", v.on ? "" : "0");
    }
  }
  _polyPath(polyStr) {
    const pts = (polyStr || "").split(",").map((s) => s.trim().split(/\s+/).map(parseFloat)).filter((p) => p.length === 2 && !isNaN(p[0]));
    return pts.length ? "M" + pts.map((p) => `${p[0]} ${p[1]}`).join(" L") + " Z" : "";
  }
  _setEdge(grp, d, color, show) {
    if (!grp) return;
    grp.style.display = show ? "" : "none";
    if (!show) return;
    grp.style.setProperty("--edge-c", color);
    grp.querySelectorAll("path").forEach((p) => p.setAttribute("d", d));
  }
  // the 4 corners [TL,TR,BR,BL] of a mattress polygon, in %
  _cornersOf(polyStr) {
    const pts = (polyStr || "").split(",").map((s) => s.trim().split(/\s+/).map(parseFloat)).filter((p) => p.length === 2 && !isNaN(p[0]));
    if (!pts.length) return null;
    const pick = (fn) => pts.reduce((a, b) => (fn(b) < fn(a) ? b : a));
    const TL = pick((p) => p[0] + p[1]), BR = pick((p) => -(p[0] + p[1]));
    const TR = pick((p) => -(p[0] - p[1])), BL = pick((p) => p[0] - p[1]);
    return [TL, TR, BR, BL];
  }
  _mattressCorners() {
    if (!this._matCorners) this._matCorners = this._cornersOf(this._config.glow_poly);
    return this._matCorners;
  }
  /* ---- "Tide": the dot field -------------------------------------------------
     Every dot's POSITION is projected onto the mattress quad. A CSS-warped
     background cannot do this: a projective map that carries a square texture onto
     a trapezoid shears the texture's circles into lozenges. Positions warp, shape
     does not.

     The field is built ONCE as a white data: URI and used as a static CSS MASK for
     both dot layers. Nothing about the mask ever animates, so the browser rasterises
     it a single time; colour comes from the layers underneath it (so it also follows
     --es-dot's colour transition without a rebuild), and the wave is a small gradient
     band moved with a transform inside the masked layer. Everything that moves is a
     transform or an opacity on a leaf element — see v9.6 in DEV-NOTES for what this
     replaced and why. */
  _dotField(cornersPct, cols, rows) {
    const AR = this._bedAR || 234 / 420;                     // h/w of the bed photo
    const VW = 1000, VH = Math.round(VW * AR);
    const px = (p) => [p[0] / 100 * VW, p[1] / 100 * VH];
    const [TL, TR, BR, BL] = cornersPct.map(px);
    const t = homographyT(1, 1, [TL[0], TL[1], TR[0], TR[1], BL[0], BL[1], BR[0], BR[1]]);
    // the quad is the four EXTREME points of the outline polygon, so its straight edges
    // fall slightly inside the polygon's rounded corners. Generate past it (OUT) and let
    // the layer's real clip-path — the exact same outline the glow always used — do the
    // bounding, so the field reaches the mattress edge instead of stopping short of it.
    const OUT = 0.04, K = 0.42;
    const sAt = (i) => -OUT + (1 + 2 * OUT) * (i + 0.5) / cols;
    const tAt = (j) => -OUT + (1 + 2 * OUT) * (j + 0.5) / rows;
    const smooth = (a, b, x) => { const u = Math.min(1, Math.max(0, (x - a) / (b - a))); return u * u * (3 - 2 * u); };
    let d = "";
    for (let j = 0; j < rows; j++) {
      const tv = tAt(j);
      for (let i = 0; i < cols; i++) {
        const sv = sAt(i);
        const P = homoProject(t, sv, tv);
        const Q = homoProject(t, sAt(i + 1 < cols ? i + 1 : i - 1), tv);
        const r = K * (Math.abs(Q[0] - P[0]) || 1);
        // brightness falls off toward the edges of the half, and further toward the
        // head — the field reads as light pooling, not a grid stopping at a border
        const rs = (sv - 0.5) / 0.5, rt = (tv - 0.5) / 0.5;
        const rr = Math.sqrt(rs * rs * 0.92 + rt * rt);
        const e = (1 - 0.86 * smooth(0.44, 1.12, rr)) * (0.52 + 0.48 * Math.max(0, Math.min(1, tv)));
        if (e < 0.045) continue;   // v10.13: cull dimmer edge dots (was .02) — fewer <circle>s in the mask
        d += `<circle cx="${P[0].toFixed(1)}" cy="${P[1].toFixed(1)}" r="${r.toFixed(2)}" opacity="${e.toFixed(2)}"/>`;
      }
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VW} ${VH}" width="${VW}" height="${VH}">`
      + `<defs><radialGradient id="g"><stop offset="0" stop-color="#fff"/><stop offset=".46" stop-color="#fff"/>`
      + `<stop offset=".62" stop-color="#fff" stop-opacity="0"/></radialGradient>`
      + `<g id="d">${d}</g></defs><use href="#d" fill="url(#g)"/></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg).replace(/"/g, "%22")}")`;
  }
  // (re)build the dot fields — only when the quads change (a split flip, or the
  // photo's aspect arriving). Colour is NOT baked in, so a warm/cool flip costs nothing.
  _paintDotFields(split) {
    const img = this.shadowRoot.querySelector(".bed-img");
    if (img && img.naturalWidth) this._bedAR = img.naturalHeight / img.naturalWidth;
    const cFull = this._mattressCorners();
    if (!cFull) return;
    // column count follows the quad's real width, so the dot pitch on screen is the
    // same whether a field covers a half or the whole mattress.
    // v10.8 pushed this to 1.9× / 56 rows and it made the mask a ~5-6k-<circle> SVG —
    // fine on a phone, laggy on the kiosk (weak GPU, the mask has to rasterise for each
    // masked/animated .dfd layer). v10.13: back to 1.3× / 34 (still ~1.3× the pre-v10.8
    // 1.15× / 28), and both are config knobs — bed_fx_density / bed_fx_rows — so the
    // kiosk card can drop them further without a redeploy. The mask is still static,
    // rebuilt only on a quad change.
    const dens = Number.isFinite(+this._config.bed_fx_density) ? +this._config.bed_fx_density : 1.3;
    const rows = Number.isFinite(+this._config.bed_fx_rows) ? Math.max(8, Math.round(+this._config.bed_fx_rows)) : 34;
    const field = (c) => this._dotField(c, Math.max(10, Math.round(Math.abs(c[1][0] - c[0][0]) * dens)), rows);
    // without glow_poly_left/right both halves clip to the SAME full-mattress outline,
    // so a second field would draw an identical copy on top — pure cost, no picture
    const hasHalves = !!(this._config.glow_poly_left && this._config.glow_poly_right);
    const dual = split && hasHalves;
    const key = (dual ? "s" : "f") + "|" + (this._bedAR || 0).toFixed(4);
    if (key === this._dotKey) return;
    this._dotKey = key;
    const apply = (host, url) => {
      if (!host) return;
      this._sty(host, "--dots", url || "none");
      this._sty(host, "display", url ? "" : "none");
    };
    const full = this.shadowRoot.querySelector('.bed-photo-fx[data-half="full"] .bed-dots');
    if (full) { apply(full, field(cFull)); return; }
    apply(this.shadowRoot.querySelector(".half-left .bed-dots"),
          field(dual ? this._cornersOf(this._config.glow_poly_left) : cFull));
    apply(this.shadowRoot.querySelector(".half-right .bed-dots"),
          dual ? field(this._cornersOf(this._config.glow_poly_right)) : null);
  }
  // the field is aspect-based, so a resize changes nothing — only the photo's aspect
  // arriving does. Without this guard every resize tick rebuilt two ~80KB data URIs.
  _warpDots() {
    if (!this._hass) return;
    const img = this.shadowRoot.querySelector(".bed-img");
    const ar = img && img.naturalWidth ? img.naturalHeight / img.naturalWidth : 0;
    if (!ar || Math.abs((this._bedAR || 0) - ar) < 1e-4) return;
    this._bedAR = ar;
    this._dotKey = null;
    this._paintBedHalves();
  }
  // paint both bed halves from their own side's climate (self on own_side, partner on the other)
  _paintBedHalves() {
    const full = this.shadowRoot.querySelector('.bed-photo-fx[data-half="full"]');
    if (full) {                                                          // single-user bed
      const v = this._sideVisual(this._activeEntity());
      this._paintDotFields(false);
      this._sty(full, "--body-dx", (this._config.own_side === "right" ? "19%" : "-19%"));
      this._paintHalf(full, v);
      this._paintRoomGlow(v, v, false);
      const S = this.shadowRoot.querySelector(".sheet-l"), S2 = this.shadowRoot.querySelector(".sheet-r");
      this._clip(S, this._config.glow_poly ? `polygon(${this._config.glow_poly})` : "");
      this._sty(S2, "display", "none");
      return;
    }
    const L = this.shadowRoot.querySelector(".half-left"), R = this.shadowRoot.querySelector(".half-right");
    if (!L && !R) return;
    const split = this._partnerOn();
    const own = this._config.own_side === "right" ? "right" : "left";
    const self = this._config.entity, partner = this._config.partner_climate_entity;
    const entFor = (physHalf) => (physHalf === own ? self : (split && partner ? partner : self));
    // split → each half clipped to its hand-tuned mattress-half polygon; solo → ONE full-mattress
    // glow (left layer fills the whole surface, right hidden) so it doesn't look like two tiles
    const polyFull = this._config.glow_poly ? `polygon(${this._config.glow_poly})` : "";
    const polyL = this._config.glow_poly_left ? `polygon(${this._config.glow_poly_left})` : polyFull;
    const polyR = this._config.glow_poly_right ? `polygon(${this._config.glow_poly_right})` : polyFull;
    this._clip(L, split ? polyL : polyFull);
    this._sty(R, "display", split ? "" : "none");
    if (split) this._clip(R, polyR);
    // the sheet plates follow the same clips, so the darkened area is exactly the surface
    const SL = this.shadowRoot.querySelector(".sheet-l"), SR = this.shadowRoot.querySelector(".sheet-r");
    this._clip(SL, split ? polyL : polyFull);
    this._sty(SR, "display", split ? "" : "none");
    if (split) this._clip(SR, polyR);
    const visL = this._sideVisual(entFor("left")), visR = this._sideVisual(entFor("right"));
    this._paintDotFields(split);
    // horizontal bias for the presence "body print": each half's sleeper sits toward the
    // outer third of the mattress (solo shows the whole bed, so bias L toward its own side)
    this._sty(L, "--body-dx", split ? "-19%" : (own === "right" ? "19%" : "-19%"));
    this._sty(R, "--body-dx", "19%");
    this._paintHalf(L, visL);
    if (split) this._paintHalf(R, visR);
    this._paintRoomGlow(visL, visR, split);
    // per-side rim outlines: each half's edge circles that side in its own temp colour (split);
    // solo → one outline round the whole mattress in this side's colour
    const colOf = (v) => (GLOW[v.on ? v.dir : "off"] || GLOW.off).bright;
    const dFull = this._polyPath(this._config.glow_poly);
    const dL = this._polyPath(this._config.glow_poly_left) || dFull;
    const dR = this._polyPath(this._config.glow_poly_right) || dFull;
    this._setEdge(this.shadowRoot.querySelector(".edge-gL"), split ? dL : dFull, colOf(visL), true);
    this._setEdge(this.shadowRoot.querySelector(".edge-gR"), dR, colOf(visR), split);
  }
  // which portion of the bed this side controls: "full" (solo/both), else "left"/"right"
  _sideMode() {
    const e = this._config.side_state_entity && this._hass.states[this._config.side_state_entity];
    const v = e ? String(e.state).toLowerCase() : "";
    if (v === "left") return "left";
    if (v === "right") return "right";
    return "full";                                   // solo / both / away / unknown → whole bed
  }
  // partner side active? (Dual = each side independent; Solo = this side owns the whole bed)
  _partnerOnReal() {
    const st = this._hass.states;
    // explicit Solo/Dual helper (local MQTT path) — authoritative, since both climates being
    // "on" is ambiguous (could be Solo mirroring the whole bed, or a coincidental Dual match)
    const dm = this._config.dual_mode_entity && st[this._config.dual_mode_entity];
    if (dm && (dm.state === "on" || dm.state === "off")) return dm.state === "on";
    const se = this._config.side_state_entity && st[this._config.side_state_entity];
    const self = se ? String(se.state).toLowerCase() : "";
    // this side's bed-side sensor is authoritative: left/right = split (partner on), solo/both = whole bed (partner OFF)
    if (self === "left" || self === "right") return true;
    if (self === "solo" || self === "both") return false;
    // free-sleep: no bed-side sensor — the partner's Away switch is the split signal
    // (Away off = Dual / partner participating, Away on = Solo / partner parked). Authoritative
    // here because climate.pod_3_* never reports "off" so the climate fallback below always
    // reads "on" and would pin the card to Dual forever.
    const pa = this._config.partner_away_entity && st[this._config.partner_away_entity];
    if (pa && (pa.state === "on" || pa.state === "off")) return pa.state === "off";
    // only when this side's sensor is missing/unknown do we infer from the partner's own signals
    const pe = this._config.partner_side_entity && st[this._config.partner_side_entity];
    if (pe) { const s = String(pe.state).toLowerCase(); if (!["away", "off", "unknown", "unavailable", ""].includes(s)) return true; }
    const pc = this._config.partner_climate_entity && st[this._config.partner_climate_entity];
    if (pc) { const s = String(pc.state).toLowerCase(); if (!["off", "unavailable", "unknown", ""].includes(s)) return true; }
    return false;
  }
  _partnerOn() { return this._pendingPartner != null ? this._pendingPartner : this._partnerOnReal(); }
  // switch which side the controls (temp tile, ring, steppers, power, dial) target
  _setActiveSide(side) {
    const next = side === "partner" ? "partner" : "self";
    if (next === this._activeSide) return;
    this._activeSide = next;
    this._overrideTemp = null; this._pendingTemp = null;   // drop optimistic state from the old side
    clearTimeout(this._halfTempTimer); this._halfTempTimer = null;
    this._haptic("light");
    this._update();
  }
  _togglePartner() {
    if (!this._hass) return;
    const self = this._config.side_state_entity, partner = this._config.partner_side_entity, pClim = this._config.partner_climate_entity;
    this._haptic("medium");
    const on = this._partnerOn();
    // optimistic switch state (the actual left/right split follows the real sensor once the cloud confirms)
    this._pendingPartner = !on;
    if (this._partnerTimer) clearTimeout(this._partnerTimer);
    this._partnerTimer = setTimeout(() => { this._pendingPartner = null; this._partnerTimer = null; this._update(); }, 12000);
    // local MQTT path: Solo/Dual is an explicit helper. Dual → partner half becomes independent;
    // Solo → this side owns the whole bed, so mirror our current on/off + setpoint onto the
    // partner half now (subsequent writes fan out to both via _writeEntities).
    if (this._config.dual_mode_entity) {
      const goingDual = !on;
      this._hass.callService("input_boolean", goingDual ? "turn_on" : "turn_off", { entity_id: this._config.dual_mode_entity });
      const selfSt = this._hass.states[this._config.entity];
      const selfOn = !!selfSt && !["off", "unavailable", "unknown"].includes(selfSt.state);
      const selfTgt = selfSt && selfSt.attributes && selfSt.attributes.temperature;
      if (pClim) {
        const pSt = this._hass.states[pClim];
        const pOn = !!pSt && !["off", "unavailable", "unknown"].includes(pSt.state);
        if (goingDual) {
          if (selfOn && !pOn) this._hass.callService("climate", "turn_on", { entity_id: pClim });
        } else {
          if (selfOn !== pOn) this._hass.callService("climate", selfOn ? "turn_on" : "turn_off", { entity_id: pClim });
          if (selfOn && Number.isFinite(selfTgt)
              && !(pSt && Math.abs((pSt.attributes || {}).temperature - selfTgt) < 0.05))
            this._hass.callService("climate", "set_temperature", { entity_id: pClim, temperature: selfTgt });
        }
      }
      this._activeSide = "self";
      this._update();
      return;
    }
    // old pod_3_* path: no bed-side split — Solo/Dual is just the partner side's Away switch.
    // Dual on → partner Away off (+ heat on) and make sure our own side isn't parked either;
    // Solo → partner Away on. (set_bed_side / partner_side_entity don't exist on this backend.)
    if (this._config.partner_away_entity && !partner) {
      const goingDual = !on;
      this._setSideActive(pClim, goingDual);
      if (goingDual && this._config.away_entity) {
        const d = this._config.away_entity.split(".")[0] === "input_boolean" ? "input_boolean" : "switch";
        this._hass.callService(d, "turn_off", { entity_id: this._config.away_entity });
      }
      this._update();
      return;
    }
    // Two-side control via set_bed_side (the eight_sleep.side_on/side_off shortcuts are broken).
    // KEY: the partner's side only "takes" once this side is off `solo` — while solo owns the whole
    // bed there's no free half to give them. So split MUST be sequenced: this side → own half first,
    // THEN partner → the other half, then turn the partner's heat on.
    const own = this._config.own_side === "right" ? "right" : "left";
    const other = own === "left" ? "right" : "left";
    if (on) {
      // partner off → this side reclaims the whole bed (solo)
      if (pClim) this._hass.callService("climate", "turn_off", { entity_id: pClim });
      if (self) this._hass.callService("eight_sleep", "set_bed_side", { entity_id: self, bed_side_state: "solo" });
    } else {
      // partner on → split, in order
      const step = (fn) => Promise.resolve(fn()).catch(() => {});
      step(() => self && this._hass.callService("eight_sleep", "set_bed_side", { entity_id: self, bed_side_state: own }))
        .then(() => partner && this._hass.callService("eight_sleep", "set_bed_side", { entity_id: partner, bed_side_state: other }))
        .then(() => pClim && this._hass.callService("climate", "turn_on", { entity_id: pClim }))
        .catch(() => {});
    }
    this._update();
  }
  // smart bias (global cooler/warmer offset) — persisted in the bias helper, used by the sensor + model
  _bias() {
    const id = this._sc("smart_bias_entity");
    const e = id && this._hass.states[id];
    const v = e ? parseFloat(e.state) : 0; return isNaN(v) ? 0 : v;
  }
  _adjustBias(delta) {
    const id = this._sc("smart_bias_entity"); if (!id || !this._hass) return;
    this._haptic("light");
    const v = Math.max(-6, Math.min(6, this._bias() + delta));
    this._hass.callService("input_number", "set_value", { entity_id: id, value: v });
  }
  _applySuggested() {
    if (!this._hass) return;
    this._ensureOn();
    this._setTemp(this._suggested());
  }
  _setSmartOpen(v) {
    this._smartOpen = v;
    const ov = this.shadowRoot.getElementById("smartOverlay");
    if (ov) ov.classList.toggle("open", v);
    if (v) this._updateSmart();
  }
  _smartHTML() {
    return `
      <div class="sm-head">
        <button class="sm-close" id="smartClose" aria-label="Close">${ICON_CHEV}</button>
        <div class="ov-title">Smart Autopilot</div>
        <span class="sm-badge" id="smartBadge">Preview</span>
      </div>
      <div class="sm-hero">
        <div class="sm-sug" id="smSug">–</div>
        <div class="sm-sublbl">Suggested bed temp now</div>
      </div>
      <div class="sm-chart" id="smChart"></div>
      <div class="sm-factors" id="smFactors"></div>
      ${this._config.smart_bias_entity ? `
      <div class="sm-bias">
        <div class="sm-bias-l">
          <div class="sm-bias-t">Adjust</div>
          <div class="sm-bias-h">cooler ‹ &nbsp; › warmer</div>
        </div>
        <div class="sm-bias-ctl">
          <span class="circ sm-b" id="smartBiasMinus" aria-label="Cooler">${ICON_MINUS}</span>
          <span class="sm-bias-v" id="smartBiasVal">0°</span>
          <span class="circ sm-b" id="smartBiasPlus" aria-label="Warmer">${ICON_PLUS}</span>
        </div>
      </div>` : ""}
      <div class="sm-actions">
        <button class="chip" id="smartToggle2">Enable auto</button>
        <button class="chip primary" id="smartApply">Apply now</button>
      </div>`;
  }
  /* ---------- v2 Autopilot tab: live telemetry, reasoning, tuning ---------- */

  // °C/h the bed surface is actually moving (a `derivative` helper over the bed temp sensor).
  // Config-only — see bed_rate_entity. Null when unconfigured or non-numeric.
  _bedRate() {
    const id = this._sc("bed_rate_entity");
    const e = id && this._hass.states[id];
    if (!e) return null;
    const v = parseFloat(e.state);
    return isNaN(v) ? null : v;
  }
  // What's stopping Autopilot from driving the bed right now. Autopilot reading "on" is NOT the
  // same as Autopilot driving: the HA-side apply automation is also conditioned on vacation mode
  // being off and no boost running, and neither of those touches the smart_autopilot toggle. A
  // target nothing is applying is the one failure a status card exists to catch.
  _apSuppress() {
    if (!this._smartOn()) return { kind: "off", label: "Autopilot is off", sub: "Your own setting is holding" };
    const vac = this._config.vacation_entity && this._hass.states[this._config.vacation_entity];
    if (vac && vac.state === "on")
      return { kind: "vacation", label: "Paused — vacation mode", sub: "Autopilot resumes when you turn vacation mode off" };
    // the HELPER, not _boostActive(): that only knows about a boost started in this browser
    // session, while the apply automation conditions on the helper — which a boost from the
    // phone, a notification action, or another tab will have set.
    const bId = this._sc("boost_active_entity");
    const bs = bId && this._hass.states[bId];
    if ((bs && bs.state === "on") || this._boostActive(this._activeEntity())) {
      const id = this._sc("boost_until_entity");
      const e = id && this._hass.states[id];
      const t = e && !isNaN(Date.parse(e.state)) ? new Date(e.state) : null;
      const hm = t ? this._fmtHM(String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0")) : null;
      return { kind: "boost", label: "Paused — boost running", sub: hm ? `Autopilot takes back over at ${hm.t}${hm.ap}` : "Autopilot takes back over when the boost ends" };
    }
    return null;
  }
  // clock time the bed reaches the target at the rate it's currently moving. Null when there's no
  // rate sensor, the bed is already there, or it's moving the wrong way (in which case an ETA
  // would be a lie rather than an estimate).
  _apEta(target, cur, rate) {
    if (rate == null) return null;
    const delta = target - cur;
    if (Math.abs(delta) < 0.3) return null;
    if (Math.abs(rate) < 0.15) return null;
    if (Math.sign(delta) !== Math.sign(rate)) return null;      // moving away from the target
    const mins = Math.round((delta / rate) * 60);
    if (mins < 1 || mins > 600) return null;
    const t = new Date(Date.now() + mins * 60000);
    const hm = this._fmtHM(String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0"));
    return { mins, text: hm ? hm.t + hm.ap : `${mins} min` };
  }
  // The convergence rail: where the bed is, where Autopilot wants it, and the gap still to close.
  // Scaled to tonight's own span so the markers use the full width instead of hugging the middle.
  _apRailHTML(target, cur) {
    const S = this._smartSegments();
    const temps = S.map((s) => s.temp).concat([target, cur]);
    let lo = Math.min(...temps) - 1.2, hi = Math.max(...temps) + 1.2;
    if (hi - lo < 4) { const m = (hi + lo) / 2; lo = m - 2; hi = m + 2; }
    const pos = (t) => Math.max(3, Math.min(97, ((t - lo) / (hi - lo)) * 100));
    const pt = pos(target), pc = pos(cur);
    const a = Math.min(pt, pc), b = Math.max(pt, pc);
    const arrived = Math.abs(target - cur) < 0.3;
    return `
      <div class="ap-rail">
        ${arrived ? "" : `<div class="ap-gap" style="left:${a}%;width:${b - a}%"></div>`}
        <div class="ap-tgt" style="left:${pt}%"></div>
        <div class="ap-now${arrived ? " ok" : ""}" style="left:${pc}%"></div>
      </div>
      <div class="ap-railends"><span>${this._fmtVal(lo + 1.2)}</span><span>${this._fmtVal(hi - 1.2)}</span></div>
      <div class="ap-raill">
        <div><span class="k">Target</span><span class="v ${target > 27 ? "warm" : target < 27 ? "cool" : "mid"}">${this._fmtVal(target)}</span></div>
        <div class="r"><span class="k">Bed now</span><span class="v${arrived ? " ok" : ""}">${this._fmtVal(cur)}</span></div>
      </div>`;
  }
  // The reasoning, as a zero-centred waterfall: one baseline, bars left for cooler and right for
  // warmer, width proportional to the largest single factor. The shape of the reasoning reads
  // before any of the numbers do.
  _apWaterfallHTML() {
    const F = this._smartFactors();
    const target = this._suggested();
    const peak = Math.max(0.5, ...F.filter((f) => !f.base).map((f) => Math.abs(f.adj)));
    const rows = F.map((f) => {
      const detail = f.detail + (f.spark ? this._roomSparkSVG() : "");
      const disp = f.disp != null ? f.disp : (f.adj > 0 ? "+" : "") + f.adj.toFixed(1);
      const cls = f.adj > 0 ? "warm" : f.adj < 0 ? "cool" : "neu";
      const w = f.base ? 0 : Math.min(46, (Math.abs(f.adj) / peak) * 46);
      const bar = w < 0.5 ? "" : `<b class="${f.adj > 0 ? "w" : "c"}" style="width:${w.toFixed(1)}%"></b>`;
      return `<div class="ap-wfrow"><div><div class="ap-wfn">${escapeHtml(f.label)}</div><div class="ap-wfd">${detail}</div></div>` +
        `<div class="ap-wfbar">${bar}</div><div class="ap-wfv ${cls}">${disp}</div></div>`;
    }).join("");
    // What the rows themselves add up to. This is the CARD's model, and it can legitimately
    // disagree with the live sensor: the sensor publishes only its summed `env_base`, so
    // _smartModel() re-derives the individual factors from the raw sensors rather than reading
    // them. A sum row that silently disagreed with the number at the top of the tab would be
    // worse than no sum row — so when they diverge, say so instead of quietly picking one.
    const sum = this._clampT(29 + F.reduce((a, f) => a + (f.base ? 0 : f.adj), 0));
    const drift = Math.abs(sum - target) >= 0.5;
    return rows + `<div class="ap-wfrow ap-wfsum"><div><div class="ap-wfn">Adds up to</div></div>` +
      `<div class="ap-wfbar"></div><div class="ap-wfv">${this._fmtVal(sum)}</div></div>` +
      (drift ? `<div class="ap-wfnote">Autopilot is running ${this._fmtVal(target)}. The breakdown above is the card&rsquo;s own reading of the same inputs &mdash; it only publishes the total, so the two can drift.</div>` : "");
  }
  // tonight's phases as chips, current one lit — the plan at a glance under the curve
  _apPhaseChipsHTML() {
    return this._smartSegments().map((s) => {
      const hm = this._fmtHM(String(Math.floor(s.mins / 60)).padStart(2, "0") + ":" + String(s.mins % 60).padStart(2, "0"));
      const cls = s.temp > 27 ? "warm" : s.temp < 27 ? "cool" : "mid";
      const now = s.key === this._apCurrentPhaseKey();
      return `<div class="ap-pchip${now ? " on" : ""}"><div class="t">${hm ? hm.t : ""}</div>` +
        `<div class="d ${now ? "" : cls}">${this._fmtVal(s.temp)}</div></div>`;
    }).join("");
  }
  // Publish tonight's plan to a host that can act on it (the iOS shell turns this into local
  // notifications). Same composed-CustomEvent pattern as _haptic() — the card announces, it
  // doesn't know or care whether anything is listening. Fires only when the plan actually
  // changes, so a native listener isn't re-arming notifications on every state tick.
  _emitSchedule() {
    if (!this._config.smart_entity) return;
    const on = this._smartOn();
    const S = this._smartSegments();
    const last = S.length - 1;
    const items = S.map((s, i) => ({
      key: s.key,
      label: s.label,
      hour: Math.floor(s.mins / 60),
      minute: s.mins % 60,
      temp: s.temp,
      kind: i === 0 ? "bedtime" : i === last ? "wake" : "phase",
    }));
    const sig = JSON.stringify([on, items]);
    if (sig === this._schedSig) return;
    this._schedSig = sig;
    this.dispatchEvent(new CustomEvent("pod-schedule", {
      detail: { enabled: on, items }, bubbles: true, composed: true,
    }));
  }
  _apCurrentPhaseKey() {
    const S = this._smartSegments();
    const relNow = ((this._nowMins() - S[0].mins) % 1440 + 1440) % 1440;
    let seg = S[0]; for (const x of S) { if (x.rel <= relNow) seg = x; }
    return seg.key;
  }
  // Tuning. Every control is gated on its helper existing, so an instance without the helpers
  // just shows the bias segment and nothing else — no empty states, no errors.
  // These steer the MODEL, which lives in the suggested_temp template sensor: creating the helper
  // is only half the work, and until the Jinja reads it the control is cosmetic.
  _apTuningHTML() {
    const st = this._hass.states, c = this._config;
    const has = (id) => !!(id && st[id]);
    // Cadence (v10.32). These two write real helpers that the apply automation reads: the tick
    // gates its /1 trigger (time_pattern takes no template, so the automation runs every minute
    // and a modulo condition decides whether the minute counts), and the deadband is the minimum
    // difference worth sending. The deadband is what makes a fast tick safe — below it the Pod
    // could not move anyway, since it stores whole °F (~0.56 °C).
    let html = "";
    if (has(c.ap_tick_entity) || has(c.ap_deadband_entity)) {
      const tickV = has(c.ap_tick_entity) ? Math.round(parseFloat(st[c.ap_tick_entity].state)) : null;
      const TICKS = [5, 2, 1];
      html += `<div class="ap-tsec"><div class="ap-tlbl">Cadence<span>${tickV != null ? `every ${tickV} min` : ""}</span></div>`;
      if (tickV != null) {
        html += `<div class="ap-trow"><span class="ap-trn">Checks every` +
          `<em class="ap-trsub">How often it may act on a change</em></span>` +
          `<div class="ap-seg" id="apTickSeg" style="grid-template-columns:repeat(${TICKS.length},minmax(0,1fr))">` +
          TICKS.map((m) => `<button class="ap-seg-opt${m === tickV ? " on" : ""}" data-tick="${m}">${m}m</button>`).join("") +
          `</div></div>`;
      }
      if (has(c.ap_deadband_entity)) {
        const db = parseFloat(st[c.ap_deadband_entity].state);
        html += `<div class="ap-trow"><span class="ap-trn">Acts past` +
          `<em class="ap-trsub">Smaller than this and it holds</em></span>` +
          `<span class="ap-step"><button class="ap-stepbtn" data-db="-0.05">&minus;</button>` +
          `<u>${db.toFixed(2)}&deg;</u>` +
          `<button class="ap-stepbtn" data-db="0.05">+</button></span></div>`;
      }
      html += `<div class="ap-thint">The model recomputes every minute. A change acts straight away; the tick is the fallback sweep. Nothing is written unless the difference clears the deadband &mdash; roughly half a step on the Pod&rsquo;s own grid.</div></div>`;
    }
    const resp = c.ap_response_entity;
    if (has(resp)) {
      const opts = st[resp].attributes.options || [];
      const cur = st[resp].state;
      html += `<div class="ap-tsec"><div class="ap-tlbl">Reaction to the room<span>${escapeHtml(cur)}</span></div>` +
        `<div class="ap-seg" id="apRespSeg" style="grid-template-columns:repeat(${opts.length},minmax(0,1fr))">` +
        opts.map((o) => `<button class="ap-seg-opt${o === cur ? " on" : ""}" data-resp="${escapeHtml(o)}">${escapeHtml(o)}</button>`).join("") +
        `</div><div class="ap-thint">${this._respHint(cur)}</div></div>`;
    }
    if (has(c.ap_min_entity) && has(c.ap_max_entity)) {
      const lo = parseFloat(st[c.ap_min_entity].state), hi = parseFloat(st[c.ap_max_entity].state);
      // absolute fence — matches the clamp in _apClick's data-lim handler (22-40)
      const TMIN = 22, TMAX = 40;
      const pct = (v) => Math.max(0, Math.min(100, ((v - TMIN) / (TMAX - TMIN)) * 100));
      const loPct = pct(lo), hiPct = pct(hi);
      const ticks = Array.from({ length: 15 }, () => `<i></i>`).join("");
      html += `<div class="ap-tsec"><div class="ap-tlbl">Temperature range<span>${this._fmtVal(lo)} – ${this._fmtVal(hi)}</span></div>` +
        `<div class="ap-rangetrack">` +
        `<div class="ap-rangegrad"></div>` +
        `<div class="ap-rangeticks">${ticks}</div>` +
        `<div class="ap-rangedim ap-rangedim-lo" style="width:${loPct}%"></div>` +
        `<div class="ap-rangedim ap-rangedim-hi" style="width:${100 - hiPct}%"></div>` +
        `<div class="ap-rangehandle" style="left:${loPct}%">${this._fmtVal(lo)}</div>` +
        `<div class="ap-rangehandle" style="left:${hiPct}%">${this._fmtVal(hi)}</div>` +
        `</div>` +
        `<div class="ap-lims">` +
        `<span class="ap-limg"><span class="ap-limk">Coolest</span><span class="ap-limr">` +
        `<button class="ap-stepbtn" data-lim="min" data-d="-0.5">&minus;</button>` +
        `<span class="ap-limv">${this._fmtVal(lo)}</span>` +
        `<button class="ap-stepbtn" data-lim="min" data-d="0.5">+</button></span></span>` +
        `<span class="ap-limg"><span class="ap-limk">Warmest</span><span class="ap-limr">` +
        `<button class="ap-stepbtn" data-lim="max" data-d="-0.5">&minus;</button>` +
        `<span class="ap-limv">${this._fmtVal(hi)}</span>` +
        `<button class="ap-stepbtn" data-lim="max" data-d="0.5">+</button></span></span>` +
        `</div><div class="ap-thint">Autopilot never takes the bed past these, whatever the plan works out &mdash; a safety fence, not a target. The dimmed ends are off-limits.</div></div>`;
    }
    const sigs = (c.ap_signals || []).filter((s) => has(s.entity));
    if (sigs.length) {
      html += `<div class="ap-tsec"><div class="ap-tlbl">What it listens to<span>${sigs.filter((s) => st[s.entity].state === "on").length} of ${sigs.length} on</span></div>` +
        sigs.map((s) => `<div class="ap-trow"><span class="ap-tri">${apSignalIcon(s.key)}</span>` +
          `<span class="ap-trn">${escapeHtml(s.label)}</span>` +
          `<span class="ap-sw${st[s.entity].state === "on" ? " on" : ""}" data-sig="${escapeHtml(s.entity)}"><i></i></span></div>`).join("") +
        `</div>`;
    }
    const offs = this._phases().map((p) => ({ p, ent: `${c.ap_offset_prefix}_${p.key}` })).filter((o) => has(o.ent));
    if (offs.length) {
      html += `<div class="ap-tsec"><div class="ap-tlbl">Per phase<span>offset from baseline</span></div>` +
        offs.map(({ p, ent }) => {
          const v = parseFloat(st[ent].state) || 0;
          const cls = v > 0 ? "warm" : v < 0 ? "cool" : "neu";
          return `<div class="ap-trow"><span class="ap-trn">${escapeHtml(p.label)}</span>` +
            `<span class="ap-step"><button class="ap-stepbtn" data-off="${escapeHtml(ent)}" data-d="-0.5">&minus;</button>` +
            `<u class="${cls}">${v > 0 ? "+" : ""}${v.toFixed(1)}</u>` +
            `<button class="ap-stepbtn" data-off="${escapeHtml(ent)}" data-d="0.5">+</button></span></div>`;
        }).join("") + `</div>`;
    }
    if (html) html += `<div class="ap-treset" data-reset="1">${V2_ICON_RESET}<span>Reset tuning to defaults</span></div>`;
    return html || `<div class="ap-tempty">Tuning controls appear here once their helpers exist &mdash; see design/autopilot/entity-plumbing.html.</div>`;
  }
  // Outside tonight — the forecast that drives the biggest single term in the model, hour by
  // hour across the night. Lives under the waterfall because it's the evidence for the
  // "Outside" row above it. Renders nothing until _ensureForecast() has landed.
  _apWeatherIcon(cond, night) {
    const c = String(cond || "").toLowerCase();
    if (/rain|pour|shower|hail|snow/.test(c)) return V2_ICON_CLOUDRAIN;
    if (/cloud|overcast|fog/.test(c)) return night ? V2_ICON_CLOUDMOON : V2_ICON_CLOUDSUN;
    if (/partly/.test(c)) return night ? V2_ICON_CLOUDMOON : V2_ICON_CLOUDSUN;
    return night ? V2_ICON_MOON : V2_ICON_SUN;
  }
  _apForecastHTML() {
    const f = this._forecast;
    if (!Array.isArray(f) || !f.length) return "";
    const S = this._smartSegments();
    const endTs = S[S.length - 1].ts;
    const now = Date.now();
    // six points spread across what's left of the night, not the next six hours
    const within = f.filter((x) => x.t >= now - 1800000 && x.t <= endTs + 3600000);
    const pool = within.length >= 3 ? within : f.slice(0, 12);
    const step = Math.max(1, Math.round(pool.length / 6));
    const cells = pool.filter((_, i) => i % step === 0).slice(0, 6);
    if (cells.length < 2) return "";
    return `<div class="ap-fcwrap"><div class="ap-fchd">Outside tonight<span>met.no</span></div>
      <div class="ap-fc">` + cells.map((c) => {
      const d = new Date(c.t);
      const hm = this._fmtHM(String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"));
      const night = d.getHours() >= 19 || d.getHours() < 6;
      return `<div class="ap-fcc"><span class="t">${hm ? hm.t.replace(":00", "") + hm.ap : ""}</span>` +
        `<span class="i">${this._apWeatherIcon(c.cond, night)}</span>` +
        `<span class="d">${Math.round(c.temp)}&deg;</span></div>`;
    }).join("") + `</div></div>`;
  }

  // How the night is actually going: the share of it the bed has spent within half a degree of
  // the plan, plus the biggest miss. Computed from the recorder history the chart already
  // fetched and the same _smartTempAtRel() curve the chart already draws — no extra query.
  //
  // Deliberately "tonight so far" rather than the wireframe's "last night": this is exact from
  // data the card already holds, where last night would need a second recorder window and would
  // read blank every evening before you'd slept.
  _apTonightStats() {
    const pts = this._bedHist;
    const startTs = this._nightStartTs();
    if (!Array.isArray(pts) || pts.length < 4 || startTs == null) return null;
    const S = this._smartSegments();
    let inBand = 0, total = 0, worst = 0, worstAt = null;
    for (const pt of pts) {
      const rel = (pt.t - startTs) / 60000;
      if (rel < 0) continue;
      const want = this._smartTempAtRel(rel, S);
      const miss = Math.abs(pt.v - want);
      total++;
      if (miss <= 0.5) inBand++;
      if (miss > worst) { worst = miss; worstAt = pt.t; }
    }
    if (total < 4) return null;
    const hm = worstAt ? this._fmtHM(String(new Date(worstAt).getHours()).padStart(2, "0") + ":" +
      String(new Date(worstAt).getMinutes()).padStart(2, "0")) : null;
    return { pct: Math.round((inBand / total) * 100), worst, worstAt: hm ? hm.t + hm.ap : null,
             mins: Math.round((Date.now() - startTs) / 60000) };
  }
  _apTonightHTML() {
    const st = this._apTonightStats();
    if (!st) return `<div class="ap-tempty">Nothing to measure yet &mdash; this fills in once the bed has been running tonight.</div>`;
    const h = Math.floor(st.mins / 60), m = st.mins % 60;
    return `<div class="ap-score">
        <div class="ap-scorebig">${st.pct}%</div>
        <div class="ap-scoresub">of the night so far within 0.5&deg; of the plan</div>
      </div>
      <div class="ap-sgrid">
        <div class="ap-scell"><span class="k">Elapsed</span><span class="v">${h}h ${m}m</span></div>
        <div class="ap-scell"><span class="k">Biggest miss</span><span class="v">${st.worst.toFixed(1)}&deg;</span></div>
        <div class="ap-scell"><span class="k">At</span><span class="v">${st.worstAt || "\u2014"}</span></div>
      </div>`;
  }

  // one collapsible block: a summary line you can read at a glance, opening in place
  _apFoldHTML(id, title, summary, body, open, icon) {
    return `<div class="ap-fold${open ? " open" : ""}" id="${id}">
      <button class="ap-foldhd" data-fold="${id}">
        ${icon ? `<span class="ap-foldi">${icon}</span>` : ""}
        <span class="ap-foldt">${title}</span>
        <span class="ap-folds" id="${id}Sum">${summary}</span>
        <svg class="ap-foldc" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <div class="ap-foldb" id="${id}Body">${body}</div>
    </div>`;
  }

  // v2 Autopilot detail: tonight's curve, then the factor breakdown behind the number —
  // baseline plus each adjustment with its own delta. The bias segment is the ONLY control;
  // manual temperature still lives on Home and is never locked out, so there's no
  // enable/disable button here — that switch is already on the Home strip.
  // Its own tab now (not a tap-to-open overlay — the title/close chrome that needed lives one
  // level up, in the shared header, same as Schedule/Sleep).
  _smartHTMLv2() {
    return `
      <div class="ap-card live" id="apLive">
        <div class="ap-chd"><span class="ap-lbl">Right now</span><span class="ap-aux" id="apAux"></span></div>
        <div class="ap-tele">
          <div class="ap-big" id="smSug">–</div>
          <div class="ap-meta">
            <div class="l1" id="apL1">Autopilot&rsquo;s target</div>
            <div class="l2" id="apL2"></div>
          </div>
        </div>
        <div id="apRail"></div>
        <div class="ap-strip" id="apStrip"></div>
        <div class="ap-note" id="apNote" hidden></div>
        <div class="ap-grid" id="apGrid" hidden></div>
        <div class="ap-clamp" id="apClamp" hidden></div>
        <button class="ap-back" id="apBack" data-apon hidden>Hand it back to Autopilot</button>
      </div>

      <div class="ap-card">
        <div class="ap-chd"><span class="ap-lbl">Tonight&rsquo;s plan</span><span class="ap-aux" id="apSpan"></span></div>
        <div class="sm-chart" id="smChart"></div>
        <div class="ap-phases" id="apPhases"></div>
      </div>

      <div class="ap-card" id="apHistCard">
        <div class="ap-chd"><span class="ap-lbl">Last night</span><span class="ap-aux" id="apHistAux"></span></div>
        <div id="apHistBody"></div>
      </div>

      ${this._apFoldHTML("apAdj", "Adjustments", "", `<div id="apAdjBody"></div>`, false, V2_ICON_CHART)}
      ${this._apFoldHTML("apWhy", `<span id="smWhyHd">Why this temperature</span>`, "",
        `<div class="sm-factors" id="smFactors"></div><div id="apForecast"></div>`, true, V2_ICON_INFO)}
      ${this._apFoldHTML("apRest", "Rest of night", "", `<div class="ap-up" id="apUp"></div>`, false, V2_ICON_MOON)}
      ${this._apFoldHTML("apNight", "Tonight so far", "", `<div id="apTonight"></div>`, false, V2_ICON_CHART)}
      ${this._apFoldHTML("apTune", "Tuning", "", `<div class="ap-tune" id="apTuning"></div>`, false, V2_ICON_SLIDERS)}

      ${this._config.smart_bias_entity ? `
      <div class="smv2-bias">
        <div class="smv2-bias-row">
          <span class="smv2-bias-t">Run it</span>
          <span class="smv2-bias-h" id="smBiasHint"></span>
        </div>
        <div class="smv2-seg" id="smBiasSeg">
          <button class="smv2-seg-opt" data-bias="-2">&minus;2</button>
          <button class="smv2-seg-opt" data-bias="-1">&minus;1</button>
          <button class="smv2-seg-opt" data-bias="0">0</button>
          <button class="smv2-seg-opt" data-bias="1">+1</button>
          <button class="smv2-seg-opt" data-bias="2">+2</button>
        </div>
      </div>` : ""}
      <div class="ap-foot">Change the temperature on Home any time &mdash; Autopilot hands back control until the next phase, then picks the plan up again.</div>`;
  }
  // Delegated click handling for the whole Autopilot tab. Optimistic where it can be (folds flip
  // immediately; a toggle paints its new state before HA confirms) — see DESIGN-LANGUAGE §5.1.
  _apClick(e) {
    const fold = e.target.closest("[data-fold]");
    if (fold) {
      const el = this.shadowRoot.getElementById(fold.dataset.fold);
      if (el) { el.classList.toggle("open"); this._haptic("light"); }
      return;
    }
    const apon = e.target.closest("[data-apon]");
    if (apon && apon.dataset.apon) {
      this._haptic("medium");
      this._hass.callService("input_boolean", "turn_on", { entity_id: apon.dataset.apon });
      return;
    }
    const tick = e.target.closest("[data-tick]");
    if (tick) {
      this._haptic("medium");
      this._hass.callService("input_number", "set_value",
        { entity_id: this._config.ap_tick_entity, value: parseFloat(tick.dataset.tick) });
      return;
    }
    const db = e.target.closest("[data-db]");
    if (db) {
      const id = this._config.ap_deadband_entity, s = id && this._hass.states[id];
      if (s) {
        const a = s.attributes || {};
        const lo = Number.isFinite(a.min) ? a.min : 0.1, hi = Number.isFinite(a.max) ? a.max : 2;
        const v = Math.max(lo, Math.min(hi, (parseFloat(s.state) || 0) + parseFloat(db.dataset.db)));
        this._haptic("light");
        this._hass.callService("input_number", "set_value", { entity_id: id, value: Math.round(v * 100) / 100 });
      }
      return;
    }
    const sig = e.target.closest("[data-sig]");
    if (sig) {
      sig.classList.toggle("on");                       // optimistic; reconciled on the next update
      this._haptic("medium");
      this._hass.callService("input_boolean", "toggle", { entity_id: sig.dataset.sig });
      return;
    }
    const resp = e.target.closest("[data-resp]");
    if (resp) {
      this._haptic("medium");
      this._hass.callService("input_select", "select_option",
        { entity_id: this._config.ap_response_entity, option: resp.dataset.resp });
      return;
    }
    const reset = e.target.closest("[data-reset]");
    if (reset) {
      // two-tap rather than a dialog: this rewrites fourteen helpers, so it shouldn't be one
      // stray touch away, but it also doesn't warrant a modal
      if (!reset.classList.contains("armed")) {
        reset.classList.add("armed");
        reset.querySelector("span").textContent = "Tap again to reset";
        this._haptic("light");
        setTimeout(() => {
          if (!reset.isConnected) return;
          reset.classList.remove("armed");
          const t = reset.querySelector("span"); if (t) t.textContent = "Reset tuning to defaults";
        }, 4000);
        return;
      }
      this._apResetTuning();
      return;
    }
    const btn = e.target.closest("[data-d]");
    if (!btn) return;
    const d = parseFloat(btn.dataset.d);
    this._haptic("light");
    if (btn.dataset.off) {
      const s = this._hass.states[btn.dataset.off];
      if (s) this._hass.callService("input_number", "set_value",
        { entity_id: btn.dataset.off, value: Math.max(-6, Math.min(6, (parseFloat(s.state) || 0) + d)) });
      return;
    }
    if (btn.dataset.lim) {
      const c = this._config;
      const id = btn.dataset.lim === "min" ? c.ap_min_entity : c.ap_max_entity;
      const s = this._hass.states[id];
      if (!s) return;
      // the floor can never cross the ceiling, and both stay inside the card's own clamp
      const lo = parseFloat((this._hass.states[c.ap_min_entity] || {}).state);
      const hi = parseFloat((this._hass.states[c.ap_max_entity] || {}).state);
      let v = (parseFloat(s.state) || 0) + d;
      v = Math.max(22, Math.min(40, v));
      if (btn.dataset.lim === "min" && Number.isFinite(hi)) v = Math.min(v, hi - 0.5);
      if (btn.dataset.lim === "max" && Number.isFinite(lo)) v = Math.max(v, lo + 0.5);
      this._hass.callService("input_number", "set_value", { entity_id: id, value: v });
    }
  }
  /// Back to the built-in behaviour: Balanced, the full 22-40° range the card has always
  /// clamped to, every signal on, and each phase's offset returned to the constant in _phases().
  _apResetTuning() {
    const c = this._config, st = this._hass.states;
    this._haptic("medium");
    const num = (id, v) => { if (id && st[id]) this._hass.callService("input_number", "set_value", { entity_id: id, value: v }); };
    if (c.ap_response_entity && st[c.ap_response_entity])
      this._hass.callService("input_select", "select_option",
        { entity_id: c.ap_response_entity, option: "Balanced" });
    num(c.ap_min_entity, 22);
    num(c.ap_max_entity, 40);
    (c.ap_signals || []).forEach((sig) => {
      if (st[sig.entity]) this._hass.callService("input_boolean", "turn_on", { entity_id: sig.entity });
    });
    this._phases(true).forEach((ph) => num(`${c.ap_offset_prefix}_${ph.key}`, ph.adj));
    const id = this._sc("smart_bias_entity");
    if (id && st[id]) this._hass.callService("input_number", "set_value", { entity_id: id, value: 0 });
  }
  // What the response profile does, in the model's own terms: it scales how far weather, room
  // temperature, humidity and sudden-change corrections are allowed to move the target away from
  // your set numbers (backend: respMul on those terms in eightsleep.jinja). Phase offsets and
  // your bias are untouched.
  _respHint(opt) {
    const o = String(opt || "").toLowerCase();
    if (o === "gentle") return "Small, slow moves. Autopilot mostly holds your set numbers and lets minor weather and room swings pass.";
    if (o === "eager") return "Big, quick moves. Autopilot leans hard on the forecast and room sensors, further from your set numbers.";
    return "The default. Weather and room changes nudge the temperature a normal amount.";
  }
  _biasHintText(b) {
    if (b <= -1.5) return "Noticeably cooler than it works out";
    if (b < -0.1) return "A bit cooler than it works out";
    if (b < 0.1) return "Matches what Autopilot works out";
    if (b < 1.5) return "A bit warmer than it works out";
    return "Noticeably warmer than it works out";
  }
  // segmented bias control: each option SETS the bias exactly (unlike the classic ±0.5 steppers)
  _setBias(v) {
    const id = this._sc("smart_bias_entity"); if (!id || !this._hass) return;
    this._haptic("medium");
    this._hass.callService("input_number", "set_value", { entity_id: id, value: Math.max(-6, Math.min(6, v)) });
  }
  _updateSmart() {
    if (!this._config.smart_entity) return;
    const $ = (id) => this.shadowRoot.getElementById(id);
    const on = this._smartOn();
    const sug = this._suggested();
    const dir = sug > 27 ? "warm" : sug < 27 ? "cool" : "mid";
    const sugStr = this._fmtVal(sug);
    // temp-tile row + dial row (both optional depending on mode)
    if (on) { this._ensureForecast(); this._ensureRoomSpark(); }
    if (this._view === "autopilot") { this._ensureLastNight(); this._apRenderLastNight(); }
    // dial-screen smart row
    const drow = $("smartRowDial");
    if (drow) {
      drow.classList.toggle("active", on);
      const sw = $("smartSwitchDial"); if (sw) sw.classList.toggle("on", on);
      const sg = $("smartSugDial"); if (sg) sg.textContent = on ? sugStr : "";
    }
    const extraHTML = () => `<div class="sm-up"><div class="sm-up-hd">Coming up</div>${this._comingUpRowsHTML()}</div>`
      + `<div class="sm-dchart">${this._smartChartSVG(this._smartModel(), sug)}</div>`;
    // inline smart panel on the home card — suggestion + toggle always visible; expands the rest when on
    const panel = $("smartPanel");
    if (panel) {
      panel.classList.toggle("open", on);
      const psw = $("smpSwitch"); if (psw) psw.classList.toggle("on", on);
      const psg = $("smpSug"); if (psg) { psg.textContent = this._fmtVal(sug); this._paint(psg, dir); }
      const pv = $("smpBiasVal");
      if (pv) { const b = this._bias(); pv.textContent = (b > 0 ? "+" : "") + (Number.isInteger(b) ? b : b.toFixed(1)) + "°"; pv.classList.toggle("warm", b > 0); pv.classList.toggle("cool", b < 0); }
      // v2's strip has no inline body — just the one-line summary that opens the detail screen
      const line = $("smpLineTxt");
      if (line) line.innerHTML = on ? this._autopilotLineHTML() : "Turn it on and it picks tonight's temperatures for you";
      if (on) {
        const up = $("smpUp"); if (up) up.innerHTML = `<div class="sm-up-hd">Coming up</div>${this._comingUpRowsHTML()}`;
        const ch = $("smpChart"); if (ch) ch.innerHTML = this._smartChartSVG(this._smartModel(), sug);
        const why = $("smpWhy"); if (why) why.innerHTML = this._factorsHTML();
        const ctx = $("smpCtx"); if (ctx) ctx.innerHTML = this._smartContextHTML();
      }
    }
    // dial screen "coming up" + chart (below the dial smart row)
    const extra = $("smDialExtra");
    if (extra) {
      if (on) { extra.innerHTML = extraHTML(); extra.style.display = ""; }
      else { extra.innerHTML = ""; extra.style.display = "none"; }
    }
    // detail overlay (pod mode only)
    if (!$("smSug")) return;
    $("smSug").textContent = sugStr;
    this._paint($("smSug"), dir);
    const badge = $("smartBadge");
    if (badge) { badge.textContent = on ? "Auto-applying" : "Preview"; badge.classList.toggle("on", on); }
    const t2 = $("smartToggle2"); if (t2) { t2.textContent = on ? "Disable auto" : "Enable auto"; t2.classList.toggle("on", on); }
    const bv = $("smartBiasVal");
    if (bv) { const b = this._bias(); bv.textContent = (b > 0 ? "+" : "") + (Number.isInteger(b) ? b : b.toFixed(1)) + "°"; bv.classList.toggle("warm", b > 0); bv.classList.toggle("cool", b < 0); }
    // v2's segmented bias control (absent under classic — no-op there)
    const v2 = this._layout === "v2";
    const whyHd = $("smWhyHd"); if (whyHd) whyHd.textContent = v2 ? `Why ${sugStr}` : `Why ${sugStr} right now`;
    const seg = $("smBiasSeg");
    if (seg) {
      const b = this._bias(), near = Math.round(Math.max(-2, Math.min(2, b)));
      seg.querySelectorAll("[data-bias]").forEach((o) => o.classList.toggle("on", +o.dataset.bias === near));
      const hint = $("smBiasHint"); if (hint) hint.textContent = this._biasHintText(b);
    }
    $("smFactors").innerHTML = v2 ? this._apWaterfallHTML() : this._factorsHTML();
    $("smChart").innerHTML = this._smartChartSVG(this._smartModel(), sug);
    if (v2) this._updateAutopilotTab(sug, sugStr, dir);
  }
  // The Autopilot tab's own live surface. Split out of _updateSmart so classic never runs it and
  // the two layouts share only the model, never the markup (DESIGN-LANGUAGE §8).
  _updateAutopilotTab(sug, sugStr, dir) {
    const $ = (id) => this.shadowRoot.getElementById(id);
    if (!$("apLive")) return;
    const cur = this._curTemp();
    const rate = this._bedRate();
    const sup = this._apSuppress();
    const eta = sup ? null : this._apEta(sug, cur, rate);
    const ph = this._phaseAt(this._nowMins());

    // headline: the target, and what it's doing about it
    this._paint($("smSug"), sup ? null : dir);
    $("apLive").classList.toggle("sup", !!sup);
    const l1 = $("apL1"), l2 = $("apL2");
    if (sup) {
      if (l1) l1.textContent = sup.label;
      if (l2) l2.textContent = sup.sub;
    } else {
      const gap = sug - cur;
      if (l1) l1.textContent = Math.abs(gap) < 0.3 ? "Holding" : gap < 0 ? "Cooling" : "Warming";
      if (l2) l2.textContent = `${ph.name} phase`;
    }
    const aux = $("apAux");
    if (aux) {
      const s = this._hass.states[this._sc("suggested_entity")];
      const t = s && s.last_changed ? Math.round((Date.now() - Date.parse(s.last_changed)) / 60000) : null;
      aux.textContent = t == null ? "" : t < 1 ? "updated just now" : t < 60 ? `updated ${t} min ago` : "";
    }

    const rail = $("apRail"); if (rail) rail.innerHTML = this._apRailHTML(sug, cur);

    // rate / arrival / room — only cells we can actually fill
    const strip = $("apStrip");
    if (strip) {
      const cells = [];
      if (rate != null) cells.push(["Rate", `${rate > 0 ? "+" : ""}${rate.toFixed(1)}°/h`, rate > 0 ? "warm" : rate < 0 ? "cool" : ""]);
      if (eta) cells.push(["Reaches it", eta.text, ""]);
      const room = this._hass.states[this._config.room_temp_entity];
      if (room && !isNaN(parseFloat(room.state))) cells.push(["Room", `${parseFloat(room.state).toFixed(1)}°`, ""]);
      strip.innerHTML = cells.map(([k, v, c]) => `<div class="c"><span class="k">${k}</span><span class="v ${c}">${v}</span></div>`).join("");
      strip.style.gridTemplateColumns = `repeat(${Math.max(1, cells.length)},minmax(0,1fr))`;
      strip.hidden = !cells.length;
    }

    // pre-conditioning only shows while it's actually ramping early
    const note = $("apNote");
    if (note) {
      const S = this._smartSegments();
      const relNow = ((this._nowMins() - S[0].mins) % 1440 + 1440) % 1440;
      let segNow = S[0]; for (const x of S) { if (x.rel <= relNow) segNow = x; }
      const next = S[(S.indexOf(segNow) + 1) % S.length];
      const ramping = !sup && next && next.leadMin >= 1 && relNow >= next.rel - next.leadMin;
      note.hidden = !ramping;
      if (ramping) note.innerHTML = `${V2_ICON_APLEAD}<span>Ramping to ${escapeHtml(next.label)} ${Math.round(next.leadMin)} min early &mdash; so the bed is there on time</span>`;
    }

    // ── not driving: the state that cost a whole night (2026-09-19, off 00:03-07:43 with
    // nothing on any screen saying so). "off" is the only suppression that is a PROBLEM — a
    // boost or vacation pause is deliberate and stays muted — so only that one goes amber and
    // offers the way back.
    const live = $("apLive"), back = $("apBack");
    const stuck = sup && sup.kind === "off" && this._isOn();
    if (live) live.classList.toggle("ap-alarm", !!stuck);
    if (back) {
      back.hidden = !stuck;
      back.dataset.apon = this._sc("smart_entity") || "";
    }
    if (stuck && l2) {
      const e = this._hass.states[this._sc("smart_entity")];
      const mins = e && e.last_changed ? Math.round((Date.now() - Date.parse(e.last_changed)) / 60000) : null;
      if (mins != null && mins >= 1)
        l2.textContent = `The bed is on manual — nothing has moved it for ${mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`}`;
    }

    // ── asked vs accepted: the Pod stores its setpoint in whole °F, so the number it took is
    // not the number that was sent (measured: 23.5 -> 23.6, 24.0 -> 23.9). Show both rather
    // than letting the mismatch read as a bug.
    const grid = $("apGrid");
    if (grid) {
      const cl = this._clim();
      const took = cl && cl.attributes ? parseFloat(cl.attributes.temperature) : NaN;
      // compare what will be DISPLAYED, not the raw floats: _fmtVal rounds, so 32.0 vs 31.9
      // both render "32°" and the chip would read "Asked 32° · Pod took 32°" — nonsense. If the
      // two format the same there is nothing to explain, so say nothing.
      const a = this._fmtVal(sug), b = Number.isFinite(took) ? this._fmtVal(took) : null;
      const show = !sup && b != null && a !== b;
      grid.hidden = !show;
      if (show) grid.innerHTML = `Asked <b>${a}</b> &middot; Pod took <b>${b}</b>`;
    }

    // ── clamped: the model wanted to go past your own fence. Without this the night just looks
    // flat and there is no way to tell a too-tight limit from a settled one.
    const clampEl = $("apClamp");
    if (clampEl) {
      const a = (this._hass.states[this._sc("suggested_entity")] || {}).attributes || {};
      const lo = parseFloat(a.clamp_lo), hi = parseFloat(a.clamp_hi);
      const atLo = Number.isFinite(lo) && Math.abs(sug - lo) < 0.05;
      const atHi = Number.isFinite(hi) && Math.abs(sug - hi) < 0.05;
      clampEl.hidden = !!sup || !(atLo || atHi);
      if (!clampEl.hidden)
        clampEl.innerHTML = `Held at your ${atLo ? "coolest" : "warmest"} limit &mdash; the model wanted to go ${atLo ? "lower" : "higher"}`;
    }

    const adj = $("apAdjBody"); if (adj) { this._ensureLedger(); adj.innerHTML = this._apLedgerHTML(); }

    const span = $("apSpan");
    if (span) {
      const S = this._smartSegments();
      const f = (m) => { const h = this._fmtHM(String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0")); return h ? h.t + h.ap : ""; };
      span.textContent = `${f(S[0].mins)} – ${f(S[S.length - 1].mins)}`;
    }
    const chart = $("smChart"); if (chart) chart.innerHTML = this._apChartSVG(sug);
    const chips = $("apPhases"); if (chips) chips.innerHTML = this._apPhaseChipsHTML();
    this._emitSchedule();
    const up = $("apUp"); if (up) up.innerHTML = this._comingUpRowsHTML();
    const tune = $("apTuning"); if (tune) tune.innerHTML = this._apTuningHTML();
    const fc = $("apForecast"); if (fc) fc.innerHTML = this._apForecastHTML();
    const tn = $("apTonight"); if (tn) tn.innerHTML = this._apTonightHTML();
    const nightSum = $("apNightSum");
    if (nightSum) {
      const st = this._apTonightStats();
      nightSum.textContent = st ? `${st.pct}% at target · worst ${st.worst.toFixed(1)}°` : "not running yet";
    }

    // fold summaries — each has to be readable without opening it
    const whySum = $("apWhySum");
    if (whySum) whySum.textContent = `baseline 29° · ${this._smartFactors().length - 1} factors`;
    const restSum = $("apRestSum");
    if (restSum) {
      const u = this._upcomingChanges().filter((x) => x.key !== this._apCurrentPhaseKey());
      restSum.textContent = u.length
        ? u.slice(0, 2).map((x) => { const h = this._fmtHM(String(Math.floor(x.mins / 60)).padStart(2, "0") + ":" + String(x.mins % 60).padStart(2, "0")); return `${this._fmtVal(x.temp)} at ${h ? h.t + h.ap : x.label}`; }).join(" · ")
        : "nothing left tonight";
    }
    const tuneSum = $("apTuneSum");
    if (tuneSum) {
      const b = this._bias();
      const sigs = (this._config.ap_signals || []).filter((s) => this._hass.states[s.entity]);
      const on = sigs.filter((s) => this._hass.states[s.entity].state === "on").length;
      tuneSum.textContent = sigs.length ? `bias ${b > 0 ? "+" : ""}${b} · ${on} of ${sigs.length} signals` : `bias ${b > 0 ? "+" : ""}${b}`;
    }
  }
  // overnight suggested-temp curve (stepped by phase, forecast-aware); marks "now"
  _smartChartSVG(M, sugNow) {
    const S = this._smartSegments();            // all phases, chronological, with rel + temp + leadMin
    const last = S.length - 1;
    const tail = 90;                             // show the wake warm-up as a short tail
    const total = (S[last].rel || 600) + tail;
    // v2: each phase HOLDS its target, then RAMPS into the next one starting `leadMin` minutes
    // early — so the bed is predicted to already be at the new number right at the scheduled
    // time, not just starting to move then. A flat hold is just a ramp with rampAt === holdEnd.
    const segs = [];
    S.forEach((s, i) => {
      const bEnd = i < last ? S[i + 1].rel : s.rel + tail;
      const nextLead = i < last ? S[i + 1].leadMin : 0;
      const rampAt = i < last ? Math.max(s.rel, bEnd - nextLead) : bEnd;
      segs.push({ a: s.rel, b: rampAt, temp: s.temp, holdEnd: rampAt });          // flat hold
      if (i < last && rampAt < bEnd) segs.push({ a: rampAt, b: bEnd, temp: s.temp, toTemp: S[i + 1].temp, ramp: true });
    });
    const temps = segs.map((s) => s.ramp ? s.toTemp : s.temp).concat(segs.map((s) => s.temp));
    const yMin = Math.min(...temps, sugNow) - 1.5, yMax = Math.max(...temps, sugNow) + 1.5;
    const W = 300, H = 132, pl = 6, pr = 6, pt = 10, pb = 30;
    const X = (r) => pl + (r / total) * (W - pl - pr);
    const Y = (t) => pt + (1 - (t - yMin) / (yMax - yMin || 1)) * (H - pt - pb);
    // hold segments draw as a flat run at s.temp; ramp segments slope from s.temp to s.toTemp
    let line = "";
    segs.forEach((s, i) => {
      const x0 = X(s.a), x1 = X(s.b);
      const y0 = Y(s.temp), y1 = Y(s.ramp ? s.toTemp : s.temp);
      line += (i === 0 ? `M ${x0} ${y0}` : ` L ${x0} ${y0}`) + ` L ${x1} ${y1}`;
    });
    const baseY = H - pb;
    const area = `M ${X(0)} ${baseY} ` + segs.map((s) => {
      const y0 = Y(s.temp), y1 = Y(s.ramp ? s.toTemp : s.temp);
      return `L ${X(s.a)} ${y0} L ${X(s.b)} ${y1}`;
    }).join(" ") + ` L ${X(total)} ${baseY} Z`;
    // a soft tick on the timeline under each ramp, so "starts early" is visible, not just implied
    const rampTicks = segs.filter((s) => s.ramp).map((s) =>
      `<line x1="${X(s.a).toFixed(1)}" y1="${baseY - 3}" x2="${X(s.a).toFixed(1)}" y2="${baseY + 3}" stroke="rgba(255,255,255,0.35)" stroke-width="1.5"/>`
    ).join("");
    const accent = sugNow > 27 ? "#ff7a5a" : sugNow < 27 ? "#6f8cff" : "#9a5cf0";
    let lastLblX = -100;
    const ticks = S.map((b, i) => {
      const x = X(b.rel);
      const grid = `<line x1="${x.toFixed(1)}" y1="${pt}" x2="${x.toFixed(1)}" y2="${baseY}" class="sm-grid"/>`;
      // skip labels that would collide with the previous one (keeps 7 phases legible)
      const isEdge = i === 0 || i === S.length - 1;
      if (!isEdge && x - lastLblX < 30) return grid;
      lastLblX = x;
      const anchor = i === 0 ? "start" : i === S.length - 1 ? "end" : "middle";
      const lx = i === 0 ? pl : i === S.length - 1 ? (W - pr) : x;
      return grid + `<text x="${lx.toFixed(1)}" y="${H - 16}" class="sm-xlbl" style="text-anchor:${anchor}">${b.short || b.label}</text>`;
    }).join("");
    const nowR = (((this._nowMins() - S[0].mins) % 1440) + 1440) % 1440;
    const nowMark = (nowR <= total) ? (() => {
      const x = X(nowR); const y = Y(sugNow);
      return `<line x1="${x.toFixed(1)}" y1="${pt}" x2="${x.toFixed(1)}" y2="${baseY}" class="sm-now"/>` +
        `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="${accent}"/>` +
        `<text x="${x.toFixed(1)}" y="${pt - 1}" class="sm-nowlbl">now</text>`;
    })() : "";
    return `<svg viewBox="0 0 ${W} ${H}" class="sm-svg">
      <defs><linearGradient id="smgrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${accent}" stop-opacity="0.35"/>
        <stop offset="1" stop-color="${accent}" stop-opacity="0"/>
      </linearGradient></defs>
      ${ticks}
      <path d="${area}" fill="url(#smgrad)"/>
      <path d="${line}" fill="none" stroke="${accent}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      ${rampTicks}
      ${nowMark}
    </svg>`;
  }

  /* ---------- the Autopilot tab's overnight chart ----------
     Its own renderer, not _smartChartSVG: that one still serves classic and v2's home strip at
     300×132 with phase-name ticks, and DESIGN-LANGUAGE §8 keeps the two layouts' markup apart.
     What this one adds: a temperature y-axis with real gridlines, clock-time x labels, the bed's
     ACTUAL temperature so far over the plan, rounded corners on the hold→ramp joins, and a stroke
     whose colour is sampled from the curve's own temperature at each point. */

  // pivot colour (§2): everything showing a temperature colours itself against the 27° midpoint
  _tColor(t) { return t > 27.3 ? "#ff8a5a" : t < 26.7 ? "#6f8cff" : "#b98cff"; }

  // Timestamp of the bedtime the CURRENT night started at, or null when there is no night in
  // progress (i.e. daytime, between wake and the next bedtime). _boundaryTs always resolves a
  // phase to its next occurrence, so S[0].ts is tomorrow's bedtime the moment tonight's passes —
  // measuring "so far" against it puts every reading a day out.
  _nightStartTs() {
    const S = this._smartSegments();
    const now = Date.now();
    let start = S[0].ts;
    if (!Number.isFinite(start)) return null;
    if (start > now) start -= 86400000;
    const tail = 60;
    const total = (S[S.length - 1].rel || 600) + tail;
    return (now - start) / 60000 <= total ? start : null;
  }

  // ── Adjustments ───────────────────────────────────────────────────────────────────────────
  // Every setpoint change tonight, newest first. Answers "is it actually adjusting, or only
  // following the schedule?" — the question the /15 tick and the old 0.5° output rounding made
  // impossible to answer from the UI. Cause is DERIVED, not recorded: a change within 2 min of
  // a phase boundary is attributed to the schedule, everything else to the environment. The
  // card says "around <phase>" rather than claiming to know, because nothing logs the real why.
  _ensureLedger(force) {
    const ent = this._sc("entity");
    if (!ent || !this._hass || !this._hass.callWS) return;
    const start = this._nightStartTs();
    if (start == null) { this._ledger = null; return; }
    const now = Date.now();
    if (!force && this._ledgerAt && now - this._ledgerAt < 3 * 60 * 1000) return;
    this._ledgerAt = now;
    this._hass.callWS({
      type: "history/history_during_period",
      start_time: new Date(start).toISOString(),
      end_time: new Date(now).toISOString(),
      entity_ids: [ent],
      minimal_response: false, no_attributes: false, significant_changes_only: false,
    }).then((res) => {
      const pts = this._parseHist((res && res[ent]) || [])
        .map((x) => ({ t: x.t, v: parseFloat((x.attrs || {}).temperature), off: x.state === "off" }))
        .filter((x) => Number.isFinite(x.v) && !x.off);
      const out = [];
      for (let i = 1; i < pts.length; i++) {
        const d = pts[i].v - pts[i - 1].v;
        if (Math.abs(d) < 0.05) continue;                 // the Pod re-reports its own setpoint
        out.push({ t: pts[i].t, from: pts[i - 1].v, to: pts[i].v, d });
      }
      this._ledger = out.reverse();
      this._updateSmart();
    }).catch(() => { this._ledger = null; this._updateSmart(); });
  }
  _apLedgerHTML() {
    const L = this._ledger;
    if (!L) return `<div class="ap-tempty">Nothing recorded yet tonight.</div>`;
    if (!L.length) return `<div class="ap-tempty">No changes yet tonight — the bed has held one setting.</div>`;
    // phase boundaries, for attribution
    const S = this._smartSegments();
    const nearPhase = (t) => {
      const d = new Date(t), mins = d.getHours() * 60 + d.getMinutes();
      for (const x of S) {
        const diff = Math.abs(((mins - x.mins + 720 + 1440) % 1440) - 720);
        if (diff <= 2) return x.label;
      }
      return null;
    };
    const env = L.filter((r) => !nearPhase(r.t)).length;
    const head = `<div class="ap-ldsum"><span><b>${L.length}</b> change${L.length === 1 ? "" : "s"}</span>` +
      `<span><b>${env}</b> from the room</span><span><b>${L.length - env}</b> from the schedule</span></div>`;
    const rows = L.slice(0, 12).map((r) => {
      const d = new Date(r.t);
      const hm = this._fmtHM(String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"));
      const ph = nearPhase(r.t);
      return `<div class="ap-ldr">` +
        `<span class="ap-ldt">${hm ? hm.t + hm.ap : ""}</span>` +
        `<i class="${r.d > 0 ? "warm" : "cool"}"></i>` +
        `<span class="ap-ldb"><b>${this._fmtVal(r.from)} &rarr; ${this._fmtVal(r.to)}</b>` +
        `<em>${ph ? `around ${escapeHtml(ph)}` : "room or forecast moved"}</em></span></div>`;
    }).join("");
    return head + rows + (L.length > 12 ? `<div class="ap-tempty">+${L.length - 12} earlier</div>` : "");
  }

  // ── Last night ────────────────────────────────────────────────────────────────────────────
  // The window the ribbon covers: the night that has already finished. 18:00 the previous
  // evening to 10:00 this morning, clipped to now so an early-morning look still draws the
  // part that has happened rather than a half-empty band.
  _apNightWindow() {
    const end = new Date(); end.setHours(10, 0, 0, 0);
    const now = Date.now();
    const e = Math.min(end.getTime(), now);
    const start = new Date(e); start.setDate(start.getDate() - 1);
    start.setHours(18, 0, 0, 0);
    return { start: start.getTime(), end: e };
  }
  // Fetch is cached for 10 min and fire-and-forget, same shape as _ensureBedHist: the ribbon
  // draws empty, the data lands, _updateSmart runs again and fills it in.
  // Two series: the climate's TARGET (an attribute, so no_attributes must stay false) and the
  // Autopilot switch, because a flat target only means something once you know whether anything
  // was driving it.
  _ensureLastNight(force) {
    const ent = this._sc("entity"), sw = this._sc("smart_entity");
    if (!ent || !this._hass || !this._hass.callWS) return;
    const now = Date.now();
    if (!force && this._apNightAt && now - this._apNightAt < 10 * 60 * 1000) return;
    this._apNightAt = now;
    const w = this._apNightWindow();
    if (!(w.end > w.start)) { this._apNight = null; return; }
    this._hass.callWS({
      type: "history/history_during_period",
      start_time: new Date(w.start).toISOString(),
      end_time: new Date(w.end).toISOString(),
      entity_ids: sw ? [ent, sw] : [ent],
      minimal_response: false, no_attributes: false, significant_changes_only: false,
    }).then((res) => {
      const tgt = this._parseHist((res && res[ent]) || [])
        .map((x) => ({ t: x.t, v: parseFloat((x.attrs || {}).temperature), off: x.state === "off" }))
        .filter((x) => Number.isFinite(x.v));
      const ap = sw ? this._parseHist((res && res[sw]) || []).map((x) => ({ t: x.t, on: x.state === "on" })) : [];
      this._apNight = tgt.length >= 2 ? { w, tgt, ap } : null;
      this._updateSmart();
    }).catch(() => { this._apNight = null; this._updateSmart(); });
  }
  // value -> the same three-way warm/mid/cool axis every other surface uses
  _apHBand(v) { return v >= 30 ? "warm" : v <= 26 ? "cool" : "mid"; }
  _apRenderLastNight() {
    const $ = (id) => this.shadowRoot.getElementById(id);
    const body = $("apHistBody"), aux = $("apHistAux");
    if (!body) return;
    const d = this._apNight;
    if (!d) {
      body.innerHTML = `<div class="ap-hempty">No recorded history for last night yet.</div>`;
      if (aux) aux.textContent = "";
      return;
    }
    const { w, tgt, ap } = d;
    const span = w.end - w.start;
    const pct = (t) => Math.max(0, Math.min(100, ((t - w.start) / span) * 100));
    // was Autopilot on at time t? (step function over its state changes; unknown => assume on,
    // so a missing switch never paints a false alarm)
    const apOn = (t) => {
      let on = true;
      for (const x of ap) { if (x.t <= t) on = x.on; else break; }
      return on;
    };
    // walk the target series into coloured runs; a run where Autopilot was off becomes a gap
    const segs = [];
    for (let i = 0; i < tgt.length; i++) {
      const a = tgt[i], b = tgt[i + 1];
      const t0 = a.t, t1 = b ? b.t : w.end;
      if (!(t1 > t0)) continue;
      const cls = a.off ? null : (apOn(t0) ? this._apHBand(a.v) : "gap");
      if (!cls) continue;
      const last = segs[segs.length - 1];
      if (last && last.cls === cls && Math.abs(last.t1 - t0) < 1000) last.t1 = t1;
      else segs.push({ cls, t0, t1 });
    }
    const lo = Math.min(...tgt.map((x) => x.v)), hi = Math.max(...tgt.map((x) => x.v));
    const rng = Math.max(1, hi - lo);
    const path = tgt.map((x, i) =>
      `${i ? "L" : "M"} ${(pct(x.t) * 3.54).toFixed(1)} ${(38 - ((x.v - lo) / rng) * 30).toFixed(1)}`).join(" ");
    const offMs = segs.filter((g) => g.cls === "gap").reduce((n, g) => n + (g.t1 - g.t0), 0);
    const hrs = (ms) => { const m = Math.round(ms / 60000); const h = Math.floor(m / 60); return m >= 60 ? (m % 60 ? `${h}h ${m % 60}m` : `${h}h`) : `${m}m`; };
    const ax = [];
    for (let k = 0; k <= 4; k++) ax.push(new Date(w.start + (span * k) / 4)
      .toLocaleTimeString([], { hour: "numeric", hour12: true }).replace(/\s/g, ""));
    body.innerHTML = `
      <div class="ap-hist">
        ${segs.map((g) => `<div class="ap-hseg ${g.cls}" style="left:${pct(g.t0).toFixed(2)}%;width:${(pct(g.t1) - pct(g.t0)).toFixed(2)}%"></div>`).join("")}
        <svg class="ap-hline" viewBox="0 0 354 44" preserveAspectRatio="none"><path d="${path}"/></svg>
      </div>
      <div class="ap-haxis">${ax.map((t) => `<span>${t}</span>`).join("")}</div>
      <div class="ap-htags">
        ${offMs > 60000 ? `<span class="ap-htag amber">Autopilot off <b>${hrs(offMs)}</b></span>` : ``}
        <span class="ap-htag">Held <b>${this._fmtVal(lo)}</b>&ndash;<b>${this._fmtVal(hi)}</b></span>
        <span class="ap-htag">${tgt.length} change${tgt.length === 1 ? "" : "s"}</span>
      </div>
      ${offMs > 15 * 60000 ? `<div class="ap-hwhy">${V2_ICON_INFO}<span>Autopilot was off for part of the night, so nothing was
        adjusting the bed &mdash; the flat stretch above is that gap, not a settled temperature.</span></div>` : ``}`;
    if (aux) aux.textContent = new Date(w.start)
      .toLocaleDateString([], { weekday: "short", day: "numeric" });
  }

  // recorder history for the bed surface since tonight's bedtime — the "Bed so far" trace.
  // Same shape as _ensureRoomSpark: cached, fire-and-forget, redraws when it lands.
  _ensureBedHist(force) {
    const ent = this._curTempEntity();
    if (!ent || !this._hass || !this._hass.callWS) return;
    const now = Date.now();
    if (!force && this._bedHistAt && now - this._bedHistAt < 5 * 60 * 1000) return;
    this._bedHistAt = now;
    // only while a night is actually in progress — outside one there is no "so far" to draw, and
    // querying the recorder for it would be a round-trip for nothing
    const start = this._nightStartTs();
    if (start == null) { this._bedHist = null; return; }
    this._hass.callWS({
      type: "history/history_during_period",
      start_time: new Date(start).toISOString(),
      end_time: new Date(now).toISOString(),
      entity_ids: [ent],
      minimal_response: true, no_attributes: true, significant_changes_only: false,
    }).then((res) => {
      const pts = this._parseHist((res && res[ent]) || [])
        .map((s) => ({ t: s.t, v: parseFloat(s.state) }))
        .filter((p) => Number.isFinite(p.v));
      this._bedHist = pts.length >= 2 ? pts : null;
      this._updateSmart();
    }).catch(() => { this._bedHist = null; });
  }

  // round the corners of a polyline without moving any of its points: each vertex becomes a short
  // quadratic. Holds stay flat and ramps stay straight — only the joins soften.
  _roundedPath(P, r) {
    if (!P.length) return "";
    if (P.length < 3) return P.map((p, i) => `${i ? "L" : "M"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
    let d = `M ${P[0].x.toFixed(1)} ${P[0].y.toFixed(1)}`;
    for (let i = 1; i < P.length - 1; i++) {
      const p0 = P[i - 1], p1 = P[i], p2 = P[i + 1];
      const d1 = Math.hypot(p1.x - p0.x, p1.y - p0.y), d2 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const rr = Math.min(r, d1 / 2, d2 / 2);
      if (!(rr > 0.5)) { d += ` L ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`; continue; }
      const ax = p1.x + (p0.x - p1.x) * rr / d1, ay = p1.y + (p0.y - p1.y) * rr / d1;
      const bx = p1.x + (p2.x - p1.x) * rr / d2, by = p1.y + (p2.y - p1.y) * rr / d2;
      d += ` L ${ax.toFixed(1)} ${ay.toFixed(1)} Q ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} ${bx.toFixed(1)} ${by.toFixed(1)}`;
    }
    const e = P[P.length - 1];
    return d + ` L ${e.x.toFixed(1)} ${e.y.toFixed(1)}`;
  }

  _apChartSVG(sugNow) {
    const S = this._smartSegments();
    const last = S.length - 1;
    const tail = 60;
    const total = (S[last].rel || 600) + tail;
    this._ensureBedHist();

    // the plan as hold/ramp segments (same model the card already drives the bed with)
    const pts = [];
    const push = (x, y) => { const p = pts[pts.length - 1]; if (!p || Math.abs(p.x - x) > 0.01 || Math.abs(p.y - y) > 0.01) pts.push({ x, y }); };
    const plan = [];
    S.forEach((s, i) => {
      const bEnd = i < last ? S[i + 1].rel : s.rel + tail;
      const rampAt = i < last ? Math.max(s.rel, bEnd - S[i + 1].leadMin) : bEnd;
      plan.push({ rel: s.rel, t: s.temp }, { rel: rampAt, t: s.temp });
      if (i < last && rampAt < bEnd) plan.push({ rel: bEnd, t: S[i + 1].temp });
    });

    // ── scale ──────────────────────────────────────────────────────────────────────────
    const nightTs = this._nightStartTs();
    const bedPts = nightTs == null ? [] : (this._bedHist || []).map((p) => ({
      rel: (p.t - nightTs) / 60000, v: p.v,
    })).filter((p) => p.rel >= -5 && p.rel <= total);
    // the live bed temperature joins the domain too — otherwise the "now" dot floats outside the
    // plot whenever the bed is further from the plan than the plan's own range
    const vals = plan.map((p) => p.t).concat(bedPts.map((p) => p.v), [sugNow, this._curTemp()]);
    let yMin = Math.min(...vals), yMax = Math.max(...vals);
    const padY = Math.max(1, (yMax - yMin) * 0.12);
    yMin -= padY; yMax += padY;
    const W = 328, H = 168, pl = 30, pr = 4, pt = 12, pb = 34;
    const X = (r) => pl + (Math.max(0, Math.min(total, r)) / total) * (W - pl - pr);
    const Y = (t) => pt + (1 - (t - yMin) / (yMax - yMin || 1)) * (H - pt - pb);
    const baseY = H - pb;

    // ── y grid: ticks at round degrees the chart actually reaches ──────────────────────
    const span = yMax - yMin;
    const step = span > 14 ? 4 : span > 9 ? 3 : span > 5 ? 2 : 1;
    let grid = "";
    for (let t = Math.ceil(yMin / step) * step; t <= yMax; t += step) {
      const y = Y(t);
      if (y < pt - 1 || y > baseY + 1) continue;
      grid += `<line x1="${pl}" y1="${y.toFixed(1)}" x2="${W - pr}" y2="${y.toFixed(1)}" class="ap-grid"/>` +
        `<text x="${pl - 6}" y="${(y + 3.2).toFixed(1)}" class="ap-ylbl">${this._fmtVal(t)}</text>`;
    }

    // ── x labels: clock time, thinned so they never collide ────────────────────────────
    const bedMins = S[0].mins;
    let xl = "", lastX = pl + 4, lastAp = (bedMins % 1440) >= 720 ? "pm" : "am";
    for (let h = Math.ceil((bedMins + 1) / 60) * 60; h <= bedMins + total; h += 60) {
      const rel = h - bedMins, x = X(rel);
      if (x - lastX < 40 || x > W - pr - 26) continue;
      const hm = this._fmtHM(String(Math.floor((h % 1440) / 60)).padStart(2, "0") + ":00");
      if (!hm) continue;
      const showAp = hm.ap !== lastAp;                 // AM/PM only when it changes
      lastAp = hm.ap; lastX = x;
      xl += `<text x="${x.toFixed(1)}" y="${H - 17}" class="ap-xlbl">${hm.t.replace(":00", "")}${showAp ? " " + hm.ap.toUpperCase() : ""}</text>`;
    }
    const bedHm = this._fmtHM(String(Math.floor(bedMins / 60)).padStart(2, "0") + ":" + String(bedMins % 60).padStart(2, "0"));
    const wakeHm = this._fmtHM(String(Math.floor(S[last].mins / 60)).padStart(2, "0") + ":" + String(S[last].mins % 60).padStart(2, "0"));
    xl = `<text x="${pl}" y="${H - 17}" class="ap-xlbl" style="text-anchor:start">${bedHm ? bedHm.t + " " + bedHm.ap.toUpperCase() : ""}</text>` + xl +
      `<text x="${W - pr}" y="${H - 17}" class="ap-xlbl" style="text-anchor:end">${wakeHm ? wakeHm.t : ""}</text>`;

    // ── the plan ───────────────────────────────────────────────────────────────────────
    plan.forEach((p) => push(X(p.rel), Y(p.t)));
    const line = this._roundedPath(pts, 9);
    const area = `${line} L ${X(total).toFixed(1)} ${baseY} L ${X(0).toFixed(1)} ${baseY} Z`;
    // stroke colour sampled from the curve's OWN temperature at each point, so the line is the
    // warm↔cool axis rather than one flat accent
    const stops = plan.map((p) => {
      const off = ((X(p.rel) - pl) / (W - pl - pr) * 100).toFixed(1);
      return `<stop offset="${Math.max(0, Math.min(100, off))}%" stop-color="${this._tColor(p.t)}"/>`;
    }).join("");
    const accent = this._tColor(sugNow);

    // ── the bed's actual temperature so far ────────────────────────────────────────────
    let bedPath = "";
    if (bedPts.length >= 2) {
      bedPath = `<path d="${bedPts.map((p, i) => `${i ? "L" : "M"} ${X(p.rel).toFixed(1)} ${Y(p.v).toFixed(1)}`).join(" ")}" class="ap-bedline"/>`;
    }

    // ── now ────────────────────────────────────────────────────────────────────────────
    const nowR = (((this._nowMins() - bedMins) % 1440) + 1440) % 1440;
    let nowMark = "";
    if (nowR <= total) {
      const x = X(nowR);
      const cur = this._curTemp();
      const y = Y(bedPts.length ? cur : sugNow);
      nowMark = `<line x1="${x.toFixed(1)}" y1="${pt}" x2="${x.toFixed(1)}" y2="${baseY}" class="ap-nowline"/>` +
        `<circle class="ap-nowhalo" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="8" fill="#e7ecff" opacity="0.16"/>` +
        `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" fill="#f3f5fa"/>` +
        `<text x="${x.toFixed(1)}" y="${pt - 2}" class="ap-nowlbl">now</text>`;
    }

    return `<svg viewBox="0 0 ${W} ${H}" class="ap-svg" role="img" aria-label="Tonight's planned bed temperature against the bed's actual temperature so far">
      <defs>
        <linearGradient id="apline" x1="0" y1="0" x2="1" y2="0">${stops}</linearGradient>
        <linearGradient id="apfill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="${accent}" stop-opacity="0.30"/>
          <stop offset="1" stop-color="${accent}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${grid}
      <path d="${area}" fill="url(#apfill)"/>
      <path d="${line}" fill="none" stroke="url(#apline)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      ${bedPath}
      ${nowMark}
      ${xl}
    </svg>
    <div class="ap-legend">
      <span><i class="pl"></i>Planned</span>
      ${bedPts.length >= 2 ? `<span><i class="bd"></i>Bed so far</span>` : ""}
    </div>`;
  }

  _fmtHM(str) {
    const m = /^(\d{1,2}):(\d{2})/.exec(str || "");
    if (!m) return null;
    let h = parseInt(m[1], 10); const min = parseInt(m[2], 10);
    const ap = h >= 12 ? "pm" : "am"; h = h % 12 || 12;
    return { mins: parseInt(m[1], 10) * 60 + min, t: h + ":" + m[2], ap };
  }

  _moreInfoEntity(id) {
    if (!id) return;
    this.dispatchEvent(new CustomEvent("hass-more-info", {
      detail: { entityId: id }, bubbles: true, composed: true,
    }));
  }

  /* ---------- in-card picker (time + temperature) ----------
     A card-styled bottom sheet that replaces the jarring HA more-info dialog
     for schedule times, the auto-off time, and schedule temperatures. */
  _openPicker(kind, entity, label) {
    if (!entity || !this._hass) return;
    this._haptic("light");
    const st = this._hass.states[entity];
    if (kind === "time") {
      const hm = this._fmtHM(st ? st.state : "22:00") || { mins: 1320 };
      this._picker = { kind, entity, label, h: Math.floor(hm.mins / 60), m: hm.mins % 60 };
    } else if (kind === "light") {
      // entity picker: choose a light.* entity, saved into an input_text helper
      const lights = Object.keys(this._hass.states)
        .filter((id) => id.startsWith("light."))
        .map((id) => ({ id, name: (this._hass.states[id].attributes || {}).friendly_name || id }))
        .sort((a, b) => a.name.localeCompare(b.name));
      this._picker = { kind, entity, label, sel: st ? String(st.state) : "", lights };
    } else if (kind === "step") {
      // v2 Schedule step rail — entity carries the phase key; time + level entities resolve
      // via _phases(). One sheet edits both together.
      const ph = this._phases().find((x) => x.key === entity);
      if (!ph) return;
      const timeEnt = ph.time_entity, levelEnt = ph.level_entity;
      const tSt = timeEnt && this._hass.states[timeEnt];
      const hm = this._fmtHM(tSt ? tSt.state : ph.defTime) || { mins: 0 };
      const lSt = levelEnt && this._hass.states[levelEnt];
      const useC = this._useC();
      const a = (lSt && lSt.attributes) || {};
      const cur = lSt && !isNaN(parseFloat(lSt.state)) ? parseFloat(lSt.state) : (useC ? ph.defC : ph.defLvl);
      const min = Number.isFinite(a.min) ? a.min : (useC ? Math.round(this._range().min) : -10);
      const max = Number.isFinite(a.max) ? a.max : (useC ? Math.round(this._range().max) : 10);
      const step = Number.isFinite(a.step) && a.step > 0 ? a.step : 1;
      const rawUnit = a.unit_of_measurement || (useC ? "\u00b0" : "");
      this._picker = {
        kind, label, key: entity, timeEnt, levelEnt,
        orig: `${Math.floor(hm.mins / 60)}:${hm.mins % 60}:${Math.max(min, Math.min(max, cur))}`,
        h: Math.floor(hm.mins / 60), m: hm.mins % 60,
        val: Math.max(min, Math.min(max, cur)), min, max, step, unit: /\u00b0/.test(rawUnit) ? "\u00b0" : rawUnit,
      };
    } else if (kind === "boost") {
      // entity is repurposed to carry the boost direction ("warm"|"cool") — there's no backing
      // entity for a not-yet-started boost
      const dir = entity;
      const { min, max, step } = this._range();
      const useC = this._useC();
      // Pre Cool Sleep opens pre-filled with ITS defaults (not the bed's current temp) so
      // holding shows exactly what a plain tap would do, ready to tweak
      const cur = dir === "cool" && Number.isFinite(this._config.precool_sleep_temp)
        ? Math.max(min, Math.min(max, this._config.precool_sleep_temp))
        : Math.max(min, Math.min(max, this._tgtTemp()));
      const defMins = dir === "cool"
        ? (Number.isFinite(this._config.precool_sleep_minutes) ? this._config.precool_sleep_minutes : 30)
        : (Number.isFinite(this._config.boost_minutes) ? this._config.boost_minutes : 30);
      this._picker = { kind, dir, label, val: cur, min, max, step, unit: useC ? "°" : "", mins: defMins, minsMin: 5, minsMax: 120, minsStep: 5 };
    } else {
      const a = (st && st.attributes) || {};
      const useC = this._useC();
      const cur = st && !isNaN(parseFloat(st.state)) ? parseFloat(st.state) : (useC ? 27 : 0);
      const min = Number.isFinite(a.min) ? a.min : (useC ? Math.round(this._range().min) : -10);
      const max = Number.isFinite(a.max) ? a.max : (useC ? Math.round(this._range().max) : 10);
      const step = Number.isFinite(a.step) && a.step > 0 ? a.step : 1;
      const rawUnit = a.unit_of_measurement || (useC ? "°" : "");
      this._picker = { kind, entity, label, val: Math.max(min, Math.min(max, cur)), min, max, step, unit: /°/.test(rawUnit) ? "°" : rawUnit };
    }
    this._renderPicker(true);
  }

  /* ---------- Glow popups (v10.24): pre-cool / pre-heat / time / schedule step ----------
     Centred Glow cards (see DESIGN-LANGUAGE-V2-HOME.md §4, design/popups/). Accent: boost by
     direction, time = schedule lilac, step = the colour of the temperature it holds. */
  _pkPal() {
    const p = this._picker;
    if (!p) return GLOW_PAL.mid;
    if (p.kind === "boost") return p.dir === "cool" ? GLOW_PAL.cool : GLOW_PAL.warm;
    if (p.kind === "step") { const c = this._pickerFaceCls(p.val); return c === "cool" ? GLOW_PAL.cool : c === "warm" ? GLOW_PAL.warm : GLOW_PAL.mid; }
    return GLOW_PAL.mid;
  }
  _pkApplyPal() {
    const inner = this.shadowRoot.querySelector("#pickerOverlay .pk-sheet");
    const pal = this._pkPal();
    if (!inner || inner.__pal === pal) return;
    inner.__pal = pal;
    inner.style.setProperty("--pk-accent", pal.rgb); inner.style.setProperty("--pk-ic", pal.hi);
    inner.style.setProperty("--pk-acc", pal.acc); inner.style.setProperty("--pk-lo", pal.lo);
  }
  _pkMinsOfDay() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
  _pkFmtMins(mins, withAp = true) {
    const m = ((mins % 1440) + 1440) % 1440;
    const hm = this._fmtHM(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
    return hm ? (withAp ? `${hm.t} ${hm.ap}` : hm.t) : "–";
  }
  _pkHelperMins(key) {
    const pre = this._sc("schedule_prefix") || "eight_sleep_me";
    const e = this._hass && this._hass.states[`input_datetime.${pre}_${key}`];
    const hm = e && this._fmtHM(e.state);
    return hm ? hm.mins : null;
  }
  _pkValTxt(v) {
    const p = this._picker;
    if (p.kind === "boost") return this._fmtVal(v);
    return p.unit === "°" ? `${this._fmtHalfC(v)}°` : p.unit ? `${Math.round(v)}${p.unit}` : this._fmtLevel(Math.round(v));
  }
  _pkWhoTxt() {
    const c = this._config;
    if (c._partnerUi && !this._partnerOn()) return "both sides";
    return this._viewingPartner() ? `${c.partner_name || "Partner"}'s side` : "your side";
  }
  // Home's gauge, same geometry (170×108, c(85,88) r72) — drag the rounded handle, centre inert
  _pkGaugeHTML(caption) {
    const track = this._glArc(-100, 100);
    return `<div class="pkg-gauge" id="pkGauge">
            <svg viewBox="0 0 170 108" aria-hidden="true">
              <defs>
                <linearGradient id="pkGrad" gradientUnits="userSpaceOnUse" x1="14" y1="0" x2="156" y2="0"><stop offset="0" class="pkg-s0"/><stop offset="1" class="pkg-s1"/></linearGradient>
                <filter id="pkBlur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="5"/></filter>
              </defs>
              <path class="pkg-track" d="${track}"/>
              <path class="pkg-fillglow" id="pkFillGlow" filter="url(#pkBlur)"/>
              <path class="pkg-fill" id="pkFill" stroke="url(#pkGrad)"/>
              <circle class="pkg-knobglow" id="pkKnobGlow" r="12" filter="url(#pkBlur)"/>
              <circle class="pkg-knob" id="pkKnob" r="9"/>
            </svg>
            <div class="pkg-center"><span class="pkg-num" id="pkNum"></span><span class="pkg-cap">${escapeHtml(caption)}</span></div>
          </div>`;
  }
  _pkPaintGauge() {
    const p = this._picker;
    const $ = (id) => this.shadowRoot.getElementById(id);
    const fill = $("pkFill");
    if (!p || !fill) return;
    const frac = p.max === p.min ? 0 : Math.max(0, Math.min(1, (p.val - p.min) / (p.max - p.min)));
    const a = -100 + frac * 200;
    const d = a > -99.5 ? this._glArc(-100, a) : "";
    fill.setAttribute("d", d);
    const g = $("pkFillGlow"); if (g) g.setAttribute("d", d);
    const [x, y] = this._glPolar(a);
    [$("pkKnob"), $("pkKnobGlow")].forEach((el) => { if (el) { el.setAttribute("cx", x.toFixed(1)); el.setAttribute("cy", y.toFixed(1)); } });
    const gr = $("pkGrad"); if (gr) gr.setAttribute("x2", Math.max(30, x).toFixed(1));
    const n = $("pkNum"); if (n) n.textContent = this._pkValTxt(p.val);
  }
  _wirePkGauge(el) {
    if (!el) return;
    let dragging = false, rect = null, lastV = null, lastHap = 0;
    const geo = (e) => { const r = rect || (rect = el.getBoundingClientRect()); return { x: (e.clientX - r.left) / r.width * 170, y: (e.clientY - r.top) / r.height * 108 }; };
    const at = (pt) => {
      const p = this._picker;
      let deg = Math.atan2(pt.y - 88, pt.x - 85) * 180 / Math.PI + 90;
      if (deg > 180) deg -= 360;
      return p.min + Math.max(0, Math.min(1, (deg + 100) / 200)) * (p.max - p.min);
    };
    el.style.touchAction = "none";
    el.addEventListener("pointerdown", (e) => {
      if (!e.isTrusted || !this._picker) return;
      rect = el.getBoundingClientRect();
      const pt = geo(e);
      if (Math.hypot(pt.x - 85, pt.y - 88) < 44) { rect = null; return; }
      dragging = true;
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      el.classList.add("is-dragging");
      this._pickerSetVal(at(pt)); lastV = this._picker.val; this._haptic("light");
      e.preventDefault(); e.stopPropagation();
    });
    el.addEventListener("pointermove", (e) => {
      if (!dragging || !this._picker) return;
      this._pickerSetVal(at(geo(e)));
      if (this._picker.val !== lastV) { lastV = this._picker.val; const t = Date.now(); if (t - lastHap > 45) { lastHap = t; this._haptic("light"); } }
    });
    const end = () => { if (!dragging) return; dragging = false; rect = null; el.classList.remove("is-dragging"); };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }
  // 12-hour wheel: hour · minute (5-min steps) · am/pm. Swipe or scroll a column to step it, tap a
  // faded row to jump to it; the middle row sits in an accent glass lens.
  _pkWheelHTML(rows) {
    const col = (c) => `<div class="pkw-col${c === "ap" ? " ap" : ""}" data-wcol="${c}"></div>`;
    return `<div class="pkw${rows === 3 ? " r3" : ""}" id="pkWheel" data-rows="${rows}"><div class="pkw-lens"></div>${col("h")}<div class="pkw-sep">:</div>${col("m")}${col("ap")}</div>`;
  }
  _pkWheelStep(c, d) {
    const p = this._picker;
    if (!p || !d) return;
    const pm = p.h >= 12;
    if (c === "h") { const h12 = ((((p.h % 12) || 12) - 1 + d) % 12 + 12) % 12 + 1; p.h = (h12 % 12) + (pm ? 12 : 0); }
    else if (c === "m") p.m = (((Math.round(p.m / 5) * 5 + d * 5) % 60) + 60) % 60;
    else if (c === "ap") p.h = (p.h + 12) % 24;
    this._haptic("light");
    this._syncPickerFace();
  }
  _pkPaintWheel() {
    const p = this._picker;
    const w = this.shadowRoot.getElementById("pkWheel");
    if (!p || !w) return;
    const n = +w.dataset.rows, half = (n - 1) / 2;
    const h12 = (p.h % 12) || 12, pm = p.h >= 12, base = Math.round(p.m / 5) * 5;
    const vals = {
      h: (o) => String(((h12 - 1 + o) % 12 + 12) % 12 + 1),
      m: (o) => String(o === 0 ? p.m : (((base + o * 5) % 60) + 60) % 60).padStart(2, "0"),
      ap: (o) => (o === 0 ? (pm ? "pm" : "am") : o === (pm ? -1 : 1) ? (pm ? "am" : "pm") : ""),
    };
    w.querySelectorAll("[data-wcol]").forEach((col) => {
      const c = col.dataset.wcol;
      const html = Array.from({ length: n }, (_, i) => {
        const o = i - half, v = vals[c](o);
        return `<button class="pkw-r r${Math.abs(o)}" data-wstep="${c}:${o}"${v ? "" : ' tabindex="-1"'}>${v}</button>`;
      }).join("");
      if (col.__h !== html) { col.__h = html; col.innerHTML = html; }
    });
  }
  _wirePkWheel() {
    const w = this.shadowRoot.getElementById("pkWheel");
    if (!w) return;
    const ROW = 26;
    w.querySelectorAll("[data-wcol]").forEach((col) => {
      const c = col.dataset.wcol;
      let y0 = null, pid = null;
      col.style.touchAction = "none";
      col.addEventListener("pointerdown", (e) => { y0 = e.clientY; pid = e.pointerId; col.__swiped = false; });
      col.addEventListener("pointermove", (e) => {
        if (y0 == null || e.pointerId !== pid) return;
        const steps = Math.trunc((e.clientY - y0) / ROW);
        if (!steps) return;
        if (!col.__swiped) { col.__swiped = true; try { col.setPointerCapture(pid); } catch (_) {} }
        y0 += steps * ROW;
        this._pkWheelStep(c, -steps);
      });
      const end = () => { y0 = null; };
      col.addEventListener("pointerup", end);
      col.addEventListener("pointercancel", end);
      col.addEventListener("wheel", (e) => { e.preventDefault(); this._pkWheelStep(c, e.deltaY > 0 ? 1 : -1); }, { passive: false });
    });
  }
  // pre-cool / pre-heat: what the run does between now and bedtime, and what happens after
  _pkBoostPlanHTML() {
    const p = this._picker;
    const now = this._pkMinsOfDay();
    const bed = this._pkHelperMins("bedtime");
    const toBed = bed == null ? null : (bed - now + 1440) % 1440;
    const showBed = toBed != null && toBed > 0 && toBed <= 360;
    const span = Math.max(p.mins * 1.25, showBed ? toBed * 1.12 : 0, 30);
    const pc = (m) => Math.max(0, Math.min(100, 100 * m / span));
    const smartOn = !!(this._sc("smart_entity") && this._smartOn());
    const b = this._boostState.get(this._activeEntity());
    const back = smartOn ? "back to Autopilot" : `back to ${this._fmtVal(b ? b.prevTemp : this._tgtTemp())}`;
    const bedPct = showBed ? pc(toBed) : null;
    const bedLbl = showBed && bedPct > 16 && bedPct < 88 ? `<span style="left:${bedPct.toFixed(1)}%"><b>${this._pkFmtMins(bed, false)}</b>bedtime</span>` : "";
    return `<div class="pkg-tl"><i class="f" style="width:${pc(p.mins).toFixed(1)}%"></i><i class="now"></i>${showBed ? `<i class="pin" style="left:${bedPct.toFixed(1)}%"></i>` : ""}</div>
          <div class="pkg-tl-l"><span class="l"><b>${this._pkFmtMins(now)}</b>now</span>${bedLbl}</div>
          <div class="pkg-note">Ends ${this._pkFmtMins(now + p.mins)} · then ${escapeHtml(back)}</div>`;
  }
  // bedtime / alarm: the night it makes — hours in bed + what moves with it
  _pkWindowHTML() {
    const p = this._picker;
    const ent = String(p.entity || ""), lbl = String(p.label || "").toLowerCase();
    if (/auto.?off/.test(ent + " " + lbl)) return "";
    const isWake = /_wake$|alarm/.test(ent) || /wake|alarm/.test(lbl);
    const isBed = !isWake && (/bedtime/.test(ent) || /bedtime/.test(lbl));
    if (!isWake && !isBed) return "";
    const cur = p.h * 60 + p.m;
    const other = (key) => {
      const alt = ent.replace(/(bedtime|wake|alarm)$/, key);
      const e = alt !== ent && this._hass.states[alt];
      const hm = e && this._fmtHM(e.state);
      return hm ? hm.mins : this._pkHelperMins(key === "alarm" ? "wake" : key);
    };
    const bed = isBed ? cur : other("bedtime");
    const wake = isWake ? cur : other(/_bedtime$/.test(ent) && this._hass.states[ent.replace(/bedtime$/, "alarm")] ? "alarm" : "wake");
    if (bed == null || wake == null) return "";
    const dur = (wake - bed + 1440) % 1440;
    const extra = isBed ? `Pre-cool starts ${this._pkFmtMins(bed - 40)}` : `Warm-up from ${this._pkFmtMins(wake - 30)}`;
    return `<div class="gl-tile pkg-tile">
          <div class="pkg-winrow"><span class="pkg-wend${isBed ? " on" : ""}">${V2_ICON_MOON}<b>${this._pkFmtMins(bed)}</b></span><i class="pkg-winbar"></i><span class="pkg-wend${isWake ? " on" : ""}"><b>${this._pkFmtMins(wake)}</b>${V2_ICON_SUN}</span></div>
          <div class="pkg-winsub"><span>${Math.floor(dur / 60)} h ${String(dur % 60).padStart(2, "0")} min in bed</span><span>${extra}</span></div>
        </div>`;
  }
  _pkStepCtx() {
    const p = this._picker;
    const st = this._hass.states;
    const ph = this._phases().map((x) => {
      const t = st[x.time_entity];
      const hm = this._fmtHM(t ? t.state : x.defTime) || this._fmtHM(x.defTime);
      const l = st[x.level_entity];
      const raw = l ? parseFloat(l.state) : NaN;
      return { ...x, mins: hm ? hm.mins : 0, val: Number.isFinite(raw) ? raw : (p.unit === "°" ? x.defC : x.defLvl) };
    });
    return { i: ph.findIndex((x) => x.key === p.key), ph };
  }
  _pkStripHTML() {
    const p = this._picker;
    const { i, ph } = this._pkStepCtx();
    return ph.map((x, k) => {
      const v = k === i ? p.val : x.val;
      const txt = p.unit === "°" ? `${Math.round(v)}°` : this._fmtLevel(Math.round(v));
      return `<button class="pkg-sc${k === i ? " on" : ""}" data-pkstep="${x.key}" data-label="${escapeHtml(x.label)}"><b class="${k === i ? "" : this._pickerFaceCls(v)}">${txt}</b><span>${escapeHtml(x.short || x.label)}</span></button>`;
    }).join("");
  }
  // ‹ › / strip: move to another step without closing — an edited step is saved first
  _pkHop(key, label) {
    const p = this._picker;
    if (!p || p.kind !== "step" || !key || key === p.key) return;
    if (`${p.h}:${p.m}:${p.val}` !== p.orig) this._savePicker(true);
    this._openPicker("step", key, label);
  }

  _pickerTimeStr() {
    const p = this._picker;
    return String(p.h).padStart(2, "0") + ":" + String(p.m).padStart(2, "0") + ":00";
  }
  // wrap-around minute-of-day math so ▲/▼ never get stuck at the ends
  _pickerBumpHour(d) { const p = this._picker; p.h = (p.h + d + 24) % 24; this._haptic("light"); this._syncPickerFace(); }
  _pickerBumpMin(d) {
    const p = this._picker;
    let total = (p.h * 60 + p.m + d * 5 + 1440) % 1440;
    p.h = Math.floor(total / 60); p.m = total % 60; this._haptic("light"); this._syncPickerFace();
  }
  _pickerSetMin(m) { this._picker.m = m; this._haptic("light"); this._syncPickerFace(); }
  _pickerSetAP(ap) {
    const p = this._picker, isPM = p.h >= 12;
    if (ap === "pm" && !isPM) p.h += 12;
    if (ap === "am" && isPM) p.h -= 12;
    this._haptic("light"); this._syncPickerFace();
  }
  _pickerBumpVal(d) {
    const p = this._picker;
    p.val = Math.max(p.min, Math.min(p.max, Math.round((p.val + d * p.step) / p.step) * p.step));
    this._haptic("light"); this._syncPickerFace();
  }
  _pickerSetVal(v) {
    const p = this._picker;
    p.val = Math.max(p.min, Math.min(p.max, Math.round(v / p.step) * p.step));
    this._syncPickerFace();
  }
  // boost-picker duration stepper (minutes)
  _pickerBumpMins(d) {
    const p = this._picker;
    p.mins = Math.max(p.minsMin, Math.min(p.minsMax, p.mins + d * p.minsStep));
    this._haptic("light"); this._syncPickerFace();
  }
  _pickerSetMins(v) {
    const p = this._picker;
    p.mins = Math.max(p.minsMin, Math.min(p.minsMax, Math.round(v / p.minsStep) * p.minsStep));
    this._syncPickerFace();
  }
  // colour the temp readout on the same pivot as the bed: purple at mid_temp (27°),
  // blue below, red above; level entities colour by sign
  _pickerFaceCls(v) {
    const p = this._picker;
    if (p.unit === "°") { const mid = this._config.mid_temp || 27; return v > mid + 0.3 ? "warm" : v < mid - 0.3 ? "cool" : "mid"; }
    return v < 0 ? "cool" : v > 0 ? "warm" : "neutral";
  }

  // update just the live readout (keeps slider focus/drag intact — no full re-render)
  _syncPickerFace() {
    const p = this._picker; if (!p) return;
    const $ = (id) => this.shadowRoot.getElementById(id);
    if (p.kind === "light") {
      const list = $("pkList");
      if (list) list.querySelectorAll("[data-light]").forEach((b) => b.classList.toggle("on", b.dataset.light === p.sel));
      return;
    }
    if (p.kind === "time" || p.kind === "step") {
      this._pkPaintWheel();
      const chips = $("pkMinChips");
      if (chips) chips.querySelectorAll("[data-min]").forEach((c) => c.classList.toggle("on", +c.dataset.min === p.m));
      if (p.kind === "time") {
        const win = $("pkWin");
        if (win) { const h = this._pkWindowHTML(); if (win.__h !== h) { win.__h = h; win.innerHTML = h; } }
        return;
      }
    }
    // Glow popups (v10.24): gauge + accent for boost/step, then boost's duration/plan/bed-now
    if (p.kind === "boost" || p.kind === "step") {
      this._pkPaintGauge();
      this._pkApplyPal();
      if (p.kind === "step") {
        const s = $("pkStrip");
        if (s) { const h = this._pkStripHTML(); if (s.__h !== h) { s.__h = h; s.innerHTML = h; } }
        return;
      }
      const mEl = $("pkMins"); if (mEl) mEl.textContent = `${p.mins} min`;
      const mc = $("pkMinsChips");
      if (mc) mc.querySelectorAll("[data-mins]").forEach((c) => c.classList.toggle("on", +c.dataset.mins === p.mins));
      const plan = $("pkPlan");
      if (plan) { const h = this._pkBoostPlanHTML(); if (plan.__h !== h) { plan.__h = h; plan.innerHTML = h; } }
      const bn = $("pkBedNow");
      if (bn) {
        const cur = this._curTemp();
        let h = "";
        if (Number.isFinite(cur)) {
          h = `Bed now <b>${escapeHtml(this._fmtVal(cur))}</b>`;
          const d = Math.round((p.val - cur) * 2) / 2;
          if (this._useC() && Math.abs(d) >= 0.5) h += ` · ${this._fmtHalfC(Math.abs(d))}° ${d < 0 ? "cooler" : "warmer"}`;
        }
        if (bn.__h !== h) { bn.__h = h; bn.innerHTML = h; }
      }
      return;
    }
    // numeric face — for "step" this is the SECOND face (pkFace2step); for boost/default it's pkFace
    const faceId = p.kind === "step" ? "pkFace2step" : "pkFace";
    const face = $(faceId);
    const cls = this._pickerFaceCls(p.val);
    if (face) { face.className = "pk-face " + cls; face.innerHTML = `${p.unit === "\u00b0" ? Math.round(p.val) : p.val}<span class="pk-ap">${p.unit}</span>`; }
    const sl = $("pkSlider"); if (sl && +sl.value !== p.val) sl.value = p.val;
    const fill = $("pkSliderFill");
    if (fill) fill.style.width = (100 * (p.val - p.min) / (p.max - p.min || 1)).toFixed(1) + "%";
    if (p.kind === "boost") {
      const face2 = $("pkFace2");
      if (face2) face2.innerHTML = `${p.mins}<span class="pk-ap">min</span>`;
      const sl2 = $("pkSlider2"); if (sl2 && +sl2.value !== p.mins) sl2.value = p.mins;
      const fill2 = $("pkSliderFill2");
      if (fill2) fill2.style.width = (100 * (p.mins - p.minsMin) / (p.minsMax - p.minsMin || 1)).toFixed(1) + "%";
    }
  }
  // A hold-to-customise opens the picker under the finger; lifting it fires a click that can land
  // on the backdrop (the sheet is still animating in) and would close the picker straight away.
  _swallowHoldRelease() {
    if (!this._boostHoldFired || Date.now() - (this._boostHoldAt || 0) > 4000) return false;
    this._boostHoldFired = false;
    return true;
  }
  _closePicker() {
    // the finger-up after a hold-to-customise lands on this overlay, not the chip, so the
    // "swallow the next boost click" flag would otherwise outlive the gesture
    this._boostHoldFired = false;
    const ov = this.shadowRoot.getElementById("pickerOverlay");
    if (ov) {
      ov.classList.remove("open");
      clearTimeout(this._pkModeTimer);
      // delayed so the close transition still plays as whichever shape was open (bottom sheet
      // or centred modal) rather than snapping to the other one mid-animation; cancelled above
      // (and in _openConfirm/_renderPicker) if a new dialog opens again before this fires
      this._pkModeTimer = setTimeout(() => ov.classList.remove("confirm", "modal"), 340);
    }
    this._picker = null;
  }
  _savePicker(keepOpen) {
    const p = this._picker; if (!p || !this._hass) return;
    this._haptic("medium");
    if (p.kind === "step") {
      if (p.timeEnt) this._hass.callService("input_datetime", "set_datetime", { entity_id: p.timeEnt, time: this._pickerTimeStr() });
      if (p.levelEnt) this._hass.callService("input_number", "set_value", { entity_id: p.levelEnt, value: p.val });
    } else if (p.kind === "time") {
      this._hass.callService("input_datetime", "set_datetime", { entity_id: p.entity, time: this._pickerTimeStr() });
    } else if (p.kind === "light") {
      this._hass.callService("input_text", "set_value", { entity_id: p.entity, value: p.sel || "" });
    } else if (p.kind === "boost") {
      this._startBoost(p.dir, { temp: p.val, minutes: p.mins });
    } else {
      this._hass.callService("input_number", "set_value", { entity_id: p.entity, value: p.val });
    }
    if (!keepOpen) this._closePicker();
  }

  _renderPicker() {
    const ov = this.shadowRoot.getElementById("pickerOverlay");
    const p = this._picker;
    if (!ov || !p) return;
    // see _openConfirm's identical guard: a still-pending removal from a just-closed dialog
    // would otherwise strip "confirm"/"modal" off THIS one shortly after it opens
    clearTimeout(this._pkModeTimer);
    const inner = ov.querySelector(".pk-sheet");
    let body;
    if (p.kind === "step") {
      const { i, ph } = this._pkStepCtx();
      const prev = ph[i - 1], next = ph[i + 1];
      body = `
        <div class="pkg-strip" id="pkStrip"></div>
        <div class="gl-tile pkg-tile">
          <div class="pkg-row"><span class="gl-lbl pkg-lbl">Starts at</span><span class="pkg-aside">${prev ? `after ${escapeHtml(prev.label)} · ${this._pkFmtMins(prev.mins)}` : "first step of the night"}</span></div>
          ${this._pkWheelHTML(3)}
        </div>
        <div class="gl-tile pkg-tile">
          <div class="pkg-row"><span class="gl-lbl pkg-lbl">Hold at</span><span class="pkg-aside">${next ? `until ${escapeHtml(next.label)} · ${this._pkFmtMins(next.mins)}` : "until you get up"}</span></div>
          <div class="pkg-gauge-row">
            <button class="pkg-stp" data-act="v-" aria-label="Cooler">${V2_ICON_MINUS}</button>
            ${this._pkGaugeHTML(p.unit === "°" ? "water" : "level")}
            <button class="pkg-stp" data-act="v+" aria-label="Warmer">${V2_ICON_PLUS}</button>
          </div>
        </div>`;
    } else if (p.kind === "time") {
      body = `
        <div class="gl-tile pkg-tile">
          <div class="pkg-row"><span class="gl-lbl pkg-lbl">Time</span><span class="pkg-aside">swipe or tap · 5-min steps</span></div>
          ${this._pkWheelHTML(5)}
          <div class="pkg-chips c4" id="pkMinChips">${[0, 15, 30, 45].map((m) => `<button class="pkg-chip${m === p.m ? " on" : ""}" data-min="${m}">:${String(m).padStart(2, "0")}</button>`).join("")}</div>
        </div>
        <div id="pkWin"></div>`;
    } else if (p.kind === "light") {
      body = p.lights.length
        ? `<div class="pk-list" id="pkList">${p.lights.map((l) => `
            <button class="pk-item ${l.id === p.sel ? "on" : ""}" data-light="${l.id}">
              <span class="pk-item-ic">${ICON_BULB}</span>
              <span class="pk-item-n">${escapeHtml(l.name)}</span>
              <span class="pk-item-r"></span>
            </button>`).join("")}</div>`
        : `<div class="pk-empty">No lights found</div>`;
    } else if (p.kind === "boost") {
      const cool = p.dir === "cool";
      const { max } = this._range();
      body = `
        <div class="gl-tile pkg-tile">
          <div class="pkg-row"><span class="gl-lbl pkg-lbl">${cool ? "Cool to" : "Warm to"}</span><span class="pkg-aside">${escapeHtml(this._pkWhoTxt())}</span></div>
          <div class="pkg-gauge-row">
            <button class="pkg-stp" data-act="v-" aria-label="Cooler">${V2_ICON_MINUS}</button>
            ${this._pkGaugeHTML("target")}
            <button class="pkg-stp" data-act="v+" aria-label="Warmer">${V2_ICON_PLUS}</button>
          </div>
          <div class="pkg-foot${cool ? "" : " split"}"><span id="pkBedNow"></span>${cool ? "" : `<button class="pkg-pill" data-act="max">${GLOW_ICON_BOOST}<span>Max heat · ${escapeHtml(this._fmtVal(max))}</span></button>`}</div>
        </div>
        <div class="gl-tile pkg-tile">
          <div class="pkg-row"><span class="gl-lbl pkg-lbl">For</span><span class="pkg-val" id="pkMins"></span></div>
          <div class="pkg-chips c5" id="pkMinsChips">${[10, 20, 30, 45, 60].map((m) => `<button class="pkg-chip" data-mins="${m}">${m}<small>m</small></button>`).join("")}</div>
          <div id="pkPlan"></div>
        </div>`;
    } else {
      const cls = this._pickerFaceCls(p.val);
      body = `
        <div class="pk-tempface">
          <button class="circ" data-act="v-" aria-label="Cooler">${ICON_MINUS}</button>
          <div class="pk-face ${cls}" id="pkFace">${p.unit === "°" ? Math.round(p.val) : p.val}<span class="pk-ap">${p.unit}</span></div>
          <button class="circ" data-act="v+" aria-label="Warmer">${ICON_PLUS}</button>
        </div>
        <div class="pk-slider-wrap">
          <div class="pk-slider-track"><div class="pk-slider-fill" id="pkSliderFill"></div></div>
          <input class="pk-slider" id="pkSlider" type="range" min="${p.min}" max="${p.max}" step="${p.step}" value="${p.val}">
          <div class="pk-slider-ends"><span>${Math.round(p.min) + p.unit}</span><span>${Math.round(p.max) + p.unit}</span></div>
        </div>`;
    }
    // Glow rebuild (v10.23): boost/time/step now render as a centered hero-badge modal — the
    // same family as the confirm dialogs, not the old bottom-docked sheet — with the picker's
    // own accent (boost tints by direction; time + step share the schedule/Autopilot lilac)
    // carried onto the badge, the steppers and the active chip/segment states. See
    // DESIGN-LANGUAGE-V2-HOME.md §7. Light (entity list) and the classic timeline's plain temp
    // picker stay as bottom sheets — unbounded/variable-length content doesn't suit a fixed card.
    const isModal = p.kind === "boost" || p.kind === "time" || p.kind === "step";
    const pkGlyph = p.kind === "light" ? ICON_BULB : "";
    inner.classList.toggle("pkg", isModal);
    inner.__pal = null;
    if (isModal) this._pkApplyPal();
    else { inner.style.setProperty("--pk-accent", GLOW_PAL.off.rgb); inner.style.setProperty("--pk-ic", GLOW_PAL.off.hi); }
    let titleRow;
    let actionsRow = `<div class="pk-actions">
        <button class="pk-btn ghost" data-act="cancel">Cancel</button>
        <button class="pk-btn save" data-act="save">Save</button>
      </div>`;
    if (isModal) {
      const lbl = String(p.label || ""), ent = String(p.entity || "");
      let icon = V2_ICON_CLOCK, sub = "", right = "", go = "Save", goIcon = GLOW_ICON_CHECK, badgeOn = false;
      if (p.kind === "boost") {
        const cool = p.dir === "cool", run = this._boostActive(this._activeEntity());
        badgeOn = !!run && run.dir === p.dir;
        icon = cool ? GLOW_ICON_PRECOOL : GLOW_ICON_BOOST;
        goIcon = icon;
        sub = `${cool ? "Cools" : "Warms"} ${this._pkWhoTxt()} before you get in`;
        go = `${badgeOn ? "Update" : "Start"} ${cool ? "pre-cool" : "pre-heat"}`;
      } else if (p.kind === "time") {
        const both = `${ent} ${lbl}`;
        const off = /auto.?off/i.test(both), wake = !off && (/_wake$|alarm/i.test(ent) || /wake|alarm/i.test(lbl)), bed = !off && !wake && /bedtime/i.test(both);
        icon = off ? V2_ICON_POWER : wake ? V2_ICON_SUN : bed ? V2_ICON_MOON : V2_ICON_CLOCK;
        sub = off ? "When the bed switches itself off" : wake ? "When your alarm goes off" : bed ? "When the Pod has the bed ready" : "Set the time";
        go = off ? "Save auto-off" : wake ? "Save alarm" : bed ? "Save bedtime" : "Save";
      } else {
        const { i, ph } = this._pkStepCtx();
        const smart = !!(this._sc("smart_entity") && this._smartOn());
        icon = V2_ICON_BED;
        sub = `Step ${i + 1} of ${ph.length} · ${smart ? "Autopilot is on" : "manual schedule"}`;
        right = `<div class="pkg-nav"><button class="pkg-navb" data-act="prev" aria-label="Previous step"${i <= 0 ? " disabled" : ""}>${GLOW_ICON_CHEVL}</button><button class="pkg-navb" data-act="next" aria-label="Next step"${i >= ph.length - 1 ? " disabled" : ""}>${V2_ICON_CHEVR}</button></div>`;
        go = "Save step";
      }
      titleRow = `<div class="pkg-hd"><div class="pkg-badge${badgeOn ? " on" : ""}">${icon}</div><div class="pkg-ht"><div class="pkg-title">${escapeHtml(lbl || "Set")}</div><div class="pkg-sub">${escapeHtml(sub)}</div></div>${right}</div>`;
      actionsRow = `<div class="pk-actions">
        <button class="pk-btn ghost" data-act="cancel">Cancel</button>
        <button class="pk-btn pkg-go" data-act="save">${goIcon}<span>${escapeHtml(go)}</span></button>
      </div>`;
    } else {
      titleRow = `<div class="pk-grip"></div>
         <div class="pk-title">${pkGlyph}${escapeHtml(p.label || (p.kind === "light" ? "Choose a light" : "Set temperature"))}</div>`;
    }
    // a still-present "confirm" from a just-closed confirm dialog (its own removal not yet due
    // — see _closePicker) would otherwise coexist with "modal" and fight it for .pk-sheet's sizing
    ov.classList.remove("confirm");
    ov.classList.toggle("modal", isModal);
    inner.innerHTML = `
      ${titleRow}
      ${body}
      ${actionsRow}`;

    // wire (fresh markup each open)
    inner.onclick = (e) => {
      const b = e.target.closest("[data-act],[data-min],[data-ap],[data-light],[data-mins],[data-wstep],[data-pkstep]");
      if (!b) return;
      e.stopPropagation();
      if (b.dataset.light) { p.sel = b.dataset.light; this._haptic("light"); this._syncPickerFace(); return; }
      if (b.dataset.min != null) return this._pickerSetMin(+b.dataset.min);
      if (b.dataset.ap) return this._pickerSetAP(b.dataset.ap);
      if (b.dataset.mins != null) { p.mins = Math.max(p.minsMin, Math.min(p.minsMax, +b.dataset.mins)); this._haptic("light"); return this._syncPickerFace(); }
      if (b.dataset.wstep) {
        const col = b.closest("[data-wcol]");
        if (col && col.__swiped) { col.__swiped = false; return; }
        const [c, o] = b.dataset.wstep.split(":");
        if (b.textContent.trim()) this._pkWheelStep(c, +o);
        return;
      }
      if (b.dataset.pkstep) return this._pkHop(b.dataset.pkstep, b.dataset.label);
      switch (b.dataset.act) {
        case "h+": return this._pickerBumpHour(1);
        case "h-": return this._pickerBumpHour(-1);
        case "m+": return this._pickerBumpMin(1);
        case "m-": return this._pickerBumpMin(-1);
        case "v+": return this._pickerBumpVal(1);
        case "v-": return this._pickerBumpVal(-1);
        case "max": p.val = p.max; this._haptic("light"); return this._syncPickerFace();
        case "prev": case "next": {
          const { i, ph } = this._pkStepCtx();
          const n = ph[i + (b.dataset.act === "next" ? 1 : -1)];
          if (n) this._pkHop(n.key, n.label);
          return;
        }
        case "cancel": return this._closePicker();
        case "save": return this._savePicker();
      }
    };
    const sl = inner.querySelector("#pkSlider");
    if (sl) { sl.oninput = () => this._pickerSetVal(+sl.value); sl.onchange = () => this._haptic("light"); }
    const sl2 = inner.querySelector("#pkSlider2");
    if (sl2) { sl2.oninput = () => this._pickerSetMins(+sl2.value); sl2.onchange = () => this._haptic("light"); }
    this._wirePkGauge(inner.querySelector("#pkGauge"));
    this._wirePkWheel();
    ov.onclick = (e) => { if (e.target === ov && !this._swallowHoldRelease()) this._closePicker(); };
    // force reflow so the sheet animates up from its off-screen start (rAF is unreliable
    // when the tab is backgrounded), then reveal
    void ov.offsetHeight;
    ov.classList.add("open");
    this._syncPickerFace();
  }

  _renderTimeline() {
    const tls = this.shadowRoot.querySelectorAll(".timeline");
    if (!tls.length) return;
    const st = this._hass.states;
    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();

    const useC = this._useC();
    const smart = this._sc("smart_entity") && this._smartOn();
    const segMap = {};
    if (smart) this._smartSegments().forEach((s) => { segMap[s.key] = s.temp; });
    // build the timeline HTML for a given mode: useSmart=true shows predicted temps, false shows manual helpers
    const build = (useSmart) => {
      const cols = this._phases().map((p) => {
        const ent = st[p.level_entity];
        const raw = ent && ent.state !== "unknown" && ent.state !== "unavailable" ? parseFloat(ent.state) : null;
        let val = raw !== null && !isNaN(raw) ? raw : (useC ? p.defC : p.defLvl);
        if (useSmart && segMap[p.key] != null) val = segMap[p.key];
        const timeEnt = st[p.time_entity];
        const hm = this._fmtHM(timeEnt ? timeEnt.state : p.defTime) || this._fmtHM(p.defTime) || { mins: 0, t: "", ap: "" };
        const disp = (useSmart || useC) ? Math.round(val) + "°" : this._fmtLevel(Math.round(val));
        const cls = useSmart ? (val > 27 ? "warm" : val < 27 ? "cool" : "neutral") : (useC ? this._tempClass(val) : (val < 0 ? "cool" : val > 0 ? "warm" : "neutral"));
        return { ...p, disp, cls, hm };
      });
      let active = 0, best = Infinity;
      cols.forEach((c, i) => { const d = (nowMins - c.hm.mins + 1440) % 1440; if (d < best) { best = d; active = i; } });
      return cols.map((c, i) => {
        const isActive = i === active;
        const icon = c.icon === "bed" ? ICON_BED : c.icon === "alarm" ? ICON_ALARM : "";
        const lvlMi = st[c.level_entity] ? c.level_entity : "";
        const timeMi = st[c.time_entity] ? c.time_entity : "";
        const top = isActive ? `<div class="tl-now">Now</div>` : `<div class="tl-level ${c.cls}">${c.disp}</div>`;
        const lbl = escapeHtml(c.label);
        return `<div class="tl-col ${isActive ? "active" : ""}">
          <button class="tl-top" data-pick="temp" data-ent="${lvlMi}" data-label="${lbl} temp" title="Set ${lbl}">${top}</button>
          <div class="tl-bar"></div>
          <button class="tl-time" data-pick="time" data-ent="${timeMi}" data-label="${lbl}" title="Set ${lbl} time">${icon}${c.hm.t ? `<span>${c.hm.t}${c.hm.ap}</span>` : `<span>${escapeHtml(c.label)}</span>`}</button>
        </div>`;
      }).join("");
    };
    const smartHtml = build(smart);
    const manualHtml = smart ? build(false) : smartHtml;   // manual-only timelines always show the manual schedule
    tls.forEach((tl) => {
      const manualOnly = tl.classList.contains("manual-only");
      tl.classList.toggle("tl-smart", !manualOnly && !!smart);
      tl.innerHTML = manualOnly ? manualHtml : smartHtml;
    });
  }

  // v2 Schedule tab (Autopilot off): the night as a rail of steps, each one a time AND a
  // temperature — tap opens the combined "step" picker sheet. Always shows the manual/base
  // values (never the smart-predicted ones), since these ARE what you're setting.
  _renderStepRail() {
    const rail = this.shadowRoot.getElementById("stepRail");
    if (!rail) return;
    const st = this._hass.states;
    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const useC = this._useC();
    const cols = this._phases().map((p) => {
      const ent = st[p.level_entity];
      const raw = ent && ent.state !== "unknown" && ent.state !== "unavailable" ? parseFloat(ent.state) : null;
      const val = raw !== null && !isNaN(raw) ? raw : (useC ? p.defC : p.defLvl);
      const timeEnt = st[p.time_entity];
      const hm = this._fmtHM(timeEnt ? timeEnt.state : p.defTime) || this._fmtHM(p.defTime) || { mins: 0, t: "", ap: "" };
      const disp = useC ? Math.round(val) + "°" : this._fmtLevel(Math.round(val));
      const cls = useC ? this._tempClass(val) : (val < 0 ? "cool" : val > 0 ? "warm" : "neutral");
      return { ...p, disp, cls, hm };
    });
    let active = 0, best = Infinity;
    cols.forEach((c, i) => { const d = (nowMins - c.hm.mins + 1440) % 1440; if (d < best) { best = d; active = i; } });
    const dotColor = { cool: "#6f8cff", warm: "#ff7a5a", neutral: "#b98cff" };
    rail.innerHTML = cols.map((c, i) => {
      const icon = c.icon === "bed" ? V2_ICON_BED : c.icon === "alarm" ? V2_ICON_ALARM : "";
      const isActive = i === active;
      return `<button class="step-row${isActive ? " active" : ""}" data-step="${c.key}" data-label="${escapeHtml(c.label)}">
        <span class="sr-time">${c.hm.t}<span class="sr-ap">${c.hm.ap}</span></span>
        <span class="sr-rail${i === 0 ? " first" : ""}${i === cols.length - 1 ? " last" : ""}"><i style="background:${dotColor[c.cls] || "#8a93a8"}"></i></span>
        <span class="sr-lbl">${icon}${escapeHtml(c.label)}</span>
        <span class="sr-deg ${c.cls}">${c.disp}</span>
        ${V2_ICON_CHEVR}
      </button>`;
    }).join("");
  }
}

/* ---------- assets ---------- */
// Which glyph stands for each Autopilot input, keyed by the `key` in config.ap_signals.
// A function, not a const map: the V2_ICON_* it returns are declared further down this file,
// and a module-level map would evaluate them before they exist.
function apSignalIcon(key) {
  switch (key) {
    case "forecast": return V2_ICON_CLOUDSUN;
    case "room": return V2_ICON_THERMO;
    case "humidity": return V2_ICON_DROP;
    case "reactive": return V2_ICON_PULSE;
    case "precon": return V2_ICON_CLOCK;
    default: return "";
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// Register PP Neue Montreal (Eight Sleep's font) at the document level once — shadow-DOM
// @font-face is unreliable, and a same-origin /local/ file avoids HA's CSP font restrictions.
// Register the bed-glow colour vars as animatable <color> custom properties at the DOCUMENT level
// (CSS @property inside a shadow-root <style> does not register in Chromium/WebKit). Once registered,
// transitioning them on .bed-wrap makes the photo-bed gradient interpolate (e.g. red -> grey) instead
// of snapping when the on/off/temp class flips. Idempotent — re-registration throws and is ignored.
let _esPropsDone = false;
function ensureAnimatableProps() {
  if (_esPropsDone) return;
  _esPropsDone = true;
  if (!window.CSS || !CSS.registerProperty) return;
  const props = [
    ["--es-bright", "#6f93ff"], ["--es-glow", "#3352e6"], ["--es-rbright", "#5a8dff"],
    ["--es-right", "#2a54e6"], ["--es-deep", "#161f66"], ["--es-deepest", "#0b1038"],
    ["--es-dot", "#3f74ff"],
  ];
  for (const [name, initialValue] of props) {
    try { CSS.registerProperty({ name, syntax: "<color>", inherits: true, initialValue }); } catch (e) { /* already registered */ }
  }
}

// ---- 2D homography → CSS matrix3d (maps a w×h rectangle onto 4 destination corners) ----
// lets us warp a square dot grid onto the mattress's perspective quad so rows stay parallel to its edges
function _adj(m) { return [m[4]*m[8]-m[5]*m[7], m[2]*m[7]-m[1]*m[8], m[1]*m[5]-m[2]*m[4], m[5]*m[6]-m[3]*m[8], m[0]*m[8]-m[2]*m[6], m[2]*m[3]-m[0]*m[5], m[3]*m[7]-m[4]*m[6], m[1]*m[6]-m[0]*m[7], m[0]*m[4]-m[1]*m[3]]; }
function _mmm(a, b) { const c = []; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { let s = 0; for (let k = 0; k < 3; k++) s += a[3*i+k]*b[3*k+j]; c[3*i+j] = s; } return c; }
function _mmv(m, v) { return [m[0]*v[0]+m[1]*v[1]+m[2]*v[2], m[3]*v[0]+m[4]*v[1]+m[5]*v[2], m[6]*v[0]+m[7]*v[1]+m[8]*v[2]]; }
function _basis(p) { const m = [p[0],p[2],p[4], p[1],p[3],p[5], 1,1,1]; const v = _mmv(_adj(m), [p[6],p[7],1]); return _mmm(m, [v[0],0,0, 0,v[1],0, 0,0,v[2]]); }
function homographyMatrix3d(w, h, d) {
  // d = [x1,y1, x2,y2, x3,y3, x4,y4] destination corners (TL,TR,BL,BR) in px
  const s = _basis([0,0, w,0, 0,h, w,h]);
  const t = _mmm(_basis(d), _adj(s));
  for (let i = 0; i < 9; i++) t[i] /= t[8];
  const m = [t[0],t[3],0,t[6], t[1],t[4],0,t[7], 0,0,1,0, t[2],t[5],0,t[8]];
  return "matrix3d(" + m.join(",") + ")";
}

// same homography, but returning the 3x3 so individual points can be projected
// (the dot field needs per-dot positions, not one CSS transform on a plane)
function homographyT(w, h, d) {
  const s = _basis([0,0, w,0, 0,h, w,h]);
  const t = _mmm(_basis(d), _adj(s));
  for (let i = 0; i < 9; i++) t[i] /= t[8];
  return t;
}
function homoProject(t, x, y) {
  const w = t[6] * x + t[7] * y + t[8];
  return [(t[0] * x + t[1] * y + t[2]) / w, (t[3] * x + t[4] * y + t[5]) / w];
}
let _dotUid = 0;

function ensureFont(url) {
  if (url === false || url === "none" || url === "") return;
  const id = "es-neue-montreal-face";
  if (document.getElementById(id)) return;
  const s = document.createElement("style");
  s.id = id;
  s.textContent = `@font-face{font-family:'ESNeueMontreal';src:url('${url}') format('woff2');font-weight:100 900;font-style:normal;font-display:swap;}`;
  document.head.appendChild(s);
}

const ICON_POWER = `<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42A7 7 0 1 1 7.6 6.58L6.17 5.17a9 9 0 1 0 11.66 0z"/></svg>`;
// Eight Sleep brand mark — pixel-traced from the official rounded "8" logo (waist + rounded caps)
const ICON_ES8 = `<svg viewBox="0 0 55 84" width="20" height="30"><path fill="currentColor" d="M12,0 L43,0 A12,12 0 0 1 55,12 L55,32 A9,9 0 0 1 46,41 L9,41 A9,9 0 0 1 0,32 L0,12 A12,12 0 0 1 12,0 Z M9,40 L46,40 A9,9 0 0 1 55,49 L55,72 A12,12 0 0 1 43,84 L12,84 A12,12 0 0 1 0,72 L0,49 A9,9 0 0 1 9,40 Z M20.5,13 A5,5 0 0 0 15.5,18 L15.5,25 A5,5 0 0 0 20.5,30 L35.5,30 A5,5 0 0 0 40.5,25 L40.5,18 A5,5 0 0 0 35.5,13 Z M20.5,51 A5,5 0 0 0 15.5,56 L15.5,66 A5,5 0 0 0 20.5,71 L35.5,71 A5,5 0 0 0 40.5,66 L40.5,56 A5,5 0 0 0 35.5,51 Z"/></svg>`;
const ICON_GEAR = `<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm9-2c0-.5 0-1-.1-1.5l2-1.5-2-3.4-2.3 1a7.6 7.6 0 0 0-2.6-1.5L15.5 2h-4l-.4 2.6c-1 .3-1.8.8-2.6 1.5l-2.3-1-2 3.4 2 1.5c-.1.5-.1 1-.1 1.5s0 1 .1 1.5l-2 1.5 2 3.4 2.3-1c.8.7 1.6 1.2 2.6 1.5l.4 2.6h4l.4-2.6c1-.3 1.8-.8 2.6-1.5l2.3 1 2-3.4-2-1.5c.1-.5.1-1 .1-1.5z"/></svg>`;
const ICON_MINUS = `<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M19 13H5v-2h14v2z"/></svg>`;
const ICON_PLUS = `<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>`;
const ICON_CHEV = `<svg viewBox="0 0 24 24" width="18" height="18" style="vertical-align:-3px"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>`;
const ICON_CHEVR = `<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M9.29 6.71a1 1 0 0 0 0 1.41L13.17 12l-3.88 3.88a1 1 0 1 0 1.42 1.41l4.58-4.58a1 1 0 0 0 0-1.42L10.71 6.7a1 1 0 0 0-1.42 0z"/></svg>`;
const ICON_SPARK = `<svg viewBox="0 0 24 24" width="17" height="17"><path fill="currentColor" d="M12 2l1.6 4.4L18 8l-4.4 1.6L12 14l-1.6-4.4L6 8l4.4-1.6L12 2zm6 10l.9 2.5L21.5 15l-2.6.9L18 18.5l-.9-2.6L14.5 15l2.6-.9L18 12zM6.5 13l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2L3.5 16l2.2-.8.8-2.2z"/></svg>`;
const ICON_CARETUP = `<svg viewBox="0 0 24 24" width="26" height="26"><path fill="currentColor" d="M12 8l6 7H6z"/></svg>`;
const ICON_CARETDN = `<svg viewBox="0 0 24 24" width="26" height="26"><path fill="currentColor" d="M12 16l-6-7h12z"/></svg>`;
const ICON_CLOCK = `<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm.5-13H11v6l5.2 3.1.8-1.3-4.5-2.6V7z"/></svg>`;
const ICON_DROP = `<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 3.2S6 10 6 14a6 6 0 0 0 12 0c0-4-6-10.8-6-10.8zm0 16.3a5 5 0 0 1-5-5c0-.5.2-1.4.9-2.7l.1.2a2.2 2.2 0 0 0 2 1.3 2.2 2.2 0 0 0 2-3.3c.9 1.4 1.5 2.9 1.5 3.8a3 3 0 0 1-1.5 5.4z"/></svg>`;
const ICON_ARROWUP = `<svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M12 4l8 9h-5v7h-6v-7H4z"/></svg>`;
const ICON_ARROWDN = `<svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M12 20l-8-9h5V4h6v7h5z"/></svg>`;
const ICON_AUTO = `<svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M12 2a1 1 0 0 1 1 1v1.06a8 8 0 0 1 6.94 6.94H21a1 1 0 0 1 0 2h-1.06a8 8 0 0 1-6.94 6.94V21a1 1 0 0 1-2 0v-1.06a8 8 0 0 1-6.94-6.94H3a1 1 0 0 1 0-2h1.06A8 8 0 0 1 11 4.06V3a1 1 0 0 1 1-1zm0 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12zm0 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"/></svg>`;

// glow colour sets (mirror the .bed-wrap.is-* CSS vars) so each bed HALF can be coloured
// independently by its own side's climate in dual (split) mode
const GLOW = {
  warm: { bright: "#ff7a68", glow: "#e63924", deep: "#5c130b", deepest: "#2c0704", rbright: "#ff5f4a", right: "#d92817", dot: "#ff5334" },
  mid:  { bright: "#c39bff", glow: "#7a34e6", deep: "#2a1466", deepest: "#150636", rbright: "#b184ff", right: "#6a2ce0", dot: "#a259ff" },
  cool: { bright: "#6f93ff", glow: "#3352e6", deep: "#161f66", deepest: "#0b1038", rbright: "#5a8dff", right: "#2a54e6", dot: "#3f74ff" },
  off:  { bright: "#464a52", glow: "#2c2f36", deep: "#131418", deepest: "#08090b", rbright: "#3d414a", right: "#26282e", dot: "#3a3e46" },
};
const ICON_MOON = `<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-2px;margin-right:5px"><path fill="currentColor" d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.4 5.4 0 0 1-7.54-7.54c-.44-.06-.9-.1-1.36-.1z"/></svg>`;
const ICON_BED = `<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;margin-right:4px"><path fill="currentColor" d="M7 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm12-6h-8v7H3V5H1v15h2v-3h18v3h2v-9a4 4 0 0 0-4-4z"/></svg>`;
const ICON_ALARM = `<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;margin-right:4px"><path fill="currentColor" d="M12 6a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm1 8h-2V9h2v5zm5.03-9.4l-1.42 1.42a9 9 0 0 1 2.36 2.36l1.42-1.42A11 11 0 0 0 18.03 4.6zM5.97 4.6A11 11 0 0 0 3.6 7.36l1.42 1.42a9 9 0 0 1 2.36-2.36L5.97 4.6z"/></svg>`;
const ICON_SUN = `<svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM11 1h2v3.5h-2V1zm0 18.5h2V23h-2v-3.5zM1 11h3.5v2H1v-2zm18.5 0H23v2h-3.5v-2zM4.2 5.6l1.4-1.4 2.5 2.5-1.4 1.4-2.5-2.5zm11.7 11.7l1.4-1.4 2.5 2.5-1.4 1.4-2.5-2.5zm2.5-13.1l1.4 1.4-2.5 2.5-1.4-1.4 2.5-2.5zM4.2 18.4l2.5-2.5 1.4 1.4-2.5 2.5-1.4-1.4z"/></svg>`;
const ICON_BULB = `<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;margin-right:4px"><path fill="currentColor" d="M12 2a7 7 0 0 0-4.1 12.7c.7.5 1.1 1.3 1.1 2.1v.2h6v-.2c0-.8.4-1.6 1.1-2.1A7 7 0 0 0 12 2zM9 19h6v1a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2v-1z"/></svg>`;
const ICON_FLAME = `<svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M12 2s5 4.5 5 9a5 5 0 0 1-10 0c0-1.3.5-2.4 1.2-3.4C8.6 9 9 10 10 10c1 0 1.2-1.2.8-2.6C10.3 5.6 12 4 12 2z"/></svg>`;
const ICON_SNOW = `<svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M11 2h2v4.6l1.8-1.8 1.4 1.4L13 9.4v3.5l3-1.7.3-2.9 1.9.2-.2 1.9 2.5-1.4 1 1.7-2.5 1.4 1.7.9-.9 1.7-2.6-1.4L14.9 15 18 16.8l2.6-1.4.9 1.7-1.7.9 2.5 1.4-1 1.7-2.5-1.4.2 1.9-1.9.2-.3-2.9-3-1.7v3.5l3.2 3.2-1.4 1.4L13 21.4V26h-2v-4.6l-1.8 1.8-1.4-1.4L11 18.4V15l-3 1.7-.3 2.9-1.9-.2.2-1.9-2.5 1.4-1-1.7 2.5-1.4L4.6 15l.9-1.7L8 14.7 11 13v-.1L8 11.2 5.4 12.6l-.9-1.7 1.7-.9L3.7 8.6l1-1.7 2.5 1.4L7 6.4l1.9-.2.3 2.9 3 1.7V7.4L9 4.2l1.4-1.4L11 4.6V2z"/></svg>`;

// ---- v2 (redesign) icon set — Lucide (ISC), vendored from navet/node_modules/lucide-react.
// Kept fully separate from the classic ICON_* constants above so 'classic' stays byte-for-byte
// the original hand-drawn glyphs; only layout:"v2" markup references these. ----
const V2_ICON_HOME = `<svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
const V2_ICON_SCHED = `<svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M5 3 2 6"/><path d="m22 6-3-3"/></svg>`;
const V2_ICON_COACH = `<svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>`;
const V2_ICON_DEV = `<svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m8 9 3 3-3 3"/><path d="M13 15h4"/></svg>`;
const V2_ICON_SLEEP = `<svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/><path d="M15 3h4l-4 5h4"/></svg>`;
const V2_ICON_GEAR = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/></svg>`;
// tab-bar-sized gear (23x23, stroke-width 2) — matches the other tab icons
const V2_ICON_GEAR_TAB = `<svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/></svg>`;
const V2_ICON_MINUS = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>`;
const V2_ICON_PLUS = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>`;
const V2_ICON_CHEVR = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>`;
const V2_ICON_CHEVL = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>`;
const V2_ICON_CHEVD = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;
const V2_ICON_CHEVU = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>`;
const V2_ICON_SPARK = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/><path d="M20 2v4"/><path d="M22 4h-4"/><circle cx="4" cy="20" r="2"/></svg>`;
// same glyph, sized to match the other tab-bar icons (23x23, stroke-width 2)
// Autopilot tab additions to the v2 set. Real Lucide paths (the same 1.21.0 set Navet ships),
// stroke-only at 24x24 like every other V2_ICON_* — never a classic filled glyph (§8).
const V2_ICON_INFO = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`;
const V2_ICON_CLOUDSUN = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="M20 12h2"/><path d="m19.07 4.93-1.41 1.41"/><path d="M15.947 12.65a4 4 0 0 0-5.925-4.128"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"/></svg>`;
const V2_ICON_CLOUDMOON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 16a3 3 0 0 1 0 6H7a5 5 0 1 1 4.9-6z"/><path d="M18.376 14.512a6 6 0 0 0 3.461-4.127c.148-.625-.659-.97-1.248-.714a4 4 0 0 1-5.259-5.26c.255-.589-.09-1.395-.716-1.248a6 6 0 0 0-4.594 5.36"/></svg>`;
const V2_ICON_CLOUDRAIN = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M8 19v1"/><path d="M8 14v1"/><path d="M16 19v1"/><path d="M16 14v1"/><path d="M12 21v1"/><path d="M12 16v1"/></svg>`;
const V2_ICON_THERMO = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/></svg>`;
const V2_ICON_PULSE = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/></svg>`;
const V2_ICON_SLIDERS = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 5H3"/><path d="M12 19H3"/><path d="M14 3v4"/><path d="M16 17v4"/><path d="M21 12h-9"/><path d="M21 19h-5"/><path d="M21 5h-7"/><path d="M8 10v4"/><path d="M8 12H3"/></svg>`;
const V2_ICON_RESET = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`;
const V2_ICON_CHART = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="m19 9-5 5-4-4-3 3"/></svg>`;

// Lucide `fast-forward` — "getting ahead of the phase" on the Autopilot tab's pre-conditioning
// line. Stroke-only like every other V2_ICON_*, never a classic filled glyph.
const V2_ICON_APLEAD = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6a2 2 0 0 1 3.414-1.414l6 6a2 2 0 0 1 0 2.828l-6 6A2 2 0 0 1 12 18z"/><path d="M2 6a2 2 0 0 1 3.414-1.414l6 6a2 2 0 0 1 0 2.828l-6 6A2 2 0 0 1 2 18z"/></svg>`;
const V2_ICON_SPARK_TAB = `<svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/><path d="M20 2v4"/><path d="M22 4h-4"/><circle cx="4" cy="20" r="2"/></svg>`;
const V2_ICON_BED = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4v16"/><path d="M2 8h18a2 2 0 0 1 2 2v10"/><path d="M2 17h20"/><path d="M6 8v9"/></svg>`;
const V2_ICON_ALARM = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M5 3 2 6"/><path d="m22 6-3-3"/></svg>`;
const V2_ICON_FLAME = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4"/></svg>`;
// deliberately the simple 3-line asterisk from the wireframe, not a detailed snowflake — at
// chip size (15px, beside bold text) a busier glyph reads heavier than the label next to it
const V2_ICON_SNOW = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9"/></svg>`;
const V2_ICON_MOON = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/></svg>`;
const V2_ICON_DROP = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/></svg>`;
const V2_ICON_POWER = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/></svg>`;
const V2_ICON_SUN = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`;
const V2_ICON_BULB = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>`;
const V2_ICON_CLOCK = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`;

/* Eight Sleep Pod, front-on 3/4 view matching the product render.
   Blue glow is theme-reactive (CSS vars) and softly breathes; a light streak
   shimmers across the surface. */
const BED_SVG = `
<svg viewBox="0 0 1180 720" class="bed-svg" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="es-bloom" cx="50%" cy="46%" r="60%">
      <stop class="bloom-stop" offset="0%" stop-color="var(--es-bright)"/>
      <stop class="bloom-stop" offset="42%" stop-color="var(--es-glow)"/>
      <stop offset="100%" stop-color="var(--es-glow)" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="es-bloomR" cx="50%" cy="50%" r="55%">
      <stop class="bloom-stop" offset="0%" stop-color="var(--es-rbright)"/>
      <stop offset="100%" stop-color="var(--es-rbright)" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="es-matL" x1="0.25" y1="0" x2="0.55" y2="1">
      <stop class="bloom-stop" offset="0%" stop-color="var(--es-glow)"/>
      <stop class="bloom-stop" offset="100%" stop-color="var(--es-deepest)"/>
    </linearGradient>
    <radialGradient id="es-matR" cx="58%" cy="34%" r="80%">
      <stop class="bloom-stop" offset="0%" stop-color="var(--es-rbright)"/>
      <stop class="bloom-stop" offset="55%" stop-color="var(--es-right)"/>
      <stop class="bloom-stop" offset="100%" stop-color="var(--es-deep)"/>
    </radialGradient>
    <linearGradient id="es-matFront" x1="0" y1="0" x2="1" y2="0">
      <stop class="bloom-stop" offset="0%" stop-color="var(--es-deepest)"/>
      <stop class="bloom-stop" offset="55%" stop-color="var(--es-deep)"/>
      <stop class="bloom-stop" offset="100%" stop-color="var(--es-right)"/>
    </linearGradient>
    <linearGradient id="es-baseTop" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#3a3d44"/><stop offset="100%" stop-color="#26282e"/>
    </linearGradient>
    <linearGradient id="es-baseFront" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#303338"/><stop offset="55%" stop-color="#1c1e22"/><stop offset="100%" stop-color="#0d0e10"/>
    </linearGradient>
    <linearGradient id="es-pillow" x1="0" y1="0" x2="0.12" y2="1">
      <stop offset="0%" stop-color="#ffffff"/><stop offset="50%" stop-color="#f1f3f7"/><stop offset="100%" stop-color="#cbd0da"/>
    </linearGradient>
    <linearGradient id="es-shimmerG" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#fff" stop-opacity="0"/>
      <stop offset="50%" stop-color="#fff" stop-opacity="0.16"/>
      <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <filter id="es-soft" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="46"/></filter>
    <filter id="es-soft2" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="30"/></filter>
    <filter id="es-pillowShadow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="9"/></filter>
    <filter id="es-fabric"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch" result="n"/>
      <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.05 0"/></filter>
    <clipPath id="es-matClip">
      <polygon points="278,205 590,200 590,470 150,470"/>
      <polygon points="590,200 902,205 1030,470 590,470"/>
    </clipPath>
    <clipPath id="es-baseClip"><polygon points="118,470 1062,470 1032,662 148,662"/></clipPath>
  </defs>

  <!-- ambient bloom (breathing) -->
  <ellipse class="ambient" cx="590" cy="360" rx="470" ry="235" fill="url(#es-bloom)" filter="url(#es-soft)"/>
  <ellipse class="glow-right" cx="800" cy="330" rx="300" ry="205" fill="url(#es-bloomR)" filter="url(#es-soft2)"/>

  <!-- base foundation -->
  <polygon points="250,196 930,196 1062,470 118,470" fill="url(#es-baseTop)"/>
  <polygon points="118,470 1062,470 1032,662 148,662" fill="url(#es-baseFront)"/>
  <rect x="100" y="460" width="980" height="210" fill="#fff" filter="url(#es-fabric)" clip-path="url(#es-baseClip)" opacity="0.6"/>
  <!-- top rim highlight of the base -->
  <polyline points="118,470 1062,470" fill="none" stroke="#42454c" stroke-width="2" opacity="0.7"/>

  <!-- mattress front thickness band -->
  <polygon class="matfront" points="150,470 1030,470 1030,520 150,520" fill="url(#es-matFront)"/>
  <polygon points="150,470 1030,470 1032,478 150,478" fill="#fff" opacity="0.14"/>

  <!-- mattress top: two glowing halves -->
  <polygon class="mat" points="278,205 590,200 590,470 150,470" fill="url(#es-matL)"/>
  <polygon class="mat" points="590,200 902,205 1030,470 590,470" fill="url(#es-matR)"/>
  <!-- centre seam -->
  <line x1="590" y1="200" x2="590" y2="470" stroke="#0a0f30" stroke-width="4" opacity="0.55"/>
  <line x1="592" y1="200" x2="592" y2="470" stroke="var(--es-bright)" stroke-width="1" opacity="0.25"/>

  <!-- surface shimmer (clipped to the mattress top) -->
  <g clip-path="url(#es-matClip)">
    <rect class="shimmer" x="-140" y="150" width="200" height="360" fill="url(#es-shimmerG)" transform="skewX(-24)"/>
  </g>

  <!-- heating / cooling wave overlay (colour + direction driven by state) -->
  <g class="thermo" clip-path="url(#es-matClip)">
    <g class="thermo-inner">
      <path d="M120 150 Q195 132 270 150 T420 150 T570 150 T720 150 T870 150 T1020 150 T1170 150"/>
      <path d="M120 198 Q195 180 270 198 T420 198 T570 198 T720 198 T870 198 T1020 198 T1170 198"/>
      <path d="M120 246 Q195 228 270 246 T420 246 T570 246 T720 246 T870 246 T1020 246 T1170 246"/>
      <path d="M120 294 Q195 276 270 294 T420 294 T570 294 T720 294 T870 294 T1020 294 T1170 294"/>
      <path d="M120 342 Q195 324 270 342 T420 342 T570 342 T720 342 T870 342 T1020 342 T1170 342"/>
      <path d="M120 390 Q195 372 270 390 T420 390 T570 390 T720 390 T870 390 T1020 390 T1170 390"/>
      <path d="M120 438 Q195 420 270 438 T420 438 T570 438 T720 438 T870 438 T1020 438 T1170 438"/>
      <path d="M120 486 Q195 468 270 486 T420 486 T570 486 T720 486 T870 486 T1020 486 T1170 486"/>
      <path d="M120 534 Q195 516 270 534 T420 534 T570 534 T720 534 T870 534 T1020 534 T1170 534"/>
    </g>
  </g>

  <!-- pillow contact shadows -->
  <ellipse cx="430" cy="250" rx="150" ry="26" fill="#04050d" filter="url(#es-pillowShadow)" opacity="0.55"/>
  <ellipse cx="772" cy="258" rx="158" ry="26" fill="#04050d" filter="url(#es-pillowShadow)" opacity="0.55"/>

  <!-- left pillow (plush, top-lit) -->
  <g>
    <path d="M304,200 C304,168 320,152 358,150 C398,147 468,147 506,150 C542,152 558,168 558,200 C558,232 542,248 506,250 C468,253 398,253 358,250 C320,248 304,232 304,200 Z" fill="url(#es-pillow)"/>
    <!-- top highlight -->
    <path d="M330,180 C372,162 490,162 532,180 C500,172 466,169 430,169 C394,169 360,172 330,180 Z" fill="#ffffff" opacity="0.7"/>
    <!-- soft fold crease -->
    <path d="M344,206 C392,192 470,192 520,206" fill="none" stroke="#c6cbd5" stroke-width="2.5" opacity="0.55"/>
    <!-- bottom soft shade + blue bounce -->
    <path d="M320,232 C360,248 500,248 542,232 C524,244 480,250 430,250 C380,250 338,244 320,232 Z" fill="#b4bac6" opacity="0.5"/>
    <path d="M340,244 C378,252 484,252 522,244 C500,250 466,252 430,252 C394,252 362,250 340,244 Z" fill="var(--es-bright)" opacity="0.22"/>
  </g>
  <!-- right pillow (plush, top-lit) -->
  <g>
    <path d="M636,208 C636,176 652,160 690,158 C730,155 802,155 840,158 C876,160 892,176 892,208 C892,240 876,256 840,258 C802,261 730,261 690,258 C652,256 636,240 636,208 Z" fill="url(#es-pillow)"/>
    <path d="M662,188 C704,170 826,170 868,188 C834,180 800,177 764,177 C728,177 692,180 662,188 Z" fill="#ffffff" opacity="0.7"/>
    <path d="M676,214 C724,200 806,200 856,214" fill="none" stroke="#c6cbd5" stroke-width="2.5" opacity="0.55"/>
    <path d="M652,240 C692,256 836,256 878,240 C860,252 812,258 764,258 C716,258 672,252 652,240 Z" fill="#b4bac6" opacity="0.5"/>
    <path d="M674,252 C712,260 818,260 856,252 C834,258 800,260 764,260 C728,260 696,258 674,252 Z" fill="var(--es-bright)" opacity="0.22"/>
  </g>

  <!-- 8 control panel chip on the base front -->
  <g transform="translate(196,556)">
    <rect x="0" y="0" width="196" height="74" rx="9" fill="#141519" stroke="#2b2e34" stroke-width="1.5"/>
    <rect x="14" y="14" width="46" height="46" rx="8" fill="#0b0c0e" stroke="#33363d" stroke-width="1"/>
    <text x="37" y="47" text-anchor="middle" font-family="Arial, sans-serif" font-size="26" font-weight="800" fill="#eef1f6">8</text>
    <rect x="72" y="16" width="70" height="6" rx="3" fill="#3a3d44"/>
    <rect x="72" y="28" width="52" height="5" rx="2.5" fill="#2a2d33"/>
    <g fill="#2a2d33">
      <rect x="72" y="46" width="16" height="14" rx="2"/>
      <rect x="94" y="46" width="16" height="14" rx="2"/>
      <rect x="116" y="46" width="16" height="14" rx="2"/>
    </g>
  </g>
</svg>`;

const STYLE = `
  *, *::before, *::after { box-sizing: border-box; }
  :host { display: block; }
  /* no scrollbar chrome on the card's own scrollers (the page-level rule can't reach into this
     shadow root) — the iOS app showed a thin bar down the right edge of every v2 view */
  * { scrollbar-width: none; }
  *::-webkit-scrollbar { display: none; width: 0; height: 0; }
  ha-card {
    display: block;
    position: relative;
    background: #000;
    color: #fff;
    border: none;
    border-radius: 22px;
    overflow: hidden;
    padding: 18px 18px 20px;
    font-family: "ESNeueMontreal", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }

  /* header */
  .hd { display: flex; align-items: center; justify-content: space-between; }
  .hd-left { display: flex; align-items: center; gap: 11px; min-width: 0; }
  .hd-logo { display: inline-flex; align-items: center; justify-content: center; color: #eef1f6; flex: 0 0 auto; opacity: .95; }
  .hd-title { font-size: 30px; font-weight: 800; letter-spacing: -0.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .burger { background: none; border: none; padding: 6px; cursor: pointer; display: flex; flex-direction: column; gap: 5px; }
  .burger span { width: 26px; height: 2.6px; background: #cfd2d8; border-radius: 2px; display: block; }

  /* header nav toggle (Pod / Routine) */
  .hnav { position: relative; display: inline-flex; align-items: center; gap: 2px; padding: 4px; border-radius: 999px; -webkit-tap-highlight-color: transparent; }
  .hnav.lens { background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.08); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); }
  .hnav.segmented { background: rgba(255,255,255,0.06); }
  .hnav-opt { position: relative; z-index: 1; background: none; border: none; color: #8a90a0; cursor: pointer; width: 40px; height: 32px; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center; transition: color .25s; -webkit-tap-highlight-color: transparent; }
  .hnav-opt svg { width: 19px; height: 19px; }
  .hnav-opt.on { color: #0a0f1e; }
  .hnav.segmented .hnav-opt.on { color: #0a0f1e; }
  /* the liquid-glass lens that slides under the active option */
  .hnav-lens { position: absolute; top: 4px; left: 4px; width: 40px; height: 32px; border-radius: 999px; z-index: 0;
    background: linear-gradient(180deg, rgba(255,255,255,0.98), rgba(226,231,242,0.9));
    box-shadow: 0 2px 8px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.9);
    transition: transform .38s cubic-bezier(.22,1,.36,1); }
  .hnav.segmented .hnav-lens { transition: transform .2s ease; box-shadow: none; background: #eef1f6; }
  /* position is set via JS (translateX = index * 42px) so it works for any combination of
     hidden/shown nav buttons — see the headerNav block in _update() */

  /* ---------- routine page ---------- */
  .view-routine, .view-autopilot { padding-top: 4px; }
  .rt-sub { color: #8a93a8; font-size: 14px; font-weight: 500; margin: 2px 0 16px; }
  .rt-card { display: block; width: 100%; text-align: left; box-sizing: border-box; background: #161616; border: none; border-radius: 16px; overflow: hidden; margin-bottom: 14px; }
  .rt-progress .rt-badge { background: #2f6bff; color: #fff; font-size: 15px; font-weight: 700; padding: 14px 18px; }
  .rt-section { color: #eef1f6; font-size: 18px; font-weight: 800; letter-spacing: -0.3px; margin: 22px 2px 12px; }
  .rt-head { color: #eef1f6; font-size: 16px; font-weight: 700; padding: 15px 18px 12px; border-bottom: 1px solid rgba(255,255,255,0.06); }
  .rt-active { color: #6f93ff; font-size: 11px; font-weight: 700; margin-left: 9px; text-transform: uppercase; letter-spacing: .6px; }
  .rt-card.rt-on { outline: 1.5px solid rgba(47,107,255,0.45); outline-offset: -1.5px; }
  .rt-times { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 16px 14px 18px; }
  /* wake-up light (sunrise alarm) card */
  .rt-wl-head { display: flex; align-items: center; }
  .rt-wl-head .wl-ic { color: #ffb44d; display: inline-flex; margin-right: 8px; }
  .rt-wl-head .wl-ic svg { width: 17px; height: 17px; }
  .rt-wl-head .smart-switch { margin-left: auto; cursor: pointer; }
  .rt-wl.rt-lit { outline: 1.5px solid rgba(255,180,77,0.4); outline-offset: -1.5px; }
  .rt-wl-body { padding: 12px 14px 14px; }
  .rt-wl-body .wl-pick { width: 100%; align-items: center; }
  .rt-t.wl-name { font-size: 17px; }
  .rt-t.wl-name.unset { color: #8a90a0; font-weight: 600; }
  .wl-chev { margin-left: auto; color: #6d7178; display: inline-flex; }
  .rt-slot { background: none; border: none; text-align: left; cursor: pointer; display: flex; align-items: flex-start; gap: 9px; padding: 4px 6px; border-radius: 12px; -webkit-tap-highlight-color: transparent; transition: background .15s; }
  .rt-slot:hover { background: rgba(255,255,255,0.05); }
  .rt-slot .rt-ic { color: #7d8496; display: inline-flex; margin-top: 3px; }
  .rt-slot .rt-ic svg { width: 18px; height: 18px; }
  .rt-col { display: flex; flex-direction: column; }
  .rt-t { color: #fff; font-size: 24px; font-weight: 800; letter-spacing: -0.5px; line-height: 1.1; }
  .rt-t .ap { font-size: 14px; font-weight: 700; margin-left: 2px; color: #cfd3dc; }
  .rt-lbl { color: #8a90a0; font-size: 12.5px; font-weight: 500; margin-top: 2px; }

  .rm-uw { background: #161616; border-radius: 16px; padding: 14px 16px 16px; }
  .rm-uw-head { color: #eef1f6; font-size: 15px; font-weight: 800; letter-spacing: -0.2px; margin-bottom: 12px; }
  .rm-uw-chips { display: flex; gap: 8px; margin-bottom: 12px; }
  .rm-uw-chip { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 7px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #cdd3e0; font: inherit; font-size: 12px; font-weight: 600; padding: 12px 6px; border-radius: 14px; cursor: pointer; -webkit-tap-highlight-color: transparent; transition: background .15s, border-color .15s; }
  .rm-uw-chip:hover { background: rgba(255,255,255,0.1); }
  .rm-uw-chip.on { background: rgba(255,255,255,0.14); border-color: #eef1f6; color: #fff; }
  .rm-uw-sw { width: 20px; height: 20px; border-radius: 50%; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.25); }
  .rm-uw-auto { display: flex; align-items: center; gap: 10px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.06); }
  .rm-uw-auto-l { color: #b6bccb; font-size: 13.5px; font-weight: 600; }
  .rm-uw-auto .smart-switch { margin-left: auto; cursor: pointer; }

  /* bed */
  /* the glow colours (--es-glow etc.) are registered as animatable <color> custom properties
     via CSS.registerProperty in ensureAnimatableProps() (document-level — @property inside a
     shadow-root <style> does NOT register), so the photo-bed gradient interpolates red->grey
     instead of snapping when the on/off/temp class changes. The .bed-wrap transition below drives it. */
  .bed-wrap {
    margin: 8px 0 14px; display: flex; justify-content: center;
    transition: filter .6s ease, --es-bright .55s ease, --es-glow .55s ease,
      --es-rbright .55s ease, --es-right .55s ease, --es-deep .55s ease, --es-deepest .55s ease;
    /* iconic blue Pod (default / cooling) */
    --es-bright:#6f93ff; --es-glow:#3352e6; --es-deep:#161f66; --es-deepest:#0b1038;
    --es-rbright:#5a8dff; --es-right:#2a54e6;
  }
  .bed-wrap.is-warm { --es-bright:#ff7a68; --es-glow:#e63924; --es-deep:#5c130b; --es-deepest:#2c0704; --es-rbright:#ff5f4a; --es-right:#d92817; }
  .bed-wrap.is-mid  { --es-bright:#c39bff; --es-glow:#7a34e6; --es-deep:#2a1466; --es-deepest:#150636; --es-rbright:#b184ff; --es-right:#6a2ce0; }
  .bed-wrap.is-cool { --es-bright:#6f93ff; --es-glow:#3352e6; --es-deep:#161f66; --es-deepest:#0b1038; --es-rbright:#5a8dff; --es-right:#2a54e6; }
  .bed-wrap.is-off  { --es-bright:#464a52; --es-glow:#2c2f36; --es-deep:#131418; --es-deepest:#08090b; --es-rbright:#3d414a; --es-right:#26282e; }
  /* off-desaturate the drawn SVG bed only — the photo bed dims per-half so one off side doesn't grey both */
  .bed-wrap.is-off .bed-svg { filter: saturate(.25) brightness(.85); }
  .bed-svg { width: 100%; max-width: 480px; height: auto; display: block; }
  .bed-svg .mat, .bed-svg .matfront, .bed-svg .bloom-stop { transition: stop-color .6s ease, fill .6s ease; }

  /* --- living animation: breathing glow + surface shimmer --- */
  .bed-svg .ambient { transform-box: fill-box; transform-origin: center; animation: es-breathe 6s ease-in-out infinite; }
  .bed-svg .glow-right { transform-box: fill-box; transform-origin: center; animation: es-breathe2 6s ease-in-out infinite; animation-delay: -2.4s; }
  .bed-svg .shimmer { animation: es-shimmer 8s ease-in-out infinite; }
  @keyframes es-breathe  { 0%,100% { opacity:.50; transform:scale(1); } 50% { opacity:.80; transform:scale(1.05); } }
  @keyframes es-breathe2 { 0%,100% { opacity:.30; } 50% { opacity:.62; } }
  @keyframes es-shimmer  { 0% { transform:translateX(-360px) skewX(-24deg); } 55%,100% { transform:translateX(1240px) skewX(-24deg); } }
  /* heating/cooling wave overlay */
  .bed-svg .thermo { opacity: 0; transition: opacity .6s ease; }
  .bed-svg .thermo path { fill: none; stroke: var(--es-bright); stroke-width: 3; opacity: 0.4; }
  .bed-svg .thermo-inner { transform-box: fill-box; }
  .bed-wrap.is-warm .thermo, .bed-wrap.is-mid .thermo, .bed-wrap.is-cool .thermo { opacity: 1; }
  .bed-wrap.is-warm .thermo-inner { animation: es-rise var(--es-wave-dur, 3.2s) linear infinite; }
  .bed-wrap.is-mid  .thermo-inner { animation: es-rise var(--es-wave-dur, 5s) linear infinite; }
  .bed-wrap.is-cool .thermo-inner { animation: es-fall var(--es-wave-dur, 5.5s) linear infinite; }
  .bed-wrap:not(.is-working) .thermo { opacity: .4; }              /* calmer waves when idle/holding */
  .bed-wrap.is-working .ambient { animation-duration: 2.8s; }       /* faster "active" pulse */
  .bed-wrap.is-working .glow-right { animation-duration: 2.8s; }
  .bed-wrap.is-off .thermo { opacity: 0; }
  @keyframes es-rise { from { transform: translateY(0); } to { transform: translateY(-48px); } }
  @keyframes es-fall { from { transform: translateY(-48px); } to { transform: translateY(0); } }
  @media (prefers-reduced-motion: reduce) { .bed-svg .thermo-inner { animation: none !important; } }
  .bed-wrap.is-off .ambient,
  .bed-wrap.is-off .glow-right,
  .bed-wrap.is-off .shimmer { animation: none; }
  .bed-wrap.is-off .ambient { opacity:.12; }
  .bed-wrap.is-off .glow-right { opacity:.1; }
  .bed-wrap.is-off .shimmer { opacity:0; }
  @media (prefers-reduced-motion: reduce) {
    .bed-svg .ambient, .bed-svg .glow-right, .bed-svg .shimmer { animation: none; }
    .bed-svg .ambient { opacity:.6; } .bed-svg .glow-right { opacity:.45; } .bed-svg .shimmer { opacity:0; }
  }
  .bed-img { position: relative; z-index: 1; width: 100%; max-width: 480px; height: auto; display: block; }

  /* ===== v9.4 "Tide" =========================================================
     The mattress reads near-black and every bit of colour on it is a dot of
     light. ONE thing moves: a wave crossing the bed in the direction the Pod is
     working, lighting each row of dots as it passes and leaving it behind.
     Replaces the old bloom + scrolling dot grid + shimmer + rim-runner stack
     (five infinite animations per half, on five unrelated clocks, none of which
     changed shape when the bed reached its target).
     ========================================================================= */
  .bed-photo { position: relative; width: 100%; max-width: 480px; }

  /* the glow the bed throws at the room — wide, soft and dim. es-bed.png is a
     TRANSLUCENT render, so a tight silhouette shadow pools inside the mattress
     base and comes out beige; this stays out of the body. */
  .bed-glow { position: absolute; z-index: 0; top: -13%; bottom: -17%; width: 68%;
    pointer-events: none; filter: blur(30px); opacity: .34; transition: opacity .6s ease;
    background: radial-gradient(50% 44% at 50% 54%, var(--gc, rgba(0,0,0,0)) 0%, rgba(0,0,0,0) 72%); }
  .bed-glow.g-l { left: -3%; }
  .bed-glow.g-r { right: -3%; }

  /* knocks the photo's grey sheet back so the dots are the only colour on the bed */
  .bed-sheet { position: absolute; z-index: 2; inset: 0; pointer-events: none;
    background: rgba(4,5,10,.70); transition: opacity .5s ease; }
  .bed-wrap.is-off:not(.is-dual) .bed-sheet { opacity: .22; }

  .bed-photo-fx {
    position: absolute; z-index: 3; inset: 0; overflow: hidden;
    pointer-events: none;
    /* NO filter and NO blend mode here. Both were being re-evaluated over the whole
       half on every frame of the wave; with the sheet plate underneath, screen and
       normal are the same picture. Hue comes from the saturated --es-dot colours. */
    transition: opacity .6s ease, filter .6s ease, --es-glow .55s ease, --es-bright .55s ease,
      --es-rbright .55s ease, --es-right .55s ease, --es-deep .55s ease, --es-deepest .55s ease;
  }

  /* barely-there deep tint, so the half is not a hole in the photograph */
  .bed-photo-glow { position: absolute; inset: 0; opacity: .05; mix-blend-mode: screen;
    background: radial-gradient(78% 98% at 50% 56%, var(--es-glow), rgba(0,0,0,0) 76%); }

  /* ---- the dot layers ------------------------------------------------------
     Both use the SAME static mask (the field, built in _dotField). Nothing about
     the mask moves — the only animated things are one opacity and one transform on
     leaf elements, which is what a compositor can actually handle. */
  .bed-dots { position: absolute; inset: 0; }
  .bed-dots .dfd { position: absolute; inset: 0; overflow: hidden; contain: paint;
    -webkit-mask-image: var(--dots, none); mask-image: var(--dots, none);
    -webkit-mask-size: 100% 100%; mask-size: 100% 100%;
    -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat; }
  /* the resting field: flat colour through the dot mask. --es-dot is a registered
     <color>, so warm/cool still cross-fades without rebuilding anything. */
  .bed-dots .dfd.dim { background: var(--es-dot, #3f74ff); opacity: .92;
    transition: background 1.6s ease; }   /* v10.8: colour eases on a temp change */
  /* the field breathes whenever the bed is ON — v10.8: a deeper, clearly-visible swell
     (.5 ↔ 1) so an on bed always reads as alive, quicker while working toward a target */
  .bed-photo-fx:not(.is-off) .dfd.dim {
    animation: es-field 11s ease-in-out infinite; will-change: opacity; }
  .bed-photo-fx.is-working .dfd.dim { animation-duration: 6.5s; }
  /* bed_motion: off — lit, but perfectly still (backticks are illegal in this CSS literal) */
  .bed-wrap.no-motion .dfd.dim { animation: none; opacity: .92; will-change: auto; }
  .bed-wrap.no-motion .band, .bed-wrap.no-motion .tide, .bed-wrap.no-motion .commit { display: none; }
  @keyframes es-field { 0%,100% { opacity: .82; } 50% { opacity: 1; } }

  /* ---- "the tide": the travelling swell, WHILE WORKING ONLY --------------
     v10.8.1 (tuner-tuned): the directional tide is the "the Pod is moving air"
     signal — it runs only while .is-working. At target the calm centre-based
     "rings" hold animation takes over (below). */
  .bed-dots .dfd.lit .tide { position: absolute; left: -14%; right: -14%; top: 0; height: 46%;
    background: linear-gradient(180deg, rgba(0,0,0,0) 0%, var(--es-dot, #3f74ff) 30%,
      #eef3ff 50%, var(--es-dot, #3f74ff) 70%, rgba(0,0,0,0) 100%);
    opacity: 0; }
  .bed-photo-fx.is-working .tide {
    animation: es-tide 8s cubic-bezier(.5,0,.5,1) infinite; will-change: transform, opacity; }
  .bed-photo-fx.is-working.is-warm .tide { animation-direction: reverse; }
  .bed-photo-fx:not(.is-working) .tide { display: none; }
  @keyframes es-tide {
    0%   { transform: translateY(-46%); opacity: 0; }
    22%,78% { opacity: 1; }
    100% { transform: translateY(150%); opacity: 0; } }

  /* ---- "rings": the at-target HOLDING animation --------------------------
     v10.8.1: while the bed is ON but not working, a thin luminous halo swells
     from the middle of the mattress on a short clock — a settled heartbeat.
     Centre-based, so it reads as clearly distinct from the working sweep. */
  .bed-dots .dfd.lit .hold { position: absolute; left: -10%; right: -10%; top: 8%;
    height: 0; padding-bottom: 74%; border-radius: 50%; transform-origin: 50% 50%; opacity: 0;
    background: radial-gradient(closest-side, rgba(0,0,0,0) 0%, rgba(0,0,0,0) 38%,
      #eef3ff 50%, var(--es-dot, #3f74ff) 55%, rgba(0,0,0,0) 64%); }
  .bed-photo-fx:not(.is-off):not(.is-working) .hold {
    animation: es-hold 4.5s linear infinite; will-change: transform, opacity; }
  .bed-photo-fx.is-working .hold, .bed-photo-fx.is-off .hold,
  .bed-wrap.no-motion .hold { display: none; }
  @keyframes es-hold {
    0%   { transform: scale(.34); opacity: 0; }
    45%  { opacity: 1; }
    75%  { transform: scale(1.18); opacity: 0; }
    100% { opacity: 0; } }

  /* ---- the commit sweep: one-shot bright pass when the target direction changes ---- */
  .bed-dots .dfd.lit .commit { position: absolute; left: -14%; right: -14%; top: 0; height: 34%;
    background: linear-gradient(180deg, rgba(0,0,0,0), #ffffff 50%, rgba(0,0,0,0)); opacity: 0; }
  .bed-photo-fx.commit-dn .commit { animation: es-wave-dn 1.15s cubic-bezier(.4,0,.3,1) 1; }
  .bed-photo-fx.commit-up .commit { animation: es-wave-up 1.15s cubic-bezier(.4,0,.3,1) 1; }

  /* the wave: a gradient band translated inside the masked layer, so the dots it
     crosses light up and the ones behind it go back to resting. Its white middle is
     what gives a lit dot its hot core. */
  .bed-dots .dfd.lit { background: none; }
  .bed-dots .dfd.lit .band { position: absolute; left: -12%; right: -12%; top: 0; height: 30%;
    background: linear-gradient(180deg, rgba(0,0,0,0) 0%, var(--es-dot, #3f74ff) 26%,
      #ffffff 46%, #ffffff 54%, var(--es-dot, #3f74ff) 74%, rgba(0,0,0,0) 100%);
    opacity: 0; }
  .bed-photo-fx.is-working .band { will-change: transform; }
  /* the wave travels ONLY while the Pod is doing thermal work: travel means
     working, stillness means arrived */
  .bed-photo-fx.is-working.is-cool .band { animation: es-wave-dn var(--es-wave-dur, 5.2s) cubic-bezier(.45,0,.55,1) infinite; }
  .bed-photo-fx.is-working.is-warm .band { animation: es-wave-up var(--es-wave-dur, 3.8s) cubic-bezier(.45,0,.55,1) infinite; }
  @keyframes es-wave-dn {
    0%   { transform: translateY(-25%); opacity: 0; }
    18%,82% { opacity: 1; }
    100% { transform: translateY(155%); opacity: 0; } }
  @keyframes es-wave-up {
    0%   { transform: translateY(155%); opacity: 0; }
    18%,82% { opacity: 1; }
    100% { transform: translateY(-25%); opacity: 0; } }
  /* at target: no wave at all — the resting field just sits a little brighter */
  .bed-photo-fx:not(.is-working) .band { display: none; }
  .bed-photo-fx.is-off { opacity: .16; }
  .bed-photo-fx.is-off .dfd.lit { display: none; }
  .bed-photo-fx.is-off .dfd.dim { animation: none; }

  /* ---- presence: the "body print" -----------------------------------------
     v10.8: while binary_sensor …_presence is on, a warm amber pool sits where the
     sleeper lies — masked to the same dot field, colour INDEPENDENT of warm/cool so
     it reads as a person, not a temperature. Slow heartbeat. Fades out over 3s when
     they leave (residual warmth), fades in over 1.1s when they get in. */
  .bed-dots .dfd.body { opacity: 0; transition: opacity 3s ease;
    transform: translate(var(--body-dx, 0), var(--body-dy, -2%)); }
  .bed-photo-fx.is-occupied .dfd.body { opacity: 1; transition: opacity 1.1s ease; }
  /* v10.13: soft edge comes from the wide gradient falloff, not a filter: blur() —
     blur on an element that also runs es-heartbeat re-rasterises it every frame. */
  .bed-dots .dfd.body i { position: absolute; border-radius: 50%;
    background: radial-gradient(circle, #ffdfa8 0%, rgba(255,213,158,.7) 26%, rgba(255,205,150,.28) 52%, rgba(255,205,150,0) 78%);
    animation: es-heartbeat 4.4s ease-in-out infinite; will-change: transform, opacity; }
  /* positions: tuner-tuned (scale 0.85, leg-spread 0.4); horizontal bias per side via --body-dx */
  .bed-dots .dfd.body .b-torso { left: 37%; top: 15.0%; width: 23.0%; height: 19.6%; }
  .bed-dots .dfd.body .b-hips  { left: 39%; top: 30.8%; width: 19.6%; height: 16.2%; animation-delay: .35s; }
  .bed-dots .dfd.body .b-legs  { left: 41%; top: 42.4%; width: 13.6%; height: 18.7%; animation-delay: .7s; }
  @keyframes es-heartbeat { 0%,100% { transform: scale(1); opacity: .74; }
    50% { transform: scale(1.05); opacity: 1; } }
  .bed-wrap.no-motion .dfd.body i { animation: none; }
  /* dual bed: each half is a DISTINCT rounded box clipped to its side of the mattress surface,
     coloured by that side's climate. A gap down the centre keeps them visually separate. */
  /* half clip-paths are set inline per side (glow_poly_left / glow_poly_right) in _paintBedHalves */
  /* subtle lift on the half currently being controlled (only while split) */
  .bed-wrap.is-dual .bed-half { transition: opacity .6s ease; }
  .bed-wrap.is-dual .bed-half:not(.half-active):not(.is-off) { opacity: .72; }

  /* green "pumping" priming overlay — shown only while the Pod is priming (circulating water) */
  .bed-priming { position: absolute; z-index: 4; inset: 0; overflow: hidden; pointer-events: none; mix-blend-mode: screen; opacity: 0; transition: opacity .5s ease; }
  .bed-wrap.is-priming .bed-priming { opacity: 1; }
  .bed-priming .bp-glow {
    position: absolute; inset: 0; transform-box: fill-box; transform-origin: center;
    background: radial-gradient(70% 90% at 50% 58%, #22e08a, transparent 72%);
    animation: es-pump 1.5s ease-in-out infinite;
  }
  .bed-priming .bp-flow {
    position: absolute; inset: -25% 0;
    background: repeating-linear-gradient(0deg, transparent 0, transparent 12px, #5affab 16px, transparent 28px);
    opacity: .16;
    -webkit-mask-image: radial-gradient(78% 92% at 50% 55%, #000 52%, transparent 80%);
            mask-image: radial-gradient(78% 92% at 50% 55%, #000 52%, transparent 80%);
    animation: es-flow 1.1s linear infinite;
  }
  @keyframes es-pump { 0%,100% { opacity: .4; transform: scale(1); } 45% { opacity: .9; transform: scale(1.035); } }
  @keyframes es-flow { from { transform: translateY(0); } to { transform: translateY(-28px); } }
  @media (prefers-reduced-motion: reduce) { .bed-priming .bp-glow, .bed-priming .bp-flow { animation: none; } }

  /* status bar: light (green ready/priming · amber needs priming · red add water) + water + Prime */
  .prime-bar {
    display: flex; align-items: center; gap: 9px; margin: -2px 2px 6px; padding: 4px 10px 4px 14px;
    background: linear-gradient(165deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02));
    -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
    border: 1px solid rgba(255,255,255,0.09);
    border-radius: 14px;
  }
  .prime-bar .ps-dot { width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto; background: #33d17a; box-shadow: 0 0 8px rgba(51,209,122,.75); transition: background .3s, box-shadow .3s; }
  .prime-bar.warn .ps-dot { background: #ffb020; box-shadow: 0 0 8px rgba(255,176,32,.75); }
  .prime-bar.bad  .ps-dot { background: #ff5a52; box-shadow: 0 0 9px rgba(255,90,82,.8); }
  .prime-bar.pulse .ps-dot { animation: es-dot-pulse 1.2s ease-in-out infinite; }
  .prime-bar .ps-text { color: #c7ccd6; font-size: 12.5px; font-weight: 600; white-space: nowrap; }
  .prime-bar .ps-water { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; color: #6f8cff; font-size: 12px; font-weight: 600; white-space: nowrap; }
  .prime-bar .ps-water .ps-drop { display: inline-flex; }
  .prime-bar .ps-water.low { color: #ff7a5a; }
  .prime-btn { flex: 0 0 auto; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12); color: #eef1f6; font: inherit; font-size: 12.5px; font-weight: 700; padding: 6px 14px; border-radius: 999px; cursor: pointer; -webkit-tap-highlight-color: transparent; transition: background .15s; }
  .prime-btn:hover { background: rgba(255,255,255,0.14); }
  .prime-btn:active { background: rgba(255,255,255,0.2); }
  .prime-btn[hidden] { display: none; }
  .prime-btn.cancel { background: rgba(255,90,82,0.15); border-color: rgba(255,90,82,0.4); color: #ff8a7a; }
  .prime-btn.cancel:hover { background: rgba(255,90,82,0.24); }
  @keyframes es-dot-pulse { 0%,100% { opacity: .5; transform: scale(.8); } 50% { opacity: 1; transform: scale(1.2); } }
  @media (prefers-reduced-motion: reduce) { .prime-bar.pulse .ps-dot { animation: none; } }
  /* confirm-sheet message (reuses the picker bottom sheet) */
  .pk-msg { color: #aeb4c4; font-size: 14px; line-height: 1.45; text-align: center; margin: 4px 6px 2px; }
  /* separate pillow layer composited ON TOP of the glow (stays neutral); position via pillow_style */
  /* default two-layer contact shadow grounds the pillows on the mattress (override via pillow_shadow) */
  .bed-pillows { position: absolute; z-index: 5; left: 0; top: 0; width: 100%; height: auto; display: block; pointer-events: none;
    filter: drop-shadow(0 5px 4px rgba(0,0,0,.55)) drop-shadow(0 16px 15px rgba(0,0,0,.38)); }
  .bed-wrap.is-off .bed-pillows { filter: saturate(.25) brightness(.85) drop-shadow(0 6px 8px rgba(0,0,0,.5)); }
  @media (prefers-reduced-motion: reduce) {
    .bed-dots .dfd, .bed-dots .band, .bed-dots .tide, .bed-dots .commit, .bed-dots .hold,
    .bed-dots .dfd.body i { animation: none !important; }
    .bed-dots .band, .bed-dots .tide, .bed-dots .commit, .bed-dots .hold { display: none; }
    .bed-dots .dfd.dim { opacity: .9; }
  }

  /* tiles — liquid glass surface */
  .tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .tile {
    background: linear-gradient(165deg, rgba(255,255,255,0.09), rgba(255,255,255,0.02));
    -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px);
    border: 1px solid rgba(255,255,255,0.1);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.1);
    border-radius: 20px; padding: 18px 18px 16px; text-align: left; color: inherit;
  }
  .temp-tile { cursor: pointer; font: inherit; -webkit-tap-highlight-color: transparent; display: block; width: 100%; }
  .tile-row { display: flex; align-items: center; justify-content: space-between; }
  .tile-label { color: #8a8d94; font-size: 16px; font-weight: 500; }
  .power { color: #6d7178; display: inline-flex; cursor: pointer; padding: 2px; }
  .power.on { color: #eef1f6; }
  /* full-width temperature tile: draggable ring (number inside) left, steppers right */
  .temp-tile.wide .temp-main { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; }
  .temp-tile.wide .big-level { margin: 4px 0; }
  /* whole wrap is the drag target so grabbing the number (not just the thin ring) slides temp */
  .temp-ring-wrap { position: relative; width: 128px; height: 128px; flex: 0 0 auto; cursor: grab; touch-action: none; }
  .temp-ring-wrap:active { cursor: grabbing; }
  .temp-ring { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
  .temp-ring .tr-track { stroke: #26282d; stroke-width: 5; }
  .temp-ring .tr-fill { stroke: #6f8cff; stroke-width: 5; transition: stroke .5s ease, opacity .4s ease; }
  .temp-ring.warm .tr-fill { stroke: #ff7a5a; } .temp-ring.cool .tr-fill { stroke: #6f8cff; } .temp-ring.mid .tr-fill { stroke: #9a5cf0; }
  .temp-ring.off .tr-fill { stroke: #464a52; }
  .is-dragging .tr-knob, .is-dragging .tr-fill, .is-dragging .knob, .is-dragging .fill { transition: none !important; }
  .temp-ring .tr-knob { fill: #fff; filter: drop-shadow(0 0 5px rgba(255,255,255,.55)); transition: opacity .4s ease, fill .5s ease, cx .8s cubic-bezier(.4,0,.2,1), cy .8s cubic-bezier(.4,0,.2,1); }
  .temp-ring.off .tr-knob { fill: #6a6f78; }
  /* current-temp marker — glides smoothly toward the set point ("current at") */
  .temp-ring .tr-cur { fill: #eef1f6; opacity: .9; filter: drop-shadow(0 0 4px rgba(255,255,255,.5)); transition: cx .9s cubic-bezier(.4,0,.2,1), cy .9s cubic-bezier(.4,0,.2,1), opacity .4s ease; }
  .temp-ring.warm .tr-cur { fill: #ffd8ca; } .temp-ring.cool .tr-cur { fill: #d3ddff; } .temp-ring.mid .tr-cur { fill: #e3d4ff; }
  /* "moving to" progress arc — dashes flow from current toward target while working */
  .temp-ring .tr-prog { stroke: rgba(255,255,255,.55); stroke-width: 5; stroke-dasharray: 1.5 6; opacity: 0; transition: opacity .5s ease; animation: es-prog-flow 1s linear infinite; }
  .temp-ring.warm .tr-prog { stroke: #ffb59e; } .temp-ring.cool .tr-prog { stroke: #aebdff; } .temp-ring.mid .tr-prog { stroke: #cbb0ff; }
  .temp-ring .tr-prog.cooling { animation-direction: reverse; }
  @keyframes es-prog-flow { to { stroke-dashoffset: -7.5; } }
  @media (prefers-reduced-motion: reduce) { .temp-ring .tr-prog { animation: none; } }
  /* number sits on top but must not eat the drag; events bubble to the wrap */
  .temp-ring-wrap .big-level { position: absolute; inset: 0; margin: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 34px; pointer-events: none; }
  .temp-ring-wrap .big-level.off { font-size: 24px; }
  .temp-ring-wrap .big-level .bl-main { line-height: 1; }
  .temp-ring-wrap .big-level .bl-sub { font-size: 11px; font-weight: 700; letter-spacing: 0; color: #8a93a8; margin-top: 4px; opacity: 0; transition: opacity .4s ease; }
  .temp-ring-wrap .big-level .bl-sub.shown { opacity: 1; }

  .big-level { font-size: 44px; font-weight: 800; margin: 14px 0 16px; letter-spacing: -1px; transition: color .5s ease, font-size .3s ease; }
  .big-level.off { font-size: 30px; color: #6d7178; }
  .big-level.cool { color: #fff; }
  .big-level.warm { color: #fff; }

  .steppers { display: flex; gap: 16px; }
  .circ {
    width: 46px; height: 46px; border-radius: 50%;
    background: linear-gradient(180deg, rgba(255,255,255,0.14), rgba(255,255,255,0.04));
    -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
    border: 1px solid rgba(255,255,255,0.2);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.28), 0 2px 10px rgba(0,0,0,0.28);
    color: #eef1f6; display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
    transition: background .15s, border-color .15s, transform .1s;
  }
  .circ:active { background: linear-gradient(180deg, rgba(255,255,255,0.22), rgba(255,255,255,0.08)); transform: scale(0.92); }
  .circ.big { width: 62px; height: 62px; }

  /* compact bedtime/alarm strip */
  .info-strip { display: flex; gap: 12px; margin-top: 12px; }
  .info-chip.wide { margin-top: 12px; }
  .info-chip {
    flex: 1; display: flex; align-items: center; gap: 8px;
    background: linear-gradient(165deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02));
    -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
    border: 1px solid rgba(255,255,255,0.09);
    border-radius: 14px; padding: 11px 14px;
  }
  .info-chip .ic { color: #6d7178; display: inline-flex; }
  .info-chip .ic svg { width: 17px; height: 17px; }
  .info-chip .il { color: #8a8d94; font-size: 13px; font-weight: 500; }
  .info-chip .iv { margin-left: auto; font-size: 17px; font-weight: 800; letter-spacing: -0.3px; color: #eef1f6; }
  .info-chip .iv .ap { font-size: 12px; font-weight: 700; color: #9498a0; margin-left: 1px; }
  .info-chip .wl-flag { color: #ffb44d; display: inline-flex; margin-left: 7px; }
  .info-chip .wl-flag svg { width: 14px; height: 14px; }
  .info-chip.wl-on { box-shadow: inset 0 0 0 1px rgba(255,180,77,0.28); }

  /* ===== inline Smart Autopilot panel (home card, expands) — liquid glass ===== */
  .smart-panel {
    margin-top: 6px; border-radius: 20px; overflow: hidden;
    background: linear-gradient(165deg, rgba(122,52,230,0.10), rgba(255,255,255,0.02));
    -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px);
    border: 1px solid rgba(122,52,230,0.22);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.08);
    transition: border-color .3s, background .3s;
  }
  .smart-panel.open { border-color: rgba(122,52,230,.55); background: linear-gradient(165deg, rgba(122,52,230,0.18), rgba(255,255,255,0.03)); }
  .smp-head { display: flex; align-items: center; gap: 10px; width: 100%; padding: 11px 16px; background: none; border: none; color: inherit; font: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .smp-head .smart-ic { color: #8a8d94; display: inline-flex; transition: color .2s; }
  .smart-panel.open .smp-head .smart-ic { color: #c8a8ff; }
  .smp-title { font-size: 15px; font-weight: 700; color: #eef1f6; }
  .smp-sug { font-size: 15px; font-weight: 800; margin-left: 2px; color: #cfd6e6; font-variant-numeric: tabular-nums; }
  .smp-sug.warm { color: #ff8a5a; } .smp-sug.cool { color: #6f8cff; } .smp-sug.mid { color: #b98cff; }
  .smp-head .smart-switch { margin-left: auto; }
  /* "autopilot just adjusted" flash — brief proof-of-life badge under the Smart panel header */
  .smp-flash {
    max-height: 0; opacity: 0; overflow: hidden; margin: 0 14px;
    transition: max-height .35s ease, opacity .3s ease, margin .35s ease;
  }
  .smp-flash.shown { max-height: 40px; opacity: 1; margin: 0 14px 10px; }
  .smp-flash > * { display: inline-flex; align-items: center; }
  .smp-flash {
    display: flex; align-items: center; gap: 6px; padding: 7px 12px; font-size: 12.5px; font-weight: 700;
    background: rgba(255,255,255,0.06); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
    border: 1px solid rgba(255,255,255,0.1); border-radius: 999px; color: #cfd6e6;
  }
  .smp-flash svg { width: 13px; height: 13px; flex: 0 0 auto; }
  .smp-flash.warm { color: #ffb59e; border-color: rgba(255,122,90,0.35); }
  .smp-flash.warm svg { color: #ff8a5a; }
  .smp-flash.cool { color: #b9c8ff; border-color: rgba(111,140,255,0.35); }
  .smp-flash.cool svg { color: #6f8cff; }
  .smp-body { max-height: 0; opacity: 0; overflow: hidden; transition: max-height .38s ease, opacity .3s ease; }
  .smart-panel.open .smp-body { max-height: 1600px; opacity: 1; }
  .smp-body > * { margin: 0 14px; }
  .smp-up, .smp-chart, .smp-why .sm-factors {
    background: rgba(255,255,255,0.05);
    -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: 14px;
  }
  .smp-up { padding: 4px 0 8px; margin-bottom: 10px; }
  .smp-chart { padding: 10px 8px 4px; margin-bottom: 10px; }
  .smp-chart .sm-svg { width: 100%; height: auto; display: block; }
  .smp-bias { margin-bottom: 14px; margin-top: 0; }
  .smp-why { margin-bottom: 10px; }
  .smp-why-hd { font-size: 11.5px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; color: #7f879c; padding: 2px 2px 8px; }
  .smp-why .sm-factors { padding: 2px 0; }
  .sm-ctx { display: flex; flex-wrap: wrap; gap: 5px 16px; padding: 10px 4px 0; font-size: 12.5px; color: #8a93a8; }
  .sm-ctx b { color: #cfd6e6; font-weight: 700; }

  /* manual controls on the home card (always available, even with autopilot on) */
  .manual-panel { margin-top: 14px; transition: opacity .3s ease; }
  .manual-panel.dimmed { opacity: 0.55; }
  .manual-panel.dimmed:hover, .manual-panel.dimmed:focus-within { opacity: 1; }
  .mp-label { color: #7f879c; font-size: 11.5px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; margin: 0 2px 10px; }
  .manual-panel .presets { justify-content: flex-start; margin: 0 0 12px; }
  .manual-panel .autopilot.manual-status { margin: 0 0 12px; justify-content: flex-start; }
  .manual-panel .timeline { margin: 0; }
  /* auto-off timer row */
  /* dual-side toggle pill (sits under the bed) */
  .side-toggle {
    display: flex; align-items: center; gap: 9px; width: fit-content; max-width: 100%; margin: -2px auto 14px; padding: 7px 8px 7px 14px;
    background: linear-gradient(165deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02));
    -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
    border: 1px solid rgba(255,255,255,0.09);
    border-radius: 999px; cursor: pointer; -webkit-tap-highlight-color: transparent; transition: background .15s;
  }
  .side-toggle:hover { background: linear-gradient(165deg, rgba(255,255,255,0.13), rgba(255,255,255,0.04)); }
  .side-toggle .st-ic { color: #6d7178; display: inline-flex; transition: color .2s; }
  .side-toggle .st-ic svg { width: 16px; height: 16px; }
  .side-toggle.active .st-ic { color: #c39bff; }
  .side-toggle .st-lbl { color: #cdd3e0; font-size: 13px; font-weight: 600; white-space: nowrap; }

  /* You / Partner segmented side-selector (shown when the bed is split) */
  .side-sel { display: inline-flex; background: rgba(255,255,255,0.07); border-radius: 999px; padding: 3px; gap: 2px; }
  .side-sel[hidden] { display: none; }
  .side-sel .ss-opt { color: #9aa2b6; font-size: 13px; font-weight: 700; padding: 6px 15px; border-radius: 999px; cursor: pointer; -webkit-tap-highlight-color: transparent; transition: background .15s, color .15s; white-space: nowrap; }
  .side-sel .ss-opt.on { background: #eef1f6; color: #0a0f1e; }
  .dial-sel { margin: 2px auto 8px; }

  .auto-off {
    display: flex; align-items: center; gap: 10px; margin-top: 12px; padding: 12px 14px;
    background: linear-gradient(165deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02));
    -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
    border: 1px solid rgba(255,255,255,0.09);
    border-radius: 14px;
  }
  .auto-off .ao-ic { color: #6d7178; display: inline-flex; transition: color .2s; }
  .auto-off .ao-ic svg { width: 18px; height: 18px; }
  .auto-off.active .ao-ic { color: #ff9a6a; }
  .ao-lbl { font-size: 14px; font-weight: 600; color: #d7dae0; }
  .ao-time { margin-left: auto; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #eef1f6; font: inherit; font-size: 13px; font-weight: 700; padding: 6px 12px; border-radius: 999px; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .ao-time:hover { background: rgba(255,255,255,0.1); }
  .auto-off .smart-switch { margin-left: 0; }

  /* ===== dial overlay (full-screen modal, like the app's temperature screen) ===== */
  .overlay {
    position: fixed; inset: 0; z-index: 100000;
    background: radial-gradient(120% 90% at 50% 8%, #14213f 0%, #0a1122 55%, #05070d 100%);
    padding: 28px 18px 32px;
    display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
    overflow-y: auto;
    opacity: 0; pointer-events: none; transform: translateY(10px);
    transition: opacity .28s ease, transform .28s ease;
  }
  .overlay.open { opacity: 1; pointer-events: auto; transform: translateY(0); }
  /* standalone dial card: render the dial inline instead of as a full-screen modal */
  ha-card.mode-dial { padding: 0; background: #05070d; }
  .overlay.dial-inline { position: static; inset: auto; z-index: auto; transform: none; opacity: 1; pointer-events: auto; border-radius: 22px; min-height: 480px; }
  .ov-inner { width: 100%; max-width: 440px; margin: auto; display: flex; flex-direction: column; align-items: center; }
  .ov-hd { width: 100%; display: flex; align-items: center; justify-content: space-between; }
  .ov-title { background: none; border: none; color: #fff; font-size: 24px; font-weight: 800; letter-spacing: -0.5px; cursor: pointer; padding: 0; display: flex; align-items: center; gap: 4px; }
  .pwr-btn { width: 42px; height: 42px; border-radius: 50%; border: none; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; transition: background .2s, color .2s, border-color .2s; }
  .pwr-btn.on {
    background: linear-gradient(180deg, #ffffff, #e5e9f2); color: #0a0f1e;
    box-shadow: 0 4px 16px rgba(255,255,255,0.18), inset 0 1px 0 rgba(255,255,255,0.9);
  }
  .pwr-btn:not(.on) {
    background: linear-gradient(180deg, rgba(255,255,255,0.12), rgba(255,255,255,0.03));
    -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
    border: 1px solid rgba(255,255,255,0.16);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.18);
    color: #aeb4c4;
  }
  .ov-sub { width: 100%; color: #8a93a8; font-size: 14px; margin: 4px 0 8px; font-weight: 500; }

  /* ---------- in-card picker (bottom sheet) — liquid glass ---------- */
  .picker-ov {
    background: radial-gradient(120% 100% at 50% 100%, rgba(20,24,38,0.5), rgba(2,3,8,0.72));
    -webkit-backdrop-filter: blur(14px) saturate(140%); backdrop-filter: blur(14px) saturate(140%);
    padding: 0; justify-content: flex-end; align-items: center;
    transform: none; z-index: 100001;
  }
  .pk-sheet {
    position: relative; overflow: hidden;
    width: 100%; max-width: 440px; box-sizing: border-box;
    background:
      linear-gradient(180deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0) 16%),
      linear-gradient(165deg, rgba(46,52,72,0.62) 0%, rgba(16,19,30,0.86) 60%, rgba(10,12,20,0.92) 100%);
    -webkit-backdrop-filter: blur(34px) saturate(160%); backdrop-filter: blur(34px) saturate(160%);
    border: 1px solid rgba(255,255,255,0.16); border-bottom: none;
    border-radius: 32px 32px 0 0;
    padding: 10px 22px calc(28px + env(safe-area-inset-bottom, 0px));
    box-shadow:
      0 -24px 60px rgba(0,0,0,0.5),
      inset 0 1px 0 rgba(255,255,255,0.22),
      inset 0 0 60px rgba(255,255,255,0.025);
    display: flex; flex-direction: column; align-items: center;
    transform: translateY(105%); transition: transform .34s cubic-bezier(.22,1,.36,1);
  }
  .picker-ov.open .pk-sheet { transform: translateY(0); }

  /* confirm dialogs render as a small centred modal, not a full-width bottom sheet */
  .picker-ov.confirm { justify-content: center; align-items: center; padding: 0 20px; }
  .picker-ov.confirm .pk-sheet {
    max-width: 360px; width: auto; min-width: 260px;
    align-self: center;
    border: 1px solid rgba(255,255,255,0.18); border-radius: 28px;
    padding: 30px 26px 24px;
    box-shadow: 0 24px 70px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.22);
    transform: translateY(12px) scale(0.94); opacity: 0;
    transition: transform .28s cubic-bezier(.22,1,.36,1), opacity .22s ease;
  }
  .picker-ov.confirm.open .pk-sheet { transform: translateY(0) scale(1); opacity: 1; }
  .picker-ov.confirm .pk-title { justify-content: center; font-size: 19px; margin-bottom: 8px; }
  .picker-ov.confirm .pk-actions { margin-top: 22px; }

  /* Glow rebuild (v10.23): boost/time/step also render as a centred hero-badge modal — same
     family as .confirm (below), just roomier for a slider/chips/second value instead of one
     line of text. Reuses .pk-confirm-badge/.pk-confirm-title verbatim so opening either kind
     of dialog feels like one system, not two. */
  .picker-ov.modal { justify-content: center; align-items: center; padding: 20px; }
  .picker-ov.modal .pk-sheet {
    max-width: 400px; width: 100%; max-height: 88vh; overflow-y: auto;
    align-self: center;
    border: 1px solid rgba(255,255,255,0.18); border-radius: 30px;
    padding: 30px 26px 24px;
    box-shadow: 0 24px 70px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.22);
    transform: translateY(12px) scale(0.95); opacity: 0;
    transition: transform .28s cubic-bezier(.22,1,.36,1), opacity .22s ease;
  }
  .picker-ov.modal.open .pk-sheet { transform: translateY(0) scale(1); opacity: 1; }
  .picker-ov.modal .pk-title { justify-content: center; text-align: center; font-size: 19px; margin-bottom: 8px; }
  .picker-ov.modal .pk-section-hd { text-align: center; width: 100%; letter-spacing: 2px; }
  .picker-ov.modal .pk-actions { margin-top: 22px; }
  /* steppers/segments/chips pick up the picker's own accent (--pk-accent/--pk-ic, set on
     .pk-sheet in _renderPicker) instead of classic's flat grey/invert-to-white — the same
     idle-tint → solid-on-active formula as Home's quick-action tiles (DESIGN-LANGUAGE-V2-HOME §4). */
  .picker-ov.modal .pk-tempface .circ {
    background: linear-gradient(180deg, rgba(var(--pk-accent),0.24), rgba(var(--pk-accent),0.07));
    border: 1px solid rgba(var(--pk-accent),0.38);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.16), 0 4px 14px rgba(var(--pk-accent),0.18);
    color: var(--pk-ic, #eef1f6);
  }
  .picker-ov.modal .pk-seg.on {
    background: linear-gradient(165deg, rgba(var(--pk-accent),0.34), rgba(255,255,255,0.04));
    border: 1px solid rgba(var(--pk-accent),0.5); color: var(--pk-ic, #fff);
    box-shadow: none;
  }
  .picker-ov.modal .pk-chip.on {
    background: linear-gradient(165deg, rgba(var(--pk-accent),0.30), rgba(255,255,255,0.02));
    border-color: rgba(var(--pk-accent),0.48); color: var(--pk-ic, #fff);
    box-shadow: none;
  }
  .picker-ov.modal .pk-slider-fill.accent { background: linear-gradient(90deg, rgba(var(--pk-accent),0.55), rgb(var(--pk-accent))); }

  /* icon badge above the title — an accent-tinted glass chip, same recipe as any semantic panel (§3) */
  .pk-confirm-badge {
    width: 52px; height: 52px; margin-bottom: 14px; border-radius: 16px;
    display: flex; align-items: center; justify-content: center;
    background: linear-gradient(165deg, rgba(var(--pk-accent),0.30), rgba(var(--pk-accent),0.07));
    border: 1px solid rgba(var(--pk-accent),0.4);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.18), 0 6px 18px rgba(var(--pk-accent),0.22);
    color: rgb(var(--pk-accent));
  }
  .pk-confirm-badge svg { width: 24px; height: 24px; }
  .pk-btn.save.danger {
    background: linear-gradient(180deg, #ff8f84, #ff5a52); color: #fff;
    box-shadow: 0 6px 22px rgba(255,90,82,0.35), inset 0 1px 0 rgba(255,255,255,0.4);
  }
  .pk-btn.save.danger:hover { background: #ff6b62; }
  .pk-grip {
    width: 38px; height: 5px; border-radius: 3px; margin: 4px 0 16px;
    background: linear-gradient(90deg, rgba(255,255,255,0.14), rgba(255,255,255,0.34), rgba(255,255,255,0.14));
    box-shadow: 0 1px 2px rgba(0,0,0,0.3);
  }
  .pk-title { display: flex; align-items: center; gap: 8px; color: #f3f5fa; font-size: 18px; font-weight: 700; letter-spacing: -0.3px; margin-bottom: 6px; text-shadow: 0 1px 6px rgba(0,0,0,0.3); }
  .pk-title svg { color: #9aa2b6; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.3)); }
  .pk-face { font-size: 68px; font-weight: 300; letter-spacing: -3px; line-height: 1; color: #f6f8fc; display: inline-flex; align-items: flex-start; text-shadow: 0 2px 16px rgba(255,255,255,0.08), 0 1px 3px rgba(0,0,0,0.35); }
  .pk-face .pk-ap { font-size: 24px; font-weight: 600; letter-spacing: 0; margin: 8px 0 0 4px; color: #9aa2b6; }
  .pk-face.cool { color: #6f8cff; } .pk-face.warm { color: #ff8a5a; } .pk-face.mid { color: #b98cff; } .pk-face.neutral { color: #cfd6e6; }

  .pk-timeface { display: flex; flex-direction: column; align-items: center; gap: 2px; margin: 6px 0 2px; }
  .pk-caret { background: none; border: none; color: #9aa2b6; cursor: pointer; padding: 4px 22px; border-radius: 12px; -webkit-tap-highlight-color: transparent; transition: color .15s, background .15s; }
  .pk-caret:hover { color: #eef1f6; background: rgba(255,255,255,0.05); }
  .pk-caret:active { background: rgba(255,255,255,0.1); }
  .pk-caret.sm { padding: 8px; border-radius: 50%; }
  .pk-minrow { display: flex; align-items: center; gap: 16px; margin: 10px 0 4px; }
  .pk-ap-seg { display: inline-flex; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); border-radius: 999px; padding: 3px; }
  .pk-seg { background: none; border: none; color: #9aa2b6; font: inherit; font-size: 13px; font-weight: 700; padding: 7px 16px; border-radius: 999px; cursor: pointer; -webkit-tap-highlight-color: transparent; transition: background .15s, color .15s; }
  .pk-seg.on { background: linear-gradient(180deg, #fff, #e7ebf3); color: #0a0f1e; box-shadow: 0 2px 8px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.9); }
  .pk-chips { display: flex; gap: 8px; margin: 14px 0 4px; }
  /* entity-list picker (wake-up light) */
  .pk-list { width: 100%; max-height: 44vh; overflow-y: auto; margin: 8px 0 2px; display: flex; flex-direction: column; gap: 6px; }
  .pk-item {
    display: flex; align-items: center; gap: 10px; width: 100%;
    background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08);
    -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
    border-radius: 14px; padding: 12px 14px; color: #dfe3ea; font-size: 15px; font-weight: 600;
    cursor: pointer; text-align: left; -webkit-tap-highlight-color: transparent; transition: background .15s, border-color .15s;
  }
  .pk-item .pk-item-ic { color: #8a90a0; display: inline-flex; }
  .pk-item .pk-item-n { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pk-item .pk-item-r { flex: 0 0 auto; width: 18px; height: 18px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.28); box-sizing: border-box; }
  .pk-item.on { background: rgba(255,180,77,0.14); border-color: rgba(255,180,77,0.4); color: #fff; }
  .pk-item.on .pk-item-ic { color: #ffb44d; }
  .pk-item.on .pk-item-r { border-color: #ffb44d; background: radial-gradient(circle, #ffb44d 42%, transparent 48%); }
  .pk-empty { color: #8a90a0; font-size: 14px; font-weight: 600; padding: 18px 0; }
  .pk-chip {
    background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.14);
    -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
    color: #cdd3e0; font: inherit; font-size: 13px; font-weight: 600; padding: 7px 14px; border-radius: 999px;
    cursor: pointer; -webkit-tap-highlight-color: transparent; transition: background .15s, color .15s, border-color .15s;
  }
  .pk-chip.on { background: rgba(111,140,255,0.28); border-color: rgba(111,140,255,0.55); color: #fff; box-shadow: 0 0 0 1px rgba(111,140,255,0.2), 0 4px 14px rgba(111,140,255,0.2); }

  .pk-tempface { display: flex; align-items: center; gap: 26px; margin: 10px 0 6px; }
  .pk-slider-wrap { width: 100%; margin: 6px 0 2px; position: relative; }
  .pk-slider-track {
    position: absolute; left: 2px; right: 2px; top: 50%; height: 8px; transform: translateY(-50%);
    background: rgba(255,255,255,0.1); box-shadow: inset 0 1px 4px rgba(0,0,0,0.4), inset 0 0 0 1px rgba(255,255,255,0.06);
    border-radius: 4px; overflow: hidden; pointer-events: none;
  }
  .pk-slider-fill { height: 100%; background: linear-gradient(90deg, #6f8cff, #b98cff 55%, #ff8a5a); box-shadow: 0 0 12px rgba(185,140,255,0.35); border-radius: 4px; }
  .pk-slider { -webkit-appearance: none; appearance: none; width: 100%; height: 30px; background: transparent; position: relative; z-index: 1; cursor: pointer; margin: 0; }
  .pk-slider::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none; width: 28px; height: 28px; border-radius: 50%;
    background: radial-gradient(circle at 33% 28%, #ffffff, #eef1f6 55%, #d3d9e6 100%);
    border: 1px solid rgba(255,255,255,0.6);
    box-shadow: 0 3px 10px rgba(0,0,0,0.45), 0 0 0 6px rgba(255,255,255,0.06);
    cursor: grab;
  }
  .pk-slider::-moz-range-thumb {
    width: 28px; height: 28px; border-radius: 50%;
    background: radial-gradient(circle at 33% 28%, #ffffff, #eef1f6 55%, #d3d9e6 100%);
    border: 1px solid rgba(255,255,255,0.6);
    box-shadow: 0 3px 10px rgba(0,0,0,0.45), 0 0 0 6px rgba(255,255,255,0.06);
    cursor: grab;
  }
  .pk-slider-ends { display: flex; justify-content: space-between; color: #7d859a; font-size: 12px; font-weight: 600; margin-top: 4px; }

  .pk-actions { display: flex; gap: 12px; width: 100%; margin-top: 22px; }
  .pk-btn { flex: 1; border: none; font: inherit; font-size: 15px; font-weight: 700; padding: 15px; border-radius: 18px; cursor: pointer; -webkit-tap-highlight-color: transparent; transition: transform .1s, background .15s, box-shadow .15s; }
  .pk-btn:active { transform: scale(0.97); }
  .pk-btn.ghost {
    background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.14);
    -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
    color: #dfe3ea; box-shadow: inset 0 1px 0 rgba(255,255,255,0.12);
  }
  .pk-btn.ghost:hover { background: rgba(255,255,255,0.14); }
  .pk-btn.save {
    background: linear-gradient(180deg, #ffffff, #e5e9f2); color: #0a0f1e;
    box-shadow: 0 6px 22px rgba(255,255,255,0.18), inset 0 1px 0 rgba(255,255,255,0.9);
  }
  .pk-btn.save:hover { background: #fff; }

  /* ---------- Glow popups (v10.24): pre-cool / pre-heat / time / schedule step ----------
     A small Glow surface centred ABOVE any host footer (bottom_chrome), so Cancel / Save never sit
     at the cut-off bottom edge: its own near-black ground glowing top-right in the picker's accent,
     .gl-tile panels, Home's gauge + a 12-hour wheel. DESIGN-LANGUAGE-V2-HOME.md §4, design/popups/. */
  .picker-ov.modal { padding: 16px 14px calc(16px + var(--v2-bottom-chrome, 0px)); }
  .picker-ov.modal .pk-sheet.pkg {
    max-width: 412px; max-height: calc(100dvh - 32px - var(--v2-bottom-chrome, 0px));
    align-items: stretch; text-align: left; padding: 20px 18px 18px; border-radius: 30px; color: #f2f4f1;
    background:
      radial-gradient(80% 40% at 100% 0%, rgba(var(--pk-accent),0.26), rgba(var(--pk-accent),0) 70%),
      linear-gradient(90deg, #060707 0%, #0a0b0c 60%, #0d0e0f 100%);
    border: 1px solid rgba(255,255,255,0.10);
    box-shadow: 0 24px 70px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.08);
    -webkit-backdrop-filter: none; backdrop-filter: none;
  }
  .pk-sheet.pkg::before { content: ""; position: absolute; inset: 0; pointer-events: none;
    background-image: radial-gradient(rgba(255,255,255,0.05) 1px, transparent 1.3px); background-size: 14px 14px; }
  .pk-sheet.pkg > * { position: relative; }
  .pk-sheet.pkg button { font-family: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; transition: transform .1s, background .15s, border-color .15s, color .15s; }
  .picker-ov.modal .pk-sheet.pkg .pk-actions { margin-top: 16px; gap: 10px; }
  .pk-sheet.pkg .pk-btn { height: 54px; padding: 0 12px; font-weight: 600; }
  .pk-sheet.pkg .pk-btn.ghost { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.09); }
  .pk-sheet.pkg .pk-btn.pkg-go { flex: 1.7; display: flex; align-items: center; justify-content: center; gap: 8px; color: #fff; white-space: nowrap;
    background: linear-gradient(180deg, var(--pk-acc), var(--pk-lo)); box-shadow: 0 8px 26px rgba(var(--pk-accent),0.4), inset 0 1px 0 rgba(255,255,255,0.3); }
  .pkg-go svg { width: 19px; height: 19px; flex: none; }
  .pkg-hd { display: flex; align-items: center; gap: 12px; min-height: 44px; }
  .pkg-badge { width: 44px; height: 44px; border-radius: 14px; flex: none; display: grid; place-items: center; background: rgba(var(--pk-accent),0.15); color: var(--pk-ic); }
  .pkg-badge.on { background: var(--pk-acc); color: #fff; box-shadow: 0 0 18px rgba(var(--pk-accent),0.55); }
  .pkg-badge svg { width: 22px; height: 22px; }
  .pkg-ht { flex: 1 1 auto; min-width: 0; }
  .pkg-title { font-size: 22px; font-weight: 500; letter-spacing: -0.3px; line-height: 1.15; color: #f5f7f4; }
  .pkg-sub { font-size: 13px; color: #8d928c; margin-top: 3px; }
  .pkg-nav { display: flex; gap: 6px; flex: none; }
  .pkg-navb { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; padding: 0; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.09); color: #c4c8c2; }
  .pkg-navb:disabled { opacity: 0.3; cursor: default; }
  .pkg-navb svg { width: 18px; height: 18px; }
  .pk-sheet.pkg .pkg-tile { margin-top: 10px; }
  .pkg-row { display: flex; align-items: center; gap: 8px; min-height: 20px; }
  .pkg-lbl { color: var(--pk-ic); }
  .pkg-aside { margin-left: auto; min-width: 0; font-size: 12.5px; color: #8d928c; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pkg-val { margin-left: auto; font-size: 15px; font-variant-numeric: tabular-nums; }
  .pkg-gauge-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: end; gap: 6px; margin-top: 8px; }
  .pkg-gauge { position: relative; width: 100%; max-width: 230px; margin: 0 auto; aspect-ratio: 170 / 108; touch-action: none; }
  .pkg-gauge svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
  .pkg-track { fill: none; stroke: rgba(255,255,255,0.08); stroke-width: 11; stroke-linecap: round; }
  .pkg-fill { fill: none; stroke-width: 11; stroke-linecap: round; }
  .pkg-fillglow { fill: none; stroke: var(--pk-acc); stroke-width: 16; stroke-linecap: round; opacity: 0.55; animation: glPulse 3.2s ease-in-out infinite; }
  .pkg-gauge.is-dragging .pkg-fillglow { animation: none; }
  .pkg-knobglow { fill: var(--pk-acc); opacity: 0.55; }
  .pkg-knob { fill: #f5f7fa; }
  .pkg-s0 { stop-color: var(--pk-lo); }
  .pkg-s1 { stop-color: var(--pk-ic); }
  .pkg-center { position: absolute; left: 0; right: 0; top: 38%; display: flex; flex-direction: column; align-items: center; pointer-events: none; }
  .pkg-num { font-size: clamp(36px, 11vw, 48px); font-weight: 200; letter-spacing: -1.5px; line-height: 1; color: #f5f7f4; font-variant-numeric: tabular-nums; }
  .pkg-cap { font-size: 10.5px; letter-spacing: 1.5px; text-transform: uppercase; color: #8d928c; margin-top: 4px; }
  .pkg-stp { width: 50px; height: 50px; border-radius: 50%; flex: none; display: grid; place-items: center; padding: 0;
    background: rgba(var(--pk-accent),0.12); border: 1px solid rgba(var(--pk-accent),0.32); color: var(--pk-ic); box-shadow: inset 0 1px 0 rgba(255,255,255,0.08); }
  .pkg-stp svg { width: 20px; height: 20px; }
  .pkg-stp:active, .pkg-chip:active, .pkg-navb:active, .pkg-pill:active, .pkg-sc:active { transform: scale(0.95); }
  .pkg-foot { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 32px; margin-top: 8px; font-size: 13px; color: #8d928c; }
  .pkg-foot.split { justify-content: space-between; }
  .pkg-foot b { font-weight: 400; color: #e6e9e4; font-variant-numeric: tabular-nums; }
  .pkg-pill { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border-radius: 999px; border: none; background: rgba(var(--pk-accent),0.14); color: var(--pk-ic); font-size: 12.5px; white-space: nowrap; }
  .pkg-pill svg { width: 14px; height: 14px; }
  .pkg-chips { display: grid; gap: 6px; margin-top: 10px; }
  .pkg-chips.c4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .pkg-chips.c5 { grid-template-columns: repeat(5, minmax(0, 1fr)); }
  .pkg-chip { height: 44px; border-radius: 14px; padding: 0; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.07); color: #c4c8c2; font-size: 15px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .pkg-chip small { font-size: 11px; color: #8d928c; margin-left: 2px; }
  .pkg-chip.on { background: linear-gradient(165deg, rgba(var(--pk-accent),0.32), rgba(255,255,255,0.02)); border-color: rgba(var(--pk-accent),0.52); color: #fff; }
  .pkg-chip.on small { color: var(--pk-ic); }
  .pkg-tl { position: relative; height: 6px; border-radius: 3px; background: rgba(255,255,255,0.07); margin: 18px 6px 0; }
  .pkg-tl .f { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 3px; background: linear-gradient(90deg, rgba(var(--pk-accent),0.45), var(--pk-acc)); box-shadow: 0 0 12px rgba(var(--pk-accent),0.6); }
  .pkg-tl .now { position: absolute; left: 0; top: 50%; width: 12px; height: 12px; border-radius: 50%; transform: translate(-50%, -50%); background: #f5f7fa; box-shadow: 0 0 0 4px rgba(var(--pk-accent),0.25); }
  .pkg-tl .pin { position: absolute; top: 50%; width: 10px; height: 10px; box-sizing: border-box; border-radius: 50%; transform: translate(-50%, -50%); background: #0a0b0c; border: 2px solid #e6e9e4; }
  .pkg-tl-l { position: relative; height: 30px; margin: 8px 6px 0; font-size: 12px; color: #8d928c; }
  .pkg-tl-l span { position: absolute; top: 0; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; line-height: 1.25; white-space: nowrap; }
  .pkg-tl-l span.l { left: -6px; transform: none; align-items: flex-start; }
  .pkg-tl-l b { font-weight: 400; color: #e6e9e4; font-variant-numeric: tabular-nums; }
  .pkg-note { margin-top: 6px; font-size: 13px; color: #b7bcb5; }
  .pkw { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) 14px minmax(0, 1fr) minmax(0, 0.8fr); align-items: center; margin-top: 6px;
    -webkit-mask-image: linear-gradient(180deg, transparent 0%, #000 26%, #000 74%, transparent 100%); mask-image: linear-gradient(180deg, transparent 0%, #000 26%, #000 74%, transparent 100%); }
  .pkw.r3 { -webkit-mask-image: linear-gradient(180deg, rgba(0,0,0,0.35) 0%, #000 30%, #000 70%, rgba(0,0,0,0.35) 100%); mask-image: linear-gradient(180deg, rgba(0,0,0,0.35) 0%, #000 30%, #000 70%, rgba(0,0,0,0.35) 100%); }
  .pkw-lens { position: absolute; left: 0; right: 0; top: 50%; height: 56px; transform: translateY(-50%); border-radius: 16px; pointer-events: none;
    background: linear-gradient(165deg, rgba(var(--pk-accent),0.22), rgba(255,255,255,0.03)); border: 1px solid rgba(var(--pk-accent),0.42);
    box-shadow: 0 0 22px rgba(var(--pk-accent),0.16), inset 0 1px 0 rgba(255,255,255,0.08); }
  .pkw-col { position: relative; display: flex; flex-direction: column; align-items: stretch; user-select: none; -webkit-user-select: none; }
  .pkw-sep { position: relative; text-align: center; font-size: 34px; font-weight: 200; color: rgba(242,244,241,0.5); }
  .pkw-r { height: 44px; padding: 0; border: none; background: none; color: rgba(242,244,241,0.5); font-size: 27px; font-weight: 300; font-variant-numeric: tabular-nums; }
  .pkw-r.r0 { height: 56px; font-size: 42px; font-weight: 200; letter-spacing: -1px; color: #f5f7f4; }
  .pkw-r.r2 { font-size: 21px; color: rgba(242,244,241,0.3); }
  .pkw-col.ap .pkw-r { font-size: 16px; letter-spacing: 1px; }
  .pkw-col.ap .pkw-r.r0 { font-size: 20px; font-weight: 400; color: var(--pk-ic); }
  .pkg-strip { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 3px; margin-top: 12px; }
  .pkg-sc { display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 0; padding: 7px 0; border-radius: 12px; border: none; background: none; }
  .pkg-sc b { font-size: 16px; font-weight: 300; color: #d9ddd6; font-variant-numeric: tabular-nums; }
  .pkg-sc b.cool { color: #5fa8ff; } .pkg-sc b.warm { color: #ff8a5a; } .pkg-sc b.mid { color: #b79bff; }
  .pkg-sc span { max-width: 100%; font-size: 10.5px; color: #8d928c; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pkg-sc.on { background: linear-gradient(165deg, rgba(var(--pk-accent),0.28), rgba(255,255,255,0.02)); box-shadow: inset 0 0 0 1px rgba(var(--pk-accent),0.5); }
  .pkg-sc.on b { color: #fff; } .pkg-sc.on span { color: #f2f4f1; }
  .pkg-winrow { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 12px; }
  .pkg-wend { display: inline-flex; align-items: center; gap: 8px; color: #8d928c; }
  .pkg-wend b { font-size: 17px; font-weight: 300; color: #e6e9e4; font-variant-numeric: tabular-nums; }
  .pkg-wend.on { color: var(--pk-ic); } .pkg-wend.on b { color: #fff; }
  .pkg-wend svg { width: 18px; height: 18px; }
  .pkg-winbar { height: 6px; border-radius: 3px; background: linear-gradient(90deg, var(--pk-acc), rgba(var(--pk-accent),0.25)); box-shadow: 0 0 10px rgba(var(--pk-accent),0.4); }
  .pkg-winsub { display: flex; justify-content: space-between; gap: 10px; margin-top: 8px; font-size: 12.5px; color: #8d928c; }
  @media (max-height: 720px) { .pkw-r { height: 36px; } .pkw-r.r0, .pkw-lens { height: 50px; } .pkg-gauge { max-width: 190px; } }
  @media (prefers-reduced-motion: reduce) { .pkg-fillglow { animation: none; } }

  .dial { position: relative; width: 320px; max-width: 86%; aspect-ratio: 1; margin: 10px 0 4px; }
  .gauge { width: 100%; height: 100%; overflow: visible; cursor: grab; touch-action: none; }
  .gauge:active { cursor: grabbing; }
  .gauge .track { stroke: #232a3d; stroke-width: 8; }
  .gauge .fill { stroke: url(#fillgrad); stroke-width: 8; transition: opacity .4s; filter: drop-shadow(0 0 6px rgba(95,123,255,.55)); }
  .gauge .fill.warm { stroke: url(#fillgradWarm); filter: drop-shadow(0 0 6px rgba(255,120,70,.5)); }
  .gauge .fill.mid { stroke: #9a5cf0; filter: drop-shadow(0 0 6px rgba(154,92,240,.55)); }
  .gauge .curtick { stroke: #c3cad8; stroke-width: 4; stroke-linecap: round; transition: opacity .3s; }
  .gauge .tick { stroke: #2c3446; stroke-width: 2; }
  .gauge .knob { fill: #fff; filter: drop-shadow(0 0 6px rgba(255,255,255,.5)); transition: opacity .3s; cursor: grab; }
  .dial-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; pointer-events: none; }
  .dc-verb { color: #99a2b6; font-size: 18px; font-weight: 500; }
  .dc-level { font-size: 92px; font-weight: 300; line-height: 1; letter-spacing: -3px; margin: 4px 0; color: #6f8cff; transition: color .5s ease; }
  .dc-level.as-temp { font-size: 74px; font-weight: 400; letter-spacing: -2px; }
  .dc-level.cool { color: #6f8cff; }
  .dc-level.warm { color: #ff8a5a; }
  .dc-level.mid { color: #b98cff; }
  .dc-level.neutral { color: #cfd6e6; }
  .dc-now { color: #8a93a8; font-size: 17px; font-weight: 500; }

  .ov-steppers { display: flex; gap: 74px; margin: 6px 0 12px; }

  /* quick-preset chips */
  .presets { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin: 0 0 14px; }
  .chip {
    background: rgba(255,255,255,0.06); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
    border: 1px solid rgba(255,255,255,0.14); box-shadow: inset 0 1px 0 rgba(255,255,255,0.08);
    color: #cdd3e0; font: inherit; font-size: 13px; font-weight: 600; padding: 7px 13px; border-radius: 999px;
    cursor: pointer; -webkit-tap-highlight-color: transparent; transition: background .15s, border-color .15s, color .15s; white-space: nowrap;
  }
  .chip:hover { background: rgba(255,255,255,0.1); }
  .chip.on { background: #eef1f6; color: #0a0f1e; border-color: #eef1f6; }
  .chip.away.on { background: #a855f7; border-color: #a855f7; color: #fff; }
  .chip.boost svg { vertical-align: -2px; margin-right: 5px; }
  .chip.boost.warm.on { background: #ff7a5a; border-color: #ff7a5a; color: #fff; }
  .chip.boost.cool.on { background: #6faaff; border-color: #6faaff; color: #0a0f1e; }
  /* v2: a solid fill + flipped-dark text reads heavy against the rest of the app's dark glass —
     the same subtle accent-tint treatment as everywhere else "on" appears in v2 (.sched-chip.on,
     .v2seg-opt.on's exception aside, since that one deliberately mimics iOS's white pill) */
  .v2home .chip.on { background: linear-gradient(165deg, rgba(255,255,255,0.24), rgba(255,255,255,0.02)); border-color: rgba(255,255,255,0.42); color: #eef1f6; }
  .v2home .chip.away.on { background: linear-gradient(165deg, rgba(168,85,247,0.24), rgba(255,255,255,0.02)); border-color: rgba(168,85,247,0.42); color: #e5cbff; }
  .v2home .chip.boost.warm.on { background: linear-gradient(165deg, rgba(255,138,90,0.24), rgba(255,255,255,0.02)); border-color: rgba(255,138,90,0.42); color: #ffd9cc; }
  .v2home .chip.boost.cool.on { background: linear-gradient(165deg, rgba(111,140,255,0.24), rgba(255,255,255,0.02)); border-color: rgba(111,140,255,0.42); color: #cfe0ff; }
  /* hold-to-edit progress: a fill sweeps left-to-right across the chip while held (Pre Cool Sleep) */
  .chip.boost[data-boost-holdable] { position: relative; overflow: hidden; isolation: isolate;  -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }
  .chip.boost[data-boost-holdable]::before {
    content: ""; position: absolute; inset: 0; z-index: -1; border-radius: inherit;
    background: linear-gradient(90deg, rgba(111,170,255,0.55), rgba(185,140,255,0.4));
    transform: scaleX(0); transform-origin: left; transition: transform .15s ease-out;
  }
  .chip.boost[data-boost-holdable].holding::before { transition: transform var(--hold-ms, 500ms) linear; transform: scaleX(1); }

  /* status row: heating/cooling countdown + ring */
  .autopilot { color: #aeb4c4; font-size: 15px; display: flex; align-items: center; justify-content: center; gap: 9px; margin-bottom: 16px; }
  .autopilot .ring { width: 22px; height: 22px; }
  .autopilot .ring-bg { fill: none; stroke: rgba(255,255,255,0.14); stroke-width: 4; }
  .autopilot .ring-fg { fill: none; stroke: #6f8cff; stroke-width: 4; stroke-linecap: round; transition: stroke-dashoffset .6s ease, opacity .4s; }
  .autopilot.warm .ring-fg { stroke: #ff7a5a; }
  .autopilot.mid .ring-fg { stroke: #9a5cf0; }
  .autopilot.cool .ring-fg { stroke: #6f8cff; }

  .timeline { width: 100%; box-sizing: border-box; background: rgba(255,255,255,0.04); border-radius: 18px; padding: 7px 4px; display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); }
  .tl-col { min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 0 1px; }
  .tl-top { background: none; border: none; padding: 4px 8px; cursor: pointer; font: inherit; border-radius: 8px; -webkit-tap-highlight-color: transparent; }
  .tl-top:hover { background: rgba(255,255,255,0.06); }
  .tl-now { color: #fff; font-weight: 700; font-size: 15px; }
  .tl-level { font-size: 15px; font-weight: 700; }
  .tl-time svg { width: 11px; height: 11px; flex: 0 0 auto; }
  .tl-level.cool { color: #6f8cff; }
  .tl-level.warm { color: #ff7a5a; }
  .tl-level.neutral { color: #cfd6e6; }
  .tl-bar { width: 100%; height: 3px; border-radius: 2px; background: #2a3145; }
  .tl-col.active .tl-bar { background: #fff; }
  .tl-time { background: none; border: none; cursor: pointer; color: #8a93a8; font: inherit; font-size: 10.5px; white-space: nowrap; display: flex; align-items: center; justify-content: center; gap: 1px; padding: 3px 2px; border-radius: 8px; -webkit-tap-highlight-color: transparent; }
  .tl-time:hover { background: rgba(255,255,255,0.06); color: #aeb4c4; }

  /* ===== smart autopilot: temp-tile row ===== */
  .smart-row { display: flex; align-items: center; gap: 8px; margin-top: 16px; padding-top: 13px; border-top: 1px solid #24262c; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .smart-ic { color: #8a8d94; display: inline-flex; transition: color .2s; }
  .smart-row.active .smart-ic { color: #b98cff; }
  .smart-lbl { font-size: 14px; font-weight: 600; color: #d7dae0; }
  .smart-sug { font-size: 13px; font-weight: 700; color: #b98cff; margin-left: 2px; }
  .smart-chev { margin-left: auto; color: #6d7178; display: inline-flex; }
  /* "Liquid glass" switch — track + knob each stack 3 layers (.sw-filter blur+distortion,
     .sw-overlay tint, .sw-specular highlight) over a shared frosted look. Geometry (40x23 track,
     18x18 knob, 2.5px inset, 17px travel) is unchanged from the old flat switch so nothing using
     it needs to move; only the fill is glass now. .smart-switch itself carries no background of
     its own — .sw-overlay is the only paint layer, so a context override (e.g. the Glow Home
     accent below) recolors that, not the switch. */
  .smart-switch {
    width: 40px; height: 23px; border-radius: 999px; position: relative; flex: 0 0 auto;
    overflow: hidden; isolation: isolate; cursor: pointer;
    box-shadow: 0 0 0 1px rgba(255,255,255,0.16);
    transition: box-shadow .25s;
  }
  .smart-switch .sw-filter, .smart-switch .sw-overlay, .smart-switch .sw-specular { position: absolute; inset: 0; border-radius: inherit; }
  .smart-switch > .sw-filter {
    backdrop-filter: blur(3px) saturate(140%) brightness(1.15);
    -webkit-backdrop-filter: blur(3px) saturate(140%) brightness(1.15);
    filter: url(#glass-distortion);
  }
  .smart-switch > .sw-overlay { background: rgba(255,255,255,0.16); transition: background .25s; }
  .smart-switch > .sw-specular { box-shadow: inset 1px 1px 1px rgba(255,255,255,0.45), inset 0 -2px 3px rgba(0,0,0,0.3); }
  .smart-switch .sk {
    position: absolute; top: 2.5px; left: 2.5px; width: 18px; height: 18px; border-radius: 50%;
    overflow: hidden; isolation: isolate;
    transition: transform .25s cubic-bezier(.2,.8,.2,1);
  }
  .smart-switch .sk .sw-filter { backdrop-filter: blur(2px) saturate(140%) brightness(1.2); -webkit-backdrop-filter: blur(2px) saturate(140%) brightness(1.2); filter: url(#glass-distortion); }
  .smart-switch .sk .sw-overlay { background: rgba(255,255,255,0.92); }
  .smart-switch .sk .sw-specular { box-shadow: inset 1px 1px 1px rgba(255,255,255,0.9), inset 0 -1px 1px rgba(0,0,0,0.12); }
  .smart-switch.on { box-shadow: 0 0 10px rgba(122,52,230,0.45), 0 0 0 1px rgba(122,52,230,0.5); }
  .smart-switch.on > .sw-overlay { background: rgba(122,52,230,0.42); }
  .smart-switch.on .sk { transform: translateX(17px); }
  /* smart row inside the dial ("Your temperature") screen */
  .sm-dialrow { display: flex; align-items: center; gap: 10px; width: 100%; max-width: 340px; box-sizing: border-box; margin: 2px auto 14px; padding: 12px 16px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.09); border-radius: 14px; color: #cdd3e0; font: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; transition: background .2s, border-color .2s; }
  .sm-dialrow .smart-lbl { font-size: 14px; font-weight: 600; color: #dfe3ee; }
  .sm-dialrow .smart-ic { color: #9aa2b8; display: inline-flex; }
  .sm-dialrow.active { background: rgba(122,52,230,0.16); border-color: rgba(122,52,230,0.45); }
  .sm-dialrow.active .smart-ic { color: #c8a8ff; }
  .sm-dialrow .smart-chev { margin-left: 0; color: #8a93a8; display: inline-flex; }
  /* dial: coming-up predicted schedule + chart (shown when smart on) */
  .sm-dialextra { width: 100%; max-width: 340px; margin: 0 auto 14px; }
  .sm-up { background: rgba(255,255,255,0.04); border-radius: 14px; padding: 6px 4px 8px; margin-bottom: 12px; }
  .sm-up-hd { font-size: 11.5px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; color: #7f879c; padding: 6px 14px 4px; }
  .sm-up-row { display: flex; align-items: center; gap: 10px; padding: 7px 14px; }
  .sm-up-t { font-size: 14px; font-weight: 700; color: #e4e7f0; min-width: 62px; font-variant-numeric: tabular-nums; }
  .sm-up-ph { font-size: 13px; color: #8a93a8; flex: 1; }
  .sm-up-v { font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; color: #cfd6e6; }
  .sm-up-v.warm { color: #ff8a5a; } .sm-up-v.cool { color: #6f8cff; } .sm-up-v.mid { color: #b98cff; }
  .sm-up-empty { font-size: 13px; color: #8a93a8; padding: 6px 14px 8px; }
  .sm-dchart {
    background: rgba(255,255,255,0.05);
    -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: 14px; padding: 10px 8px 4px;
  }
  .sm-dchart .sm-svg { width: 100%; height: auto; display: block; }

  /* ===== smart autopilot: detail overlay — liquid glass ===== */
  .smart-ov { background: radial-gradient(120% 90% at 50% 8%, #1c1230 0%, #100a1c 55%, #05070d 100%); }
  .smart-ov .ov-inner { padding: 20px 18px 22px; display: flex; flex-direction: column; height: 100%; box-sizing: border-box; }
  .sm-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .sm-close {
    background: linear-gradient(180deg, rgba(255,255,255,0.14), rgba(255,255,255,0.04));
    -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
    border: 1px solid rgba(255,255,255,0.16);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.22);
    color: #cdd2da; width: 34px; height: 34px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; transform: rotate(90deg);
  }
  .sm-head .ov-title { font-size: 19px; font-weight: 700; color: #fff; }
  .sm-badge {
    margin-left: auto; font-size: 11.5px; font-weight: 700; letter-spacing: .3px; text-transform: uppercase; color: #8a8d94;
    background: rgba(255,255,255,0.06); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
    border: 1px solid rgba(255,255,255,0.12); padding: 4px 10px; border-radius: 999px;
  }
  .sm-badge.on { color: #d9c7ff; background: rgba(122,52,230,.18); border-color: rgba(122,52,230,.5); }
  .sm-hero { text-align: center; margin: 12px 0 6px; }
  .sm-sug { font-size: 68px; font-weight: 300; line-height: 1; letter-spacing: -2px; color: #cfd6e6; }
  .sm-sug.warm { color: #ff8a5a; } .sm-sug.cool { color: #6f8cff; } .sm-sug.mid { color: #b98cff; }
  .sm-sublbl { color: #8a93a8; font-size: 14px; font-weight: 500; margin-top: 4px; }
  .sm-chart { margin: 10px 0 8px; }
  .sm-svg { width: 100%; height: auto; display: block; }
  .sm-svg .sm-grid { stroke: #22252c; stroke-width: 1; }
  .sm-svg .sm-xlbl { fill: #6d7178; font-size: 9px; text-anchor: middle; font-weight: 600; }
  .sm-svg .sm-now { stroke: #ffffff; stroke-width: 1; stroke-dasharray: 3 3; opacity: .5; }
  .sm-svg .sm-nowlbl { fill: #cfd6e6; font-size: 9px; text-anchor: middle; font-weight: 700; }
  .sm-factors {
    display: flex; flex-direction: column; gap: 1px; margin-top: 4px;
    background: rgba(255,255,255,0.05);
    -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: 14px; padding: 4px 0;
  }
  .sm-frow { display: flex; align-items: center; gap: 10px; padding: 9px 15px; }
  .sm-fl { font-size: 14px; font-weight: 600; color: #d7dae0; min-width: 92px; }
  .sm-fd { font-size: 13px; color: #8a93a8; flex: 1; display: flex; align-items: center; gap: 8px; }
  .sm-spark { flex: 0 0 auto; overflow: visible; }
  .sm-spark path { stroke: #8a93a8; }
  .sm-spark.warm path { stroke: #ff8a5a; }
  .sm-spark.cool path { stroke: #6f8cff; }
  .sm-fv { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; color: #8a93a8; }
  .sm-fv.warm { color: #ff7a5a; } .sm-fv.cool { color: #6f8cff; } .sm-fv.neutral { color: #8a93a8; }
  .sm-actions { display: flex; gap: 10px; margin-top: auto; padding-top: 16px; }
  .sm-actions .chip { flex: 1; padding: 13px; font-size: 14px; border-radius: 12px; }
  .sm-actions .chip.on { background: rgba(122,52,230,.18); border-color: rgba(122,52,230,.5); color: #d9c7ff; }
  .sm-actions .chip.primary { background: #eef1f6; color: #0a0f1e; border-color: #eef1f6; font-weight: 700; }
  /* clean bias adjuster */
  .sm-bias {
    display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; padding: 12px 15px;
    background: rgba(255,255,255,0.05);
    -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: 14px;
  }
  .sm-bias-t { font-size: 14px; font-weight: 600; color: #dfe3ee; }
  .sm-bias-h { font-size: 11.5px; color: #7f879c; margin-top: 2px; }
  .sm-bias-ctl { display: flex; align-items: center; gap: 12px; }
  .sm-bias .circ.sm-b { width: 36px; height: 36px; border-color: #3a3d43; }
  .sm-bias-v { font-size: 18px; font-weight: 700; min-width: 44px; text-align: center; font-variant-numeric: tabular-nums; color: #cfd6e6; }
  .sm-bias-v.warm { color: #ff8a5a; } .sm-bias-v.cool { color: #6f8cff; }
  /* smart schedule hint on the timeline */
  .timeline.tl-smart { box-shadow: inset 0 0 0 1px rgba(122,52,230,.35); }

  /* ===== settings tab (layout rollback) ===== */
  .hd-right { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
  .hd-gear { background: none; border: none; color: #8a90a0; cursor: pointer; padding: 5px; display: inline-flex; border-radius: 999px; transition: color .2s; -webkit-tap-highlight-color: transparent; }
  .hd-gear.on, .hd-gear:hover { color: #eef1f6; }
  /* temp-tile "You / Partner" pill — the view switch, appears only once Solo/Dual (header) is
     set to Dual. Hidden by default (opacity+width collapsed, not the hidden attribute — that
     can't transition) and animates in/out with it instead of just popping. */
  .ht-sidesel { max-width: 0; opacity: 0; overflow: hidden; pointer-events: none;
    transition: max-width .28s ease, opacity .2s ease; }
  .ht-sidesel.shown { max-width: 160px; opacity: 1; pointer-events: auto; }
  .ht-sidesel .ss-opt { padding: 5px 10px; font-size: 11.5px; white-space: nowrap; }
  /* "Partner" option's live-state dot — on/off independent of which side is active, so you can
     see their status without switching to it (and switching back to "You" never reads as
     "losing" it) */
  .ss-dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; vertical-align: middle;
    margin: 0 6px 1px 0; flex: none; background: rgba(255,255,255,0.22); transition: background .2s, box-shadow .2s; }
  .ss-dot.on { background: #6f8cff; box-shadow: 0 0 6px rgba(111,140,255,0.9); }
  /* hairline divider between the pill and the bed/room stats, animating with the pill instead
     of wrapping everything in a bordered card — a boxed treatment read as over-built for three
     lines of text (nothing else this small on Home gets one, only the big Autopilot strip does) */
  .ht-r-div { max-width: 0; height: 1px; opacity: 0; overflow: hidden; align-self: flex-end;
    background: rgba(255,255,255,0.08); transition: max-width .28s ease, opacity .2s ease; }
  .ht-r-div.shown { max-width: 130px; opacity: 1; width: 100%; }
  /* header power toggle — Liquid Glass circle (blur + specular top-edge highlight + hairline
     rim), glowing green ONLY when on (the design language's one accent for "success/active"
     state, matching the prime-bar water dot's exact green-glow recipe) */
  .hd-pwr {
    width: 38px; height: 38px; border-radius: 50%; border: none; flex: none;
    display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
    color: #f3f5fa;
    background: linear-gradient(180deg, rgba(255,255,255,0.14), rgba(255,255,255,0.04));
    -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
    border: 1px solid rgba(255,255,255,0.2);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.28), 0 2px 10px rgba(0,0,0,0.28);
    transition: background .2s, border-color .2s, box-shadow .2s, color .2s;
    -webkit-tap-highlight-color: transparent;
  }
  .hd-pwr svg { width: 19px; height: 19px; }
  /* same class-vs-[hidden] gotcha as .sched-chip above (display beats the UA default) — needed
     now that _update() hides this outside the Home view */
  .hd-pwr[hidden] { display: none; }
  .hd-pwr:active { transform: scale(0.92); }
  .hd-pwr.on {
    color: #eafff2;
    background: linear-gradient(165deg, rgba(51,209,122,0.30), rgba(255,255,255,0.03));
    border-color: rgba(51,209,122,0.55);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.28), 0 0 14px rgba(51,209,122,0.55), 0 2px 10px rgba(0,0,0,0.3);
  }
  .view-settings { padding: 10px 0 2px; }
  .set-card { background: rgba(255,255,255,0.045); border: 1px solid rgba(255,255,255,0.09); border-radius: 16px; padding: 16px; }
  .set-h { font-size: 12px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; color: #8a90a0; margin-bottom: 10px; }
  .set-seg { display: flex; gap: 6px; background: rgba(255,255,255,0.05); border-radius: 12px; padding: 4px; }
  .set-opt { flex: 1; background: none; border: none; color: #aab0c0; font: inherit; font-size: 14px; padding: 9px 0; border-radius: 9px; cursor: pointer; transition: background .2s, color .2s; -webkit-tap-highlight-color: transparent; }
  .set-opt.on { background: #eef1f6; color: #0a0f1e; font-weight: 600; }
  .set-note { font-size: 12.5px; line-height: 1.5; color: #9aa0b0; margin-top: 12px; }
  .set-note.dim { color: #6b7180; margin-top: 6px; }
  /* Settings rows (v10.29): anything that opens its own screen, e.g. Developer */
  .set-card + .set-card, .view-settings .rm-uw { margin-top: 12px; }
  .set-row { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; color: inherit; font: inherit; cursor: pointer;
    -webkit-tap-highlight-color: transparent; }
  .set-row:hover { background: rgba(255,255,255,0.065); }
  .set-row-l { display: flex; flex-direction: column; gap: 3px; flex-grow: 1; }
  .set-row-l b { font-size: 15px; font-weight: 600; color: #eef1f6; }
  .set-row-l i { font-style: normal; font-size: 12.5px; color: #8a90a0; line-height: 1.4; }
  .set-row-c { color: #8a90a0; display: inline-flex; flex: none; }
  .dev-back { display: inline-flex; align-items: center; gap: 3px; margin: 2px 0 12px; padding: 7px 13px 7px 7px; border-radius: 999px;
    background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.09); color: #c5cbda; font: inherit; font-size: 13.5px; cursor: pointer; }
  .dev-back:hover { background: rgba(255,255,255,0.1); }
  .set-done { margin-top: 14px; width: 100%; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); color: #eef1f6; font: inherit; font-size: 14px; padding: 11px 0; border-radius: 12px; cursor: pointer; }

  /* Settings > Pod Light */
  .led-card { margin-bottom: 12px; }
  .led-hd { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
  .led-pw { display: inline-flex; align-items: center; gap: 7px; height: 28px; padding: 0 5px 0 12px; border-radius: 999px;
    background: #eef1f6; color: #0a0f1e; border: none; font: inherit; font-size: 11.5px; font-weight: 700; cursor: pointer; }
  .led-pw i { width: 18px; height: 18px; border-radius: 50%; background: #0a0f1e; }
  .led-pw.off { background: rgba(255,255,255,0.08); color: #8a90a0; }
  .led-pw.off i { background: #6b7180; }
  .led-stage { position: relative; width: 190px; margin: 8px auto 12px; }
  .led-stage img { display: block; width: 100%; height: auto; }
  .led-glow { position: absolute; left: 34.4%; top: 97.5%; width: 19%; height: 5px; transform: translate(-50%,-50%);
    border-radius: 999px; background: var(--lc); opacity: var(--lb, 1);
    box-shadow: 0 0 8px var(--lc), 0 0 20px color-mix(in srgb, var(--lc) 65%, transparent), 0 0 44px color-mix(in srgb, var(--lc) 38%, transparent); }
  .led-card.led-off .led-glow { opacity: 0; }
  .led-card.fx-breathe .led-glow { animation: led-br 3.8s ease-in-out infinite; }
  .led-card.fx-pulse .led-glow { animation: led-br 1.15s ease-in-out infinite; }
  .led-card.fx-rainbow .led-glow { animation: led-hue 7s linear infinite; }
  .led-card.fx-candle .led-glow { animation: led-ca 2.4s ease-in-out infinite; }
  .led-card.fx-strobe .led-glow { animation: led-st .9s steps(1) infinite; }
  .led-card.fx-auto .led-glow { opacity: .28; }
  @keyframes led-br { 0%,100%{opacity:.4} 50%{opacity:1} }
  @keyframes led-hue { to { filter: hue-rotate(360deg); } }
  @keyframes led-ca { 0%,100%{opacity:.9} 22%{opacity:.66} 55%{opacity:1} 78%{opacity:.72} }
  @keyframes led-st { 0%,50%{opacity:1} 51%,100%{opacity:0} }
  .led-row { display: flex; align-items: baseline; justify-content: space-between; margin: 12px 0 8px; }
  .led-lbl { font-size: 11px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; color: #8a90a0; }
  .led-val { font-size: 12.5px; font-weight: 700; color: #eef1f6; }
  .led-sl { position: relative; height: 28px; border-radius: 999px; background: rgba(255,255,255,0.10);
    border: 1px solid rgba(255,255,255,0.14); overflow: hidden; touch-action: none; cursor: pointer; }
  .led-sl b { position: absolute; inset: 0 auto 0 0; border-radius: 999px; background: linear-gradient(90deg, rgba(255,255,255,0.32), rgba(255,255,255,0.72)); }
  .led-sl i { position: absolute; top: 50%; width: 20px; height: 20px; border-radius: 50%; transform: translate(-50%,-50%);
    background: #f3f5fa; box-shadow: 0 2px 7px rgba(0,0,0,0.4); }
  .led-sw { display: flex; gap: 9px; flex-wrap: wrap; }
  .led-swx { width: 30px; height: 30px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.16); padding: 0; cursor: pointer; }
  .led-swx.on { border-color: #fff; box-shadow: 0 0 0 2px rgba(255,255,255,0.28); }
  .led-fx { display: flex; gap: 7px; flex-wrap: wrap; }
  .led-fxx { height: 32px; padding: 0 12px; border-radius: 999px; font: inherit; font-size: 12px; font-weight: 700;
    color: #cdd3e0; background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.16); cursor: pointer; }
  .led-fxx.on { color: #0a0f1e; background: #eef1f6; border-color: #eef1f6; }

  /* ===== v2 compact layout ===== */
  .layout-v2 .bed-wrap { max-width: 60%; margin: 2px auto 8px; }   /* dead: .layout-v2 never matches in v2 — see .v2home rule below */
  .v2home .bed-wrap { max-width: 100%; margin: 2px auto 6px; }   /* not shrunk — see the tab bar below for where the room actually came from */
  .layout-v2 .info-strip,
  .layout-v2 #onSinceChip,
  .layout-v2 .prime-bar,
  .layout-v2 .side-toggle { display: none !important; }
  .layout-v2 #manualPanel .chip.boost { display: none; }
  .layout-v2 .manual-panel { margin-top: 12px; }
  .layout-v2[data-mode="auto"] #manualPanel { display: none; }
  .layout-v2[data-mode="manual"] #smartPanel { display: none; }

  .v2-status { display: flex; flex-direction: column; gap: 2px; padding: 11px 14px; border-radius: 12px; margin: 0 0 12px;
    background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); }
  .v2-status.warm { background: rgba(230,57,36,0.13); border-color: rgba(230,57,36,0.30); }
  .v2-status.cool { background: rgba(51,82,230,0.13); border-color: rgba(51,82,230,0.32); }
  .v2-status.mid  { background: rgba(122,52,230,0.14); border-color: rgba(122,52,230,0.32); }
  .v2s-main { font-size: 14px; font-weight: 600; color: #eef1f6; }
  .v2s-sub { font-size: 11.5px; color: #9aa0b0; }

  .v2-boost { display: flex; gap: 8px; margin: 0 0 10px; }
  .v2-boost .chip.boost { flex: 1; justify-content: center; }

  .v2-mode { display: flex; gap: 6px; background: rgba(255,255,255,0.05); border-radius: 12px; padding: 4px; margin: 0 0 12px; }
  .v2m-opt { flex: 1; background: none; border: none; color: #aab0c0; font: inherit; font-size: 13px; padding: 8px 0; border-radius: 9px; cursor: pointer; transition: background .2s, color .2s; -webkit-tap-highlight-color: transparent; }
  .v2m-opt.on { background: #eef1f6; color: #0a0f1e; font-weight: 600; }

  .v2-next { display: flex; align-items: center; gap: 8px; padding: 10px 4px 0; margin-top: 12px; border-top: 1px solid rgba(255,255,255,0.08); font-size: 12.5px; }
  .v2n-l { color: #8a90a0; }
  .v2n-b { color: #cfd6e6; flex: 1; }
  .v2n-t { color: #eef1f6; font-variant-numeric: tabular-nums; }

  .v2-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
  .v2chip { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; padding: 5px 10px; border-radius: 999px;
    background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.09); color: #aab0c0; }
  .v2chip[data-v2chip] { cursor: pointer; }
  .v2chip.warn { background: rgba(240,160,40,0.14); border-color: rgba(240,160,40,0.34); color: #f0c070; }
  .v2chip.act { background: rgba(93,202,165,0.14); border-color: rgba(93,202,165,0.34); color: #7fe0c0; }

  /* ===================================================================================
     v2 — the redesign. Everything below is scoped to markup only _podHTMLv2()/_routineHTMLv2()/
     _smartHTMLv2() emit (".v2home", ".home-status", ".home-temp", ".step-rail", ".tabbar",
     ".smv2-*", ".sched-chip") — classic never renders these classes, so none of this touches it.
     =================================================================================== */
  .v2home {
    /* ha-card's own padding (18px sides, 18/20 top/bottom) eats into this, so subtract it —
       otherwise the shell would sit ~38px taller than the viewport and reopen the same bug
       by a smaller margin. */
    /* --v2-outer-chrome: how much vertical space the HOST PAGE reserves around the card
       (kiosk/public/index.html's own body padding + safe-area insets) — custom properties
       cross the shadow-DOM boundary, so the host sets it once and every card instance honours
       it, without this file knowing anything about its host. Falls back to 0px (a plain HA
       dashboard, which adds no such outer chrome around ha-card). */
    height: calc(100dvh - 38px - var(--v2-outer-chrome, 0px) - var(--v2-bottom-chrome, 0px));
    max-height: calc(100dvh - 38px - var(--v2-outer-chrome, 0px) - var(--v2-bottom-chrome, 0px));
    display: flex; flex-direction: column; overflow: hidden;
  }
  .v2home > .hd { flex: none; }             /* the title bar: permanent, never scrolls */
  .v2content { flex: 1 1 auto; min-height: 0; position: relative; }
  /* every view fills the content box and scrolls independently — switching tabs is an
     [hidden] toggle (_setView), so each keeps its own scroll position for free */
  .v2content > [id^="view"] {
    position: absolute; inset: 0; overflow-y: auto; -webkit-overflow-scrolling: touch;
    /* clears the floating tab bar (58px) + its offset from the bottom + a hair of breathing
       room, so the last bit of scrollable content doesn't end up sitting underneath the bar */
    box-sizing: border-box;
    padding-bottom: calc(58px + env(safe-area-inset-bottom) + 24px);
  }

  /* Liquid Glass tab bar: navigation floats in its own layer above the content. The material
     does the work — blur + saturation over whatever scrolls under it, a specular highlight
     along the top edge and a fainter one where light bends round the bottom, a hairline rim.
     Colour appears in exactly one place: the selected item. */
  .tabbar {
    /* Fixed to the VIEWPORT, not flowed inside .v2home. A flex-flow bar (the previous approach)
       had to reserve its own row — height plus the safe-area margin above it — inside the
       already-shrunk content box, in-flow, permanently, whether or not anything was scrolled
       under it. A real iOS tab bar floats: it costs the content only a little bottom padding
       (added on .v2content's children below) instead of a whole reserved row, and
       position:fixed always resolves against the true viewport regardless of ha-card's own
       height or padding, so this needs no coordination with the --v2-outer-chrome math above. */
    position: fixed; left: 16px; right: 16px; z-index: 40;
    bottom: calc(max(16px, env(safe-area-inset-bottom) + 8px) + var(--v2-bottom-chrome, 0px));
    height: 58px;
    display: flex; align-items: center; padding: 0 5px; border-radius: 999px;
    background: rgba(255,255,255,0.085);
    -webkit-backdrop-filter: blur(36px) saturate(185%) brightness(1.06);
            backdrop-filter: blur(36px) saturate(185%) brightness(1.06);
    box-shadow: inset 0 0.5px 0 rgba(255,255,255,0.45), inset 0 -0.5px 0 rgba(255,255,255,0.16),
      inset 0 0 0 0.5px rgba(255,255,255,0.11), 0 10px 28px rgba(0,0,0,0.42), 0 2px 6px rgba(0,0,0,0.30);
  }
  .tabbar .tab {
    position: relative; flex: 1 1 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
    height: 58px; background: none; border: none; padding: 0; cursor: pointer; font: inherit;
    font-size: 10px; font-weight: 600; color: rgba(235,235,245,0.60);
    -webkit-tap-highlight-color: transparent; transition: color .22s;
  }
  .tabbar .tab.on { color: var(--es-nav-accent, #6f8cff); }
  .tabbar .tab svg, .tabbar .tab span { position: relative; z-index: 1; }
  .tabbar .tab svg { stroke-width: 1.9; transition: stroke-width .22s; }
  .tabbar .tab.on svg { stroke-width: 2.4; }
  /* ONE shared lens, not one per tab — it physically SLIDES between tabs (translateX, set by
     JS from each tab's real offsetLeft/offsetWidth, since tabs are flex:1 1 0 and their width
     depends on the device) rather than cross-fading two separate elements in place. Sized to
     the first tab (Home, the default view) by default so it's correctly placed even before
     JS runs on first paint — no load-time jump. Same spring curve as .hnav-lens and every
     sheet transition in this file (§5.2): cubic-bezier(.22,1,.36,1), never a linear slide. */
  .tabbar .lens {
    /* left stays 0 deliberately — JS supplies the FULL horizontal offset via translateX
       (active.offsetLeft + pad), so a nonzero left here would double-count against it.
       width is a static, close-enough guess for the instant before JS's first _update() runs
       (same tick as mount — imperceptible either way); JS overwrites it immediately after. */
    position: absolute; top: 5px; bottom: 5px; left: 0; width: calc(25% - 8px);
    border-radius: 999px; z-index: 0;
    background: rgba(255,255,255,0.14);
    -webkit-backdrop-filter: blur(3px) brightness(1.16) saturate(140%); backdrop-filter: blur(3px) brightness(1.16) saturate(140%);
    box-shadow: inset 0 0.5px 0 rgba(255,255,255,0.50), inset 0 0 0 0.5px rgba(255,255,255,0.16), 0 1px 3px rgba(0,0,0,0.24);
    transition: transform .42s cubic-bezier(.22,1,.36,1), width .42s cubic-bezier(.22,1,.36,1);
  }
  @media (prefers-reduced-motion: reduce) { .tabbar .lens { transition: none; } }
  /* The lens takes a faint wash of the active tab's status tone (see _renderTabStatus). Painted
     by a child layer rather than on .lens itself so it can cross-fade — background-image on the
     lens can't transition, and the lens's own translateX must stay the only thing moving. */
  .tabbar .lens::after { content: ""; position: absolute; inset: 0; border-radius: inherit;
    background: var(--t-tint, transparent); transition: background .45s ease; pointer-events: none; }

  /* Status indicators (v10.30) — the liquid-lens-navbar-card idea, sourced from the card's own
     state. Both slots are absolutely positioned off the tab's CENTRE (left: 50% + an offset),
     not off its right edge: tabs are flex: 1 1 0, so their width changes with the device and
     with how many are configured, but the icon is always 23px centred — so the icon's shoulder
     is a fixed distance from the middle and the dot lands in the same place on every phone. */
  .tabbar .tab .t-dot {
    position: absolute; top: 8px; left: 50%; margin-left: 7px; z-index: 2;
    width: 6px; height: 6px; border-radius: 50%; background: #6d7178;
    opacity: 0; transform: scale(.5); pointer-events: none;
    transition: opacity .3s ease, transform .3s cubic-bezier(.22,1,.36,1), background .3s, box-shadow .3s;
  }
  .tabbar .tab .t-dot.show { opacity: 1; transform: scale(1); }
  /* "acc" defers to the bed's live Glow colour, so Home's dot changes with the bed, not with a
     rule written here; the rest reuse the Coach tab's semantic set (--cch-ok/amb/bad). */
  .tabbar .tab .t-dot.acc  { background: var(--gl-acc, #8d928c); box-shadow: 0 0 7px rgba(var(--gl-rgb, 141,146,140),0.85); }
  .tabbar .tab .t-dot.ok   { background: #33d17a; box-shadow: 0 0 7px rgba(51,209,122,0.75); }
  .tabbar .tab .t-dot.amb  { background: #ffb020; box-shadow: 0 0 7px rgba(255,176,32,0.75); }
  .tabbar .tab .t-dot.bad  { background: #ff5a52; box-shadow: 0 0 7px rgba(255,90,82,0.75); }
  .tabbar .tab .t-dot.info { background: #5fa8ff; box-shadow: 0 0 7px rgba(95,168,255,0.75); }
  .tabbar .tab .t-dot.dim  { background: #6d7178; box-shadow: none; }
  /* Glow's one motion motif: the slow ambient breath, reserved for "this is live right now".
     Same 1.8s opacity breathing as the gauge glow and the vitals dot, never a colour flash. */
  .tabbar .tab .t-dot.beat { animation: tabDotBeat 1.8s ease-in-out infinite; }
  @keyframes tabDotBeat { 0%, 100% { opacity: 1; } 50% { opacity: .28; } }
  @media (prefers-reduced-motion: reduce) {
    .tabbar .tab .t-dot { transition: none; }
    .tabbar .tab .t-dot.beat { animation: none; }
  }
  /* Count badge — iOS red bubble, same corner as the dot (a tab shows one or the other, never
     both). tabular-nums so a 1 and a 2 are the same width and the bubble never resizes. */
  .tabbar .tab .t-badge {
    position: absolute; top: 4px; left: 50%; margin-left: 4px; z-index: 3;
    min-width: 15px; height: 15px; padding: 0 4px; box-sizing: border-box; border-radius: 8px;
    background: #ff5a52; color: #fff; font-size: 9.5px; line-height: 15px; font-weight: 700;
    font-style: normal; text-align: center; font-variant-numeric: tabular-nums;
    box-shadow: 0 0 8px rgba(255,90,82,0.5); pointer-events: none;
  }
  .tabbar .tab .t-badge[hidden] { display: none; }

  /* status line: one plain-language sentence, dot and copy always together */
  .home-status { display: flex; align-items: center; gap: 9px; margin: 2px 2px 8px; }
  .home-status .hs-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; background: #6d7178; transition: background .35s, box-shadow .35s; }
  .home-status .hs-dot.warm { background: #ff7a5a; box-shadow: 0 0 10px rgba(255,122,90,.9); }
  .home-status .hs-dot.cool { background: #6f8cff; box-shadow: 0 0 10px rgba(111,140,255,.9); }
  .home-status .hs-dot.mid  { background: #b98cff; box-shadow: 0 0 10px rgba(185,140,255,.9); }
  .home-status .hs-text { font-size: 14.5px; font-weight: 600; color: #c5cbda; }
  .home-status .hs-water { margin-left: auto; font-size: 12px; font-weight: 600; color: #7f879c; white-space: nowrap; }
  .home-status .hs-water.low { color: #ff8a5a; }

  /* the number, with the temperature axis directly under it */
  .home-temp { display: block; width: 100%; text-align: left; background: none; border: none; padding: 0; margin: 0 0 6px; color: inherit; font: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .home-temp .ht-top { display: flex; align-items: flex-end; gap: 10px; }
  .home-temp .ht-l { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .home-temp .ht-lbl { font-size: 11.5px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; color: #8a93a8; }
  .home-temp .big-level { font-size: 54px; font-weight: 300; letter-spacing: -2px; line-height: .94; display: block; }
  .home-temp .ht-r { margin-left: auto; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; padding-bottom: 7px; }
  /* keeps "Bed now"/"Room" tight to each other (one glanceable stat block) while the outer
     .ht-r gap gives real separation from the pill/divider above it */
  .ht-stats { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
  .home-temp .ht-r .bl-sub { font-size: 13.5px; font-weight: 600; color: #9aa2b6; }
  .home-temp .ht-room { font-size: 12.5px; font-weight: 600; color: #7f879c; white-space: nowrap; }
  .home-temp .hd-gear { flex: 0 0 auto; margin: 0 0 6px 10px; }
  .home-temp .ht-ctl { display: flex; align-items: center; gap: 12px; margin-top: 8px; }
  .home-temp .ht-track { position: relative; flex: 1 1 auto; height: 10px; border-radius: 999px; cursor: pointer;
    background: linear-gradient(90deg, #6f8cff, #b98cff 52%, #ff8a5a); transition: opacity .3s, filter .3s; }
  .home-temp .ht-track.off { opacity: .35; filter: saturate(.3); }
  .home-temp .ht-thumb { position: absolute; top: 50%; width: 24px; height: 24px; border-radius: 50%; transform: translate(-50%, -50%);
    background: radial-gradient(circle at 33% 28%, #fff, #eef1f6 55%, #d3d9e6);
    box-shadow: 0 0 0 6px rgba(255,255,255,0.06), 0 2px 8px rgba(0,0,0,0.45); transition: left .25s ease; }
  .home-temp .ht-scale { display: flex; justify-content: space-between; margin: 4px 58px 0; font-size: 10.5px; font-weight: 700; letter-spacing: .3px; text-transform: uppercase; color: #6d7178; }

  /* quick actions: one row, tap for the default and hold to customise */
  .presets.quick { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 6px; }
  /* Home fits one screen with no internal scroll (measured: content needed 783px against a
     730px box on a 402x844 phone, 53px short). Every trim below is v2 Home-specific — none of
     these classes render in classic or any other v2 tab — and each shaves a little rather than
     one thing shaving a lot: the quick-action row (the one asked to shrink) drops height and
     type size, every row's margin tightens by a few px, and the hero photo — the only
     non-requested change — steps down 66%->60% to close what the margin trims alone didn't
     reach. Re-measure (see kiosk/public/app.js's CONFIG or the dev harness) before trimming
     further if new Home content is ever added. */
  .presets.quick .chip { flex: 1 1 auto; justify-content: center; height: 32px; font-size: 11.5px; }

  /* Autopilot collapsed to a strip; its reasoning is one tap deeper */
  .smart-panel.strip .smp-head { padding-bottom: 6px; }
  .smart-panel.strip .smp-line { display: flex; align-items: center; gap: 8px; width: 100%; background: none; border: none;
    padding: 0 16px 8px; margin-top: 0; color: #9aa2b6; font: inherit; font-size: 12.5px; font-weight: 500; text-align: left; cursor: pointer;
    -webkit-tap-highlight-color: transparent; }
  .smart-panel.strip .smp-line .sl-txt { flex: 1 1 auto; }
  .smart-panel.strip .smp-line b { color: #d7dae0; font-weight: 700; }
  .smart-panel.strip .smp-line .sl-why { color: #d7c9f5; font-weight: 700; }
  .smart-panel.strip .smp-line .sl-chev { display: inline-flex; color: #6d7178; }

  /* tonight's steps on Home */
  .timeline.home-tl { margin-top: 6px; }

  /* Schedule tab (v2): "who's driving" chip lives in the shared header */
  .sched-chip { display: flex; align-items: center; gap: 7px; height: 34px; padding: 0 13px; border-radius: 999px;
    background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); white-space: nowrap; }
  /* an author display rule beats the UA stylesheet's [hidden]{display:none} — without this,
     the chip rendered as an empty pill on every OTHER view (Home included) whenever it was
     hidden but not yet populated with text, which is exactly the "weird box" bug */
  .sched-chip[hidden] { display: none; }
  .sched-chip .sc-txt { font-size: 12px; font-weight: 700; color: #9aa2b6; }
  .sched-chip .sc-ico { display: none; width: 13px; height: 13px; flex: 0 0 auto; }
  .sched-chip.on { background: rgba(122,52,230,0.18); border-color: rgba(122,52,230,0.34); }
  .sched-chip.on .sc-txt { color: #d7c9f5; }
  .sched-chip.on .sc-ico { display: inline-flex; }

  /* the reusable "answers what happens tonight" building blocks: a card of rows, a section label */
  .v2label { font-size: 11.5px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; color: #8a93a8; }
  .v2label.section { margin: 22px 2px 10px; }
  .v2rowhd { display: flex; align-items: center; justify-content: space-between; padding: 0 2px 10px; }
  .v2rowhd-sub { font-size: 11.5px; font-weight: 600; color: #7f879c; }
  .v2card { background: linear-gradient(165deg, rgba(255,255,255,0.09), rgba(255,255,255,0.02));
    -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px);
    border: 1px solid rgba(255,255,255,0.10); box-shadow: inset 0 1px 0 rgba(255,255,255,0.10);
    border-radius: 20px; padding: 14px; display: flex; flex-direction: column; gap: 8px; overflow: hidden; }
  /* bedtime/alarm as large tap targets */
  .v2slot { display: flex; align-items: center; gap: 13px; padding: 15px; border-radius: 18px;
    background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.07);
    color: inherit; font: inherit; text-align: left; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .v2ic { display: inline-flex; flex: 0 0 auto; }
  .v2ic svg { width: 21px; height: 21px; }
  .v2ic.bed { color: #8fb0ff; } .v2ic.alarm { color: #ffb44d; } .v2ic.snow { color: #6f8cff; }
  .v2ic.sun { color: #ffb44d; } .v2ic.flame { color: #ff8a5a; } .v2ic.power { color: #8a93a8; }
  .v2col { display: flex; flex-direction: column; gap: 2px; flex-grow: 1; min-width: 0; }
  .v2t { font-size: 21px; font-weight: 700; letter-spacing: -0.4px; }
  .v2t .ap { font-size: 13px; font-weight: 700; margin-left: 2px; color: #cfd3dc; }
  .v2l { font-size: 12px; font-weight: 600; color: #8a93a8; }
  .v2chev { display: inline-flex; flex: 0 0 auto; color: #6d7178; }
  .v2chev svg { width: 17px; height: 17px; }
  .v2precool { display: flex; align-items: center; gap: 9px; padding: 4px 4px 0; }
  .v2precool #precoolTxt { font-size: 12.5px; font-weight: 600; color: #9aa2b6; flex-grow: 1; }
  /* the three things around the alarm, and the two weekly routines — one row each in one card */
  .v2trow { display: flex; align-items: center; gap: 11px; padding: 13px 2px; border-bottom: 1px solid rgba(255,255,255,0.06);
    background: none; border-left: none; border-right: none; border-top: none; color: inherit; font: inherit; text-align: left;
    width: 100%; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .v2card > .v2trow:last-child { border-bottom: none; }
  .v2trow .v2tt { flex-grow: 1; font-size: 14px; font-weight: 600; min-width: 0; }
  .v2trow .v2ts { display: block; font-size: 12px; font-weight: 500; color: #8a93a8; margin-top: 1px; }
  .v2rt-name { flex-grow: 1; font-size: 14px; font-weight: 700; }
  .v2rt-sub { display: block; font-size: 12px; font-weight: 500; color: #8a93a8; margin-top: 1px; }
  .v2rt-times { font-size: 13px; font-weight: 600; color: #c5cbda; font-variant-numeric: tabular-nums; white-space: nowrap; }

  /* segmented toggle (Sleep Coach: weeknights / weekends; Sleep: night / week / month) */
  .v2seg { display: flex; gap: 4px; height: 32px; padding: 4px; border-radius: 999px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); }
  .v2seg-opt { height: 24px; padding: 0 11px; border-radius: 999px; background: none; border: none; color: #9aa2b6; font: inherit; font-size: 11.5px; font-weight: 700; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .v2seg-opt.on { background: #eef1f6; color: #0a0f1e; }
  /* 3 supporting stats */
  .v2stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 9px; }
  .v2stat { background: linear-gradient(165deg, rgba(255,255,255,0.09), rgba(255,255,255,0.02));
    -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px); border: 1px solid rgba(255,255,255,0.10);
    border-radius: 16px; padding: 10px 12px 11px; display: flex; flex-direction: column; gap: 2px; }
  .v2stat-v { font-size: 20px; font-weight: 800; letter-spacing: -0.4px; }
  .v2stat-l { font-size: 10.5px; font-weight: 700; letter-spacing: .3px; text-transform: uppercase; color: #8a93a8; }
  /* last-7-nights bar strip */
  .v2bars { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 8px; align-items: end; height: 64px; }
  .v2bar-col { display: flex; flex-direction: column; align-items: center; gap: 7px; height: 100%; justify-content: flex-end; }
  .v2bar { width: 100%; border-radius: 7px; background: linear-gradient(180deg, #6f8cff, rgba(111,140,255,0.35)); }
  .v2bar-col.on .v2bar { background: linear-gradient(180deg, #8fb0ff, rgba(143,176,255,0.4)); }
  .v2bar.v2bar-mid { background: linear-gradient(180deg, #ffb020, rgba(255,176,32,0.3)); }
  .v2bar.v2bar-low { background: linear-gradient(180deg, #ff8a5a, rgba(255,138,90,0.3)); }
  .v2bar.v2bar-empty { background: rgba(255,255,255,0.06); }
  .v2bar-lbl { font-size: 10.5px; font-weight: 700; color: #6d7178; }
  .v2bar-col.on .v2bar-lbl { color: #f3f5fa; }
  /* ---- v2 "Sleep" tab ---- */
  .view-sleep { padding: 4px 2px 90px; }
  /* =====================================================================================
     Sleep — the "Report" (v10.25). Glow language: same .gl-tile panels, wide-tracked labels,
     thin numerals, Home's arc + rounded handle. design/sleep-directions.
     ===================================================================================== */
  .v2home.glow.slp-mode > .gl-bg { --gl-rgb: 183,155,255; }
  .slp { padding-bottom: 4px; }
  .slp-whorow { display: flex; justify-content: flex-end; padding: 2px 0 0; }
  .slp-seg { display: inline-flex; gap: 2px; padding: 4px; border-radius: 14px; background: rgba(255,255,255,0.05); }
  .slp-opt { height: 30px; min-width: 0; padding: 0 11px; border: 0; border-radius: 10px; background: none; cursor: pointer;
    font: inherit; font-size: 12.5px; font-weight: 600; color: #8d928c; -webkit-tap-highlight-color: transparent; }
  .slp-opt.on { background: rgba(255,255,255,0.11); color: #f2f4f1; }
  .slp-date, .slp-hhd { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
  .slp-arrow { width: 36px; height: 36px; flex: none; border-radius: 50%; display: grid; place-items: center; cursor: pointer;
    background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.09); color: #e6e9e4; -webkit-tap-highlight-color: transparent; }
  .slp-arrow svg { width: 18px; height: 18px; }
  .slp-arrow[disabled] { opacity: 0.32; pointer-events: none; }
  .slp-dt { min-width: 0; }
  .slp-dt b { display: block; font-size: 16px; font-weight: 500; white-space: nowrap; }
  .slp-dt em { display: block; font-style: normal; font-size: 12px; color: #8d928c; margin-top: 2px; white-space: nowrap; }
  .slp-date .slp-seg { margin-left: auto; }
  /* v10.26: Night / Week / Month gets its own full-width row; the date line keeps the arrows apart */
  .slp-date { flex-wrap: wrap; row-gap: 12px; }
  .slp-date .slp-seg { order: -1; flex: 1 0 100%; margin-left: 0; }
  .slp-date .slp-seg .slp-opt { flex: 1 1 0; }
  .slp-date .slp-dt { flex: 1 1 auto; }
  .slp-ap { font-size: 0.7em; color: #8d928c; letter-spacing: 0; margin-left: 3px; }
  .slp-note { font-size: 12px; color: #8d928c; white-space: nowrap; }
  .slp-note.wrap { white-space: normal; line-height: 1.45; margin: 10px 0 0; display: block; }
  .slp-chip { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 999px;
    font-size: 12.5px; font-weight: 600; white-space: nowrap; background: rgba(255,255,255,0.06); color: #b7bcb5; border: 1px solid rgba(255,255,255,0.07); }
  .slp-chip svg { width: 14px; height: 14px; flex: none; }
  .slp-chip.warn { color: #ffd27a; background: rgba(255,176,32,0.12); border-color: transparent; }
  /* scores */
  .slp-two { display: grid; grid-template-columns: minmax(0,1.25fr) minmax(0,1fr); gap: 8px; margin-top: 2px; }
  .slp-scorebtn, .slp-rec { display: flex; flex-direction: column; align-items: center; min-width: 0;
    background: none; border: 0; padding: 0; color: inherit; font: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .slp-scorebtn[disabled] { cursor: default; }
  .slp-scorebtn:active .slp-arcwrap { transform: scale(0.98); }
  .slp-arcwrap { position: relative; display: block; width: 100%; transition: transform .12s; }
  .slp-arc { width: 100%; height: auto; display: block; overflow: visible; }
  .slp-arc-track { fill: none; stroke: rgba(255,255,255,0.08); stroke-width: 12; stroke-linecap: round; }
  .slp-arc-track.thin { stroke-width: 10; }
  .slp-arc-fill { fill: none; stroke: url(#slpArcG); stroke-width: 12; stroke-linecap: round; }
  .slp-arc-glow { fill: none; stroke: var(--gl-acc, #b79bff); stroke-width: 16; stroke-linecap: round; opacity: 0.5; filter: blur(5px);
    animation: glPulse 3.2s ease-in-out infinite; }
  .slp-arc-knob { fill: #f5f7fa; }
  .slp-arc-knob.hrv { filter: drop-shadow(0 0 6px #b99bff); }
  .slp-band { fill: none; stroke: #b99bff; stroke-width: 10; stroke-linecap: round; opacity: 0.75; }
  .slp-band-glow { fill: none; stroke: #b99bff; stroke-width: 14; stroke-linecap: round; opacity: 0.4; filter: blur(5px); }
  .slp-scorebtn.low .slp-arcwrap { opacity: 0.55; }
  .slp-arcnum { position: absolute; left: 0; right: 0; top: 42%; display: flex; flex-direction: column; align-items: center; pointer-events: none; }
  .slp-arcnum.rec { top: 48%; }
  .slp-arcnum b { font-size: clamp(38px, 13vw, 54px); font-weight: 200; letter-spacing: -2px; line-height: 1; font-variant-numeric: tabular-nums; }
  .slp-arcnum.rec b { font-size: clamp(26px, 9vw, 34px); letter-spacing: -1px; }
  .slp-arcnum span { font-size: 11px; color: #8d928c; margin-top: 3px; }
  .slp-cap { font-size: 14px; margin-top: 2px; }
  .slp-capw { font-size: 12px; color: var(--gl-hi, #d8c9ff); margin-top: 1px; text-align: center; line-height: 1.3; }
  .slp-capw.hrv { color: #b99bff; } .slp-capw.warn { color: #ffb020; } .slp-capw.dim { color: #8d928c; }
  .slp-sent { font-size: 17px; font-weight: 300; line-height: 1.35; letter-spacing: -0.2px; color: #f2f4f1; margin: 12px 0 0; text-wrap: pretty; }
  .slp-link { display: inline-flex; align-items: center; gap: 4px; margin-top: 10px; padding: 0; border: 0; background: none; cursor: pointer;
    font: inherit; font-size: 13px; font-weight: 600; color: var(--gl-hi, #d8c9ff); -webkit-tap-highlight-color: transparent; }
  .slp-link.right { margin: 0 0 0 auto; }
  .slp-link svg { width: 14px; height: 14px; }
  /* banner + stages */
  .slp-banner { display: flex; gap: 12px; align-items: flex-start; background: linear-gradient(180deg, rgba(255,176,32,0.09), rgba(255,176,32,0.03)); border-color: rgba(255,176,32,0.22); }
  .slp-banner p { margin: 6px 0 0; font-size: 14.5px; line-height: 1.42; color: #e6e9e4; }
  .slp-bic { width: 34px; height: 34px; flex: none; border-radius: 11px; display: grid; place-items: center; background: rgba(255,176,32,0.14); color: #ffb020; }
  .slp-bic.on { background: rgba(var(--gl-rgb),0.15); color: var(--gl-hi); }
  .slp-bic svg, .slp-iic svg { width: 18px; height: 18px; }
  .slp-bicbig { width: 52px; height: 52px; border-radius: 16px; display: grid; place-items: center; background: rgba(var(--gl-rgb),0.15); color: var(--gl-hi); }
  .slp-bicbig svg { width: 24px; height: 24px; }
  .slp-stats { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 12px; margin-top: 12px; }
  .slp-stat > span { font-size: 15px; color: #e6e9e4; }
  .slp-stat > div { display: flex; align-items: center; gap: 10px; margin-top: 6px; }
  .slp-stat b { font-size: 24px; font-weight: 300; letter-spacing: -0.5px; font-variant-numeric: tabular-nums; }
  .slp-sep { width: 1px; height: 20px; background: rgba(255,255,255,0.22); }
  .slp-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
  .slp-dot.good { background: #33d17a; } .slp-dot.warn { background: #ffb020; }
  .slp-hyp { width: 100%; height: auto; display: block; margin-top: 16px; overflow: visible; }
  .slp-hyp .slp-grid, .slp-night .slp-grid { stroke: rgba(255,255,255,0.05); }
  .slp-conn { stroke: rgba(227,236,255,0.42); stroke-width: 1; }
  .slp-tick { stroke: rgba(255,255,255,0.22); }
  .st-wake { fill: #e3ecff; } .st-rem { fill: #8fbcff; } .st-light { fill: #34528f; }
  .st-deep { fill: #2f74e8; filter: drop-shadow(0 0 6px rgba(47,116,232,0.7)); }
  .slp-hypax { position: relative; height: 34px; margin-top: 4px; font-size: 12px; color: #8d928c; }
  .slp-hypax b { display: block; font-size: 12.5px; color: #f2f4f1; }
  .slp-hypax .l { position: absolute; left: 0; top: 0; } .slp-hypax .r { position: absolute; right: 0; top: 0; text-align: right; }
  .slp-hypax .m { position: absolute; top: 0; transform: translateX(-50%); }
  .slp-legend { display: flex; justify-content: center; gap: 16px; margin-top: 8px; font-size: 12.5px; color: #b7bcb5; }
  .slp-legend span { display: inline-flex; align-items: center; gap: 6px; }
  .slp-legend i { width: 11px; height: 11px; border-radius: 3px; display: block; }
  .slp-legend i.st-wake { background: #e3ecff; } .slp-legend i.st-rem { background: #8fbcff; }
  .slp-legend i.st-light { background: #34528f; } .slp-legend i.st-deep { background: #2f74e8; }
  .slp-kvrow { display: flex; align-items: flex-start; gap: 10px; }
  .slp-kvrow.top { margin-top: 16px; padding-top: 14px; border-top: 1px solid rgba(255,255,255,0.06); }
  .slp-kvrow > span:first-child { font-size: 16px; margin-top: 2px; }
  .slp-kvrow > div { margin-left: auto; text-align: right; }
  .slp-kvrow b { font-size: 23px; font-weight: 300; letter-spacing: -0.5px; font-variant-numeric: tabular-nums; }
  .slp-kvv { display: inline-flex; align-items: center; gap: 8px; }
  .slp-kvrow em { display: block; font-style: normal; font-size: 12px; color: #8d928c; margin-top: 3px; }
  .slp-nostage { position: relative; height: 84px; margin-top: 10px; display: grid; place-items: center; text-align: center; }
  .slp-nostage i { position: absolute; left: 0; right: 0; border-top: 1px dashed rgba(255,255,255,0.1); }
  .slp-nostage i:nth-of-type(1) { top: 12%; } .slp-nostage i:nth-of-type(2) { top: 37%; }
  .slp-nostage i:nth-of-type(3) { top: 62%; } .slp-nostage i:nth-of-type(4) { top: 87%; }
  .slp-nostage span { position: relative; font-size: 13.5px; color: #b7bcb5; background: #101113; padding: 4px 10px; border-radius: 8px; }
  /* the night chart */
  .slp-readout { display: flex; align-items: flex-end; gap: 14px; margin-top: 10px; min-height: 44px; }
  .slp-rt { font-size: 32px; font-weight: 200; letter-spacing: -1.2px; line-height: 1; font-variant-numeric: tabular-nums; }
  .slp-rt .slp-ap { font-size: 14px; }
  .slp-rl { display: flex; flex-direction: column; gap: 3px; padding-bottom: 2px; min-width: 0; }
  .slp-rl span { font-size: 13px; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .slp-rl i { width: 7px; height: 7px; border-radius: 50%; display: block; }
  .slp-rl .hr { color: #ffa3b3; } .slp-rl .hr i { background: #ff7f95; }
  .slp-rl .bt { color: var(--gl-hi, #d8c9ff); } .slp-rl .bt i { background: #ff8a5a; }
  .slp-chartwrap { margin-top: 10px; touch-action: none; cursor: grab; }
  .slp-night { width: 100%; height: auto; display: block; overflow: visible; }
  .slp-xlab { font-size: 10.5px; fill: #8d928c; text-anchor: middle; }
  .slp-wake { fill: rgba(255,255,255,0.07); }
  .slp-hr { fill: none; stroke: #ff7f95; stroke-width: 1.5; stroke-linejoin: round; opacity: 0.95; }
  .slp-temp { fill: none; stroke: #ff8a5a; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
  .slp-temp-glow { fill: none; stroke: #ff8a5a; stroke-width: 7; opacity: 0.35; filter: blur(3px); }
  .slp-pres { fill: var(--gl-hi, #d8c9ff); opacity: 0.6; }
  .slp-cur line { stroke: #f2f4f1; stroke-width: 1; opacity: 0.55; }
  .slp-cur .c-hr { fill: #ff7f95; stroke: #0a0b0c; stroke-width: 2; }
  .slp-cur .c-t { fill: #f5f7fa; }
  /* v10.26 air band + readout */
  .slp-airbg { fill: rgba(255,255,255,0.03); }
  .slp-pm { fill: rgba(94,214,190,0.28); stroke: #5ed6be; stroke-width: 1.2; stroke-linejoin: round; }
  .slp-rh { fill: none; stroke: #7fd0ff; stroke-width: 1.6; stroke-dasharray: 3 3; stroke-linejoin: round; }
  .slp-cur .c-rh { fill: #7fd0ff; stroke: #0a0b0c; stroke-width: 1.5; }
  .slp-rl .air { color: #9fe6d6; } .slp-rl .air i { background: #5ed6be; }
  .slp-airnote { margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.06); }
  .slp-airnote p { margin: 4px 0 0; font-size: 13px; line-height: 1.35; color: #b7bcb5; }
  .slp-airnote.warn p { color: #ffd29a; }
  .slp-airkey { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: #8d928c; }
  .slp-airkey i { width: 10px; height: 4px; border-radius: 2px; display: block; }
  .slp-airkey i.pm { background: #5ed6be; } .slp-airkey i.rh { background: #7fd0ff; margin-left: 8px; }
  /* v10.26 consistency */
  .slp-streak { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; font-weight: 600; color: #ffb48f; }
  .slp-streak svg { width: 14px; height: 14px; }
  .slp-streak.off { color: #8d928c; font-weight: 500; }
  .slp-cbody { display: flex; align-items: center; gap: 16px; margin-top: 12px; }
  .slp-cringwrap { position: relative; width: 76px; height: 76px; flex: none; }
  .slp-cring { width: 76px; height: 76px; display: block; }
  .slp-cring .trk { fill: none; stroke: rgba(255,255,255,0.08); stroke-width: 8; }
  .slp-cring .val { fill: none; stroke: var(--gl-hi, #d8c9ff); stroke-width: 8; stroke-linecap: round;
    filter: drop-shadow(0 0 6px rgba(183,155,255,0.55)); }
  .slp-cringwrap > b { position: absolute; inset: 0; display: grid; place-items: center; font-size: 22px; font-weight: 300; letter-spacing: -0.5px; }
  .slp-cringwrap > b small { font-size: 11px; }
  .slp-ctext { min-width: 0; }
  .slp-ctext b { display: block; font-size: 17px; font-weight: 500; }
  .slp-ctext em { display: block; font-style: normal; font-size: 12.5px; color: #8d928c; margin-top: 3px; line-height: 1.35; }
  .slp-cdays { display: grid; grid-template-columns: repeat(7, 1fr); margin: 14px 0 6px; }
  .slp-cday { display: flex; flex-direction: column; align-items: center; gap: 5px; font-size: 11px; color: #8d928c; }
  .slp-cday i { width: 14px; height: 14px; border-radius: 50%; display: block; border: 1.5px dashed rgba(255,255,255,0.18); }
  .slp-cday.hit i { border: 0; background: var(--gl-hi, #d8c9ff); box-shadow: 0 0 8px rgba(183,155,255,0.6); }
  .slp-cday.miss i { border: 1.5px solid rgba(216,201,255,0.55); }
  /* v10.26 month */
  .slp-mkvs { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 16px; margin-top: 12px; }
  .slp-mkv em { display: block; font-style: normal; font-size: 12px; color: #8d928c; }
  .slp-mkv b { display: block; margin-top: 2px; font-size: 21px; font-weight: 300; letter-spacing: -0.4px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .slp-mkv b small { font-size: 12px; font-weight: 500; color: var(--gl-hi, #d8c9ff); letter-spacing: 0; }
  .slp-mgrid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 5px; margin-top: 8px; }
  .slp-mhead { margin-top: 12px; }
  .slp-mhead span { text-align: center; font-size: 11px; color: #8d928c; }
  .slp-mcell { position: relative; aspect-ratio: 1; border-radius: 10px; border: 0; padding: 0; font: inherit; color: #f2f4f1;
    background: rgba(255,255,255,0.035); display: grid; place-items: center; }
  .slp-mcell.pad { background: none; }
  .slp-mcell em { position: absolute; top: 3px; left: 5px; font-style: normal; font-size: 9px; color: rgba(255,255,255,0.45); }
  .slp-mcell b { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 6px; }
  .slp-mcell.none { background: rgba(255,255,255,0.02); }
  .slp-mcell.g1 { background: rgba(183,155,255,0.10); }
  .slp-mcell.g2 { background: rgba(183,155,255,0.22); }
  .slp-mcell.g3 { background: rgba(183,155,255,0.38); }
  .slp-mcell.g4 { background: rgba(183,155,255,0.58); box-shadow: 0 0 10px rgba(183,155,255,0.35); }
  .slp-mcell.on { outline: 1.5px solid rgba(255,255,255,0.7); outline-offset: -1.5px; }
  button.slp-mcell { cursor: pointer; }
  .slp-mlegend { display: flex; justify-content: center; gap: 14px; margin-top: 10px; font-size: 11.5px; color: #8d928c; }
  .slp-mlegend span { display: inline-flex; align-items: center; gap: 5px; }
  .slp-mlegend i { width: 10px; height: 10px; border-radius: 3px; display: block; }
  .slp-mlegend i.g1 { background: rgba(183,155,255,0.10); } .slp-mlegend i.g2 { background: rgba(183,155,255,0.22); }
  .slp-mlegend i.g3 { background: rgba(183,155,255,0.38); } .slp-mlegend i.g4 { background: rgba(183,155,255,0.58); }
  .slp-bwrow { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .slp-bw { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; text-align: left; font: inherit; color: inherit; cursor: default; }
  button.slp-bw { cursor: pointer; }
  .slp-bw .slp-prevring { margin: 8px 0 4px; }
  .slp-bwd { font-size: 14px; font-weight: 600; }
  .slp-bw em { font-style: normal; font-size: 12px; color: #8d928c; white-space: nowrap; }
  .slp-msec { margin: 18px 4px 2px; font-size: 11px; font-weight: 600; letter-spacing: 1.6px; text-transform: uppercase; color: #8d928c; }
  .slp-sweet { margin: 10px 0 0; font-size: 14px; line-height: 1.4; color: #d6d9d4; }
  .slp-sweet b { color: #fff; font-weight: 600; }
  .slp-sbars { display: flex; align-items: flex-end; gap: 8px; height: 132px; margin: 14px 0 6px; }
  .slp-sbar { flex: 1 1 0; min-width: 0; height: 100%; display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .slp-sbar .v { font-size: 12px; font-weight: 600; color: #b7bcb5; font-variant-numeric: tabular-nums; }
  .slp-sbt { flex: 1 1 auto; width: 100%; max-width: 34px; display: flex; align-items: flex-end; }
  .slp-sbt i { display: block; width: 100%; border-radius: 8px 8px 4px 4px; background: rgba(183,155,255,0.25); }
  .slp-sbar.on .slp-sbt i { background: linear-gradient(180deg, var(--gl-hi, #d8c9ff), #8a6be0); box-shadow: 0 0 14px rgba(183,155,255,0.5); }
  .slp-sbar.on .v { color: #fff; }
  .slp-sbar .k { font-size: 12.5px; color: #e6e9e4; font-variant-numeric: tabular-nums; }
  .slp-sbar .n { font-size: 10.5px; color: #8d928c; }
  /* vitals + moments */
  .slp-vrow { display: grid; grid-template-columns: 34px minmax(0,1fr) auto 96px; align-items: center; gap: 12px; padding: 11px 0;
    border-top: 1px solid rgba(255,255,255,0.06); }
  .slp-vitals .gl-row + .slp-vrow { border-top: 0; }
  .slp-vic { width: 34px; height: 34px; border-radius: 11px; display: grid; place-items: center; background: color-mix(in srgb, var(--c) 14%, transparent); color: var(--c); }
  .slp-vic svg { width: 17px; height: 17px; }
  .slp-vname b { display: block; font-size: 14.5px; font-weight: 400; }
  .slp-vname em { display: block; font-style: normal; font-size: 12px; color: #8d928c; margin-top: 2px; white-space: nowrap; }
  .slp-vval { font-size: 22px; font-weight: 300; letter-spacing: -0.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .slp-vval.big { margin-left: auto; }
  .slp-vval small { font-size: 12px; color: #8d928c; margin-left: 3px; }
  .slp-mbars { width: 96px; height: 30px; display: block; overflow: visible; }
  .slp-mbar { stroke-width: 5; stroke-linecap: round; opacity: 0.38; }
  .slp-mbar.on { opacity: 1; }
  .slp-mgap { fill: rgba(255,255,255,0.2); }
  .slp-mlist { position: relative; margin-top: 6px; }
  .slp-rail { position: absolute; left: 87px; top: 22px; bottom: 22px; width: 1px; background: rgba(255,255,255,0.12); }
  .slp-mrow { display: grid; grid-template-columns: 60px 30px minmax(0,1fr) auto; align-items: center; column-gap: 12px; height: 44px; }
  .slp-mt { font-size: 15px; font-weight: 300; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .slp-mic { position: relative; z-index: 1; width: 30px; height: 30px; border-radius: 10px; display: grid; place-items: center;
    background: linear-gradient(color-mix(in srgb, var(--c) 15%, transparent), color-mix(in srgb, var(--c) 15%, transparent)), #141619; color: var(--c); }
  .slp-mic svg { width: 16px; height: 16px; }
  .slp-mlbl { font-size: 14.5px; white-space: nowrap; }
  .slp-mdet { font-size: 12.5px; color: #8d928c; white-space: nowrap; }
  /* week */
  .slp-week { display: grid; grid-template-columns: repeat(7, minmax(0,1fr)); gap: 4px; margin-top: 10px; }
  .slp-wcol { display: flex; flex-direction: column; gap: 6px; min-width: 0; background: none; border: 0; padding: 0; cursor: pointer;
    font: inherit; color: inherit; -webkit-tap-highlight-color: transparent; }
  .slp-wv { text-align: center; font-size: 13px; height: 16px; color: #b7bcb5; }
  .slp-wv.gap { font-size: 10.5px; color: #5b605b; }
  .slp-wcol.on .slp-wv { color: #f2f4f1; }
  .slp-wbar { height: 96px; display: flex; flex-direction: column; justify-content: flex-end; padding: 0 5px; }
  .slp-wbar i { display: block; border-radius: 8px; background: linear-gradient(180deg, var(--gl-hi, #d8c9ff), var(--gl-acc, #8a6be0)); opacity: 0.5; }
  .slp-wbar i.gap { height: 26%; background: none; border: 1px dashed rgba(255,255,255,0.18); }
  .slp-wcol.on .slp-wbar i { opacity: 1; box-shadow: 0 0 18px rgba(var(--gl-rgb),0.55); }
  .slp-wd { text-align: center; font-size: 12px; color: #8d928c; }
  .slp-wcol.on .slp-wd { color: #f2f4f1; }
  .slp-caps { margin-top: 8px; }
  .slp-caprow { display: flex; align-items: center; gap: 10px; height: 24px; }
  .slp-caprow > span { width: 30px; font-size: 12px; color: #8d928c; }
  .slp-captrack { position: relative; flex: 1; height: 12px; border-radius: 999px; background: rgba(255,255,255,0.04); }
  .slp-captrack b { position: absolute; top: 0; bottom: 0; border-radius: 999px; background: linear-gradient(90deg, var(--gl-acc, #8a6be0), var(--gl-hi, #d8c9ff)); }
  .slp-captrack em { position: absolute; left: 12px; top: -3px; font-style: normal; font-size: 11px; color: #5b605b; }
  .slp-capax { display: flex; justify-content: space-between; padding-left: 40px; margin-top: 4px; font-size: 10.5px; color: #8d928c; }
  .slp-insight { display: flex; gap: 12px; align-items: flex-start; }
  .slp-insight p { margin: 6px 0 0; font-size: 14.5px; line-height: 1.42; color: #e6e9e4; }
  .slp-iic { width: 40px; height: 40px; flex: none; border-radius: 12px; display: grid; place-items: center; background: rgba(var(--gl-rgb),0.15); color: var(--gl-hi); }
  /* health check */
  .slp-lead { font-size: 15px; line-height: 1.45; color: #b7bcb5; margin: 10px 0 0; }
  .slp-lead.big { font-size: 22px; font-weight: 300; line-height: 1.3; color: #f2f4f1; margin-top: 14px; }
  .slp-sub { font-size: 14.5px; line-height: 1.42; color: #b7bcb5; margin: 8px 0 0; }
  .slp-foot { font-size: 12px; line-height: 1.45; color: #8d928c; margin: 14px 0 0; }
  .slp-hname { font-size: 15px; }
  .slp-hfoot { margin-top: 10px; }
  .slp-band-chart { width: 100%; height: auto; display: block; margin-top: 12px; overflow: visible; }
  .slp-bandbox { fill: rgba(255,255,255,0.055); }
  .slp-bandline { fill: none; stroke: rgba(255,255,255,0.26); stroke-width: 1.2; stroke-linejoin: round; }
  .slp-banddot { fill: rgba(255,255,255,0.5); }
  .slp-banddot.out { fill: #ff8a5a; }
  .slp-banddot.last { stroke: #0a0b0c; stroke-width: 2; }
  .slp-bandring { fill: none; stroke: #ff8a5a; opacity: 0.45; }
  .slp-bandempty { font-size: 13px; color: #8d928c; margin-top: 12px; }
  /* states */
  .slp-big { padding: 18px 16px 16px; }
  .slp-steps { position: relative; display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); margin-top: 18px; }
  .slp-step { display: flex; flex-direction: column; align-items: center; position: relative; z-index: 1; min-width: 0; }
  .slp-step i { width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; background: #0d0e10;
    border: 1.5px solid rgba(255,255,255,0.18); color: #0b0c0e; }
  .slp-step i svg { width: 14px; height: 14px; }
  .slp-step.done i { background: var(--gl-acc); border-color: var(--gl-acc); }
  .slp-step.now i { border: 2px solid var(--gl-acc); box-shadow: 0 0 14px rgba(var(--gl-rgb),0.7); }
  .slp-step b { font-size: 13px; font-weight: 400; color: #8d928c; margin-top: 8px; white-space: nowrap; }
  .slp-step.done b, .slp-step.now b { color: #f2f4f1; }
  .slp-step em { font-style: normal; font-size: 11.5px; color: #8d928c; margin-top: 2px; white-space: nowrap; }
  .slp-prev { display: flex; align-items: center; gap: 14px; width: 100%; text-align: left; cursor: pointer;
    font: inherit; color: inherit; -webkit-tap-highlight-color: transparent; }
  .slp-prev svg.slp-mini { width: 56px; height: 56px; }
  .slp-prevring { position: relative; width: 56px; height: 56px; flex: none; display: grid; place-items: center; }
  .slp-prevring.sm, .slp-prevring.sm svg.slp-mini { width: 52px; height: 52px; }
  .slp-prevring b { position: absolute; font-size: 18px; font-weight: 300; }
  .slp-mini-bg { fill: none; stroke: rgba(255,255,255,0.08); stroke-width: 5; }
  .slp-mini-fg { fill: none; stroke: var(--gl-acc, #b79bff); stroke-width: 5; stroke-linecap: round; }
  .slp-prevtxt { flex: 1; min-width: 0; }
  .slp-prevtxt b { display: block; font-size: 15px; font-weight: 400; margin-top: 5px; }
  /* score breakdown popup */
  .slp-prows { margin-top: 10px; }
  .slp-prow { padding: 11px 0; border-top: 1px solid rgba(255,255,255,0.06); }
  .slp-prow:first-child { border-top: 0; }
  .slp-phd { display: flex; align-items: baseline; gap: 10px; }
  .slp-phd b { font-size: 15px; font-weight: 500; }
  .slp-phd em { font-style: normal; font-size: 12px; color: #8d928c; }
  .slp-phd span { margin-left: auto; font-size: 21px; font-weight: 300; font-variant-numeric: tabular-nums; }
  .slp-phd small { font-size: 12px; color: #8d928c; }
  .slp-ptrack { display: block; height: 6px; border-radius: 999px; background: rgba(255,255,255,0.08); margin-top: 9px; overflow: hidden; }
  .slp-ptrack b { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--gl-acc, #8a6be0), var(--gl-hi, #d8c9ff)); }
  /* raw data */
  .slp-raw { margin-top: 12px; border-radius: 16px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); padding: 10px 14px; }
  .slp-raw summary { font-size: 12.5px; font-weight: 600; color: #b7bcb5; cursor: pointer; }
  .slp-raw pre { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 10.5px; line-height: 1.45; color: #9aa0a8;
    white-space: pre-wrap; word-break: break-word; margin: 10px 0 0; max-height: 320px; overflow: auto; }
  .slp-rawfoot { font-size: 10.5px; color: #6d7178; margin-top: 8px; }
  .slp-rawfoot code { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  .slp-bars .v2bar-lbl { margin-top: 5px; }
  .slp-dev { margin-top: 12px; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; overflow: hidden; }
  .slp-dev > summary { padding: 12px 14px; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .5px;
    color: #8a93a8; cursor: pointer; list-style: none; -webkit-tap-highlight-color: transparent; }
  .slp-dev > summary::-webkit-details-marker { display: none; }
  .slp-dev > summary::before { content: "▸ "; }
  .slp-dev[open] > summary::before { content: "▾ "; }
  .slp-dev-hint { font-weight: 500; text-transform: none; letter-spacing: 0; color: #6d7178; }
  .slp-dev-body { padding: 4px 14px 14px; }
  .slp-dev-lbl { margin: 14px 0 5px; font-size: 10.5px; font-weight: 800; text-transform: uppercase; letter-spacing: .4px; color: #6d7178; }
  .slp-dev-lbl:first-child { margin-top: 4px; }
  .slp-dev-lbl code { font-size: 10px; color: #8a93a8; }
  .slp-dev-tbl { width: 100%; border-collapse: collapse; font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .slp-dev-tbl td { padding: 2px 6px 2px 0; vertical-align: top; border-bottom: 1px solid rgba(255,255,255,0.04); }
  .slp-dev-tbl td:first-child { color: #8a93a8; white-space: nowrap; width: 44%; }
  .slp-dev-tbl td:last-child { color: #d6d9e0; word-break: break-word; }
  .slp-dev-json { margin: 6px 0 0; padding: 10px; max-height: 320px; overflow: auto; border-radius: 8px;
    background: rgba(0,0,0,0.35); font: 10.5px/1.45 ui-monospace, Menlo, monospace; color: #b9c0cc; white-space: pre; }
  .slp-dev-foot { margin-top: 10px; font-size: 10.5px; color: #6d7178; line-height: 1.6; }
  .slp-dev-foot code { display: block; margin-top: 3px; padding: 6px 8px; border-radius: 6px; background: rgba(0,0,0,0.35);
    color: #9aa2b0; font-size: 10px; word-break: break-all; }
  .v2chev.up svg, .v2chev.up { transform: rotate(180deg); }
  .v2chev { transition: transform .2s ease; }

  /* =====================================================================================
     Sleep Coach (v10.29) — design/coach. Glow tiles and labels, but the coach's OWN
     semantic colours (green / amber / red from DESIGN-LANGUAGE.md §2): "did I hit my
     target" is not a bed-temperature signal, so it never follows GLOW_PAL. The tab's
     ambient glow is lilac like Sleep's, so the two read as one pair.
     ===================================================================================== */
  .view-coach { padding: 4px 2px 90px; }
  .v2home.glow.cch-mode > .gl-bg { --gl-rgb: 183,155,255; }
  .cch { padding-bottom: 4px; display: flex; flex-direction: column; gap: 10px; }
  .cch { --cch-ok: #33d17a; --cch-amb: #ffb020; --cch-bad: #ff5a52; --cch-off: #8d928c; }
  .cch .ok { color: var(--cch-ok); } .cch .amb { color: var(--cch-amb); }
  .cch .bad { color: var(--cch-bad); } .cch .off { color: var(--cch-off); }
  .cch svg { flex: none; }
  .cch .gl-lbl svg, .cch-pop .gl-lbl svg { width: 15px; height: 15px; flex: none; }
  /* v10.35: icon + label sat flush (the label is plain inline text with 2.6px tracking) */
  .cch .gl-lbl, .cch-pop .gl-lbl { display: inline-flex; align-items: center; gap: 8px; }
  .cch-note svg { width: 15px; height: 15px; vertical-align: -3px; }
  .cch-top { display: flex; align-items: center; gap: 8px; padding: 2px 0 0; }
  .cch-top .slp-seg { flex: none; }
  .cch-top .slp-arrow { margin-left: auto; }
  .cch-top .slp-arrow svg { width: 17px; height: 17px; }
  .slp-seg.wide { display: flex; width: 100%; }
  .slp-seg.wide .slp-opt { flex: 1 1 0; }
  .cch-pill { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 11px; border-radius: 999px;
    font-size: 12.5px; font-weight: 500; white-space: nowrap; background: rgba(255,255,255,0.07); color: #d9ddd6; }
  .cch-pill svg { width: 14px; height: 14px; }
  .cch-pill.ok { background: rgba(51,209,122,0.14); color: var(--cch-ok); }
  .cch-pill.amb { background: rgba(255,176,32,0.14); color: var(--cch-amb); }
  .cch-pill.bad { background: rgba(255,90,82,0.15); color: var(--cch-bad); }
  .cch-hero.ok { border-color: rgba(51,209,122,0.3); box-shadow: inset 0 1px 0 rgba(255,255,255,0.06), 0 12px 30px rgba(0,0,0,0.35), 0 0 26px rgba(51,209,122,0.12); }
  .cch-hero.amb { border-color: rgba(255,176,32,0.3); box-shadow: inset 0 1px 0 rgba(255,255,255,0.06), 0 12px 30px rgba(0,0,0,0.35), 0 0 26px rgba(255,176,32,0.12); }
  .cch-hero.bad { border-color: rgba(255,90,82,0.32); box-shadow: inset 0 1px 0 rgba(255,255,255,0.06), 0 12px 30px rgba(0,0,0,0.35), 0 0 26px rgba(255,90,82,0.14); }
  .cch-hero.warm { border-color: rgba(255,138,90,0.32); }
  .cch-hrow { display: flex; align-items: center; gap: 16px; margin-top: 12px; }
  .cch-ring { position: relative; flex: none; display: grid; place-items: center; }
  .cch-ringsvg { display: block; }
  .cch-ringsvg.ok { color: var(--cch-ok); } .cch-ringsvg.amb { color: var(--cch-amb); }
  .cch-ringsvg.bad { color: var(--cch-bad); } .cch-ringsvg.off { color: var(--cch-off); }
  .cch-ring b { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -62%); font-size: 22px; font-weight: 300; }
  .cch-ring b small { font-size: 13px; color: #8d928c; }
  .cch-ring em { position: absolute; left: 50%; bottom: 17px; transform: translateX(-50%); font-style: normal;
    font-size: 9.5px; letter-spacing: 1.4px; text-transform: uppercase; color: #8d928c; white-space: nowrap; }
  .cch-hmain { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .cch-big { font-size: 34px; font-weight: 300; letter-spacing: -1.1px; line-height: 1.05; }
  .cch-big.xl { font-size: 54px; letter-spacing: -2px; margin-top: 6px; }
  .cch-ap { font-size: 0.52em; color: #8d928c; margin-left: 2px; }
  .cch-sub { font-size: 12.5px; color: #8d928c; }
  .cch-sub.sm { font-size: 11px; }
  .cch-note { font-size: 12.5px; line-height: 1.45; color: #9aa09a; margin-top: 10px; }
  .cch-note.big { font-size: 14px; color: #c4c8c2; }
  .cch-note b { color: #d9ddd6; font-weight: 500; }
  .cch-lrow { display: flex; align-items: center; gap: 8px; justify-content: space-between; }
  .cch-num { font-size: 30px; font-weight: 300; letter-spacing: -1px; line-height: 1; }
  .cch-num small { font-size: 0.52em; color: #8d928c; letter-spacing: 0; margin-left: 1px; }
  .cch-drowv { display: flex; align-items: flex-end; gap: 10px; margin-top: 10px; }
  .cch-drowv .cch-sub { padding-bottom: 4px; }
  .cch-bar { height: 10px; border-radius: 999px; background: rgba(255,255,255,0.07); margin-top: 12px; overflow: hidden; }
  .cch-bar b { display: block; height: 100%; border-radius: 999px; background: var(--cch-ok); }
  .cch-bar b.amb { background: var(--cch-amb); } .cch-bar b.bad { background: var(--cch-bad); }
  .cch-chip { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: 999px; font-size: 12px; white-space: nowrap; }
  .cch-chip svg { width: 13px; height: 13px; }
  .cch-chip.ok { background: rgba(51,209,122,0.14); color: var(--cch-ok); }
  .cch-chip.amb { background: rgba(255,176,32,0.14); color: var(--cch-amb); }
  /* now -> wind-down -> in bed -> up */
  .cch-tl { position: relative; height: 54px; margin: 18px 6px 2px; }
  .cch-tlline, .cch-tlfill { position: absolute; left: 0; top: 4px; height: 1px; }
  .cch-tlline { right: 0; background: rgba(255,255,255,0.12); }
  .cch-tk b, .cch-tk em { max-width: 84px; overflow: hidden; text-overflow: ellipsis; }
  .cch-tlfill { background: linear-gradient(90deg, #b79bff, var(--cch-ok)); }
  .cch-tk { position: absolute; top: 0; transform: translateX(-50%); text-align: center; }
  .cch-tk i { display: block; width: 7px; height: 7px; margin: 0 auto 7px; border-radius: 50%; background: rgba(255,255,255,0.5); }
  .cch-tk.nowtk i { width: 9px; height: 9px; background: #f2f4f1; box-shadow: 0 0 10px rgba(242,244,241,0.5); }
  .cch-tk b { display: block; font-size: 12px; font-weight: 400; white-space: nowrap; }
  .cch-tk em { display: block; font-style: normal; font-size: 10px; color: #8d928c; white-space: nowrap; }
  .cch-dots { display: flex; align-items: center; justify-content: space-between; gap: 10px;
    margin-top: 12px; padding-top: 11px; border-top: 1px solid rgba(255,255,255,0.075); }
  .cch-dl { font-size: 12.5px; color: #8d928c; }
  .cch-drow { display: flex; gap: 7px; }
  .cch-dot { width: 11px; height: 11px; border-radius: 50%; background: var(--cch-off); }
  .cch-dot.ok { background: var(--cch-ok); box-shadow: 0 0 10px rgba(51,209,122,0.4); }
  .cch-dot.amb { background: var(--cch-amb); box-shadow: 0 0 10px rgba(255,176,32,0.4); }
  .cch-dot.bad { background: var(--cch-bad); box-shadow: 0 0 10px rgba(255,90,82,0.4); }
  /* rows: the plan, the nudges, the wake sequence — one shape for all three */
  .cch-prows { margin-top: 4px; }
  .cch-prow { display: flex; align-items: center; gap: 12px; padding: 10px 0; width: 100%;
    background: none; border: none; color: inherit; font: inherit; text-align: left; }
  .cch-prow.tap { cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .cch-prow.tap:hover { background: rgba(255,255,255,0.03); }
  .gl-tile.cch-prow { padding: 12px 16px; }
  .gl-tile.cch-prow.lit { border-color: rgba(255,176,32,0.3); }
  .cch-hair { display: block; height: 1px; margin-left: 44px; background: rgba(255,255,255,0.075); }
  .cch-ic { width: 32px; height: 32px; flex: none; border-radius: 11px; display: grid; place-items: center;
    background: rgba(255,255,255,0.07); }
  .cch-ic svg { width: 17px; height: 17px; }
  .cch-ic.ok { background: rgba(51,209,122,0.13); } .cch-ic.amb { background: rgba(255,176,32,0.13); }
  .cch-ic.bad { background: rgba(255,90,82,0.13); } .cch-ic.mid { background: rgba(183,155,255,0.14); color: #b79bff; }
  .cch-ic.warm { background: rgba(255,138,90,0.14); color: #ff8a5a; }
  .cch-ic.cool { background: rgba(95,168,255,0.14); color: #5fa8ff; }
  .cch-pt { display: flex; flex-direction: column; gap: 2px; flex-grow: 1; min-width: 0; }
  .cch-pt b { font-size: 14.5px; font-weight: 500; }
  .cch-pt em { font-style: normal; font-size: 12px; color: #8d928c; line-height: 1.4; }
  .cch-pt em.amb { color: var(--cch-amb); }
  .cch-ptime { font-size: 12.5px; color: #8d928c; white-space: nowrap; flex: none; }
  .cch-chev { color: #8d928c; display: inline-flex; flex: none; }
  .cch-tg { width: 44px; height: 26px; border-radius: 999px; position: relative; flex: none; background: rgba(255,255,255,0.12); }
  .cch-tg i { position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: #e6e9e4; transition: left .18s ease; }
  .cch-tg.on { background: var(--cch-ok); box-shadow: 0 0 16px rgba(51,209,122,0.35); }
  .cch-tg.on i { left: 21px; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.35); }
  .cch-banner { display: flex; align-items: center; gap: 12px; }
  .cch-bic { width: 40px; height: 40px; flex: none; border-radius: 13px; display: grid; place-items: center; background: rgba(255,90,82,0.14); }
  .cch-bic svg { width: 20px; height: 20px; }
  .cch-bt { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .cch-bt b { font-size: 15px; font-weight: 500; }
  .cch-bt em { font-style: normal; font-size: 12.5px; color: #8d928c; }
  .cch-tbtn { display: inline-flex; align-items: center; gap: 2px; background: none; border: none; color: inherit;
    font: inherit; font-size: 20px; font-weight: 300; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .cch-tbtn svg { width: 17px; height: 17px; color: #8d928c; }
  .cch-imup { height: 54px; margin-top: 14px; width: 100%; }
  /* Nights: one lane per night against the target lines */
  .cch-kvs { display: flex; gap: 10px; }
  .gl-tile.cch-kv { flex: 1 1 0; padding: 13px 14px; }
  .cch-kvv { font-size: 21px; font-weight: 300; letter-spacing: -0.5px; margin-top: 5px; }
  .cch-lanes { position: relative; margin-top: 12px; }
  .cch-lane { display: flex; align-items: center; gap: 8px; height: 19px; }
  .cch-ll { width: 48px; flex: none; text-align: right; font-size: 10.5px; color: #8d928c; white-space: nowrap; }
  .cch-lt { position: relative; flex: 1 1 0; height: 19px; }
  .cch-lb { position: absolute; top: 5px; height: 9px; border-radius: 999px; background: var(--cch-off); }
  .cch-lb.ok { background: linear-gradient(90deg, rgba(51,209,122,0.85), rgba(51,209,122,0.4)); }
  .cch-lb.amb { background: linear-gradient(90deg, rgba(255,176,32,0.85), rgba(255,176,32,0.4)); }
  .cch-lb.bad { background: linear-gradient(90deg, rgba(255,90,82,0.85), rgba(255,90,82,0.4)); }
  .cch-gap { position: absolute; left: 0; right: 0; top: 9px; height: 1px; background: rgba(255,255,255,0.1); }
  .cch-ltrack { position: absolute; left: 56px; right: 0; top: 0; bottom: 20px; pointer-events: none; }
  .cch-vline { position: absolute; top: 0; bottom: 0; width: 1px; opacity: 0.75; }
  .cch-vline.ok { background: var(--cch-ok); } .cch-vline.warm { background: #ff8a5a; }
  .cch-axis { position: relative; height: 16px; margin: 4px 0 0 56px; }
  .cch-axis span { position: absolute; transform: translateX(-50%); font-size: 10px; color: #8d928c; }
  .cch-legend { display: flex; gap: 14px; margin-top: 10px; }
  .cch-legend span { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #8d928c; }
  .cch-legend i { width: 10px; height: 2px; flex: none; }
  .cch-legend i.ok { background: var(--cch-ok); } .cch-legend i.warm { background: #ff8a5a; }
  .cch-read p { margin: 10px 0 0; font-size: 15px; line-height: 1.45; color: #e6e9e4; }
  .cch-read p b { font-weight: 500; color: #f2f4f1; }
  .cch-read p b.amb { color: var(--cch-amb); }
  /* the targets sheet (centred Glow card — never a bottom sheet) */
  .cch-pop .pkg-badge { color: var(--cch-ok, #33d17a); }
  .cch-srows { margin-top: 6px; }
  .cch-srow { display: flex; align-items: center; gap: 10px; padding: 12px 0; }
  .cch-sctl { display: flex; align-items: center; gap: 10px; flex: none; }
  .cch-sbtn { width: 36px; height: 36px; flex: none; border-radius: 50%; display: grid; place-items: center; cursor: pointer;
    background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.09); color: #e6e9e4; }
  .cch-sbtn svg { width: 17px; height: 17px; }
  .cch-sval { min-width: 92px; text-align: center; font-size: 19px; font-weight: 300; }
  .cch-sval small { font-size: 12.5px; color: #8d928c; }
  .cch-tapzone { position: absolute; inset: 0; cursor: pointer; }
  .cch-pop .cch-prow { position: relative; }

  .step-rail { display: flex; flex-direction: column; }
  .step-row { display: flex; align-items: center; gap: 12px; height: 54px; background: none; border: none; padding: 0; margin: 0;
    color: inherit; font: inherit; text-align: left; cursor: pointer; -webkit-tap-highlight-color: transparent; border-radius: 12px; }
  .step-row:hover { background: rgba(255,255,255,0.03); }
  .step-row .sr-time { width: 68px; flex: none; text-align: right; font-size: 12.5px; font-weight: 700; color: #9aa2b6; font-variant-numeric: tabular-nums; }
  .step-row .sr-time .sr-ap { font-size: 10px; margin-left: 1px; text-transform: uppercase; }
  .step-row.active .sr-time { color: #f3f5fa; }
  .step-row .sr-rail { position: relative; width: 14px; flex: none; align-self: stretch; display: flex; align-items: center; justify-content: center; }
  .step-row .sr-rail::before { content: ""; position: absolute; top: 0; bottom: 0; width: 2px; background: rgba(255,255,255,0.10); }
  .step-row .sr-rail.first::before { top: 50%; }
  .step-row .sr-rail.last::before { bottom: 50%; }
  .step-row .sr-rail i { position: relative; width: 10px; height: 10px; border-radius: 50%; display: block; box-shadow: 0 0 0 3px #08090c; }
  .step-row .sr-lbl { flex: 1 1 auto; min-width: 0; font-size: 14.5px; font-weight: 600; color: #d7dae0; display: flex; align-items: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .step-row.active .sr-lbl { color: #fff; }
  .step-row .sr-lbl svg { flex: 0 0 auto; }
  .step-row .sr-deg { font-size: 15.5px; font-weight: 700; font-variant-numeric: tabular-nums; margin-right: 2px; }
  .step-row .sr-deg.cool { color: #6f8cff; } .step-row .sr-deg.warm { color: #ff7a5a; } .step-row .sr-deg.neutral { color: #b98cff; }
  .step-row svg:last-child { flex: 0 0 auto; color: #6d7178; width: 16px; height: 16px; }

  /* Autopilot detail (v2): factor breakdown heading + the segmented "Run it" bias control */
  .smv2-why-hd { font-size: 13.5px; font-weight: 700; color: #8a93a8; margin: 14px 2px 6px; }
  .smv2-bias { margin-top: 12px; padding: 12px 15px; background: rgba(255,255,255,0.05);
    -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.07); border-radius: 14px; }
  .smv2-bias-row { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
  .smv2-bias-t { font-size: 14px; font-weight: 600; color: #dfe3ee; }
  .smv2-bias-h { font-size: 12px; font-weight: 500; color: #7f879c; }
  .smv2-seg { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 4px; padding: 4px; border-radius: 999px;
    background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.10); }
  .smv2-seg-opt { height: 38px; border-radius: 999px; background: none; border: none; color: #9aa2b6; font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .smv2-seg-opt.on { background: #7a34e6; color: #fff; }

  /* ── Autopilot tab (v2 only) ──────────────────────────────────────────────────────────────
     The live card is always on; every explanation collapses to a summary line and opens in
     place. Purple #7a34e6 is the Autopilot accent; warm/cool stay the temperature axis. */
  .ap-card { margin-top: 11px; padding: 14px 15px 15px; border-radius: 20px;
    background: linear-gradient(165deg, rgba(255,255,255,0.09), rgba(255,255,255,0.02));
    -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px);
    border: 1px solid rgba(255,255,255,0.10); box-shadow: inset 0 1px 0 rgba(255,255,255,0.10); }
  .ap-card.live { background: linear-gradient(165deg, rgba(122,52,230,0.16), rgba(255,255,255,0.02));
    border-color: rgba(122,52,230,0.26); }
  .ap-card.live.sup { background: linear-gradient(165deg, rgba(255,255,255,0.07), rgba(255,255,255,0.02));
    border-color: rgba(255,255,255,0.10); }
  .ap-chd { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
  .ap-lbl { font-size: 11.5px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; color: #8a93a8; }
  .ap-aux { font-size: 10.5px; font-weight: 600; color: #767e93; font-variant-numeric: tabular-nums; }
  .ap-tele { display: flex; align-items: flex-end; gap: 12px; }
  .ap-big { font-size: 62px; font-weight: 300; letter-spacing: -2.6px; line-height: .82; color: #b98cff; }
  .ap-big.warm { color: #ff8a5a; } .ap-big.cool { color: #6f8cff; } .ap-big.mid { color: #b98cff; }
  .ap-meta { padding-bottom: 5px; min-width: 0; }
  .ap-meta .l1 { font-size: 12.5px; font-weight: 700; color: #e4e8f2; }
  .ap-meta .l2 { margin-top: 3px; font-size: 11.5px; font-weight: 600; color: #8a93a8; }

  /* convergence rail: target, the bed's real temperature, and the gap still to close */
  .ap-rail { position: relative; height: 8px; border-radius: 999px; margin: 17px 3px 0;
    background: rgba(255,255,255,0.07); box-shadow: inset 0 1px 2px rgba(0,0,0,0.45); }
  .ap-gap { position: absolute; top: 0; bottom: 0; border-radius: 999px;
    background: linear-gradient(90deg, rgba(111,140,255,0.85), rgba(143,176,255,0.30)); }
  .ap-tgt { position: absolute; top: 50%; width: 15px; height: 15px; border-radius: 50%;
    transform: translate(-50%,-50%); background: #150f26;
    box-shadow: 0 0 0 3px #b98cff, 0 0 14px rgba(185,140,255,0.65); }
  .ap-now { position: absolute; top: 50%; width: 19px; height: 19px; border-radius: 50%;
    transform: translate(-50%,-50%);
    background: radial-gradient(circle at 33% 28%, #fff, #eef1f6 55%, #d3d9e6);
    box-shadow: 0 0 0 6px rgba(255,255,255,0.06), 0 2px 8px rgba(0,0,0,0.5); }
  .ap-now.ok { box-shadow: 0 0 0 6px rgba(51,209,122,0.18), 0 2px 8px rgba(0,0,0,0.5); }
  .ap-raill { display: flex; justify-content: space-between; margin-top: 11px; font-variant-numeric: tabular-nums; }
  .ap-raill .r { text-align: right; }
  .ap-raill .k { display: block; font-size: 9px; font-weight: 700; letter-spacing: .35px; text-transform: uppercase; color: #767e93; }
  .ap-raill .v { display: block; margin-top: 2px; font-size: 13.5px; font-weight: 700; color: #eef1f7; }
  .ap-raill .v.mid { color: #b98cff; } .ap-raill .v.warm { color: #ff8a5a; }
  .ap-raill .v.cool { color: #6f8cff; } .ap-raill .v.ok { color: #7ce0b0; }

  .ap-strip { display: grid; gap: 1px; margin-top: 14px; background: rgba(255,255,255,0.08);
    border-radius: 13px; overflow: hidden; }
  .ap-strip .c { background: rgba(20,16,32,0.6); padding: 8px 10px; display: flex; flex-direction: column; gap: 3px; }
  .ap-strip .k { font-size: 9px; font-weight: 700; letter-spacing: .35px; text-transform: uppercase; color: #767e93; }
  .ap-strip .v { font-size: 14.5px; font-weight: 700; color: #eef1f7; font-variant-numeric: tabular-nums; }
  .ap-strip .v.warm { color: #ff8a5a; } .ap-strip .v.cool { color: #6f8cff; }
  .ap-note { display: flex; align-items: center; gap: 8px; margin-top: 12px; padding-top: 11px;
    border-top: 1px solid rgba(255,255,255,0.08); font-size: 11.5px; font-weight: 600; color: #9bb0ff; }
  .ap-note svg { flex: none; }

  /* the overnight chart */
  .ap-svg { width: 100%; height: auto; display: block; overflow: visible; }
  .ap-svg .ap-grid { stroke: rgba(255,255,255,0.07); stroke-width: 1; }
  .ap-svg .ap-ylbl { fill: #5f6678; font-size: 9px; font-weight: 600; text-anchor: end; }
  .ap-svg .ap-xlbl { fill: #6d7178; font-size: 9px; font-weight: 600; text-anchor: middle; }
  .ap-svg .ap-nowline { stroke: #f3f5fa; stroke-width: 1; stroke-dasharray: 2 3; opacity: .5; }
  .ap-svg .ap-nowlbl { fill: #cfd5e2; font-size: 8.5px; font-weight: 700; text-anchor: middle; }
  .ap-svg .ap-bedline { fill: none; stroke: #e7ecff; stroke-width: 2; stroke-linecap: round;
    stroke-dasharray: 1 4; opacity: .9; }
  .ap-legend { display: flex; gap: 15px; margin: 5px 0 0 30px; font-size: 10px; font-weight: 600; color: #838b9f; }
  .ap-legend span { display: flex; align-items: center; gap: 5px; }
  .ap-legend i { width: 13px; height: 3px; border-radius: 2px; }
  .ap-legend i.pl { background: linear-gradient(90deg, #6f8cff, #b98cff, #ff8a5a); }
  .ap-legend i.bd { background: repeating-linear-gradient(90deg, #e7ecff 0 2px, transparent 2px 5px); }

  .ap-phases { display: flex; gap: 6px; margin-top: 11px; }
  .ap-pchip { flex: 1 1 0; min-width: 0; border-radius: 12px; padding: 7px 4px 8px; text-align: center;
    background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); }
  .ap-pchip .t { font-size: 9px; font-weight: 700; color: #767e93; font-variant-numeric: tabular-nums; }
  .ap-pchip .d { margin-top: 3px; font-size: 12px; font-weight: 700; color: #cfd5e2; font-variant-numeric: tabular-nums; }
  .ap-pchip .d.warm { color: #ff8a5a; } .ap-pchip .d.cool { color: #6f8cff; } .ap-pchip .d.mid { color: #b98cff; }
  .ap-pchip.on { background: linear-gradient(165deg, rgba(122,52,230,0.26), rgba(255,255,255,0.02));
    border-color: rgba(122,52,230,0.44); }
  .ap-pchip.on .t { color: #cbb2ff; } .ap-pchip.on .d { color: #e9dcff; }

  /* collapsible explanation blocks */
  .ap-fold { margin-top: 10px; border-radius: 18px; overflow: hidden;
    background: linear-gradient(165deg, rgba(255,255,255,0.09), rgba(255,255,255,0.02));
    -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px);
    border: 1px solid rgba(255,255,255,0.10); box-shadow: inset 0 1px 0 rgba(255,255,255,0.10); }
  .ap-foldhd { display: flex; align-items: center; gap: 9px; width: 100%; padding: 14px 15px;
    background: none; border: none; color: inherit; font: inherit; text-align: left; cursor: pointer;
    -webkit-tap-highlight-color: transparent; }
  .ap-foldt { flex: none; font-size: 12px; font-weight: 700; letter-spacing: .3px; text-transform: uppercase; color: #cdd3e0; }
  .ap-folds { flex: 1 1 auto; min-width: 0; font-size: 11.5px; font-weight: 500; color: #838b9f;
    text-align: right; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .ap-foldc { flex: none; color: #767e93; transition: transform .2s cubic-bezier(.22,1,.36,1); }
  .ap-fold.open .ap-foldc { transform: rotate(180deg); }
  .ap-fold.open .ap-folds { opacity: 0; }
  .ap-foldb { display: none; padding: 0 15px 13px; }
  .ap-fold.open .ap-foldb { display: block; }
  .ap-fold .sm-factors { background: none; border: none; padding: 0; margin: 0; -webkit-backdrop-filter: none; backdrop-filter: none; }

  /* the reasoning, as a zero-centred waterfall */
  .ap-wfrow { display: grid; grid-template-columns: 100px 1fr 46px; align-items: center; gap: 10px;
    padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
  .ap-wfrow:last-child { border-bottom: none; }
  .ap-wfn { font-size: 12.5px; font-weight: 700; color: #e4e8f2; }
  .ap-wfd { margin-top: 2px; font-size: 10.5px; font-weight: 500; color: #767e93;
    display: flex; align-items: center; gap: 6px; }
  .ap-wfbar { position: relative; height: 18px; }
  .ap-wfbar::before { content: ""; position: absolute; left: 50%; top: -1px; bottom: -1px; width: 1px;
    background: rgba(255,255,255,0.16); }
  .ap-wfbar b { position: absolute; top: 4px; height: 10px; border-radius: 3px; }
  .ap-wfbar b.c { right: 50%; background: linear-gradient(270deg, #6f8cff, rgba(111,140,255,0.45)); }
  .ap-wfbar b.w { left: 50%; background: linear-gradient(90deg, #ff8a5a, rgba(255,138,90,0.45)); }
  .ap-wfv { font-size: 12.5px; font-weight: 700; text-align: right; font-variant-numeric: tabular-nums; }
  .ap-wfv.warm { color: #ff8a5a; } .ap-wfv.cool { color: #6f8cff; } .ap-wfv.neu { color: #9aa2b6; }
  .ap-wfsum { border-top: 1px solid rgba(255,255,255,0.14); margin-top: 3px; padding-top: 11px; }
  .ap-wfsum .ap-wfn { font-weight: 800; }
  .ap-wfsum .ap-wfv { font-size: 17px; color: #b98cff; }
  .ap-wfnote { margin-top: 10px; font-size: 11px; font-weight: 500; color: #8a93a8; line-height: 1.45; }

  /* tuning */
  .ap-tsec + .ap-tsec { margin-top: 18px; }
  .ap-tlbl { display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
    font-size: 11.5px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase;
    color: #8a93a8; margin-bottom: 9px; }
  .ap-tlbl span { text-transform: none; letter-spacing: 0; font-size: 11.5px; font-weight: 600; color: #9aa2b6; }
  .ap-seg { display: grid; gap: 4px; padding: 4px; border-radius: 999px;
    background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.10); }
  .ap-seg-opt { height: 44px; border-radius: 999px; background: none; border: 1px solid transparent;
    color: #9aa2b6; font: inherit; font-size: 13px; font-weight: 700; cursor: pointer;
    -webkit-tap-highlight-color: transparent; }
  .ap-seg-opt.on { background: linear-gradient(165deg, rgba(122,52,230,0.55), rgba(122,52,230,0.32));
    border-color: rgba(185,140,255,0.45); color: #f0e8ff; }
  /* temperature-range track — a live-drifting cool->warm gradient behind the fence, with tick
     marks and the off-limits ends dimmed. Purely visual (the ± steppers below still do the work);
     mirrors the "safety fence, not a target" framing in the hint underneath. */
  .ap-rangetrack { position: relative; height: 40px; border-radius: 999px; overflow: hidden;
    margin-bottom: 12px; border: 1px solid rgba(255,255,255,0.16);
    box-shadow: inset 0 1px 3px rgba(0,0,0,0.35); }
  .ap-rangegrad { position: absolute; inset: 0;
    background: linear-gradient(90deg, #2e6bff 0%, #35b8ff 20%, #6ad1c9 38%, #ffd166 60%, #ff9a4d 80%, #ff5c5c 100%);
    background-size: 220% 100%; animation: apRangeDrift 16s ease-in-out infinite; }
  @keyframes apRangeDrift { 0%, 100% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } }
  @media (prefers-reduced-motion: reduce) { .ap-rangegrad { animation: none; background-position: 35% 50%; } }
  .ap-rangeticks { position: absolute; inset: 0; display: flex; align-items: center; justify-content: space-between;
    padding: 0 12px; pointer-events: none; }
  .ap-rangeticks i { width: 1px; height: 13px; background: rgba(255,255,255,0.32); border-radius: 1px; }
  .ap-rangedim { position: absolute; top: 0; bottom: 0; background: rgba(8,9,14,0.62); pointer-events: none; }
  .ap-rangedim-lo { left: 0; border-radius: 999px 0 0 999px; }
  .ap-rangedim-hi { right: 0; border-radius: 0 999px 999px 0; }
  .ap-rangehandle { position: absolute; top: 50%; transform: translate(-50%, -50%); min-width: 30px;
    height: 26px; padding: 0 8px; border-radius: 999px; background: rgba(10,12,18,0.88);
    border: 1px solid rgba(255,255,255,0.55); color: #fff; font-size: 11px; font-weight: 800;
    display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 6px rgba(0,0,0,0.4);
    font-variant-numeric: tabular-nums; }
  .ap-trow { display: flex; align-items: center; gap: 12px; padding: 11px 0;
    border-bottom: 1px solid rgba(255,255,255,0.06); }
  .ap-trow:last-child { border-bottom: none; }
  .ap-trn { flex: 1 1 auto; min-width: 0; font-size: 13.5px; font-weight: 700; color: #eef1f7; }
  .ap-sw { width: 40px; height: 23px; border-radius: 999px; position: relative; flex: none; cursor: pointer;
    background: linear-gradient(180deg, rgba(255,255,255,0.1), rgba(255,255,255,0.03));
    box-shadow: inset 0 1px 3px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.14); }
  .ap-sw i { position: absolute; top: 2.5px; left: 2.5px; width: 18px; height: 18px; border-radius: 50%;
    background: #fff; transition: transform .2s cubic-bezier(.22,1,.36,1); }
  .ap-sw.on { background: #7a34e6; box-shadow: inset 0 1px 3px rgba(0,0,0,0.28), 0 0 0 1px rgba(122,52,230,0.5); }
  .ap-sw.on i { transform: translateX(17px); }
  .ap-step { display: flex; align-items: center; gap: 3px; padding: 3px; border-radius: 999px;
    background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.10); flex: none; }
  .ap-lims { display: flex; align-items: flex-start; justify-content: space-around; gap: 14px; }
  .ap-limg { display: flex; flex-direction: column; align-items: center; gap: 6px; }
  .ap-limk { font-size: 10.5px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; color: #8a93a8; }
  .ap-limr { display: flex; align-items: center; gap: 3px; padding: 3px; border-radius: 999px;
    background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.10); }
  .ap-thint { margin-top: 10px; font-size: 11.5px; font-weight: 500; color: #8a93a8; line-height: 1.45; }
  .ap-stepbtn { width: 32px; height: 32px; border-radius: 50%; flex: none; cursor: pointer;
    background: rgba(255,255,255,0.05); border: none; color: #b6bdcd; font: inherit; font-size: 15px;
    font-weight: 700; line-height: 1; -webkit-tap-highlight-color: transparent; }
  .ap-stepbtn:active { background: rgba(255,255,255,0.14); }
  .ap-step u, .ap-limv { min-width: 46px; text-align: center; font-size: 13px; font-weight: 700;
    text-decoration: none; font-variant-numeric: tabular-nums; color: #eef1f7; }
  .ap-step u.warm { color: #ff8a5a; } .ap-step u.cool { color: #6f8cff; } .ap-step u.neu { color: #9aa2b6; }
  /* fold + row glyphs — sized and muted so they read as labels, not decoration */
  .ap-foldi { flex: none; display: flex; color: #9aa2b6; }
  .ap-foldi svg { width: 16px; height: 16px; }
  .ap-tri { flex: none; display: flex; width: 30px; height: 30px; border-radius: 10px;
    align-items: center; justify-content: center; color: #b6bdcd;
    background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.09); }
  .ap-tri svg { width: 15px; height: 15px; }

  /* Outside tonight — the forecast behind the model's largest single term */
  .ap-fcwrap { margin-top: 14px; padding-top: 13px; border-top: 1px solid rgba(255,255,255,0.08); }
  .ap-fchd { display: flex; align-items: baseline; justify-content: space-between;
    font-size: 11px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase;
    color: #8a93a8; margin-bottom: 10px; }
  .ap-fchd span { text-transform: none; letter-spacing: 0; font-weight: 600; color: #6d7178; }
  .ap-fc { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 5px; }
  .ap-fcc { display: flex; flex-direction: column; align-items: center; gap: 5px; }
  .ap-fcc .t { font-size: 9.5px; font-weight: 700; color: #767e93; }
  .ap-fcc .i { color: #8a93a8; display: flex; }
  .ap-fcc .i svg { width: 17px; height: 17px; }
  .ap-fcc .d { font-size: 13px; font-weight: 700; color: #cfd5e2; font-variant-numeric: tabular-nums; }

  /* tonight so far */
  .ap-score { display: flex; align-items: flex-end; gap: 12px; }
  .ap-scorebig { font-size: 38px; font-weight: 300; letter-spacing: -1.5px; line-height: .9; color: #7ce0b0; }
  .ap-scoresub { font-size: 11.5px; font-weight: 600; color: #9aa2b6; padding-bottom: 3px; }
  .ap-sgrid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; margin-top: 12px; }
  .ap-scell { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.07);
    border-radius: 11px; padding: 8px 9px; }
  .ap-scell .k { display: block; font-size: 9px; font-weight: 700; letter-spacing: .3px;
    text-transform: uppercase; color: #767e93; }
  .ap-scell .v { display: block; margin-top: 2px; font-size: 15px; font-weight: 700; color: #eef1f7;
    font-variant-numeric: tabular-nums; }

  /* reset */
  .ap-treset { display: flex; align-items: center; justify-content: center; gap: 8px;
    margin-top: 18px; padding: 13px; border-radius: 14px; cursor: pointer;
    background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
    font-size: 13px; font-weight: 700; color: #ff8a7a; -webkit-tap-highlight-color: transparent; }
  .ap-treset svg { width: 15px; height: 15px; }
  .ap-treset.armed { background: rgba(255,90,82,0.16); border-color: rgba(255,90,82,0.45); color: #ff5a52; }

  /* .ap-strip/.ap-note set display, which outranks the UA's [hidden] rule inside a shadow root */
  .ap-strip[hidden], .ap-note[hidden] { display: none !important; }
  .ap-card.live.sup .ap-big { color: #767e93; }
  .ap-tempty { font-size: 12px; font-weight: 500; color: #6d7178; line-height: 1.45; }
  .ap-foot { margin: 12px 3px 0; font-size: 11.5px; font-weight: 500; color: #6d7178; line-height: 1.45; }
  @media (prefers-reduced-motion: reduce) {
    .ap-foldc, .ap-sw i { transition: none; }
  }

  /* the bias segment is emitted by _smartHTMLv2 but styled with the older .smv2-* rules, so it
     kept the fixed purple after everything around it moved to the accent */
  .v2home.glow .smv2-seg { border-color: transparent; box-shadow: inset 0 0 0 0.5px rgba(255,255,255,0.09); }
  .v2home.glow .smv2-seg-opt.on { background: var(--gl-acc); color: #0b0b0c;
    box-shadow: 0 0 18px rgba(var(--gl-rgb),0.5); }
  .v2home.glow .smv2-bias-t { color: var(--gl-hi); }

  /* ── Autopilot tab, Glow skin (v10.31) ─────────────────────────────────────────────────────
     The tab was still on the pre-Glow system: flat glass cards and a fixed purple #7a34e6
     accent, sitting inside a shell whose every other surface had moved to GLOW_PAL. These
     rules re-skin it in place — same class names, same JS, same markup — by consuming the
     --gl-* custom properties that #podRoot (.pod.v2home.glow) already stamps, so Autopilot
     re-tints with the bed's own state exactly like Home instead of being "the purple screen".
     Design notes: design/autopilot-glow/ (canvas), DESIGN-LANGUAGE-V2-HOME.md §2-4.
     Scoped to .v2home.glow so the classic layout keeps the original treatment untouched. */
  .v2home.glow .ap-card { border-radius: 24px; border: none;
    background: linear-gradient(158deg, rgba(255,255,255,0.075), rgba(255,255,255,0.022) 60%, rgba(var(--gl-rgb),0.04));
    -webkit-backdrop-filter: blur(22px) saturate(175%); backdrop-filter: blur(22px) saturate(175%);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.22), inset 0 0 0 0.5px rgba(255,255,255,0.09),
      0 14px 38px rgba(0,0,0,0.45); }
  .v2home.glow .ap-card.live {
    background: linear-gradient(158deg, rgba(var(--gl-rgb),0.13), rgba(255,255,255,0.022) 62%, rgba(var(--gl-rgb),0.06));
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.28), inset 0 0 0 0.5px rgba(var(--gl-rgb),0.26),
      inset 0 -16px 38px rgba(var(--gl-rgb),0.1), 0 14px 40px rgba(0,0,0,0.45),
      0 0 40px rgba(var(--gl-rgb),0.12); }
  .v2home.glow .ap-card.live.sup {
    background: linear-gradient(158deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02));
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.2), inset 0 0 0 0.5px rgba(255,255,255,0.08),
      0 14px 38px rgba(0,0,0,0.45); }
  /* §4: 11px / 2.6px tracking / tinted --gl-hi, never a fixed grey */
  .v2home.glow .ap-lbl, .v2home.glow .ap-tlbl, .v2home.glow .ap-fchd {
    font-size: 11px; letter-spacing: 2.6px; font-weight: 500; color: var(--gl-hi); opacity: .9; }
  .v2home.glow .ap-tlbl span, .v2home.glow .ap-fchd span { letter-spacing: 0; opacity: .75; color: rgba(235,235,245,0.5); }
  /* the hero number: gradient-filled and throwing its own light, like Home's .gl-num */
  .v2home.glow .ap-big { font-weight: 250; letter-spacing: -3px;
    background: linear-gradient(168deg, #fff 24%, var(--gl-hi) 78%, var(--gl-acc));
    -webkit-background-clip: text; background-clip: text; color: transparent;
    filter: drop-shadow(0 0 24px rgba(var(--gl-rgb),0.42)); }
  .v2home.glow .ap-big.warm, .v2home.glow .ap-big.cool, .v2home.glow .ap-big.mid { color: transparent; }
  .v2home.glow .ap-card.live.sup .ap-big { background: none; color: #8d928c; filter: none; }
  .v2home.glow .ap-meta .l1 { color: var(--gl-hi); }
  /* convergence rail: the gap runs a travelling shimmer while it is still closing */
  .v2home.glow .ap-gap { background: linear-gradient(90deg, rgba(var(--gl-rgb),0.3), var(--gl-acc));
    box-shadow: 0 0 18px rgba(var(--gl-rgb),0.5); overflow: hidden; }
  .v2home.glow .ap-gap::after { content: ""; position: absolute; top: 0; bottom: 0; width: 42%;
    background: linear-gradient(90deg, transparent, rgba(255,255,255,0.7), transparent);
    animation: apFlow 2.4s ease-in-out infinite; }
  @keyframes apFlow { 0% { left: -45%; } 100% { left: 103%; } }
  .v2home.glow .ap-tgt { background: #0a0b0c;
    box-shadow: 0 0 0 3px var(--gl-acc), 0 0 16px rgba(var(--gl-rgb),0.75); }
  .v2home.glow .ap-raill .v.mid, .v2home.glow .ap-raill .v.warm, .v2home.glow .ap-raill .v.cool { color: var(--gl-hi); }
  /* strip + phase chips: hairlines and tint, not bordered boxes */
  .v2home.glow .ap-strip { background: none; gap: 0; border-radius: 0;
    border-top: 1px solid rgba(255,255,255,0.08); padding-top: 13px; }
  .v2home.glow .ap-strip .c { background: none; padding: 0 12px; }
  .v2home.glow .ap-strip .c + .c { border-left: 1px solid rgba(255,255,255,0.08); }
  .v2home.glow .ap-strip .v { font-weight: 300; font-size: 17px; letter-spacing: -.4px; }
  .v2home.glow .ap-strip .v.warm, .v2home.glow .ap-strip .v.cool { color: var(--gl-hi); }
  .v2home.glow .ap-note { color: var(--gl-hi); }
  .v2home.glow .ap-pchip { border: none; background: rgba(255,255,255,0.035);
    box-shadow: inset 0 0 0 0.5px rgba(255,255,255,0.055); }
  .v2home.glow .ap-pchip.on { background: rgba(var(--gl-rgb),0.2);
    box-shadow: inset 0 0 0 0.5px rgba(var(--gl-rgb),0.45), 0 0 20px rgba(var(--gl-rgb),0.28); }
  .v2home.glow .ap-pchip.on .t { color: var(--gl-hi); } .v2home.glow .ap-pchip.on .d { color: #fff; }
  .v2home.glow .ap-pchip .d.warm, .v2home.glow .ap-pchip .d.cool, .v2home.glow .ap-pchip .d.mid { color: #cfd5e2; }
  /* folds become sections: a hairline under the header, no second pane inside the first */
  .v2home.glow .ap-fold { border: none; border-radius: 0; background: none;
    -webkit-backdrop-filter: none; backdrop-filter: none; box-shadow: none;
    border-bottom: 1px solid rgba(255,255,255,0.07); margin-top: 0; }
  .v2home.glow .ap-foldhd { padding: 15px 3px; }
  .v2home.glow .ap-foldt { font-size: 11px; letter-spacing: 2.6px; font-weight: 500; color: var(--gl-hi); }
  .v2home.glow .ap-foldb { padding: 0 3px 15px; }
  .v2home.glow .ap-foldi { color: var(--gl-hi); opacity: .8; }
  .v2home.glow .ap-wfsum .ap-wfv { color: var(--gl-hi); }
  .v2home.glow .ap-wfbar b.c { box-shadow: 0 0 14px rgba(95,168,255,0.45); }
  .v2home.glow .ap-wfbar b.w { box-shadow: 0 0 14px rgba(255,138,90,0.45); }
  /* controls take the accent instead of the old fixed purple */
  .v2home.glow .ap-seg { border: none; box-shadow: inset 0 0 0 0.5px rgba(255,255,255,0.09); }
  .v2home.glow .ap-seg-opt.on { background: var(--gl-acc); border-color: transparent; color: #0b0b0c;
    box-shadow: 0 0 18px rgba(var(--gl-rgb),0.5); }
  .v2home.glow .ap-sw.on { background: rgba(var(--gl-rgb),0.62);
    box-shadow: inset 0 1px 3px rgba(0,0,0,0.25), 0 0 0 1px rgba(var(--gl-rgb),0.55), 0 0 18px rgba(var(--gl-rgb),0.45); }
  .v2home.glow .ap-step, .v2home.glow .ap-limr, .v2home.glow .ap-tri, .v2home.glow .ap-scell,
  .v2home.glow .ap-treset { border: none; box-shadow: inset 0 0 0 0.5px rgba(255,255,255,0.09); }
  .v2home.glow .ap-tri { color: var(--gl-hi); background: rgba(var(--gl-rgb),0.15); }
  .v2home.glow .ap-step u.warm, .v2home.glow .ap-step u.cool, .v2home.glow .ap-step u.neu { color: var(--gl-hi); }
  .v2home.glow .ap-scorebig { background: linear-gradient(168deg, #fff, var(--gl-hi));
    -webkit-background-clip: text; background-clip: text; color: transparent; }

  /* the live card's aux line becomes a glowing pill — it is the "this is live right now" cue,
     the same job Home's status pill does, so it should not read as grey caption text */
  .v2home.glow .ap-card.live .ap-aux { padding: 6px 11px; border-radius: 999px; font-size: 10px;
    letter-spacing: .4px; text-transform: uppercase; color: var(--gl-hi);
    background: rgba(var(--gl-rgb),0.13);
    box-shadow: inset 0 0 0 0.5px rgba(var(--gl-rgb),0.4), 0 0 18px rgba(var(--gl-rgb),0.2);
    animation: apPill 3.4s ease-in-out infinite; }
  @keyframes apPill { 50% { box-shadow: inset 0 0 0 0.5px rgba(var(--gl-rgb),0.55), 0 0 28px rgba(var(--gl-rgb),0.36); } }
  /* the aux text is empty until the suggestion has a last_changed to age — an empty pill would
     paint as a small lit blob, so collapse it entirely rather than showing chrome with no content */
  .v2home.glow .ap-card.live .ap-aux:empty { display: none; }
  .v2home.glow .ap-card.live.sup .ap-aux, .v2home.glow .ap-card.live.ap-alarm .ap-aux { animation: none; }
  .v2home.glow .ap-card.live.ap-alarm .ap-aux { color: #ffd68a; background: rgba(255,176,32,0.14);
    box-shadow: inset 0 0 0 0.5px rgba(255,176,32,0.45); }
  /* the fence the target lives inside — without it the rail has no scale */
  .ap-railends { display: flex; justify-content: space-between; margin: 6px 3px 0;
    font-size: 10px; font-weight: 600; color: rgba(235,235,245,0.3); font-variant-numeric: tabular-nums; }
  /* the now-dot breathes, so "live" reads without a legend */
  .v2home.glow .ap-svg .ap-nowhalo { animation: apHalo 2.2s ease-out infinite; }
  @keyframes apHalo { 0% { opacity: .34; } 100% { opacity: 0; } }
  /* last night's gap, explained in words under the ribbon */
  .ap-hwhy { display: flex; align-items: flex-start; gap: 9px; margin-top: 13px; padding-top: 12px;
    border-top: 1px solid rgba(255,255,255,0.07); font-size: 11.5px; font-weight: 500;
    line-height: 1.45; color: #ffd68a; }
  .ap-hwhy svg { flex: none; width: 15px; height: 15px; margin-top: 1px; }

  /* asked vs accepted, the clamp note, and the way back from "not driving" (v10.31) */
  .ap-grid, .ap-clamp { display: inline-flex; align-items: center; gap: 7px; margin-top: 12px;
    padding: 7px 12px; border-radius: 999px; font-size: 10.5px; font-weight: 600;
    color: rgba(235,235,245,0.6); background: rgba(255,255,255,0.05);
    box-shadow: inset 0 0 0 0.5px rgba(255,255,255,0.1); }
  .ap-grid b { color: var(--gl-hi, #d8c9ff); font-weight: 700; }
  .ap-clamp { color: #ffd68a; background: rgba(255,176,32,0.13);
    box-shadow: inset 0 0 0 0.5px rgba(255,176,32,0.35); }
  .ap-grid[hidden], .ap-clamp[hidden], .ap-back[hidden] { display: none !important; }
  /* "off" is the only suppression that is a problem — boost and vacation are deliberate and stay
     muted. This one goes amber and offers the way back, because on 2026-09-19 it sat unnoticed
     for 7h 40m. */
  .v2home.glow .ap-card.live.ap-alarm {
    background: linear-gradient(158deg, rgba(255,176,32,0.14), rgba(255,255,255,0.03));
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.22), inset 0 0 0 0.5px rgba(255,176,32,0.45),
      inset 0 -16px 38px rgba(255,176,32,0.1), 0 0 44px rgba(255,176,32,0.2),
      0 14px 40px rgba(0,0,0,0.45); }
  .v2home.glow .ap-card.live.ap-alarm .ap-lbl { color: #ffd68a; }
  .v2home.glow .ap-card.live.ap-alarm .ap-meta .l1 { color: #ffd68a; }
  .ap-back { display: block; width: 100%; margin-top: 14px; height: 46px; border: none;
    border-radius: 15px; font: inherit; font-size: 13px; font-weight: 700; cursor: pointer;
    color: #120d00; background: #ffb020; box-shadow: 0 0 26px rgba(255,176,32,0.4);
    -webkit-tap-highlight-color: transparent; }
  .ap-back:active { filter: brightness(0.92); }

  .ap-trsub { display: block; margin-top: 3px; font-style: normal; font-size: 11px; font-weight: 500; color: rgba(235,235,245,0.44); }
  .ap-cadv { flex: none; font-size: 13px; font-weight: 700; color: var(--gl-hi, #d8c9ff); font-variant-numeric: tabular-nums; }

  /* the adjustments ledger */
  .ap-ldsum { display: flex; gap: 14px; padding-bottom: 11px; margin-bottom: 4px;
    border-bottom: 1px solid rgba(255,255,255,0.08); font-size: 11px; font-weight: 500;
    color: rgba(235,235,245,0.5); }
  .ap-ldsum b { color: var(--gl-hi, #d8c9ff); font-weight: 700; font-size: 13px; }
  .ap-ldr { display: flex; align-items: flex-start; gap: 11px; padding: 10px 0;
    border-bottom: 1px solid rgba(255,255,255,0.06); }
  .ap-ldr:last-child { border-bottom: none; }
  .ap-ldt { width: 62px; flex: none; font-size: 11px; font-weight: 700; padding-top: 2px;
    color: rgba(235,235,245,0.4); font-variant-numeric: tabular-nums; }
  .ap-ldr > i { width: 8px; height: 8px; border-radius: 50%; flex: none; margin-top: 5px; }
  .ap-ldr > i.warm { background: #ff8a5a; box-shadow: 0 0 10px rgba(255,138,90,.9); }
  .ap-ldr > i.cool { background: #5fa8ff; box-shadow: 0 0 10px rgba(95,168,255,.9); }
  .ap-ldb { flex-grow: 1; font-size: 12.5px; }
  .ap-ldb b { font-weight: 700; font-variant-numeric: tabular-nums; }
  .ap-ldb em { display: block; margin-top: 4px; font-style: normal; font-size: 11px;
    font-weight: 500; color: rgba(235,235,245,0.44); }

  /* ── LAST NIGHT ribbon (v10.31) ────────────────────────────────────────────────────────────
     The whole of last night as one band: the setpoint the bed actually held, coloured
     warm -> cool, with the stretches where nothing was driving it cut out in amber hatching.
     Added because on 2026-09-19 Autopilot was switched off at 00:03 and the setpoint sat at
     28.1 until 07:43 while the model was asking for 25-32 — and no screen said so; it was only
     found by reading recorder history by hand. As a ribbon it is the first thing the eye lands
     on. Data: _ensureLastNight() (history/history_during_period). */
  .ap-hist { position: relative; height: 44px; border-radius: 12px; overflow: hidden;
    background: rgba(255,255,255,0.04); box-shadow: inset 0 0 0 0.5px rgba(255,255,255,0.07); }
  .ap-hseg { position: absolute; top: 0; bottom: 0; }
  .ap-hseg.warm { background: linear-gradient(180deg, rgba(255,138,90,0.58), rgba(255,138,90,0.15)); }
  .ap-hseg.mid  { background: linear-gradient(180deg, rgba(183,155,255,0.58), rgba(183,155,255,0.15)); }
  .ap-hseg.cool { background: linear-gradient(180deg, rgba(95,168,255,0.62), rgba(95,168,255,0.16)); }
  .ap-hseg.gap  { background: repeating-linear-gradient(-45deg,
      rgba(255,176,32,0.3) 0 5px, rgba(255,176,32,0.08) 5px 10px);
    box-shadow: inset 0 0 0 1px rgba(255,176,32,0.45); }
  .ap-hline { position: absolute; inset: 0; pointer-events: none; }
  .ap-hline path { fill: none; stroke: rgba(255,255,255,0.75); stroke-width: 1.6; }
  .ap-haxis { display: flex; justify-content: space-between; margin-top: 7px;
    font-size: 9.5px; font-weight: 600; color: rgba(235,235,245,0.32); font-variant-numeric: tabular-nums; }
  .ap-htags { display: flex; gap: 7px; margin-top: 12px; flex-wrap: wrap; }
  .ap-htag { display: inline-flex; align-items: center; gap: 6px; height: 27px; padding: 0 11px;
    border-radius: 999px; font-size: 10.5px; font-weight: 600; color: rgba(235,235,245,0.68);
    background: rgba(255,255,255,0.05); box-shadow: inset 0 0 0 0.5px rgba(255,255,255,0.09); }
  .ap-htag b { color: #fff; font-weight: 700; }
  .ap-htag.amber { color: #ffd68a; background: rgba(255,176,32,0.13);
    box-shadow: inset 0 0 0 0.5px rgba(255,176,32,0.38); }
  .ap-hempty { font-size: 12px; font-weight: 500; color: #6d7178; line-height: 1.45; }
  @media (prefers-reduced-motion: reduce) { .v2home.glow .ap-gap::after { animation: none; } }

  /* the step editor sheet's two section labels ("Starts at" / "Hold at") */
  .pk-section-hd { font-size: 11.5px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; color: #8a93a8; margin: 0 0 8px 2px; }

  /* ===== Dev tab (v2) — a dense read surface; see _devHTMLv2 / _renderDev ===== */
  .dev { --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; padding-top: 2px; }
  .dev .mono { font-family: var(--mono); }
  .dev-intro { font-size: 12.5px; font-weight: 500; color: #8a93a8; line-height: 1.5; margin: 0 2px 12px; }
  .dev-card { padding: 13px 14px 14px; }
  .dev-card + .dev-card { margin-top: 10px; }
  .dev-card.dev-ap { background: linear-gradient(165deg, rgba(122,52,230,0.12), rgba(255,255,255,0.02)); border-color: rgba(122,52,230,0.24); }
  .dev-lbl { font-size: 11px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; color: #8a93a8; margin-bottom: 9px; }
  .dev-ent { font-size: 11px; color: #c5cbda; margin: -2px 0 8px; word-break: break-all; }
  .dev-seg { display: flex; gap: 3px; padding: 3px; border-radius: 999px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); margin-bottom: 8px; }
  .dev-seg span { flex: 1; text-align: center; padding: 6px 0; border-radius: 999px; font-size: 11.5px; font-weight: 700; color: #9aa2b6; font-family: var(--mono); }
  .dev-seg span.on { background: linear-gradient(165deg, rgba(122,52,230,0.30), rgba(255,255,255,0.02)); border: 1px solid rgba(122,52,230,0.45); color: #d7c9f5; }
  .dev-r { display: flex; align-items: baseline; gap: 10px; font-size: 12px; line-height: 1.55; }
  .dev-r .k { color: #8a93a8; flex-grow: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dev-r .v { font-weight: 700; color: #eef1f6; flex: none; font-variant-numeric: tabular-nums; font-family: var(--mono); }
  .dev-lr { display: grid; grid-template-columns: minmax(0,1fr) 66px 66px; gap: 5px 8px; align-items: baseline; }
  .dev-lr .hh { font-size: 9.5px; font-weight: 700; letter-spacing: .3px; text-transform: uppercase; color: #767e93; text-align: right; }
  .dev-lr .k { font-size: 12px; color: #8a93a8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dev-lr .c { font-size: 12px; font-weight: 700; color: #eef1f6; text-align: right; font-variant-numeric: tabular-nums; font-family: var(--mono); }
  .dev-r .v.cool, .dev-lr .c.cool { color: #8fb0ff; }
  .dev-r .v.warm, .dev-lr .c.warm { color: #ff8a5a; }
  .dev-r .v.mid, .dev-lr .c.mid { color: #b98cff; }
  .dev-r .v.ok, .dev-lr .c.ok { color: #33d17a; }
  .dev-r .v.dim, .dev-lr .c.dim { color: #6d7178; font-weight: 600; }
  .dev-st { display: flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 700; line-height: 1.7; }
  .dev-st .dev-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .dev-st .dev-age { margin-left: auto; font-size: 10.5px; font-weight: 600; color: #7f879c; font-family: var(--mono); }
  .dev-note { font-size: 10.5px; font-weight: 600; color: #7f879c; margin-top: 9px; line-height: 1.5; }
  .dev-acts { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 8px; }
  .dev-btn { height: 40px; border-radius: 12px; font: inherit; font-size: 12px; font-weight: 700; color: #cdd3e0;
    background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .dev-btn:active { background: rgba(255,255,255,0.12); }
  .dev-foot { font-size: 10px; font-weight: 600; color: #6d7178; margin-top: 10px; }
  /* Dev > Vibration themes (v10.37) */
  .vib-side span { text-transform: capitalize; cursor: pointer; }
  .vib-grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 8px; margin-top: 4px; }
  .vib-tile { display: flex; flex-direction: column; align-items: flex-start; gap: 5px; padding: 11px 12px; border-radius: 14px; text-align: left;
    background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.10); color: inherit; font: inherit; cursor: pointer;
    -webkit-tap-highlight-color: transparent; transition: background .2s, border-color .2s; }
  .vib-tile:active { background: rgba(183,155,255,0.14); }
  .vib-tile b { font-size: 13.5px; font-weight: 700; color: #eef1f6; }
  .vib-tile .vib-bar { display: block; width: 100%; height: 4px; border-radius: 3px; background: rgba(255,255,255,0.08); overflow: hidden; }
  .vib-tile .vib-bar em { display: block; height: 100%; border-radius: 3px; background: linear-gradient(90deg, #8a6be0, #d8c9ff); }
  .vib-tile .mono { font-size: 10.5px; color: #9aa2b6; }
  .vib-tile small { font-size: 11px; color: #7f879c; }
  .vib-tile.live { background: rgba(183,155,255,0.14); border-color: rgba(183,155,255,0.5); box-shadow: 0 0 16px rgba(183,155,255,0.25);
    animation: vib-shake .18s linear infinite; }
  .vib-tile.live small { color: #d8c9ff; }
  @keyframes vib-shake { 0%,100% { transform: translateX(0); } 25% { transform: translateX(-1px); } 75% { transform: translateX(1px); } }
  @media (prefers-reduced-motion: reduce) { .vib-tile.live { animation: none; } }
  .vib-stop { width: 100%; margin-top: 8px; text-transform: none; }
  /* Dev > Pod services (v10.33) */
  .dev-hs { display: flex; align-items: center; gap: 10px; padding: 10px 12px; margin: -2px 0 6px; border-radius: 12px;
    background: rgba(51,209,122,0.08); border: 1px solid rgba(51,209,122,0.22); cursor: pointer; }
  .dev-hs.warn { background: rgba(255,176,32,0.09); border-color: rgba(255,176,32,0.26); }
  .dev-hs.bad { background: rgba(255,90,82,0.10); border-color: rgba(255,90,82,0.30); }
  .dev-hs .dev-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
  .dev-hs.pulse .dev-dot { animation: es-dot-pulse 1.2s ease-in-out infinite; }
  .dev-hs-t { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex-grow: 1; }
  .dev-hs-t b { font-size: 13.5px; color: #eef1f6; }
  .dev-hs-t i { font-style: normal; font-size: 11.5px; color: #9aa2b6; line-height: 1.35; }
  .dev-hs-n { font-size: 11px; font-weight: 700; color: #9aa2b6; flex: none; }
  .dev-sg { font-size: 9.5px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; color: #6f778b; margin: 10px 0 2px; }
  .dev-st .dev-sl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .dev-st .dev-age { flex: none; max-width: 55%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; }
  .dev-ev { display: flex; gap: 10px; font-size: 11.5px; line-height: 1.6; color: #c5cbda; }
  .dev-ev .mono { flex: none; width: 74px; color: #7f879c; font-size: 10.5px; }
  .dev-btn.armed { background: rgba(255,90,82,0.16); border-color: rgba(255,90,82,0.45); color: #ffb3ae; }
  .dev-tg { display: flex; align-items: center; gap: 10px; width: 100%; margin-top: 10px; padding: 10px 12px; border-radius: 12px; text-align: left;
    background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.09); color: inherit; font: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .dev-tg span { display: flex; flex-direction: column; gap: 2px; flex-grow: 1; }
  .dev-tg b { font-size: 12.5px; color: #eef1f6; }
  .dev-tg i { font-style: normal; font-size: 11px; color: #8a93a8; line-height: 1.35; }
  .dev-tg em { width: 38px; height: 22px; border-radius: 11px; background: rgba(255,255,255,0.14); position: relative; flex: none; transition: background .2s; }
  .dev-tg em::after { content: ""; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: #eef1f6; transition: transform .2s; }
  .dev-tg.on em { background: #33d17a; }
  .dev-tg.on em::after { transform: translateX(16px); }
  /* Settings > Pod (v10.33) */
  .pod-hl { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
  .pod-hl .ps-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; background: #33d17a; box-shadow: 0 0 8px rgba(51,209,122,.75); }
  .pod-hl.warn .ps-dot { background: #ffb020; box-shadow: 0 0 8px rgba(255,176,32,.75); }
  .pod-hl.bad .ps-dot { background: #ff5a52; box-shadow: 0 0 9px rgba(255,90,82,.8); }
  .pod-hl.pulse .ps-dot { animation: es-dot-pulse 1.2s ease-in-out infinite; }
  .pod-rb { padding: 12px 14px; margin: 0 -2px; border-radius: 12px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); }
  .pod-rb.armed { background: rgba(255,90,82,0.14); border-color: rgba(255,90,82,0.42); }
  .pod-rb.armed .set-row-l b { color: #ffb3ae; }
  .pod-rb .set-row-c svg { width: 20px; height: 20px; }

  /* =====================================================================================
     v2 Home — "Glow" (v10.14). Scoped to .v2home.glow; classic never renders these classes.
     --gl-* = the bed's state colour (set by _renderGlow); --s-* = one side's colour.
     ===================================================================================== */
  .v2home.glow { position: relative; --gl-rgb: 141,146,140; --gl-rgb2: 141,146,140; --gl-acc: #8d928c; --gl-hi: #b7bcb5;
    --es-nav-accent: var(--gl-hi); }
  .v2home.glow > .gl-bg { position: absolute; inset: -18px -18px -20px; z-index: 0; pointer-events: none;
    background: radial-gradient(64% 40% at 100% 0%, rgba(var(--gl-rgb),0.26), rgba(var(--gl-rgb),0) 70%),
                radial-gradient(46% 30% at 100% 58%, rgba(var(--gl-rgb),0.07), rgba(var(--gl-rgb),0) 70%),
                linear-gradient(90deg, #060707 0%, #0a0b0c 60%, #0c0d0e 100%); }
  .v2home.glow.gl-dual > .gl-bg {
    background: radial-gradient(58% 34% at 100% 0%, rgba(var(--gl-rgb),0.24), rgba(var(--gl-rgb),0) 70%),
                radial-gradient(54% 32% at 100% 40%, rgba(var(--gl-rgb2),0.17), rgba(var(--gl-rgb2),0) 70%),
                linear-gradient(90deg, #060707 0%, #0a0b0c 60%, #0c0d0e 100%); }
  .v2home.glow > .gl-bg::after { content: ""; position: absolute; inset: 0;
    background-image: radial-gradient(rgba(255,255,255,0.05) 1px, transparent 1.3px); background-size: 14px 14px; }
  .v2home.glow > .hd, .v2home.glow > .v2content { position: relative; z-index: 1; }
  /* edge to edge: .v2home clips (overflow:hidden) at ha-card's PADDING box, so the glow stopped in a hard
     rectangle 18px inside the rounded card and every tile/button shadow at the sides was sheared off.
     Let the shell paint out to ha-card (which clips to its own radius), and widen the scroll area to the
     card edge while padding the same 18px back so content stays exactly where it was. */
  .v2home.glow { overflow: visible; }
  .v2home.glow > .v2content { margin: 0 -18px; }
  .v2home.glow > .v2content > [id^="view"] { padding-left: 18px; padding-right: 18px; }
  .v2home.glow .bed-glow { display: none; }
  .v2home.glow .bed-wrap { max-width: 82%; margin: 12px auto 2px; }
  /* v10.34 thermal headroom (E3): the host is exactly the bed's box, so the bar's position on the
     right flank is a fraction of the bed image (measured: visible mattress ends at ~81%) */
  .v2home.glow .hr-host { position: relative; max-width: 82%; margin: 12px auto 2px; }
  .v2home.glow .hr-host > .bed-wrap { max-width: 100%; margin: 0; }
  /* v10.39: the fan beside the bed. The box is bigger than the fan so its air can cross the bed;
     only the fan itself takes taps (dyson-fan-card mini). Tune --fan-* per dashboard if needed. */
  /* v10.40: with the fan in, the bed (and its headroom bar) slides right by bed_shift % of the
     row (default 7) so the fan has its own floor; the fan counters it and stays where it was. */
  .v2home.glow .hr-host.has-fan { margin-left: calc(9% + var(--bed-shift, 0%)); margin-right: calc(9% - var(--bed-shift, 0%)); }
  .es-fan { position: absolute; z-index: 7; pointer-events: none;
    left: calc(var(--fan-left, -12%) - var(--bed-shift, 0%) * 1.22); bottom: var(--fan-bottom, 10%); width: var(--fan-w, 74%); height: var(--fan-h, 86%); }
  .es-fan dyson-fan-card { display: block; width: 100%; height: 100%; }
  .hr-edge { position: absolute; left: 92.7%; top: 7.8%; width: 44px; height: 44%; padding: 0; margin: 0 0 0 -6px;
    background: none; border: 0; color: inherit; font: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent;
    --hr-c: #33d17a; --hr-frac: 0.5; }
  .hr-edge.warn { --hr-c: #ffb020; } .hr-edge.bad { --hr-c: #ff5a52; }
  .hr-edge[hidden] { display: none; }
  .hr-edge i { position: absolute; left: 6px; width: 5px; border-radius: 3px; }
  .hr-edge .hr-track { top: 0; bottom: 0; background: rgba(255,255,255,0.10); }
  .hr-edge .hr-fill { bottom: 0; height: calc(var(--hr-frac) * 100%); min-height: 4px; background: var(--hr-c);
    box-shadow: 0 0 12px var(--hr-c); transition: height .6s ease, background .4s; }
  .hr-edge .hr-floor { display: none; left: 0; bottom: -2px; width: 17px; height: 3px; border-radius: 2px; background: #ff5a52; box-shadow: 0 0 8px #ff5a52; }
  .hr-edge.bad .hr-fill { opacity: 0; } .hr-edge.bad .hr-floor { display: block; }
  .hr-edge .hr-txt { position: absolute; left: 20px; bottom: -2px; display: flex; flex-direction: column; align-items: flex-start; gap: 1px; white-space: nowrap; }
  .hr-edge .hr-txt b { font-size: 15px; font-weight: 400; color: var(--hr-c); font-variant-numeric: tabular-nums; }
  .hr-edge .hr-txt em { font-style: normal; font-size: 8.5px; font-weight: 600; letter-spacing: 1.6px; text-transform: uppercase; color: #7f879c; }
  .hr-big { display: flex; align-items: baseline; justify-content: center; gap: 10px; margin: 2px 0 6px; }
  .hr-big b { font-size: 40px; font-weight: 300; color: rgb(var(--hr-rgb)); letter-spacing: -1px; }
  .hr-big span { font-size: 14px; font-weight: 700; color: rgb(var(--hr-rgb)); }
  .hr-rows { width: 100%; margin: 10px 0 4px; text-align: left; }
  .hr-row { display: flex; align-items: center; gap: 10px; padding: 9px 2px; border-top: 1px solid rgba(255,255,255,0.07); }
  .hr-row span { display: flex; flex-direction: column; gap: 1px; flex-grow: 1; }
  .hr-row b { font-size: 14px; font-weight: 600; color: #eef1f6; }
  .hr-row i { font-style: normal; font-size: 11.5px; color: #8a93a8; }
  .hr-row em { font-style: normal; font-family: inherit; letter-spacing: 0; font-size: 15px; font-weight: 600; color: #eef1f6; }
  .hr-tip { font-size: 12.5px; }
  .v2home.glow .hd-pwr.on { color: var(--gl-acc); border-color: rgba(var(--gl-rgb),0.45); background: rgba(var(--gl-rgb),0.12);
    box-shadow: 0 0 18px rgba(var(--gl-rgb),0.3); }
  .v2home.glow .tabbar { background: rgba(20,22,24,0.72); }

  .gl-tile { position: relative; border-radius: 22px; padding: 14px 16px; margin-top: 10px;
    background: linear-gradient(180deg, rgba(255,255,255,0.062), rgba(255,255,255,0.018));
    border: 1px solid rgba(255,255,255,0.075);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.06), 0 12px 30px rgba(0,0,0,0.35); }
  .gl-tile[hidden] { display: none !important; }
  .gl-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .gl-lbl { font-size: 11px; font-weight: 500; letter-spacing: 2.6px; text-transform: uppercase; color: #b7bcb5; white-space: nowrap; }
  .gl-chip { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 999px;
    font-size: 12.5px; font-weight: 600; white-space: nowrap; background: rgba(var(--gl-rgb),0.14); color: var(--gl-hi); }
  .gl-chip[hidden] { display: none; }
  /* v10.36 wake-up pill — the state chip's recipe in Glow's schedule lilac */
  .gl-wake { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border: 0;
    border-radius: 999px; font: inherit; font-size: 12.5px; font-weight: 600; white-space: nowrap; cursor: pointer;
    background: rgba(183,155,255,0.15); color: #d8c9ff; -webkit-tap-highlight-color: transparent; }
  .gl-wake[hidden] { display: none; }
  .gl-wake svg { width: 14px; height: 14px; flex: none; }
  .gl-wake.armed svg { color: #33d17a; }
  .gl-wake.plain { background: rgba(255,255,255,0.07); color: #b7bcb5; }
  .gl-wake.waking { background: rgba(255,176,32,0.16); color: #ffd79a; animation: gl-wake-pulse 1.6s ease-in-out infinite; }
  .gl-wake.waking svg { color: #ffb020; }
  @keyframes gl-wake-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(255,176,32,0); } 50% { box-shadow: 0 0 16px 1px rgba(255,176,32,0.45); } }
  .gl-wake:not([hidden]) + .gl-chip { margin-left: 0; }
  .gl-temp-hd.waking .gl-lbl { display: none; }
  .gl-temp-hd.waking .gl-wake { margin-left: 0; }
  .gl-temp-hd.waking .gl-wake + .gl-chip { margin-left: auto; }
  @media (prefers-reduced-motion: reduce) { .gl-wake.waking { animation: none; } }
  .wk-sheet { text-align: left; width: 100%; }
  .wk-hd { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .wk-lbl { color: #d8c9ff; }
  .wk-coach { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 999px; border: 0; font: inherit;
    font-size: 12px; font-weight: 600; cursor: pointer; background: rgba(255,255,255,0.07); color: #9aa2b6; }
  .wk-coach svg { width: 13px; height: 13px; }
  .wk-coach.on { background: rgba(51,209,122,0.14); color: #33d17a; }
  .wk-time { display: flex; align-items: baseline; gap: 8px; margin-top: 10px; }
  .wk-time b { font-size: 52px; font-weight: 300; letter-spacing: -1.5px; color: #eef1f6; line-height: 1; }
  .wk-time span { font-size: 20px; color: #9aa2b6; }
  .wk-time em { margin-left: auto; font-style: normal; font-size: 12.5px; color: #8a93a8; }
  .wk-sub { font-size: 12.5px; color: #8a93a8; margin: 6px 0 12px; line-height: 1.4; }
  .wk-seg { margin-bottom: 6px; }
  .wk-rows { display: flex; flex-direction: column; }
  .wk-row { display: flex; align-items: center; gap: 11px; padding: 9px 0; border: 0; border-top: 1px solid rgba(255,255,255,0.07);
    background: none; color: inherit; font: inherit; text-align: left; width: 100%; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  div.wk-row { cursor: default; }
  .wk-ic { width: 32px; height: 32px; border-radius: 10px; display: grid; place-items: center; flex: none;
    background: rgba(var(--wk-rgb),0.15); color: rgb(var(--wk-rgb)); }
  .wk-ic svg { width: 16px; height: 16px; }
  .wk-t { flex-grow: 1; display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .wk-t b { font-size: 14px; font-weight: 600; color: #eef1f6; }
  .wk-t i { font-style: normal; font-size: 11.5px; color: #8a93a8; }
  .wk-row .cch-tg.on { background: #33d17a; box-shadow: 0 0 16px rgba(51,209,122,0.35); }   /* --cch-ok only exists inside the Coach tab */
  .wk-acts { display: flex; gap: 8px; margin-top: 14px; }
  .wk-acts .pk-btn { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
  .wk-acts .pk-btn svg { width: 16px; height: 16px; }
  .gl-chip svg { width: 14px; height: 14px; flex: none; }

  /* temperature tile: Solo = one gauge beside bed/room + stacked − / +; Dual = a column per side */
  .gl-sides { display: grid; grid-template-columns: minmax(0,1fr); gap: 14px; margin-top: 8px; }
  .gl-temp.dual .gl-sides { grid-template-columns: repeat(2, minmax(0,1fr)); margin-top: 4px; }
  .gl-side { --s-rgb: var(--gl-rgb); --s-acc: var(--gl-acc); --s-hi: var(--gl-hi); --s-lo: #5b605b;
    display: grid; grid-template-columns: minmax(116px, 170px) minmax(0,1fr) auto; align-items: center; gap: 12px; min-width: 0; }
  .gl-side[hidden] { display: none !important; }
  .gl-temp.dual .gl-side { display: flex; flex-direction: column; align-items: stretch; gap: 4px; }
  .gl-temp.dual .gl-side + .gl-side { border-left: 1px solid rgba(255,255,255,0.07); padding-left: 14px; }
  .gl-side-hd { display: none; align-items: center; gap: 7px; height: 26px; padding: 0; background: none; border: none; color: inherit;
    font: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; min-width: 0; }
  .gl-temp.dual .gl-side-hd { display: flex; }
  .gl-side-hd .gl-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--s-acc); box-shadow: 0 0 8px rgba(var(--s-rgb),0.9); }
  .gl-side-hd .gl-name { font-size: 14px; font-weight: 600; color: #c9cdc7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gl-side.active .gl-side-hd .gl-name { color: #fff; }
  .gl-side-hd .gl-word { margin-left: auto; font-size: 11.5px; font-weight: 600; color: var(--s-hi); white-space: nowrap; }
  .gl-temp.dual .gl-side:not(.active) .gl-gauge { opacity: 0.82; }
  .gl-gauge { position: relative; width: 100%; max-width: 170px; aspect-ratio: 170 / 108; cursor: grab; touch-action: none; }
  .gl-temp.dual .gl-gauge { width: 100%; max-width: 150px; margin: 0 auto; }
  .gl-gauge svg { width: 100%; height: 100%; display: block; overflow: visible; }
  .gl-track { fill: none; stroke: rgba(255,255,255,0.08); stroke-width: 12; stroke-linecap: round; }
  .gl-fill { fill: none; stroke-width: 12; stroke-linecap: round; }
  .gl-fillglow { fill: none; stroke: var(--s-acc); stroke-width: 16; stroke-linecap: round; opacity: 0.55; animation: glPulse 3.2s ease-in-out infinite; }
  .gl-s0 { stop-color: var(--s-lo); } .gl-s1 { stop-color: var(--s-hi); }
  .gl-knob { fill: #f5f7fa; }
  .gl-knobglow { fill: var(--s-acc); opacity: 0.55; }
  .gl-side.off .gl-fill, .gl-side.off .gl-fillglow, .gl-side.off .gl-knobglow { opacity: 0.2; animation: none; }
  .gl-side.off .gl-knob { fill: #8d928c; }
  .is-dragging .gl-fillglow { animation: none; }
  @keyframes glPulse { 50% { opacity: 0.3; } }
  .gl-center { position: absolute; left: 0; right: 0; top: 38%; display: flex; flex-direction: column; align-items: center; pointer-events: none; }
  .gl-num { font-size: clamp(30px, 9vw, 38px); font-weight: 300; letter-spacing: -1.5px; line-height: 1; font-variant-numeric: tabular-nums; color: #f2f4f1; }
  .gl-side.off .gl-num { font-size: 26px; color: #8d928c; }
  .gl-temp.dual .gl-num { font-size: 30px; }
  .gl-sub { font-size: 9.5px; font-weight: 600; letter-spacing: 1.5px; text-transform: uppercase; color: #8d928c; margin-top: 3px; }
  .gl-kv { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .gl-temp.dual .gl-kv { display: none; }
  .gl-kv span { display: block; font-size: 12px; color: #8d928c; white-space: nowrap; }
  .gl-kv b { display: block; font-size: clamp(14px, 4.1vw, 17px); font-weight: 300; color: #f2f4f1; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .gl-kv b i { display: block; font-style: normal; font-size: 11.5px; font-weight: 400; color: #8d928c; margin-top: 1px; }
  .v2home.glow .hd-title { font-size: 26px; letter-spacing: -0.6px; }
  @media (max-width: 400px) {
    .v2home.glow .hd-title { font-size: 22px; }
    .v2home.glow .hd-right .side-sel .ss-opt { padding: 6px 11px; }
    .gl-step.circ { width: 46px; height: 46px; }
    .gl-side { grid-template-columns: minmax(108px, 146px) minmax(0,1fr) auto; gap: 10px; }
  }
  .gl-vwait { margin-top: 12px; font-size: 13px; color: #8d928c; }
  .gl-steps { display: flex; flex-direction: column-reverse; align-items: center; gap: 8px; }
  .gl-temp.dual .gl-steps { flex-direction: row; justify-content: space-between; margin-top: 6px; }
  .gl-step.circ { width: 50px; height: 50px; }
  .gl-temp.dual .gl-step.circ { width: 44px; height: 44px; }
  .gl-bednow { display: none; }
  .gl-temp.dual .gl-bednow { display: block; flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; text-align: center; font-size: 12px; color: #8d928c; white-space: nowrap; }
  .gl-temp.dual .gl-steps { gap: 4px; min-width: 0; }
  .gl-temp.dual .gl-step.circ { flex: none; }
  .gl-sides { container-type: inline-size; }
  @container (max-width: 330px) { .gl-temp.dual .gl-step.circ { width: 38px; height: 38px; } .gl-temp.dual .gl-bednow { font-size: 11px; } }

  /* quick actions: three even tiles */
  .v2home.glow .presets.quick { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0,1fr); gap: 8px; margin: 10px 0 0; }
  .v2home.glow .presets.quick .chip { height: 50px; margin: 0; border-radius: 16px; justify-content: center; padding: 0 6px; gap: 6px;
    font-size: 12.5px; font-weight: 600; line-height: 1.15; text-align: center; white-space: normal; color: #e6e9e4;
    background: linear-gradient(180deg, rgba(255,255,255,0.058), rgba(255,255,255,0.018)); border: 1px solid rgba(255,255,255,0.075); }
  .v2home.glow .presets.quick .chip svg { flex: none; margin: 0; }
  .v2home.glow .presets.quick .chip.boost.warm svg { color: #ff9a7e; }
  .v2home.glow .presets.quick .chip.boost.cool svg { color: #8cc0ff; }
  .v2home.glow .presets.quick .chip.boost.warm.on { color: #fff; background: linear-gradient(180deg, rgba(255,138,90,0.22), rgba(255,138,90,0.05));
    border-color: rgba(255,138,90,0.5); box-shadow: 0 0 22px rgba(255,138,90,0.2); }
  .v2home.glow .presets.quick .chip.boost.cool.on { color: #fff; background: linear-gradient(180deg, rgba(95,168,255,0.22), rgba(95,168,255,0.05));
    border-color: rgba(95,168,255,0.5); box-shadow: 0 0 22px rgba(95,168,255,0.2); }
  .v2home.glow .presets.quick .chip.away.on { color: #fff; background: linear-gradient(180deg, rgba(183,155,255,0.22), rgba(183,155,255,0.05));
    border-color: rgba(183,155,255,0.5); }
  .v2home.glow .presets.quick .chip.qa { display: flex; flex-direction: row; flex-wrap: nowrap; align-items: center; height: 56px;
    justify-content: flex-start; gap: 9px; padding: 0 10px; text-align: left; overflow: hidden; }
  .v2home.glow .presets.quick .chip.qa .qa-t { flex: 1 1 auto; }
  .v2home.glow .presets.quick .chip.boost.qa svg, .v2home.glow .presets.quick .chip.away.qa svg { color: inherit; width: 19px; height: 19px; }
  .qa-ic { width: 34px; height: 34px; border-radius: 11px; display: grid; place-items: center; flex: none;
    transition: background .25s, color .25s, box-shadow .25s; }
  .chip.boost.warm .qa-ic { background: rgba(255,138,90,0.15); color: #ff9a7e; }
  .chip.boost.cool .qa-ic { background: rgba(95,168,255,0.15); color: #8cc0ff; }
  .chip.away .qa-ic { background: rgba(183,155,255,0.15); color: #c7b3ff; }
  /* v10.26 Wind down tile: amber badge, a progress hairline while it runs */
  .chip.wind .qa-ic { background: rgba(255,178,92,0.15); color: #ffc27e; }
  .chip.wind.on .qa-ic { background: #ffa94d; color: #fff; box-shadow: 0 0 14px rgba(255,169,77,0.6); }
  .v2home.glow .presets.quick .chip.wind.qa svg { color: inherit; width: 19px; height: 19px; }
  .v2home.glow .presets.quick .chip.wind { position: relative; }
  .v2home.glow .presets.quick .chip.wind.on { color: #fff; background: linear-gradient(180deg, rgba(255,169,77,0.2), rgba(255,169,77,0.05));
    border-color: rgba(255,169,77,0.45); box-shadow: 0 0 22px rgba(255,169,77,0.16); }
  .v2home.glow .presets.quick .chip.wind.on::after { content: ""; position: absolute; left: 0; bottom: 0; height: 2px;
    width: calc(var(--wd, 0) * 1%); background: #ffa94d; border-radius: 0 2px 2px 0; transition: width 1s linear; }
  .v2home.glow.wd > .gl-bg { filter: brightness(calc(1 - var(--wd-dim, 0) * 0.5)); transition: filter 3s ease; }
  .chip.boost.warm.on .qa-ic { background: #ff8a5a; color: #fff; box-shadow: 0 0 14px rgba(255,138,90,0.6); }
  .chip.boost.cool.on .qa-ic { background: #5fa8ff; color: #fff; box-shadow: 0 0 14px rgba(95,168,255,0.6); }
  .chip.away.on .qa-ic { background: #b79bff; color: #fff; box-shadow: 0 0 14px rgba(183,155,255,0.6); }
  .qa-t { display: flex; flex-direction: column; min-width: 0; overflow: hidden; font-size: 12.5px; font-weight: 600; line-height: 1.15; }
  .qa-t small { margin-top: 2px; font-size: 10.5px; font-weight: 500; color: rgba(255,255,255,0.72); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* narrow action row: badge on top, label centred under it — side-by-side has no room for the words.
     A container query on the row itself, so it follows the card's real width (dashboard column,
     kiosk, phone) rather than the viewport. */
  .v2home.glow .presets.quick { container-type: inline-size; }
  @container (max-width: 380px) {
    .v2home.glow .presets.quick .chip.qa { flex-direction: column; align-items: center; justify-content: center; height: 76px; gap: 5px; padding: 6px 4px; text-align: center; }
    .v2home.glow .presets.quick .chip.qa .qa-t { flex: 0 0 auto; align-items: center; max-width: 100%; font-size: 12px; white-space: nowrap; }
    .qa-ic { width: 30px; height: 30px; border-radius: 10px; }
    /* v10.26: four tiles (Wind down added) — labels wrap to two lines instead of clipping */
    .v2home.glow .presets.quick:has(> .chip.qa:nth-child(4)) .chip.qa { height: auto; min-height: 76px; padding: 7px 3px; }
    .v2home.glow .presets.quick:has(> .chip.qa:nth-child(4)) .chip.qa .qa-t { white-space: normal; font-size: 11.5px; line-height: 1.15; }
    .v2home.glow .presets.quick:has(> .chip.qa:nth-child(4)) .qa-ic { width: 28px; height: 28px; }
  }
  /* v10.27: four tiles need the stacked layout well above 380px — a Pro Max row is ~383px and
     each tile is ~90px, which clipped "Heat boost" / "Pre-sleep" / "Wind down" side-by-side */
  @container (min-width: 380.02px) and (max-width: 600px) {
    .v2home.glow .presets.quick:has(> .chip.qa:nth-child(4)) .chip.qa { flex-direction: column; align-items: center; justify-content: center;
      height: auto; min-height: 76px; gap: 5px; padding: 7px 4px; text-align: center; }
    .v2home.glow .presets.quick:has(> .chip.qa:nth-child(4)) .chip.qa .qa-t { flex: 0 0 auto; align-items: center; max-width: 100%;
      white-space: normal; font-size: 12px; line-height: 1.15; }
    .v2home.glow .presets.quick:has(> .chip.qa:nth-child(4)) .qa-ic { width: 30px; height: 30px; border-radius: 10px; }
  }

  /* live vitals — only rendered while someone is in bed */
  .gl-live { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--gl-hi); white-space: nowrap; }
  .gl-live i { width: 7px; height: 7px; border-radius: 50%; background: var(--gl-acc); box-shadow: 0 0 8px rgba(var(--gl-rgb),0.9); animation: glLive 1.6s ease-in-out infinite; }
  @keyframes glLive { 50% { opacity: 0.35; } }
  .gl-v3 { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 14px; margin-top: 10px; }
  .gl-met svg { width: 100%; height: 26px; display: block; overflow: visible; }
  .gl-met b { display: block; margin-top: 6px; font-size: 26px; font-weight: 300; letter-spacing: -0.8px; line-height: 1; font-variant-numeric: tabular-nums; }
  .gl-met b small, .gl-vcol b small { font-size: 12px; font-weight: 400; color: #8d928c; margin-left: 3px; letter-spacing: 0; }
  .gl-met span { display: block; font-size: 12px; color: #8d928c; margin-top: 3px; }
  .gl-v2 { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 14px; margin-top: 8px; }
  .gl-vcol { min-width: 0; }
  .gl-vcol + .gl-vcol { border-left: 1px solid rgba(255,255,255,0.07); padding-left: 14px; }
  .gl-vcol.absent { opacity: 0.55; }
  .gl-vdot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: rgb(var(--gl-rgb)); }
  .gl-vcol.p .gl-vdot, .gl-vcol.p .gl-live i { background: rgb(var(--gl-rgb2)); box-shadow: 0 0 8px rgba(var(--gl-rgb2),0.9); }
  .gl-vcol.p .gl-live { color: #d9ddd6; }
  .gl-vname { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gl-vabs { margin-left: auto; font-size: 11.5px; color: #8d928c; white-space: nowrap; }
  .gl-vhr { display: flex; align-items: center; gap: 7px; margin-top: 10px; }
  .gl-vheart { color: #ff7f95; display: inline-flex; }
  .gl-vhr b { font-size: 26px; font-weight: 300; letter-spacing: -0.8px; line-height: 1; font-variant-numeric: tabular-nums; }
  .gl-vr { display: flex; align-items: baseline; justify-content: space-between; margin-top: 7px; font-size: 13px; color: #8d928c; }
  .gl-vr b { font-weight: 500; color: #e6e9e4; font-variant-numeric: tabular-nums; }

  /* schedule / Autopilot */
  .gl-schsub { font-size: 12px; color: #8d928c; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .gl-aptog { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; background: none; border: none; padding: 0; color: #8d928c;
    font: inherit; font-size: 12.5px; cursor: pointer; -webkit-tap-highlight-color: transparent; flex: none; }
  .v2home.glow .gl-sched .smart-switch.on { box-shadow: 0 0 16px rgba(var(--s-rgb, var(--gl-rgb)),0.45); }
  .v2home.glow .gl-sched .smart-switch.on > .sw-overlay { background: var(--s-acc, var(--gl-acc)); opacity: 0.55; }

  /* v10.41 "boxes: false": the dyson-fan-card language. No glass panels: sections
     sit straight on the glow, split by a hairline that fades out at both ends. Home tab only for now. Controls are bare
     text + icons; ON = accent colour + glow. Only real controls keep a shape: the Solo/Dual pill,
     power, the -/+ rings and switches. Tinted alert/hero tiles keep their tint, lose the frame. */
  .v2home.glow.nobox #viewPod .gl-tile { background: linear-gradient(90deg, transparent, rgba(255,255,255,0.085) 18%, rgba(255,255,255,0.085) 82%, transparent) top / 100% 1px no-repeat;
    border: 0; border-radius: 0; box-shadow: none; -webkit-backdrop-filter: none; backdrop-filter: none; padding: 18px 2px 6px; margin-top: 12px; }
  .v2home.glow.nobox #viewPod .gl-tile.cch-hero, .v2home.glow.nobox #viewPod .gl-tile.slp-banner, .v2home.glow.nobox #viewPod .gl-tile.cch-banner {
    border: 0; box-shadow: none; border-radius: 18px; padding: 14px 14px; }
  .v2home.glow.nobox #viewPod .gl-tile.cch-hero { background: radial-gradient(120% 90% at 50% 0%, rgba(var(--gl-rgb),0.10), transparent 70%); }
  .v2home.glow.nobox #viewPod button.gl-tile:active { background-color: rgba(255,255,255,0.04); }
  /* prime status: one quiet line under the bed */
  .v2home.glow.nobox .prime-bar { background: none; border: 0; -webkit-backdrop-filter: none; backdrop-filter: none; padding: 0 2px; margin: 2px 0 0; min-height: 34px; }
  .v2home.glow.nobox .prime-btn { background: none; border: 0; padding: 6px 2px 6px 10px; color: var(--gl-hi); font-weight: 600; letter-spacing: .2px; }
  .v2home.glow.nobox .prime-btn:hover, .v2home.glow.nobox .prime-btn:active { background: none; color: #fff; }
  .v2home.glow.nobox .prime-btn.cancel { background: none; color: #ff8a7a; }
  /* header pills inside sections become words */
  .v2home.glow.nobox .gl-wake, .v2home.glow.nobox .gl-wake.plain, .v2home.glow.nobox .gl-wake.waking { background: none; padding: 0 2px; }
  .v2home.glow.nobox .gl-wake.waking { text-shadow: 0 0 12px rgba(255,176,32,0.6); animation: none; }
  .v2home.glow.nobox .gl-chip { background: none; padding: 0 2px; }
  /* -/+ keep a hairline ring so they still read as buttons */
  .v2home.glow.nobox .gl-step.circ { background: none; -webkit-backdrop-filter: none; backdrop-filter: none; box-shadow: none;
    border: 1px solid rgba(255,255,255,0.13); color: #dfe3dc; }
  .v2home.glow.nobox .gl-step.circ:active { background: rgba(var(--s-rgb, var(--gl-rgb)),0.16); border-color: rgba(var(--s-rgb, var(--gl-rgb)),0.5); }
  /* quick actions: icon over word, columns split by hairlines */
  .v2home.glow.nobox .presets.quick { gap: 0; margin: 14px 0 0; }
  .v2home.glow.nobox .presets.quick .chip, .v2home.glow.nobox .presets.quick .chip.qa,
  .v2home.glow.nobox .presets.quick .chip.on { background: none; border: 0; border-radius: 0; box-shadow: none;
    flex-direction: column; align-items: center; justify-content: center; text-align: center; height: 66px; min-height: 0; gap: 6px; padding: 4px 4px; color: #c9cdc6; }
  .v2home.glow.nobox .presets.quick .chip { position: relative; }
  .v2home.glow.nobox .presets.quick .chip + .chip::before { content: ""; position: absolute; left: 0; top: 16%; bottom: 16%; width: 1px; background: rgba(255,255,255,0.075); }
  .v2home.glow.nobox .presets.quick .chip .qa-t { flex: 0 0 auto; align-items: center; max-width: 100%; white-space: nowrap; font-size: 12px; font-weight: 600; }
  .v2home.glow.nobox .qa-ic, .v2home.glow.nobox .chip.on .qa-ic { width: 26px; height: 26px; background: none; box-shadow: none; }
  .v2home.glow.nobox .presets.quick .chip .qa-ic svg { width: 21px; height: 21px; }
  .v2home.glow.nobox .chip.boost.warm.on .qa-ic { color: #ff9a7e; filter: drop-shadow(0 0 7px rgba(255,138,90,0.9)); }
  .v2home.glow.nobox .chip.boost.cool.on .qa-ic { color: #8cc0ff; filter: drop-shadow(0 0 7px rgba(95,168,255,0.9)); }
  .v2home.glow.nobox .chip.away.on .qa-ic { color: #c7b3ff; filter: drop-shadow(0 0 7px rgba(183,155,255,0.9)); }
  .v2home.glow.nobox .chip.wind.on .qa-ic { color: #ffc27e; filter: drop-shadow(0 0 7px rgba(255,169,77,0.9)); }
  .v2home.glow.nobox .presets.quick .chip.boost.warm.on { background: none; border: 0; box-shadow: none; color: #ffb59c; text-shadow: 0 0 14px rgba(255,138,90,0.55); }
  .v2home.glow.nobox .presets.quick .chip.boost.cool.on { background: none; border: 0; box-shadow: none; color: #a9d0ff; text-shadow: 0 0 14px rgba(95,168,255,0.55); }
  .v2home.glow.nobox .presets.quick .chip.away.on { background: none; border: 0; box-shadow: none; color: #d8c9ff; text-shadow: 0 0 14px rgba(183,155,255,0.55); }
  .v2home.glow.nobox .presets.quick .chip.wind.on { background: none; border: 0; box-shadow: none; color: #ffd2a0; text-shadow: 0 0 14px rgba(255,169,77,0.55); }
  .v2home.glow.nobox .presets.quick .chip.wind.on::after { left: 22%; width: calc(var(--wd, 0) * 0.56%); border-radius: 2px; }
  .v2home.glow.nobox .presets.quick .chip:active { background: radial-gradient(60% 70% at 50% 50%, rgba(255,255,255,0.07), transparent); }
  .gl-pchips { display: grid; gap: 3px; margin-top: 8px; }
  .gl-pchip { display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 0; padding: 7px 0; border-radius: 12px;
    background: none; border: none; color: inherit; font: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .gl-pchip b { font-size: 16px; font-weight: 300; font-variant-numeric: tabular-nums; color: #d9ddd6; }
  .gl-pchip b.cool { color: #5fa8ff; } .gl-pchip b.warm { color: #ff8a5a; }
  .gl-pchip span { font-size: 9.5px; color: #8d928c; white-space: nowrap; letter-spacing: -0.2px; }
  .gl-pchip.on { background: rgba(255,255,255,0.07); }
  .gl-pchip.on span { color: #f2f4f1; }
  .gl-curve { position: relative; margin-top: 10px; cursor: pointer; }
  .gl-curve svg { width: 100%; height: 54px; display: block; overflow: visible; }
  .gl-cglow { fill: none; stroke: var(--s-acc, var(--gl-acc)); stroke-width: 6; opacity: 0.3; vector-effect: non-scaling-stroke; }
  .gl-cline { fill: none; stroke: var(--s-acc, var(--gl-acc)); stroke-width: 2.2; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; }
  .gl-cnow { position: absolute; width: 9px; height: 9px; margin: -4.5px 0 0 -4.5px; border-radius: 50%; background: #f2f4f1;
    box-shadow: 0 0 0 3px rgba(0,0,0,0.6); }
  .gl-cax { display: flex; justify-content: space-between; gap: 8px; margin-top: 7px; font-size: 11px; color: #8d928c; white-space: nowrap; }
  .gl-why { display: flex; align-items: center; gap: 8px; width: 100%; margin-top: 10px; padding: 10px 0 0; background: none; border: none;
    border-top: 1px solid rgba(255,255,255,0.07); color: #9aa2b6; font: inherit; font-size: 12.5px; text-align: left; cursor: pointer;
    -webkit-tap-highlight-color: transparent; }
  .gl-why[hidden] { display: none; }
  .gl-why .sl-txt { flex: 1 1 auto; min-width: 0; }
  .gl-why b { color: #d7dae0; font-weight: 700; }
  .gl-why .sl-chev { display: inline-flex; color: #6d7178; }
  @media (prefers-reduced-motion: reduce) { .gl-fillglow, .gl-live i { animation: none; } }
`;

/* ==== XRAY HOME BEGIN ==== */
/* =====================================================================================
   v10.42 — `home: xray` (design/home-xray/PROMPT.md). An opt-in Home for layout v2: the bed and
   the Dyson stand on one perspective dot floor drawn on a single canvas, in the dyson-fan-card's
   rim-lit x-ray language (white hairlines on black, edges brightest where they turn away from you,
   far side dimmer). Temperature is the only colour — GLOW_PAL's ember / ice, a neutral grey at the
   pivot — and it shows as light in the floor and on the mattress: a heating side's light swells
   outward and lifts, a cooling side's settles back in toward the bed. The motion is the Roadster
   card's: a sweep line, the floor rising out from the centre, edges drawing themselves in, outlines
   tracing, contents fading up, numbers counting from zero; springs (k100 / c20) for every state
   change; a ripple across the floor on tap. Idle is still: the one rAF loop only runs while
   something moves (boot, a ripple, a spring settling, the fan's air, an active heat/cool flow).
     home: xray          # off unless set; the default Glow Home is untouched
     xray_bed: photo     # photo = the canon photo bed on the x-ray floor | model = the 3D wireframe Pod
     navbar_link: true   # dock liquid-lens-navbar-card small while this Home is up and grow into the
                         # room it frees, moving with the bar as one (as the Media card's app mode)
   Everything else (fan_entity / fan_path, the quick actions, Autopilot, the ids _update drives) is
   the existing card. Only the Home tab changes; Schedule / Autopilot / Settings are as they were.
   ===================================================================================== */
const XR_K = 100, XR_C = 20;
const XR_EASE = "cubic-bezier(0.4, 0, 0.2, 1)";
const xrSpr = (x, e) => ({ x, v: 0, t: x, e: e || 0.001 });
function xrStep(s, dt) {
  let n = Math.max(1, Math.ceil(dt / 0.008));
  const h = dt / n;
  while (n--) { const a = -XR_K * (s.x - s.t) - XR_C * s.v; s.v += a * h; s.x += s.v * h; }
  if (Math.abs(s.x - s.t) < s.e && Math.abs(s.v) < s.e * 20) { s.x = s.t; s.v = 0; return false; }
  return true;
}
const xrClamp = (v, a, b) => Math.max(a, Math.min(b, v));
const xrSm = (a, b, x) => { const t = xrClamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const xrE3 = (t) => 1 - Math.pow(1 - xrClamp(t, 0, 1), 3);
const xrWrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
// at the pivot the bed is neither heating nor cooling: neutral grey, not Glow's lilac (colour = temperature)
const XR_MID = { acc: "#c9ccd2", hi: "#e4e6ea", lo: "#7c8088", rgb: "201,204,210" };
const XR_WHITE = [236, 241, 250];
// world = cm, x right, y up, z toward you. Camera fitted to the photo bed's own foreshortening
// (back edge 0.774 of the front, top depth 0.33 of the width), so both bed options share one floor.
const XR_CAM = { F: 770, pitch: 19.5 * Math.PI / 180 };
// the Pod: a 30 cm mattress on the floor (what es-bed.png is), king-ish, head at the back
const XR_BED = { ax: 84, az: 103, h: 30, r: 9, pipe: 5 };
// the Dyson HP07's model (dyson-fan-card DF_MODEL, units ≈ the render's px), stood beside the head
// of your side like a nightstand fan, aimed down across where you lie
const XR_FAN_S = 0.104;                  // cm per model unit: ~86 cm, a touch under the HP07's real 105 cm so the bed leads
const XR_FAN_AT = { x: -120, z: -104, aim: [-40, -10] };
const XR_FAN = {
  top: 825,
  foot: { r: 126, h: 6, lipR: 116, lipY: 9 },
  profile: [[12, 110], [95, 111], [300, 111], [316, 108], [332, 100], [346, 88], [354, 79]],
  filter: [104, 291],
  cut: { y: 362, k: 0.18, r: 76 },
  btn: 196,
  loop: { cy: 600.5, a: 104, b: 224.5, fcy: 592, fa: 78, fb: 193, hcy: 586.5, ha: 50, hb: 166,
          zf: 92, zt: -50, zb: -62, rf: 6, rb: 54 },
  lcd: { y: 326, z: 102, r: 19 },
};
const XR_FPAL = { cool: { rgb: "95,168,255", fx: "150,204,255" }, heat: { rgb: "255,138,90", fx: "255,116,82" } };
function xrStadium(a, b, t) {
  const st = 2 * (b - a), per = 2 * st + 2 * Math.PI * a;
  let s = t * per;
  if (s < st) return [a, -(b - a) + s, 1, 0];
  s -= st;
  if (s < Math.PI * a) { const q = s / a; return [a * Math.cos(q), b - a + a * Math.sin(q), Math.cos(q), Math.sin(q)]; }
  s -= Math.PI * a;
  if (s < st) return [-a, b - a - s, -1, 0];
  s -= st;
  const q = Math.PI + s / a;
  return [a * Math.cos(q), -(b - a) + a * Math.sin(q), Math.cos(q), Math.sin(q)];
}
// rounded rectangle in plan (half extents ax/az, corner radius r): [x, z, nx, nz] around it
function xrRRect(ax, az, r, nPer) {
  const out = [], q = nPer || 6;
  const corners = [[ax - r, az - r, 0], [-(ax - r), az - r, Math.PI / 2], [-(ax - r), -(az - r), Math.PI], [ax - r, -(az - r), Math.PI * 1.5]];
  // start on the front face (z = +az) heading -x, so index 0 is front-right: draw-in starts at the front
  for (const [cx, cz, a0] of corners) {
    for (let i = 0; i <= q; i++) {
      const a = a0 + (i / q) * (Math.PI / 2);
      out.push([cx + r * Math.cos(a), cz + r * Math.sin(a), Math.cos(a), Math.sin(a)]);
    }
  }
  return out;
}
// superellipse in plan for the pillows (n = 4: soft square)
function xrSuper(ax, az, n, N) {
  const out = [];
  for (let i = 0; i < N; i++) {
    const t = (i / N) * 2 * Math.PI, c = Math.cos(t), s = Math.sin(t);
    const x = ax * Math.sign(c) * Math.pow(Math.abs(c), 2 / n), z = az * Math.sign(s) * Math.pow(Math.abs(s), 2 / n);
    const nx = Math.sign(c) * Math.pow(Math.abs(c), 2 - 2 / n) / ax, nz = Math.sign(s) * Math.pow(Math.abs(s), 2 - 2 / n) / az;
    const l = Math.hypot(nx, nz) || 1;
    out.push([x, z, nx / l, nz / l]);
  }
  return out;
}

const XR_MIXIN = {
  _xrOn() { return !!(this._xr && this._layout === "v2" && this._mode !== "dial"); },
  _xrBedMode() { return String(this._config.xray_bed || "photo").toLowerCase() === "model" ? "model" : "photo"; },   // photo is the default (2026-10-19)

  /* ---------------- the navbar, as one with the card ----------------
     liquid-lens-navbar-card's window protocol (lln-navbar → / ← lln-navbar-state, v1.13). Opening
     the Home docks the bar small (stay, no HUD); the card's bottom edge follows the bar's top, so
     the room it frees goes to the hero. Tap the bar → it springs open and the card springs back
     with it; touch the card → it docks again. The first state event arrives as the bar STARTS to
     dock (still at full size), so the landing is predicted from it (origin bottom-centre: top +
     h·(1 − scale) + offset) and the card moves in the same 500 ms; the landed report corrects it. */
  _xrNavOn() { return !!(this._config && this._xrOn() && this._config.navbar_link !== false); },
  connectedCallback() { if (this._xrNavOn() && this._xrCv) this._xrNavBind(true); },
  disconnectedCallback() { if (this._xrNavFn) this._xrNavBind(false); },
  _xrNavBind(on) {
    if (on) {
      if (this._xrNavFn) return;
      this._xrNavFn = (e) => this._xrNavState((e && e.detail) || {});
      window.addEventListener("lln-navbar-state", this._xrNavFn);
      this._xrNavDown = () => { if (!this._xrNavDocked) this._xrNavDock(); };
      this.addEventListener("pointerdown", this._xrNavDown, true);
      clearTimeout(this._xrNavT);
      // after the view settles; once more in case the footer mounts after this card
      this._xrNavT = setTimeout(() => { this._xrNavDock(true); this._xrNavT = setTimeout(() => { if (!this._xrNavDocked) this._xrNavDock(true); }, 1200); }, 900);
    } else {
      clearTimeout(this._xrNavT);
      window.removeEventListener("lln-navbar-state", this._xrNavFn);
      this.removeEventListener("pointerdown", this._xrNavDown, true);
      this._xrNavFn = this._xrNavDown = null;
      if (this._xrNavDocked) this._xrNavSend("expand");
      this._xrNavDocked = false;
      this._xrNavSet(null);
    }
  },
  _xrNavSend(action, extra) {
    try { window.dispatchEvent(new CustomEvent("lln-navbar", { detail: { action, source: "eight-sleep-card", ...(extra || {}) } })); } catch (_) {}
  },
  _xrNavDock(force) {
    if ((this._xrNavDocked && !force) || !this.isConnected) return;
    this._xrNavAsk = performance.now();
    this._xrNavSend("minimize", { stay: true, scale: 0.66, offset: 12, hud: false });
  },
  _xrNavState(d) {
    const docked = d.state === "minimized";
    const top = Number(d.top);
    if (!docked) { this._xrNavDocked = false; this._xrNavTop0 = null; this._xrNavSet(null); return; }
    const first = !this._xrNavDocked;
    this._xrNavDocked = true;
    if (!(top > 0)) return;
    // the first report comes as the bar starts to move: that's its full-size top
    if (first) this._xrNavTop0 = top;
    let land = top;
    // our own dock: predict the landing so the card moves with the bar, not after it
    if (first && this._xrNavAsk && performance.now() - this._xrNavAsk < 400 && Number(d.height) > 30)
      land = top + (Number(d.height) - 16) * (1 - 0.66) + 12;
    // the card's bottom edge drops exactly as far as the bar's top does, so the gap between them
    // (and the card's own tab bar over it) is the same docked as open
    const base = Number(this._config.bottom_chrome) || 0, drop = Math.max(0, land - (this._xrNavTop0 || land));
    this._xrNavSet(Math.max(0, Math.round(base - drop)));
  },
  // the bottom chrome the card leaves for the footer: config bottom_chrome, or the docked bar's footprint
  _xrNavSet(px) {
    if (this._xrNavBottom === px) return;
    this._xrNavBottom = px;
    const root = this.shadowRoot && this.shadowRoot.getElementById("podRoot");
    if (root) root.classList.toggle("xr-navdock", px != null);
    this._sty(this, "--v2-bottom-chrome", (px != null ? px : (Number(this._config.bottom_chrome) || 0)) + "px");
  },

  /* ---------------- markup ---------------- */
  _xrSideHTML(key, name) {
    let dots = "";
    for (let i = 0; i <= 40; i++) {
      const a = (-100 + i * 5) * Math.PI / 180;
      dots += `<circle class="xr-d" cx="${(85 + 72 * Math.sin(a)).toFixed(1)}" cy="${(88 - 72 * Math.cos(a)).toFixed(1)}" r="1.55"/>`;
    }
    return `
          <div class="xr-side" id="glSide_${key}" data-glside="${key}"${key === "partner" ? " hidden" : ""}>
            <button class="gl-side-hd xr-shd" data-glsel="${key}"><i class="gl-dot"></i><span class="gl-name">${escapeHtml(name)}</span><span class="gl-word" id="glWord_${key}"></span></button>
            <div class="xr-ctl">
              <button class="circ gl-step" data-glbump="-1" data-glside="${key}" aria-label="Cooler">${V2_ICON_MINUS}</button>
              <div class="gl-gauge xr-gauge" data-glside="${key}">
                <svg viewBox="0 0 170 108" aria-hidden="true">
                  <defs><radialGradient id="xrKG_${key}"><stop offset="0" class="xr-kg0"/><stop offset="1" class="xr-kg1"/></radialGradient></defs>
                  <line class="xr-mid" id="xrMid_${key}" x1="85" y1="9" x2="85" y2="3"/>
                  <g id="xrDots_${key}">${dots}</g>
                  <circle class="xr-cur" id="xrCur_${key}" r="3.3" cx="-20" cy="-20"/>
                  <circle class="xr-kglow" id="xrKG2_${key}" r="13" cx="-40" cy="-40" fill="url(#xrKG_${key})"/>
                  <circle class="xr-knob" id="xrKnob_${key}" r="4.4" cx="-40" cy="-40"/>
                </svg>
                <div class="xr-center"><span class="gl-num xr-num" id="glNum_${key}"></span><span class="gl-bednow xr-bed" id="glBedNow_${key}"></span></div>
              </div>
              <button class="circ gl-step" data-glbump="1" data-glside="${key}" aria-label="Warmer">${V2_ICON_PLUS}</button>
            </div>
            <div class="gl-kv" hidden><b id="glBed_${key}"></b><b id="glRoom_${key}"></b></div>
          </div>`;
  },
  _xrHomeHTML(primeBar) {
    const c = this._config, photo = this._xrBedMode() === "photo";
    return `
        <div class="view-pod xr-home" id="viewPod">
        <div class="xr-hero" id="xrHero">
          <canvas class="xr-cv" id="xrCv"></canvas>
          ${photo ? `<div class="xr-photo" id="xrPhoto"><div class="bed-wrap" id="bed"></div></div>` : `<div class="bed-wrap" id="bed" hidden></div>`}
          ${photo && c.fan_entity ? `<canvas class="xr-cv xr-cvtop" id="xrCvTop" aria-hidden="true"></canvas>` : ""}
          <div class="xr-hud xr-tl" id="xrStat"><i class="xr-led"></i><b id="xrStatW"></b><span id="xrStatT"></span></div>
          <div class="xr-hud xr-tr" id="xrRoom"></div>
          <div class="xr-tag" id="xrTag_self" hidden></div>
          <div class="xr-tag" id="xrTag_partner" hidden></div>
          ${c.fan_entity ? `<div class="xr-tag xr-fantag" id="xrFanTag"></div>` : ""}
          ${c.headroom === false ? "" : `<button class="hr-edge" id="hrEdge" hidden aria-label="Cooling headroom">
            <i class="hr-track"></i><i class="hr-fill" id="hrFill"></i><i class="hr-floor"></i>
            <span class="hr-txt"><b id="hrVal"></b><em id="hrWord"></em></span>
          </button>`}
          ${primeBar}
        </div>
        <span class="big-level" id="homeLevel" hidden><span class="bl-main" id="homeLevelMain"></span></span>
        <div class="gl-tile gl-temp xr-temp" id="glTemp">
          <div class="gl-row gl-temp-hd" id="glTempHd"><span class="gl-lbl">Temperature</span>${c.wake_pill === false ? "" : `<button class="gl-wake" id="glWake" hidden aria-label="Wake-up time"></button>`}<span class="gl-chip" id="glState" hidden></span></div>
          <div class="gl-sides xr-sides">${this._xrSideHTML("self", c.own_label || "You")}${c._partnerUi ? this._xrSideHTML("partner", c.partner_name || "Partner") : ""}</div>
        </div>
        <div class="presets quick no-temps" id="podPresets"></div>
        <div class="gl-tile gl-sched" id="smartPanel">
          <div class="gl-row gl-sched-hd">
            <span class="gl-lbl" id="glSchedLbl">Schedule</span>
            <span class="gl-schsub" id="glSchedSub"></span>
            ${c.smart_entity ? `<button class="gl-aptog" id="smpHead" aria-label="Autopilot"><span class="gl-aplbl">Autopilot</span><span class="smp-sug" id="smpSug" hidden></span><span class="smart-switch" id="smpSwitch" role="switch">${SW_GLASS}<span class="sk">${SW_GLASS}</span></span></button>` : ""}
          </div>
          <div class="smp-flash" id="smpFlash" hidden></div>
          <div id="glSchedBody"></div>
          ${c.smart_entity ? `<button class="gl-why" id="smpLine" hidden><span class="sl-txt" id="smpLineTxt"></span><span class="sl-chev">${V2_ICON_CHEVR}</span></button>` : ""}
        </div>
        </div>`;
  },

  /* ---------------- mount (once per build) ---------------- */
  _xrMount() {
    const $ = (id) => this.shadowRoot.getElementById(id);
    const cv = $("xrCv"), hero = $("xrHero");
    if (this._xrRaf) { cancelAnimationFrame(this._xrRaf); this._xrRaf = 0; }
    if (this._xrRO) { try { this._xrRO.disconnect(); } catch (_) {} this._xrRO = null; }
    if (!cv || !hero) return;
    this._xrCv = cv; this._xrCtx = cv.getContext("2d"); this._xrHero = hero;
    // photo bed: the fan + its air ride a thin canvas ABOVE the photo, so the air lands on the bed
    const top = $("xrCvTop");
    this._xrCvTop = top || null; this._xrCtxTop = top ? top.getContext("2d") : null;
    this._xrT0 = performance.now();
    this._xrReduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (!this._xrS) {
      const side = () => ({ lvl: xrSpr(0), on: xrSpr(0), work: xrSpr(0), occ: xrSpr(0), rgb: [201, 204, 210], tr: [201, 204, 210] });
      this._xrS = { hl: side(), hr: side(), fan: { amt: xrSpr(0), lvl: xrSpr(1, 0.01), heat: false, on: false, rev: false, osc: false, span: 0 },
        A: xrSpr(1), ph: 0, wave: 0, sway: 0, swayPh: 0, rev: 1, revT0: 0, revDur: 1500, drain: null, ripples: [],
        g: { self: xrSpr(0.5, 0.0005), partner: xrSpr(0.5, 0.0005) }, V: {} };
    }
    this._xrGeo = null;
    this._xrBuildModel();
    if (window.ResizeObserver) {
      this._xrRO = new ResizeObserver(() => { this._xrLayout(); this._xrKick(); });
      this._xrRO.observe(hero);
    }
    // the floor and the fan take taps; nothing fires for the first second after mount (dyson-fan-card
    // v0.1.1: a phantom input on load once turned the real fan), and synthetic events never do
    let down = null;
    cv.style.touchAction = "manipulation";
    cv.addEventListener("pointerdown", (e) => {
      if (!e.isTrusted || performance.now() - this._xrT0 < 1000) return;
      const r = cv.getBoundingClientRect();                     // once per gesture, never in a move
      down = { x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now(), id: e.pointerId, moved: false, fan: this._xrHitFan(e.clientX - r.left, e.clientY - r.top) };
      if (down.fan && this._config.fan_path) {
        clearTimeout(this._xrHold);
        this._xrHold = setTimeout(() => { if (down && down.fan && !down.moved) { const p = this._config.fan_path; down = null; this._haptic("medium"); this._xrNavigate(p); } }, 560);
      }
    });
    cv.addEventListener("pointermove", (e) => {
      if (!down || e.pointerId !== down.id) return;
      // a scroll / swipe that started on the canvas is not a tap (pure arithmetic, no layout reads)
      if (!down.moved && down.r0 == null) down.r0 = [e.clientX, e.clientY];
      if (down.r0 && Math.hypot(e.clientX - down.r0[0], e.clientY - down.r0[1]) > 9) { down.moved = true; clearTimeout(this._xrHold); }
    });
    const up = (e) => {
      clearTimeout(this._xrHold);
      if (!down || e.pointerId !== down.id) { down = null; return; }
      const d = down; down = null;
      if (d.moved || e.type === "pointercancel") return;
      if (d.fan) { this._xrFanTap(); return; }
      this._xrRipple(d.x, d.y);
    };
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
    // logo → replay the boot (still honours the 8 s rest)
    const logo = this.shadowRoot.querySelector(".v2home.xray .hd-logo");
    if (logo) { logo.style.cursor = "pointer"; logo.addEventListener("click", () => { this._haptic("light"); this._xrBoot(); }); }
    // a control that fires traces its outline once
    const root = $("podRoot");
    if (root) root.addEventListener("click", (e) => {
      if (this._view !== "pod") return;
      const el = e.target.closest(".gl-step, .presets .chip, .smart-switch, .hd-pwr, .side-sel .ss-opt, .prime-btn, .gl-why, .xr-shd, .gl-wake, .gl-pchip");
      if (el) this._xrTrace(el.matches(".side-sel .ss-opt") ? el.parentElement : el);
    }, true);
    document.addEventListener("visibilitychange", this._xrVis || (this._xrVis = () => { if (!document.hidden) this._xrKick(); }));
    this._xrLayout();
    if (this._xrNavOn() && this.isConnected) {
      if (this._xrNavFn) { this._xrNavBind(false); }
      this._xrNavBind(true);
    }
  },
  _xrNavigate(path) {
    if (!path) return;
    try { history.pushState(null, "", path); window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: false } })); } catch (_) {}
  },
  _xrFanTap() {
    const id = this._config.fan_entity, st = id && this._hass && this._hass.states[id];
    if (!st || st.state === "unavailable") return;
    this._haptic("medium");
    this._hass.callService("fan", st.state === "on" ? "turn_off" : "turn_on", { entity_id: id });
  },

  /* ---------------- static geometry ---------------- */
  _xrBuildModel() {
    const B = XR_BED, lines = [];
    const add = (pts, close, b0, rim, glow, zone) => lines.push({ pts, close, b0, rim, glow: !!glow, zone: zone || 0 });
    const norm = (x, y, z) => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };
    // ring around the mattress at height y, inset `ins`, normal = horizontal·h + up·v
    const ring = (ins, y, h, v) => xrRRect(B.ax - ins, B.az - ins, Math.max(2, B.r - ins), 6).map(([x, z, nx, nz]) => { const n = norm(nx * h, v, nz * h); return [x, y, z, n[0], n[1], n[2]]; });
    const P = B.pipe, s45 = Math.SQRT1_2;
    add(ring(0, 0.4, 1, -0.2), true, 0.14, 0.62);                       // floor line
    add(ring(0, 13, 1, 0), true, 0, 0.5);                               // an iso-line that only shows at the rim
    add(ring(0, B.h - P - 2.4, 1, 0), true, 0.05, 0.55);                // the cover's side seam
    add(ring(P * (1 - s45), B.h - P + P * s45, s45, s45), true, 0.03, 0.62, true);
    add(ring(P, B.h, 0.18, 1), true, 0.34, 0.45, true);                 // the top piping: the crisp edge
    // sparse cross-sections round the perimeter, rolling over the top edge
    const base = xrRRect(B.ax, B.az, B.r, 6);
    for (let i = 3; i < base.length; i += 7) {
      const [x, z, nx, nz] = base[i], sec = [];
      sec.push([x, 0.4, z, nx, 0, nz], [x, B.h - P, z, nx, 0, nz]);
      for (let j = 1; j <= 4; j++) {
        const ps = (j / 4) * (Math.PI / 2), ins = P * (1 - Math.cos(ps)), y = B.h - P + P * Math.sin(ps);
        const n = norm(nx * Math.cos(ps), Math.sin(ps), nz * Math.cos(ps));
        sec.push([x - nx * ins, y, z - nz * ins, n[0], n[1], n[2]]);
      }
      add(sec, false, 0.04, 0.3);
    }
    // the zone seam down the middle of the cover (Dual's two water circuits)
    add([[0, B.h + 0.2, B.az - 8, 0, 1, 0], [0, B.h + 0.2, 0, 0, 1, 0], [0, B.h + 0.2, -(B.az - 8), 0, 1, 0]], false, 0.12, 0, false, 9);
    // the cover's tag on the front-left face
    const tg = [];
    for (let i = 0; i < 12; i++) { const q = xrStadium(3.2, 5.6, i / 12); tg.push([-68 + q[0], 20 + q[1], B.az + 0.3, 0, 0, 1]); }
    add(tg, true, 0.3, 0.2, true);
    // pillows: soft superellipse loaves at the head
    const prof = [[0.9, 0], [1, 0.32], [0.93, 0.68], [0.6, 0.95], [0.18, 1]];
    for (const px of [-41, 41]) {
      const plan = xrSuper(30, 16, 4.2, 40), zc = -B.az + 25, H = 16;
      prof.forEach(([sc, hy], k) => {
        if (sc < 0.25) return;
        const dy = k === 0 ? -0.3 : k === prof.length - 1 ? 1 : (prof[k + 1][1] - prof[k - 1][1]);
        const dr = k === 0 ? 1 : k === prof.length - 1 ? -1 : -(prof[k + 1][0] - prof[k - 1][0]);
        add(plan.map(([x, z, nx, nz]) => { const n = norm(nx * dy, dr * 0.6, nz * dy); return [px + x * sc, B.h + hy * H, zc + z * sc, n[0], n[1], n[2]]; }),
          true, k === 1 ? 0.05 : 0.02, 0.7, k === 1, px < 0 ? -1 : 1);
      });
    }
    lines.forEach((L) => { if (!L.zone) { let sx = 0; L.pts.forEach((p) => { sx += p[0]; }); sx /= L.pts.length; L.zone = sx < -6 ? -1 : sx > 6 ? 1 : 0; } if (L.zone === 9) L.zone = 0; });
    // the cover's thermal surface: a dot field per half (the Tide), at the top
    const mdots = [];
    let mrow = 0;
    for (let z = -B.az + 8; z <= B.az - 6; z += 10.5, mrow++) {
      for (let x = -B.ax + 7 + (mrow % 2) * 3.3; x <= B.ax - 6; x += 6.6) {
        if (Math.abs(x) < 3) continue;
        const pil = z < -B.az + 44 && Math.abs(Math.abs(x) - 41) < 32;
        mdots.push({ x, z, side: x < 0 ? -1 : 1, pil });
      }
    }
    // a faint dot skin on the cover's sides, so the block reads solid (the fan's shroud does the same)
    const sdots = [];
    for (let y = 4; y <= B.h - P - 4; y += 5.5) {
      for (let x = -B.ax + B.r; x <= B.ax - B.r; x += 7) sdots.push({ x, y, z: B.az + 0.2, n: [0, 0, 1] });
      for (let z = -B.az + B.r; z <= B.az - B.r; z += 8) { sdots.push({ x: B.ax + 0.2, y, z, n: [1, 0, 0] }); sdots.push({ x: -B.ax - 0.2, y, z, n: [-1, 0, 0] }); }
    }
    // the floor: one even staggered grid (wider in depth so it reads as a floor), not under the bed
    const fdots = [];
    let row = 0;
    for (let z = -300; z <= 340; z += 10.5, row++) {
      for (let x = -360; x <= 360; x += 8.5) {
        const xx = x + (row % 2) * 4.25;
        const ox = Math.max(0, Math.abs(xx) - B.ax), oz = Math.max(0, Math.abs(z) - B.az);
        const de = Math.hypot(ox, oz);                               // distance from the mattress edge
        if (de < 5) continue;
        const fx = xx - XR_FAN_AT.x, fz = z - XR_FAN_AT.z;
        const fr = Math.hypot(fx, fz);
        if (this._config.fan_entity && fr < 24) continue;            // under the fan's foot
        fdots.push({ x: xx, z, de, side: xx < 0 ? -1 : 1, r0: Math.hypot(xx * 0.8, z), fr, fth: Math.atan2(fx, fz) });
      }
    }
    this._xrM = { lines, mdots, sdots, fdots };
    this._xrFanM = this._config.fan_entity ? this._xrBuildFan() : null;
  },
  _xrBuildFan() {
    const M = XR_FAN, L = M.loop, N = 72;
    const unit = [];
    for (let i = 0; i < 48; i++) { const a = (i / 48) * 2 * Math.PI; unit.push([Math.sin(a), Math.cos(a)]); }
    const st = (a, b, cy) => { const out = []; for (let i = 0; i < N; i++) { const q = xrStadium(a, b, i / N); out.push([q[0], cy + q[1], q[2], q[3]]); } return out; };
    const outer = st(L.a, L.b, L.cy), front = st(L.fa, L.fb, L.fcy), hole = st(L.ha, L.hb, L.hcy);
    const mid = front.map((q, i) => q.map((v, j) => (v + hole[i][j]) / 2));
    const dots = [];
    let row = 0;
    for (let y = M.filter[0]; y <= M.filter[1]; y += 12, row++) {
      for (let j = 0; j < 30; j++) {
        const ang = ((j + (row % 2) * 0.5) / 30) * 2 * Math.PI;
        if (Math.abs(Math.abs(Math.sin(ang)) - 1) < 0.02) continue;
        dots.push([Math.sin(ang), Math.cos(ang), y]);
      }
    }
    const lcd = [], btn = [];
    for (let i = 0; i < 20; i++) { const a = (i / 20) * 2 * Math.PI; lcd.push([M.lcd.r * Math.cos(a), M.lcd.r * Math.sin(a)]); }
    for (let i = 0; i < 14; i++) { const q = xrStadium(5.5, 15, i / 14); btn.push([q[0], q[1]]); }
    return { unit, outer, front, hole, mid, dots, lcd, btn };
  },

  /* ---------------- projection + layout ---------------- */
  // world (cm) → [sx, sy, s, depth]; depth > 0 = toward you
  _xrP(x, y, z) {
    const G = this._xrGeo, cp = G.cp, sp = G.sp;
    const u = y * cp - z * sp, d = y * sp + z * cp, s = XR_CAM.F / (XR_CAM.F - d);
    return [G.cx + x * G.k * s, G.cy - u * G.k * s, s, d];
  },
  _xrLayout() {
    const hero = this._xrHero, cv = this._xrCv;
    if (!hero || !cv) return false;
    const W = hero.clientWidth, H = hero.clientHeight;
    if (W < 60 || H < 60) return false;
    const fan = !!this._xrFanM;
    const cp = Math.cos(XR_CAM.pitch), sp = Math.sin(XR_CAM.pitch);
    // fit bed (+ fan) into the hero with room for the HUD above and the prime line below
    this._xrGeo = { W, H, k: 1, cx: 0, cy: 0, cp, sp };
    const pts = [];
    const B = XR_BED;
    for (const x of [-B.ax, B.ax]) for (const z of [-B.az, B.az]) for (const y of [0, B.h]) pts.push(this._xrP(x, y, z));
    pts.push(this._xrP(0, B.h + 14, -B.az + 8));
    // the photo bed reaches past the model's mattress corners (its rolled edges + shadow): frame that too
    if (this._xrBedMode() === "photo") for (const x of [-B.ax * 1.2, B.ax * 1.2]) pts.push(this._xrP(x, 0, B.az + 6));
    if (fan) for (const y of [0, XR_FAN.top * XR_FAN_S]) for (const dx of [-17, 17]) pts.push(this._xrP(XR_FAN_AT.x + dx, y, XR_FAN_AT.z));
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const p of pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    const padT = 30, padB = 62, padX = 22;
    // the bed sits dead centre; the fan tucks in beside it, so the frame is symmetric about the bed
    const half = Math.max(-x0, x1);
    const k = Math.min((W / 2 - padX) / half, (H - padT - padB) / (y1 - y0));
    const G = this._xrGeo;
    G.k = k;
    G.cx = W / 2;
    G.cy = padT + (H - padT - padB) / 2 - ((y0 + y1) / 2) * k;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    G.dpr = dpr;
    const bw = Math.round(W * dpr), bh = Math.round(H * dpr);
    for (const c of [cv, this._xrCvTop]) if (c && (c.width !== bw || c.height !== bh)) { c.width = bw; c.height = bh; }
    // the photo bed: its mattress front corners onto the model's
    const ph = this.shadowRoot.getElementById("xrPhoto");
    if (ph) {
      const L = this._xrP(-B.ax, B.h, B.az), R = this._xrP(B.ax, B.h, B.az);
      const pw = (R[0] - L[0]) / (0.8488 - 0.1419);
      const img = ph.querySelector(".bed-img");
      const asp = img && img.naturalWidth ? img.naturalHeight / img.naturalWidth : 0.5625;
      Object.assign(ph.style, { left: (L[0] - 0.1419 * pw).toFixed(1) + "px", top: (L[1] - 0.534 * pw * asp).toFixed(1) + "px", width: pw.toFixed(1) + "px" });
      if (img && !img.__xr) { img.__xr = 1; img.addEventListener("load", () => this._xrLayout()); }
    }
    // tags on the floor in front of each half, the fan's under its foot, the headroom bar on the right flank
    const place = (el, p, dy) => { if (el) { el.style.left = p[0].toFixed(1) + "px"; el.style.top = (p[1] + (dy || 0)).toFixed(1) + "px"; } };
    const own = this._config.own_side === "right" ? 1 : -1;
    G.tagSelf = this._xrP(own * 46, 0, B.az + 30);
    G.tagPartner = this._xrP(-own * 46, 0, B.az + 30);
    G.tagSolo = this._xrP(0, 0, B.az + 30);
    if (fan) {
      const fp = this._xrP(XR_FAN_AT.x, 0, XR_FAN_AT.z + 26);
      place(this.shadowRoot.getElementById("xrFanTag"), fp, 0);
      const top = this._xrP(XR_FAN_AT.x, XR_FAN.top * XR_FAN_S, XR_FAN_AT.z), foot = this._xrP(XR_FAN_AT.x, 0, XR_FAN_AT.z);
      const hw = 20 * k * foot[2];
      G.fanHit = [foot[0] - hw, top[1] - 6, foot[0] + hw, foot[1] + 14];
    } else G.fanHit = null;
    const hr = this.shadowRoot.getElementById("hrEdge");
    if (hr) {
      const a = this._xrP(B.ax + 8, B.h, -B.az * 0.55), b = this._xrP(B.ax + 8, 0, B.az * 0.35);
      Object.assign(hr.style, { left: a[0].toFixed(1) + "px", top: a[1].toFixed(1) + "px", height: Math.max(40, b[1] - a[1]).toFixed(1) + "px" });
    }
    this._xrPlaceTags();
    G.horizon = this._xrP(0, 0, 0)[1];
    return true;
  },
  _xrPlaceTags() {
    const G = this._xrGeo;
    if (!G) return;
    const dual = this._xrDual;
    const s = this.shadowRoot.getElementById("xrTag_self"), p = this.shadowRoot.getElementById("xrTag_partner");
    const at = (el, q) => { if (el && q) { el.style.left = q[0].toFixed(1) + "px"; el.style.top = q[1].toFixed(1) + "px"; } };
    at(s, dual ? G.tagSelf : G.tagSolo);
    at(p, G.tagPartner);
    // two tags that would touch drop their detail ("in bed", bpm) and keep the names
    if (this._xrHero) this._xrHero.classList.toggle("xr-tight", dual && Math.abs(G.tagSelf[0] - G.tagPartner[0]) < 150);
  },
  _xrHitFan(x, y) {
    const G = this._xrGeo, h = G && G.fanHit;
    return !!h && x >= h[0] && x <= h[2] && y >= h[1] && y <= h[3];
  },
  _xrRipple(sx, sy) {
    const G = this._xrGeo;
    if (!G) return;
    // the floor point under the finger: ray onto y = 0
    const cp = G.cp, sp = G.sp, F = XR_CAM.F;
    const X = (sx - G.cx) / G.k, Yv = -(sy - G.cy) / G.k;          // = x·s and u·s
    // u = -z·sp, d = z·cp, s = F / (F - d)  →  Yv = -z·sp·F/(F - z·cp)
    const z = (Yv * F) / (Yv * cp - sp * F);
    const s = F / (F - z * cp), x = X / s;
    if (!Number.isFinite(z) || Math.abs(z) > 420 || Math.abs(x) > 460) return;
    const S = this._xrS;
    S.ripples.push({ x, z, t0: performance.now() });
    if (S.ripples.length > 4) S.ripples.shift();
    this._haptic("light");
    this._xrKick();
  },

  /* ---------------- state → scene (every hass tick, from _renderGlow) ---------------- */
  _xrRender(dual, vs, vp, ps, pp) {
    const $ = (id) => this.shadowRoot.getElementById(id);
    const S = this._xrS;
    if (!S || !this._xrCv) return;
    const c = this._config, H = this._hass.states;
    this._xrDual = dual;
    const root = $("podRoot");
    if (root) root.classList.toggle("xr-off", !(vs.on || (vp && vp.on)));
    const own = c.own_side === "right" ? 1 : -1;
    // scene targets per bed half (x < 0 = left). Solo = the whole bed tracks your side.
    const halves = { [own]: vs, [-own]: dual ? vp : vs };
    const pals = { [own]: ps, [-own]: dual ? pp : ps };
    const mid = this._midTemp(), { min, max } = this._range();
    const sig = [];
    [-1, 1].forEach((h) => {
      const v = halves[h], p = pals[h], T = h < 0 ? S.hl : S.hr;   // S.hl = the LEFT half's springs, S.hr = right
      const span = v.tgt >= mid ? (max - mid) : (mid - min);
      const inten = span > 0 ? Math.pow(Math.min(1, Math.abs(v.tgt - mid) / span), 0.6) : 0;
      const signed = !v.on ? 0 : v.dir === "warm" ? Math.max(0.3, inten) : v.dir === "cool" ? -Math.max(0.3, inten) : 0;
      T.lvl.t = signed; T.on.t = v.on ? 1 : 0; T.work.t = v.on && v.working ? 1 : 0;
      const ent = (h === own) ? c.entity : (dual ? c.partner_climate_entity : c.entity);
      T.occ.t = this._presenceOn(ent) || (!dual && this._presenceOn(c.partner_climate_entity)) ? 1 : 0;
      T.tr = p.rgb.split(",").map(Number);
      T.dir = v.dir;
      sig.push(signed.toFixed(2), T.on.t, T.work.t, T.occ.t, p.rgb);
    });
    // the fan
    const F = S.fan, fe = c.fan_entity && H[c.fan_entity];
    if (fe) {
      const A = fe.attributes || {};
      const oid = c.fan_entity.split(".")[1];
      const cl = H[c.fan_climate_entity || `climate.${oid}`];
      F.on = fe.state === "on";
      F.avail = fe.state !== "unavailable" && fe.state !== "unknown";
      F.heat = cl ? cl.state === "heat" : A.preset_mode === "heat";
      F.auto = A.preset_mode === "auto";
      F.rev = A.direction === "reverse";
      F.osc = A.oscillating === true;
      const lo = Number(A.angle_low), hi = Number(A.angle_high);
      F.span = F.osc && Number.isFinite(lo) && Number.isFinite(hi) ? Math.max(0, hi - lo) : 0;
      const pct = Number(A.percentage);
      F.lvl.t = xrClamp(Math.round((Number.isFinite(pct) && pct > 0 ? pct : 10) / 10), 1, 10);
      F.amt.t = F.on && F.avail ? 1 : 0;
      const tag = $("xrFanTag");
      if (tag) {
        const txt = !F.avail ? "Fan offline" : !F.on ? "Fan off" : F.auto ? "Auto" : (F.heat ? "Heat " : "Cool ") + F.lvl.t;
        if (tag.textContent !== txt) tag.textContent = txt;
        tag.className = "xr-tag xr-fantag" + (F.on ? (F.heat ? " heat" : " cool") : "");
      }
      sig.push(F.on, F.heat, F.lvl.t, F.span, F.rev);
    }
    // standby: the same layout, dimmed — never hidden
    const podOn = !!(vs.on || (vp && vp.on));
    S.A.t = podOn ? 1 : 0.42;
    sig.push(podOn);
    // HUD: what the controlled side is doing, the room, the floor tags
    const vpAct = this._viewingPartner() && vp ? vp : vs, pAct = this._viewingPartner() && vp ? pp : ps;
    const who = dual ? (this._viewingPartner() ? (c.partner_name || "Partner") : (c.own_label || "You")) + " · " : "";
    let w = "", t = "";
    const boost = this._boostActive(this._activeEntity());
    if (!podOn) { w = "Pod off"; t = " · standby"; }
    else if (!vpAct.on) { w = who + "Off"; t = ""; }
    else if (boost) { w = boost.dir === "warm" ? "Heat boost" : "Pre-cool"; t = ` · ${this._boostRemainingLabel(boost)} left`; }
    else if (vpAct.working) {
      w = this._glWord(vpAct);
      const eta = String(this._etaText() || "").replace(/\s*to target/i, "").replace(/\s*\(est\.\)/i, "");
      t = ` to ${this._fmtVal(vpAct.tgt)}${eta ? " · " + eta : ""}`;
    } else { w = "Holding"; t = ` ${this._fmtVal(vpAct.tgt)}`; }
    const sw = $("xrStatW"), stt = $("xrStatT"), st = $("xrStat");
    if (podOn && vpAct.on) w = who + w;
    if (sw && sw.textContent !== w) sw.textContent = w;
    if (stt && stt.textContent !== t) stt.textContent = t;
    if (st) { this._sty(st, "--h-acc", pAct.acc); this._sty(st, "--h-rgb", pAct.rgb); }
    let rm = this._glRoomText();
    if (!rm && c.headroom_room_entity) { const v = parseFloat((H[c.headroom_room_entity] || {}).state); if (Number.isFinite(v)) rm = { t: `${Math.round(v)}\u00b0`, h: "" }; }
    const rEl = $("xrRoom");
    if (rEl) { const txt = rm ? `Room ${rm.t}${rm.h ? " · " + rm.h : ""}` : ""; if (rEl.textContent !== txt) rEl.textContent = txt; }
    this._xrTags(dual, vs, vp, ps, pp);
    // the gauges: lit dots from the pivot to the target, a ring at the bed's own temperature
    [["self", vs, ps], ["partner", vp, pp]].forEach(([key, v, p]) => { if (v) this._xrSetGauge(key, v, p); });
    // power: on → off runs the boot backwards into standby; off → on wakes it with the boot
    if (this._xrPodOn === true && !podOn) this._xrShutdown();
    else if (this._xrPodOn === false && podOn) this._xrBoot();
    this._xrPodOn = podOn;
    if (!this._xrGeo) this._xrLayout();
    if (!this._xrBooted && this._view === "pod" && this._xrGeo) { this._xrBooted = true; this._xrBoot(true); }
    const sg = sig.join("|");
    if (sg !== this._xrSig) { this._xrSig = sg; this._xrKick(); }
    else if (!this._xrDrawn) this._xrKick();
  },
  _xrTags(dual, vs, vp, ps, pp) {
    const c = this._config, S = this._hass.states;
    const vit = (p) => {
      const pe = c[p + "presence_entity"], st = pe && S[pe];
      if (!st || st.state !== "on") return null;
      const hr = parseFloat((S[c[p + "heart_rate_entity"]] || {}).state);
      return Number.isFinite(hr) && hr > 0 ? `${Math.round(hr)} bpm` : "In bed";
    };
    const set = (id, show, html, rgb) => {
      const el = this.shadowRoot.getElementById(id);
      if (!el) return;
      el.hidden = !show;
      if (show && el.__h !== html) { el.__h = html; el.innerHTML = html; }
      if (rgb) this._sty(el, "--t-rgb", rgb);
    };
    if (dual) {
      const a = vit(""), b = vit("partner_");
      set("xrTag_self", true, `<b>${escapeHtml(c.own_label || "You")}</b>${a ? `<span>${escapeHtml(a)}</span>` : ""}`, ps.rgb);
      set("xrTag_partner", true, `<b>${escapeHtml(c.partner_name || "Partner")}</b>${b ? `<span>${escapeHtml(b)}</span>` : ""}`, pp.rgb);
    } else {
      const a = vit("") || (c.partner_presence_entity ? vit("partner_") : null);
      set("xrTag_self", !!a, `<span>${escapeHtml(a || "")}</span>`, ps.rgb);
      set("xrTag_partner", false, "");
    }
    this._xrPlaceTags();
  },
  _xrSetGauge(key, v, p) {
    const S = this._xrS, g = S.g[key];
    const el = this.shadowRoot.getElementById("glSide_" + key);
    if (!el || !g) return;
    g.on = v.on; g.cur = v.cur; g.mid = this._frac(this._midTemp());
    g.t = this._frac(v.tgt);
    if (this._xrDragging && (key === "partner") === this._viewingPartner()) { g.x = g.t; g.v = 0; }
    this._xrNum("n_" + key, v.on ? v.tgt : null);
    this._xrPaintGauge(key);
  },
  _xrDragPaint(key, v) {
    const S = this._xrS, g = S && S.g[key];
    if (!g) return;
    g.t = g.x = this._frac(v); g.v = 0; g.on = true;
    const o = S.V["n_" + key];
    if (o) { o.t = o.x = v; o.na = false; o.v = 0; }
    this._xrPaintGauge(key);
    this._xrPaintNum("n_" + key);
  },
  // the dotted arc: 41 dots over ±100°, lit from the pivot to the target in the side's colour
  _xrPaintGauge(key) {
    const S = this._xrS, g = S.g[key];
    const dots = this.shadowRoot.getElementById("xrDots_" + key);
    if (!dots) return;
    const kids = dots.children, n = kids.length;
    const f = xrClamp(g.x, 0, 1), m = g.mid != null ? g.mid : 0.5;
    const lo = Math.min(f, m), hi = Math.max(f, m), on = g.on !== false;
    const sig = `${f.toFixed(3)}|${m.toFixed(3)}|${on}|${Number.isFinite(g.cur) ? this._frac(g.cur).toFixed(3) : "-"}`;
    if (g.__p === sig) return;
    g.__p = sig;
    for (let i = 0; i < n; i++) {
      const fi = i / (n - 1);
      const lit = on && fi >= lo - 0.001 && fi <= hi + 0.001 && hi - lo > 0.004;
      const near = lit ? 1 - Math.abs(f - fi) / Math.max(0.05, hi - lo) : 0;
      const op = lit ? (0.42 + 0.58 * Math.pow(Math.max(0, near), 1.4)).toFixed(2) : "";
      const e = kids[i];
      if (e.__l !== lit) { e.__l = lit; e.setAttribute("class", lit ? "xr-d on" : "xr-d"); }
      if (e.__o !== op) { e.__o = op; if (op) e.setAttribute("fill-opacity", op); else e.removeAttribute("fill-opacity"); }
    }
    const pol = (fr, r) => { const a = (-100 + fr * 200) * Math.PI / 180; return [85 + r * Math.sin(a), 88 - r * Math.cos(a)]; };
    const [kx, ky] = pol(f, 72);
    for (const id of ["xrKnob_", "xrKG2_"]) { const k = this.shadowRoot.getElementById(id + key); if (k) { k.setAttribute("cx", kx.toFixed(1)); k.setAttribute("cy", ky.toFixed(1)); } }
    const cur = this.shadowRoot.getElementById("xrCur_" + key);
    if (cur) {
      if (Number.isFinite(g.cur)) { const [cx, cy] = pol(this._frac(g.cur), 72); cur.setAttribute("cx", cx.toFixed(1)); cur.setAttribute("cy", cy.toFixed(1)); }
      else { cur.setAttribute("cx", "-20"); cur.setAttribute("cy", "-20"); }
    }
    const md = this.shadowRoot.getElementById("xrMid_" + key);
    if (md) { const [a, b] = pol(m, 79), [c2, d] = pol(m, 85); md.setAttribute("x1", a.toFixed(1)); md.setAttribute("y1", b.toFixed(1)); md.setAttribute("x2", c2.toFixed(1)); md.setAttribute("y2", d.toFixed(1)); }
  },
  // counters: spring to their value; the boot sets them to 0 so they count up (Roadster _V)
  _xrNum(k, t) {
    const S = this._xrS;
    let o = S.V[k];
    const na = t == null || !Number.isFinite(t);
    if (!o) { o = S.V[k] = { x: na ? 0 : t, v: 0, t: na ? 0 : t, na, e: 0.01 }; this._xrPaintNum(k); return; }
    const wasNa = o.na;
    o.na = na;
    if (!na) { if (wasNa) { o.x = t; o.v = 0; } if (o.t !== t) { o.t = t; this._xrKick(); } }
    if (na || wasNa) this._xrPaintNum(k);
  },
  _xrPaintNum(k) {
    const o = this._xrS.V[k], el = this.shadowRoot.getElementById(k.startsWith("n_") ? "glNum_" + k.slice(2) : k);
    if (!o || !el) return;
    const txt = o.na ? "Off" : this._fmtVal(o.x);
    if (el.textContent !== txt) el.textContent = txt;
  },

  /* ---------------- the loop ---------------- */
  _xrKick() {
    if (this._xrRaf || !this._xrCv) return;
    this._xrLast = 0;
    this._xrRaf = requestAnimationFrame((t) => this._xrFrame(t));
  },
  _xrFrame(ts) {
    this._xrRaf = 0;
    if (!this.isConnected || !this._xrCv || !this._xrCv.isConnected) return;
    if (this._view !== "pod" || document.hidden) return;          // a hidden Home costs nothing
    if (!this._xrGeo && !this._xrLayout()) return;
    const S = this._xrS, R = this._xrReduce;
    const dt = this._xrLast ? Math.min(0.05, (ts - this._xrLast) / 1000) : 1 / 60;
    this._xrLast = ts;
    let busy = false;
    const springs = [S.A, S.fan.amt, S.fan.lvl, S.hl.lvl, S.hl.on, S.hl.work, S.hl.occ, S.hr.lvl, S.hr.on, S.hr.work, S.hr.occ];
    for (const s of springs) {
      if (R) { s.x = s.t; s.v = 0; continue; }
      if (xrStep(s, dt)) busy = true;
    }
    // colours ease toward their side's palette (springs on each channel would ring through other hues)
    for (const T of [S.hl, S.hr]) {
      for (let i = 0; i < 3; i++) {
        const d = T.tr[i] - T.rgb[i];
        if (Math.abs(d) > 0.5 && !R) { T.rgb[i] += d * (1 - Math.exp(-dt * 6)); busy = true; } else T.rgb[i] = T.tr[i];
      }
    }
    for (const key of ["self", "partner"]) {
      const g = S.g[key];
      if (R || this._xrDragging) { if (g.x !== g.t) { g.x = g.t; g.v = 0; } }
      else if (xrStep(g, dt)) busy = true;
      this._xrPaintGauge(key);
    }
    for (const k in S.V) {
      const o = S.V[k];
      if (o.na) continue;
      if (R) { o.x = o.t; o.v = 0; } else if (xrStep(o, dt)) busy = true;
      this._xrPaintNum(k);
    }
    // the reveal (boot) and the drain (power-off)
    const now = performance.now();
    if (S.rev < 1) { S.rev = xrClamp((now - S.revT0) / S.revDur, 0, 1); busy = true; }
    if (S.drain) {
      const k = xrClamp((now - S.drain.t0) / S.drain.dur, 0, 1);
      S.drainK = k;
      busy = true;
      if (k >= 1) { S.drain = null; S.drainK = 0; S.rev = 0; S.revT0 = now; S.revDur = 900; }   // standby floor comes back, dim
    }
    S.ripples = S.ripples.filter((r) => now - r.t0 < 2600);
    if (S.ripples.length) busy = true;
    // flows: a working side's light moves, the fan's air moves; holding and off are still
    const flowing = !R && (S.hl.work.x > 0.02 || S.hr.work.x > 0.02);
    if (flowing) { S.ph += dt; busy = true; }
    const F = S.fan;
    if (this._xrFanM && !R && F.amt.x > 0.01) {
      S.wave += dt * (0.25 + F.lvl.x * 0.075);
      if (F.osc && F.span > 0) S.swayPh += dt / (6 + F.span / 15);
      busy = true;
    }
    const swayT = F.osc && F.span > 0 && F.on ? Math.min(28, F.span / 2) * Math.sin(S.swayPh * 2 * Math.PI) : 0;
    S.sway += (swayT - S.sway) * (1 - Math.exp(-dt * 4));
    try { this._xrDraw(now); this._xrDrawn = true; }
    catch (err) { if (!this._xrErr) { this._xrErr = true; console.error("eight-sleep-card xray draw", err); } }
    if (busy) this._xrKick();
  },

  /* ---------------- drawing ---------------- */
  _xrDraw(now) {
    const G = this._xrGeo, ctx = this._xrCtx, S = this._xrS, M = this._xrM;
    if (!G || !ctx || !M) return;
    ctx.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, G.W, G.H);
    const ctxF = this._xrCtxTop || ctx;
    if (ctxF !== ctx) { ctxF.setTransform(G.dpr, 0, 0, G.dpr, 0, 0); ctxF.globalCompositeOperation = "source-over"; ctxF.globalAlpha = 1; ctxF.clearRect(0, 0, G.W, G.H); }
    const A = S.A.x * (S.drain ? 1 - xrE3(S.drainK) * 0.85 : 1);
    if (A < 0.01) return;
    const rev = S.rev, R = 400, rr = rev * R * 1.25;
    // power-off: the floor drains back into the middle
    const drainR = S.drain ? R * 1.25 * (1 - xrE3(S.drainK)) : Infinity;
    const L = S.hl, Rh = S.hr;                 // left / right halves
    const sideOf = (s) => (s < 0 ? L : Rh);
    const ph = S.ph;
    const bandPos = (T, speed, off) => { const u = ((ph * speed + off) % 1 + 1) % 1; return [u, Math.sin(Math.PI * u)]; };
    const rgbS = (a) => `${Math.round(a[0])},${Math.round(a[1])},${Math.round(a[2])}`;
    const fan = this._xrFanM ? S.fan : null, famt = fan ? fan.amt.x : 0;
    const fpal = fan && fan.heat ? XR_FPAL.heat : XR_FPAL.cool;
    const yaw = Math.atan2(XR_FAN_AT.aim[0] - XR_FAN_AT.x, XR_FAN_AT.aim[1] - XR_FAN_AT.z) + S.sway * Math.PI / 180;
    const beam = yaw + (fan && fan.rev ? Math.PI : 0);
    const flvl = fan ? fan.lvl.x : 1;
    // ---- 0 · a soft pool of each half's light on the floor (the glow the dots sit in) ----
    if (rev > 0.3) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (const h of [-1, 1]) {
        const T = sideOf(h), amt = T.on.x * (0.35 + 0.65 * Math.abs(T.lvl.x)) * A * xrSm(0.3, 0.9, rev) * (S.drain ? 1 - xrE3(S.drainK) : 1);
        if (amt < 0.01) continue;
        const c0 = this._xrP(h * 46, 0, 10), ex = this._xrP(h * 46 + 120, 0, 10), ez = this._xrP(h * 46, 0, 150);
        const rx = Math.abs(ex[0] - c0[0]), ry = Math.max(8, Math.abs(ez[1] - c0[1]));
        ctx.save();
        ctx.translate(c0[0], c0[1]); ctx.scale(1, ry / rx);
        const gr = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
        const rgb = rgbS(T.rgb);
        gr.addColorStop(0, `rgba(${rgb},${(0.13 * amt).toFixed(3)})`);
        gr.addColorStop(0.55, `rgba(${rgb},${(0.045 * amt).toFixed(3)})`);
        gr.addColorStop(1, `rgba(${rgb},0)`);
        ctx.fillStyle = gr;
        ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
      ctx.restore();
    }
    // ---- 1 · floor ----
    const buckets = new Map();
    const put = (key, x, y, sz) => { let p = buckets.get(key); if (!p) { p = new Path2D(); buckets.set(key, p); } p.rect(x - sz / 2, y - sz / 2, sz, sz); };
    const ripples = S.ripples;
    for (const d of M.fdots) {
      if (d.r0 > rr || d.r0 > drainR) continue;
      let y = 0;
      if (rev < 1) y = -26 * (1 - xrE3((rr - d.r0) / 90));
      // the thermal pool round the bed, per half
      const T = sideOf(d.side), lv = T.lvl.x, on = T.on.x;
      let g = 0, core = 0, col = 0;
      if (on > 0.01 && Math.abs(lv) > 0.01) {
        const pool = Math.exp(-d.de / 64) * (0.35 + 0.65 * Math.abs(lv)) * on;
        if (pool > 0.012) {
          let b = 0;
          const w = T.work.x;
          if (w > 0.01) {
            for (const off of [0, 0.5]) {
              const [u, fade] = bandPos(T, lv > 0 ? 0.28 : 0.16, off);
              const pos = lv > 0 ? u * 150 : (1 - u) * 150;              // warm swells out, cool settles in
              const q = (d.de - pos) / 24;
              b = Math.max(b, Math.exp(-q * q) * fade);
            }
            b *= w;
            y += (lv > 0 ? 5 : -3) * b * pool;
          }
          g = pool * (0.62 + 0.9 * b);
          core = pool * b;
          col = d.side < 0 ? 1 : 2;
        }
      }
      // the fan's air: a cone of light along where it blows, pulses rolling outward
      if (famt > 0.01 && d.fr > 26 && d.fr < 330) {
        const dth = xrWrap(d.fth - beam), sig = 0.2 + flvl * 0.012;
        const cone = Math.exp(-(dth * dth) / (2 * sig * sig));
        if (cone > 0.03) {
          const env = xrSm(26, 60, d.fr) * (1 - xrSm(200, 330, d.fr));
          let bnd = 0;
          for (const off of [0, 0.5]) {
            const u = ((S.wave * 0.34 + off) % 1), e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
            const q = (d.fr - (40 + e * 260)) / 30;
            bnd = Math.max(bnd, Math.exp(-q * q) * Math.sin(Math.PI * u));
          }
          const ga = famt * cone * env * (0.22 + 0.85 * bnd) * (A < 0.6 ? 0.5 : 1);
          if (ga > g) { g = ga; core = cone * env * bnd * famt; col = 3; }
          y += 2.2 * famt * cone * env * bnd;
        }
      }
      let boost = 0;
      for (const rp of ripples) {
        const age = (now - rp.t0) / 1000, dd = Math.hypot(d.x - rp.x, d.z - rp.z), front = age * 150;
        const kk = front - dd;
        if (kk > 0 && kk < 80) { const amp = Math.exp(-age * 1.5) * Math.sin((kk / 80) * Math.PI); y += amp * 7; boost += amp; }
      }
      const P = this._xrP(d.x, y, d.z);
      if (P[0] < -4 || P[0] > G.W + 4 || P[1] < -4 || P[1] > G.H + 4) continue;
      const fade = (1 - xrSm(R * 0.55, R, d.r0)) * (1 - xrSm(G.H - 26, G.H, P[1])) * xrSm(-2, 30, P[1]);
      if (fade < 0.02) continue;
      const near = xrClamp((d.z + 300) / 640, 0, 1);
      const sz = (0.8 + 0.45 * near) * Math.min(1.6, P[2]) * (1 + boost * 0.7);
      const base = fade * (0.07 + 0.11 * near) * A;
      if (boost > 0.08) {
        put("W" + Math.min(14, Math.round((base + boost * 0.75) * 14)), P[0], P[1], sz);
      } else if (g > 0.05) {
        const a = Math.min(1, fade * A * g);
        const key = (core > 0.8 ? "C" : col === 1 ? "L" : col === 2 ? "R" : "F") + Math.min(14, Math.round(a * 14));
        put(key, P[0], P[1], sz * (1.1 + core * 0.35));
      } else {
        put("W" + Math.min(14, Math.round(base * 14 * 1.0 + g * 4)), P[0], P[1], sz);
      }
    }
    // the floor stays grey-white; a side's temperature and the fan's air only tint it
    const tint = (rgb, m) => rgbS([0, 1, 2].map((i) => 236 + (rgb[i] - 236) * m));
    const cols = { W: "255,255,255", C: "240,244,255", L: tint(L.rgb, 0.42), R: tint(Rh.rgb, 0.42), F: tint(fpal.fx.split(",").map(Number), 0.45) };
    for (const [k, p] of buckets) {
      const a = +k.slice(1) / 14;
      if (a <= 0) continue;
      ctx.fillStyle = `rgba(${cols[k[0]]},${(k[0] === "W" ? a * 0.9 : 0.1 + a * 0.62).toFixed(3)})`;
      ctx.fill(p);
    }
    // ---- 2 · the bed (model) ----
    const hp = xrE3((rev - 0.18) / 0.82) * (S.drain ? 1 - xrE3(S.drainK * 1.3) : 1);
    if (this._xrBedMode() === "model" && hp > 0) this._xrDrawBed(ctx, A, hp);
    // ---- 3 · the fan + its air ----
    if (fan && hp > 0) {
      this._xrDrawFan(ctxF, A, hp, yaw, fpal, famt);
      if (famt > 0.01 && hp > 0.97) this._xrBeams(ctxF, A * xrSm(0.97, 1, hp), yaw, fpal, famt);
    }
    ctx.globalAlpha = 1;
  },
  // rim-lit wireframe: every segment weighted by how edge-on its surface is to you, far side dimmer
  _xrDrawBed(ctx, A, hp) {
    const M = this._xrM, S = this._xrS, B = XR_BED, G = this._xrGeo;
    const vy = G.sp, vz = G.cp;
    const mixRGB = (T) => {
      const m = Math.min(0.55, Math.abs(T.lvl.x) * T.on.x * 0.7);
      return XR_WHITE.map((v, i) => Math.round(v + (T.rgb[i] - v) * m)).join(",");
    };
    const zoneRGB = { "-1": mixRGB(S.hl), "0": XR_WHITE.join(","), "1": mixRGB(S.hr) };
    const Bk = new Map(), Gl = new Path2D();
    let glowN = 0;
    for (const Ln of M.lines) {
      const pts = Ln.pts, n = pts.length, m = Ln.close ? n : n - 1;
      const q = pts.map((p) => { const P = this._xrP(p[0], p[1], p[2]); const d = p[4] * vy + p[5] * vz; P.push(1 - Math.abs(d), d); return P; });
      const lim = hp * m;
      for (let i = 0; i < m && i < lim; i++) {
        const a = q[i], b0 = q[(i + 1) % n];
        let b = b0;
        if (i + 1 > lim) { const f = lim - i; b = [a[0] + (b0[0] - a[0]) * f, a[1] + (b0[1] - a[1]) * f, b0[2], b0[3], b0[4], b0[5]]; }
        const r = (a[4] + b[4]) / 2, front = a[5] + b[5] >= 0;
        let al = Ln.b0 + Ln.rim * Math.pow(r, 1.7);
        if (!front) al *= 0.42;
        al *= A;
        const bi = Math.min(14, Math.round(al * 14));
        if (bi <= 0) continue;
        const key = Ln.zone + ":" + bi;
        let p = Bk.get(key);
        if (!p) { p = new Path2D(); Bk.set(key, p); }
        p.moveTo(a[0], a[1]); p.lineTo(b[0], b[1]);
        if (Ln.glow && front && al > 0.4) { Gl.moveTo(a[0], a[1]); Gl.lineTo(b[0], b[1]); glowN++; }
      }
    }
    ctx.save();
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    // the cover's dot field: lit per half; a working half's light travels (warm toward the head, cool toward the foot)
    const ph = S.ph, buckets = new Map();
    const put = (key, x, y, sz) => { let p = buckets.get(key); if (!p) { p = new Path2D(); buckets.set(key, p); } p.rect(x - sz / 2, y - sz / 2, sz, sz); };
    for (const d of M.mdots) {
      const T = d.side < 0 ? S.hl : S.hr;
      const P = this._xrP(d.x, B.h + 0.3, d.z);
      // draw-in: the cover's dots appear from the foot up with the edges
      if ((B.az - d.z) / (2 * B.az) > hp * 1.05) continue;
      const lv = Math.abs(T.lvl.x) * T.on.x;
      let lit = 0, core = 0;
      if (T.on.x > 0.01) {
        lit = (0.3 + 0.55 * lv) * T.on.x;
        if (T.work.x > 0.01) {
          let b = 0;
          for (const off of [0, 0.5]) {
            const u = ((ph * (T.lvl.x > 0 ? 0.22 : 0.14) + off) % 1 + 1) % 1, fade = Math.sin(Math.PI * u);
            const zp = T.lvl.x > 0 ? B.az - u * 2 * B.az : -B.az + u * 2 * B.az;
            const qq = (d.z - zp) / 20;
            b = Math.max(b, Math.exp(-qq * qq) * fade);
          }
          b *= T.work.x;
          lit += b * (0.35 + 0.5 * lv);
          core = b;
        }
      }
      // someone lying there: a soft brighter body in the field
      let body = 0;
      if (T.occ.x > 0.01) {
        const cx = d.side * 41, hw = d.z < -52 ? 0 : d.z < -8 ? 21 : d.z < 22 ? 19 : d.z < 92 ? 15 - (d.z - 22) * 0.06 : 0;
        if (hw > 0 && Math.abs(d.x - cx) < hw) body = T.occ.x * (1 - Math.pow(Math.abs(d.x - cx) / hw, 4));
      }
      const pil = d.pil ? 0.35 : 1;
      const sz = 1.25 * Math.min(1.5, P[2]);
      if (lit > 0.04) {
        const a = Math.min(1, (lit + body * 0.18) * pil) * A;
        put((core > 0.9 ? "C" : d.side < 0 ? "L" : "R") + Math.min(12, Math.round(a * 12)), P[0], P[1], sz * (1.1 + core * 0.35));
      } else {
        put("W" + Math.min(12, Math.round((0.1 + body * 0.25) * pil * A * 12)), P[0], P[1], sz);
      }
    }
    for (const d of M.sdots) {
      if (d.y / B.h > hp) continue;
      const P = this._xrP(d.x, d.y, d.z);
      const f = d.n[1] * vy + d.n[2] * vz;                          // facing you → dim, edge-on → brighter
      put("W" + Math.min(12, Math.round((0.05 + 0.12 * (1 - Math.abs(f))) * A * 12)), P[0], P[1], 0.9 * Math.min(1.4, P[2]));
    }
    const rgbS = (a) => `${Math.round(a[0])},${Math.round(a[1])},${Math.round(a[2])}`;
    const cols = { W: "236,241,250", C: "244,246,255", L: rgbS(S.hl.rgb), R: rgbS(S.hr.rgb) };
    for (const [k, p] of buckets) { const a = +k.slice(1) / 12; if (a > 0) { ctx.fillStyle = `rgba(${cols[k[0]]},${a.toFixed(3)})`; ctx.fill(p); } }
    if (glowN) {
      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = `rgba(236,241,250,${(0.07 * A).toFixed(3)})`; ctx.lineWidth = 4; ctx.stroke(Gl);
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.lineWidth = 1;
    for (const [key, p] of Bk) {
      const [z, bi] = key.split(":");
      ctx.strokeStyle = `rgba(${zoneRGB[z]},${(+bi / 14).toFixed(3)})`;
      ctx.stroke(p);
    }
    ctx.restore();
  },
  // dyson-fan-card's _drawFan, on this card's floor (same model, same fresnel weighting)
  _xrDrawFan(ctx, A, hp, yaw, pal, amt) {
    const M = this._xrFanM, D = XR_FAN, G = this._xrGeo, S = this._xrS;
    if (!M) return;
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    const vy = G.sp, vz = G.cp, FS = XR_FAN_S;
    const P = (X, Y, Z) => this._xrP(XR_FAN_AT.x + X * FS, Y * FS, XR_FAN_AT.z + Z * FS);
    const col = pal.fx.split(",").map(Number), mix = Math.min(1, amt * 0.5);
    const rgb = XR_WHITE.map((v, i) => Math.round(v + (col[i] - v) * mix)).join(",");
    const dim = (S.fan.on ? 1 : 0.86) * A;
    const V = (x, y, z, nx, ny, nz, spin) => {
      let X = x, Z = z, NX = nx, NZ = nz;
      if (spin !== false) { X = x * cs + z * sn; Z = -x * sn + z * cs; NX = nx * cs + nz * sn; NZ = -nx * sn + nz * cs; }
      const q = P(X, y, Z);
      const d = (ny * vy + NZ * vz) / (Math.hypot(NX, ny, NZ) || 1);
      q.push(1 - Math.abs(d), d);
      return q;
    };
    const B = new Map(), Gp = new Path2D();
    let glowN = 0;
    const seg = (a, b, b0, rim, glow) => {
      const r = (a[4] + b[4]) / 2, front = a[5] + b[5] >= 0;
      let al = b0 + rim * Math.pow(r, 1.7);
      if (!front) al *= 0.42;
      const bi = Math.min(14, Math.round(al * 14));
      if (bi <= 0) return;
      let pth = B.get(bi);
      if (!pth) { pth = new Path2D(); B.set(bi, pth); }
      pth.moveTo(a[0], a[1]); pth.lineTo(b[0], b[1]);
      if (glow && front && al > 0.45) { Gp.moveTo(a[0], a[1]); Gp.lineTo(b[0], b[1]); glowN++; }
    };
    const poly = (pts, close, b0, rim, glow) => {
      const n = pts.length, m = close ? n : n - 1, lim = hp * m;
      for (let i = 0; i < m && i < lim; i++) seg(pts[i], pts[(i + 1) % n], b0, rim, glow);
    };
    const ringV = (r, y, spin, ny) => M.unit.map(([sa, ca]) => V(r * sa, y, r * ca, sa, ny || 0, ca, spin));
    ctx.save();
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    // perforated shroud; a light band climbs it while it runs
    const buckets = new Map();
    const put = (key, x, y, sz) => { let b = buckets.get(key); if (!b) { b = new Path2D(); buckets.set(key, b); } b.rect(x - sz / 2, y - sz / 2, sz, sz); };
    for (const d of M.dots) {
      if ((d[2] - D.filter[0]) / (D.filter[1] - D.filter[0]) > hp) continue;
      const x = d[0] * 111, z = d[1] * 111, Z = -x * sn + z * cs;
      const q = P(x * cs + z * sn, d[2], Z);
      const depth = Z / 111;
      const a = depth > 0 ? 0.1 + 0.3 * Math.pow(depth, 0.6) : 0.04 + 0.04 * (1 + depth);
      let lit = 0;
      if (amt > 0.02) lit = amt * Math.pow(0.5 + 0.5 * Math.cos(2 * Math.PI * (d[2] / 64 - S.wave * 0.9)), 6) * (0.25 + 0.75 * Math.max(0, depth));
      const sz = (depth > 0 ? 1.15 : 0.85) * Math.min(1.4, q[2]);
      if (lit > 0.12) put("L" + Math.min(8, Math.round(lit * 8)), q[0], q[1], sz * 1.15);
      else put("B" + Math.min(12, Math.round(a * 24)), q[0], q[1], sz);
    }
    for (const [key, path] of buckets) {
      const n = +key.slice(1);
      ctx.fillStyle = key[0] === "L" ? `rgba(${pal.fx},${((0.25 + n / 9) * A).toFixed(3)})` : `rgba(${rgb},${((n / 24) * dim).toFixed(3)})`;
      ctx.fill(path);
    }
    const F = D.foot;
    poly(ringV(F.r, 0, false), true, 0.14, 0.7);
    poly(ringV(F.r, F.h, false, 0.5), true, 0.2, 0.75, true);
    poly(ringV(F.lipR, F.lipY, false, 0.9), true, 0.1, 0.5);
    for (const [y, r] of D.profile) poly(ringV(r, y), true, 0.1, 0.74);
    const C = D.cut;
    poly(M.unit.map(([sa, ca]) => V(C.r * sa, C.y + C.k * C.r * ca, C.r * ca, sa, 0.5, ca)), true, 0.22, 0.7, true);
    const sil = [[0, F.r], [F.h, F.r], [F.lipY, F.lipR], ...D.profile, [C.y, C.r]];
    for (const sx of [1, -1]) poly(sil.map(([y, r]) => V(sx * r, y, 0, sx, 0, 0, false)), false, 0.86, 0.1, true);
    for (const sx of [1, -1]) {
      poly([V(sx * 111.6, 95, 0, sx, 0, 0), V(sx * 111.6, 300, 0, sx, 0, 0)], false, 0.22, 0.45);
      poly(M.btn.map(([bz, by]) => V(sx * 112.5, D.btn + by, bz, sx, 0, 0)), true, 0.38, 0.4);
    }
    const lc = V(0, D.lcd.y, D.lcd.z, 0, 0, 1);
    poly(M.lcd.map(([dx, dy]) => V(dx, D.lcd.y + dy, D.lcd.z, 0, 0, 1)), true, 0.5, 0.25);
    const L = D.loop;
    const nrm = (x, y, z) => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };
    const band = (inset, z, nz, nr) => M.outer.map(([x, y, nx, ny]) => { const n = nrm(nx * nr, ny * nr, nz); return V(x - nx * inset, y - ny * inset, z, n[0], n[1], n[2]); });
    const tun = (src, z, bz) => src.map(([x, y, nx, ny]) => { const n = nrm(-nx, -ny, 0.45 + bz); return V(x, y, z, n[0], n[1], n[2]); });
    const s45 = Math.SQRT1_2;
    const OFe = band(L.rf, L.zf, 0.9, 0.45), OF2 = band(0, L.zf - L.rf, 0, 1), O1 = band(0, (L.zf + L.zb + L.rb) / 2, 0, 1);
    const OB2 = band(0, L.zb + L.rb, 0, 1), OBm = band(L.rb * (1 - s45), L.zb + L.rb * (1 - s45), -s45, s45), OBe = band(L.rb, L.zb, -1, 0.15);
    const FO = tun(M.front, L.zf, 0.9), TM = tun(M.mid, (L.zf + L.zt) / 2, 0), HO = tun(M.hole, L.zt, -0.2), HB = tun(M.hole, L.zb, -0.9);
    poly(OFe, true, 0.32, 0.65, true); poly(OF2, true, 0.02, 0.6); poly(O1, true, 0.015, 0.62); poly(OB2, true, 0.02, 0.6);
    poly(OBm, true, 0.02, 0.62, true); poly(OBe, true, 0.16, 0.5); poly(FO, true, 0.28, 0.55, true); poly(TM, true, 0.03, 0.45);
    poly(HO, true, 0.24, 0.5); poly(HB, true, 0.1, 0.45);
    for (let i = 0; i < M.outer.length; i += 9) {
      const [x, y, nx, ny] = M.outer[i], arc = [];
      for (let j = 0; j <= 4; j++) {
        const ps = (j / 4) * (Math.PI / 2), ins = L.rb * (1 - Math.cos(ps)), z = L.zb + L.rb - L.rb * Math.sin(ps);
        const n = nrm(nx * Math.cos(ps), ny * Math.cos(ps), -Math.sin(ps));
        arc.push(V(x - nx * ins, y - ny * ins, z, n[0], n[1], n[2]));
      }
      poly([OFe[i], OF2[i], O1[i], ...arc, HB[i], HO[i], TM[i], FO[i], OFe[i]], false, 0.045, 0.28);
    }
    if (glowN) {
      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = `rgba(${rgb},${(0.07 * A).toFixed(3)})`; ctx.lineWidth = 3.5; ctx.stroke(Gp);
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.lineWidth = 1;
    for (const [bi, pth] of B) { ctx.strokeStyle = `rgba(${rgb},${((bi / 14) * dim).toFixed(3)})`; ctx.stroke(pth); }
    if (amt > 0.02 && hp > 0.9) {
      const tp = new Path2D();
      HO.forEach((q, i) => (i ? tp.lineTo(q[0], q[1]) : tp.moveTo(q[0], q[1])));
      tp.closePath();
      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = `rgba(${pal.fx},${(0.12 * amt * A).toFixed(3)})`; ctx.lineWidth = 4; ctx.stroke(tp);
      ctx.strokeStyle = `rgba(${pal.fx},${(0.5 * amt * A).toFixed(3)})`; ctx.lineWidth = 1.1; ctx.stroke(tp);
      ctx.globalCompositeOperation = "source-over";
      if (lc[5] > 0) {
        const rr = D.lcd.r * FS * G.k * lc[2] * 2.2, a = amt * lc[5] * A;
        const g = ctx.createRadialGradient(lc[0], lc[1], 0, lc[0], lc[1], rr);
        g.addColorStop(0, `rgba(255,255,255,${(0.85 * a).toFixed(3)})`);
        g.addColorStop(0.25, `rgba(${pal.rgb},${(0.7 * a).toFixed(3)})`);
        g.addColorStop(1, `rgba(${pal.rgb},0)`);
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(lc[0], lc[1], rr, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
  },
  // the air: a flat fan of light lines out of the loop toward the bed, a pulse drifting along each
  _xrBeams(ctx, A, yaw, pal, amt) {
    const S = this._xrS, Lp = XR_FAN.loop, FS = XR_FAN_S, fan = S.fan;
    const cs = Math.cos(yaw), sn = Math.sin(yaw), dirZ = fan.rev ? -1 : 1;
    const rot = (x, y, z) => this._xrP(XR_FAN_AT.x + (x * cs + z * sn) * FS, y * FS, XR_FAN_AT.z + (-x * sn + z * cs) * FS);
    const lvl = fan.lvl.x;
    const n = Math.round(5 + lvl * 0.7), spread = ((13 + lvl * 1.4) * Math.PI) / 180;
    const len = 640 + lvl * 34;
    const am = amt * (0.3 + lvl * 0.035) * A, speed = 0.12 + lvl * 0.028;
    ctx.save();
    ctx.globalCompositeOperation = "lighter"; ctx.lineCap = "round";
    for (let i = 0; i < n; i++) {
      const u = n > 1 ? i / (n - 1) - 0.5 : 0, a = u * 2 * spread;
      const sx = u * Lp.fa * 1.2, sy = Lp.fcy - Lp.fb * 0.12, sz = fan.rev ? Lp.zb : Lp.zf;
      const dx = Math.sin(a), dz = Math.cos(a) * dirZ;
      // the sheet falls gently toward the floor as it travels, so it lands across the bed
      const Ap = rot(sx, sy, sz), Bp = rot(sx + dx * len, sy - len * 0.42, sz + dz * len);
      const al = am * (1 - Math.abs(u) * 0.6) * (fan.rev ? 0.6 : 1);
      const g = ctx.createLinearGradient(Ap[0], Ap[1], Bp[0], Bp[1]);
      g.addColorStop(0, `rgba(${pal.fx},${(al * 0.9).toFixed(3)})`);
      g.addColorStop(0.55, `rgba(${pal.fx},${(al * 0.35).toFixed(3)})`);
      g.addColorStop(1, `rgba(${pal.fx},0)`);
      ctx.strokeStyle = g; ctx.lineWidth = 0.9;
      ctx.beginPath(); ctx.moveTo(Ap[0], Ap[1]); ctx.lineTo(Bp[0], Bp[1]); ctx.stroke();
      const q = (S.wave * speed * 3 + i * 0.37) % 1, q0 = Math.max(0, q - 0.08), q1 = Math.min(1, q + 0.04);
      const P0 = [Ap[0] + (Bp[0] - Ap[0]) * q0, Ap[1] + (Bp[1] - Ap[1]) * q0], P1 = [Ap[0] + (Bp[0] - Ap[0]) * q1, Ap[1] + (Bp[1] - Ap[1]) * q1];
      const pa = al * 1.4 * (1 - q) * Math.min(1, q * 8);
      if (pa > 0.01) {
        const pg = ctx.createLinearGradient(P0[0], P0[1], P1[0], P1[1]);
        pg.addColorStop(0, `rgba(${pal.fx},0)`);
        pg.addColorStop(1, `rgba(${pal.fx},${Math.min(1, pa).toFixed(3)})`);
        ctx.strokeStyle = pg; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(P0[0], P0[1]); ctx.lineTo(P1[0], P1[1]); ctx.stroke();
      }
    }
    ctx.restore();
  },

  /* ---------------- boot / power-off / traces (Roadster) ---------------- */
  _xrSweep(collapse) {
    const hero = this._xrHero, G = this._xrGeo;
    if (!hero || !hero.animate) return;
    const bar = document.createElement("i");
    bar.className = "xr-sweep";
    bar.style.top = ((G && G.horizon) || hero.clientHeight * 0.55).toFixed(1) + "px";
    hero.appendChild(bar);
    if (collapse) bar.animate([{ transform: "scaleX(1)", opacity: 1 }, { transform: "scaleX(0)", opacity: 0.4 }], { duration: 560, easing: XR_EASE, fill: "forwards" }).onfinish = () => bar.remove();
    else bar.animate([{ transform: "scaleX(0)", opacity: 1 }, { transform: "scaleX(1)", opacity: 1, offset: 0.62 }, { transform: "scaleX(1)", opacity: 0 }], { duration: 700, easing: XR_EASE }).onfinish = () => bar.remove();
  },
  _xrOutline(el, rr, kind) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const NS = "http://www.w3.org/2000/svg", root = this.shadowRoot.getElementById("podRoot");
    if (!root) return null;
    // rects are in screen px; the svg lives in the card's CSS px (they differ under any page zoom / scale)
    const sc = root.offsetWidth ? rr.width / root.offsetWidth || 1 : 1;
    const w = r.width / sc, h = r.height / sc;
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "xr-trc");
    svg.setAttribute("width", w); svg.setAttribute("height", Math.max(2, h));
    svg.style.left = (r.left - rr.left) / sc + "px"; svg.style.top = (r.top - rr.top) / sc + "px";
    let sh;
    if (kind === "line") {
      sh = document.createElementNS(NS, "line");
      sh.setAttribute("x1", w * 0.1); sh.setAttribute("x2", w * 0.9); sh.setAttribute("y1", 0.5); sh.setAttribute("y2", 0.5);
    } else {
      sh = document.createElementNS(NS, "rect");
      sh.setAttribute("x", 0.6); sh.setAttribute("y", 0.6);
      sh.setAttribute("width", Math.max(0, w - 1.2)); sh.setAttribute("height", Math.max(0, h - 1.2));
      sh.setAttribute("rx", Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, w / 2, h / 2));
    }
    sh.setAttribute("pathLength", "1");
    sh.style.strokeDasharray = "1"; sh.style.strokeDashoffset = "1";
    svg.appendChild(sh);
    root.appendChild(svg);
    return { svg, sh };
  },
  _xrTrace(el) {
    if (!el || this._xrReduce || !el.animate) return;
    const root = this.shadowRoot.getElementById("podRoot");
    if (!root) return;
    const o = this._xrOutline(el, root.getBoundingClientRect(), el.matches(".presets .chip, .gl-why, .gl-pchip, .xr-shd") ? "line" : "rect");
    if (!o) return;
    o.sh.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 380, easing: XR_EASE, fill: "forwards" });
    o.svg.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 320, delay: 420, fill: "forwards" }).onfinish = () => o.svg.remove();
  },
  _xrShaped() {
    const r = this.shadowRoot;
    return [...r.querySelectorAll(".v2home.xray .hd .side-sel, .v2home.xray .hd .hd-pwr, #viewPod .gl-step.circ, #viewPod .smart-switch")].filter((e) => e.offsetParent);
  },
  // boot: sweep → the floor rises out from the middle → bed + fan draw in → outlines trace →
  // contents fade up → numbers count from zero (~1.8 s, never twice inside 8 s)
  _xrBoot(force) {
    const S = this._xrS;
    if (!S || !this._xrCv) return;
    const now = performance.now();
    if (this._xrBootAt && now - this._xrBootAt < 8000) return;
    this._xrBootAt = now;
    S.drain = null; S.drainK = 0;
    if (this._xrReduce) { S.rev = 1; this._xrKick(); return; }
    const root = this.shadowRoot.getElementById("podRoot");
    this.shadowRoot.querySelectorAll(".xr-trc, .xr-sweep").forEach((n) => n.remove());
    this._xrSweep(false);
    S.rev = 0; S.revT0 = now + 160; S.revDur = 1500;
    // counters from zero, gauges sweep out from the pivot
    for (const k in S.V) { const o = S.V[k]; if (!o.na) { o.x = 0; o.v = 0; } }
    for (const key of ["self", "partner"]) { const g = S.g[key]; if (g.mid != null) { g.x = g.mid; g.v = 0; } }
    if (root && root.animate) {
      const rr = root.getBoundingClientRect();
      const shaped = this._xrShaped();
      const lines = [...this.shadowRoot.querySelectorAll("#viewPod > .gl-tile")].filter((e) => e.offsetParent);
      [...lines, ...shaped].slice(0, 24).forEach((el, i) => {
        const o = this._xrOutline(el, rr, el.classList.contains("gl-tile") ? "line" : "rect");
        if (!o) return;
        const delay = 380 + Math.min(i, 20) * 55;
        o.sh.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 440, delay, easing: XR_EASE, fill: "forwards" });
        o.svg.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 340, delay: delay + 520, easing: XR_EASE, fill: "forwards" }).onfinish = () => o.svg.remove();
      });
      const fade = [...this.shadowRoot.querySelectorAll(".v2home.xray .hd-left, .v2home.xray .hd-right > *, #viewPod .xr-hud, #viewPod .xr-tag:not([hidden]), #viewPod .prime-bar, #viewPod .gl-temp-hd, #viewPod .xr-side:not([hidden]), #podPresets .chip, #smartPanel > *:not([hidden])")];
      fade.forEach((el, i) => el.animate([{ opacity: 0, transform: "scale(0.98)" }, { opacity: 1, transform: "scale(1)" }],
        { duration: 260, delay: 520 + Math.min(i, 18) * 45, easing: XR_EASE, fill: "backwards" }));
    }
    this._xrKick();
  },
  // power-off: the boot in reverse — outlines un-trace, the floor drains, the sweep collapses — then a
  // dim standby with the same layout (controls stay where they are)
  _xrShutdown() {
    const S = this._xrS;
    if (!S) return;
    if (this._xrReduce) { this._xrKick(); return; }
    const root = this.shadowRoot.getElementById("podRoot");
    this.shadowRoot.querySelectorAll(".xr-trc, .xr-sweep").forEach((n) => n.remove());
    if (root && root.animate) {
      const rr = root.getBoundingClientRect();
      this._xrShaped().reverse().forEach((el, i) => {
        const o = this._xrOutline(el, rr, "rect");
        if (!o) return;
        o.sh.style.strokeDashoffset = "0";
        o.sh.animate([{ strokeDashoffset: 0 }, { strokeDashoffset: -1 }], { duration: 420, delay: i * 35 + 60, easing: XR_EASE, fill: "forwards" }).onfinish = () => o.svg.remove();
      });
    }
    setTimeout(() => this._xrSweep(true), 180);
    S.rev = 1;
    S.drain = { t0: performance.now() + 120, dur: 760 };
    S.drainK = 0;
    this._xrKick();
  },
};
Object.assign(EightSleepCard.prototype, XR_MIXIN);

const XR_STYLE = `
  /* v10.42 home: xray — scoped to .v2home.xray (only rendered when the flag is on) */
  .v2home.xray { --xr-mono: ui-monospace, "SF Mono", "JetBrains Mono", "Roboto Mono", Menlo, Consolas, monospace; }
  .v2home.xray > .gl-bg { background: radial-gradient(70% 34% at 50% 30%, rgba(var(--gl-rgb),0.07), rgba(var(--gl-rgb),0) 70%), #000; }
  .v2home.xray.gl-dual > .gl-bg { background: radial-gradient(40% 30% at 32% 30%, rgba(var(--gl-rgb),0.06), transparent 70%), radial-gradient(40% 30% at 68% 30%, rgba(var(--gl-rgb2),0.06), transparent 70%), #000; }
  .v2home.xray > .gl-bg::after { display: none; }
  .v2home.xray .hd-title { font-weight: 600; letter-spacing: -0.4px; }
  .v2home.xray .hd-pwr { background: none; -webkit-backdrop-filter: none; backdrop-filter: none; box-shadow: none; border: 1px solid rgba(255,255,255,0.16); }
  .v2home.xray .hd-pwr.on { background: none; border-color: rgba(var(--gl-rgb),0.6); box-shadow: 0 0 14px rgba(var(--gl-rgb),0.35), inset 0 0 10px rgba(var(--gl-rgb),0.12); }
  .v2home.xray .side-sel { background: none; border: 1px solid rgba(255,255,255,0.14); }
  .v2home.xray .side-sel .ss-opt { font-family: var(--xr-mono); font-size: 11px; font-weight: 600; letter-spacing: 1.2px; text-transform: uppercase; }
  .v2home.xray .side-sel .ss-opt.on { background: rgba(255,255,255,0.92); color: #000; }
  .v2home.xray .tabbar { background: rgba(10,11,12,0.78); }
  /* one body with the navbar: the card's height and its tab bar ride the bar's own curves —
     its 500 ms ease into the dock, its 550 ms spring back out */
  .v2home.xray { transition: height .55s cubic-bezier(0.22, 1.25, 0.36, 1), max-height .55s cubic-bezier(0.22, 1.25, 0.36, 1); }
  .v2home.xray.xr-navdock { transition: height .5s cubic-bezier(0.22, 1, 0.36, 1), max-height .5s cubic-bezier(0.22, 1, 0.36, 1); }
  .v2home.xray .tabbar { transition: bottom .55s cubic-bezier(0.22, 1.25, 0.36, 1); }
  .v2home.xray.xr-navdock .tabbar { transition: bottom .5s cubic-bezier(0.22, 1, 0.36, 1); }
  @media (prefers-reduced-motion: reduce) { .v2home.xray, .v2home.xray .tabbar { transition: none; } }
  .v2home.xray .gl-lbl { font-family: var(--xr-mono); font-size: 9.5px; font-weight: 500; letter-spacing: 2.2px; color: #7d828a; }
  .v2home.xray #viewPod:not([hidden]) { display: flex; flex-direction: column; overflow-x: hidden; }
  .v2home.xray #viewPod > * { flex: none; }
  /* the hero takes whatever height is left, so the Home never scrolls */
  .v2home.xray #viewPod > .xr-hero { position: relative; flex: 1 1 auto; min-height: 168px; margin: 0 -18px; overflow: hidden; }
  .v2home.xray .xr-cv { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  .v2home.xray .xr-photo { position: absolute; z-index: 1; pointer-events: none; }
  .v2home.xray .xr-cvtop { z-index: 2; pointer-events: none; }
  .v2home.xray .xr-photo .bed-wrap { max-width: none; width: 100%; margin: 0; }
  .v2home.xray .xr-photo .bed-photo { max-width: none; }
  .xr-hud { position: absolute; z-index: 3; top: 6px; font-family: var(--xr-mono); font-size: 10px; letter-spacing: 1.4px; text-transform: uppercase;
    white-space: nowrap; color: #8b9098; pointer-events: none; font-variant-numeric: tabular-nums; }
  .xr-tl { left: 18px; display: flex; align-items: center; gap: 7px; max-width: calc(100% - 150px); overflow: hidden; }
  .xr-tl b { font-weight: 600; color: var(--h-acc, #c9ccd2); text-shadow: 0 0 10px rgba(var(--h-rgb, 201,204,210),0.55); }
  .xr-tl span { overflow: hidden; text-overflow: ellipsis; color: #a9adb4; }
  .xr-led { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--h-acc, #8d928c); box-shadow: 0 0 8px rgba(var(--h-rgb, 141,146,140),0.9); }
  .xr-tr { right: 18px; }
  .xr-tag { position: absolute; z-index: 3; transform: translate(-50%, 0); font-family: var(--xr-mono); font-size: 9px; letter-spacing: 1.6px; text-transform: uppercase;
    white-space: nowrap; color: #7d828a; pointer-events: none; display: flex; gap: 6px; align-items: baseline; }
  .xr-tag[hidden] { display: none; }
  .xr-tag b { font-weight: 600; color: rgb(var(--t-rgb, 201,204,210)); }
  .xr-tight .xr-tag:not(.xr-fantag) span { display: none; }
  .xr-fantag.cool { color: #8fbfff; } .xr-fantag.heat { color: #ffad8c; }
  .v2home.xray .xr-hero .hr-edge { margin: 0; width: 40px; }
  .v2home.xray .xr-hero .hr-edge .hr-txt b { font-family: var(--xr-mono); font-size: 12px; }
  .v2home.xray .xr-hero .prime-bar { position: absolute; z-index: 3; left: 18px; right: 18px; bottom: 2px; min-height: 30px; margin: 0; padding: 0;
    font-family: var(--xr-mono); }
  .v2home.xray .xr-hero .prime-bar .ps-dot { width: 6px; height: 6px; }
  .v2home.xray .xr-hero .prime-bar .ps-text, .v2home.xray .xr-hero .prime-bar .ps-water, .v2home.xray .xr-hero .prime-btn {
    font-size: 9.5px; letter-spacing: 1.4px; text-transform: uppercase; font-weight: 600; }
  .v2home.xray .xr-hero .prime-bar .ps-text { color: #8b9098; }
  .v2home.xray .xr-hero .prime-bar .ps-water { color: #8fbfff; }
  .v2home.xray .xr-hero .prime-bar .ps-water svg { width: 12px; height: 12px; }
  .xr-sweep { position: absolute; left: 0; right: 0; height: 1px; margin-top: -0.5px; z-index: 4; pointer-events: none; transform-origin: center;
    background: linear-gradient(90deg, transparent, #eef2fa 18%, #fff 50%, #eef2fa 82%, transparent); box-shadow: 0 0 12px rgba(220,232,255,0.9); }
  .xr-trc { position: absolute; z-index: 30; pointer-events: none; overflow: visible; }
  .xr-trc rect, .xr-trc line { fill: none; stroke: rgba(240,244,252,0.85); stroke-width: 1; filter: drop-shadow(0 0 3px rgba(220,232,255,0.7)); }
  /* temperature: a dotted arc per side between hairline −/+ rings */
  .v2home.xray .xr-temp { padding-top: 12px; margin-top: 4px; }
  .v2home.xray .gl-temp-hd { min-height: 22px; }
  .v2home.xray .gl-temp-hd .gl-wake { font-family: var(--xr-mono); font-size: 10.5px; letter-spacing: 0.6px; height: 22px; }
  .v2home.xray .xr-sides { display: grid; grid-template-columns: minmax(0,1fr); gap: 10px; margin-top: 2px; container-type: inline-size; }
  .v2home.xray .gl-temp.dual .xr-sides { grid-template-columns: repeat(2, minmax(0,1fr)); }
  .xr-side { --s-rgb: var(--gl-rgb); --s-acc: var(--gl-acc); --s-hi: var(--gl-hi); min-width: 0; }
  .xr-side[hidden] { display: none !important; }
  /* the Glow renderer still writes these; the hero HUD carries the state + room instead */
  .v2home.xray .xr-side .gl-kv, .v2home.xray #glState { display: none !important; }
  .gl-temp.dual .xr-side + .xr-side { border-left: 1px solid rgba(255,255,255,0.07); padding-left: 10px; }
  .xr-shd { display: none; width: 100%; align-items: center; gap: 7px; height: 22px; padding: 0; background: none; border: 0; color: inherit; font: inherit; cursor: pointer;
    -webkit-tap-highlight-color: transparent; }
  .gl-temp.dual .xr-shd { display: flex; }
  .xr-shd .gl-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--s-acc); box-shadow: 0 0 8px rgba(var(--s-rgb),0.9); }
  .xr-shd .gl-name { font-family: var(--xr-mono); font-size: 10px; font-weight: 600; letter-spacing: 1.6px; text-transform: uppercase; color: #a3a8af;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .xr-side.active .xr-shd .gl-name { color: #fff; }
  .xr-shd .gl-word { margin-left: auto; font-family: var(--xr-mono); font-size: 9px; font-weight: 600; letter-spacing: 1.4px; text-transform: uppercase; color: var(--s-hi);
    white-space: nowrap; text-shadow: 0 0 10px rgba(var(--s-rgb),0.5); }
  .xr-ctl { display: flex; align-items: center; justify-content: center; gap: 6px; }
  .v2home.xray .xr-gauge { flex: 1 1 auto; width: auto; max-width: 168px; min-width: 0; aspect-ratio: 170 / 108; margin: 0; position: relative; cursor: grab; touch-action: none; }
  .v2home.xray .gl-temp.dual .xr-gauge { max-width: 150px; }
  .xr-gauge svg { width: 100%; height: 100%; display: block; overflow: visible; }
  .xr-d { fill: rgba(255,255,255,0.22); }
  .xr-d.on { fill: var(--s-acc); }
  .xr-mid { stroke: rgba(255,255,255,0.35); stroke-width: 1; stroke-linecap: round; }
  .xr-cur { fill: none; stroke: rgba(255,255,255,0.8); stroke-width: 1; }
  .xr-kg0 { stop-color: var(--s-acc); stop-opacity: 0.75; } .xr-kg1 { stop-color: var(--s-acc); stop-opacity: 0; }
  .xr-knob { fill: #fff; stroke: var(--s-acc); stroke-width: 2.2; }
  .xr-side.off .xr-knob { fill: #8d928c; stroke: #5b605b; } .xr-side.off .xr-kglow { opacity: 0; }
  .gl-temp.dual .xr-side:not(.active) .xr-gauge { opacity: 0.8; }
  .xr-center { position: absolute; left: 0; right: 0; top: 40%; display: flex; flex-direction: column; align-items: center; pointer-events: none; }
  .v2home.xray .xr-num { font-size: 34px; font-weight: 300; letter-spacing: -1.5px; line-height: 1; color: #f2f4f6; font-variant-numeric: tabular-nums; }
  .v2home.xray .gl-temp.dual .xr-num { font-size: 28px; }
  .v2home.xray .xr-side.off .xr-num { font-size: 22px; color: #8d928c; letter-spacing: -0.5px; }
  .v2home.xray .xr-bed, .v2home.xray .gl-temp.dual .xr-bed { display: block; margin-top: 4px; font-size: 11.5px; color: #8d928c; white-space: nowrap; }
  .v2home.xray .xr-ctl .gl-step.circ { flex: none; width: 40px; height: 40px; }
  .v2home.xray .gl-temp.dual .xr-ctl .gl-step.circ { width: 34px; height: 34px; }
  @container (max-width: 330px) { .v2home.xray .gl-temp.dual .xr-ctl .gl-step.circ { width: 30px; height: 30px; } .v2home.xray .gl-temp.dual .xr-num { font-size: 22px; } }
  /* quick actions + Autopilot: the boxless rows, tracked mono labels */
  .v2home.glow.nobox.xray .presets.quick { margin-top: 8px; }
  .v2home.glow.nobox.xray .presets.quick .chip { height: 58px; }
  .v2home.xray #smartPanel { margin-top: 8px; padding-top: 12px; }
  .v2home.xray .gl-schsub, .v2home.xray .gl-aplbl { font-family: var(--xr-mono); font-size: 9.5px; letter-spacing: 1px; text-transform: uppercase; }
  .v2home.xray .gl-curve svg { height: 38px; }
  .v2home.xray .gl-cline { stroke-width: 1.4; }
  .v2home.xray .gl-cglow { stroke-width: 5; opacity: 0.22; }
  .v2home.xray .gl-cax { font-family: var(--xr-mono); font-size: 9px; letter-spacing: 1px; text-transform: uppercase; margin-top: 5px; }
  .v2home.xray .gl-why { margin-top: 8px; padding-top: 8px; font-size: 12px; }
  .v2home.xray .gl-pchip b { font-family: var(--xr-mono); font-size: 14px; }
  @media (prefers-reduced-motion: reduce) { .xr-sweep, .xr-trc { display: none; } }
`;
/* ==== XRAY HOME END ==== */

/* ==== LIQUID NAV (v10.43) ====
   The v2 tab bar becomes a liquid-lens navbar — the same hand as custom:liquid-lens-navbar-card
  , built in, so the public card needs nothing else installed:
     · press anywhere on the bar and the glass lens lifts and follows the finger (damped follow,
       so one bad frame is one small step, never a jump), squashing with its speed like a drop
     · every tab it crosses ticks a selection haptic; sticky 6 px edges stop boundary tremor
     · lifting the finger switches to the tab under it; drag off the bar (90 px up / 48 px down)
       to cancel — the lens glides home. Taps are just very short drags. Keyboard still clicks.
   `tab_drag: false` restores plain tap-to-switch.

   navbar_join: true — the "bubble join". When a liquid-lens-navbar-card
   footer sits under the card (bottom_chrome), the two bars become one liquid: a glass neck
   connects the card's bar to the footer's lens (the 8+ route), the bar is BORN from that lens
   as a bubble each time the view opens, the neck gulps on a tab switch, stretches thin and
   pinches off when the footer goes to standby, and joins back with a wobble when it returns.
   Needs liquid-lens-navbar-card ≥ 1.14 (lln-navbar-state carries barTop + lens); without the
   footer, or without its answer within 700 ms, the bar is simply the bar. */
const LN_FOLLOW = 0.55, LN_HYST = 6, LN_VTOP = 90, LN_VBOT = 48;
const LN_MOTION_OK = () => !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
const LN_MIXIN = {
  _lnWire(tb) {
    const tabs = [...tb.querySelectorAll("[data-view]")];
    tabs.forEach((b) => { b.onclick = () => { if (this._lnSwallow) return; this._setView(b.dataset.view); }; });
    if (this._config.tab_drag !== false) {
      tb.classList.add("ln-live");
      tb.onpointerdown = (e) => this._lnDown(e, tb);
    }
    if (this._config.navbar_join) {
      if (!this.shadowRoot.getElementById("lnJoin"))
        tb.insertAdjacentHTML("beforebegin", `<div class="ln-join" id="lnJoin" aria-hidden="true"><div class="ln-neck" id="lnNeck"></div><svg class="ln-rim" id="lnRim"><defs><radialGradient id="lnBubG" cx="34%" cy="28%" r="80%"><stop offset="0" style="stop-color:#fff;stop-opacity:.42"/><stop offset=".45" style="stop-color:var(--ln-tint, #fff);stop-opacity:.48"/><stop offset="1" style="stop-color:var(--ln-tint, #fff);stop-opacity:.26"/></radialGradient></defs><path id="lnRimL"/><path id="lnRimR"/><circle id="lnBub" class="ln-bub" r="0"/></svg></div>`);
      this._lnJoinBind(true);
    }
  },

  /* ---------------- drag ---------------- */
  _lnDown(e, tb) {
    if (e.button > 0 || this._ln) return;
    const lens = tb.querySelector("#tabLens");
    if (!lens) return;
    const S = this._ln = { tb, lens, x: e.clientX, y: e.clientY, lx: null, v: 0, hov: null, out: false };
    lens.classList.add("trk", "lift");
    tb.classList.add("ln-drag");
    this._lnHover(S, this._lnRects(S));
    S.move = (ev) => { S.x = ev.clientX; S.y = ev.clientY; };
    S.up = () => this._lnUp(false);
    S.cancel = () => this._lnUp(true);
    document.addEventListener("pointermove", S.move);
    document.addEventListener("pointerup", S.up);
    document.addEventListener("pointercancel", S.cancel);
    const tick = () => { if (this._ln !== S) return; this._lnFrame(S); S.raf = requestAnimationFrame(tick); };
    this._lnFrame(S);
    S.raf = requestAnimationFrame(tick);
  },
  _lnRects(S) { return [...S.tb.querySelectorAll("[data-view]")].map((b) => b.getBoundingClientRect()); },
  _lnHover(S, rects) {
    let idx = null;
    const cur = S.hov != null && rects[S.hov];
    if (cur && S.x >= cur.left - LN_HYST && S.x <= cur.right + LN_HYST) idx = S.hov;
    else rects.forEach((r, i) => { if (idx == null && S.x >= r.left && S.x <= r.right) idx = i; });
    if (S.out) idx = null;
    if (idx === S.hov) return;
    S.hov = idx;
    [...S.tb.querySelectorAll("[data-view]")].forEach((b, i) => b.classList.toggle("hov", i === idx));
    if (idx != null) this._haptic("selection");
  },
  _lnFrame(S) {
    const r = S.tb.getBoundingClientRect();
    S.out = S.y < r.top - LN_VTOP || S.y > r.bottom + LN_VBOT;
    const rects = this._lnRects(S);
    this._lnHover(S, rects);
    if (S.out) {
      // off the bar: the lens lets go and goes home, the drag stays alive in case you come back
      if (S.lx != null) { S.lx = null; S.lens.classList.remove("trk", "lift"); this._positionTabLens(true); }
      return;
    }
    if (S.lx == null) S.lens.classList.add("trk", "lift");
    const w = S.lens.offsetWidth, pad = 4;
    const target = Math.min(Math.max(S.x - r.left - w / 2, pad), r.width - w - pad);
    const prev = S.lx;
    S.lx = prev == null ? target : prev + (target - prev) * LN_FOLLOW;
    S.v = S.v * 0.6 + (prev == null ? 0 : S.lx - prev) * 0.4;
    // a drop, not a puck: stretch along the travel, thin across it, by how fast it's moving
    const st = Math.min(0.26, Math.abs(S.v) * 0.016);
    S.lens.style.transform = `translateX(${S.lx.toFixed(1)}px) scale(${(1.07 + st).toFixed(3)}, ${(1.07 - st * 0.7).toFixed(3)})`;
  },
  _lnUp(cancelled) {
    const S = this._ln;
    if (!S) return;
    this._ln = null;
    cancelAnimationFrame(S.raf);
    document.removeEventListener("pointermove", S.move);
    document.removeEventListener("pointerup", S.up);
    document.removeEventListener("pointercancel", S.cancel);
    S.lens.classList.remove("trk", "lift");
    S.tb.classList.remove("ln-drag");
    S.tb.querySelectorAll(".hov").forEach((b) => b.classList.remove("hov"));
    const btn = !cancelled && !S.out && S.hov != null ? S.tb.querySelectorAll("[data-view]")[S.hov] : null;
    // the click that follows this pointerup is already handled — swallow it (keyboard clicks,
    // which come without a pointerdown, still go through the button's own onclick)
    this._lnSwallow = true;
    clearTimeout(this._lnSwT);
    this._lnSwT = setTimeout(() => { this._lnSwallow = false; }, 450);
    if (btn && btn.dataset.view !== this._view) this._setView(btn.dataset.view);
    else this._positionTabLens(true);
  },

  /* ---------------- bubble join ---------------- */
  _lnJoinBind(on) {
    if (on) {
      if (this._lnFootFn || !this.isConnected) return;
      this._lnFootFn = (e) => this._lnFootState((e && e.detail) || {});
      window.addEventListener("lln-navbar-state", this._lnFootFn);
      window.addEventListener("lln-navbar-frame", this._lnFootFn);
      // the footer doesn't announce resizes itself — ask it where it went (rotation, the HA app
      // resizing its webview), then re-aim the neck; the answer comes back synchronously
      this._lnResize = () => { this._lnAsk(); this._lnJoinKick(); clearTimeout(this._lnRzT); this._lnRzT = setTimeout(() => this._lnAsk(), 450); };
      window.addEventListener("resize", this._lnResize);
      // the bar waits, hidden, for the footer's answer — then it's born from the footer's lens
      this._lnEnter = LN_MOTION_OK();
      const tb = this.shadowRoot.getElementById("tabBar");
      if (tb && this._lnEnter) tb.classList.add("ln-pre");
      clearTimeout(this._lnPreT);
      this._lnPreT = setTimeout(() => this._lnEnterGiveUp(), 700);
      this._lnAsk();
      // the footer may mount after this card on a view switch: ask again once it has
      setTimeout(() => this._lnAsk(), 120);
    } else {
      if (!this._lnFootFn) return;
      window.removeEventListener("lln-navbar-state", this._lnFootFn);
      window.removeEventListener("lln-navbar-frame", this._lnFootFn);
      window.removeEventListener("resize", this._lnResize);
      this._lnFootFn = this._lnResize = null;
      cancelAnimationFrame(this._lnJR);
      this._lnJR = null;
      clearTimeout(this._lnPreT);
      this._lnFoot = null;
      this._lnJ = null;
    }
  },
  _lnAsk() { try { window.dispatchEvent(new CustomEvent("lln-navbar", { detail: { action: "report", source: "eight-sleep-card" } })); } catch (_) {} },
  _lnEnterGiveUp() {
    this._lnEnter = false;
    const tb = this.shadowRoot && this.shadowRoot.getElementById("tabBar");
    if (tb) tb.classList.remove("ln-pre");
  },
  _lnFootState(d) {
    const lens = d.lens && d.lens.w > 0 ? d.lens : null;
    if (!(Number(d.barTop) > 0) || !lens) { this._lnFoot = null; this._lnJoinKick(); return; }
    const tint = d.tint && d.tint !== "transparent" ? String(d.tint) : null;
    this._lnFoot = { top: Number(d.barTop), lens, min: d.state === "minimized", tint };
    const join = this.shadowRoot && this.shadowRoot.getElementById("lnJoin");
    if (join && tint) join.style.setProperty("--ln-tint", tint);
    if (this._lnEnter && this._lnRun()) return;
    this._lnJoinKick();
  },
  // the geometry the neck is heading for, in viewport px — or null for "no neck"
  _lnTarget() {
    const tb = this.shadowRoot && this.shadowRoot.getElementById("tabBar");
    const F = this._lnFoot;
    if (!tb || !F || this._view === undefined) return null;
    const r = tb.getBoundingClientRect();
    if (!r.width) return null;
    const x = Math.min(Math.max(F.lens.x + F.lens.w / 2, r.left + 34), r.right - 34);
    const y0 = r.bottom, y1 = F.top, gap = y1 - y0;
    // a short gap is a fat meniscus; it thins as the footer drops away (standby) and past
    // ~30 px lets go. Keyed on the gap, not the state, so standby STRETCHES it before it snaps.
    const wm = gap < 2 ? 15 : Math.max(0, 11.5 - (gap - 14) * 0.6);
    return { x, y0, y1, wm: gap > 30 ? 0 : wm };
  },
  _lnJoinKick() {
    if (!this._lnFootFn) return;
    if (!this._lnJ) this._lnJ = { wm: 0, vw: 0, x: null, y0: 0, y1: 0, pulse: 0 };
    if (this._lnJR) return;
    const step = () => {
      const J = this._lnJ;
      if (!J) { this._lnJR = null; return; }
      const T = this._lnTarget();
      const motion = LN_MOTION_OK();
      let settled = true;
      if (T) {
        if (J.x == null || !motion) { J.x = T.x; J.y0 = T.y0; J.y1 = T.y1; }
        J.x += (T.x - J.x) * 0.35; J.y0 += (T.y0 - J.y0) * 0.35; J.y1 += (T.y1 - J.y1) * 0.35;
        // an underdamped spring on the neck's waist: joins overshoot and wobble, pinches snap
        const tw = T.wm + J.pulse * 6;
        // letting go is crisp (no bounce back into view); joining is wobbly
        if (motion) { J.vw = (J.vw + (tw - J.wm) * (tw ? 0.16 : 0.22)) * (tw ? 0.78 : 0.55); J.wm += J.vw; }
        else { J.wm = tw; J.vw = 0; }
        J.pulse *= 0.86;
        if (J.pulse < 0.01) J.pulse = 0;
        settled = Math.abs(tw - J.wm) < 0.05 && Math.abs(J.vw) < 0.05 && Math.abs(T.y1 - J.y1) < 0.3 && Math.abs(T.x - J.x) < 0.3 && !J.pulse;
      } else {
        if (motion) { J.vw = (J.vw + (0 - J.wm) * 0.2) * 0.7; J.wm += J.vw; } else J.wm = 0;
        settled = J.wm <= 0.05 && Math.abs(J.vw) < 0.05;
      }
      this._lnDrawNeck(J);
      this._lnJR = settled ? null : requestAnimationFrame(step);
    };
    this._lnJR = requestAnimationFrame(step);
  },
  // an hourglass in the gap between the two bars: flared ends that read as the glass being
  // pulled out of each bar's edge, a concave waist of half-width wm
  _lnNeckPath(x, y0, y1, wm, we) {
    const h = y1 - y0, ym = y0 + h / 2, f = (n) => n.toFixed(1);
    const side = (s) => {
      const xe = x + s * we, xm = x + s * wm;
      return [`${f(xe)},${f(y0 - 1)}`, `C ${f(x + s * (wm + we * 0.25))},${f(y0 - 1)} ${f(xm)},${f(ym - h * 0.22)} ${f(xm)},${f(ym)}`,
              `C ${f(xm)},${f(ym + h * 0.22)} ${f(x + s * (wm + we * 0.25))},${f(y1 + 1)} ${f(xe)},${f(y1 + 1)}`];
    };
    const L = side(-1), R = side(1);
    return {
      fill: `M ${L[0]} ${L[1]} ${L[2]} L ${R[0].split(",")[0]},${f(y1 + 1)} C ${f(x + wm + we * 0.25)},${f(y1 + 1)} ${f(x + wm)},${f(ym + h * 0.22)} ${f(x + wm)},${f(ym)} C ${f(x + wm)},${f(ym - h * 0.22)} ${f(x + wm + we * 0.25)},${f(y0 - 1)} ${R[0]} Z`,
      l: `M ${L[0]} ${L[1]} ${L[2]}`, r: `M ${R[0]} ${R[1]} ${R[2]}`,
    };
  },
  _lnDrawNeck(J) {
    const $ = (id) => this.shadowRoot.getElementById(id);
    const neck = $("lnNeck"), join = $("lnJoin");
    if (!neck || !join) return;
    const show = J.wm > 0.4 && J.y1 - J.y0 > 0.5;
    join.classList.toggle("on", show);
    if (!show) return;
    const we = Math.min(26, 13 + J.wm * 1.1);
    const p = this._lnNeckPath(J.x, J.y0, J.y1, Math.max(0.4, J.wm), we);
    neck.style.clipPath = `path("${p.fill}")`;
    neck.style.webkitClipPath = `path("${p.fill}")`;
    const l = $("lnRimL"), r = $("lnRimR");
    if (l) l.setAttribute("d", p.l);
    if (r) r.setAttribute("d", p.r);
  },
  _lnGulp() { if (this._lnJ && this._lnFoot) { this._lnJ.pulse = 1; this._lnJoinKick(); } },

  /* the birth: a bubble sitting on the footer's lens rises out of it on a stretching neck, then
     inflates sideways into the full bar while the icons pour in behind it. One rAF timeline so
     the neck and the bubble are always drawn from the same numbers. */
  _lnRun() {
    const tb = this.shadowRoot.getElementById("tabBar");
    const F = this._lnFoot;
    this._lnEnter = false;
    clearTimeout(this._lnPreT);
    if (!tb || !F) return false;
    const r = tb.getBoundingClientRect();
    if (!r.width) { tb.classList.remove("ln-pre"); return false; }
    const cx = Math.min(Math.max(F.lens.x + F.lens.w / 2, r.left + 34), r.right - 34);
    const cy = r.top + r.height / 2, fy = F.lens.y + F.lens.h / 2;
    const R0 = 23, RISE = 640, GROW = 560, T0 = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const inOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    // slow pull off the lens (so the neck has time to stretch), a 6% overshoot, then settle
    const rise = (t) => (t < 0.75 ? 1.06 * inOut(t / 0.75) : 1.06 - 0.06 * ease((t - 0.75) / 0.25));
    // the inflate: eased, a 4% overshoot sideways, then home — slow enough to read as stretching
    const grow = (t) => (t < 0.72 ? 1.04 * inOut(t / 0.72) : 1.04 - 0.04 * ease((t - 0.72) / 0.28));
    const join = this.shadowRoot.getElementById("lnJoin"), bub = this.shadowRoot.getElementById("lnBub");
    // the bubble is born carrying the footer lens's colour (its route's lens_color)
    if (join) { join.style.setProperty("--ln-tint", F.tint || "#ffffff"); join.classList.add("birth"); }
    tb.classList.remove("ln-pre");
    tb.classList.add("ln-birth");
    if (!this._lnJ) this._lnJ = { wm: 0, vw: 0, x: null, y0: 0, y1: 0, pulse: 0 };
    cancelAnimationFrame(this._lnJR);
    this._lnJR = null;
    const frame = (now) => {
      if (!this._lnFootFn) return;
      const t = now - T0;
      const a = Math.min(1, t / RISE), b = Math.max(0, Math.min(1, (t - RISE * 0.72) / GROW));
      // rise: bubble centre from the footer lens up to the bar's centre, a little overshoot
      const ty = (fy - cy) * (1 - rise(a));
      const rad = R0 * (0.62 + 0.38 * ease(Math.min(1, a * 1.4)));
      // grow: the clip opens from a circle to the whole pill, springy
      const k = grow(b);
      const li = Math.max(0, (cx - r.left - rad) * (1 - k)), ri = Math.max(0, (r.right - cx - rad) * (1 - k));
      const ti = Math.max(0, (r.height / 2 - rad) * (1 - Math.min(1, k)));
      tb.style.transform = `translateY(${ty.toFixed(1)}px)`;
      tb.style.clipPath = `inset(${ti.toFixed(1)}px ${ri.toFixed(1)}px ${ti.toFixed(1)}px ${li.toFixed(1)}px round 999px)`;
      tb.style.setProperty("--ln-born", b.toFixed(3));
      // fade in as it leaves the footer's lens (no dark hole punched in the purple)
      tb.style.opacity = Math.min(1, a * 3.2).toFixed(3);
      // a glass skin on the bubble — the bar's own rim and shadow are clipped away while it's round
      if (bub) {
        bub.setAttribute("cx", cx.toFixed(1)); bub.setAttribute("cy", (cy + ty).toFixed(1));
        bub.setAttribute("r", rad.toFixed(1));
        bub.style.opacity = (Math.min(1, a * 3.2) * Math.max(0, 1 - b * 4)).toFixed(3);
      }
      // the neck hangs from the bubble's underside to the footer, thinning as it stretches
      const J = this._lnJ;
      // (its underside is wherever the clip's bottom edge is, so the hand-off to the resting
      // neck at the end is seamless)
      J.x = cx; J.y0 = cy + ty + (r.height / 2 - ti); J.y1 = F.top;
      const gap = J.y1 - J.y0;
      J.wm = gap < 2 ? 15 : Math.max(1.2, 13 - gap * 0.5); J.vw = 0;
      this._lnDrawNeck(J);
      if (t < RISE * 0.72 + GROW) { this._lnJR = requestAnimationFrame(frame); return; }
      tb.style.transform = ""; tb.style.clipPath = ""; tb.style.opacity = ""; tb.style.removeProperty("--ln-born");
      if (bub) { bub.setAttribute("r", "0"); bub.style.opacity = "0"; }
      if (join) join.classList.remove("birth");
      tb.classList.remove("ln-birth");
      this._lnJR = null;
      this._positionTabLens();
      this._lnJoinKick();
    };
    this._lnJR = requestAnimationFrame(frame);
    this._haptic("light");
    return true;
  },
};
Object.assign(EightSleepCard.prototype, LN_MIXIN);
{
  // chain onto whatever lifecycle the other mixins installed (XR_MIXIN owns these slots)
  const P = EightSleepCard.prototype, cc = P.connectedCallback, dc = P.disconnectedCallback;
  P.connectedCallback = function () {
    if (cc) cc.call(this);
    if (this._config && this._config.navbar_join && this.shadowRoot && this.shadowRoot.getElementById("tabBar")) this._lnJoinBind(true);
  };
  P.disconnectedCallback = function () {
    if (dc) dc.call(this);
    if (this._ln) this._lnUp(true);
    this._lnJoinBind(false);
  };
}

const LN_STYLE = `
  /* v10.43 liquid nav — the liquid-lens-navbar-card glass on the card's own tab bar */
  .tabbar.ln-live { touch-action: none; -webkit-user-select: none; user-select: none; }
  .tabbar .lens {
    background: radial-gradient(circle at 32% 26%, rgba(255,255,255,0.26), rgba(255,255,255,0.06) 45%, rgba(255,255,255,0.03) 72%);
    -webkit-backdrop-filter: blur(2px) saturate(200%) brightness(1.28); backdrop-filter: blur(2px) saturate(200%) brightness(1.28);
    box-shadow: inset 0 0 12px rgba(255,255,255,0.16), inset 0 -6px 10px rgba(0,0,0,0.10),
      inset 3px 0 7px rgba(80,200,255,0.22), inset -3px 0 7px rgba(255,90,190,0.20),
      inset 0 2px 5px rgba(255,255,255,0.18), 0 2px 10px rgba(0,0,0,0.26);
    border: 0.5px solid rgba(255,255,255,0.34); box-sizing: border-box;
    transition: transform .42s cubic-bezier(.22,1,.36,1), width .42s cubic-bezier(.22,1,.36,1),
      box-shadow .25s ease, opacity .25s ease;
  }
  /* while a finger drives it: no transform transition (it follows frame by frame), and it
     lifts — brighter glass, stronger chromatic edge, a shadow that says it's off the bar */
  .tabbar .lens.trk { transition: width .3s cubic-bezier(.22,1,.36,1), box-shadow .25s ease; }
  .tabbar .lens.lift {
    box-shadow: inset 0 0 16px rgba(255,255,255,0.24), inset 0 -8px 12px rgba(0,0,0,0.12),
      inset 4px 0 9px rgba(80,200,255,0.34), inset -4px 0 9px rgba(255,90,190,0.30),
      inset 0 3px 6px rgba(255,255,255,0.24), 0 8px 22px rgba(0,0,0,0.36);
  }
  .tabbar .tab svg { transition: stroke-width .22s, transform .28s cubic-bezier(.22,1.4,.36,1); }
  .tabbar .tab.hov { color: rgba(255,255,255,0.96); }
  .tabbar .tab.hov svg { transform: scale(1.12); }
  .tabbar.ln-drag .tab.on:not(.hov) { color: rgba(235,235,245,0.60); }
  @media (prefers-reduced-motion: reduce) { .tabbar .tab svg { transition: none; } .tabbar .tab.hov svg { transform: none; } }

  /* bubble join — neck between the bar and the footer's lens */
  /* above the bar (z 41): the bar's backdrop blur would smear the bubble's skin; the neck itself
     only ever occupies the gap, so it never covers a tab */
  .ln-join { position: fixed; inset: 0; z-index: 41; pointer-events: none; opacity: 0; transition: opacity .18s ease; }
  .ln-join.on { opacity: 1; }
  .ln-neck { position: absolute; inset: 0; background: rgba(255,255,255,0.10);
    -webkit-backdrop-filter: blur(36px) saturate(185%) brightness(1.06); backdrop-filter: blur(36px) saturate(185%) brightness(1.06); }
  .ln-rim { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
  .ln-rim path { fill: none; stroke: rgba(255,255,255,0.34); stroke-width: 0.6; stroke-linecap: round; }
  .v2home.glow .ln-neck { background: color-mix(in srgb, var(--ln-tint, #fff) 10%, rgba(20,22,24,0.72)); }
  .ln-neck { transition: background .7s ease; }
  .ln-rim path { transition: stroke .7s ease; }
  .ln-bub { fill: url(#lnBubG); stroke: rgba(255,255,255,0.42); stroke-width: 0.8; opacity: 0;
    filter: drop-shadow(0 4px 10px rgba(0,0,0,0.35)); }
  /* while it's being born the neck is the lens's colour, still wet from the footer */
  .ln-join.birth .ln-neck { background: color-mix(in srgb, var(--ln-tint, #fff) 34%, rgba(20,22,24,0.72)); }
  .ln-join.birth .ln-rim path { stroke: color-mix(in srgb, var(--ln-tint, #fff) 50%, rgba(255,255,255,0.5)); }
  /* birth: hidden until the footer answers, then the icons pour in as the bubble opens */
  .tabbar.ln-pre { opacity: 0; }
  .tabbar.ln-birth .tab { opacity: calc(var(--ln-born, 0) * 1.4 - 0.25); }
  .tabbar.ln-birth .lens { opacity: var(--ln-born, 0); }
`;

if (!customElements.get("eight-sleep-card")) {
  customElements.define("eight-sleep-card", EightSleepCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "eight-sleep-card",
    name: "Eight Sleep Card",
    description: "Eight Sleep Pod app-style temperature card",
    preview: false,
  });
  console.info(HELP, "color:#fff;background:#3f6bff;border-radius:3px", "color:#3f6bff");
}

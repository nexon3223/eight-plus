#!/usr/bin/env python3
"""
Backend detection against each integration's real unique-ID scheme.

    python3 tests/test_detect.py

  cloud      lukas-clarke/eight_sleep   "<device_id>.<user_id>.<key>", room sensors "<device_id>.<key>"
  freesleep  Mrtenz/hass-free-sleep     "<entry_id>_<side>_<key>", pod-level "<entry_id>_<key>"
  gateway    gateway/ (MQTT discovery)  "eight_pod_ctl_*", "eight_pod_bio_*", "eight_pod_wd_*"

Entity ids are deliberately renamed in places: detection must follow unique IDs, not entity ids.
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "eight_plus", "app"))
import detect as D  # noqa: E402

FAILS = []


def check(name, cond, detail=""):
    print(("ok  " if cond else "FAIL") + f"  {name}" + (f"  — {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


def ent(platform, entity_id, unique_id, disabled=False):
    return {"platform": platform, "entity_id": entity_id, "unique_id": unique_id,
            "disabled_by": "user" if disabled else None}


# ── lukas-clarke/eight_sleep ────────────────────────────────────────────────────────────
DEV, U1, U2 = "a1b2c3d4", "user0001", "user0002"
cloud = []
for user, name in ((U1, "alex"), (U2, "sam")):
    s = f"{name}_s_eight_sleep_side"
    cloud += [
        ent("eight_sleep", f"climate.{s}_climate", f"{DEV}.{user}.climate"),
        ent("eight_sleep", f"sensor.{s}_heart_rate", f"{DEV}.{user}.current_heart_rate"),
        ent("eight_sleep", f"sensor.{s}_hrv", f"{DEV}.{user}.current_hrv"),
        ent("eight_sleep", f"sensor.{s}_breath_rate", f"{DEV}.{user}.current_breath_rate"),
        ent("eight_sleep", f"sensor.{s}_bed_temperature", f"{DEV}.{user}.bed_temperature"),
        ent("eight_sleep", f"sensor.{s}_side", f"{DEV}.{user}.side"),
        ent("eight_sleep", f"sensor.{s}_bed_state", f"{DEV}.{user}.bed_state"),
        ent("eight_sleep", f"sensor.{s}_next_alarm", f"{DEV}.{user}.next_alarm"),
        ent("eight_sleep", f"binary_sensor.{s}_bed_presence", f"{DEV}.{user}.bed_presence"),
        # Pod 5 pillow: also a climate, must NOT be taken for the side's climate
        ent("eight_sleep", f"climate.{s}_pillow", f"{DEV}.{user}.pillow_climate"),
    ]
cloud += [
    ent("eight_sleep", "sensor.alex_example_com_s_eight_sleep_has_water", f"{DEV}.has_water"),
    ent("eight_sleep", "sensor.alex_example_com_s_eight_sleep_is_priming", f"{DEV}.is_priming"),
    ent("eight_sleep", "sensor.alex_example_com_s_eight_sleep_room_temperature", f"{DEV}.room_temperature"),
    ent("eight_sleep", "binary_sensor.base_snore", f"{DEV}.base.snore_mitigation"),
]
# alex's side sensor says "right": detection must put alex on the right
cloud_states = {"sensor.alex_s_eight_sleep_side_side": {"state": "right"},
                "sensor.sam_s_eight_sleep_side_side": {"state": "left"},
                "climate.alex_s_eight_sleep_side_climate": {"state": "heat_cool"},
                "climate.sam_s_eight_sleep_side_climate": {"state": "off"}}
hit = D.detect_cloud(cloud, cloud_states)
check("cloud: found", bool(hit))
if hit:
    r, l = hit["sides"].get("right", {}), hit["sides"].get("left", {})
    check("cloud: side sensor places alex right", r.get("climate") == "climate.alex_s_eight_sleep_side_climate", r)
    check("cloud: sam left", l.get("climate") == "climate.sam_s_eight_sleep_side_climate", l)
    check("cloud: pillow climate ignored", "pillow" not in str(hit["sides"]))
    for k in ("presence", "heart_rate", "hrv", "breath_rate", "bed_temp", "bed_state", "next_alarm", "side_sensor"):
        check(f"cloud: {k}", r.get(k, "").startswith(("sensor.alex", "binary_sensor.alex")), r.get(k))
    check("cloud: presence is the binary sensor", r.get("presence", "").startswith("binary_sensor."))
    check("cloud: has_water / is_priming", hit["shared"].get("has_water", "").endswith("_has_water")
          and hit["shared"].get("is_priming", "").endswith("_is_priming"), hit["shared"])
    full = D._mark_online(D.detect_cloud(cloud, cloud_states), cloud_states)
    check("cloud: online", full.get("online") is True)

# ── Mrtenz/hass-free-sleep ──────────────────────────────────────────────────────────────
E = "01JABCDEF"
fs = []
for side in ("left", "right"):
    fs += [
        ent("free_sleep", f"climate.pod_4_{side}_temperature", f"{E}_{side}_temperature"),
        ent("free_sleep", f"binary_sensor.pod_4_{side}_presence", f"{E}_{side}_bed_presence"),
        ent("free_sleep", f"sensor.pod_4_{side}_heart_rate", f"{E}_{side}_heart_rate"),
        ent("free_sleep", f"sensor.pod_4_{side}_hrv", f"{E}_{side}_hrv"),
        ent("free_sleep", f"sensor.pod_4_{side}_respiration_rate", f"{E}_{side}_respiration_rate"),
        ent("free_sleep", f"switch.pod_4_{side}_away_mode", f"{E}_{side}_away_mode"),
    ]
fs += [
    ent("free_sleep", "binary_sensor.pod_4_water_level", f"{E}_water_level"),
    ent("free_sleep", "binary_sensor.pod_4_priming", f"{E}_priming"),
    ent("free_sleep", "button.pod_4_prime", f"{E}_prime"),
    ent("free_sleep", "switch.pod_4_prime_daily", f"{E}_prime_daily"),
    ent("free_sleep", "switch.pod_4_biometrics", f"{E}_biometrics"),
    ent("free_sleep", "button.pod_4_reboot", f"{E}_reboot"),
]
# a user who renamed the left climate: still found by unique id
fs[0]["entity_id"] = "climate.bed_left"
hit = D.detect_freesleep(fs)
check("freesleep: found", bool(hit))
if hit:
    l, r = hit["sides"].get("left", {}), hit["sides"].get("right", {})
    check("freesleep: renamed climate followed", l.get("climate") == "climate.bed_left", l)
    check("freesleep: right climate", r.get("climate") == "climate.pod_4_right_temperature", r)
    for k, v in (("presence", "binary_sensor.pod_4_left_presence"), ("heart_rate", "sensor.pod_4_left_heart_rate"),
                 ("hrv", "sensor.pod_4_left_hrv"), ("breath_rate", "sensor.pod_4_left_respiration_rate"),
                 ("away_switch", "switch.pod_4_left_away_mode")):
        check(f"freesleep: {k}", l.get(k) == v, l.get(k))
    sh = hit["shared"]
    check("freesleep: water / priming / prime / biometrics",
          sh.get("water_low") == "binary_sensor.pod_4_water_level" and sh.get("priming") == "binary_sensor.pod_4_priming"
          and sh.get("prime_button") == "button.pod_4_prime" and sh.get("biometrics_toggle") == "switch.pod_4_biometrics", sh)
    check("freesleep: prime_daily not taken for prime", sh.get("prime_button") != "switch.pod_4_prime_daily")

# ── Eight+ Pod gateway ──────────────────────────────────────────────────────────────────
gw = []
for side in ("left", "right"):
    gw += [
        ent("mqtt", f"climate.eight_sleep_pod_{side}", f"eight_pod_ctl_{side}"),
        ent("mqtt", f"binary_sensor.eight_sleep_pod_{side}_presence", f"eight_pod_bio_{side}_present"),
        ent("mqtt", f"sensor.eight_sleep_pod_{side}_heart_rate", f"eight_pod_bio_{side}_heart_rate"),
        ent("mqtt", f"sensor.eight_sleep_pod_{side}_hrv", f"eight_pod_bio_{side}_hrv"),
        ent("mqtt", f"sensor.eight_sleep_pod_{side}_breathing_rate", f"eight_pod_bio_{side}_breathing_rate"),
        ent("mqtt", f"sensor.eight_sleep_pod_{side}_water_temp", f"eight_pod_bio_{side}_water_temp"),
    ]
gw += [
    ent("mqtt", "binary_sensor.eight_sleep_pod_water_low", "eight_pod_ctl_water_low"),
    ent("mqtt", "binary_sensor.eight_sleep_pod_priming", "eight_pod_ctl_priming"),
    ent("mqtt", "sensor.eight_sleep_pod_health", "eight_pod_wd_health"),
    ent("mqtt", "light.eight_sleep_pod_front_led", "eight_pod_led"),
    ent("mqtt", "light.unrelated", "something_else"),
]
hit = D.detect_gateway(gw)
check("gateway: found", bool(hit))
if hit:
    check("gateway: both sides", set(hit["sides"]) == {"left", "right"}, hit["sides"].keys())
    check("gateway: vitals + water temp", hit["sides"]["right"].get("water_temp") == "sensor.eight_sleep_pod_right_water_temp")
    check("gateway: health + led", hit["shared"].get("health") == "sensor.eight_sleep_pod_health"
          and hit["shared"].get("led") == "light.eight_sleep_pod_front_led", hit["shared"])
    check("gateway: ssh capable", hit["ssh_capable"] is True)

# ── all together, and nothing at all ────────────────────────────────────────────────────
both = D.detect_all(cloud + fs + gw, {})
check("detect_all: all three backends", all(both[k] for k in ("cloud", "freesleep", "gateway")))
none = D.detect_all([ent("hue", "light.x", "abc")], {})
check("detect_all: nothing on an unrelated install", not any(none.values()))
disabled = D.detect_gateway([dict(e, disabled_by="user") for e in gw])
check("disabled entities are ignored", disabled is None)

print("ALL GOOD" if not FAILS else f"{len(FAILS)} FAILED")
sys.exit(1 if FAILS else 0)

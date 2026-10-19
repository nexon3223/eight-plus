#!/usr/bin/env python3
"""The Pod app's proxy is the only thing between a phone on the LAN and Home Assistant —
check its call_service scoping directly (no network)."""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "eight_plus", "app"))
os.environ.pop("EIGHT_PLUS_DRY_RUN", None)
import detect as D  # noqa: E402
import generator as G  # noqa: E402
import standalone as SA  # noqa: E402

reg = json.load(open(os.path.join(ROOT, "tests", "fixtures", "registry.json")))
a = {"backend": "gateway", "bed": D.detect_all(reg, {})["gateway"],
     "sleepers": [{"name": "Alex", "side": "left", "notify": ""}],
     "room": {"weather": "weather.home", "temp": "sensor.bedroom_temperature"},
     "features": {"autopilot": True, "coach": True, "pipeline": True},
     "schedule": {"weekday_bed": "22:30", "weekday_wake": "07:00", "weekend_bed": "23:30", "weekend_wake": "08:30"}}
plan = G.build(a, "t")
scope = SA.Scope().load({"entities": plan["entities"], "cards": plan["cards"], "answers": a})
deny = SA.make_handler("/tmp", scope, {})._deny


def svc(domain, service, eid=None, target=None):
    m = {"type": "call_service", "domain": domain, "service": service, "service_data": {}}
    if eid:
        m["service_data"]["entity_id"] = eid
    if target:
        m["target"] = {"entity_id": target}
    return deny(m)


cases = [
    ("bed climate", svc("climate", "set_temperature", "climate.eight_sleep_pod_left"), None),
    ("both halves via target", svc("climate", "turn_on", target=["climate.eight_sleep_pod_left", "climate.eight_sleep_pod_right"]), None),
    ("own helper", svc("input_boolean", "turn_on", "input_boolean.eight_sleep_alex_smart_autopilot"), None),
    ("wind-down script", svc("script", "turn_on", "script.eight_sleep_alex_wind_down"), None),
    ("prime button", svc("button", "press", "button.eight_sleep_pod_prime"), None),
    ("restart HA", svc("homeassistant", "restart"), "deny"),
    ("stop HA", svc("homeassistant", "stop"), "deny"),
    ("a house light", svc("light", "turn_on", "light.kitchen"), "deny"),
    ("any switch", svc("switch", "turn_off", "switch.garage_door"), "deny"),
    ("mixed targets", svc("climate", "turn_off", ["climate.eight_sleep_pod_left", "climate.living_room"]), "deny"),
    ("no target", svc("input_boolean", "turn_on"), "deny"),
    ("some script", svc("script", "turn_on", "script.unlock_front_door"), "deny"),
    ("notify", svc("notify", "notify"), "deny"),
    ("lock", svc("lock", "unlock", "lock.front_door"), "deny"),
]
bad = []
for label, got, want in cases:
    ok = (got is None) if want is None else bool(got)
    print(f"{'ok ' if ok else 'BAD'} {label:24} -> {got or 'allowed'}")
    if not ok:
        bad.append(label)
for t in ("auth/current_user", "config/entity_registry/list", "execute_script", "fire_event", "render_template"):
    assert deny({"type": t}), t
m = {"type": "subscribe_entities", "entity_ids": ["light.kitchen", "climate.eight_sleep_pod_left"]}
assert deny(m) is None and m["entity_ids"] == ["climate.eight_sleep_pod_left"], m
h = {"type": "history/history_during_period", "entity_ids": ["lock.front_door"]}
assert deny(h), "history for a non-bed entity must be refused"
assert not bad, bad
print(f"ALL GOOD — {len(scope.entities)} entities in scope")

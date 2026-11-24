#!/usr/bin/env python3
"""
End-to-end: a free-sleep Pod, all the way through Eight+.

    python3 tests/e2e/e2e_freesleep.py --hass /path/to/venv/bin/hass \
        --free-sleep-src /path/to/hass-free-sleep/custom_components/free_sleep \
        [--units metric|us_customary] [--workdir DIR] [--keep]

What it does, with nothing mocked on the Home Assistant side:
  1. starts tests/e2e/fake_freesleep.py (the free-sleep server's HTTP API)
  2. starts a throwaway Home Assistant Core, onboards it with a generated test login, sets the
     unit system, and adds the REAL hass-free-sleep integration through its config flow
  3. starts the Eight+ add-on (writes for real into the throwaway config dir)
  4. runs the wizard's API: detect → preview → install (incl. the HA restart) for two sleepers
  5. checks: config valid, helpers/automations/dashboard exist, the bed's sensors resolve,
     then FIRES the bedtime automation and the notification "Warmer" action and asserts what the
     Pod actually received (°F on the wire, the right side, inside 55–110)
  6. bed presence on the Pod → HA presence → Eight+ in-bed sensor
  7. the add-on's sleep pipeline is running on the HA source

--keep leaves everything running and prints the HA URL + test login file, for a browser look
at the installed card.
"""
import argparse
import json
import os
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
APP = os.path.join(ROOT, "eight_plus", "app")
sys.path.insert(0, APP)

PROCS = []
FAILS = []


def say(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def check(ok, what, detail=""):
    say(("ok   " if ok else "FAIL ") + what + (f" — {detail}" if detail and not ok else ""))
    if not ok:
        FAILS.append(what + (f": {detail}" if detail else ""))
    return ok


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def http(method, url, body=None, token=None, form=False, timeout=30):
    data = None
    headers = {}
    if body is not None:
        if form:
            data = "&".join(f"{k}={urllib.request.quote(str(v))}" for k, v in body.items()).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        else:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        return json.loads(raw) if raw else None


def wait_for(fn, timeout, what, every=1.0):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            v = fn()
            if v:
                return v
        except Exception as e:  # noqa: BLE001
            last = e
        time.sleep(every)
    raise TimeoutError(f"timed out waiting for {what}" + (f" ({last!r})" if last else ""))


def start(cmd, log_path, env=None):
    f = open(log_path, "w")
    p = subprocess.Popen(cmd, stdout=f, stderr=subprocess.STDOUT, env={**os.environ, **(env or {})},
                         start_new_session=True)
    PROCS.append(p)
    return p


def stop_all():
    for p in PROCS:
        try:
            os.killpg(p.pid, signal.SIGTERM)
        except OSError:   # already gone (macOS says EPERM for an exited group)
            pass
    for p in PROCS:
        try:
            p.wait(timeout=20)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except OSError:
                pass


CONFIG_YAML = """\
homeassistant:
  name: Eight+ e2e
  time_zone: {tz}
  unit_system: {units}
  latitude: 40.7
  longitude: -74.0
  elevation: 10
http:
  server_host: 127.0.0.1
  server_port: {port}
frontend:
config:
api:
websocket_api:
lovelace:
history:
recorder:
  purge_keep_days: 2
logbook:
automation: !include automations.yaml
script: !include scripts.yaml
scene: !include scenes.yaml
input_boolean:
input_number:
input_datetime:
input_select:
input_text:
counter:
template:
person:
logger:
  default: warning
  logs:
    custom_components.free_sleep: info
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hass", required=True)
    ap.add_argument("--free-sleep-src", required=True)
    ap.add_argument("--units", default="metric", choices=("metric", "us_customary"))
    ap.add_argument("--workdir")
    ap.add_argument("--keep", action="store_true")
    a = ap.parse_args()

    work = a.workdir or os.path.join(ROOT, ".e2e", a.units)
    if os.path.exists(work):
        shutil.rmtree(work)
    cfg, data = os.path.join(work, "config"), os.path.join(work, "data")
    os.makedirs(os.path.join(cfg, "custom_components"))
    os.makedirs(data)
    shutil.copytree(a.free_sleep_src, os.path.join(cfg, "custom_components", "free_sleep"))
    ha_port, pod_port, addon_port = free_port(), free_port(), free_port()
    tz = time.strftime("%Z") and "Europe/London"
    open(os.path.join(cfg, "configuration.yaml"), "w").write(CONFIG_YAML.format(port=ha_port, units=a.units, tz=tz))
    for f in ("automations.yaml", "scripts.yaml", "scenes.yaml"):
        open(os.path.join(cfg, f), "w").write("[]\n" if f == "automations.yaml" else "{}\n")
    ha_url, pod_url, addon = f"http://127.0.0.1:{ha_port}", f"http://127.0.0.1:{pod_port}", f"http://127.0.0.1:{addon_port}"

    try:
        # ── 1. the Pod
        start([sys.executable, os.path.join(ROOT, "tests", "e2e", "fake_freesleep.py"), "--port", str(pod_port),
               "--model", "Pod 4", "--left-name", "Left", "--right-name", "Right"], os.path.join(work, "pod.log"))
        wait_for(lambda: http("GET", pod_url + "/api/deviceStatus"), 15, "fake Pod")
        say("fake free-sleep Pod 4 up", pod_url)

        # ── 2. Home Assistant
        # bare `hass` exits 100 on a restart request and expects a supervisor to start it again
        # (HA OS / the container do) — so does this loop
        start(["/bin/sh", "-c", 'while :; do "$0" -c "$1"; [ $? -eq 100 ] || break; done', a.hass, cfg],
              os.path.join(work, "hass.log"))
        say("starting Home Assistant", ha_url, f"({a.units}) — first start installs frontend deps, can take minutes")
        wait_for(lambda: http("GET", ha_url + "/api/onboarding"), 600, "Home Assistant", every=3)
        pw = secrets.token_urlsafe(18)
        login = {"username": "e2e", "password": pw, "url": ha_url}
        json.dump(login, open(os.path.join(work, "test-login.json"), "w"))
        os.chmod(os.path.join(work, "test-login.json"), 0o600)
        cid = ha_url + "/"
        r = http("POST", ha_url + "/api/onboarding/users",
                 {"client_id": cid, "name": "E2E", "username": "e2e", "password": pw, "language": "en"})
        tok = http("POST", ha_url + "/auth/token", {"grant_type": "authorization_code", "code": r["auth_code"],
                                                     "client_id": cid}, form=True)["access_token"]
        for step in ("core_config", "analytics"):
            try:
                http("POST", f"{ha_url}/api/onboarding/{step}", {}, token=tok)
            except urllib.error.HTTPError:
                pass
        os.environ.update(HA_URL=ha_url, HA_TOKEN=tok)
        from haclient import HA, endpoints
        ha = HA(endpoints(), log=lambda *x: None)
        ha.wait(30)
        llat = ha.call({"type": "auth/long_lived_access_token", "client_name": "eight-plus-e2e", "lifespan": 30})
        check(ha.config()["unit_system"]["temperature"] == ("°C" if a.units == "metric" else "°F"),
              f"HA unit system is {a.units}")

        # the real hass-free-sleep config flow
        flow = http("POST", ha_url + "/api/config/config_entries/flow", {"handler": "free_sleep"}, token=tok)
        res = http("POST", f"{ha_url}/api/config/config_entries/flow/{flow['flow_id']}",
                   {"host": pod_url, "update_interval": 5}, token=tok)
        check(res.get("type") == "create_entry", "hass-free-sleep config flow creates the entry", json.dumps(res)[:300])

        def climates():
            return [s for s in ha.states().values() if s["entity_id"].startswith("climate.") and s["state"] != "unavailable"]
        wait_for(lambda: len(climates()) >= 2, 60, "free-sleep climate entities")
        say("free-sleep entities:", ", ".join(sorted(s["entity_id"] for s in ha.states().values()
                                                     if s["entity_id"].split(".")[1].startswith("pod_4"))))

        # ── 3. the add-on, writing for real
        start([sys.executable, os.path.join(APP, "main.py")], os.path.join(work, "addon.log"),
              env={"CONFIG_DIR": cfg, "DATA_DIR": data, "HA_URL": ha_url, "HA_TOKEN": llat,
                   "INGRESS_PORT": str(addon_port), "EIGHT_PLUS_DEV": "1", "EIGHT_PLUS_DRY_RUN": "0"})
        wait_for(lambda: http("GET", addon + "/api/status"), 30, "Eight+ add-on")

        # ── 4. the wizard, through its API
        det = http("GET", addon + "/api/detect?fresh=1", timeout=60)
        fs = det["backends"].get("freesleep")
        check(bool(fs), "Eight+ detects free-sleep", json.dumps(det["backends"])[:300])
        if not fs:
            raise SystemExit(1)
        check(fs.get("online") is not False, "free-sleep detected as online")
        for side in ("left", "right"):
            sd = fs["sides"].get(side) or {}
            check(all(sd.get(k) for k in ("climate", "presence", "heart_rate", "hrv", "breath_rate")),
                  f"{side} side: climate, presence and vitals all found", json.dumps(sd))
        check(not det["backends"].get("gateway") and not det["backends"].get("cloud"), "no false-positive backends")
        say("notes:", fs.get("notes"))

        answers = {
            "backend": "freesleep", "bed": fs,
            "sleepers": [{"name": "Alex", "side": "left", "notify": "notify.mobile_app_e2e_phone"}, {"name": "Sam", "side": "right", "notify": ""}],
            "room": {"weather": "", "temp": "", "humidity": ""},
            "features": {"autopilot": True, "smart": False, "notifications": True, "pipeline": True},
            "schedule": {"weekday_bed": "22:30", "weekday_wake": "07:00", "weekend_bed": "23:30", "weekend_wake": "08:30"},
            "winddown_scene": "", "pipeline": {"source": "ha", "host": "", "port": 8822, "user": "root", "sudo": True},
            "dashboard": {"url_path": "eight-plus", "title": "Eight+"},
        }
        pre = http("POST", addon + "/api/preview", {"answers": answers}, timeout=60)
        check(not pre.get("collisions"), "preview: no entity collisions", str(pre.get("collisions")))
        say("preview warnings:", pre.get("warnings"))
        http("POST", addon + "/api/install", {"answers": answers, "standalone": False}, timeout=60)
        say("installing (Home Assistant will restart)…")

        def progress():
            try:
                p = http("GET", addon + "/api/progress", timeout=10)
            except Exception:  # noqa: BLE001 — HA restarting
                return None
            return p if (not p.get("running") and (p.get("done") or p.get("error"))) else None
        p = wait_for(progress, 600, "install", every=3)
        for s in p.get("steps", []):
            say(f"   [{s['status']}] {s['label']}" + (f" — {s['detail']}" if s.get("detail") else ""))
        if not check(p.get("done") and not p.get("error"), "install completes", p.get("error") or ""):
            raise SystemExit(1)

        os.environ["HA_TOKEN"] = llat   # fresh connection after the restart, on the long-lived token
        ha = HA(endpoints(), log=lambda *x: None)
        ha.wait(120)
        wait_for(lambda: len(climates()) >= 2, 120, "free-sleep back after restart")

        # ── 5. what got installed
        st = ha.states()
        cc = ha.check_config()
        check(cc.get("result") == "valid", "Home Assistant config check passes", json.dumps(cc)[:400])
        autos = [e for e in st if e.startswith("automation.") and "eight" in e]
        check(len(autos) >= 20, f"Eight+ automations loaded ({len(autos)})")
        unavailable = [e for e in autos if st[e]["state"] == "unavailable"]
        check(not unavailable, "no automation is unavailable (all parsed)", ", ".join(unavailable[:5]))
        for e in ("input_number.eight_sleep_alex_bedtime_level", "input_datetime.eight_sleep_alex_bedtime",
                  "input_boolean.eight_sleep_alex_smart_autopilot", "binary_sensor.eight_sleep_alex_in_bed",
                  "sensor.eight_sleep_alex_bed_temperature", "input_number.eight_sleep_sam_bedtime_level",
                  "binary_sensor.eight_plus_water_low", "binary_sensor.eight_plus_priming"):
            check(e in st, f"exists: {e}")
        bt = st.get("sensor.eight_sleep_alex_bed_temperature", {}).get("state")
        check(bt not in (None, "unknown", "unavailable"), "bed temperature sensor has a value", str(bt))
        dash = ha.call({"type": "lovelace/config", "url_path": "eight-plus"})
        card = dash["views"][0]["cards"][0]
        check(card.get("source") == "freesleep" and card.get("entity") == fs["sides"]["left"]["climate"],
              "dashboard card points at the free-sleep climate", json.dumps({k: card.get(k) for k in ("source", "entity")}))
        res = ha.call({"type": "lovelace/resources"})
        check(any("eight-sleep-card" in r["url"] for r in res), "card resource registered")
        say("Alex's bed temperature:", bt, st.get("sensor.eight_sleep_alex_bed_temperature", {}).get("attributes", {}).get("unit_of_measurement"))

        # ── 5b. fire bedtime for real: the Autopilot schedule automation at the bedtime phase
        unit = ha.config()["unit_system"]["temperature"]
        lvl_c = float(st["input_number.eight_sleep_alex_bedtime_level"]["state"])
        http("POST", pod_url + "/_reset_log", {})
        # HA's clock, not this machine's (they can be in different time zones)
        req = urllib.request.Request(ha_url + "/api/template", method="POST",
                                     data=json.dumps({"template": "{{ (now() + timedelta(seconds=20)).strftime('%H:%M:%S') }}"}).encode(),
                                     headers={"Authorization": f"Bearer {llat}", "Content-Type": "application/json"})
        when = urllib.request.urlopen(req, timeout=10).read().decode().strip()
        ha.service("input_datetime", "set_datetime", {"time": when},
                   {"entity_id": "input_datetime.eight_sleep_alex_bedtime"})
        say(f"bedtime moved to {when} (HA time) — waiting for the automation…")
        time.sleep(35)
        log = http("GET", pod_url + "/_log")
        left = [x for x in log if x["path"] == "/api/deviceStatus" and "left" in x["body"]]
        rejected = [x for x in log if x.get("rejected")]
        check(not rejected, "Pod rejected nothing", json.dumps(rejected)[:300])
        on = any(x["body"]["left"].get("isOn") is True for x in left)
        temps = [x["body"]["left"]["targetTemperatureF"] for x in left if "targetTemperatureF" in x["body"]["left"]]
        want_f = lvl_c * 9 / 5 + 32
        check(on, "bedtime turned Alex's side ON at the Pod", json.dumps(log)[:300])
        check(bool(temps) and abs(temps[-1] - want_f) <= 1.0,
              f"bedtime level {lvl_c}°C reached the Pod as ~{want_f:.1f}°F", f"Pod got {temps}")
        check(not any("right" in x["body"] for x in log if x["path"] == "/api/deviceStatus"),
              "Sam's side untouched (dual mode)")
        cl = ha.states()[fs["sides"]["left"]["climate"]]
        check(cl["state"] == "heat_cool", "HA climate shows the side on", cl["state"])
        say("HA climate:", cl["state"], cl["attributes"].get("temperature"), unit)

        # ── 5c. the notification "Warmer" button: +1 degree in HA's unit, through the generated automation
        before = float(cl["attributes"]["temperature"])
        http("POST", pod_url + "/_reset_log", {})
        ha.call({"type": "fire_event", "event_type": "mobile_app_notification_action",
                 "event_data": {"action": "EP_ALEX_WARMER"}})
        time.sleep(8)
        log = http("GET", pod_url + "/_log")
        temps = [x["body"]["left"]["targetTemperatureF"] for x in log
                 if x["path"] == "/api/deviceStatus" and "targetTemperatureF" in (x["body"].get("left") or {})]
        if temps:
            got = temps[-1]
            before_f = before if unit == "°F" else before * 9 / 5 + 32
            check(0.4 <= got - before_f <= 2.5, "Warmer raised the Pod ~1°", f"{before_f:.1f}°F → {got}°F")
        else:
            check(False, "Warmer reached the Pod", json.dumps(log)[:300])

        # ── 6. presence: someone gets into Alex's side
        http("POST", pod_url + "/_presence", {"left": True})
        pres = fs["sides"]["left"]["presence"]
        wait_for(lambda: ha.states()[pres]["state"] == "on", 30, "HA presence on")
        check(True, "Pod presence → HA presence")
        hr = fs["sides"]["left"]["heart_rate"]
        wait_for(lambda: ha.states()[hr]["state"] not in ("unknown", "unavailable", "0"),
                 30, "heart rate")
        check(True, "vitals flow while in bed")
        try:
            wait_for(lambda: ha.states()["binary_sensor.eight_sleep_alex_in_bed"]["state"] == "on",
                     480, "Eight+ in-bed", every=5)   # ≥40 % of the last 15 min ≈ 6 min in bed
            check(True, "Eight+ in-bed sensor follows (after its debounce)")
        except TimeoutError as e:
            check(False, "Eight+ in-bed sensor follows", str(e))

        # ── 7. the sleep pipeline
        stt = http("GET", addon + "/api/status")
        sl = stt.get("sleep") or {}
        check(sl.get("enabled") and not sl.get("last_error"), "sleep pipeline running", json.dumps(sl)[:300])

        say("")
        say("RESULT:", "ALL GOOD" if not FAILS else f"{len(FAILS)} failure(s)")
        for f in FAILS:
            say("  -", f)
        if a.keep:
            say(f"left running — Home Assistant {ha_url}/eight-plus, login in {os.path.join(work, 'test-login.json')}")
            say("Ctrl-C to stop")
            signal.pause()
        return 1 if FAILS else 0
    finally:
        if not a.keep:
            stop_all()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        stop_all()
        sys.exit(130)

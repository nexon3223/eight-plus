#!/usr/bin/env python3
"""
es-watchdog -- on-Pod health monitor + self-repair for the Eight Sleep Pod 3
(stock firmware + es-franken-proxy + es-biometrics tap).

Why it exists (2026-09-25 incident): at 07:32 AEST frankenfirmware hung. A new
frank came up 15 min later and the bed-sensor side recovered, but the Frozen MCU
(pumps + TECs) never did. MQTT stayed connected, HA showed every entity healthy,
commands were accepted and silently went nowhere, and it took a manual reboot
2h20m later to fix it. Nothing noticed, and the journal that would have said why
was lost with the unclean shutdown.

So this service:
  * checks every layer each POLL seconds -- systemd units, the Frozen + Sensor
    MCUs (by the age of their records in the RAW stream frank writes), the
    frank<->dac<->proxy control link, capybara's heartbeat, clock sync / steps,
    MQTT, disk, memory, board temperature, water + priming;
  * repairs with an escalating ladder: restart the unit -> restart the control
    stack -> reboot the Pod, with cooldowns and a persisted reboot budget so it
    can never boot-loop;
  * snapshots the relevant journals to /persistent before every repair, so the
    evidence survives even if the journal doesn't;
  * publishes one `sensor.eight_sleep_pod_health` (state + a per-check list in
    its attributes) and Reboot / Restart-control buttons + an Auto-repair switch
    over MQTT discovery on the existing "Eight Sleep Pod" device.

Read-only towards frank/dac: it never touches the control socket beyond the
proxy's own status call; repairs are plain `systemctl` actions.
"""
import glob
import io
import json
import os
import socket
import subprocess
import threading
import time

try:
    import cbor2
except ImportError:  # still useful without it: unit/link/clock checks all work
    cbor2 = None
try:
    import paho.mqtt.client as mqtt
except ImportError:
    mqtt = None

VERSION = "1.0.0"
POLL = 15                                   # s between checks
DATA_DIR = "/persistent/es-watchdog"
INCIDENT_DIR = f"{DATA_DIR}/incidents"
STATE_FILE = f"{DATA_DIR}/state.json"
EVENTS_FILE = f"{DATA_DIR}/events.jsonl"
KEEP_INCIDENTS = 40
RAW_DIR = "/persistent"
HEARTBEAT = "/persistent/frozen.heartbeat"
CTL_SOCK = "/run/es-franken-ctl.sock"

# MQTT broker — /etc/eight-plus/gateway.conf (KEY=value lines, written by gateway/install.sh),
# overridable by MQTT_* environment variables.
def _gateway_conf(path="/etc/eight-plus/gateway.conf"):
    c = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    c[k.strip()] = v.strip().strip('"')
    except OSError:
        pass
    c.update({k: v for k, v in os.environ.items() if k.startswith("MQTT_")})
    return c


_GW = _gateway_conf()
MQTT_HOST = _GW.get("MQTT_HOST", "homeassistant.local")
MQTT_PORT = int(_GW.get("MQTT_PORT", "1883"))
MQTT_USER = _GW.get("MQTT_USER", "")
MQTT_PASS = _GW.get("MQTT_PASS", "")
DISC = "homeassistant"
NODE = "eight_pod_wd"
BASE = "eightpod/wd"
AVAIL_T = f"{BASE}/availability"
STATE_T = f"{BASE}/state"
ATTR_T = f"{BASE}/attributes"
CMD_T = f"{BASE}/cmd"
DEVICE = {"identifiers": ["eight_sleep_pod_local"], "name": "Eight Sleep Pod",
          "manufacturer": "Eight Sleep", "model": "Pod 3 (stock + local control)"}

# --- thresholds -------------------------------------------------------------------
STALE_WARN, STALE_BAD = 60, 120             # s since the last Frozen / Sensor record
LINK_WARN, LINK_BAD = 15, 90                # s since the proxy's last var dump from frank
HB_BAD = 30                                 # s capybara's frozen.heartbeat may lag
PRIME_LONG = 2.5 * 3600                     # daily prime here runs ~1h45m (purge check never passes)
BOOT_GRACE = 300                            # s of uptime before we repair anything
START_GRACE = 90                            # s after this service starts
ESCALATE_AFTER = 240                        # s a repair gets before we go one rung up
UNIT_RESTART_COOLDOWN = 300
REBOOT_MIN_GAP = 30 * 60
REBOOTS_PER_DAY = 3

# systemd units we expect active. crit=True -> can take temperature control down.
UNITS = [
    # id,                 label,                     group,      crit,  restartable
    ("frank",              "Firmware (frank)",        "Control",  True,  True),
    ("es-franken-proxy",   "Control proxy",           "Control",  True,  True),
    ("dac",                "Device client (dac)",     "System",   True,  True),
    ("capybara",           "Supervisor (capybara)",   "System",   True,  False),  # never restart: owns I2C power
    ("frozen-heartbeat",   "Frozen heartbeat feeder", "System",   True,  True),
    ("fake-hwclock",       "Clock keeper",            "System",   False, True),
    ("es-biometrics",      "Biometrics stream",       "Services", False, True),
    ("es-biometrics-mqtt", "Biometrics → HA",         "Services", False, True),
    ("es-led",             "Front light",             "Services", False, True),
    ("es-pod-webui",       "Pod web UI",              "Services", False, True),
]


def log(*a):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)


def sh(cmd, timeout=20):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout.strip()
    except Exception as e:  # noqa: BLE001
        return -1, str(e)


def uptime():
    try:
        return float(open("/proc/uptime").read().split()[0])
    except Exception:  # noqa: BLE001
        return 1e9


# --- persisted state (survives reboots: reboot budget, auto-repair flag) -------
def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return {"auto_repair": True, "reboots": []}


def save_state(st):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f)
    os.replace(tmp, STATE_FILE)


def event(kind, **kw):
    """Append to the persistent event log (repairs, clock steps, reboots)."""
    rec = {"ts": int(time.time()), "kind": kind, **kw}
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        if os.path.exists(EVENTS_FILE) and os.path.getsize(EVENTS_FILE) > 512 * 1024:
            lines = open(EVENTS_FILE).read().splitlines()[-500:]
            open(EVENTS_FILE, "w").write("\n".join(lines) + "\n")
        with open(EVENTS_FILE, "a") as f:
            f.write(json.dumps(rec) + "\n")
    except Exception as e:  # noqa: BLE001
        log("event write failed", e)
    log("EVENT", json.dumps(rec))
    return rec


def snapshot(reason):
    """Save the journals that explain a failure to /persistent BEFORE we act.
    (On 2026-09-25 the only copy of frank's logs was lost with the reboot.)"""
    try:
        os.makedirs(INCIDENT_DIR, exist_ok=True)
        path = f"{INCIDENT_DIR}/{time.strftime('%Y%m%d-%H%M%S')}-{reason}.log"
        parts = [("status", ["systemctl", "--no-pager", "status", "frank", "dac", "capybara", "es-franken-proxy"]),
                 ("time", ["timedatectl"]),
                 ("journal", ["journalctl", "--no-pager", "-o", "short-iso", "--since", "-20min",
                              "-u", "frank", "-u", "dac", "-u", "capybara", "-u", "es-franken-proxy",
                              "-u", "systemd-timesyncd", "-u", "es-watchdog"]),
                 ("dac(user)", ["journalctl", "--no-pager", "-o", "short-iso", "--since", "-20min", "_COMM=node"]),
                 ("kernel", ["journalctl", "--no-pager", "-k", "--since", "-20min"])]
        with open(path, "w") as f:
            for name, cmd in parts:
                f.write(f"===== {name}: {' '.join(cmd)}\n")
                f.write(sh(cmd, timeout=30)[1][-400_000:] + "\n")
        files = sorted(glob.glob(f"{INCIDENT_DIR}/*.log"))
        for old in files[:-KEEP_INCIDENTS]:
            os.unlink(old)
        return os.path.basename(path)
    except Exception as e:  # noqa: BLE001
        log("snapshot failed", e)
        return None


# --- probes -------------------------------------------------------------------------
class RawTail:
    """Newest-record timestamps per type from the RAW stream frank writes.
    frzTemp = Frozen MCU (pumps/TECs/water temps); bedTemp + capSense = Sensor MCU."""

    def __init__(self):
        self.seen = {}          # type -> latest ts
        self.frz = None         # latest frzTemp record
        self.bed = None
        self._sig = None

    def poll(self):
        files = [f for f in glob.glob(f"{RAW_DIR}/*.RAW") if not f.endswith("SEQNO.RAW")]
        if not files or cbor2 is None:
            return
        path = max(files, key=os.path.getmtime)
        st = os.stat(path)
        sig = (path, st.st_size, st.st_mtime)
        if sig == self._sig:
            return
        self._sig = sig
        try:
            with open(path, "rb") as f:
                buf = io.BytesIO(f.read())
        except OSError:
            return
        while True:
            try:
                row = cbor2.load(buf)
            except Exception:  # noqa: BLE001 - end of file / partial trailing record
                break
            if not isinstance(row, dict) or not row.get("data"):
                continue
            try:
                d = cbor2.loads(row["data"])
            except Exception:  # noqa: BLE001
                continue
            if not isinstance(d, dict):
                continue
            t, ts = d.get("type"), d.get("ts")
            if not isinstance(ts, (int, float)):
                continue
            if ts >= self.seen.get(t, 0):
                self.seen[t] = ts
                if t == "frzTemp":
                    self.frz = d
                elif t == "bedTemp":
                    self.bed = d

    def age(self, *types):
        ts = max((self.seen.get(t, 0) for t in types), default=0)
        return (time.time() - ts) if ts else None


def proxy_status():
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(3)
        s.connect(CTL_SOCK)
        s.sendall(b'{"cmd":"status"}\n')
        buf = b""
        while b"\n" not in buf:
            d = s.recv(4096)
            if not d:
                break
            buf += d
        s.close()
        return json.loads(buf.decode())
    except Exception:  # noqa: BLE001
        return None


def unit_states(names):
    _, out = sh(["systemctl", "is-active", *names])
    vals = out.splitlines()
    return {n: (vals[i] if i < len(vals) else "unknown") for i, n in enumerate(names)}


def fmt_age(sec):
    if sec is None:
        return "never"
    sec = int(sec)
    if sec < 90:
        return f"{sec}s ago"
    if sec < 5400:
        return f"{sec // 60} min ago"
    return f"{sec // 3600}h {sec % 3600 // 60}m ago"


# --- the watchdog ------------------------------------------------------------------
class Watchdog:
    def __init__(self):
        self.st = load_state()
        self.st.setdefault("auto_repair", True)
        self.st.setdefault("reboots", [])
        self.raw = RawTail()
        self.started = time.monotonic()
        self.checks = {}          # id -> dict(label, group, s, detail, since, crit)
        self.bad_since = {}       # problem key -> monotonic
        self.ladder = {}          # problem key -> {"rung": n, "at": monotonic}
        self.last_action = None
        self.unit_kicks = {}      # unit -> [monotonic,...]
        self.clock_off = time.time() - time.monotonic()
        self.clock_step = None    # (wall ts, seconds)
        self.rebooting = False
        self.prime_start = None
        self.proxy = None
        self.cli = None
        self.connected = False
        self._last_pub = None
        self._last_pub_t = 0
        self.lock = threading.Lock()

    # ---------- checks
    def put(self, cid, label, group, s, detail, crit=False):
        prev = self.checks.get(cid)
        since = prev["since"] if prev and prev["s"] == s else int(time.time())
        self.checks[cid] = {"id": cid, "label": label, "group": group, "s": s,
                            "detail": detail, "since": since, "crit": crit}

    def run_checks(self):
        now = time.time()
        # clock: detect wall-clock steps (frank has hung on these before)
        off = now - time.monotonic()
        step = off - self.clock_off
        self.clock_off = off
        if abs(step) > 2:
            self.clock_step = (int(now), round(step, 1))
            event("clock_step", seconds=round(step, 1))
            self.raw.seen = {k: v + step for k, v in self.raw.seen.items()}
        _, sync = sh(["timedatectl", "show", "-p", "NTPSynchronized", "--value"])
        recent_step = self.clock_step and now - self.clock_step[0] < 1800
        if recent_step:
            self.put("clock", "Clock", "System", "warn",
                     f"jumped {self.clock_step[1]:+.0f}s at {time.strftime('%H:%M', time.localtime(self.clock_step[0]))} UTC")
        elif sync != "yes":
            self.put("clock", "Clock", "System", "warn", "not synced to NTP")
        else:
            self.put("clock", "Clock", "System", "ok", "synced")

        # units
        us = unit_states([u[0] for u in UNITS])
        for uid, label, group, crit, _r in UNITS:
            v = us.get(uid, "unknown")
            s = "ok" if v == "active" else "warn" if v in ("activating", "reloading") else "bad"
            self.put("unit:" + uid, label, group, s, v, crit)

        # MCUs via the RAW stream
        self.raw.poll()
        frank_on = us.get("frank") == "active"
        for cid, label, types, detail_ok in (
                ("frozen", "Temperature control", ("frzTemp",), None),
                ("sensor", "Bed sensors", ("bedTemp", "capSense"), None)):
            a = self.raw.age(*types)
            if a is None:
                s, d = ("warn", "no data yet") if cbor2 else ("off", "cbor2 missing")
            elif a < STALE_WARN:
                s, d = "ok", "reporting"
            elif a < STALE_BAD:
                s, d = "warn", f"quiet · last {fmt_age(a)}"
            else:
                s, d = "bad", f"silent · last {fmt_age(a)}"
            if cid == "frozen" and s == "ok" and self.raw.frz:
                f = self.raw.frz
                d = f"{f['left'] / 100:.0f}° · {f['right'] / 100:.0f}° · sink {f['hs'] / 100:.0f}°"
            self.put(cid, label, "Control", s, d, True)

        # control link: HA/MQTT -> proxy -> frank
        ps = proxy_status()
        self.proxy = ps
        if ps is None:
            self.put("link", "Control link", "Control", "bad", "proxy not answering", True)
        elif not ps.get("frank_connected"):
            self.put("link", "Control link", "Control", "bad", "firmware not connected", True)
        else:
            va = ps.get("vars_age")
            if "vars_age" not in ps:             # older proxy without freshness tracking
                self.put("link", "Control link", "Control", "ok", "firmware connected", True)
            elif va is None:
                self.put("link", "Control link", "Control", "warn", "waiting for first status", True)
            elif va < LINK_WARN:
                self.put("link", "Control link", "Control", "ok", "firmware answering", True)
            elif va < LINK_BAD:
                self.put("link", "Control link", "Control", "warn", f"slow · {fmt_age(va)}", True)
            else:
                self.put("link", "Control link", "Control", "bad", f"no reply · {fmt_age(va)}", True)
        if ps is not None:
            self.put("mqtt_proxy", "Proxy ↔ Home Assistant", "Services",
                     "ok" if ps.get("mqtt_connected") else "bad",
                     "connected" if ps.get("mqtt_connected") else "MQTT disconnected")
        self.put("mqtt", "Watchdog ↔ Home Assistant", "Services",
                 "ok" if self.connected else "bad", "connected" if self.connected else "MQTT disconnected")

        # capybara's frozen heartbeat
        try:
            hb = time.time() - int(open(HEARTBEAT).read().strip())
            self.put("heartbeat", "Frozen heartbeat", "System",
                     "ok" if hb < HB_BAD else "bad", "fresh" if hb < HB_BAD else f"{int(hb)}s old", True)
        except Exception:  # noqa: BLE001
            self.put("heartbeat", "Frozen heartbeat", "System", "bad", "missing", True)

        # water / priming (from the proxy's var dump)
        if ps is not None:
            if ps.get("water_low"):
                self.put("water", "Water tank", "Water", "bad", "low — add water")
            else:
                self.put("water", "Water tank", "Water", "ok", "full")
            if ps.get("priming"):
                self.prime_start = self.prime_start or now
                dur = now - self.prime_start
                self.put("priming", "Priming", "Water", "warn" if dur > PRIME_LONG else "ok",
                         f"priming · {int(dur // 600) * 10}+ min" if dur >= 600 else "priming")
            else:
                self.prime_start = None
                self.put("priming", "Priming", "Water", "ok", "idle")

        # resources
        try:
            sv = os.statvfs("/")
            free_gb = sv.f_bavail * sv.f_frsize / 1e9
            self.put("disk", "Storage", "Resources", "ok" if free_gb > 1 else "warn" if free_gb > 0.3 else "bad", f"{free_gb:.1f} GB free")
        except OSError:
            pass
        try:
            mi = {l.split(":")[0]: int(l.split()[1]) for l in open("/proc/meminfo")}
            av = mi.get("MemAvailable", 0) / 1024
            self.put("memory", "Memory", "Resources", "ok" if av > 300 else "warn" if av > 120 else "bad",
                     f"{av / 1024:.1f} GB free" if av > 1024 else f"{av:.0f} MB free")
        except Exception:  # noqa: BLE001
            pass
        if self.raw.bed:
            mcu = self.raw.bed.get("mcu", 0) / 100
            self.put("board", "Board temperature", "Resources", "ok" if mcu < 65 else "warn" if mcu < 75 else "bad", f"{mcu:.0f}°C")

    # ---------- repair
    def can_reboot(self):
        now = time.time()
        rb = [t for t in self.st["reboots"] if now - t < 86400]
        self.st["reboots"] = rb
        if rb and now - rb[-1] < REBOOT_MIN_GAP:
            return False, "rebooted < 30 min ago"
        if len(rb) >= REBOOTS_PER_DAY:
            return False, f"{len(rb)} reboots in 24h — holding off"
        return True, ""

    def reboot(self, reason, manual=False):
        snap = snapshot("reboot-" + reason)
        self.st["reboots"].append(time.time())
        save_state(self.st)
        self.last_action = event("reboot", reason=reason, manual=manual, snapshot=snap)
        self.rebooting = True
        self.publish(force=True)
        time.sleep(2)
        sh(["systemctl", "reboot"])

    def kick_unit(self, uid, reason):
        now = time.monotonic()
        k = [t for t in self.unit_kicks.get(uid, []) if now - t < 3600]
        if k and now - k[-1] < UNIT_RESTART_COOLDOWN:
            return False
        k.append(now)
        self.unit_kicks[uid] = k
        snap = snapshot(f"restart-{uid}")
        rc, out = sh(["systemctl", "restart", uid], timeout=60)
        self.last_action = event("restart", unit=uid, reason=reason, rc=rc, snapshot=snap)
        return True

    def restart_control(self, reason):
        """proxy first (it owns frank's socket), then frank (it only dials at startup)."""
        snap = snapshot("control-" + reason)
        sh(["systemctl", "restart", "es-franken-proxy"], timeout=60)
        time.sleep(3)
        rc, _ = sh(["systemctl", "restart", "frank"], timeout=90)
        self.last_action = event("restart_control", reason=reason, rc=rc, snapshot=snap)

    def repair(self):
        if not self.st.get("auto_repair", True):
            return
        if uptime() < BOOT_GRACE or time.monotonic() - self.started < START_GRACE:
            return
        now = time.monotonic()
        c = self.checks

        def bad(cid):
            return c.get(cid, {}).get("s") == "bad"

        # which problem is the most fundamental right now? (one action per cycle)
        problem = None
        if bad("unit:capybara"):
            problem = ("capybara", "reboot")
        elif bad("unit:frank") or bad("unit:es-franken-proxy") or bad("unit:dac"):
            problem = ("control_units", "control")
        elif bad("sensor"):
            problem = ("sensor_silent", "control")          # frank hung / not writing RAW
        elif bad("frozen"):
            problem = ("frozen_silent", "control")          # the 2026-09-25 failure
        elif bad("link"):
            problem = ("link_down", "control")
        elif bad("heartbeat"):
            problem = ("heartbeat", "unit:frozen-heartbeat")
        else:
            for uid, _l, _g, _c, restartable in UNITS:
                if restartable and bad("unit:" + uid):
                    problem = ("unit_" + uid, "unit:" + uid)
                    break

        # forget problems that cleared
        for k in list(self.bad_since):
            if not problem or problem[0] != k:
                if k in self.ladder:
                    event("recovered", problem=k)
                self.bad_since.pop(k, None)
                self.ladder.pop(k, None)
        if not problem:
            return
        key, first = problem
        self.bad_since.setdefault(key, now)
        if now - self.bad_since[key] < 45:        # must persist 3 polls before we act
            return
        rung = self.ladder.get(key)
        if rung is None:
            if first == "reboot":
                ok, why = self.can_reboot()
                if ok:
                    self.reboot(key)
                else:
                    self.ladder[key] = {"rung": 9, "at": now}
                    event("reboot_blocked", problem=key, why=why)
                return
            if first == "control":
                self.restart_control(key)
            elif first.startswith("unit:"):
                self.kick_unit(first[5:], key)
            self.ladder[key] = {"rung": 1, "at": now}
            return
        if rung["rung"] == 1 and now - rung["at"] > ESCALATE_AFTER:
            crit = key in ("control_units", "sensor_silent", "frozen_silent", "link_down", "heartbeat") \
                or any(key == "unit_" + u[0] and u[3] for u in UNITS)
            if not crit:
                self.ladder[key] = {"rung": 9, "at": now}   # non-critical: stay flagged, no reboot
                return
            ok, why = self.can_reboot()
            if ok:
                self.reboot(key)
            else:
                self.ladder[key] = {"rung": 9, "at": now}
                event("reboot_blocked", problem=key, why=why)

    # ---------- summary
    def summary(self):
        if self.rebooting:
            return "rebooting", "Restarting the Pod"
        vals = list(self.checks.values())
        crit_bad = [c for c in vals if c["s"] == "bad" and c["crit"]]
        recovering = any(r["rung"] == 1 for r in self.ladder.values())
        if crit_bad:
            head = crit_bad[0]
            if recovering:
                return "recovering", f"Repairing: {head['label'].lower()}"
            return "error", f"{head['label']}: {head['detail']}"
        other = [c for c in vals if c["s"] in ("bad", "warn")]
        if other:
            return "degraded", f"{other[0]['label']}: {other[0]['detail']}"
        return "ok", "All systems normal"

    # ---------- MQTT
    def mqtt_start(self):
        if mqtt is None:
            log("paho missing -- MQTT disabled")
            return
        c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="es-watchdog")
        if MQTT_USER:
            c.username_pw_set(MQTT_USER, MQTT_PASS)
        c.will_set(AVAIL_T, "offline", retain=True)
        c.on_connect = self._on_connect
        c.on_disconnect = self._on_disconnect
        c.on_message = self._on_msg
        c.reconnect_delay_set(2, 30)
        c.connect_async(MQTT_HOST, MQTT_PORT, keepalive=30)
        c.loop_start()
        self.cli = c

    def _disc(self):
        base = {"device": DEVICE, "availability_topic": AVAIL_T}
        yield "sensor", "health", {
            **base, "name": "Health", "icon": "mdi:heart-pulse", "state_topic": STATE_T,
            "value_template": "{{ value_json.state }}", "json_attributes_topic": ATTR_T,
            "device_class": "enum", "options": ["ok", "degraded", "recovering", "error", "rebooting"]}
        yield "sensor", "health_summary", {
            **base, "name": "Health summary", "icon": "mdi:text-box-check-outline", "state_topic": STATE_T,
            "value_template": "{{ value_json.summary[:250] }}", "entity_category": "diagnostic"}
        yield "button", "reboot", {
            **base, "name": "Reboot", "icon": "mdi:restart", "command_topic": f"{CMD_T}/reboot",
            "payload_press": "PRESS", "device_class": "restart", "entity_category": "config"}
        yield "button", "restart_control", {
            **base, "name": "Restart control", "icon": "mdi:swap-horizontal", "command_topic": f"{CMD_T}/restart_control",
            "payload_press": "PRESS", "entity_category": "config"}
        yield "switch", "auto_repair", {
            **base, "name": "Auto repair", "icon": "mdi:auto-fix", "command_topic": f"{CMD_T}/auto_repair",
            "state_topic": STATE_T, "value_template": "{{ 'ON' if value_json.auto_repair else 'OFF' }}",
            "entity_category": "config"}

    def _on_connect(self, c, u, f, rc, p=None):
        if rc != 0:
            return
        self.connected = True
        log("mqtt connected")
        for comp, key, cfg in self._disc():
            cfg = {"unique_id": f"{NODE}_{key}", "default_entity_id": f"{comp}.eight_sleep_pod_{key}", **cfg}
            c.publish(f"{DISC}/{comp}/{NODE}/{key}/config", json.dumps(cfg), retain=True)
        c.publish(AVAIL_T, "online", retain=True)
        c.subscribe(f"{CMD_T}/+")
        self.publish(force=True)

    def _on_disconnect(self, *a):
        self.connected = False

    def _on_msg(self, c, u, msg):
        key = msg.topic.rsplit("/", 1)[-1]
        val = msg.payload.decode("utf-8", "replace").strip()
        log(f"cmd {key} <- {val!r}")
        # act on a worker thread: never block paho's network loop
        if key == "reboot":
            threading.Thread(target=self.reboot, args=("manual",), kwargs={"manual": True}, daemon=True).start()
        elif key == "restart_control":
            threading.Thread(target=self.restart_control, args=("manual",), daemon=True).start()
        elif key == "auto_repair":
            self.st["auto_repair"] = val.upper() == "ON"
            save_state(self.st)
            event("auto_repair", on=self.st["auto_repair"])
            self.publish(force=True)

    def publish(self, force=False):
        if not (self.cli and self.connected):
            return
        state, summary = self.summary()
        order = {"Control": 0, "System": 1, "Water": 2, "Services": 3, "Resources": 4}
        checks = sorted(self.checks.values(), key=lambda c: (order.get(c["group"], 9), not c["crit"]))
        try:
            lines = open(EVENTS_FILE).read().splitlines()[-8:]
            recent = [json.loads(l) for l in lines]
        except Exception:  # noqa: BLE001
            recent = []
        now = time.time()
        attrs = {
            "summary": summary,
            "checks": [{k: c[k] for k in ("id", "label", "group", "s", "detail", "since", "crit")} for c in checks],
            "auto_repair": self.st.get("auto_repair", True),
            "reboots_24h": len([t for t in self.st["reboots"] if now - t < 86400]),
            "events": recent,
            "booted_at": int(now - uptime()) // 60 * 60,
            "version": VERSION,
        }
        body = {"state": state, "summary": summary, "auto_repair": attrs["auto_repair"]}
        sig = json.dumps([body, [(c["id"], c["s"], c["detail"]) for c in checks], recent], sort_keys=True)
        if not force and sig == self._last_pub and now - self._last_pub_t < 60:
            return
        self._last_pub, self._last_pub_t = sig, now
        self.cli.publish(ATTR_T, json.dumps(attrs), retain=True)
        self.cli.publish(STATE_T, json.dumps(body), retain=True)

    # ---------- main
    def loop(self):
        os.makedirs(INCIDENT_DIR, exist_ok=True)
        event("start", version=VERSION, uptime=int(uptime()))
        self.mqtt_start()
        while True:
            t0 = time.monotonic()
            try:
                with self.lock:
                    self.run_checks()
                    if not self.rebooting:
                        self.repair()
                    self.publish()
            except Exception as e:  # noqa: BLE001 -- the watchdog must never die of a probe bug
                log("cycle error:", repr(e))
            time.sleep(max(1, POLL - (time.monotonic() - t0)))


if __name__ == "__main__":
    Watchdog().loop()

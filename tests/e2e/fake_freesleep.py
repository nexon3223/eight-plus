#!/usr/bin/env python3
"""
A stand-in free-sleep Pod: the HTTP API of throwaway31265/free-sleep's server, closely enough
that the real hass-free-sleep integration can't tell the difference.

    python3 tests/e2e/fake_freesleep.py --port 3000 [--model "Pod 4"] [--left-name Left]

Mirrors the real server where it matters to Home Assistant:
  * deviceStatus/settings/services/schedules accept deep-partial bodies and 400 on the same
    things the server's zod schemas reject (e.g. targetTemperatureF outside 55–110)
  * setpoints are stored as franken "levels" — level = round((F − 82.5) / 27.5 × 100) — and read
    back as round(82.5 ± level × 0.275), so HA sees the same whole-°F grid a real Pod reports
  * isOn → a 12 h on-duration (secondsRemaining), off → 0
  * away mode on EITHER side makes every side update hit both sides (controlBothSides)
  * waterLevel is the string "true"/"false", like the real thing
  * vitals summary is the 5-minute average; zeros when nobody's in bed

Test-only endpoints (not on a real Pod):
  GET  /_log              every accepted write, oldest first: [{t, path, body}]
  POST /_presence         {"left": true}  — someone gets into / out of bed
  POST /_water            {"low": true}
  POST /_reset_log
"""
import argparse
import copy
import json
import math
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

LOCK = threading.Lock()
LOG = []


def level_from_f(f):
    return round((f - 82.5) / 27.5 * 100)


def f_from_level(level):
    if level == 0:
        return 83
    if level < 0:
        return round(82.5 - (-level / 100) * 27.5)
    return round(82.5 + (level / 100) * 27.5)


def deep_merge(dst, src):
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            deep_merge(dst[k], v)
        else:
            dst[k] = v
    return dst


class Pod:
    def __init__(self, model, names):
        self.model = model
        self.side = {s: {"level": 0, "cur": 0.0, "until": 0.0, "present": False, "vib": False} for s in ("left", "right")}
        self.water_ok = True
        self.priming_until = 0.0
        self.settings = {
            "id": "settings", "timeZone": "America/New_York", "temperatureFormat": "fahrenheit",
            "rebootDaily": False, "primePodDaily": {"enabled": True, "time": "14:00"},
            **{s: {"name": names[s], "awayMode": False,
                   "scheduleOverrides": {"temperatureSchedules": {"disabled": False, "expiresAt": ""},
                                         "alarm": {"disabled": False, "timeOverride": "", "expiresAt": ""}},
                   "taps": {}} for s in ("left", "right")},
        }
        self.services = {"biometrics": {"enabled": True, "jobs": {}}, "sentryLogging": {"enabled": False}}
        self.schedules = {s: {} for s in ("left", "right")}
        self.last_tick = time.time()

    # the water "moves" toward the target at ~1 level / 2 s while a side is on
    def tick(self):
        now = time.time()
        dt = now - self.last_tick
        self.last_tick = now
        for st in self.side.values():
            goal = st["level"] if st["until"] > now else 0
            step = dt / 2
            st["cur"] += max(-step, min(step, goal - st["cur"]))

    def status(self):
        self.tick()
        now = time.time()
        out = {}
        for s, st in self.side.items():
            secs = max(0, int(st["until"] - now))
            out[s] = {"currentTemperatureLevel": round(st["cur"]), "currentTemperatureF": f_from_level(round(st["cur"])),
                      "targetTemperatureF": f_from_level(st["level"]), "secondsRemaining": secs,
                      "isOn": secs > 0, "isAlarmVibrating": st["vib"]}
        out.update({"waterLevel": "true" if self.water_ok else "false", "isPriming": self.priming_until > now,
                    "settings": {"v": 1, "gainLeft": 400, "gainRight": 400, "ledBrightness": 50},
                    "coverVersion": self.model, "hubVersion": self.model,
                    "freeSleep": {"version": "2026.10.04", "branch": "main"}, "wifiStrength": 78})
        return out

    def update_status(self, body):
        # same checks as DeviceStatusSchema.deepPartial()
        for s in ("left", "right"):
            t = (body.get(s) or {}).get("targetTemperatureF")
            if t is not None and not (isinstance(t, (int, float)) and 55 <= t <= 110):
                raise ValueError(f"{s}.targetTemperatureF {t!r} must be 55–110")
        if body.get("isPriming"):
            self.priming_until = time.time() + 30
        both = self.settings["left"]["awayMode"] or self.settings["right"]["awayMode"]
        for s in ("left", "right"):
            part = body.get(s)
            if not part:
                continue
            targets = ("left", "right") if both else (s,)
            for t in targets:
                st = self.side[t]
                if "isOn" in part:
                    st["until"] = time.time() + 43200 if part["isOn"] else 0
                if part.get("targetTemperatureF"):
                    st["level"] = level_from_f(part["targetTemperatureF"])
                if part.get("secondsRemaining"):
                    st["until"] = time.time() + part["secondsRemaining"]
                if part.get("isAlarmVibrating") is False:
                    st["vib"] = False

    def vitals(self, side):
        if not self.side[side]["present"]:
            return {"avgHeartRate": 0, "minHeartRate": 0, "maxHeartRate": 0, "avgBreathingRate": 0, "avgHRV": 0}
        w = math.sin(time.time() / 300)
        return {"avgHeartRate": round(58 + 4 * w), "minHeartRate": 52, "maxHeartRate": 66,
                "avgBreathingRate": round(14 + w, 1), "avgHRV": round(48 + 6 * w, 1)}

    def presence(self):
        now = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        return {s: {"present": st["present"], "lastUpdatedAt": now} for s, st in self.side.items()}


POD = None


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj=None):
        body = b"" if obj is None else json.dumps(obj).encode()
        self.send_response(code)
        if obj is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        with LOCK:
            if u.path == "/api/deviceStatus":
                return self._send(200, POD.status())
            if u.path == "/api/settings":
                return self._send(200, POD.settings)
            if u.path == "/api/services":
                return self._send(200, POD.services)
            if u.path == "/api/schedules":
                return self._send(200, POD.schedules)
            if u.path == "/api/metrics/vitals/summary":
                return self._send(200, POD.vitals((q.get("side") or ["left"])[0]))
            if u.path == "/api/metrics/presence":
                return self._send(200, POD.presence())
            if u.path == "/_log":
                return self._send(200, LOG)
        self._send(404, {"error": "not found"})

    def do_POST(self):
        u = urlparse(self.path)
        try:
            b = self._body()
        except json.JSONDecodeError:
            return self._send(400, {"error": "bad json"})
        with LOCK:
            try:
                if u.path == "/api/deviceStatus":
                    POD.update_status(b)
                elif u.path == "/api/settings":
                    deep_merge(POD.settings, b)
                elif u.path == "/api/services":
                    deep_merge(POD.services, b)
                elif u.path == "/api/schedules":
                    deep_merge(POD.schedules, b)
                elif u.path in ("/api/execute", "/api/jobs"):
                    pass
                elif u.path == "/_presence":
                    for s, v in b.items():
                        POD.side[s]["present"] = bool(v)
                    return self._send(204)
                elif u.path == "/_water":
                    POD.water_ok = not b.get("low")
                    return self._send(204)
                elif u.path == "/_reset_log":
                    LOG.clear()
                    return self._send(204)
                else:
                    return self._send(404, {"error": "not found"})
            except ValueError as e:
                LOG.append({"t": time.time(), "path": u.path, "body": b, "rejected": str(e)})
                return self._send(400, {"error": "Invalid request data", "details": str(e)})
            LOG.append({"t": time.time(), "path": u.path, "body": b})
        self._send(204)


def main():
    global POD
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=3000)
    ap.add_argument("--model", default="Pod 4")
    ap.add_argument("--left-name", default="Left")
    ap.add_argument("--right-name", default="Right")
    a = ap.parse_args()
    POD = Pod(a.model, {"left": a.left_name, "right": a.right_name})
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), H)
    print(f"fake free-sleep {a.model} on http://127.0.0.1:{a.port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()

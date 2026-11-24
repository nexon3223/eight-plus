#!/usr/bin/env python3
"""
Eight+ add-on entry point.

  :8099  ingress — the onboarding wizard + control panel (HA sidebar, admin only)
  :8098  the standalone Pod app (optional, off until switched on in the panel)

Development off-box:  HA_URL=http://homeassistant.local:8123 HA_TOKEN=… CONFIG_DIR=/tmp/cfg \
                      DATA_DIR=/tmp/data EIGHT_PLUS_DEV=1 python3 main.py
"""
import json
import mimetypes
import os
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import detect  # noqa: E402
import generator as G  # noqa: E402
from haclient import HA, endpoints  # noqa: E402
from installer import DryHA, Installer, InstallError  # noqa: E402
from sleep_service import SleepService, ssh_pubkey, ssh_test  # noqa: E402
from standalone import StandaloneApp  # noqa: E402

VERSION = open(os.path.join(HERE, "VERSION")).read().strip() if os.path.exists(os.path.join(HERE, "VERSION")) else "dev"
CONFIG_DIR = os.environ.get("CONFIG_DIR", "/homeassistant")
DATA_DIR = os.environ.get("DATA_DIR", "/data")
BUNDLE = os.path.join(HERE, "bundle")
WEB = os.path.join(HERE, "web")
DEV = os.environ.get("EIGHT_PLUS_DEV") == "1"
INGRESS_IP = "172.30.32.2"


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def options():
    try:
        return json.load(open(os.path.join(DATA_DIR, "options.json")))
    except (OSError, ValueError):
        return {}


class App:
    def __init__(self):
        self.ep = endpoints()
        self.ha = HA(self.ep, log=log)
        if os.environ.get("EIGHT_PLUS_DRY_RUN") == "1":
            log("DRY RUN — reads are real, every write to Home Assistant is skipped")
            self.ha = DryHA(self.ha, log)
        self.inst = Installer(self.ha, CONFIG_DIR, DATA_DIR, BUNDLE, VERSION, log=log)
        self.opt = options()
        self.sleep = SleepService(self.ha, self.inst, self.opt, log=log)
        self.app = StandaloneApp(os.path.join(BUNDLE, "app"), self.ep, int(self.opt.get("app_port", 8098)), log=log)
        self._detect_cache = (0, None)

    def boot(self):
        st = self.inst.state
        if st.get("installed"):
            self.sleep.start()
            self.app.update_scope(st)
            if st.get("standalone"):
                self.app.start()

    # ── API
    def detect(self, fresh=False):
        t, cached = self._detect_cache
        if cached and not fresh and time.time() - t < 20:
            return cached
        if not self.ha.wait(20):
            raise InstallError("Can't reach Home Assistant yet — it may still be starting.")
        reg = self.ha.registry()
        states = self.ha.states()
        cfg = self.ha.config()
        found = detect.detect_all(reg, states)
        pick = detect.pickers(states, self.ha.services())
        mq = self.ha.supervisor("/services/mqtt")
        out = {
            "backends": found,
            "pickers": pick,
            "ha": {"version": cfg.get("version"), "location": cfg.get("location_name"),
                   "time_zone": cfg.get("time_zone"), "units": (cfg.get("unit_system") or {}).get("temperature")},
            "integrations": {
                "eight_sleep": any(e.get("platform") == "eight_sleep" for e in reg),
                "free_sleep": any(e.get("platform") == "free_sleep" for e in reg),
                "mqtt": "mqtt" in (cfg.get("components") or []),
                "hacs": "hacs" in (cfg.get("components") or []),
            },
            "mqtt_broker": bool(mq and mq.get("host")),
            "card": self.inst.card_status(),
            "packages": self.inst.packages_setup(),
            "all_entities": sorted(e for e in states if e.split(".")[0] in
                                   ("climate", "binary_sensor", "sensor")),
            "existing_prefixes": sorted({e.split(".", 1)[1].rsplit("_smart_autopilot", 1)[0]
                                         for e in states if e.endswith("_smart_autopilot")}),
        }
        self._detect_cache = (time.time(), out)
        return out

    def status(self):
        st = self.inst.state
        return {
            "version": VERSION, "ha_connected": self.ha.connected, "in_addon": self.ep["in_addon"],
            "installed": bool(st.get("installed")),
            "install": {k: st.get(k) for k in ("version", "installed_at", "dashboard", "card", "sleepers",
                                               "standalone", "packages_dir", "answers")} if st.get("installed") else None,
            "backend": (st.get("answers") or {}).get("backend"),
            "drift": self.inst.drift() if st.get("installed") else None,
            "progress": self.inst.progress,
            "sleep": self.sleep.snapshot(),
            "app": {"enabled": bool(st.get("standalone")), "running": bool(self.app.httpd),
                    "port": self.app.port},
        }

    def after_install(self):
        """Once the installer thread finishes cleanly, start the pipeline + app on the new plan."""
        def watch():
            while self.inst.progress.get("running"):
                time.sleep(2)
            if self.inst.progress.get("done"):
                st = self.inst.state
                self.app.update_scope(st)
                self.sleep.start()
        threading.Thread(target=watch, daemon=True).start()

    def set_standalone(self, on):
        st = self.inst.state
        st["standalone"] = bool(on)
        self.inst.save_state(st)
        self.app.update_scope(st)
        if on:
            self.app.start()
        else:
            self.app.stop()
        return {"enabled": bool(on)}


APP = None


class Handler(BaseHTTPRequestHandler):
    server_version = "EightPlus/" + VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _guard(self):
        # ingress traffic only ever comes from the Supervisor's proxy
        ip = self.client_address[0]
        if DEV or ip in (INGRESS_IP, "127.0.0.1", "::1"):
            return True
        self.send_error(403, "Eight+ is only reachable through the Home Assistant sidebar")
        return False

    def _json(self, obj, code=200):
        body = json.dumps(obj, default=str).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def do_GET(self):
        if not self._guard():
            return
        path = self.path.split("?")[0]
        try:
            if path == "/api/status":
                return self._json(APP.status())
            if path == "/api/detect":
                return self._json(APP.detect(fresh="fresh" in self.path))
            if path == "/api/progress":
                return self._json(APP.inst.progress)
            if path == "/api/ssh/pubkey":
                return self._json({"pubkey": ssh_pubkey()})
            if path == "/api/files":
                st = APP.inst.state
                plan = G.build(st["answers"], version=VERSION)
                return self._json({"files": plan["files"], "cards": plan["cards"]})
        except Exception as e:  # noqa: BLE001
            return self._json({"error": str(e)}, 500)
        return self._static(path)

    def do_POST(self):
        if not self._guard():
            return
        path = self.path.split("?")[0]
        try:
            b = self._body()
            if path == "/api/preview":
                pre = APP.inst.preflight(b["answers"])
                plan = G.build(APP.inst.with_units(b["answers"]), version=VERSION)
                pre["files"] = plan["files"]
                pre["cards"] = plan["cards"]
                return self._json(pre)
            if path == "/api/install":
                a = b["answers"]
                if b.get("standalone") is not None:
                    st = APP.inst.state
                    st["standalone"] = bool(b["standalone"])
                    APP.inst.save_state(st)
                APP.inst.start_install(a)
                APP.after_install()
                return self._json({"started": True})
            if path == "/api/update":
                st = APP.inst.state
                APP.inst.start_install(st["answers"])
                APP.after_install()
                return self._json({"started": True})
            if path == "/api/uninstall":
                APP.inst.start_uninstall(bool(b.get("keep_dashboard")))
                return self._json({"started": True})
            if path == "/api/pipeline/run":
                APP.sleep.run_now(int(b.get("backfill") or 0))
                return self._json({"started": True})
            if path == "/api/ssh/test":
                ok, out = ssh_test(b["host"], int(b.get("port") or 8822), b.get("user") or "root", b.get("sudo", True))
                return self._json({"ok": ok, "output": out})
            if path == "/api/standalone":
                return self._json(APP.set_standalone(b.get("enabled")))
        except (InstallError, G.GenError) as e:
            return self._json({"error": str(e)}, 400)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            return self._json({"error": f"{type(e).__name__}: {e}"}, 500)
        self.send_error(404)

    def _static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        full = os.path.normpath(os.path.join(WEB, path.lstrip("/")))
        if not full.startswith(WEB) or not os.path.isfile(full):
            self.send_error(404)
            return
        body = open(full, "rb").read()
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if full.endswith(".js"):
            ctype = "text/javascript"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    global APP
    log(f"Eight+ {VERSION} starting (config {CONFIG_DIR}, data {DATA_DIR})")
    APP = App()
    threading.Thread(target=APP.boot, daemon=True).start()
    port = int(os.environ.get("INGRESS_PORT", "8099"))
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    srv.daemon_threads = True
    log(f"panel on :{port}")
    srv.serve_forever()


if __name__ == "__main__":
    main()

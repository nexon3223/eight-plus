"""
The sleep-statistics service: collector -> nightly rollup -> publish, inside the add-on.

Replaces the launchd agents of the standalone ~/pod-sleep-pipeline. Rollup is idempotent and
cheap, so rather than guess when someone got up it simply re-rolls "last night" every 30 min
through the morning (05:00–13:30) — the report appears soon after they're up and settles as
late data arrives.
"""
import datetime as dt
import os
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "pipeline"))

import config as C  # noqa: E402  (pipeline/config.py)
import collect  # noqa: E402
import rollup  # noqa: E402
import publish  # noqa: E402

SSH_DIR = os.path.join(os.environ.get("DATA_DIR", "/data"), "ssh")


class SleepService:
    def __init__(self, ha, installer, options, log=print):
        self.ha, self.installer, self.opt, self.log = ha, installer, options, log
        self.collector = None
        self.ssh = None
        self.status = {"enabled": False, "source": None, "last_rollup": None, "last_publish": None,
                       "last_error": None, "nights": {}, "mqtt": None}
        self._stop = threading.Event()
        self._kick = threading.Event()
        self._started = False

    # ─────────────────────────── configuration from the installed plan
    def _configure(self):
        st = self.installer.state
        if not st.get("installed"):
            return False
        a = st.get("answers") or {}
        if (a.get("features") or {}).get("pipeline") is False:
            return False
        sides = (a.get("bed") or {}).get("sides") or {}
        C.configure(STORE_DB=os.path.join(self.installer.data, "sleep.db"))
        C.SLEEPERS = {s["side"]: {"slug": s["slug"], "p": s["p"], "name": s["name"]}
                      for s in st.get("sleepers") or []}
        mq = self.ha.supervisor("/services/mqtt") if self.opt.get("use_mqtt", True) else None
        if self.opt.get("mqtt_host"):          # an external broker the Supervisor doesn't know about
            mq = {"host": self.opt["mqtt_host"], "port": self.opt.get("mqtt_port", 1883),
                  "username": self.opt.get("mqtt_user", ""), "password": self.opt.get("mqtt_password", "")}
        if getattr(self.installer, "dry", False):
            mq = None                          # dry run: publish goes to the (skipped) REST path
        if mq and mq.get("host"):
            C.MQTT.update(host=mq["host"], port=int(mq.get("port") or 1883),
                          user=mq.get("username") or "", password=mq.get("password") or "")
            self.status["mqtt"] = f"{mq['host']}:{mq.get('port')}"
        else:
            C.MQTT["host"] = ""
            self.status["mqtt"] = None
        pipe = a.get("pipeline") or {}
        if pipe.get("source") == "ssh" and pipe.get("host"):
            self.ssh = collect.SSHCollector(pipe["host"], pipe.get("port", 8822), pipe.get("user", "root"),
                                            os.path.join(SSH_DIR, "id_ed25519"), pipe.get("sudo", True),
                                            raw_cap=a.get("backend") == "gateway", log=self.log)
            self.status["source"] = f"ssh {pipe.get('user', 'root')}@{pipe['host']}"
        else:
            watch = {}
            for side in C.SLEEPERS:
                sd = sides.get(side) or {}
                watch[side] = {k: sd.get(k) for k in ("heart_rate", "hrv", "breath_rate", "presence")}
            self.collector = collect.HACollector(self.ha, watch, log=self.log)
            self.status["source"] = "home assistant"
        return True

    # ─────────────────────────── lifecycle
    def start(self):
        if self._started:
            self.restart()
            return
        self._started = True
        threading.Thread(target=self._loop, daemon=True, name="sleep").start()

    def restart(self):
        """Re-read the plan (after an install/update) — the loop picks it up."""
        if self.collector:
            self.collector.stop()
        self.collector = self.ssh = None
        self.status["enabled"] = False
        self._kick.set()

    def run_now(self, backfill=0):
        threading.Thread(target=self._nightly, kwargs={"backfill": backfill}, daemon=True).start()

    def _loop(self):
        last_ssh = 0
        last_roll_slot = None
        while not self._stop.is_set():
            try:
                if not self.status["enabled"]:
                    if self._configure():
                        self.status["enabled"] = True
                        self.ha.wait(120)
                        if self.collector:
                            self.collector.start()
                            self.collector.backfill(days=int(self.opt.get("backfill_days", 10)))
                        self._nightly(backfill=int(self.opt.get("backfill_days", 10)))
                if self.status["enabled"]:
                    now = time.time()
                    if self.ssh and now - last_ssh > 15 * 60:
                        last_ssh = now
                        try:
                            self.ssh.run()
                        except Exception as e:  # noqa: BLE001
                            self.status["last_error"] = f"ssh: {e}"
                    t = dt.datetime.now()
                    slot = (t.date(), t.hour, t.minute // 30)
                    if 5 <= t.hour <= 13 and slot != last_roll_slot and t.minute % 30 >= 5:
                        last_roll_slot = slot
                        self._nightly()
                    elif C.MQTT.get("host") == "" and t.minute == 0 and slot != last_roll_slot:
                        last_roll_slot = slot
                        self._publish()          # REST states don't survive an HA restart
            except Exception as e:  # noqa: BLE001
                self.status["last_error"] = repr(e)
                self.log("sleep service:", repr(e))
            self._kick.wait(30)
            self._kick.clear()

    def _needs(self):
        out = {}
        try:
            st = self.ha.states()
            for side, sl in C.SLEEPERS.items():
                v = (st.get(f"input_number.{sl['p']}_sleep_need") or {}).get("state")
                out[side] = float(v) if v not in (None, "unknown", "unavailable") else 8.0
        except Exception:  # noqa: BLE001
            pass
        return out

    def _publish(self):
        r = publish.publish(self.ha, needs=self._needs(), log=self.log)
        self.status["last_publish"] = r
        return r

    def _nightly(self, backfill=0):
        try:
            if self.ssh:
                self.ssh.run()
            res = rollup.run(sides=list(C.SLEEPERS), backfill=backfill)
            self.status["last_rollup"] = time.time()
            for (d, side), s in res.items():
                if s and C.SLEEPERS.get(side):
                    self.status["nights"].setdefault(C.SLEEPERS[side]["name"], {})[d] = s.get("sleep_score")
            self._publish()
            self.status["last_error"] = None
        except Exception as e:  # noqa: BLE001
            self.status["last_error"] = repr(e)
            self.log("nightly failed:", repr(e))

    def snapshot(self):
        s = dict(self.status)
        if self.collector:
            s["collector"] = self.collector.stats
        if self.ssh:
            s["ssh"] = self.ssh.stats
        s["nights"] = {k: dict(sorted(v.items())[-7:]) for k, v in s["nights"].items()}
        return s


# ─────────────────────────── SSH key for the optional Pod source
def ssh_pubkey():
    os.makedirs(SSH_DIR, mode=0o700, exist_ok=True)
    key = os.path.join(SSH_DIR, "id_ed25519")
    if not os.path.exists(key):
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "eight-plus-addon", "-f", key],
                       check=True)
    return open(key + ".pub").read().strip()


def ssh_test(host, port, user, sudo):
    c = collect.SSHCollector(host, port, user, os.path.join(SSH_DIR, "id_ed25519"), sudo)
    return c.test()

"""
Eight+ installer — applies a generator plan to Home Assistant, safely.

Everything Eight+ writes lives in three places, so it can be updated or removed cleanly:
  <packages>/eight_plus/*.yaml          helpers, template sensors, scripts, automations
  custom_templates/eight_plus.jinja     the Autopilot model + hm12
  www/eight_plus/                       the card (unless HACS provides it) + bed art
plus one dashboard (storage mode) and at most one Lovelace resource.

Order of work — nothing irreversible happens before the config check passes:
  preflight -> backup -> write files -> check_config (rollback on failure) -> restart/reload
  -> wait for HA -> seed first-run helper values -> card resource -> dashboard -> verify
"""
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import threading
import time

import generator as G

STATE_FILE = "state.json"
PKG_LINE = "  packages: !include_dir_named packages"


def _sha(text):
    return hashlib.sha256(text.encode()).hexdigest()[:16]


class InstallError(RuntimeError):
    pass


class DryHA:
    """EIGHT_PLUS_DRY_RUN=1: reads go to the real Home Assistant, every write is logged and
    skipped — for developing the wizard against a live system without touching it.
    main.App wraps the ONE client everything shares, so no component can bypass it."""

    WRITES = ("lovelace/resources/create", "lovelace/resources/update", "lovelace/resources/delete",
              "lovelace/dashboards/create", "lovelace/dashboards/delete", "lovelace/config/save", "call_service")

    def __init__(self, ha, log):
        self._ha, self._log = ha, log

    def __getattr__(self, k):
        return getattr(self._ha, k)

    def call(self, msg, timeout=60):
        if msg.get("type") in self.WRITES:
            self._log("[dry-run] skip", msg.get("type"), msg.get("domain", ""), msg.get("service", ""),
                      msg.get("url_path", ""))
            if msg.get("type") == "lovelace/dashboards/list":
                return []
            return {"id": "dry-run"}
        return self._ha.call(msg, timeout)

    def service(self, domain, service, data=None, target=None, timeout=60):
        self._log("[dry-run] skip service", f"{domain}.{service}", json.dumps(data or {})[:120])

    def rest(self, method, path, body=None, timeout=120):
        if method.upper() != "GET":
            self._log("[dry-run] skip REST", method, path)
            return None
        return self._ha.rest(method, path, body, timeout)

    def check_config(self):
        self._log("[dry-run] skip check_config")
        return {"result": "valid"}

    def states(self):
        st = self._ha.states()
        # pretend the install's entities appeared, so the flow completes
        for e in getattr(self, "_expect", []):
            st.setdefault(e, {"entity_id": e, "state": "unknown", "attributes": {}})
        return st


class Installer:
    def __init__(self, ha, config_dir, data_dir, bundle_dir, version, log=print):
        self.dry = isinstance(ha, DryHA)
        self.ha, self.cfg, self.data, self.bundle = ha, config_dir, data_dir, bundle_dir
        self.version, self.log = version, log
        self.lock = threading.Lock()
        self.progress = {"running": False, "steps": [], "done": False, "error": None}
        os.makedirs(self.data, exist_ok=True)

    # ─────────────────────────────────────────── state
    @property
    def state(self):
        try:
            with open(os.path.join(self.data, STATE_FILE)) as f:
                return json.load(f)
        except (OSError, ValueError):
            return {}

    def save_state(self, st):
        tmp = os.path.join(self.data, STATE_FILE + ".tmp")
        with open(tmp, "w") as f:
            json.dump(st, f, indent=1)
        os.replace(tmp, os.path.join(self.data, STATE_FILE))

    def _step(self, label, status="run", detail=""):
        steps = self.progress["steps"]
        if steps and steps[-1]["label"] == label:
            steps[-1].update(status=status, detail=detail)
        else:
            steps.append({"label": label, "status": status, "detail": detail})
        self.log(f"[install] {status:5} {label} {detail}")

    # ─────────────────────────────────────────── configuration.yaml / packages
    def packages_setup(self):
        """How packages are wired in configuration.yaml. Returns
        {'mode': 'dir_named'|'dir_merge_named'|'missing'|'manual', 'dir': 'packages', 'why': str}."""
        path = os.path.join(self.cfg, "configuration.yaml")
        try:
            text = open(path, encoding="utf-8").read()
        except OSError:
            return {"mode": "manual", "dir": "packages", "why": "configuration.yaml is not readable"}
        m = re.search(r"(?m)^homeassistant:[ \t]*(.*)$", text)
        if not m:
            return {"mode": "missing", "dir": "packages", "why": "no homeassistant: section"}
        if m.group(1).strip() and not m.group(1).strip().startswith("#"):
            return {"mode": "manual", "dir": "packages",
                    "why": f"homeassistant: is set inline ({m.group(1).strip()[:40]})"}
        block = text[m.end():]
        end = re.search(r"(?m)^\S", block)
        block = block[: end.start()] if end else block
        pm = re.search(r"(?m)^[ \t]+packages:[ \t]*(.*)$", block)
        if not pm:
            return {"mode": "missing", "dir": "packages", "why": "no packages: under homeassistant:"}
        val = pm.group(1).split("#")[0].strip()
        mm = re.match(r"!include_dir_(named|merge_named)\s+(\S+)", val)
        if mm:
            return {"mode": "dir_" + mm.group(1), "dir": mm.group(2).strip("'\"").rstrip("/"), "why": ""}
        return {"mode": "manual", "dir": "packages",
                "why": f"packages: is '{val or 'an inline mapping'}' — add Eight+ by hand (see DOCS)"}

    def _ensure_packages_line(self):
        """Add `packages: !include_dir_named packages` to configuration.yaml. Returns True if
        the file changed (which means HA needs a restart, not a reload)."""
        ps = self.packages_setup()
        if ps["mode"].startswith("dir_"):
            return False
        if ps["mode"] == "manual":
            raise InstallError("Can't wire packages automatically: " + ps["why"])
        path = os.path.join(self.cfg, "configuration.yaml")
        text = open(path, encoding="utf-8").read()
        m = re.search(r"(?m)^homeassistant:[ \t]*(#.*)?$", text)
        if m:
            after = text[m.end():]
            ind = re.match(r"\n([ \t]+)\S", after)
            line = (ind.group(1) if ind else "  ") + "packages: !include_dir_named packages"
            text = text[: m.end()] + "\n" + line + text[m.end():]
        else:
            text = text.rstrip("\n") + "\n\n# Added by the Eight+ add-on\nhomeassistant:\n" + PKG_LINE + "\n"
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return True

    def _dest(self, rel, ps):
        """Map a plan path to a real path. packages/… follows configuration.yaml."""
        if rel.startswith("packages/"):
            return os.path.join(self.cfg, ps["dir"], rel[len("packages/"):])
        return os.path.join(self.cfg, rel)

    def _file_text(self, rel, text, ps):
        if rel.startswith("packages/") and ps["mode"] == "dir_merge_named":
            name = os.path.splitext(os.path.basename(rel))[0]
            body = "\n".join(("  " + ln) if ln.strip() else ln for ln in text.splitlines())
            return f"{name}:\n{body}\n"
        return text

    # ─────────────────────────────────────────── card
    def card_status(self):
        """Where the card comes from. HACS wins over a manual copy, which wins over ours."""
        try:
            res = self.ha.call({"type": "lovelace/resources"}) or []
        except Exception as e:  # noqa: BLE001
            return {"found": False, "url": None, "mode": "unknown", "error": str(e), "ours": []}
        cards = [r for r in res if "eight-sleep-card" in (r.get("url") or "")]
        ours = [r for r in cards if "/local/eight_plus/" in r["url"]]
        hacs = [r for r in cards if "/hacsfiles/" in r["url"]]
        manual = [r for r in cards if r not in ours and r not in hacs]
        pick, mode = (hacs, "hacs") if hacs else (manual, "manual") if manual else (ours, "ours") if ours else ([], "none")
        r = pick[0] if pick else {}
        return {"found": bool(pick), "url": r.get("url"), "id": r.get("id"), "mode": mode,
                "ours": [o["id"] for o in ours]}

    # ─────────────────────────────────────────── units
    def with_units(self, answers):
        """The answers plus this Home Assistant's temperature unit ("C"/"F"). Eight+ is °C inside;
        on a °F system the generator converts at the climate entities. Stamped at install, so a
        later unit-system change needs "Change setup" (status flags it)."""
        a = dict(answers)
        try:
            a["units"] = "F" if (self.ha.config().get("unit_system") or {}).get("temperature") == "°F" else "C"
        except Exception:  # noqa: BLE001 — HA unreachable: keep what the answers already say
            a.setdefault("units", "C")
        return a

    # ─────────────────────────────────────────── preflight
    def preflight(self, answers):
        answers = self.with_units(answers)
        plan = G.build(answers, version=self.version)
        st = self.state
        owned = set(st.get("entities") or [])
        states = self.ha.states()
        collisions = sorted(e for e in plan["entities"] if e in states and e not in owned)
        ps = self.packages_setup()
        card = self.card_status()
        warnings = []
        if ps["mode"] == "manual":
            warnings.append("Packages can't be wired automatically: " + ps["why"])
        if not answers.get("room", {}).get("weather"):
            warnings.append("No weather entity — Autopilot won't adjust for the outside temperature.")
        return {"plan_summary": plan["summary"], "collisions": collisions, "packages": ps,
                "card": card, "warnings": warnings, "reinstall": bool(st.get("installed")),
                "restart_needed": ps["mode"] == "missing" or not st.get("installed")}

    # ─────────────────────────────────────────── install
    def start_install(self, answers):
        answers = self.with_units(answers)
        with self.lock:
            if self.progress["running"]:
                raise InstallError("an install is already running")
            self.progress = {"running": True, "steps": [], "done": False, "error": None,
                             "started": time.time()}
        threading.Thread(target=self._install, args=(answers,), daemon=True, name="install").start()

    def _install(self, answers):
        backup_dir = None
        written = []
        loaded = False   # once HA has loaded the new config, a later failure must not roll back
        try:
            self._step("Checking your answers")
            plan = G.build(answers, version=self.version)
            prev = self.state
            owned = set(prev.get("entities") or [])
            states = self.ha.states()
            coll = [e for e in plan["entities"] if e in states and e not in owned]
            if coll:
                raise InstallError(f"{len(coll)} entities already exist and weren't made by Eight+ "
                                   f"(e.g. {', '.join(coll[:3])}). Pick different names or remove them.")
            self._step("Checking your answers", "ok")

            self._step("Backing up")
            ps = self.packages_setup()
            if ps["mode"] == "manual":
                raise InstallError("Can't wire packages automatically: " + ps["why"])
            stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
            backup_dir = os.path.join(self.cfg, "eight_plus_backups", stamp)
            os.makedirs(backup_dir, exist_ok=True)
            shutil.copy2(os.path.join(self.cfg, "configuration.yaml"), backup_dir)
            for rel in list(plan["files"]) + list(prev.get("files") or {}):
                src = self._dest(rel, ps)
                if os.path.isfile(src):
                    dst = os.path.join(backup_dir, "files", rel)
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    shutil.copy2(src, dst)
            self._step("Backing up", "ok", os.path.relpath(backup_dir, self.cfg))

            self._step("Writing Eight+ config")
            restart = self._ensure_packages_line()
            ps = self.packages_setup()
            # files a previous install wrote that this plan doesn't (a sleeper removed) go away
            for rel in set(prev.get("files") or {}) - set(plan["files"]):
                p = self._dest(rel, ps)
                if os.path.isfile(p):
                    os.remove(p)
            for rel, text in plan["files"].items():
                p = self._dest(rel, ps)
                os.makedirs(os.path.dirname(p), exist_ok=True)
                with open(p, "w", encoding="utf-8") as f:
                    f.write(self._file_text(rel, text, ps))
                written.append(rel)
            www = os.path.join(self.cfg, "www", "eight_plus")
            os.makedirs(www, exist_ok=True)
            for fn in ("es-bed.png", "es-pillows.png"):
                src = os.path.join(self.bundle, "assets", fn)
                if os.path.isfile(src):
                    shutil.copy2(src, os.path.join(www, fn))
            self._step("Writing Eight+ config", "ok", f"{len(written)} files")

            self._step("Asking Home Assistant to check the config")
            chk = self.ha.check_config() or {}
            if chk.get("result") != "valid":
                raise InstallError("Home Assistant rejected the config:\n" + str(chk.get("errors"))[:1500])
            self._step("Asking Home Assistant to check the config", "ok")

            restart = restart or not prev.get("installed")
            if restart:
                self._step("Restarting Home Assistant", "run", "about a minute")
                try:
                    self.ha.service("homeassistant", "restart", timeout=10)
                except Exception:  # noqa: BLE001 — the socket dropping IS the restart
                    pass
                time.sleep(2 if self.dry else 15)
                if not self._wait_ha(600):
                    raise InstallError("Home Assistant didn't come back within 10 minutes")
                self._step("Restarting Home Assistant", "ok")
            else:
                self._step("Reloading Home Assistant")
                self.ha.service("homeassistant", "reload_custom_templates")
                self.ha.service("homeassistant", "reload_all", timeout=180)
                time.sleep(3)
                self._step("Reloading Home Assistant", "ok")
            loaded = True

            self._step("Waiting for the new entities")
            if self.dry:
                self.ha._expect = plan["entities"]
            missing = self._wait_entities(plan["entities"], 180)
            if missing:
                self._step("Waiting for the new entities", "warn",
                           f"{len(missing)} not up yet: {', '.join(missing[:4])}")
            else:
                self._step("Waiting for the new entities", "ok", f"{len(plan['entities'])} entities")

            self._step("Setting your schedule")
            seeded = set(prev.get("seeded") or [])
            n = 0
            for svc, data in plan["seeds"]:
                eid = data["entity_id"]
                if eid in seeded:
                    continue  # never overwrite what the user has changed since
                dom, name = svc.split(".")
                try:
                    self.ha.service(dom, name, {k: v for k, v in data.items()})
                    seeded.add(eid)
                    n += 1
                except Exception as e:  # noqa: BLE001
                    self.log("seed failed", eid, e)
            self._step("Setting your schedule", "ok", f"{n} values")

            self._step("Installing the card")
            card = self.card_status()
            card_url = card.get("url")
            if card["mode"] in ("none", "ours"):
                src = os.path.join(self.bundle, "eight-sleep-card.js")
                shutil.copy2(src, os.path.join(www, "eight-sleep-card.js"))
                url = f"/local/eight_plus/eight-sleep-card.js?v={self.version}"
                if card["mode"] == "ours":
                    self.ha.call({"type": "lovelace/resources/update", "resource_id": card["id"],
                                  "res_type": "module", "url": url})
                else:
                    r = self.ha.call({"type": "lovelace/resources/create", "res_type": "module", "url": url})
                    card["id"] = (r or {}).get("id")
                card_url = url
                self._step("Installing the card", "ok", "bundled copy")
            else:
                # HACS or a hand-installed copy provides it — retire a bundled copy we added before
                for rid in card.get("ours") or []:
                    self.ha.call({"type": "lovelace/resources/delete", "resource_id": rid})
                self._step("Installing the card", "ok", f"using {card['mode'].upper()} ({card_url})")

            self._step("Building your dashboard")
            dash = self._dashboard(plan, answers)
            self._step("Building your dashboard", "ok", "/" + dash)

            self.save_state({
                "installed": True, "version": self.version, "installed_at": time.time(),
                "answers": answers,
                "files": {r: _sha(self._file_text(r, plan["files"][r], ps)) for r in plan["files"]},
                "packages_dir": ps["dir"], "entities": plan["entities"], "seeded": sorted(seeded),
                "dashboard": dash, "card": {"mode": card["mode"] if card["mode"] != "none" else "ours",
                                            "url": card_url, "resource_id": card.get("id")},
                "sleepers": plan["sleepers"], "cards": plan["cards"], "backup": backup_dir,
            })
            self.progress["done"] = True
            self.progress["dashboard"] = dash
        except Exception as e:  # noqa: BLE001
            self.log("install failed:", repr(e))
            self.progress["error"] = str(e)
            if self.progress["steps"]:
                self.progress["steps"][-1]["status"] = "fail"
            # roll back only if HA never loaded the new config
            if backup_dir and not loaded:
                self._rollback(backup_dir, written)
        finally:
            self.progress["running"] = False

    def _rollback(self, backup_dir, written):
        try:
            ps = self.packages_setup()
            shutil.copy2(os.path.join(backup_dir, "configuration.yaml"), os.path.join(self.cfg, "configuration.yaml"))
            for rel in written:
                p = self._dest(rel, ps)
                b = os.path.join(backup_dir, "files", rel)
                if os.path.isfile(b):
                    shutil.copy2(b, p)
                elif os.path.isfile(p):
                    os.remove(p)
            self._step("Rolled back — nothing was changed", "ok")
        except Exception as e:  # noqa: BLE001
            self._step("Rollback failed — restore from " + backup_dir, "fail", str(e))

    def _wait_ha(self, timeout):
        t0 = time.time()
        while time.time() - t0 < timeout:
            try:
                if self.ha.wait(5) and self.ha.config().get("state") == "RUNNING":
                    return True
            except Exception:  # noqa: BLE001
                pass
            time.sleep(3)
        return False

    def _wait_entities(self, entities, timeout):
        t0 = time.time()
        missing = list(entities)
        while time.time() - t0 < timeout:
            try:
                st = self.ha.states()
                missing = [e for e in entities if e not in st]
            except Exception:  # noqa: BLE001
                pass
            if not missing:
                return []
            time.sleep(5)
        return missing

    def _dashboard(self, plan, answers):
        want = (answers.get("dashboard") or {}).get("url_path") or "eight-plus"
        title = (answers.get("dashboard") or {}).get("title") or "Eight+"
        dashes = self.ha.call({"type": "lovelace/dashboards/list"}) or []
        mine = self.state.get("dashboard")
        exists = {d["url_path"]: d for d in dashes}
        if want in exists and want != mine:
            want = want + "-2"
        if want not in exists:
            self.ha.call({"type": "lovelace/dashboards/create", "url_path": want, "title": title,
                          "icon": "mdi:bed", "show_in_sidebar": True, "require_admin": False, "mode": "storage"})
        self.ha.call({"type": "lovelace/config/save", "url_path": want, "config": plan["dashboard"]})
        return want

    # ─────────────────────────────────────────── uninstall
    def start_uninstall(self, keep_dashboard=False):
        with self.lock:
            if self.progress["running"]:
                raise InstallError("something is already running")
            self.progress = {"running": True, "steps": [], "done": False, "error": None}
        threading.Thread(target=self._uninstall, args=(keep_dashboard,), daemon=True).start()

    def _uninstall(self, keep_dashboard):
        try:
            st = self.state
            ps = self.packages_setup()
            self._step("Removing Eight+ files")
            for rel in st.get("files") or {}:
                p = self._dest(rel, ps)
                if os.path.isfile(p):
                    os.remove(p)
            d = os.path.join(self.cfg, ps["dir"], "eight_plus")
            if os.path.isdir(d) and not os.listdir(d):
                os.rmdir(d)
            self._step("Removing Eight+ files", "ok")
            if st.get("dashboard") and not keep_dashboard:
                self._step("Removing the dashboard")
                for dsh in self.ha.call({"type": "lovelace/dashboards/list"}) or []:
                    if dsh["url_path"] == st["dashboard"]:
                        self.ha.call({"type": "lovelace/dashboards/delete", "dashboard_id": dsh["id"]})
                self._step("Removing the dashboard", "ok")
            card = st.get("card") or {}
            if card.get("mode") == "ours" and card.get("resource_id"):
                self._step("Removing the card resource")
                try:
                    self.ha.call({"type": "lovelace/resources/delete", "resource_id": card["resource_id"]})
                except Exception as e:  # noqa: BLE001
                    self.log("resource delete:", e)
                self._step("Removing the card resource", "ok")
            self._step("Reloading Home Assistant")
            self.ha.service("homeassistant", "reload_custom_templates")
            self.ha.service("homeassistant", "reload_all", timeout=180)
            self._step("Reloading Home Assistant", "ok",
                       "derivative/history sensors disappear fully after the next restart")
            self.save_state({"installed": False, "uninstalled_at": time.time(), "answers": st.get("answers")})
            self.progress["done"] = True
        except Exception as e:  # noqa: BLE001
            self.progress["error"] = str(e)
            if self.progress["steps"]:
                self.progress["steps"][-1]["status"] = "fail"
        finally:
            self.progress["running"] = False

    # ─────────────────────────────────────────── drift (for "updates available")
    def drift(self):
        """Files whose content no longer matches what this add-on version would write."""
        st = self.state
        if not st.get("installed"):
            return {"installed": False}
        try:
            plan = G.build(self.with_units(st["answers"]), version=self.version)
        except Exception as e:  # noqa: BLE001
            return {"installed": True, "error": str(e)}
        ps = self.packages_setup()
        changed, edited = [], []
        for rel, text in plan["files"].items():
            p = self._dest(rel, ps)
            try:
                on_disk = open(p, encoding="utf-8").read()
            except OSError:
                changed.append(rel)
                continue
            if _sha(on_disk) != _sha(self._file_text(rel, text, ps)):
                (edited if _sha(on_disk) != (st.get("files") or {}).get(rel) else changed).append(rel)
        return {"installed": True, "version": st.get("version"), "update": changed, "edited": edited}

#!/usr/bin/env python3
"""
Installer tests against a fake Home Assistant — no network, no real config.

  • configuration.yaml wiring for every shape we claim to handle (and refusal for the rest)
  • a full install -> update -> uninstall on a temp config dir: files, backups, seeds, dashboard,
    card resource, state, and that a user-changed helper is never re-seeded
  • rollback: a failing config check leaves configuration.yaml and the package dir as they were
"""
import json
import os
import shutil
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "eight_plus", "app"))
import detect as D  # noqa: E402
import installer as I  # noqa: E402


class FakeHA:
    def __init__(self, valid=True):
        self.valid = valid
        self.calls, self.services_called = [], []
        self.resources, self.dashboards, self.lovelace = [], [], {}
        self._states = {"climate.eight_sleep_pod_left": {"state": "heat_cool"},
                        "climate.eight_sleep_pod_right": {"state": "off"}}
        self.created = set()
        self.connected = True

    # installer-facing API
    def wait(self, t=0):
        return True

    def config(self):
        return {"state": "RUNNING"}

    def states(self):
        return {**self._states, **{e: {"state": "unknown"} for e in self.created}}

    def check_config(self):
        return {"result": "valid"} if self.valid else {"result": "invalid", "errors": "Invalid config for [template]: boom"}

    def service(self, domain, service, data=None, target=None, timeout=60):
        self.services_called.append((f"{domain}.{service}", data or {}))
        if (domain, service) in (("homeassistant", "restart"), ("homeassistant", "reload_all")):
            self.created |= set(self.expect)

    def call(self, msg, timeout=60):
        t = msg["type"]
        self.calls.append(t)
        if t == "lovelace/resources":
            return list(self.resources)
        if t == "lovelace/resources/create":
            r = {"id": f"r{len(self.resources)}", "url": msg["url"], "type": "module"}
            self.resources.append(r)
            return r
        if t == "lovelace/resources/update":
            for r in self.resources:
                if r["id"] == msg["resource_id"]:
                    r["url"] = msg["url"]
            return {}
        if t == "lovelace/resources/delete":
            self.resources = [r for r in self.resources if r["id"] != msg["resource_id"]]
            return {}
        if t == "lovelace/dashboards/list":
            return list(self.dashboards)
        if t == "lovelace/dashboards/create":
            self.dashboards.append({"id": msg["url_path"], "url_path": msg["url_path"]})
            return {}
        if t == "lovelace/dashboards/delete":
            self.dashboards = [d for d in self.dashboards if d["id"] != msg["dashboard_id"]]
            return {}
        if t == "lovelace/config/save":
            self.lovelace[msg["url_path"]] = msg["config"]
            return {}
        raise AssertionError(f"unexpected WS call {t}")


def answers():
    reg = json.load(open(os.path.join(ROOT, "tests", "fixtures", "registry.json")))
    bed = D.detect_all(reg, {})["gateway"]
    return {"backend": "gateway", "bed": bed,
            "sleepers": [{"name": "Alex", "side": "left", "notify": "notify.mobile_app_alex"},
                         {"name": "Sam", "side": "right", "notify": ""}],
            "room": {"weather": "weather.home", "temp": "sensor.bedroom_temperature", "humidity": ""},
            "features": {"autopilot": True, "smart": True, "coach": True, "notifications": True, "pipeline": True},
            "schedule": {"weekday_bed": "22:30", "weekday_wake": "07:00", "weekend_bed": "23:30", "weekend_wake": "08:30"}}


def run(inst):
    inst.progress["running"] = True
    inst._install(answers())
    return inst.progress


def mkenv(cfg_text, valid=True):
    d = tempfile.mkdtemp(prefix="eightplus-")
    cfg, data, bundle = (os.path.join(d, x) for x in ("config", "data", "bundle"))
    os.makedirs(cfg)
    os.makedirs(os.path.join(bundle, "assets"))
    open(os.path.join(cfg, "configuration.yaml"), "w").write(cfg_text)
    open(os.path.join(bundle, "eight-sleep-card.js"), "w").write("// card")
    for fn in ("es-bed.png", "es-pillows.png"):
        open(os.path.join(bundle, "assets", fn), "wb").write(b"png")
    ha = FakeHA(valid)
    inst = I.Installer(ha, cfg, data, bundle, "9.9.9", log=lambda *a: None)
    import generator as G
    ha.expect = G.build(answers(), "9.9.9")["entities"]
    I.time.sleep = lambda s: None          # no real waiting in tests
    return d, cfg, ha, inst


DEFAULT = "default_config:\n\nfrontend:\n  themes: !include_dir_merge_named themes\n\nautomation: !include automations.yaml\n"


def test_wiring():
    cases = [
        ("missing section", DEFAULT, "missing", True),
        ("section, no packages", "homeassistant:\n  name: Home\n  unit_system: metric\n" + DEFAULT, "missing", True),
        ("dir_named already", "homeassistant:\n  packages: !include_dir_named pkgs\n" + DEFAULT, "dir_named", False),
        ("merge_named", "homeassistant:\n  customize: !include c.yaml\n  packages: !include_dir_merge_named packages/\n", "dir_merge_named", False),
        ("inline map", "homeassistant:\n  packages:\n    foo: !include foo.yaml\n", "manual", None),
        ("inline homeassistant", "homeassistant: !include ha.yaml\n", "manual", None),
    ]
    for label, text, mode, changes in cases:
        d, cfg, ha, inst = mkenv(text)
        ps = inst.packages_setup()
        assert ps["mode"] == mode, (label, ps)
        if changes is None:
            try:
                inst._ensure_packages_line()
                raise AssertionError(f"{label}: should refuse")
            except I.InstallError:
                pass
        else:
            assert inst._ensure_packages_line() == changes, label
            assert inst.packages_setup()["mode"].startswith("dir_"), (label, open(os.path.join(cfg, "configuration.yaml")).read())
            if label == "section, no packages":
                t = open(os.path.join(cfg, "configuration.yaml")).read()
                assert t.startswith("homeassistant:\n  packages: !include_dir_named packages\n  name: Home"), t
        shutil.rmtree(d)
    print("ok  configuration.yaml wiring (6 shapes)")


def test_install_update_uninstall():
    d, cfg, ha, inst = mkenv(DEFAULT)
    p = run(inst)
    assert p["done"] and not p["error"], p
    files = os.listdir(os.path.join(cfg, "packages", "eight_plus"))
    assert sorted(files) == ["eight_plus_alex.yaml", "eight_plus_bed.yaml", "eight_plus_sam.yaml"], files
    assert os.path.isfile(os.path.join(cfg, "custom_templates", "eight_plus.jinja"))
    assert os.path.isfile(os.path.join(cfg, "www", "eight_plus", "eight-sleep-card.js"))
    assert "packages: !include_dir_named packages" in open(os.path.join(cfg, "configuration.yaml")).read()
    assert os.listdir(os.path.join(cfg, "eight_plus_backups"))
    assert ("homeassistant.restart", {}) in ha.services_called
    seeds = [s for s in ha.services_called if s[0].startswith(("input_", "counter"))]
    assert len(seeds) > 100, len(seeds)
    assert ha.resources and ha.resources[0]["url"].startswith("/local/eight_plus/eight-sleep-card.js")
    assert "eight-plus" in ha.lovelace and len(ha.lovelace["eight-plus"]["views"]) == 2
    st = inst.state
    assert st["installed"] and st["card"]["mode"] == "ours" and len(st["seeded"]) == len(seeds)
    assert inst.drift()["update"] == [] and inst.drift()["edited"] == []
    print(f"ok  install: {len(files)} package files, {len(seeds)} seeds, dashboard + resource")

    # a hand edit is reported as 'edited', not silently overwritten on the next drift check
    fp = os.path.join(cfg, "packages", "eight_plus", "eight_plus_sam.yaml")
    open(fp, "a").write("# my tweak\n")
    assert inst.drift()["edited"] == ["packages/eight_plus/eight_plus_sam.yaml"], inst.drift()

    # update: reload not restart, no re-seeding, HACS copy takes over from the bundled one
    ha.services_called.clear()
    ha.resources.append({"id": "hacs1", "url": "/hacsfiles/eight-plus/eight-sleep-card.js", "type": "module"})
    p = run(inst)
    assert p["done"], p
    names = [s[0] for s in ha.services_called]
    assert "homeassistant.restart" not in names and "homeassistant.reload_all" in names, names
    assert not [s for s in names if s.startswith(("input_", "counter"))], "re-seeded on update"
    assert [r["id"] for r in ha.resources] == ["hacs1"], ha.resources
    assert inst.state["card"]["mode"] == "hacs"
    assert "# my tweak" not in open(fp).read()
    print("ok  update: reload only, no re-seed, switched to the HACS card")

    # uninstall
    inst.progress["running"] = True
    inst._uninstall(False)
    assert inst.progress["done"], inst.progress
    assert not os.path.exists(os.path.join(cfg, "packages", "eight_plus"))
    assert not os.path.exists(os.path.join(cfg, "custom_templates", "eight_plus.jinja"))
    assert not ha.dashboards and [r["id"] for r in ha.resources] == ["hacs1"]
    assert not inst.state["installed"]
    print("ok  uninstall: files, dashboard gone; HACS resource left alone")
    shutil.rmtree(d)


def test_rollback():
    d, cfg, ha, inst = mkenv(DEFAULT, valid=False)
    before = open(os.path.join(cfg, "configuration.yaml")).read()
    p = run(inst)
    assert p["error"] and "rejected" in p["error"], p
    assert open(os.path.join(cfg, "configuration.yaml")).read() == before
    assert not os.path.exists(os.path.join(cfg, "packages", "eight_plus", "eight_plus_bed.yaml"))
    assert not [s for s in ha.services_called if s[0] == "homeassistant.restart"]
    assert not inst.state.get("installed")
    print("ok  rollback: invalid config -> configuration.yaml restored, nothing restarted")
    shutil.rmtree(d)


def test_collision():
    d, cfg, ha, inst = mkenv(DEFAULT)
    ha._states["input_boolean.eight_sleep_alex_smart_autopilot"] = {"state": "on"}
    p = run(inst)
    assert p["error"] and "already exist" in p["error"], p
    assert not os.path.exists(os.path.join(cfg, "packages"))
    print("ok  collision: refused before touching anything")
    shutil.rmtree(d)


if __name__ == "__main__":
    t0 = time.time()
    test_wiring()
    test_install_update_uninstall()
    test_rollback()
    test_collision()
    print(f"ALL GOOD ({time.time() - t0:.1f}s)")

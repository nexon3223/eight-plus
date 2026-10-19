// Standalone Pod webapp — connects to the kiosk proxy (/ws) and drives the card.
// No login: the HA token lives on the server, this page just speaks the HA WS API.

// Card config (mirrors the real dashboard card; asset paths point at this app).
// Card config comes from the add-on (/config.js), built from your setup answers.
const CONFIG = window.__POD_CONFIG || { type: "custom:eight-sleep-card", layout: "v2" };

// Last-known HA state, so the card paints real values the instant the app opens instead of
// defaults while the websocket connects. Slimmed (no context/last_updated) and written at most
// every 30 s + when the page is hidden. Anything older than a week is ignored.
const CACHE_KEY = "pod.states.v1";
const CACHE_MAX_AGE = 7 * 864e5;
function loadCachedStates() {
  try {
    const j = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (j && j.states && Date.now() - j.t < CACHE_MAX_AGE) return j.states;
  } catch (_) {}
  return null;
}

class HAConn {
  // urls: tried in order on every (re)connect — the native app passes [LAN, remote] so home
  // Wi-Fi skips the internet round trip; the served build passes just its own origin.
  constructor(urls) {
    this.urls = Array.isArray(urls) ? urls : [urls];
    this._u = 0;
    this._id = 1;
    this._pending = new Map();
    this._queue = [];              // service calls made before the socket was ready
    this._waiters = [];            // callWS() callers waiting for ready
    this.states = loadCachedStates() || {};
    this.fromCache = Object.keys(this.states).length > 0;
    this.ready = false;
    this.onUpdate = null;
    this.onStatus = null;
    this._connect();
    const save = () => this._saveCache();
    document.addEventListener("visibilitychange", () => { if (document.hidden) save(); });
    window.addEventListener("pagehide", save);
  }
  get url() { return this.urls[this._u % this.urls.length]; }
  _connect() {
    const url = this.url;
    let ws;
    try { ws = this.ws = new WebSocket(url); } catch (e) { this._next(); return; }
    // a LAN address that isn't reachable (away from home) can hang instead of failing — give
    // up on it quickly and move on to the next URL
    const isLast = this._u % this.urls.length === this.urls.length - 1;
    clearTimeout(this._ot);
    if (!isLast) this._ot = setTimeout(() => { if (ws.readyState !== 1) { try { ws.close(); } catch (_) {} } }, 1800);
    ws.onopen = () => { clearTimeout(this._ot); this._init(ws); };
    ws.onmessage = (e) => this._msg(e);
    ws.onclose = () => {
      clearTimeout(this._ot);
      if (ws !== this.ws) return;
      const wasReady = this.ready;
      this.ready = false;
      if (wasReady) this._status(false);         // a LAN miss on a cold start isn't news
      if (wasReady) this._reconnect(0);           // dropped: retry the same URL first
      else this._next();                          // never got there: try the next one
    };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }
  _next() {
    this._u++;
    // walked the whole list without connecting
    if (this._u % this.urls.length === 0) { this._maybeLogin(); this._reconnect(1500); }
    else this._reconnect(0);
  }
  _reconnect(delay) {
    clearInterval(this._ka);
    if (this._rt) return;
    this._rt = setTimeout(() => { this._rt = null; this._connect(); }, delay);
  }
  _status(ok) { if (this.onStatus) this.onStatus(ok); }
  // Bundled-UI escape hatch: served from pod:// there is no login page to fall back to, so a
  // fresh install with no es_session cookie would retry the websocket forever. After a few
  // full rounds of failures, navigate to the real origin — that runs the HA login, and the
  // served build works from there. Only ever fires in the native app (__POD_LOGIN is injected).
  _maybeLogin() {
    if (!window.__POD_LOGIN || this.ready) return;
    this._fails = (this._fails || 0) + 1;
    if (this._fails < 4) return;
    location.href = window.__POD_LOGIN;
  }
  _send(obj) { obj.id = this._id++; this.ws.send(JSON.stringify(obj)); return obj.id; }
  _cmd(obj) {
    return new Promise((res, rej) => {
      let id;
      try { id = this._send(obj); } catch (e) { return rej(e); }
      this._pending.set(id, { res, rej });
    });
  }
  async _init(ws) {
    try {
      const st = await this._cmd({ type: "get_states" });
      if (ws !== this.ws) return;
      const fresh = {};
      for (const s of st) fresh[s.entity_id] = s;
      this.states = fresh;
      this.fromCache = false;
      this._send({ type: "subscribe_events", event_type: "state_changed" });
      this.ready = true;
      this._fails = 0;
      try { performance.mark("pod-live"); } catch (_) {}
      this._status(true);
      this._flush();
      this._drain();
      this._saveCache();
      clearInterval(this._ka);
      this._ka = setInterval(() => { try { this._send({ type: "ping" }); } catch (_) {} }, 30000);
    } catch (e) {
      this._status(false);
    }
  }
  _msg(e) {
    let m; try { m = JSON.parse(e.data); } catch (_) { return; }
    if (m.type === "result") {
      const p = this._pending.get(m.id);
      if (p) { this._pending.delete(m.id); m.success === false ? p.rej(m.error) : p.res(m.result); }
      return;
    }
    if (m.type === "pong") return;
    if (m.type === "event" && m.event && m.event.event_type === "state_changed") {
      const d = m.event.data; if (!d) return;
      if (d.new_state) this.states[d.entity_id] = d.new_state; else delete this.states[d.entity_id];
      this._flush();
      this._saveSoon();
      return;
    }
    if (m.type === "kiosk_error") { console.warn("[kiosk]", m.message); this._status(false); }
  }
  _flush() {
    // NB: setTimeout, not requestAnimationFrame — rAF is frozen while the tab is
    // backgrounded, which would stall live updates on a phone webapp.
    if (!this.onUpdate || this._pf) return;
    this._pf = setTimeout(() => {
      this._pf = 0;
      try { this.onUpdate(); } catch (e) { console.error("[kiosk] update failed", e); }
    }, 60);
  }

  // ── cache ──
  _saveSoon() {
    if (this._sv) return;
    this._sv = setTimeout(() => { this._sv = 0; this._saveCache(); }, 30000);
  }
  _saveCache() {
    if (this.fromCache) return;              // nothing new to write yet
    try {
      const slim = {};
      for (const [k, s] of Object.entries(this.states)) {
        slim[k] = { entity_id: k, state: s.state, attributes: s.attributes, last_changed: s.last_changed };
      }
      localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), states: slim }));
    } catch (_) { /* quota / private mode: the cache is only a head start */ }
  }

  // ── writes before we're connected ──
  // Tap "turn on" while the app is still connecting and it goes out the moment the socket is
  // up. Repeats of the same call on the same entity collapse to the last one (so dragging the
  // temperature while offline sends one set_temperature, not twenty), and the change is shown
  // straight away on the cached state so the UI answers the tap.
  callService(domain, service, data) {
    data = data || {};
    if (this.ready) return this._cmd({ type: "call_service", domain, service, service_data: data });
    this._optimistic(domain, service, data);
    const key = `${domain}.${service}:${JSON.stringify(data.entity_id || "")}`;
    const opposite = { turn_on: "turn_off", turn_off: "turn_on" }[service];
    const oppKey = opposite && `${domain}.${opposite}:${JSON.stringify(data.entity_id || "")}`;
    return new Promise((res, rej) => {
      this._queue = this._queue.filter((q) => {
        if (q.key === key || q.key === oppKey) { q.res(null); return false; }
        return true;
      });
      this._queue.push({ key, domain, service, data, res, rej });
      this._flush();
      if (this.onQueue) this.onQueue(this._queue.length);
    });
  }
  _drain() {
    const q = this._queue; this._queue = [];
    for (const it of q) {
      this._cmd({ type: "call_service", domain: it.domain, service: it.service, service_data: it.data })
        .then(it.res, it.rej);
    }
    if (q.length && this.onQueue) this.onQueue(0);
    const w = this._waiters; this._waiters = [];
    for (const f of w) f();
  }
  _optimistic(domain, service, data) {
    const ids = [].concat(data.entity_id || []);
    for (const id of ids) {
      const cur = this.states[id];
      if (!cur) continue;
      const s = { ...cur, attributes: { ...cur.attributes } };
      if (domain === "climate" && service === "set_temperature" && data.temperature != null) s.attributes.temperature = data.temperature;
      else if (domain === "climate" && service === "turn_on") s.state = data.hvac_mode || "heat_cool";
      else if (domain === "climate" && service === "turn_off") s.state = "off";
      else if (domain === "climate" && service === "set_hvac_mode" && data.hvac_mode) s.state = data.hvac_mode;
      else if (service === "turn_on" && /^(input_boolean|switch|light)$/.test(domain)) s.state = "on";
      else if (service === "turn_off" && /^(input_boolean|switch|light)$/.test(domain)) s.state = "off";
      else if (service === "toggle" && /^(input_boolean|switch|light)$/.test(domain)) s.state = cur.state === "on" ? "off" : "on";
      else if (domain === "input_number" && service === "set_value") s.state = String(data.value);
      else continue;
      this.states[id] = s;
    }
  }
  async callWS(msg) {
    if (!this.ready) await new Promise((r) => this._waiters.push(r));
    return this._cmd(Object.assign({}, msg));
  }
}

// iOS Safari has no navigator.vibrate. Toggling a hidden <input switch> pulses the
// Taptic engine (iOS 17.4+). The card fires a bubbling/composed "haptic" event on every
// tap/drag tick; we catch it here and click the switch (we're inside the user gesture).
function setupHaptics() {
  let label = null;
  try {
    label = document.createElement("label");
    label.setAttribute("aria-hidden", "true");
    label.style.display = "none";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("switch", "");
    label.appendChild(input);
    document.body.appendChild(label);
  } catch (_) { label = null; }
  window.addEventListener("haptic", () => {
    try { if (label) label.click(); } catch (_) {}
    try { if (navigator.vibrate) navigator.vibrate(8); } catch (_) {}
  }, true);
}

function makeHass(ha) {
  return {
    states: ha.states,
    callService: (d, s, data) => ha.callService(d, s, data),
    callWS: (m) => ha.callWS(m),
    config: { unit_system: { temperature: "°C" } },
    user: { is_admin: true, name: "Pod" },
    themes: { darkMode: true },
    selectedTheme: null,
    language: "en",
    locale: { language: "en", number_format: "language", time_format: "12" },
    connection: { connected: ha.ready },
    entities: {}, devices: {}, areas: {}, services: {},
  };
}

(async () => {
  setupHaptics();
  const splash = document.getElementById("splash");
  const conn = document.getElementById("conn");
  let lifted = false;
  function liftSplash() {
    if (lifted || !splash) return;
    lifted = true;
    splash.classList.add("hide");
    setTimeout(() => { try { splash.remove(); } catch (_) {} }, 600);
  }
  // safety net: never let the splash trap the screen
  setTimeout(liftSplash, 4000);

  try {
    await customElements.whenDefined("eight-sleep-card");
    const card = document.createElement("eight-sleep-card");
    card.setConfig(CONFIG);
    document.getElementById("app").appendChild(card);

    // window.__POD_WS is injected by the native app when the UI is served from inside the
    // bundle (pod:// has no host to derive this from). Served from the kiosk it is absent and
    // this falls back to the page's own origin, so one app.js works both ways.
    // __POD_WS_LIST (native app, newer builds) = LAN first, then remote.
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ha = new HAConn(window.__POD_WS_LIST || window.__POD_WS || `${proto}://${location.host}/ws`);
    window.__esha = ha;  // debug handle

    // Render immediately — from the cached snapshot when there is one, defaults otherwise.
    card.hass = makeHass(ha);
    try { performance.mark("pod-first-render"); } catch (_) {}
    // tell the native shell the UI is on screen (it holds its own splash until then)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      try { window.webkit.messageHandlers.ready.postMessage(1); } catch (_) {}
    }));
    setTimeout(liftSplash, ha.fromCache ? 0 : 80);

    ha.onUpdate = () => { card.hass = makeHass(ha); };
    // Banner: quiet while a cold start connects (the cached UI is already usable); only speak
    // up if it's taking a while, if taps are waiting, or if a live connection dropped.
    let queued = 0, slow = false;
    const paint = () => {
      const show = !ha.ready && (slow || queued > 0);
      conn.textContent = queued > 0 ? "Connecting… your change will send" : (ha.fromCache ? "Connecting…" : "Reconnecting…");
      conn.classList.toggle("show", show);
      conn.classList.toggle("soft", show && queued === 0 && ha.fromCache);
    };
    const slowT = setTimeout(() => { slow = true; paint(); }, 2500);
    ha.onStatus = (ok) => { if (ok) { clearTimeout(slowT); slow = false; } else slow = true; paint(); };
    ha.onQueue = (n) => { queued = n; paint(); };
  } catch (e) {
    console.error("[kiosk] boot failed", e);
    liftSplash();
    if (conn) { conn.textContent = "Load error — check console"; conn.classList.add("show"); }
  }

  // register the service worker (offline app-shell launch)
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
})();

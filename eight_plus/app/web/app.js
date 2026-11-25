// Eight+ setup panel — onboarding wizard + home screen. Vanilla, no build.
// Runs inside Home Assistant ingress, so every URL is RELATIVE ("api/…", never "/api/…").

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const api = async (path, body) => {
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
};
const slugify = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const hm12 = (t) => { if (!t) return ""; const [h, m] = t.split(":").map(Number); return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`; };
const mins = (t) => { const [h, m] = (t || "0:0").split(":").map(Number); return h * 60 + m; };
const hhmm = (m) => { m = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };

const ICON = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="m11 6-6 6 6 6"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
};
const LOGO = (cls = "") => `<img class="logo ${cls}" src="icon.png" alt="Eight+">`;

const REPO = "https://github.com/nexon3223/eight-plus";
const STEPS = ["welcome", "backend", "people", "routine", "room", "features", "review"];
const PHASES = [["bedtime", "Bedtime", 32], ["winddown", "Wind-down", 30], ["early", "Early", 28], ["late", "Late", 27], ["deep", "Deep", 26], ["prewake", "Pre-wake", 30], ["wake", "Wake", 35]];

const S = {
  status: null, det: null, step: "welcome", view: "wizard", err: null, busy: false,
  preview: null, progress: null, couple: false, standalone: false, overrides: {},
  a: {
    backend: null, bed: null,
    sleepers: [{ name: "", side: "left", notify: "" }, { name: "", side: "right", notify: "" }],
    room: { weather: "", temp: "", humidity: "" },
    features: { autopilot: true, smart: true, notifications: true, pipeline: true },
    schedule: { weekday_bed: "22:30", weekday_wake: "07:00", weekend_bed: "23:30", weekend_wake: "08:30" },
    winddown_scene: "",
    pipeline: { source: "ha", host: "", port: 8822, user: "root", sudo: true },
    dashboard: { url_path: "eight-plus", title: "Eight+" },
  },
};

// ───────────────────────────────────────────── helpers
function answers() {
  const a = structuredClone(S.a);
  a.sleepers = S.couple ? a.sleepers : [a.sleepers[0]];
  a.sleepers.forEach((s) => (s.name = s.name.trim()));
  const found = S.det?.backends?.[a.backend];
  if (found) {
    const bed = structuredClone(found);
    for (const [side, o] of Object.entries(S.overrides[a.backend] || {}))
      for (const [k, v] of Object.entries(o)) { bed.sides[side] = bed.sides[side] || {}; if (v) bed.sides[side][k] = v; }
    a.bed = bed;
  }
  if (!a.features.autopilot) a.features.smart = false;
  delete a.features.coach;   // Sleep Coach is deprecated — never sent, even from older saved answers
  return a;
}
function sidesAvailable() { return Object.keys(S.det?.backends?.[S.a.backend]?.sides || {}); }
function nightPhases(bed, wake) {
  const b = mins(bed), span = ((mins(wake) - b) % 1440 + 1440) % 1440 || 480;
  const r5 = (x) => Math.round(x / 5) * 5;
  const rel = { bedtime: 0, winddown: r5(span * .06), early: r5(span * .16), late: r5(span * .30), deep: r5(span * .55), prewake: r5(Math.max(span - 45, span * .85)), wake: span };
  return { rel, span, at: Object.fromEntries(Object.entries(rel).map(([k, v]) => [k, hhmm(b + v)])) };
}
function goto(step) { S.step = step; S.err = null; render(); window.scrollTo({ top: 0, behavior: "smooth" }); }
function openInHA(path) {
  try { const w = window.top; w.history.pushState(null, "", "/" + path); w.dispatchEvent(new CustomEvent("location-changed")); }
  catch (_) { window.open("/" + path, "_top"); }
}
function appUrl() {
  let host = location.hostname;
  try { host = window.top.location.hostname; } catch (_) {}
  return `http://${host}:${S.status?.app?.port || 8098}`;
}

// ───────────────────────────────────────────── validation per step
function problems(step) {
  const a = S.a, out = [];
  if (step === "backend") {
    if (!a.backend) out.push("Pick how Home Assistant talks to your Pod.");
    else if (!S.det.backends[a.backend]) out.push("That connection isn't set up in Home Assistant yet — follow its setup guide, then Rescan.");
  }
  if (step === "people") {
    const list = S.couple ? a.sleepers : [a.sleepers[0]];
    list.forEach((s, i) => { if (!s.name.trim()) out.push(`Give ${S.couple ? `sleeper ${i + 1}` : "yourself"} a name.`); });
    if (S.couple && slugify(a.sleepers[0].name) === slugify(a.sleepers[1].name) && a.sleepers[0].name) out.push("The two names need to be different.");
    if (S.couple && a.sleepers[0].side === a.sleepers[1].side) out.push("Two people can't share a side.");
    const bed = answers().bed;
    list.forEach((s) => { const sd = bed?.sides?.[s.side]; if (!sd?.climate) out.push(`No climate control found for the ${s.side} side.`); else if (!sd.presence) out.push(`Pick a bed-presence sensor for the ${s.side} side (Connect step).`); });
    const clash = list.map((s) => "eight_sleep_" + slugify(s.name)).filter((p) => (S.det.existing_prefixes || []).includes(p) && !(S.status?.install?.sleepers || []).some((x) => x.p === p));
    if (clash.length) out.push(`You already have Eight Sleep helpers named ${clash.join(", ")} from a manual setup — choose a different name so Eight+ doesn't collide with them.`);
  }
  if (step === "review" && S.preview?.collisions?.length) out.push("Some entities already exist — go back and pick different names.");
  if (step === "review" && S.preview?.packages?.mode === "manual") out.push("Wire up packages by hand first (see the note above), then come back.");
  return out;
}

// ───────────────────────────────────────────── chrome
function top() {
  const off = S.status && !S.status.ha_connected ? '<span class="ha-off">● Home Assistant offline</span>' : "";
  if (S.view !== "wizard") return `<div class="top">${LOGO("sm")}<div class="spacer"></div>${off}</div>`;
  const i = STEPS.indexOf(S.step);
  const lead = i > 0 ? `<button class="back" data-act="back" aria-label="Back">${ICON.back}</button>` : LOGO("sm");
  const dashes = STEPS.slice(1).map((_, k) => `<i class="${k + 1 === i ? "on" : k + 1 < i ? "done" : ""}"></i>`).join("");
  return `<div class="top">${lead}<div class="steps">${dashes}</div>${off}</div>`;
}
function head(eyebrow, title, lede) {
  return `${eyebrow ? `<div class="eyebrow">${eyebrow}</div>` : ""}<h1>${title}</h1>${lede ? `<p class="lede">${lede}</p>` : ""}`;
}
function nav(...args) { S._nav = args; return `<div class="nav" id="navbox">${navInner(...args)}</div>`; }
function renderNav() { const b = $("#navbox"); if (b && S._nav) b.innerHTML = navInner(...S._nav); }
function navInner(nextLabel = "Continue", nextAct = "next", alt = "") {
  // problems only show once someone has tried to move on — no scolding an untouched form
  const issues = S.tried === S.step ? problems(S.step) : [];
  return `${issues.length ? `<div class="note warn issues">${issues.map(esc).join("<br>")}</div>` : ""}
    ${alt ? `<div class="alt">${alt}</div>` : ""}
    <button class="btn primary" data-act="${nextAct}" ${issues.length || S.busy ? "disabled" : ""}>${nextLabel}</button>`;
}

// ───────────────────────────────────────────── wizard steps
function vWelcome() {
  const d = S.det, pk = d.packages;
  const found = Object.values(d.backends).filter((b) => b && b.online !== false);
  const stale = Object.values(d.backends).filter((b) => b && b.online === false);
  const list = (xs) => xs.map((f) => `<b>${esc(f.label)}</b>`).join(xs.length > 2 ? ", " : " and ").replace(/, (?=[^,]*$)/, " and ");
  // passing checks are one line; only the ones that need attention explain themselves
  const chk = (ok, label, detail, level = "warn") => `<li><span class="st ${ok ? "ok" : level}">${ok ? "✓" : "!"}</span><div><div>${label}</div>${ok ? "" : `<div class="d">${detail}</div>`}</div></li>`;
  return `<div class="screen fade"><div class="hero">${LOGO("xl")}
    <h1>Your Pod, run by your home.</h1>
    <p class="lede">Schedules, a weather-aware Autopilot and nightly sleep reports — set up as plain Home Assistant helpers. About three minutes.</p>
    <div class="glass"><ul class="checks">
      ${chk(found.length > 0, found.length ? `Found your Pod via ${list(found)}` : "No Pod connection yet", (found.length ? "We'll confirm the details next." : "The next step shows how to connect one.") + (stale.length ? ` (${stale.map((f) => esc(f.label)).join(", ")} ${stale.length > 1 ? "are" : "is"} registered but offline.)` : ""))}
      ${chk(pk.mode.startsWith("dir_") || pk.mode === "missing", pk.mode.startsWith("dir_") ? `Packages are on` : pk.mode === "missing" ? "Packages will be switched on" : "Packages need a manual step", pk.mode.startsWith("dir_") ? `<span class="mono">${esc(pk.dir)}/</span>` : pk.mode === "missing" ? "One line in configuration.yaml, backed up first." : esc(pk.why || "Eight+ keeps all its YAML in one folder."), "bad")}
      ${chk(d.mqtt_broker || d.integrations.mqtt, d.mqtt_broker ? "MQTT broker available" : d.integrations.mqtt ? "MQTT is set up" : "No MQTT broker", d.mqtt_broker ? "Sleep reports publish as proper devices." : d.integrations.mqtt ? "External broker? Add its login in the add-on's Configuration tab." : "Sleep reports are written straight into Home Assistant instead.")}
      ${chk(d.card.found, d.card.found ? `Card installed (${esc(d.card.mode)})` : "Card not installed yet", d.card.found ? esc(d.card.url) : "We'll install the bundled copy. Use HACS later for updates.")}
    </ul></div></div>
    ${nav("Get started")}</div>`;
}

const BACKENDS = [
  { id: "gateway", name: "Eight+ Pod gateway", tag: "Local · real-time · vitals, presence, vibration", setup: "Needs a rooted Pod 3.", link: REPO + "/blob/main/docs/pod-gateway.md" },
  { id: "freesleep", name: "free-sleep", tag: "Local · community firmware", setup: "Flash free-sleep, then add hass-free-sleep from HACS.", link: "https://github.com/throwaway31265/free-sleep" },
  { id: "cloud", name: "Eight Sleep cloud", tag: "Cloud · nothing to flash", setup: "Add the eight_sleep integration from HACS and sign in.", link: "https://github.com/lukas-clarke/eight_sleep" },
];
const FIELD_LABEL = { climate: "Temperature control", presence: "Bed presence", heart_rate: "Heart rate", hrv: "HRV", breath_rate: "Breathing rate", bed_temp: "Bed temperature", water_temp: "Water temperature" };

function vBackend() {
  const d = S.det;
  const rows = BACKENDS.map((b) => {
    const f = d.backends[b.id], sel = S.a.backend === b.id;
    const chip = !f ? '<span class="chip">Not set up</span>' : f.online === false ? '<span class="chip warn">Offline</span>'
      : `<span class="chip ok">Found · ${Object.keys(f.sides).length} side${Object.keys(f.sides).length > 1 ? "s" : ""}</span>`;
    return `<div class="opt ${sel ? "sel" : ""} ${f ? "" : "dim"}" role="button" tabindex="0" data-act="backend" data-id="${b.id}">
      <span class="box">${ICON.check}</span>
      <div class="t"><div class="n">${b.name}</div><div class="d">${f ? b.tag : `${b.setup} <a href="${b.link}" target="_blank" rel="noopener">Guide ↗</a>`}</div></div>${chip}</div>`;
  }).join("");
  let detail = "";
  const f = d.backends[S.a.backend];
  if (f) {
    const ov = S.overrides[S.a.backend] || {};
    let missing = false;
    const sides = Object.entries(f.sides).map(([side, ents]) => {
      const trs = Object.entries(FIELD_LABEL).map(([k, label]) => {
        const v = (ov[side] || {})[k] || ents[k];
        if (!v && !["presence", "climate"].includes(k)) return "";
        if (v && !(ov[side] || {})[k]) return `<tr><td>${label}</td><td class="mono">${esc(v)}</td></tr>`;
        if (!v) missing = true;
        const dom = k === "presence" ? "binary_sensor." : k === "climate" ? "climate." : "sensor.";
        const opts = d.all_entities.filter((e) => e.startsWith(dom));
        return `<tr><td>${label}</td><td>${v ? "" : '<div class="miss">Not found — pick one</div>'}
          <select data-ov="${side}.${k}"><option value="">—</option>${opts.map((e) => `<option ${e === v ? "selected" : ""}>${esc(e)}</option>`).join("")}</select></td></tr>`;
      }).join("");
      return `<div class="label" style="text-transform:uppercase">${side} side</div><div class="glass"><table class="ents">${trs}</table></div>`;
    }).join("");
    detail = `${f.notes.map((n) => `<div class="note gap">${esc(n)}</div>`).join("")}
      <details ${missing ? "open" : ""}><summary>What we found</summary>${sides}</details>`;
  }
  return `<div class="screen fade">${head("Connecting your Pod", "How does Home Assistant reach your Pod?")}
    <div class="opts">${rows}</div>${detail}
    ${nav("Continue", "next", '<button class="btn link" data-act="rescan">Rescan</button>')}</div>`;
}

/* ---------- the bed: the app's mattress photo with a dot field laid onto it ----------
   Same geometry as the Pod card / native app (one outline + a homography so the grid recedes with
   the bed while every dot stays round). Dots are dim until someone sleeps on that side, then a
   sweep of white runs from the pillows to the foot and leaves them lit. */
const BED = (() => {
  const W = 420, H = 234, COLS = 71, ROWS = 34;
  const Q = [[22.3, 12.8], [76.8, 12.1], [85.2, 53.8], [14.1, 53.7]];
  const POLY = "22.1 13.3, 22.2 13.0, 22.3 12.8, 22.5 12.6, 22.7 12.5, 23.0 12.5, 23.4 12.4, 75.7 11.8, 76.1 11.8, 76.4 11.9, 76.6 12.0, 76.8 12.1, 76.9 12.3, 77.0 12.6, 85.3 53.3, 85.3 53.5, 85.2 53.8, 85.1 53.9, 84.8 54.0, 84.5 54.1, 84.0 54.1, 15.1 53.9, 14.7 53.9, 14.4 53.8, 14.1 53.7, 13.9 53.5, 13.9 53.3, 13.9 53.1"
    .split(",").map((p) => p.trim().split(" ").map(Number));
  const ss = (lo, hi, x) => { const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo))); return t * t * (3 - 2 * t); };
  function solve(a, b) {   // Gauss-Jordan, pivoted
    const n = b.length, m = a.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
      [m[c], m[p]] = [m[p], m[c]];
      const pv = m[c][c]; for (let j = c; j <= n; j++) m[c][j] /= pv;
      for (let r = 0; r < n; r++) if (r !== c && m[r][c]) { const f = m[r][c]; for (let j = c; j <= n; j++) m[r][j] -= f * m[c][j]; }
    }
    return m.map((r) => r[n]);
  }
  const dots = (() => {
    const dst = Q.map(([x, y]) => [x / 100 * W, y / 100 * H]), src = [[0, 0], [1, 0], [1, 1], [0, 1]], A = [], B = [];
    src.forEach(([x, y], i) => { const [u, v] = dst[i]; A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]); B.push(u); A.push([0, 0, 0, x, y, 1, -x * v, -y * v]); B.push(v); });
    const h = solve(A, B), over = 0.04, k = 0.255;
    const P = (s, t) => { const w = h[6] * s + h[7] * t + 1; return [(h[0] * s + h[1] * t + h[2]) / w, (h[3] * s + h[4] * t + h[5]) / w]; };
    const sa = (i) => -over + (1 + 2 * over) * (i + 0.5) / COLS, ta = (j) => -over + (1 + 2 * over) * (j + 0.5) / ROWS;
    const half = 2 / COLS, out = [];
    for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
      const s = sa(i), t = ta(j), p = P(s, t), p2 = P(sa(i + 1 < COLS ? i + 1 : i - 1), t);
      const rs = (s - 0.5) / 0.5, rt = (t - 0.5) / 0.5, rr = Math.sqrt(rs * rs * 0.92 + rt * rt);
      const o = (1 - 0.86 * ss(0.44, 1.12, rr)) * (0.52 + 0.48 * Math.min(1, Math.max(0, t)));
      if (o < 0.045) continue;
      out.push({ x: p[0], y: p[1], r: k * Math.abs(p2[0] - p[0]), o, t: Math.min(1, Math.max(0, t)), m: ss(0.5 - half, 0.5 + half, s) });
    }
    return out;
  })();
  // per-side light, kept across re-renders so a change plays as a sweep rather than a jump
  const side = { l: { want: null, from: 0, to: 0, at: 0 }, r: { want: null, from: 0, to: 0, at: 0 } };
  let raf = 0;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const level = (sd, now) => {   // how far along the sweep we are, 0..1.5 (the front runs past the foot)
    const age = (now - sd.at) / 1000;
    return reduce ? 1.5 : age / 0.85 * 1.5;
  };
  function paint(cv, now) {
    const box = cv.getBoundingClientRect(); if (!box.width) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1), pw = Math.round(box.width * dpr), ph = Math.round(box.width * H / W * dpr);
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; cv.style.height = `${box.width * H / W}px`; }
    const c = cv.getContext("2d"), sc = pw / W;
    c.setTransform(sc, 0, 0, sc, 0, 0); c.clearRect(0, 0, W, H);
    // the sheet plate: one dark plate over the whole mattress top
    c.beginPath(); POLY.forEach(([x, y], i) => c[i ? "lineTo" : "moveTo"](x / 100 * W, y / 100 * H)); c.closePath();
    c.fillStyle = "rgba(4,5,10,.70)"; c.fill(); c.save(); c.clip();
    const f = { l: level(side.l, now), r: level(side.r, now) };
    const amt = (sd, fr, t) => { const a = ss(0, 1, (fr - t) / 0.38); return sd.from + (sd.to - sd.from) * a; };
    const breathe = reduce ? 0 : 0.5 + 0.5 * Math.sin(now / 1400);
    for (const d of dots) {
      const lv = amt(side.l, f.l, d.t) * (1 - d.m) + amt(side.r, f.r, d.t) * d.m;
      const wave = reduce ? 0 : Math.sin(now / 900 - d.t * 6) * 0.5 + 0.5;
      const glow = lv * (0.78 + 0.22 * wave * (0.6 + 0.4 * breathe));
      const base = 0.18 * d.o, a = base + (d.o * 0.98 - base) * glow;
      // unlit: cool grey; lit: white
      const g = 112 + 143 * glow;
      c.fillStyle = `rgba(${g},${g + 2},${g + 8},${Math.min(1, a)})`;
      c.beginPath(); c.arc(d.x, d.y, d.r * (1 + 0.16 * glow), 0, 6.2832); c.fill();
    }
    c.restore();
    const hero = cv.closest(".bedhero");
    if (hero) { const l = hero.querySelector(".bedglow.l"), r = hero.querySelector(".bedglow.r"); const gl = (sd, fr) => (sd.from + (sd.to - sd.from) * Math.min(1, Math.max(0, fr / 1.2))); if (l) l.style.opacity = gl(side.l, f.l); if (r) r.style.opacity = gl(side.r, f.r); }
  }
  function run() {
    cancelAnimationFrame(raf);
    const cv = document.querySelector("canvas.bedfield");
    if (!cv) return;
    const tick = (now) => {
      if (!cv.isConnected) return;
      paint(cv, now);
      if (reduce && Math.max(level(side.l, now), level(side.r, now)) >= 1.5) return;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }
  return {
    set(cv) {
      const now = performance.now();
      for (const k of ["l", "r"]) {
        const want = +cv.dataset[k], sd = side[k];
        if (sd.want === null) { sd.from = sd.to = want; sd.at = now - 9999; }      // first paint: no sweep
        else if (sd.to !== want) {
          sd.from = sd.from + (sd.to - sd.from) * Math.min(1, Math.max(0, level(sd, now) / 1.2));   // start from what's showing
          sd.to = want; sd.at = now;
        }
        sd.want = want;
      }
      run();
    },
  };
})();
function paintBed() { const cv = document.querySelector("canvas.bedfield"); if (cv) BED.set(cv); }

function vPeople() {
  const avail = sidesAvailable();
  const two = avail.length > 1;
  if (!two) S.couple = false;
  const s = S.a.sleepers;
  const who = (side) => { const i = s.findIndex((x, k) => x.side === side && (k === 0 || S.couple)); return i < 0 ? null : i; };
  const half = (side) => {
    if (!avail.includes(side)) return `<div class="bedhalf ${side[0]} off">No ${side} side</div>`;
    const i = who(side);
    return `<div class="bedhalf ${side[0]} ${i != null ? "taken" : ""}" data-act="side" data-side="${side}" role="button" tabindex="0">
      ${i != null ? `<div class="who" data-live="name-${i}">${esc(s[i].name || (i ? "Partner" : "You"))}</div><div class="side">${side}</div>` : `<div class="side">Tap to sleep here</div><div class="side sub">${side}</div>`}</div>`;
  };
  const lit = (side) => (avail.includes(side) && who(side) != null ? 1 : 0);
  const bedHero = `<div class="bedhero"><div class="bedglow l"></div><div class="bedglow r"></div>
    <div class="bedphoto"><img src="es-bed.png" alt="" draggable="false"><canvas class="bedfield" data-l="${lit("left")}" data-r="${lit("right")}"></canvas>
    <img class="bedpillows" src="es-pillows.png" alt="" draggable="false">${half("left")}${half("right")}</div></div>`;
  const notifyOpts = (cur) => `<option value="">No phone notifications</option>${S.det.pickers.notify.map((n) => `<option ${n === cur ? "selected" : ""} value="${n}">${esc(n.replace("notify.mobile_app_", "").replace(/_/g, " "))}</option>`).join("")}`;
  const person = (i) => `<div>${S.couple ? `<div class="label">${i ? "Second sleeper" : "First sleeper"}</div>` : ""}
      <label class="field"><span>${i ? "Their name" : "Your name"}</span><input type="text" maxlength="24" placeholder="${i ? "e.g. Sam" : "e.g. Alex"}" data-bind="sleepers.${i}.name" value="${esc(s[i].name)}"><small>Helpers: <span class="mono" data-live="prefix-${i}">eight_sleep_${esc(slugify(s[i].name) || "…")}_*</span></small></label>
      <label class="field"><span>Phone for bed notifications</span><select data-bind="sleepers.${i}.notify">${notifyOpts(s[i].notify)}</select>${S.det.pickers.notify.length ? "" : "<small>Install the Companion app on a phone to get these.</small>"}</label></div>`;
  return `<div class="screen fade">${head("", "Who sleeps in this bed?", two ? "Each person gets their own schedule, Autopilot and reports." : "You get your own schedule, Autopilot and reports.")}
    ${two ? `<div class="seg"><button class="${S.couple ? "" : "on"}" data-act="couple" data-v="0">Just me</button><button class="${S.couple ? "on" : ""}" data-act="couple" data-v="1">Two of us</button></div>` : ""}
    ${bedHero}
    <div class="stack">${person(0)}${S.couple ? person(1) : ""}</div>
    ${nav()}</div>`;
}

function vRoutine() {
  const sc = S.a.schedule;
  const shade = { bedtime: "#c9b6ff", winddown: "#b39cff", early: "#9479ff", late: "#7a5cf5", deep: "#5b3fd6", prewake: "#b48cff", wake: "#ff9fd0" };
  const bar = (bed, wake) => {
    const n = nightPhases(bed, wake), keys = PHASES.map((p) => p[0]);
    const cells = keys.slice(0, -1).map((k, i) => `<div style="flex:${n.rel[keys[i + 1]] - n.rel[k]};background:${shade[k]}" title="${PHASES[i][1]} ${hm12(n.at[k])}"></div>`).join("");
    return `<div class="night"><div class="bar">${cells}</div><div class="legend"><span>${hm12(bed)}</span><span>${Math.floor(n.span / 60)}h ${n.span % 60}m</span><span>${hm12(wake)}</span></div></div>`;
  };
  const block = (label, bedKey, wakeKey) => `<div class="label">${label}</div><div class="times">
      <label class="time"><span>Bedtime</span><input type="time" data-bind="schedule.${bedKey}" value="${sc[bedKey]}"></label>
      <label class="time"><span>Wake up</span><input type="time" data-bind="schedule.${wakeKey}" value="${sc[wakeKey]}"></label></div>${bar(sc[bedKey], sc[wakeKey])}`;
  return `<div class="screen fade">${head("", "When do you usually sleep?", "The bed eases through seven temperature phases and warms you for your alarm.")}
    ${block("Weeknights · Sun – Thu", "weekday_bed", "weekday_wake")}
    ${block("Weekends · Fri + Sat", "weekend_bed", "weekend_wake")}
    ${nav()}</div>`;
}

function vRoom() {
  const p = S.det.pickers, r = S.a.room;
  const nm = (e) => { const n = p.names?.[e]; return n && n !== e ? `${n} · ${e}` : e; };
  const sel = (key, list, none, label, help) => `<label class="field"><span>${label}</span><select data-bind="room.${key}"><option value="">${none}</option>${list.map((e) => `<option value="${esc(e)}" ${e === r[key] ? "selected" : ""}>${esc(nm(e))}</option>`).join("")}</select><small>${help}</small></label>`;
  return `<div class="screen fade">${head("", "Autopilot Sensors")}
    ${sel("weather", p.weather, "No weather entity", "Weather", "Cold night outside → a warmer bed.")}
    ${sel("temp", p.temperature, "No room sensor", "Bedroom temperature", "A sensor in the bedroom works best.")}
    ${sel("humidity", p.humidity, "No humidity sensor", "Bedroom humidity", "Dry air feels cooler; Autopilot compensates.")}
    <label class="field"><span>Wind-down scene</span><select data-bind="winddown_scene"><option value="">Just the bed</option>${p.scenes.map((e) => `<option value="${esc(e)}" ${e === S.a.winddown_scene ? "selected" : ""}>${esc(nm(e))}</option>`).join("")}</select><small>Runs with the card's Wind down button.</small></label>
    ${nav()}</div>`;
}

function vFeatures() {
  const f = S.a.features, anyPhone = (S.couple ? S.a.sleepers : [S.a.sleepers[0]]).some((s) => s.notify);
  const tog = (key, title, text, opts = {}) => `<div class="toggle"><div class="txt"><h3>${title}</h3><p>${text}</p>${opts.after || ""}</div>
    <label class="switch"><input type="checkbox" data-feat="${key}" ${(opts.value ?? f[key]) ? "checked" : ""} ${opts.disabled ? "disabled" : ""}><span></span></label></div>`;
  const ssh = S.a.pipeline.source === "ssh";
  const pipeAfter = f.pipeline && S.det.backends[S.a.backend]?.ssh_capable ? `<div class="seg small" style="margin:12px 0 0"><button class="${ssh ? "" : "on"}" data-act="psrc" data-v="ha">Home Assistant</button><button class="${ssh ? "on" : ""}" data-act="psrc" data-v="ssh">Pod over SSH</button></div>
    ${ssh ? `<div style="margin-top:14px"><div class="row"><label class="field"><span>Pod address</span><input type="text" data-bind="pipeline.host" placeholder="192.168.1.x" value="${esc(S.a.pipeline.host)}"></label>
      <label class="field" style="flex:.45"><span>Port</span><input type="text" data-bind="pipeline.port" value="${esc(S.a.pipeline.port)}"></label></div>
      <label class="field" style="margin-top:12px"><span>User</span><input type="text" data-bind="pipeline.user" value="${esc(S.a.pipeline.user)}"></label>
      <p class="small muted" style="margin:12px 0 6px">Add this key to the Pod's <span class="mono">~/.ssh/authorized_keys</span>:</p><pre id="pubkey">loading…</pre>
      <button class="btn ghost small" data-act="sshtest">Test connection</button> <span id="sshres" class="small"></span></div>` : ""}` : "";
  return `<div class="screen fade">${head("", "Pick what you want.", "Change any of it later from the card.")}
    <div class="glass">
      ${tog("smart", "Smart Autopilot", "Adjusts all night from the weather, your room and the season.")}
      ${tog("pipeline", "Sleep reports", "Score, stages, heart rate and HRV each morning — computed here.", { after: pipeAfter })}
      ${tog("notifications", "Bed notifications", anyPhone ? "Bed ready, good morning with your score, water low." : "Pick a phone on the previous step to turn these on.", { disabled: !anyPhone, value: anyPhone && f.notifications })}
      ${tog("standalone", "Pod app on your Wi-Fi", `A no-login app on port ${S.status?.app?.port || 8098}. Anyone on your network can control the bed with it.`, { value: S.standalone })}
    </div>${nav()}</div>`;
}

function vReview() {
  const p = S.preview;
  if (!p) return `<div class="screen fade">${head("", "Working out the plan…")}<div class="glass"><ul class="checks"><li><span class="st run"></span><div class="muted">Building every file Eight+ will write</div></li></ul></div></div>`;
  const sm = p.plan_summary, a = answers();
  const people = sm.sleepers.map((s) => `<tr><td>${esc(s.name)} · ${esc(s.side)}</td><td><span class="mono">${esc(s.prefix)}_*</span><br><span class="small muted">${s.helpers} helpers · ${s.automations} automations${s.notify ? ` · ${esc(s.notify.replace("notify.mobile_app_", ""))}` : ""}</span></td></tr>`).join("");
  const night = nightPhases(a.schedule.weekday_bed, a.schedule.weekday_wake).at;
  const files = Object.entries(p.files).map(([k, v]) => `<details><summary class="mono">${esc(k)}</summary><pre>${esc(v)}</pre></details>`).join("");
  return `<div class="screen fade">${head("", "Here's what Eight+ will set up.", "Nothing changes until you install. Your config is backed up, and we roll back if Home Assistant objects.")}
    <div class="grid three">
      <div class="glass stat"><div class="k">Helpers</div><div class="v">${sm.helpers}</div></div>
      <div class="glass stat"><div class="k">Automations</div><div class="v">${sm.automations}</div></div>
      <div class="glass stat"><div class="k">Sensors</div><div class="v">${sm.template_sensors}</div></div>
    </div>
    <div class="glass"><table class="ents">${people}</table></div>
    <div class="note gap">Weeknights: on at <b>${hm12(night.bedtime)}</b>, coolest around <b>${hm12(night.deep)}</b>, warming from <b>${hm12(night.prewake)}</b>, wake <b>${hm12(night.wake)}</b>${a.features.smart ? ", Autopilot adjusting as it goes" : ""}.</div>
    ${p.restart_needed ? '<div class="note warn gap">Home Assistant will <b>restart once</b> (about a minute) to load the new package.</div>' : ""}
    ${p.packages.mode === "missing" ? '<div class="note gap">Adds <span class="mono">packages: !include_dir_named packages</span> under <span class="mono">homeassistant:</span>.</div>' : ""}
    ${p.warnings.map((w) => `<div class="note warn gap">${esc(w)}</div>`).join("")}
    ${p.collisions.length ? `<div class="note bad gap"><div><b>${p.collisions.length} entities already exist</b> and weren't made by Eight+: ${p.collisions.slice(0, 6).map((c) => `<span class="mono">${esc(c)}</span>`).join(", ")}${p.collisions.length > 6 ? "…" : ""}. Go back and use different names.</div></div>` : ""}
    <details><summary>Every file Eight+ will write</summary>${files}</details>
    ${nav(p.reinstall ? "Update install" : "Install", "install")}</div>`;
}

// ───────────────────────────────────────────── install / done / home
function vInstall() {
  const pr = S.progress || { steps: [] };
  const list = pr.steps.map((s) => `<li><span class="st ${s.status}">${s.status === "ok" ? "✓" : s.status === "warn" ? "!" : s.status === "fail" ? "✕" : ""}</span><div><div>${esc(s.label)}</div>${s.detail ? `<div class="d">${esc(s.detail)}</div>` : ""}</div></li>`).join("");
  const fail = pr.error;
  return `<div class="screen fade">${head(fail ? "Something went wrong" : pr.done ? "Done" : "Installing", fail ? "Install stopped." : pr.done ? "All set." : "Setting up your Pod…",
      fail ? "Nothing half-finished was left behind." : "Leave this open. If Home Assistant restarts, we pick up where we left off.")}
    <div class="glass"><ul class="checks">${list || '<li><span class="st run"></span><div>Starting…</div></li>'}</ul></div>
    ${fail ? `<div class="note bad gap" style="white-space:pre-wrap">${esc(fail)}</div><div class="nav"><button class="btn primary" data-act="toreview">Back to review</button></div>` : ""}</div>`;
}

function vDone() {
  const st = S.status, ins = st.install || {};
  const dash = ins.dashboard || "eight-plus";
  const names = (ins.sleepers || []).map((s) => esc(s.name));
  return `<div class="screen fade"><div class="hero">${LOGO("xl")}<h1>You're all set.</h1>
    <p class="lede">${names.join(" and ")}${names.length > 1 ? " each have" : " has"} a schedule and Autopilot. The bed turns on at bedtime by itself.</p>
    <div class="glass"><ul class="checks">
      <li><span class="st ok">✓</span><div><div>Dashboard</div><div class="d">/${esc(dash)} — pin it in the Home Assistant app.</div></div></li>
      <li><span class="st ${ins.answers?.features?.pipeline === false ? "todo" : "ok"}">${ins.answers?.features?.pipeline === false ? "" : "✓"}</span><div><div>Sleep reports</div><div class="d">${ins.answers?.features?.pipeline === false ? "Off." : "Reading back through your recent nights now."}</div></div></li>
      ${st.app.enabled ? `<li><span class="st ok">✓</span><div><div>Pod app</div><div class="d"><span class="url">${esc(appUrl())}</span> — Share → Add to Home Screen.</div></div></li>` : ""}
    </ul></div></div>
    <div class="nav"><div class="alt"><button class="btn link" data-act="home">Go to the Eight+ panel</button></div>
      <button class="btn primary" data-act="opendash" data-path="${esc(dash)}">Open dashboard</button></div></div>`;
}

function vHome() {
  const st = S.status, ins = st.install || {}, sl = st.sleep || {}, dr = st.drift || {};
  const upd = (dr.update || []).length, edited = (dr.edited || []).length;
  return `<div class="screen fade">${head(`Installed · v${esc(ins.version)}`, "Eight+ is running.",
      `${esc(({ gateway: "Eight+ Pod gateway", freesleep: "free-sleep", cloud: "Eight Sleep cloud" })[st.backend] || "")} · ${(ins.sleepers || []).map((s) => `${esc(s.name)} (${s.side})`).join(" · ")}`)}
    ${upd ? `<div class="note warn flex" style="margin-bottom:12px"><div style="flex:1"><b>This version updates ${upd} Eight+ file${upd > 1 ? "s" : ""}.</b> Your values and history are kept.${edited ? ` ${edited} hand-edited file(s) will be overwritten — copy your changes out first.` : ""}</div><button class="btn ghost small" data-act="update">Apply</button></div>` : ""}
    <div class="grid three">
      <div class="glass stat"><div class="k">Home Assistant</div><div class="v s">${st.ha_connected ? "Connected" : "Offline"}</div></div>
      <div class="glass stat"><div class="k">Sleep reports</div><div class="v s">${sl.enabled ? (sl.last_error ? "Error" : "Running") : "Off"}</div><div class="small muted">${sl.enabled ? esc(sl.source || "") + (sl.mqtt ? " → MQTT" : " → REST") : ""}</div></div>
      <div class="glass stat"><div class="k">Card</div><div class="v s">${esc((ins.card || {}).mode === "hacs" ? "HACS" : "Bundled")}</div></div>
    </div>
    ${sl.last_error ? `<div class="note bad gap">${esc(sl.last_error)}</div>` : ""}
    <div class="glass" style="margin-top:12px"><div class="toggle" style="padding:0"><div class="txt"><h3>Pod app on your Wi-Fi</h3><p>${st.app.enabled ? `Running at <span class="url">${esc(appUrl())}</span>` : "A no-login app for phones at home. Anyone on your network can control the bed."}</p></div>
      <label class="switch"><input type="checkbox" data-act="standalone" ${st.app.enabled ? "checked" : ""}><span></span></label></div></div>
    <div id="filesbox"></div>
    <div class="nav"><div class="alt"><button class="btn link" data-act="files">View YAML</button><button class="btn link" data-act="rerun">Change setup</button><button class="btn link danger" data-act="uninstall">Uninstall</button></div>
      <button class="btn primary" data-act="opendash" data-path="${esc(ins.dashboard || "eight-plus")}">Open dashboard</button></div></div>`;
}

// ───────────────────────────────────────────── render + events
function render() {
  const root = $("#root");
  if (S.err && !S.det) { root.innerHTML = `<div class="top">${LOGO("sm")}</div><div class="screen">${head("Can't load", "Eight+ can't reach Home Assistant.", esc(S.err))}<div class="nav"><button class="btn primary" data-act="reload">Try again</button></div></div>`; return; }
  if (!S.det || !S.status) return;
  let body;
  if (S.view === "install") body = vInstall();
  else if (S.view === "done") body = vDone();
  else if (S.view === "home") body = vHome();
  else body = ({ welcome: vWelcome, backend: vBackend, people: vPeople, routine: vRoutine, room: vRoom, features: vFeatures, review: vReview })[S.step]();
  root.innerHTML = top() + (S.err ? `<div class="note bad" style="margin-bottom:14px">${esc(S.err)}</div>` : "") + body;
  // the entrance animation plays once per screen, not on every re-render (picking an option, toggling)
  const key = S.view + "/" + S.step + "/" + !!S.preview;
  if (key === S._shown) root.querySelectorAll(".fade").forEach((n) => n.classList.remove("fade"));
  S._shown = key;
  paintBed();
  if (S.step === "features" && S.a.pipeline.source === "ssh" && $("#pubkey")) api("api/ssh/pubkey").then((j) => { $("#pubkey").textContent = j.pubkey; }).catch((e) => { $("#pubkey").textContent = e.message; });
}

function setPath(obj, path, v) { const k = path.split("."); let o = obj; while (k.length > 1) o = o[k.shift()]; o[k[0]] = v; }

document.addEventListener("input", (e) => {
  const b = e.target.dataset.bind;
  if (!b) return;
  setPath(S.a, b, e.target.value);
  // names update their echoes in place — a full re-render mid-typing would eat the next click
  const m = b.match(/^sleepers\.(\d)\.name$/);
  if (m) {
    const v = e.target.value, i = +m[1];
    document.querySelectorAll(`[data-live="name-${i}"]`).forEach((n) => (n.textContent = v || (i ? "Partner" : "You")));
    document.querySelectorAll(`[data-live="prefix-${i}"]`).forEach((n) => (n.textContent = `eight_sleep_${slugify(v) || "…"}_*`));
  }
  if (S.tried === S.step) renderNav();   // outside the focused input, so typing isn't disturbed
});
document.addEventListener("change", (e) => {
  const t = e.target;
  // (text inputs don't re-render on change: change fires on blur, i.e. on the mousedown of
  //  whatever was clicked next, and replacing the DOM then would swallow that click)
  if (t.dataset.bind) { setPath(S.a, t.dataset.bind, t.value); if (t.type !== "text") render(); }
  if (t.dataset.ov) { const [side, k] = t.dataset.ov.split("."); const o = (S.overrides[S.a.backend] ||= {}); (o[side] ||= {})[k] = t.value; render(); }
  if (t.dataset.feat) { if (t.dataset.feat === "standalone") S.standalone = t.checked; else S.a.features[t.dataset.feat] = t.checked; render(); }
  if (t.dataset.act === "standalone") api("api/standalone", { enabled: t.checked }).then(refresh).catch((er) => { S.err = er.message; render(); });
});
document.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches?.('.opt[role="button"]')) { e.preventDefault(); e.target.click(); }
});

document.addEventListener("click", async (e) => {
  if (e.target.closest("a")) return;   // setup-guide links inside option rows open, they don't select
  const el = e.target.closest("[data-act]");
  if (!el || el.tagName === "INPUT") return;
  const act = el.dataset.act, i = STEPS.indexOf(S.step);
  try {
    if (act === "next" || act === "install") {
      if (problems(S.step).length) { S.tried = S.step; render(); return; }
    }
    if (act === "next") {
      if (S.step === "features") { goto("review"); S.preview = null; S.preview = await api("api/preview", { answers: answers() }); render(); return; }
      goto(STEPS[i + 1]);
    }
    if (act === "back") goto(STEPS[Math.max(0, i - 1)]);
    if (act === "backend") { S.a.backend = el.dataset.id; const sides = sidesAvailable(); S.a.sleepers[0].side = sides[0] || "left"; S.a.sleepers[1].side = sides[1] || sides[0] || "right"; render(); }
    if (act === "rescan") { S.det = await api("api/detect?fresh=1"); render(); }
    if (act === "couple") { S.couple = el.dataset.v === "1"; if (S.couple && S.a.sleepers[0].side === S.a.sleepers[1].side) S.a.sleepers[1].side = sidesAvailable().find((x) => x !== S.a.sleepers[0].side); render(); }
    if (act === "side") {
      const side = el.dataset.side, s = S.a.sleepers;
      if (!S.couple) s[0].side = side;
      else if (s[0].side === side || s[1].side === side) { const t = s[0].side; s[0].side = s[1].side; s[1].side = t; }
      else s[0].side = side;
      render();
    }
    if (act === "psrc") { S.a.pipeline.source = el.dataset.v; render(); }
    if (act === "sshtest") { const r = await api("api/ssh/test", S.a.pipeline); $("#sshres").innerHTML = r.ok ? '<span style="color:var(--ok)">Connected ✓</span>' : `<span style="color:var(--bad)">${esc(r.output.split("\n").slice(-2).join(" "))}</span>`; }
    if (act === "install") { S.busy = true; await api("api/install", { answers: answers(), standalone: S.standalone }); S.busy = false; S.view = "install"; S.progress = null; render(); poll(); }
    if (act === "toreview") { S.view = "wizard"; goto("review"); }
    if (act === "opendash") openInHA(el.dataset.path);
    if (act === "home") { S.view = "home"; await refresh(); }
    if (act === "rerun") { prefill(); S.view = "wizard"; goto("backend"); }
    if (act === "update") { await api("api/update", {}); S.view = "install"; S.progress = null; render(); poll(); }
    if (act === "files") { const j = await api("api/files"); $("#filesbox").innerHTML = `<div class="glass" style="margin-top:12px">${Object.entries(j.files).map(([k, v]) => `<details><summary class="mono">${esc(k)}</summary><pre>${esc(v)}</pre></details>`).join("")}<details><summary>Card config</summary><pre>${esc(JSON.stringify(j.cards, null, 2))}</pre></details></div>`; }
    if (act === "uninstall") {
      if (!confirm("Remove Eight+? This deletes the Eight+ helpers, automations, sensors and dashboard. Your backups and sleep history are kept.")) return;
      await api("api/uninstall", {}); S.view = "install"; S.progress = null; render(); poll(true);
    }
    if (act === "reload") location.reload();
  } catch (er) { S.busy = false; S.err = er.message; render(); }
});

async function poll(uninstall) {
  for (;;) {
    try { S.progress = await api("api/progress"); } catch (_) { /* HA restarting — keep polling */ }
    render();
    if (S.progress && !S.progress.running && (S.progress.done || S.progress.error)) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (S.progress.done) { await refresh(false); S.view = uninstall ? "wizard" : "done"; if (uninstall) { S.step = "welcome"; S.det = await api("api/detect?fresh=1"); } render(); }
}

// "Change setup": start the wizard from what's installed, so a tweak is a two-click job
function prefill() {
  const a = S.status?.install?.answers;
  if (!a) return;
  const keep = structuredClone(S.a);
  S.a = { ...keep, ...structuredClone(a), room: { ...keep.room, ...(a.room || {}) }, features: { ...keep.features, ...(a.features || {}) },
    schedule: { ...keep.schedule, ...(a.schedule || {}) }, pipeline: { ...keep.pipeline, ...(a.pipeline || {}) } };
  delete S.a.features.coach;
  S.couple = (a.sleepers || []).length > 1;
  S.a.sleepers = [...(a.sleepers || []), ...keep.sleepers].slice(0, 2);
  if (!S.couple) S.a.sleepers[1] = { name: "", side: S.a.sleepers[0].side === "left" ? "right" : "left", notify: "" };
  S.standalone = !!S.status.app?.enabled;
}

async function refresh(draw = true) {
  S.status = await api("api/status");
  if (draw) render();
}

window.__eightplus = { S, render, goto, answers };   // debug handle

(async function boot() {
  try {
    S.status = await api("api/status");
    S.det = await api("api/detect");
    S.status = await api("api/status");   // detect waited for the HA connection — status is live now
    const found = Object.entries(S.det.backends).filter(([, v]) => v && v.online !== false);
    if (found.length === 1) S.a.backend = found[0][0];
    const pk = S.det.pickers;
    S.a.room.weather = pk.weather[0] || "";
    S.a.room.temp = pk.temperature.find((e) => /bed/.test(e)) || "";
    S.a.room.humidity = pk.humidity.find((e) => /bed/.test(e)) || "";
    if (pk.notify.length === 1) S.a.sleepers[0].notify = pk.notify[0];
    if (S.status.installed) S.view = "home";
    if (S.status.progress?.running) { S.view = "install"; poll(); }
    render();
    setInterval(() => { if (S.view === "home") refresh(); else api("api/status").then((st) => { const was = S.status?.ha_connected; S.status = st; if (was !== st.ha_connected) render(); }).catch(() => {}); }, 15000);
  } catch (e) { S.err = e.message; render(); setTimeout(boot, 4000); }
})();

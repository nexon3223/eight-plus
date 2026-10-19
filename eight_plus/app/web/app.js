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
  auto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M14 14.8V4a2 2 0 1 0-4 0v10.8a4 4 0 1 0 4 0Z"/><path d="M12 9v6"/><path d="M18 5h3M18 9h2"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3Z"/><path d="m9 12 2 2 4-4"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg>',
};

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
    features: { autopilot: true, smart: true, coach: false, notifications: true, pipeline: true },
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
    else if (!S.det.backends[a.backend]) out.push("That connection isn't set up in Home Assistant yet — follow its setup link, then Rescan.");
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

// ───────────────────────────────────────────── views
function top() {
  const st = S.status;
  const ha = st?.ha_connected ? '<span class="pill ok"><span class="dot"></span>Home Assistant</span>' : '<span class="pill bad"><span class="dot"></span>Home Assistant offline</span>';
  return `<div class="top"><div class="mark">8<span>+</span></div><div><div class="title">Eight+</div><div class="sub">Pod control for Home Assistant · v${esc(st?.version)}</div></div><div class="spacer"></div>${ha}</div>`;
}
function stepper() {
  const i = STEPS.indexOf(S.step);
  return `<div class="steps">${STEPS.map((_, k) => `<i class="${k <= i ? "on" : ""}"></i>`).join("")}</div>`;
}
function nav(...args) { S._nav = args; return `<div id="navbox">${navInner(...args)}</div>`; }
function renderNav() { const b = $("#navbox"); if (b && S._nav) b.innerHTML = navInner(...S._nav); }
function navInner(backLabel = "Back", nextLabel = "Continue", nextAct = "next", extra = "") {
  // problems only show once someone has tried to move on — no scolding an untouched form
  const issues = S.tried === S.step ? problems(S.step) : [];
  return `${issues.length ? `<div class="note warn" style="margin-top:18px">${issues.map(esc).join("<br>")}</div>` : ""}
    <div class="nav">${S.step !== "welcome" ? `<button class="btn ghost" data-act="back">${backLabel}</button>` : ""}<div class="spacer"></div>${extra}
    <button class="btn primary" data-act="${nextAct}" ${issues.length || S.busy ? "disabled" : ""}>${nextLabel}</button></div>`;
}

function vWelcome() {
  const d = S.det, i = d.integrations, pk = d.packages;
  const found = Object.values(d.backends).filter((b) => b && b.online !== false);
  const stale = Object.values(d.backends).filter((b) => b && b.online === false);
  const list = (xs) => xs.map((f) => `<b>${esc(f.label)}</b>`).join(xs.length > 2 ? ", " : " and ").replace(/, (?=[^,]*$)/, " and ");
  const chk = (ok, label, detail, level = "warn") => `<li><span class="st ${ok ? "ok" : level}">${ok ? "✓" : "!"}</span><div><div>${label}</div><div class="d">${detail}</div></div></li>`;
  return `${stepper()}<div class="fade">
  <div class="eyebrow">Welcome</div>
  <h1>Your Pod, run by your home.</h1>
  <p class="lede">Eight+ sets up everything the Eight+ card needs — schedules, a weather-aware Autopilot, sleep reports and a bedtime coach — as ordinary Home Assistant helpers and automations you can see and tweak. Takes about three minutes.</p>
  <div class="grid four">
    <div class="card feature"><div class="ico">${ICON.auto}</div><h3>Smart Autopilot</h3><p>Warms or cools the bed through the night from the weather, your room and the season.</p></div>
    <div class="card feature"><div class="ico">${ICON.moon}</div><h3>Sleep reports</h3><p>A score, stages, heart rate and HRV every morning — computed right here, no subscription.</p></div>
    <div class="card feature"><div class="ico">${ICON.shield}</div><h3>Sleep Coach</h3><p>Nudges at bedtime and a wake-up that won't let you snooze through it. Optional.</p></div>
    <div class="card feature"><div class="ico">${ICON.phone}</div><h3>Pod app</h3><p>A full-screen app for every phone in the house. Optional.</p></div>
  </div>
  <div class="card" style="margin-top:14px"><h2>Before we start</h2><ul class="checks" style="margin-top:8px">
    ${chk(found.length > 0, found.length ? `Found your Pod via ${list(found)}` : "No working Pod connection in Home Assistant yet", (found.length ? "We'll confirm the details next." : "That's fine — the next step shows how to connect one.") + (stale.length ? ` (${stale.map((f) => esc(f.label)).join(", ")} ${stale.length > 1 ? "are" : "is"} registered but offline.)` : ""))}
    ${chk(pk.mode.startsWith("dir_") || pk.mode === "missing", pk.mode.startsWith("dir_") ? `Packages are on (<span class="mono">${esc(pk.dir)}/</span>)` : pk.mode === "missing" ? "Packages will be switched on" : "Packages need a manual step", pk.mode === "missing" ? "Adds one line to configuration.yaml (backed up first)." : esc(pk.why || "Eight+ keeps all its YAML in one folder."), "bad")}
    ${chk(d.mqtt_broker || d.integrations.mqtt, d.mqtt_broker ? "MQTT broker available" : d.integrations.mqtt ? "MQTT is set up" : "No MQTT broker", d.mqtt_broker ? "Sleep reports publish as proper devices." : d.integrations.mqtt ? "Using an external broker? Add its login in the add-on's Configuration tab so sleep reports publish as devices." : "Sleep reports still work — they're written straight into Home Assistant instead.")}
    ${chk(d.card.found, d.card.found ? `Card installed (${esc(d.card.mode)})` : "Card not installed yet", d.card.found ? esc(d.card.url) : "We'll install the bundled copy. For automatic updates, add it through HACS later.")}
  </ul></div>
  ${nav("", "Get started")}</div>`;
}

const BACKENDS = [
  { id: "gateway", name: "Eight+ Pod gateway", tag: "Local · real-time", desc: "Your Pod runs stock firmware with the Eight+ gateway (franken proxy + biometrics tap) publishing over MQTT.",
    pros: ["Instant control, no cloud", "Vitals, presence, water temps, Pod health", "Bed vibration for wake-ups"], setup: "Needs a rooted Pod 3 — see the gateway guide in the repo." , link: REPO + "/blob/main/docs/pod-gateway.md" },
  { id: "freesleep", name: "free-sleep", tag: "Local · community firmware", desc: "The open free-sleep firmware on the Pod, with the hass-free-sleep integration.",
    pros: ["No cloud, no subscription", "Presence + vitals", "Well-trodden community project"], setup: "Flash free-sleep, then install hass-free-sleep from HACS.", link: "https://github.com/throwaway31265/free-sleep" },
  { id: "cloud", name: "Eight Sleep cloud", tag: "Cloud · easiest", desc: "Your Pod as it came, through Eight Sleep's servers and the eight_sleep custom integration.",
    pros: ["Nothing to flash", "Works with the official app", "Needs your Eight Sleep login"], setup: "Install the eight_sleep custom integration from HACS, sign in, then Rescan.", link: "https://github.com/lukas-clarke/eight_sleep" },
];
const FIELD_LABEL = { climate: "Temperature control", presence: "Bed presence", heart_rate: "Heart rate", hrv: "HRV", breath_rate: "Breathing rate", bed_temp: "Bed temperature", water_temp: "Water temperature" };

function vBackend() {
  const d = S.det;
  const cards = BACKENDS.map((b) => {
    const f = d.backends[b.id], sel = S.a.backend === b.id;
    const badge = !f ? '<span class="pill">Not set up</span>' : f.online === false ? '<span class="pill warn"><span class="dot"></span>Offline</span>'
      : `<span class="pill ok"><span class="dot"></span>Found · ${Object.keys(f.sides).length} side${Object.keys(f.sides).length > 1 ? "s" : ""}</span>`;
    return `<button class="choice ${sel ? "sel" : ""} ${f ? "" : "dim"}" data-act="backend" data-id="${b.id}">
      <div class="head"><span class="radio"></span><h2>${b.name}</h2></div>
      <div class="tags">${badge}<span class="pill accent">${b.tag}</span></div><p>${b.desc}</p>
      <ul>${b.pros.map((p) => `<li>•<span>${p}</span></li>`).join("")}</ul>
      ${f ? "" : `<p class="small" style="margin-top:10px">${b.setup} <a href="${b.link}" target="_blank" rel="noopener">Setup guide ↗</a></p>`}</button>`;
  }).join("");
  let detail = "";
  const f = d.backends[S.a.backend];
  if (f) {
    const ov = S.overrides[S.a.backend] || {};
    const sides = Object.entries(f.sides).map(([side, ents]) => {
      const rows = Object.entries(FIELD_LABEL).map(([k, label]) => {
        const v = (ov[side] || {})[k] || ents[k];
        if (!v && !["presence", "climate"].includes(k)) return "";
        if (v && !(ov[side] || {})[k]) return `<tr><td>${label}</td><td class="mono">${esc(v)}</td></tr>`;
        const dom = k === "presence" ? "binary_sensor." : k === "climate" ? "climate." : "sensor.";
        const opts = d.all_entities.filter((e) => e.startsWith(dom));
        return `<tr><td>${label}</td><td>${v ? "" : '<div class="miss small" style="margin-bottom:6px">Not found — pick one</div>'}
          <select data-ov="${side}.${k}"><option value="">—</option>${opts.map((e) => `<option ${e === v ? "selected" : ""}>${esc(e)}</option>`).join("")}</select></td></tr>`;
      }).join("");
      return `<div><h3 style="text-transform:capitalize">${side} side</h3><table class="ents">${rows}</table></div>`;
    }).join("");
    detail = `<div class="card fade" style="margin-top:14px"><h2>What we found</h2>
      ${f.notes.map((n) => `<div class="note" style="margin-top:10px">${esc(n)}</div>`).join("")}
      <div class="grid two" style="margin-top:6px">${sides}</div></div>`;
  }
  return `${stepper()}<div class="fade"><div class="eyebrow">Step 1 · Connect</div><h1>How does Home Assistant reach your Pod?</h1>
    <p class="lede">We looked through your integrations. Pick the one you use — you can switch later by running setup again.</p>
    <div class="grid three">${cards}</div>${detail}
    ${nav("Back", "Continue", "next", '<button class="btn ghost" data-act="rescan">Rescan</button>')}</div>`;
}

function vPeople() {
  const avail = sidesAvailable();
  const two = avail.length > 1;
  if (!two) S.couple = false;
  const s = S.a.sleepers;
  const who = (side) => { const i = s.findIndex((x, k) => x.side === side && (k === 0 || S.couple)); return i < 0 ? null : i; };
  const half = (side) => {
    if (!avail.includes(side)) return `<div class="half" style="opacity:.35;cursor:default">No ${side} side</div>`;
    const i = who(side);
    return `<div class="half ${i != null ? `taken ${i ? "b" : "a"}` : ""}" data-act="side" data-side="${side}"><div class="pillow"></div>
      ${i != null ? `<div class="who" data-live="name-${i}">${esc(s[i].name || (i ? "Partner" : "You"))}</div><div class="small muted">${side}</div>` : `Tap to sleep here<br><span class="small">${side}</span>`}</div>`;
  };
  const notifyOpts = (cur) => `<option value="">No phone notifications</option>${S.det.pickers.notify.map((n) => `<option ${n === cur ? "selected" : ""} value="${n}">${esc(n.replace("notify.mobile_app_", "").replace(/_/g, " "))}</option>`).join("")}`;
  const person = (i) => `<div class="card"><div class="row" style="align-items:flex-start">
      <label class="field"><span>${i ? "Their name" : S.couple ? "Your name" : "Your name"}</span><input type="text" maxlength="24" placeholder="${i ? "e.g. Sam" : "e.g. Alex"}" data-bind="sleepers.${i}.name" value="${esc(s[i].name)}"><small>Helpers are named <span class="mono" data-live="prefix-${i}">eight_sleep_${esc(slugify(s[i].name) || "…")}_*</span></small></label>
      <label class="field"><span>Phone for bed notifications</span><select data-bind="sleepers.${i}.notify">${notifyOpts(s[i].notify)}</select><small>${S.det.pickers.notify.length ? "From the Home Assistant Companion app." : "Install the Companion app on a phone to get these."}</small></label>
    </div></div>`;
  return `${stepper()}<div class="fade"><div class="eyebrow">Step 2 · People</div><h1>Who sleeps in this bed?</h1>
    <p class="lede">Each person gets their own schedule, Autopilot and sleep reports.${two ? " Solo means one schedule warms or cools the whole bed; with two of you, each side follows its own sleeper." : ""}</p>
    ${two ? `<div class="seg" style="margin-bottom:18px"><button class="${S.couple ? "" : "on"}" data-act="couple" data-v="0">Just me</button><button class="${S.couple ? "on" : ""}" data-act="couple" data-v="1">Two of us</button></div>` : ""}
    <div class="grid two" style="align-items:center"><div class="bed">${half("left")}${half("right")}</div>
      <div class="stack">${person(0)}${S.couple ? person(1) : ""}</div></div>
    ${nav()}</div>`;
}

function vRoutine() {
  const sc = S.a.schedule;
  const bar = (bed, wake) => {
    const n = nightPhases(bed, wake);
    const colors = { bedtime: "#ff9c66", winddown: "#ffb88a", early: "#b9a6ff", late: "#8fb4ff", deep: "#5d8dff", prewake: "#ffc58f", wake: "#ff8a4c" };
    const keys = PHASES.map((p) => p[0]);
    const cells = keys.slice(0, -1).map((k, i) => { const w = n.rel[keys[i + 1]] - n.rel[k]; return `<div style="flex:${w};background:${colors[k]}" title="${k} ${hm12(n.at[k])}">${w > n.span * .1 ? PHASES[i][1] : ""}</div>`; }).join("");
    return `<div class="night"><div class="bar">${cells}</div><div class="legend"><span>${hm12(bed)} bed on</span><span>${Math.floor(n.span / 60)}h ${n.span % 60}m</span><span>${hm12(wake)} wake</span></div></div>`;
  };
  return `${stepper()}<div class="fade"><div class="eyebrow">Step 3 · Routine</div><h1>When do you usually sleep?</h1>
    <p class="lede">The bed turns on at bedtime, eases through seven temperature phases overnight and warms you up for your alarm. You can fine-tune every phase in the card afterwards.</p>
    <div class="grid two">
      <div class="card"><h2>Weeknights</h2><p class="muted small">Sunday – Thursday nights</p>
        <div class="row" style="margin-top:12px"><label class="field"><span>Bedtime</span><input type="time" data-bind="schedule.weekday_bed" value="${sc.weekday_bed}"></label>
        <label class="field"><span>Wake up</span><input type="time" data-bind="schedule.weekday_wake" value="${sc.weekday_wake}"></label></div>${bar(sc.weekday_bed, sc.weekday_wake)}</div>
      <div class="card"><h2>Weekends</h2><p class="muted small">Friday + Saturday nights</p>
        <div class="row" style="margin-top:12px"><label class="field"><span>Bedtime</span><input type="time" data-bind="schedule.weekend_bed" value="${sc.weekend_bed}"></label>
        <label class="field"><span>Wake up</span><input type="time" data-bind="schedule.weekend_wake" value="${sc.weekend_wake}"></label></div>${bar(sc.weekend_bed, sc.weekend_wake)}</div>
    </div>
    <div class="note" style="margin-top:14px">Starting temperatures run from ${PHASES.map((p) => `${p[1].toLowerCase()} ${p[2]}°`).join(" → ")}. Autopilot moves them with the weather once it's on.</div>
    ${nav()}</div>`;
}

function vRoom() {
  const p = S.det.pickers, r = S.a.room;
  const nm = (e) => { const n = p.names?.[e]; return n && n !== e ? `${n} · ${e}` : e; };
  const sel = (key, list, none, label, help) => `<label class="field"><span>${label}</span><select data-bind="room.${key}"><option value="">${none}</option>${list.map((e) => `<option value="${esc(e)}" ${e === r[key] ? "selected" : ""}>${esc(nm(e))}</option>`).join("")}</select><small>${help}</small></label>`;
  return `${stepper()}<div class="fade"><div class="eyebrow">Step 4 · Your room</div><h1>What does Autopilot have to work with?</h1>
    <p class="lede">Autopilot reads the weather and your bedroom to pick the right temperature. Everything here is optional — it just gets smarter with more.</p>
    <div class="card"><div class="grid two">
      ${sel("weather", p.weather, "No weather entity", "Weather", "Cold night outside → a warmer bed at bedtime.")}
      ${sel("temp", p.temperature, "No room sensor", "Bedroom temperature", "A sensor in the bedroom itself works best.")}
      ${sel("humidity", p.humidity, "No humidity sensor", "Bedroom humidity", "Dry air feels cooler; Autopilot compensates.")}
      <label class="field"><span>Wind-down scene</span><select data-bind="winddown_scene"><option value="">Just the bed</option>${p.scenes.map((e) => `<option value="${esc(e)}" ${e === S.a.winddown_scene ? "selected" : ""}>${esc(nm(e))}</option>`).join("")}</select><small>Runs with the card's Wind down button — dim lights, close blinds…</small></label>
    </div></div>${nav()}</div>`;
}

function vFeatures() {
  const f = S.a.features, anyPhone = (S.couple ? S.a.sleepers : [S.a.sleepers[0]]).some((s) => s.notify);
  const tog = (key, title, text, opts = {}) => `<div class="toggle"><div class="txt"><h3>${title}</h3><p>${text}</p>${opts.after || ""}</div>
    <label class="switch"><input type="checkbox" data-feat="${key}" ${(opts.value ?? f[key]) ? "checked" : ""} ${opts.disabled ? "disabled" : ""}><span></span></label></div>`;
  const ssh = S.a.pipeline.source === "ssh";
  const pipeAfter = f.pipeline && S.det.backends[S.a.backend]?.ssh_capable ? `<div class="seg small" style="margin-top:10px"><button class="${ssh ? "" : "on"}" data-act="psrc" data-v="ha">From Home Assistant</button><button class="${ssh ? "on" : ""}" data-act="psrc" data-v="ssh">Straight from the Pod (SSH)</button></div>
    ${ssh ? `<div class="card" style="margin-top:10px;box-shadow:none"><div class="row"><label class="field"><span>Pod address</span><input type="text" data-bind="pipeline.host" placeholder="e.g. 192.168.1.x" value="${esc(S.a.pipeline.host)}"></label>
      <label class="field" style="max-width:110px"><span>Port</span><input type="text" data-bind="pipeline.port" value="${esc(S.a.pipeline.port)}"></label><label class="field" style="max-width:140px"><span>User</span><input type="text" data-bind="pipeline.user" value="${esc(S.a.pipeline.user)}"></label></div>
      <p class="small muted">Add this key to the Pod's <span class="mono">~/.ssh/authorized_keys</span>:</p><pre id="pubkey">loading…</pre>
      <button class="btn ghost small" data-act="sshtest">Test connection</button> <span id="sshres" class="small"></span></div>` : ""}` : "";
  return `${stepper()}<div class="fade"><div class="eyebrow">Step 5 · Features</div><h1>Pick what you want.</h1>
    <p class="lede">Everything can be switched on or off later from the card or by running setup again.</p>
    <div class="card">
      ${tog("smart", "Smart Autopilot", "Adjusts the temperature all night from the weather, your room and the season. Off = the bed follows your fixed schedule.")}
      ${tog("pipeline", "Sleep reports", "Score, stages, heart rate, HRV and breathing each morning, computed on your Home Assistant box. Uses what your Pod already reports — backfills from your recorder history, so you'll likely see last night straight away.", { after: pipeAfter })}
      ${tog("coach", "Sleep Coach", "Picks a bedtime from your sleep debt, nudges you when it's time, and runs a wake-up that escalates (heat, alerts" + (S.a.backend === "gateway" ? ", bed vibration" : "") + ") until you're actually up." + (anyPhone ? "" : " <b>Works best with a phone picked on the People step.</b>"))}
      ${tog("notifications", "Bed notifications", anyPhone ? "Bed ready, goodnight, good morning with your score, water low, and one-tap Warmer/Cooler buttons." : "Pick a phone on the People step to turn these on.", { disabled: !anyPhone, value: anyPhone && f.notifications })}
      ${tog("standalone", "Pod app on your Wi-Fi", `A full-screen, no-login app for any phone at home (Add to Home Screen) on port ${S.status?.app?.port || 8098}. <b>Anyone on your network can control the bed with it</b> — but only the bed.`, { value: S.standalone })}
    </div>${nav()}</div>`;
}

function vReview() {
  const p = S.preview;
  if (!p) return `${stepper()}<div class="card"><p class="muted">Working out the plan…</p></div>`;
  const sm = p.plan_summary, a = answers();
  const people = sm.sleepers.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.side)} side · <span class="mono">${esc(s.prefix)}_*</span> · ${s.helpers} helpers · ${s.automations} automations${s.notify ? ` · 🔔 ${esc(s.notify.replace("notify.mobile_app_", ""))}` : ""}</td></tr>`).join("");
  const night = nightPhases(a.schedule.weekday_bed, a.schedule.weekday_wake).at;
  const files = Object.entries(p.files).map(([k, v]) => `<details><summary class="mono">${esc(k)}</summary><pre>${esc(v)}</pre></details>`).join("");
  return `${stepper()}<div class="fade"><div class="eyebrow">Step 6 · Review</div><h1>Here's what Eight+ will set up.</h1>
    <p class="lede">Nothing changes until you press Install. Your configuration is backed up first, and if Home Assistant doesn't like the result we roll straight back.</p>
    <div class="grid four">
      <div class="card stat"><div class="k">Helpers</div><div class="v">${sm.helpers}</div></div>
      <div class="card stat"><div class="k">Automations</div><div class="v">${sm.automations}</div></div>
      <div class="card stat"><div class="k">Sensors</div><div class="v">${sm.template_sensors}</div></div>
      <div class="card stat"><div class="k">Dashboard</div><div class="v"><small>/</small>${esc(a.dashboard.url_path)}</div></div>
    </div>
    <div class="card" style="margin-top:14px"><h2>${esc(sm.backend)}</h2><table class="ents">${people}</table>
      <div class="note" style="margin-top:12px">Tonight on weeknights: bed on at <b>${hm12(night.bedtime)}</b>, deepest cool around <b>${hm12(night.deep)}</b>, warming from <b>${hm12(night.prewake)}</b>, wake at <b>${hm12(night.wake)}</b>${a.features.smart ? " — with Autopilot adjusting as it goes" : ""}. The bed switches itself off after you get up.</div>
      ${p.restart_needed ? '<div class="note warn" style="margin-top:10px">Home Assistant will <b>restart once</b> (about a minute) to load the new package.</div>' : ""}
      ${p.packages.mode === "missing" ? '<div class="note" style="margin-top:10px">Adds <span class="mono">packages: !include_dir_named packages</span> under <span class="mono">homeassistant:</span> in configuration.yaml.</div>' : ""}
      ${p.warnings.map((w) => `<div class="note warn" style="margin-top:10px">${esc(w)}</div>`).join("")}
      ${p.collisions.length ? `<div class="note bad" style="margin-top:10px"><div><b>${p.collisions.length} entities already exist</b> and weren't made by Eight+: ${p.collisions.slice(0, 6).map((c) => `<span class="mono">${esc(c)}</span>`).join(", ")}${p.collisions.length > 6 ? "…" : ""}. Go back and use different names.</div></div>` : ""}
      <details><summary>See every file Eight+ will write</summary>${files}</details>
    </div>
    ${nav("Back", p.reinstall ? "Update install" : "Install", "install")}</div>`;
}

function vInstall() {
  const pr = S.progress || { steps: [] };
  const list = pr.steps.map((s) => `<li><span class="st ${s.status}">${s.status === "ok" ? "✓" : s.status === "warn" ? "!" : s.status === "fail" ? "✕" : ""}</span><div><div>${esc(s.label)}</div>${s.detail ? `<div class="d">${esc(s.detail)}</div>` : ""}</div></li>`).join("");
  const fail = pr.error;
  return `<div class="fade"><div class="eyebrow">${fail ? "Something went wrong" : pr.done ? "Done" : "Installing"}</div>
    <h1>${fail ? "Install stopped." : pr.done ? "All set." : "Setting up your Pod…"}</h1>
    <p class="lede">${fail ? "Nothing half-finished was left behind — details below." : "Leave this page open. If Home Assistant restarts, it'll pick up where it left off."}</p>
    <div class="card"><ul class="checks">${list || '<li><span class="st run"></span><div>Starting…</div></li>'}</ul></div>
    ${fail ? `<div class="note bad" style="margin-top:14px;white-space:pre-wrap">${esc(fail)}</div><div class="nav"><button class="btn ghost" data-act="toreview">Back to review</button></div>` : ""}</div>`;
}

function vDone() {
  const st = S.status, ins = st.install || {};
  const dash = ins.dashboard || "eight-plus";
  return `<div class="fade hero-done"><div class="tick">✓</div><h1>Your Pod is set up.</h1>
    <p class="lede" style="margin:0 auto 20px">${(ins.sleepers || []).map((s) => esc(s.name)).join(" and ")}${(ins.sleepers || []).length > 1 ? " each have" : " has"} a dashboard view, a schedule and Autopilot. Sleep reports appear each morning.</p>
    <button class="btn primary" data-act="opendash" data-path="${esc(dash)}">Open the Eight+ dashboard</button></div>
    <div class="grid two" style="margin-top:22px">
      <div class="card"><h2>Add it to your phone</h2><p class="muted small">In the Home Assistant app, open the dashboard and pin it — or turn on the Pod app below for a full-screen version.</p>
        ${st.app.enabled ? `<p class="small">Pod app: <span class="url">${esc(appUrl())}</span></p><p class="muted small">Open it in Safari → Share → Add to Home Screen.</p>` : ""}</div>
      <div class="card"><h2>Tonight</h2><p class="muted small">The bed turns on at bedtime by itself. Change anything in the card — Schedule for times, Autopilot for how it thinks, Settings for the rest.</p>
        <p class="muted small">${ins.answers?.features?.pipeline === false ? "Sleep reports are off." : "Sleep reports are starting — Eight+ is reading back through your recent nights now, so the Sleep tab may fill in within a few minutes."}</p></div>
    </div>
    <div class="nav"><div class="spacer"></div><button class="btn ghost" data-act="home">Go to the Eight+ panel</button></div>`;
}

function vHome() {
  const st = S.status, ins = st.install || {}, sl = st.sleep || {}, dr = st.drift || {};
  const nights = Object.entries(sl.nights || {}).map(([name, n]) => {
    const vals = Object.entries(n);
    return `<div><h3>${esc(name)}</h3>${vals.length ? `<div class="nights">${vals.map(([d, v]) => `<div style="height:${Math.max(6, v || 0)}%" title="${d}"><span>${v ?? "–"}</span></div>`).join("")}</div>` : '<p class="muted small">No nights yet — the first report lands the morning after a night in bed.</p>'}</div>`;
  }).join("");
  const upd = (dr.update || []).length, edited = (dr.edited || []).length;
  return `<div class="fade"><div class="eyebrow">Installed · v${esc(ins.version)}</div><h1>Eight+ is running.</h1>
    <p class="lede">${esc(({ gateway: "Eight+ Pod gateway", freesleep: "free-sleep", cloud: "Eight Sleep cloud" })[st.backend] || "")} · ${(ins.sleepers || []).map((s) => `${esc(s.name)} (${s.side})`).join(" · ")}</p>
    ${upd ? `<div class="note warn flex" style="margin-bottom:14px"><div style="flex:1"><b>This version updates ${upd} Eight+ file${upd > 1 ? "s" : ""}.</b> Your helper values, schedules and history are kept.${edited ? ` ${edited} file(s) were edited by hand and will be overwritten — copy your changes out first.` : ""}</div><button class="btn primary small" data-act="update">Apply update</button></div>` : ""}
    <div class="grid three">
      <div class="card stat"><div class="k">Home Assistant</div><div class="v" style="font-size:18px">${st.ha_connected ? "Connected" : "Offline"}</div></div>
      <div class="card stat"><div class="k">Sleep reports</div><div class="v" style="font-size:18px">${sl.enabled ? (sl.last_error ? "Error" : "Running") : "Off"}</div><div class="small muted">${sl.enabled ? esc(sl.source || "") + (sl.mqtt ? " → MQTT" : " → REST") : ""}</div></div>
      <div class="card stat"><div class="k">Card</div><div class="v" style="font-size:18px">${esc((ins.card || {}).mode === "hacs" ? "HACS" : "Bundled")}</div><div class="small muted mono">${esc((ins.card || {}).url || "")}</div></div>
    </div>
    ${sl.last_error ? `<div class="note bad" style="margin-top:14px">${esc(sl.last_error)}</div>` : ""}
    <div class="card" style="margin-top:14px"><div class="row"><h2 style="flex:1">Recent sleep scores</h2><button class="btn ghost small" data-act="runpipe">Run now</button></div><div class="grid two" style="margin-top:12px">${nights || '<p class="muted small">Sleep reports are off.</p>'}</div></div>
    <div class="card" style="margin-top:14px"><div class="toggle" style="border:0;padding:0"><div class="txt"><h3>Pod app on your Wi-Fi</h3><p>${st.app.enabled ? `Running at <span class="url">${esc(appUrl())}</span>` : "A full-screen, no-login app for phones at home. Anyone on your network can control the bed with it — but only the bed."}</p></div>
      <label class="switch"><input type="checkbox" data-act="standalone" ${st.app.enabled ? "checked" : ""}><span></span></label></div></div>
    <div class="nav"><button class="btn danger" data-act="uninstall">Uninstall</button><div class="spacer"></div>
      <button class="btn ghost" data-act="files">View YAML</button><button class="btn ghost" data-act="rerun">Change setup</button><button class="btn primary" data-act="opendash" data-path="${esc(ins.dashboard || "eight-plus")}">Open dashboard</button></div>
    <div id="filesbox"></div></div>`;
}

// ───────────────────────────────────────────── render + events
function render() {
  const root = $("#root");
  if (S.err && !S.det) { root.innerHTML = `${top()}<div class="card"><h2>Can't load</h2><p class="muted">${esc(S.err)}</p><button class="btn primary" data-act="reload">Try again</button></div>`; return; }
  if (!S.det || !S.status) return;
  let body;
  if (S.view === "install") body = vInstall();
  else if (S.view === "done") body = vDone();
  else if (S.view === "home") body = vHome();
  else body = ({ welcome: vWelcome, backend: vBackend, people: vPeople, routine: vRoutine, room: vRoom, features: vFeatures, review: vReview })[S.step]();
  root.innerHTML = top() + (S.err ? `<div class="note bad" style="margin-bottom:14px">${esc(S.err)}</div>` : "") + body;
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

document.addEventListener("click", async (e) => {
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
    if (act === "runpipe") { await api("api/pipeline/run", {}); el.textContent = "Running…"; setTimeout(refresh, 4000); }
    if (act === "files") { const j = await api("api/files"); $("#filesbox").innerHTML = `<div class="card" style="margin-top:14px">${Object.entries(j.files).map(([k, v]) => `<details><summary class="mono">${esc(k)}</summary><pre>${esc(v)}</pre></details>`).join("")}<details><summary>Card config</summary><pre>${esc(JSON.stringify(j.cards, null, 2))}</pre></details></div>`; }
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

// Plyra School: a graded course from 1100 to 2500. Each grade is a chessboard with its lessons on a knight's tour.
// Lessons mix reading, perfect-play endgame drills (Lichess tablebases), Lichess puzzles by theme, and trainers of our
// own: Think First (candidates graded by Stockfish), Blind Steps (visualization), Convert and Hold (play on against
// Stockfish). The School is part of Ply Pro and up; a free account gets the first two lessons.
import * as svc from "../app/sync.js";
import {
  ctx, esc, sleep, shuffle, stm, colorName, toast, el, makeBoard, waitClick, pickPuzzles,
  runPuzzle, runTbItem, runPlayout, runWatch, runThink, runBlindRound, findEnginePositions, runEngineGame, runChoice,
} from "./trainers.js";

const FILES = "abcdefgh";
const $view = document.getElementById("view");
const $hdr = document.getElementById("hdr");
const PREVIEW = location.pathname.includes("preview");
const CHECKOUT = {
  pro: "https://buy.stripe.com/aFa28r2EW2ZY9OReu7cIE00",
  max: "https://buy.stripe.com/aFa3cvcfw7ge3qt2LpcIE01",
  unlimited: "https://buy.stripe.com/fZuaEXfrIcAy2mpadRcIE02",
};

// ---------------- local storage (this browser), separate from the phone app's ----------------
const kv = (() => {
  let dbp = null; const mem = {};
  const db = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open("plyra-school", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  return {
    async get(k) {
      try { const d = await db(); return await new Promise((res, rej) => { const q = d.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
      catch { return mem[k]; }
    },
    async set(k, v) {
      mem[k] = v;
      try { const d = await db(); await new Promise((res, rej) => { const t = d.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); } catch {}
    },
  };
})();

// ---------------- state ----------------
const app = { signedIn: false, email: null, plan: "free", meta: null, full: {}, base: 0, dirty: false };
const paid = () => app.plan !== "free";
let S = { lessons: {}, review: [], seen: [] };        // progress: synced to the account
let P = { openAll: false, knightAt: {}, grade: 1 };   // preferences of this browser
const progressKey = () => `progress:${app.email || "-"}`;
async function saveLocal() { await kv.set(progressKey(), { S, base: app.base, dirty: app.dirty }); }
const savePrefs = () => kv.set("prefs", P);
let pushTimer = null;
function save() {
  app.dirty = true;
  saveLocal();
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushProgress, 1500);
}
ctx.onMiss = (key, kind, data) => addReview(key, kind, data);
Object.defineProperty(ctx, "seen", { get: () => S.seen, set: v => { S.seen = v; } });
ctx.saveSeen = () => save();

// merge two progress documents: a lesson done anywhere is done, best stars win, review items by latest change
function merge(a, b) {
  a = a || {}; b = b || {};
  const out = { lessons: { ...(b.lessons || {}) }, review: [], seen: [] };
  for (const [id, x] of Object.entries(a.lessons || {})) {
    const y = out.lessons[id];
    out.lessons[id] = !y ? x : { done: !!(x.done || y.done), stars: Math.max(x.stars || 0, y.stars || 0),
      best: Math.max(x.best || 0, y.best || 0), at: Math.max(x.at || 0, y.at || 0) };
  }
  const rev = new Map();
  for (const r of [...(b.review || []), ...(a.review || [])]) {
    const o = rev.get(r.key);
    if (!o || (r.t || 0) > (o.t || 0)) rev.set(r.key, r);
  }
  out.review = [...rev.values()].filter(r => !r.gone).concat([...rev.values()].filter(r => r.gone && Date.now() - r.t < 30 * 864e5));
  out.seen = [...new Set([...(b.seen || []), ...(a.seen || [])])].slice(-3000);
  return out;
}

// ---------------- Plyra's service ----------------
async function api(method, path, body) {
  const s = await svc.session();
  let r;
  try {
    r = await fetch(svc.GATEWAY + path, { method, headers: { "X-Session": s || "", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined });
  } catch { const e = new Error("offline"); e.status = 0; throw e; }
  let j = null; try { j = await r.json(); } catch {}
  if (r.ok) return j;
  const e = new Error((j && (typeof j.detail === "string" ? j.detail : j.detail?.message)) || `Error ${r.status}`);
  e.status = r.status; e.detail = j?.detail;
  if (r.status === 401) { await svc.signOut(); app.signedIn = false; go("#/"); }
  throw e;
}
async function pullProgress() {
  try {
    const j = await api("GET", "/v1/school/progress");
    if (j.plan) app.plan = j.plan;
    const merged = merge(S, j.progress);
    S = merged; app.base = j.version;
    app.dirty = JSON.stringify(merged) !== JSON.stringify(merge(j.progress, null));
    await saveLocal();
    if (app.dirty) await pushProgress();
  } catch { /* offline: keep working on this browser's copy */ }
}
async function pushProgress() {
  if (!app.signedIn || !app.dirty) return;
  for (let i = 0; i < 3; i++) {
    try {
      const j = await api("PUT", "/v1/school/progress", { base_version: app.base, progress: S });
      app.base = j.version; app.dirty = false; await saveLocal(); return;
    } catch (e) {
      if (e.status === 409 && e.detail) { S = merge(S, e.detail.progress); app.base = e.detail.version; continue; }
      return;  // offline: stays dirty, sent next time
    }
  }
}
async function loadGrade(n) {
  if (app.full[n]) return app.full[n];
  const cached = await kv.get(`grade:${n}`);
  if (cached && cached.v === app.meta.version && paid()) { app.full[n] = cached.grade; return cached.grade; }
  const j = await api("GET", `/v1/school/grade/${n}`);
  if (j.plan) app.plan = j.plan;
  app.full[n] = j.grade;
  kv.set(`grade:${n}`, { v: app.meta.version, grade: j.grade });
  return j.grade;
}

// ---------------- curriculum helpers ----------------
const grades = () => app.meta.grades;
const TRACKS = () => app.meta.tracks;
function findLesson(id) {
  for (const g of grades()) { const i = g.lessons.findIndex(l => l.id === id); if (i >= 0) return { g, i, l: g.lessons[i] }; }
  return null;
}
const isDone = l => !!S.lessons[l.id]?.done;
const gradeDone = g => isDone(g.lessons[g.lessons.length - 1]);
const gradeOpen = g => P.openAll || g.n === 1 || gradeDone(grades()[g.n - 2]);
const lessonOpen = (g, i) => gradeOpen(g) && (P.openAll || i === 0 || isDone(g.lessons[i - 1]));
const canUse = l => paid() || app.meta.free.includes(l.id);
const currentIndex = g => { const i = g.lessons.findIndex(l => !isDone(l)); return i < 0 ? g.lessons.length - 1 : i; };
const currentGrade = () => grades().find(g => !gradeDone(g)) || grades()[grades().length - 1];
const starsText = n => "★".repeat(n) + "☆".repeat(3 - n);

// ---------------- review queue ----------------
const DAY = 864e5, BOXES = [0, 1, 3, 7, 21];
function addReview(key, kind, data) {
  const ex = S.review.find(r => r.key === key);
  if (ex) { ex.box = 0; ex.due = Date.now(); ex.gone = false; ex.t = Date.now(); }
  else S.review.push({ key, kind, data, box: 0, due: Date.now(), t: Date.now() });
  save();
}
function gradeReview(key, ok) {
  const r = S.review.find(x => x.key === key); if (!r) return;
  r.t = Date.now();
  if (ok) { r.box = Math.min(BOXES.length - 1, r.box + 1); r.due = Date.now() + BOXES[r.box] * DAY; }
  else { r.box = 0; r.due = Date.now() + DAY / 2; }
  if (ok && r.box === BOXES.length - 1) { r.gone = true; r.data = null; }
  save();
}
const dueReviews = () => S.review.filter(r => !r.gone && r.due <= Date.now());

// ---------------- routing ----------------
let leave = () => {};
function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
function route() {
  leave(); leave = () => {};
  window.scrollTo(0, 0);
  if (!app.signedIn) return welcomeScreen();
  const [, a, b] = (location.hash || "#/").split("/");
  if (a === "lesson" && findLesson(b)) return lessonScreen(findLesson(b));
  if (a === "grade" && grades()[+b - 1]) { P.grade = +b; savePrefs(); return mapScreen(grades()[+b - 1]); }
  if (a === "notebook") return notebookScreen();
  if (a === "review") return reviewScreen();
  if (a === "plans") return plansScreen();
  const g = grades()[(P.grade || currentGrade().n) - 1] || currentGrade();
  return mapScreen(g);
}
function header(backTo) {
  $hdr.innerHTML = "";
  if (backTo) {
    const b = el(`<button class="icon-btn" aria-label="Back"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>`);
    b.onclick = () => go(backTo);
    $hdr.appendChild(b);
  } else if (app.signedIn) {
    const b = el(`<button class="pill plan-pill">${paid() ? esc(planName(app.plan)) : "Free · Upgrade"}</button>`);
    b.onclick = () => go("#/plans");
    $hdr.appendChild(b);
  }
}
const planName = p => ({ pro: "Ply Pro", max: "Ply Max", unlimited: "Unlimited", owner: "Owner", friend: "Ply Pro" }[p] || "Free");

// ---------------- welcome and sign-in ----------------
function welcomeScreen() {
  header(null);
  $view.innerHTML = "";
  $view.appendChild(el(`<section class="hero">
    <div class="eyebrow">Plyra School</div>
    <h1>A chess school on a chessboard.</h1>
    <p class="soft">Five grades from 1100 to 2500. Endgames against perfect play, tactics from real games, and trainers
    for calculation you won't find anywhere else.</p>
    ${miniMap()}
  </section>`));
  const card = el(`<div class="card"><h3>Sign in to start</h3>
    <p class="small soft" style="margin:0 0 10px">Your Plyra account: just your email, we send a 6-digit code. Plyra School is part of
    Ply Pro and up; with a free account you can try the first two lessons.</p></div>`);
  signInFlow(card);
  $view.appendChild(card);
  $view.appendChild(el(`<p class="small soft">By continuing you agree to the <a href="../terms.html">Terms</a> and <a href="../privacy.html">Privacy policy</a>.</p>`));
}
function miniMap() {
  let sq = "";
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) sq += `<i class="${(c + 8 - r) % 2 === 1 ? "d" : "l"}"></i>`;
  const g = app.meta.grades[0];
  const dots = g.lessons.map(l => { const [x, y] = center(l.square); return `<span class="mini-dot" style="left:${(x - .5) * 12.5}%;top:${(y - .5) * 12.5}%;--c:${TRACKS()[l.track].color}"></span>`; }).join("");
  return `<div class="map-wrap mini" aria-hidden="true"><div class="map-board">${sq}</div>${dots}</div>`;
}
function signInFlow(root) {
  const f = el(`<div>
    <form class="stack" id="f1" novalidate>
      <input class="field" id="email" type="email" inputmode="email" autocomplete="email" placeholder="Email" required>
      <button class="btn primary block" type="submit">Send me a code</button>
      <div class="err" id="e1"></div>
    </form>
    <form class="stack" id="f2" hidden novalidate>
      <p class="small soft" id="sent-to" style="margin:0"></p>
      <input class="field code" id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*" aria-label="6-digit code">
      <button class="btn primary block" type="submit">Sign in</button>
      <div class="btn-row"><button class="btn small" type="button" id="resend">Send a new code</button><button class="btn small" type="button" id="again">Use another email</button></div>
      <div class="err" id="e2"></div>
      <div id="devices"></div>
    </form></div>`);
  root.appendChild(f);
  const f1 = f.querySelector("#f1"), f2 = f.querySelector("#f2");
  let email = "";
  const PENDING = "pendingSignIn", MINUTES = 10;
  const codeStep = () => { f1.hidden = true; f2.hidden = false; f.querySelector("#sent-to").textContent = `We sent a 6-digit code to ${email}. It works for ${MINUTES} minutes; check your spam folder if it isn't there.`; };
  svc.kvGet(PENDING).then(p => { if (p && Date.now() - p.t < MINUTES * 60000 && f2.hidden) { email = p.email; f.querySelector("#email").value = email; codeStep(); } });
  f1.addEventListener("submit", async e => {
    e.preventDefault();
    email = f.querySelector("#email").value.trim();
    const err = f.querySelector("#e1");
    if (!/^\S+@\S+\.\S+$/.test(email)) { err.textContent = "Enter your email address."; return; }
    const b = f1.querySelector("button"); b.disabled = true; err.textContent = "";
    try { await svc.startSignIn(email); await svc.kvSet(PENDING, { email, t: Date.now() }); codeStep(); f.querySelector("#code").focus(); }
    catch (x) { err.textContent = x.message; }
    b.disabled = false;
  });
  f.querySelector("#again").onclick = async () => { await svc.kvDel(PENDING); f2.hidden = true; f1.hidden = false; };
  f.querySelector("#resend").onclick = async e => {
    const b = e.currentTarget; b.disabled = true;
    try { await svc.startSignIn(email); await svc.kvSet(PENDING, { email, t: Date.now() }); toast("New code sent."); }
    catch (x) { f.querySelector("#e2").textContent = x.message; }
    setTimeout(() => { b.disabled = false; }, 20000);
  };
  const verify = async (replace = null) => {
    const code = f.querySelector("#code").value.trim(), err = f.querySelector("#e2");
    if (!/^\d{6}$/.test(code)) { err.textContent = "Enter the 6 digits from the email."; return; }
    err.textContent = "";
    try {
      await svc.verifySignIn(email, code, replace);
      await svc.kvDel(PENDING);
      await afterSignIn();
      toast("Welcome to Plyra School.");
      go("#/");
    } catch (x) {
      if (x.status === 409 && x.detail?.devices) {
        const box = f.querySelector("#devices");
        box.innerHTML = `<p class="small">${esc(x.detail.message)}</p>` + x.detail.devices.map(d =>
          `<button class="btn block small" type="button" data-id="${esc(d.id)}" style="margin-top:6px">Sign out ${esc(d.name || d.device_name || "device")}</button>`).join("");
        box.querySelectorAll("button[data-id]").forEach(b => (b.onclick = () => verify(b.dataset.id)));
      } else err.textContent = x.message;
    }
  };
  f.querySelector("#code").addEventListener("input", e => { const v = e.target.value.replace(/\D/g, "").slice(0, 6); if (v !== e.target.value) e.target.value = v; if (v.length === 6) verify(); });
  f2.addEventListener("submit", e => { e.preventDefault(); verify(); });
}
async function afterSignIn() {
  app.signedIn = true;
  app.email = await svc.kvGet("email");
  const local = await kv.get(progressKey());
  if (local) { S = merge(local.S, null); app.base = local.base || 0; app.dirty = !!local.dirty; }
  else S = { lessons: {}, review: [], seen: [] };
  try { const a = await svc.account(); app.plan = String(a.plan || "free").toLowerCase(); }
  catch { const a = await svc.kvGet("account"); app.plan = String(a?.plan || "free").toLowerCase(); }
  await pullProgress();
}

// ---------------- plans ----------------
function plansScreen() {
  header("#/");
  $view.innerHTML = "";
  $view.appendChild(el(`<section><div class="eyebrow">Your plan · ${esc(planName(app.plan))}</div>
    <h1>${paid() ? "You have the whole School." : "Open the whole School."}</h1>
    <p class="soft">${paid() ? "All five grades are yours, on this phone and on any other device you sign in on." :
      "Plyra School is part of Ply Pro and up: all five grades, every trainer, and your progress on every device. One plan works in the phone app, the School and Plyra on your computer."}</p></section>`));
  if (!paid()) {
    const plans = [
      ["pro", "Ply Pro", "The whole School, Woodpecker, unlimited puzzles, plus Plyra's AI coach on your computer.", true],
      ["max", "Ply Max", "Everything in Ply Pro, more AI on your computer, every repertoire drilled on the phone."],
      ["unlimited", "Unlimited", "Everything, with the most AI."],
    ];
    for (const [id, name, text, best] of plans) {
      const c = el(`<div class="card plan${best ? " best" : ""}"><div class="eyebrow">${best ? "Most popular" : "&nbsp;"}</div><h2>${name}</h2>
        <p class="soft small">${text}</p><a class="btn ${best ? "primary" : ""} block" target="_blank" rel="noopener">Choose ${name}</a></div>`);
      c.querySelector("a").href = checkoutUrl(id);
      $view.appendChild(c);
    }
    const again = el(`<div class="card"><p class="small soft" style="margin:0 0 10px">Paid already? Use the same email as at checkout, then refresh.</p>
      <button class="btn block">I've paid: refresh my plan</button></div>`);
    again.querySelector("button").onclick = async () => {
      try { const a = await svc.account(); app.plan = String(a.plan || "free").toLowerCase(); } catch {}
      toast(paid() ? `${planName(app.plan)} is active.` : "Still on the Free plan for this email.");
      route();
    };
    $view.appendChild(again);
  }
  const acct = el(`<div class="card"><p class="small soft" style="margin:0 0 10px">Signed in as ${esc(app.email || "")}</p>
    <button class="btn block">Sign out</button></div>`);
  acct.querySelector("button").onclick = async () => { await pushProgress(); await svc.signOut(); app.signedIn = false; app.full = {}; go("#/"); };
  $view.appendChild(acct);
}
function checkoutUrl(planId) {
  const u = new URL(CHECKOUT[planId]);
  if (app.email) u.searchParams.set("prefilled_email", app.email);
  try { const ref = localStorage.getItem("plyra_ref"); if (ref) u.searchParams.set("prefilled_promo_code", ref); } catch {}
  return u.toString();
}

// ---------------- the map ----------------
function center(sq) { return [FILES.indexOf(sq[0]) + 0.5, 8 - +sq[1] + 0.5]; }
function mapScreen(g) {
  header(null);
  const L = g.lessons;
  const open = gradeOpen(g);
  const cur = currentIndex(g);
  const done = L.filter(isDone).length;
  const stars = L.reduce((s, l) => s + (S.lessons[l.id]?.stars || 0), 0);
  const due = dueReviews().length;
  $view.innerHTML = "";
  const tabs = el(`<nav class="grade-tabs" aria-label="Grades"></nav>`);
  for (const x of grades()) {
    const b = el(`<button class="${x.n === g.n ? "on" : ""} ${gradeOpen(x) ? "" : "locked"} ${gradeDone(x) ? "done" : ""}" aria-label="Grade ${x.n}">${gradeDone(x) ? "✓" : x.n}</button>`);
    b.onclick = () => go(`#/grade/${x.n}`);
    tabs.appendChild(b);
  }
  $view.appendChild(tabs);
  $view.appendChild(el(`<section>
    <div class="eyebrow">Grade ${g.n} · ${esc(g.range)} · ${done} of ${L.length} lessons</div>
    <h1>${esc(g.name.split(" · ")[1] || g.name)}</h1>
    <p class="soft">${esc(g.intro || "")}</p>
  </section>`));
  if (!open) $view.appendChild(el(`<div class="card locked-note"><b>Grade ${g.n} opens when you pass the Grade ${g.n - 1} checkpoint.</b></div>`));

  const wrap = el(`<div class="map-wrap${open ? "" : " dim"}" role="list" aria-label="Lessons"></div>`);
  const grid = el(`<div class="map-board" aria-hidden="true"></div>`);
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) grid.appendChild(el(`<i class="${(c + 8 - r) % 2 === 1 ? "d" : "l"}"></i>`));
  wrap.appendChild(grid);
  let paths = "";
  for (let i = 1; i < L.length; i++) {
    const [x1, y1] = center(L[i - 1].square), [x2, y2] = center(L[i].square);
    const dx = x2 - x1, dy = y2 - y1;
    const mx = Math.abs(dx) > Math.abs(dy) ? x2 : x1, my = Math.abs(dx) > Math.abs(dy) ? y1 : y2;
    const lit = isDone(L[i - 1]);
    paths += `<path d="M${x1} ${y1} L${mx} ${my} L${x2} ${y2}" stroke="${lit ? TRACKS()[L[i].track].color : "#3A4250"}" stroke-width="0.07" ${lit ? "" : 'stroke-dasharray="0.12 0.12"'}/>`;
  }
  wrap.appendChild(el(`<svg class="map-lines" viewBox="0 0 8 8" preserveAspectRatio="none" aria-hidden="true">${paths}</svg>`));
  L.forEach((l, i) => {
    const [x, y] = center(l.square);
    const st = S.lessons[l.id];
    const plan = !canUse(l);
    const cls = ["node", isDone(l) ? "done" : "", lessonOpen(g, i) ? "" : "locked", i === cur && open ? "current" : ""].join(" ");
    const n = el(`<button class="${cls}" role="listitem" style="left:${(x - .5) * 12.5}%;top:${(y - .5) * 12.5}%;--c:${TRACKS()[l.track].color}"
      aria-label="Lesson ${i + 1}: ${esc(l.title)}${isDone(l) ? ", done" : ""}${lessonOpen(g, i) ? "" : ", locked"}${plan ? ", Ply Pro" : ""}">
      <span class="dot">${l.track === "exam" ? "✓" : i + 1}</span>${st?.stars ? `<span class="stars">${"★".repeat(st.stars)}</span>` : ""}${plan ? '<span class="pro-dot" aria-hidden="true"></span>' : ""}</button>`);
    n.onclick = () => openLesson(g, i);
    wrap.appendChild(n);
  });
  if (open) {
    const target = L[cur].square;
    const from = P.knightAt[g.id] && L.some(l => l.square === P.knightAt[g.id]) ? P.knightAt[g.id] : target;
    const kn = el(`<div class="knight" aria-hidden="true"><img src="pieces/wN.svg" alt=""></div>`);
    const place = sq => { const [x, y] = center(sq); kn.style.left = `${(x - .5) * 12.5}%`; kn.style.top = `${(y - .5) * 12.5}%`; };
    place(from);
    wrap.appendChild(kn);
    if (from !== target) requestAnimationFrame(() => requestAnimationFrame(() => place(target)));
    if (P.knightAt[g.id] !== target) { P.knightAt[g.id] = target; savePrefs(); }
  }
  $view.appendChild(wrap);
  $view.appendChild(el(`<div class="legend">${Object.values(TRACKS()).map(t => `<span style="--c:${t.color}">${t.name}</span>`).join("")}</div>`));

  if (open) {
    const next = L[cur];
    const nextCard = el(`<div class="card" style="margin-top:16px;--c:${TRACKS()[next.track].color}">
      <div class="eyebrow" style="color:var(--c)">${gradeDone(g) ? "Grade complete · revisit" : "Next lesson"} · ${TRACKS()[next.track].name}</div>
      <h2>${esc(next.title)}</h2>
      <p class="soft small">${esc(summary(next))}</p>
      <button class="btn primary block">${!canUse(next) ? "Unlock with Ply Pro" : S.lessons[next.id] ? "Continue" : "Start"}</button>
    </div>`);
    nextCard.querySelector("button").onclick = () => openLesson(g, cur);
    $view.appendChild(nextCard);
  }
  if (!paid()) {
    const up = el(`<div class="upsell"><span>Free account: the first two lessons. <b>Ply Pro</b> opens all five grades.</span><button class="btn small primary">See plans</button></div>`);
    up.querySelector("button").onclick = () => go("#/plans");
    $view.appendChild(up);
  }
  const tools = el(`<div class="btn-row" style="margin:14px 0">
    <button class="btn" data-go="#/notebook">Notebook <span class="pill">${grades().flatMap(x => x.lessons).filter(l => isDone(l) && l.track !== "exam").length}</span></button>
    <button class="btn" data-go="#/review">Review <span class="pill"${due ? ' style="color:var(--brass)"' : ""}>${due}</span></button>
  </div>`);
  tools.querySelectorAll("[data-go]").forEach(b => (b.onclick = () => go(b.dataset.go)));
  $view.appendChild(tools);

  const list = el(`<div class="card"><div class="eyebrow">Grade ${g.n} lessons · ${stars} of ${L.length * 3} stars</div></div>`);
  L.forEach((l, i) => {
    const st = S.lessons[l.id];
    const row = el(`<button class="lesson-row ${isDone(l) ? "done" : ""}" style="--c:${TRACKS()[l.track].color}" ${lessonOpen(g, i) ? "" : "disabled"}>
      <span class="num">${l.track === "exam" ? "✓" : i + 1}</span>
      <span style="flex:1;min-width:0"><b>${esc(l.title)}</b><br><span class="small dim">${TRACKS()[l.track].name} · ${l.square}</span></span>
      <span class="small" style="color:var(--brass)">${st?.done ? starsText(st.stars) : !canUse(l) ? '<span class="pill">Ply Pro</span>' : lessonOpen(g, i) ? "" : "🔒"}</span></button>`);
    row.onclick = () => openLesson(g, i);
    list.appendChild(row);
  });
  if (PREVIEW) {
    const t = el(`<label class="small soft" style="display:flex;gap:10px;align-items:center;margin-top:12px">
      <input type="checkbox" ${P.openAll ? "checked" : ""}> Open every lesson and grade (preview)</label>`);
    t.querySelector("input").onchange = e => { P.openAll = e.target.checked; savePrefs(); route(); };
    list.appendChild(t);
  }
  $view.appendChild(list);
}
function openLesson(g, i) {
  const l = g.lessons[i];
  if (!canUse(l)) return go("#/plans");
  if (!lessonOpen(g, i)) return toast(gradeOpen(g) ? "Finish the lesson before it first." : `Pass the Grade ${g.n - 1} checkpoint first.`);
  go(`#/lesson/${l.id}`);
}
function summary(l) {
  const names = { read: "reading", watch: "perfect play", exercise: "drills", playout: "play it out", puzzles: "puzzles", think: "Think First", blind: "Blind Steps", exam: "checkpoint", engine: "play on vs Stockfish", choose: "positions from real games" };
  const kinds = l.steps ? [...new Set(l.steps.map(s => s.type))] : l.kinds || [];
  return `${l.steps ? l.steps.length : l.parts} parts · ${[...new Set(kinds.map(k => names[k]))].join(", ")}`;
}

// ---------------- notebook ----------------
function notebookScreen() {
  header("#/");
  $view.innerHTML = "";
  $view.appendChild(el(`<section><div class="eyebrow">Your notebook</div><h1>Rules you've earned</h1>
    <p class="soft">Every lesson you finish writes its one-line rule here. Read them before a game.</p></section>`));
  let any = false;
  for (const g of grades()) {
    const done = g.lessons.filter(l => isDone(l) && l.track !== "exam");
    if (!done.length) continue;
    any = true;
    const card = el(`<div class="card"><div class="eyebrow">${esc(g.name)}</div></div>`);
    done.forEach(l => card.appendChild(el(`<div class="notebook-item" style="--c:${TRACKS()[l.track].color}"><span class="tick"></span>
      <div><b>${esc(l.title)}</b><br><span class="soft">${esc(l.rule)}</span></div></div>`)));
    $view.appendChild(card);
  }
  if (!any) $view.appendChild(el(`<div class="card"><p class="soft" style="margin:0">Nothing yet. Finish your first lesson and its rule appears here.</p></div>`));
}

// ---------------- review ----------------
async function reviewScreen() {
  header("#/");
  $view.innerHTML = "";
  const due = dueReviews();
  $view.appendChild(el(`<section><div class="eyebrow">Review · ${due.length} due</div><h1>Positions you missed</h1>
    <p class="soft">Missed positions come back: right away, then after a day, three days, a week and three weeks. Get one right at three weeks and it graduates.</p></section>`));
  if (!due.length) {
    const later = S.review.filter(r => !r.gone).length;
    $view.appendChild(el(`<div class="card"><p class="soft" style="margin:0">Nothing due. ${later ? `${later} waiting for later.` : "Positions you miss in lessons land here."}</p></div>`));
    return;
  }
  const host = el(`<div></div>`); $view.appendChild(host);
  const board = makeBoard(host);
  let alive = true; leave = () => { alive = false; };
  for (const [i, r] of due.entries()) {
    if (!alive) return;
    const t = `Review ${i + 1} of ${due.length}`;
    const ok = r.kind === "puzzle" ? await runPuzzle(board, r.data, { title: t })
      : r.kind === "choice" ? await runChoice(board, r.data, { title: t }) : await runTbItem(board, r.data, { title: t });
    if (!alive) return;
    gradeReview(r.key, ok);
    if (i + 1 < due.length) await waitClick(board, "Next");
  }
  board.ui.msg("Review done.", "good");
  board.ui.actions([["Back to the map", () => go("#/"), true]]);
}

// ---------------- lesson runner ----------------
async function lessonScreen({ g, i, l: metaLesson }) {
  header(`#/grade/${g.n}`);
  if (!canUse(metaLesson)) return go("#/plans");
  let lesson = metaLesson;
  if (!lesson.steps) {
    $view.innerHTML = `<div class="card"><p class="soft" style="margin:0">Loading the lesson…</p></div>`;
    try {
      lesson = (await loadGrade(g.n)).lessons.find(x => x.id === metaLesson.id);
      if (!lesson) {  // the website is newer than the copy of this grade on the phone (or the service): fetch again
        delete app.full[g.n]; await kv.set(`grade:${g.n}`, null);
        lesson = (await loadGrade(g.n)).lessons.find(x => x.id === metaLesson.id);
        if (!lesson) throw Object.assign(new Error("This lesson is being updated. Try again in a few minutes."), { status: 503 });
      }
    }
    catch (e) {
      $view.innerHTML = "";
      const c = el(`<div class="card"><p>${e.status === 402 ? "This lesson is part of Ply Pro." : e.status === 0 ? "You're offline. Lessons you've opened before work offline; this one needs a connection the first time." : esc(e.message)}</p><button class="btn primary block">${e.status === 402 ? "See plans" : "Back"}</button></div>`);
      c.querySelector("button").onclick = () => go(e.status === 402 ? "#/plans" : `#/grade/${g.n}`);
      $view.appendChild(c);
      return;
    }
  }
  const color = TRACKS()[lesson.track].color;
  let alive = true; leave = () => { alive = false; };
  const isAlive = () => alive;
  const scores = [];
  for (let si = 0; si < lesson.steps.length; si++) {
    if (!alive) return;
    const step = lesson.steps[si];
    $view.innerHTML = "";
    $view.appendChild(el(`<div style="--c:${color}">
      <div class="eyebrow" style="color:${color}">Grade ${g.n} · ${TRACKS()[lesson.track].name} · ${esc(lesson.title)}</div>
      <div class="steps">${lesson.steps.map((_, k) => `<i class="${k < si ? "on" : k === si ? "now" : ""}"></i>`).join("")}</div>
    </div>`));
    const host = el(`<div></div>`); $view.appendChild(host);
    if (step.type === "read" && !step.fen) {
      host.appendChild(el(`<div class="card"><p class="prose" style="margin:0">${esc(step.text)}</p></div>`));
      const b = el(`<button class="btn primary block">Continue</button>`); host.appendChild(b);
      await new Promise(res => (b.onclick = res));
      continue;
    }
    const board = makeBoard(host);
    board.ui.title(`Part ${si + 1} of ${lesson.steps.length}`);
    if (step.type === "read") {
      board.ui.prompt(`${colorName(stm(step.fen))} to move`);
      board.set({ fen: step.fen, orientation: "white", interactive: false, marks: step.marks || [], animate: false });
      board.ui.msg(esc(step.text));
      await waitClick(board, "Continue");
    } else if (step.type === "watch") {
      await runWatch(board, step, isAlive);
    } else if (step.type === "exercise") {
      let got = 0;
      for (const [k, item] of step.items.entries()) {
        if (!alive) return;
        if (await runTbItem(board, item, { title: `${step.label} · ${k + 1} of ${step.items.length}` })) got++;
        await waitClick(board, k + 1 < step.items.length ? "Next position" : "Continue");
      }
      scores.push([got, step.items.length]);
    } else if (step.type === "playout") {
      board.ui.title("Play it out · the opponent is the tablebase");
      const s = await runPlayout(board, step, isAlive);
      if (!alive) return;
      scores.push([s, 1]);
      await waitClick(board, "Continue");
    } else if (step.type === "puzzles") {
      board.ui.msg("Loading puzzles…");
      const rows = await pickPuzzles(step);
      let got = 0;
      for (const [k, row] of rows.entries()) {
        if (!alive) return;
        if (await runPuzzle(board, row, { title: `${step.label} · ${k + 1} of ${rows.length}` })) got++;
        await waitClick(board, k + 1 < rows.length ? "Next puzzle" : "Continue");
      }
      scores.push([got, rows.length]);
    } else if (step.type === "think") {
      board.ui.msg("Loading positions… Stockfish starts on the first answer.");
      const rows = await pickPuzzles({ min: step.min, max: step.max, count: step.count, minLine: 4 });
      let got = 0, max = 0;
      for (const [k, row] of rows.entries()) {
        if (!alive) return;
        const [p, m] = await runThink(board, row, `${step.label} · ${k + 1} of ${rows.length}`, isAlive);
        got += p; max += m;
        await waitClick(board, k + 1 < rows.length ? "Next position" : "Continue");
      }
      scores.push([got, max]);
    } else if (step.type === "blind") {
      const [lo, hi] = step.plies || [2, 4];
      const rows = await pickPuzzles({ min: step.min, max: step.max, count: step.count + 6, minLine: hi + 1 });
      let got = 0, plies = lo;
      for (let k = 0; k < step.count && k < rows.length; k++) {
        if (!alive) return;
        const ok = await runBlindRound(board, rows[k], plies, `${step.label} · ${k + 1} of ${step.count} · ${plies} moves`, isAlive);
        if (ok) { got++; plies = Math.min(hi, plies + 1); } else plies = Math.max(lo, plies - 1);
        await waitClick(board, k + 1 < step.count ? "Next" : "Continue");
      }
      scores.push([got, step.count]);
    } else if (step.type === "engine") {
      board.ui.title(`${step.label} · against Stockfish`);
      board.ui.prompt(step.mode === "convert" ? "Convert the advantage" : "Hold the position");
      board.ui.msg("Stockfish is choosing positions from real games… (the first time takes a few seconds)");
      const positions = await findEnginePositions(step, (a, b) => board.ui.msg(`Stockfish is choosing positions from real games… ${a}/${b}`));
      let got = 0;
      for (const [k, pos] of positions.entries()) {
        if (!alive) return;
        got += await runEngineGame(board, pos, step, `${step.label} · ${k + 1} of ${positions.length}`, isAlive);
        if (!alive) return;
        await waitClick(board, k + 1 < positions.length ? "Next position" : "Continue");
      }
      scores.push([got, Math.max(1, positions.length)]);
    } else if (step.type === "choose") {
      const items = shuffle(step.items.slice()).slice(0, step.count);
      let got = 0;
      for (const [k, item] of items.entries()) {
        if (!alive) return;
        if (await runChoice(board, item, { title: `${step.label} · ${k + 1} of ${items.length}` })) got++;
        if (!alive) return;
        await waitClick(board, k + 1 < items.length ? "Next position" : "Continue");
      }
      scores.push([got, items.length]);
    } else if (step.type === "exam") {
      const r = await runExam(board, step, g, isAlive);
      if (!alive) return;
      if (!r.pass) {
        board.ui.extra.innerHTML = "";
        board.ui.msg(`${r.got} of ${r.total}. You need ${step.pass} to pass. Go over your misses in Review, then try again.`, "bad");
        await new Promise(res => board.ui.actions([["Back to the map", () => { go(`#/grade/${g.n}`); res(); }], ["Try again", () => { route(); res(); }, true]]));
        return;
      }
      scores.push([r.got, r.total]);
    }
  }
  if (!alive) return;
  finishLesson(g, i, lesson, scores);
}

async function runExam(board, step, g, alive) {
  const full = await loadGrade(g.n);
  const steps = full.lessons.flatMap(l => l.steps);
  const tbItems = shuffle(steps.filter(s => s.type === "exercise").flatMap(s => s.items)).slice(0, 3);
  const choices = shuffle(steps.filter(s => s.type === "choose").flatMap(s => s.items)).slice(0, 2);
  const themes = [...new Set(steps.filter(s => s.type === "puzzles").flatMap(s => s.themes))];
  const blindStep = steps.find(s => s.type === "blind");
  const plies = blindStep?.plies ? blindStep.plies[0] + 1 : 3;
  const nPuzzles = step.count - tbItems.length - choices.length - 2;
  const puzzles = await pickPuzzles({ themes, min: step.min, max: step.max, count: nPuzzles });
  const blinds = await pickPuzzles({ min: blindStep?.min || step.min, max: blindStep?.max || step.max, count: 2, minLine: plies + 1 });
  const qs = shuffle([...tbItems.map(x => ["tb", x]), ...choices.map(x => ["ch", x]), ...puzzles.map(x => ["pz", x])]).concat(blinds.map(x => ["bl", x]));
  let got = 0;
  for (const [k, [kind, x]] of qs.entries()) {
    if (!alive()) return { pass: false, got, total: qs.length };
    const title = `Checkpoint · ${k + 1} of ${qs.length} · ${got} right`;
    const ok = kind === "tb" ? await runTbItem(board, x, { title, exam: true })
      : kind === "pz" ? await runPuzzle(board, x, { title, exam: true })
      : kind === "ch" ? await runChoice(board, x, { title, exam: true })
      : await runBlindRound(board, x, plies, title, alive);
    if (ok) got++;
    await waitClick(board, k + 1 < qs.length ? "Next question" : "See result");
  }
  const pass = got >= Math.round(step.pass * qs.length / step.count);
  return { pass, got, total: qs.length };
}

function finishLesson(g, i, lesson, scores) {
  const got = scores.reduce((s, x) => s + x[0], 0), max = scores.reduce((s, x) => s + x[1], 0);
  const acc = max ? got / max : 1;
  const stars = acc >= 0.9 ? 3 : acc >= 0.7 ? 2 : 1;
  const prev = S.lessons[lesson.id] || {};
  S.lessons[lesson.id] = { done: true, stars: Math.max(stars, prev.stars || 0), best: Math.max(acc, prev.best || 0), at: Date.now() };
  save();
  const color = TRACKS()[lesson.track].color;
  const isExam = lesson.track === "exam";
  const nextGrade = isExam ? grades()[g.n] : null;
  const r = 52, C = 2 * Math.PI * r;
  $view.innerHTML = "";
  const card = el(`<div style="--c:${color}">
    <div class="eyebrow" style="color:${color}">${isExam ? `Grade ${g.n} passed` : `Lesson complete · ${TRACKS()[lesson.track].name}`}</div>
    <h1>${esc(lesson.title)}</h1>
    <svg class="score-ring" viewBox="0 0 120 120" role="img" aria-label="${Math.round(acc * 100)} percent">
      <circle cx="60" cy="60" r="${r}" fill="none" stroke="#2A313D" stroke-width="9"/>
      <circle cx="60" cy="60" r="${r}" fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${C * acc} ${C}" transform="rotate(-90 60 60)"/>
      <text x="60" y="58" text-anchor="middle" fill="#ECEEE8" font-family="JetBrains Mono, monospace" font-weight="700" font-size="24">${Math.round(acc * 100)}%</text>
      <text x="60" y="80" text-anchor="middle" fill="#E3B65A" font-size="15">${starsText(stars)}</text>
    </svg>
    <div class="rule-card" style="margin-bottom:14px"><div class="eyebrow">${isExam ? "Certificate" : "Into your notebook"}</div><p style="margin:0">${esc(lesson.rule)}</p></div>
    ${nextGrade ? `<p class="soft">${esc(nextGrade.name)} is open.</p>` : ""}
    ${dueReviews().length ? `<p class="soft small">${dueReviews().length} missed position${dueReviews().length > 1 ? "s are" : " is"} waiting in Review.</p>` : ""}
    <div class="btn-row"><button class="btn" data-a="again">Do it again</button><button class="btn primary" data-a="map">${nextGrade ? `Go to Grade ${nextGrade.n}` : "Back to the map"}</button></div>
  </div>`);
  card.querySelector("[data-a=again]").onclick = () => route();
  card.querySelector("[data-a=map]").onclick = () => go(nextGrade ? `#/grade/${nextGrade.n}` : `#/grade/${g.n}`);
  $view.appendChild(card);
}

// ---------------- start ----------------
(async () => {
  $view.innerHTML = `<p class="soft" style="padding:20px 0">Loading…</p>`;
  app.meta = await (await fetch("curriculum/sample.json", { cache: "no-cache" })).json();
  P = { ...P, ...((await kv.get("prefs")) || {}) };
  if (await svc.session()) {
    app.signedIn = true;
    app.email = await svc.kvGet("email");
    const local = await kv.get(progressKey());
    if (local) { S = merge(local.S, null); app.base = local.base || 0; app.dirty = !!local.dirty; }
    const a = await svc.kvGet("account");
    app.plan = String(a?.plan || "free").toLowerCase();
    window.addEventListener("hashchange", route);
    route();
    // refresh the plan and the progress in the background, then redraw the map if nothing else is open
    (async () => {
      try { const acc = await svc.account(); app.plan = String(acc.plan || "free").toLowerCase(); } catch {}
      await pullProgress();
      const [, a2] = (location.hash || "#/").split("/");
      if (!a2 || a2 === "grade") route();
    })();
  } else {
    window.addEventListener("hashchange", route);
    route();
  }
  window.addEventListener("online", pushProgress);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") pushProgress(); });
})();

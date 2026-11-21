// Plyra phone app.
//   Link a Chess.com or Lichess account (no Plyra account needed): your games are reviewed by Stockfish on the phone,
//   and every mistake, missed tactic and opening you play becomes practice with spaced repetition.
//   Signed in to a Plyra account, the phone also gets the repertoires, tactics and progress from Plyra on your
//   computer, and drill progress goes both ways.
// Everything is kept on the phone (works offline).
import { Board, playUci, startFen } from "./board.js";
import * as svc from "./sync.js";
import * as games from "./games.js";
import { reviewGame, practiceItems, openingsPack, keyOf } from "./review.js";
import { analyse, winPct } from "./engine.js";
import * as pz from "./puzzles.js";

const DAY = 86400;
const BOX_DAYS = { 1: 0, 2: 1, 3: 3, 4: 7, 5: 21 };  // same spacing as the computer's drill
const FREE_TACTICS_PER_DAY = 10;
const FREE_PUZZLES_PER_DAY = 20;   // rated, phase and theme puzzles on the Free plan (Woodpecker is Ply Pro)
const paid = () => plan() !== "free";
// The Free plan's daily allowances are counted by Plyra's service per account (so they can't be reset on the phone);
// offline, a count kept on the phone stands in until the next connection.
const FREE_LIMITS = { puzzle: FREE_PUZZLES_PER_DAY, tactic: FREE_TACTICS_PER_DAY };
async function allowance(kind, consume = false) {
  if (paid()) return { allowed: true, used: 0, limit: null };
  const key = `${kind}:${today()}`;
  let r = null;
  try { r = await svc.usage(kind, consume); } catch (e) { if (e.status === 401) { await signedOut(); return { allowed: false, used: 0, limit: 0 }; } }
  if (r) {
    if (r.plan && r.plan !== "free" && app.account) app.account.plan = r.plan;
    await svc.kvSet(key, Math.max(r.used, (await svc.kvGet(key)) || 0));
    return r;
  }
  const used = (await svc.kvGet(key)) || 0, limit = FREE_LIMITS[kind];
  if (!consume) return { allowed: used < limit, used, limit };
  if (used >= limit) return { allowed: false, used, limit };
  await svc.kvSet(key, used + 1);
  return { allowed: true, used: used + 1, limit };
}
async function puzzlesLeft() { const a = await allowance("puzzle"); return a.limit == null ? null : Math.max(0, a.limit - a.used); }
const TACTICS = "TACTICS", MISTAKES = "MISTAKES";
const REVIEW_FIRST = 25;      // games reviewed automatically after an import (newest first)
const REFRESH_EVERY = 3600;   // seconds between automatic fetches of new games

const $view = document.getElementById("view");
const $tabs = document.getElementById("tabs");
const $status = document.getElementById("status");

const app = {
  tab: "today", screen: null, cleanup: null,
  signedIn: false, account: null, books: [], syncing: false, syncOff: false,
  links: [], games: [], reviews: {}, reviewTarget: REVIEW_FIRST, reviewing: null, importing: null,
  practice: [], packs: {},
};

// ---- helpers -------------------------------------------------------------------------------------------------
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const now = () => Date.now() / 1000;
const today = () => new Date().toISOString().slice(0, 10);
function h(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; }
function toast(text, ms = 2600) {
  document.querySelector(".toast")?.remove();
  const t = h(`<div class="toast" role="status">${esc(text)}</div>`);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}
function ago(ts) {
  if (!ts) return "never";
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
function until(ts) {
  const s = ts - now();
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
}
function dateOf(t) { return t ? new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : ""; }
function shortLabel(label) {
  const parts = String(label || "Repertoire").split(" · ");
  return parts[parts.length - 1] || parts[0];
}
function plan() { return String(app.account?.plan || "free").toLowerCase(); }
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
const shake = el => { el.classList.remove("wrong"); void el.offsetWidth; el.classList.add("wrong"); };

// ---- tabs ------------------------------------------------------------------------------------------------------
const ICONS = {
  today: '<path d="M4 11.5 12 5l8 6.5V20a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z"/>',
  openings: '<path d="M4 5.5C6.5 4 9.5 4 12 6c2.5-2 5.5-2 8-.5V19c-2.5-1.5-5.5-1.5-8 .5-2.5-2-5.5-2-8-.5zM12 6v13.5"/>',
  practice: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".8" fill="currentColor"/>',
  progress: '<path d="M4 19h16M6 15l4-4 3 3 5-6"/>',
  account: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c1-3.5 4-5 7-5s6 1.5 7 5"/>',
};
const TABS = [["today", "Today"], ["openings", "Openings"], ["practice", "Practice"], ["progress", "Games"], ["account", "Account"]];

function drawTabs() {
  $tabs.innerHTML = TABS.map(([id, label]) =>
    `<button data-tab="${id}" ${app.tab === id ? 'aria-current="page"' : ""}>
       <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[id]}</svg>
       ${label}</button>`).join("");
}
$tabs.addEventListener("click", e => {
  const b = e.target.closest("button[data-tab]");
  if (b) go(b.dataset.tab);
});
$view.addEventListener("click", e => {
  const g = e.target.closest("[data-go]");
  if (g) { e.preventDefault(); go(g.dataset.go, g.dataset.screen ? JSON.parse(g.dataset.screen) : null); }
});

function go(tab, screen = null) {
  if (app.cleanup) { app.cleanup(); app.cleanup = null; }
  app.tab = tab;
  app.screen = screen;
  drawTabs();
  window.scrollTo(0, 0);
  render();
}

let renderSeq = 0;
async function signedOut() {
  await svc.signOut();
  app.signedIn = false; app.account = null; app.books = [];
  await rebuildPractice();
  app.screen = null;
  drawStatus();
  render();
}

// Plyra needs a free account (an email and a 6-digit code, no password): the account is what carries your plan and
// your daily allowances, on every phone and computer you use.
async function viewWelcome(root) {
  root.append(h(`<div class="welcome">
    <img src="icons/icon-192.png" alt="" class="welcome-icon">
    <div class="eyebrow">Plyra Chess</div>
    <h1>Get better from your own games.</h1>
    <ul class="ticks" style="margin:14px 0 18px;color:var(--ink-soft)">
      <li>Your Chess.com or Lichess games reviewed by Stockfish, right on your phone</li>
      <li>Drills of the mistakes you actually make and the openings you play</li>
      <li>Rated puzzles by phase, endgame type and theme</li>
    </ul></div>`));
  const card = h(`<div class="card"><h3>Create your free account or sign in</h3>
    <p class="small soft" style="margin:0 0 10px">Just your email: we send a 6-digit code, no password. Already use Plyra on your
    computer or bought a plan? Use the same email.</p></div>`);
  signInFlow(card);
  root.append(card);
  root.append(h(`<p class="small soft">By continuing you agree to the <a href="../terms.html">Terms</a> and
    <a href="../privacy.html">Privacy policy</a>.</p>`));
}

async function render() {
  $tabs.hidden = !app.signedIn;
  const fn = !app.signedIn ? viewWelcome : { today: viewToday, openings: viewOpenings, practice: viewPractice, progress: viewGames, account: viewAccount }[app.tab];
  const seq = ++renderSeq;
  const frag = document.createElement("div");
  await fn(frag);
  if (seq !== renderSeq) return;  // a newer render started meanwhile
  $view.replaceChildren(...frag.childNodes);
  app.onRendered?.();
  app.onRendered = null;
}
// re-render only the overview screens (never in the middle of a drill or a puzzle)
function refreshIfIdle() {
  if (!app.signedIn) return;  // never redraw the sign-in screen under someone typing a code
  if (!app.screen && ["today", "openings", "progress"].includes(app.tab)) render();
}

function drawStatus() {
  let text = "";
  if (app.importing) text = app.importing;
  else if (app.reviewing) text = app.reviewing;
  else if (app.signedIn) text = app.syncing ? "Syncing…" : (navigator.onLine ? "" : "Offline");
  else if (!navigator.onLine) text = "Offline";
  $status.textContent = text;
}

// ---- data ----------------------------------------------------------------------------------------------------------
async function loadLocal() {
  app.signedIn = !!(await svc.session());
  app.books = (await svc.kvGet("books")) || [];
  app.account = await svc.kvGet("account");
  app.links = (await svc.kvGet("links")) || [];
  app.games = (await svc.kvGet("games")) || [];
  app.reviews = (await svc.kvGet("reviews")) || {};
  app.reviewTarget = (await svc.kvGet("reviewTarget")) || REVIEW_FIRST;
  await rebuildPractice();
}

async function rebuildPractice() {
  const items = practiceItems(app.games, app.reviews);
  const desk = await svc.kvGet("practice/main");
  if (app.signedIn && desk?.items) {
    for (const p of desk.items) {
      items.push({ id: p.id, fen: p.fen, color: p.color, kind: "tactic", tactic: true, phase: "middlegame",
                   best: p.solution_uci, bestSan: p.solution_san, line: p.line || [], move: p.move_number,
                   label: desk.categories?.[p.category] || "Tactic", date: p.date, desk: true, t: 0 });
    }
  }
  app.practice = items;
  app.packs = {};
  for (const color of ["white", "black"]) {
    const p = openingsPack(app.games, app.reviews, color);
    if (p) app.packs[p.id] = p;
  }
}

// ---- importing games -------------------------------------------------------------------------------------------------
async function importGames(link, { first = false } = {}) {
  const name = link.platform === "lichess" ? "Lichess" : "Chess.com";
  app.importing = `Getting your ${name} games…`;
  drawStatus();
  try {
    const got = link.platform === "lichess"
      ? await games.lichess(link.username, { max: first ? 100 : 40 })
      : await games.chesscom(link.username, { months: first ? 3 : 1, onProgress: (i, n) => { app.importing = `Getting your ${name} games (${i}/${n})…`; drawStatus(); } });
    const have = new Set(app.games.map(g => g.id));
    const fresh = got.filter(g => !have.has(g.id));
    app.games = [...fresh, ...app.games].sort((a, b) => b.t - a.t).slice(0, 1500);
    await svc.kvSet("games", app.games);
    link.last = Date.now();
    await svc.kvSet("links", app.links);
    return fresh.length;
  } finally {
    app.importing = null;
    drawStatus();
  }
}

async function refreshGames({ force = false } = {}) {
  if (!navigator.onLine) return;
  let n = 0;
  for (const l of app.links) {
    if (!force && l.last && Date.now() - l.last < REFRESH_EVERY * 1000) continue;
    try { n += await importGames(l); } catch (e) { if (force) toast(e.message); }
  }
  if (n) { await rebuildPractice(); refreshIfIdle(); }
  reviewLoop();
  return n;
}

// ---- reviewing on the phone (newest games first, one position at a time) ---------------------------------------------
let reviewRunning = false;
async function reviewLoop() {
  if (reviewRunning) return;
  reviewRunning = true;
  try {
    for (;;) {
      const todo = app.games.slice(0, app.reviewTarget).filter(g => !app.reviews[g.id]);
      if (!todo.length) break;
      const g = todo[0];
      const left = todo.length;
      const r = await reviewGame(g, {
        onPly: (i, n) => {
          app.reviewing = `Reviewing ${left} game${left === 1 ? "" : "s"} · ${Math.round(100 * i / n)}%`;
          drawStatus();
        },
      });
      if (!r) break;
      app.reviews[g.id] = r;
      await svc.kvSet("reviews", app.reviews);
      await rebuildPractice();
      refreshIfIdle();
    }
  } catch (e) {
    console.error(e);
    toast("The engine stopped: " + (e.message || e));
  } finally {
    app.reviewing = null;
    reviewRunning = false;
    drawStatus();
  }
}

// ---- syncing with a Plyra account --------------------------------------------------------------------------------------
async function syncNow({ quiet = false } = {}) {
  if (!app.signedIn || app.syncing) return;
  app.syncing = true;
  drawStatus();
  try {
    await svc.pushAll();
    const r = await svc.pull();
    app.syncOff = r.enabled === false;
    if (!app.syncOff) app.books = r.books;
    try { app.account = await svc.account(); } catch { /* keep the last one */ }
    await rebuildPractice();
    if (!quiet) toast("Up to date.");
  } catch (e) {
    if (e.status === 401) { await signedOut(); toast("Signed out: sign in again."); }
    else if (!quiet) toast(e.message);
  } finally {
    app.syncing = false;
    drawStatus();
  }
}

// ---- drill state (the same records as the computer: box, due, right_count, wrong_count) ----------------------------------
async function drillState(id) { return (await svc.kvGet(`drill/${id}`)) || {}; }
async function record(id, key, correct) {
  const st = await drillState(id);
  const r = st[key] || { box: 1, right_count: 0, wrong_count: 0 };
  const box = correct ? Math.min(5, (r.box || 1) + 1) : 1;
  st[key] = { box, due: now() + BOX_DAYS[box] * DAY, right_count: (r.right_count || 0) + (correct ? 1 : 0),
              wrong_count: (r.wrong_count || 0) + (correct ? 0 : 1) };
  await svc.kvSet(`drill/${id}`, st);
  const days = (await svc.kvGet("practiceDays")) || {};
  days[today()] = (days[today()] || 0) + 1;
  await svc.kvSet("practiceDays", days);
  if (app.signedIn) {
    await svc.markDirty(id);
    clearTimeout(record.t);
    record.t = setTimeout(() => { if (navigator.onLine) svc.pushAll().catch(() => {}); }, 4000);
  }
  return st[key];
}

function countKeys(keys, st) {
  const t = now();
  let due = 0, fresh = 0, learned = 0;
  for (const k of keys) {
    const r = st[k];
    if (!r) fresh++; else if ((r.due || 0) <= t) due++;
    if (r && (r.box || 1) >= 4) learned++;
  }
  return { due, fresh, learned, total: keys.length };
}
async function packCounts(pack, id) {
  if (!pack) return null;
  return countKeys(pack.nodes.filter(n => n.k && n.m).map(n => n.k), await drillState(id));
}
async function practiceCounts(kind) {
  const items = app.practice.filter(p => kind === "tactics" ? p.tactic : !p.desk);
  return countKeys(items.map(p => p.id), await drillState(kind === "tactics" ? TACTICS : MISTAKES));
}

// ---- linking a chess account ------------------------------------------------------------------------------------------
function linkForm(compact = false) {
  const f = h(`<form class="${compact ? "" : "card "}stack" novalidate>
    ${compact ? "" : `<h3>Link your chess account</h3>
    <p class="small soft" style="margin:0">Plyra fetches your recent games, reviews them with Stockfish on this phone, and
    turns your mistakes into practice. No password needed: game histories are public.</p>`}
    <div class="seg" style="margin:0" role="group" aria-label="Site">
      <button type="button" data-p="chess.com" aria-pressed="true">Chess.com</button>
      <button type="button" data-p="lichess" aria-pressed="false">Lichess</button></div>
    <input class="field" name="u" placeholder="Your username" autocomplete="username" autocapitalize="none" spellcheck="false">
    <button class="btn primary block" type="submit">Get my games</button>
    <div class="err"></div></form>`);
  let platform = "chess.com";
  f.querySelector(".seg").addEventListener("click", e => {
    const b = e.target.closest("button[data-p]");
    if (!b) return;
    platform = b.dataset.p;
    f.querySelectorAll(".seg button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  });
  f.addEventListener("submit", async e => {
    e.preventDefault();
    const username = f.u.value.trim(), err = f.querySelector(".err"), btn = f.querySelector("button[type=submit]");
    if (!/^[A-Za-z0-9_-]{2,30}$/.test(username)) { err.textContent = "Enter your username on that site."; return; }
    if (app.links.some(l => l.platform === platform && l.username.toLowerCase() === username.toLowerCase())) { err.textContent = "That account is already linked."; return; }
    btn.disabled = true; err.textContent = ""; btn.textContent = "Getting your games…";
    const link = { platform, username };
    app.links.push(link);
    try {
      const n = await importGames(link, { first: true });
      if (!n) {
        app.links = app.links.filter(l => l !== link);
        await svc.kvSet("links", app.links);
        err.textContent = "No standard games found for that player in the last few months.";
        btn.disabled = false; btn.textContent = "Get my games";
        return;
      }
      toast(`${n} games found. Reviewing the newest ${Math.min(n, app.reviewTarget)} with Stockfish…`, 4000);
      await rebuildPractice();
      go("today");
      reviewLoop();
    } catch (x) {
      app.links = app.links.filter(l => l !== link);
      await svc.kvSet("links", app.links);
      err.textContent = x.message;
      btn.disabled = false; btn.textContent = "Get my games";
    }
  });
  return f;
}

// ---- Today -------------------------------------------------------------------------------------------------------------------
async function viewToday(root) {
  if (!app.links.length && !app.signedIn && !(await pz.rating()).n && !(await pz.woodpecker())) {
    root.append(h(`<div><div class="eyebrow">Plyra Chess</div><h1>Get better from your own games.</h1>
      <p class="soft">Link your account and Plyra reviews your games with Stockfish, then drills you on the mistakes you
      actually make, the tactics you missed and the openings you play.</p></div>`));
    root.append(linkForm());
    root.append(h(`<div class="card row"><span class="grow"><b>Just want to train?</b><br><span class="small soft">20 free rated puzzles a day,
      by phase, endgame type and theme. No account needed.</span></span>
      <button class="btn small primary" data-go="practice">Start</button></div>`));
    const inst = await installCard();
    if (inst) root.append(inst);
    root.append(h(`<p class="small soft">Use Plyra on your computer? <a href="#" data-go="account">Sign in</a> to bring
      your repertoires and practice here too.</p>`));
    return;
  }
  const hour = new Date().getHours();
  root.append(h(`<div><div class="eyebrow">${new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</div>
    <h1>${hour < 12 ? "Good morning." : hour < 18 ? "Good afternoon." : "Good evening."}</h1></div>`));

  const days = (await svc.kvGet("practiceDays")) || {};
  const tac = await practiceCounts("tactics"), mis = await practiceCounts("mistakes");
  let opn = 0;
  for (const p of Object.values(app.packs)) { const c = await packCounts(p, p.id); opn += c.due + Math.min(c.fresh, 10); }
  for (const b of app.books) { const c = await packCounts(await svc.kvGet(`pack/${b.id}`), b.id); if (c) opn += c.due + Math.min(c.fresh, 10); }
  const todo = n => n.due + Math.min(n.fresh, 10);
  root.append(h(`<div class="card"><h3>Today's practice</h3>
    <div class="stats">
      <button class="stat tap" data-go="practice" data-screen='{"mode":"tactics"}'><b>${todo(tac)}</b><span>tactics</span></button>
      <button class="stat tap" data-go="practice" data-screen='{"mode":"mistakes"}'><b>${todo(mis)}</b><span>mistakes</span></button>
      <button class="stat tap" data-go="openings"><b>${opn}</b><span>openings</span></button></div>
    <p class="small soft" style="margin:10px 0 0">${days[today()] || 0} answered today.</p></div>`));

  if (app.reviewing || app.importing) {
    root.append(h(`<div class="card row"><span class="spinner" aria-hidden="true"></span><span class="grow small">${esc(app.importing || app.reviewing)}.
      New mistakes appear in Practice as each game is done.</span></div>`));
  }

  const me = await pz.rating(), wp = await pz.woodpecker();
  const wc = wp && wp.cycles[wp.cycles.length - 1];
  root.append(h(`<div class="card"><div class="row"><span class="grow"><h3 style="margin:0">Puzzles</h3>
      <span class="small soft">Rating ${me.r}${me.streak ? ` · streak ${me.streak}` : ""}</span></span>
      <button class="btn small primary" data-go="practice" data-screen='{"mode":"puzzle"}'>Solve</button></div>
    ${wp && paid() ? `<div class="row" style="margin-top:10px"><span class="grow small">Woodpecker · cycle ${wp.cycles.length} · ${wc.done.length}/${wp.puzzles.length}</span>
      <button class="btn small" data-go="practice" data-screen='{"mode":"woodpecker"}'>Continue</button></div>` : ""}</div>`));
  const inst = await installCard();
  if (inst) root.append(inst);
  const last = app.games.find(g => app.reviews[g.id]);
  if (last) root.append(gameRow(last, "Your last reviewed game"));
  if (!app.links.length) {
    root.append(h(`<div class="card"><h3>Link your Chess.com or Lichess account</h3>
      <p class="small soft">Get your own games reviewed on this phone and practise your mistakes.</p>
      <button class="btn block" data-go="account">Link an account</button></div>`));
  }
}

function gameRow(g, title = "") {
  const r = app.reviews[g.id];
  const opp = g.color === "white" ? g.black : g.white;
  const n = r ? r.moves.filter(m => m.kind !== "inaccuracy").length : null;
  const el = h(`<button class="card list-item game" style="padding:14px 16px">
    <span class="res ${g.result}" aria-label="${g.result}">${g.result === "win" ? "W" : g.result === "draw" ? "D" : "L"}</span>
    <span class="grow">${title ? `<span class="small soft">${esc(title)}</span><br>` : ""}<b>vs ${esc(opp)}</b>${g.oppRating ? ` <span class="small soft">(${g.oppRating})</span>` : ""}<br>
      <span class="small soft">${esc(g.opening || "")}${g.opening ? " · " : ""}${cap(g.speed || "")} · ${dateOf(g.t)}</span></span>
    <span class="small" style="text-align:right;white-space:nowrap">${r ? `<b class="mono">${r.accuracy ?? "–"}%</b><br><span class="soft">${n ? `${n} mistake${n === 1 ? "" : "s"}` : "clean"}</span>` : `<span class="soft">not reviewed</span>`}</span></button>`);
  el.addEventListener("click", () => go("progress", { game: g.id }));
  return el;
}

// ---- Openings -------------------------------------------------------------------------------------------------------------------
async function viewOpenings(root) {
  if (app.screen?.pack) return drillScreen(root, app.screen.pack);
  root.append(h(`<div><div class="eyebrow">Openings</div><h1>Your openings</h1></div>`));

  // from your games
  const mine = h(`<div class="card"><h3>From your games</h3>
    <p class="small soft" style="margin:0 0 4px">The openings you actually play, move by move. Where your usual move
    loses ground, Stockfish's move replaces it, so drilling fixes the habit. Replies are the ones your opponents played.</p></div>`);
  root.append(mine);
  const packs = Object.values(app.packs);
  if (!packs.length) {
    mine.append(h(`<p class="small soft" style="margin:8px 0 0">${app.links.length ? "Ready once a few games of each colour are reviewed." : "Link your Chess.com or Lichess account to build these."}</p>`));
    if (!app.links.length) mine.append(h(`<button class="btn block" data-go="account" style="margin-top:8px">Link an account</button>`));
  }
  for (const p of packs) {
    const c = await packCounts(p, p.id);
    const row = h(`<button class="list-item">
      <span class="dot ${p.color}" aria-hidden="true"></span>
      <span class="grow"><b>${esc(p.label)}</b><br><span class="small soft">${p.positions} positions from ${p.games} games${p.fixes.length ? ` · ${p.fixes.length} fixed by Stockfish` : ""}</span></span>
      ${c.due ? `<span class="pill due">${c.due} due</span>` : c.fresh ? `<span class="pill">${c.fresh} new</span>` : ""}
      <span class="chev" aria-hidden="true">›</span></button>`);
    row.addEventListener("click", () => go("openings", { pack: p.id }));
    mine.append(row);
  }

  // opening mistakes
  const om = app.practice.filter(p => p.phase === "opening" && !p.desk);
  if (om.length) {
    root.append(h(`<div class="card row"><span class="grow"><h3 style="margin:0">Opening mistakes</h3>
      <span class="small soft">${om.length} positions in the first 12 moves where you went wrong</span></span>
      <button class="btn small" data-go="practice" data-screen='{"mode":"mistakes","phase":"opening"}'>Practise</button></div>`));
  }

  // your opening results
  const fam = {};
  for (const g of app.games) {
    if (!g.family) continue;
    const k = g.color + "|" + g.family;
    const o = fam[k] ||= { color: g.color, name: g.family, n: 0, pts: 0 };
    o.n++; o.pts += g.result === "win" ? 1 : g.result === "draw" ? .5 : 0;
  }
  const rows = Object.values(fam).filter(o => o.n >= 2).sort((a, b) => b.n - a.n).slice(0, 10);
  if (rows.length) {
    root.append(h(`<div class="card"><h3>How your openings score</h3>${rows.map(o => {
      const pct = Math.round(100 * o.pts / o.n);
      return `<div style="margin:10px 0"><div class="row small"><span class="dot ${o.color}" aria-hidden="true"></span><span class="grow">${esc(o.name)}</span><span class="mono">${pct}% · ${o.n} games</span></div>
        <div class="progressbar"><i style="width:${pct}%"></i></div></div>`;
    }).join("")}</div>`));
  }

  // built in Plyra on your computer
  const built = h(`<div class="card"><h3>Repertoires from Plyra</h3></div>`);
  root.append(built);
  if (!app.signedIn) {
    built.append(h(`<p class="small soft" style="margin:0">Build complete, Stockfish-checked repertoires in Plyra on your
      computer; <a href="#" data-go="account">sign in</a> and they appear here to drill.</p>`));
  } else if (app.syncOff) {
    built.append(syncOffCard(true));
  } else if (!app.books.length) {
    built.append(h(`<p class="small soft" style="margin:0">None yet. Build one in Plyra on your computer (Theory → Build a book).</p>`));
  } else {
    const allowed = plan() === "free" ? 1 : plan() === "pro" ? 3 : Infinity;
    for (const [i, b] of app.books.entries()) {
      const c = await packCounts(await svc.kvGet(`pack/${b.id}`), b.id);
      const row = h(`<button class="list-item">
        <span class="dot ${b.color === "black" ? "black" : "white"}" aria-hidden="true"></span>
        <span class="grow"><b>${esc(shortLabel(b.label))}</b><br>
          <span class="small soft">${c ? `${c.learned} of ${c.total} learned` : "Not downloaded yet: sync"}</span></span>
        ${c && c.due ? `<span class="pill due">${c.due} due</span>` : c && c.fresh ? `<span class="pill">${c.fresh} new</span>` : ""}
        <span class="chev" aria-hidden="true">›</span></button>`);
      if (i >= allowed) {
        row.classList.add("locked");
        row.querySelector(".small").textContent = plan() === "free" ? "Locked: Ply Pro drills up to 3 repertoires" : "Locked: Ply Max drills every repertoire";
        row.addEventListener("click", () => go("account", { screen: "plans" }));
      } else row.addEventListener("click", () => go("openings", { pack: b.id }));
      built.append(row);
    }
  }
}

// one drill line through a pack, preferring replies that lead to due (or new) positions
function nextLine(pack, st) {
  const t = now();
  const due = i => { const r = st[pack.nodes[i].k]; return !r || (r.due || 0) <= t; };
  const line = [];
  let i = 0;
  for (let guard = 0; guard < 120; guard++) {
    const n = pack.nodes[i];
    if (!n) break;
    if (n.m) { line.push({ node: i, uci: n.m[0], san: n.m[1], mine: true }); i = n.m[2]; continue; }
    if (!n.r || !n.r.length) break;
    const w = n.r.map(r => r[2] * (due(r[3]) ? 3 : 1));
    const total = w.reduce((a, b) => a + b, 0);
    let x = Math.random() * total, pick = n.r[n.r.length - 1];
    for (let j = 0; j < n.r.length; j++) { x -= w[j]; if (x <= 0) { pick = n.r[j]; break; } }
    line.push({ node: i, uci: pick[0], san: pick[1], mine: false });
    i = pick[3];
  }
  return line.some(s => s.mine) ? line : null;
}

async function drillScreen(root, packId) {
  const pack = app.packs[packId] || await svc.kvGet(`pack/${packId}`);
  const label = pack ? (pack.kind === "games" ? pack.label : shortLabel(app.books.find(b => b.id === packId)?.label || pack.label)) : "";
  if (!pack) {
    root.append(h(`<div class="card"><p>This repertoire isn't on the phone yet. Sync, then try again.</p>
      <button class="btn" data-go="openings">Back</button></div>`));
    return;
  }
  const el = h(`<div>
    <button class="back" data-go="openings" style="min-height:36px;padding:0">‹ Openings</button>
    <div class="puzzle-head"><b>${esc(label)}</b><span class="small soft">you play ${pack.color}</span><span class="pill" id="score" style="margin-left:auto"></span></div>
    <div class="board-wrap"><div id="board"></div></div>
    <div class="moves" id="moves"></div>
    <div class="msg info" id="msg">Your move.</div>
    <div class="btn-row" style="margin-top:12px">
      <button class="btn" id="hint">Show the move</button>
      <button class="btn primary" id="next" hidden>Next line</button>
    </div></div>`);
  root.append(el);
  const $ = s => el.querySelector(s);
  const $msg = $("#msg"), $moves = $("#moves"), $next = $("#next"), $hint = $("#hint"), $score = $("#score");
  let fen, line, step, missed, right, wrong, sans, timers = [];
  const later = (fn, ms) => timers.push(setTimeout(fn, ms));
  app.cleanup = () => timers.forEach(clearTimeout);

  const board = new Board($("#board"), { onMove: uci => answer(uci) });
  const say = (cls, text) => { $msg.className = "msg " + cls; $msg.textContent = text; };
  const drawMoves = () => {
    const parts = sans.map((x, k) => (k % 2 === 0 ? `${k / 2 + 1}. ` : "") + x);
    $moves.textContent = (parts.length > 12 ? "… " : "") + parts.slice(-12).join(" ");
  };
  const scoreText = () => { $score.textContent = `${right} right · ${wrong} missed`; };

  async function newLine() {
    line = nextLine(pack, await drillState(packId));
    fen = startFen();
    sans = [];
    for (const u of pack.start || []) { const r = playUci(fen, u); if (!r) break; [fen] = r; sans.push(r[1]); }
    step = 0; right = 0; wrong = 0;
    $next.hidden = true; $hint.hidden = false; $score.textContent = "";
    board.set({ fen, orientation: pack.color, interactive: false, animate: false });
    drawMoves();
    if (!line) { say("info", "Nothing to drill here yet."); $hint.hidden = true; return; }
    advance();
  }
  function advance() {
    if (step >= line.length) return finish();
    const s = line[step];
    if (!s.mine) {
      say("info", "…");
      later(() => {
        const r = playUci(fen, s.uci);
        if (!r) return finish();
        [fen] = r; sans.push(r[1]); step++;
        board.set({ fen, last: [s.uci.slice(0, 2), s.uci.slice(2, 4)], interactive: false });
        drawMoves();
        later(advance, 220);
      }, step === 0 ? 350 : 420);
      return;
    }
    missed = false;
    say("info", "Your move.");
    board.set({ fen, interactive: true, animate: false, last: board.last });
  }
  async function answer(uci) {
    const s = line[step], node = pack.nodes[s.node];
    if (uci.slice(0, 4) === s.uci.slice(0, 4) && (uci.length === 4 || uci === s.uci)) {
      if (!missed) { right++; await record(packId, node.k, true); }
      const r = playUci(fen, s.uci);
      [fen] = r; sans.push(r[1]); step++;
      drawMoves();
      say("good", (missed ? `${s.san}. Got it.` : `Right: ${s.san}.`) + (node.was ? ` (Your old ${node.was} lost ground here.)` : ""));
      scoreText();
      later(advance, node.was ? 1400 : 450);
      return;
    }
    if (!missed) { missed = true; wrong++; await record(packId, node.k, false); }
    shake($("#board"));
    const played = playUci(fen, uci);
    const ps = played ? played[1] : "That";
    say("bad", node.was && ps === node.was
      ? `${ps} is your usual move, but it loses ground here. Play ${s.san}.`
      : `${ps} isn't it. Your move here is ${s.san}: play it.`);
    scoreText();
    later(() => { board.set({ fen, interactive: true, animate: false, last: board.last }); hintSquare(s.uci.slice(0, 2)); }, 350);
  }
  function hintSquare(sq, end = "from") {
    el.querySelector(`.sq[data-sq="${sq}"]`)?.classList.add("hint", end);
  }
  $hint.addEventListener("click", async () => {
    const s = line && line[step];
    if (!s || !s.mine) return;
    if (!missed) { missed = true; wrong++; await record(packId, pack.nodes[s.node].k, false); }
    say("info", `The move is ${s.san}. Play it to go on.`);
    scoreText();
    hintSquare(s.uci.slice(0, 2));
    hintSquare(s.uci.slice(2, 4), "to");
  });
  function finish() {
    board.set({ fen, interactive: false, animate: false, last: board.last });
    $hint.hidden = true; $next.hidden = false;
    const n = right + wrong;
    say(wrong ? "info" : "good", n ? `End of the line: ${right} of ${n} right.${wrong ? " The missed moves come back today." : ""}` : "End of the line.");
  }
  $next.addEventListener("click", newLine);
  app.onRendered = newLine;
}

// ---- Practice: tactics and mistakes ------------------------------------------------------------------------------------------------
function nextItem(items, st, skip) {
  const t = now();
  const due = items.filter(i => i.id !== skip && st[i.id] && (st[i.id].due || 0) <= t).sort((a, b) => st[a.id].due - st[b.id].due);
  if (due.length) return due[0];
  return items.find(i => i.id !== skip && !st[i.id]) || null;
}

async function gamePractice(root) {
  const mode = app.screen?.mode || "tactics";
  const phase = app.screen?.phase || "all";
  const all = app.practice.filter(p => mode === "tactics" ? p.tactic : !p.desk);
  const items = phase === "all" ? all : all.filter(p => p.phase === phase);
  const stateId = mode === "tactics" ? TACTICS : MISTAKES;
  const head = h(`<div>
    <button class="back" data-go="practice" style="min-height:36px;padding:0">‹ Practice</button>
    <div class="seg tight" role="tablist">
      <button data-m="tactics" aria-pressed="${mode === "tactics"}">Tactics</button>
      <button data-m="mistakes" aria-pressed="${mode === "mistakes"}">Mistakes</button></div>
    ${mode === "mistakes" ? `<div class="seg small-seg">${["all", "opening", "middlegame", "endgame"].map(p => `<button data-ph="${p}" aria-pressed="${p === phase}">${cap(p)}</button>`).join("")}</div>` : ""}
    </div>`);
  head.addEventListener("click", e => {
    const m = e.target.closest("button[data-m]"), p = e.target.closest("button[data-ph]");
    if (m) go("practice", { mode: m.dataset.m });
    if (p) go("practice", { mode, phase: p.dataset.ph });
  });
  root.append(head);
  if (!all.length) {
    root.append(h(`<div class="card empty"><div class="glyph">${mode === "tactics" ? "♞" : "♟"}</div>
      <h2>${mode === "tactics" ? "No tactics yet" : "No mistakes yet"}</h2>
      <p class="soft">${app.reviewing ? "Your games are being reviewed now; positions appear here as each game is done."
        : app.links.length ? "None found in your reviewed games so far. Review more games in the Games tab."
        : "They come from your own games. Link your Chess.com or Lichess account and Plyra reviews them on this phone."}</p>
      ${app.links.length ? "" : `<button class="btn primary block" data-go="account">Link an account</button>`}</div>`));
    return;
  }
  const st = await drillState(stateId);
  const c = countKeys(items.map(i => i.id), st);
  const el = h(`<div>
    <div id="p-head" class="puzzle-head"></div>
    <div class="board-wrap"><div id="board"></div></div>
    <div class="msg info" id="msg"></div>
    <div class="btn-row" style="margin-top:12px">
      <button class="btn" id="show">Show the move</button>
      <button class="btn primary" id="next" hidden>Next position</button>
    </div>
    <p class="small soft" id="from" style="margin-top:10px"></p></div>`);
  root.append(el);
  const $ = s => el.querySelector(s);
  const $msg = $("#msg"), $head = $("#p-head"), $show = $("#show"), $next = $("#next"), $from = $("#from");
  const say = (cls, html) => { $msg.className = "msg " + cls; $msg.innerHTML = html; };
  let cur = null, answered = false;
  const board = new Board($("#board"), { onMove: uci => judge(uci) });
  const limited = mode === "tactics" && plan() === "free";
  const countToday = async () => { if (limited) await allowance("tactic", true); };

  async function load(skip = null) {
    answered = false;
    $next.hidden = true; $show.hidden = false; $from.innerHTML = "";
    if (limited && !(await allowance("tactic")).allowed) {
      $head.innerHTML = "";
      board.set({ fen: startFen(), interactive: false, animate: false });
      say("info", `That's today's ${FREE_TACTICS_PER_DAY} missed tactics on the Free plan; more tomorrow. Your mistakes and all puzzles have no daily limit.`);
      $show.hidden = true;
      el.append(upgradeNote("Ply Pro has unlimited missed-tactics drills."));
      return;
    }
    cur = nextItem(items, await drillState(stateId), skip);
    if (!cur) {
      const s2 = await drillState(stateId);
      const soon = Math.min(...items.map(i => s2[i.id]?.due || Infinity));
      $head.innerHTML = "";
      board.set({ fen: startFen(), interactive: false, animate: false });
      say("good", `All caught up.${isFinite(soon) ? ` The next position is due in ${until(soon)}.` : ""}`);
      $show.hidden = true;
      return;
    }
    const title = cur.desk ? cur.label : cur.missedWin ? "Missed win" : cur.tactic ? "Missed tactic" : cap(cur.kind);
    $head.innerHTML = `<b>${esc(title)}</b><span class="small soft">move ${esc(cur.move)}${cur.opp ? ` vs ${esc(cur.opp)}` : ""}${cur.t ? `, ${dateOf(cur.t)}` : cur.date ? `, ${esc(cur.date)}` : ""} · <span class="mono">${c.due} due · ${c.fresh} new</span></span>`;
    board.set({ fen: cur.fen, orientation: cur.color, interactive: true, animate: false });
    say("info", cur.tactic ? "Find the best move." : `You played ${esc(cur.playedSan)} here. Find the better move.`);
  }

  async function judge(uci) {
    if (answered) return;
    answered = true;
    const after = playUci(cur.fen, uci);
    let ok = uci.slice(0, 4) === cur.best.slice(0, 4) && (uci.length === 4 || uci === cur.best) || (after && after[1].endsWith("#"));
    let alsoGood = false;
    if (!ok && after && cur.winBefore != null && cur.played !== uci) {
      say("info", "Checking your move…");
      try {
        const e = await analyse(after[0], { depth: 12 });
        const w = e.mate === 0 ? 100 : 100 - winPct(e.cp, e.mate);
        if (cur.winBefore - w <= 5) { ok = true; alsoGood = true; }
      } catch { /* judge by the stored move */ }
    }
    const rec = await record(stateId, cur.id, ok);
    await countToday();
    const lineTxt = (cur.line || []).length ? `<br><span class="small">Line: ${esc(cur.line.join(" "))}</span>` : "";
    if (ok) {
      say("good", (alsoGood ? `${esc(after[1])} works too (Stockfish's choice was ${esc(cur.bestSan)}).` : `Right: ${esc(after[1])}.`)
        + ` ${rec.box > 1 ? `Comes back in ${BOX_DAYS[rec.box]} day${BOX_DAYS[rec.box] === 1 ? "" : "s"}.` : ""}${lineTxt}`);
    } else {
      shake($("#board"));
      say("bad", `${esc(after ? after[1] : "That")} isn't it. The move is <b>${esc(cur.bestSan)}</b>.${lineTxt}`);
      setTimeout(() => {
        board.set({ fen: cur.fen, interactive: false, animate: false });
        const r = playUci(cur.fen, cur.best);
        if (r) board.set({ fen: r[0], last: [cur.best.slice(0, 2), cur.best.slice(2, 4)], interactive: false });
      }, 700);
    }
    showFrom();
    $show.hidden = true; $next.hidden = false;
  }
  function showFrom() {
    if (!cur.gameId) return;
    $from.innerHTML = `In the game you played ${esc(cur.playedSan)} (lost ${cur.loss}% winning chances). <a href="#" id="see">See the game</a>`;
    $from.querySelector("#see").addEventListener("click", e => { e.preventDefault(); go("progress", { game: cur.gameId, ply: cur.move * 2 - (cur.color === "white" ? 1 : 0) }); });
  }
  $show.addEventListener("click", async () => {
    if (!cur || answered) return;
    answered = true;
    await record(stateId, cur.id, false);
    await countToday();
    const r = playUci(cur.fen, cur.best);
    if (r) board.set({ fen: r[0], last: [cur.best.slice(0, 2), cur.best.slice(2, 4)], interactive: false });
    say("info", `The move is <b>${esc(cur.bestSan)}</b>. It comes back later today.${(cur.line || []).length ? `<br><span class="small">Line: ${esc(cur.line.join(" "))}</span>` : ""}`);
    showFrom();
    $show.hidden = true; $next.hidden = false;
  });
  $next.addEventListener("click", () => load(cur?.id));
  app.onRendered = () => load();
}

// ---- Practice: the training dashboard (free for everyone, no account needed) ------------------------------------------------
async function viewPractice(root) {
  const m = app.screen?.mode;
  if (m === "tactics" || m === "mistakes") return gamePractice(root);
  if (m === "puzzle") return puzzleScreen(root, app.screen.theme || null);
  if (m === "woodpecker") return woodpeckerScreen(root);
  const me = await pz.rating();
  root.append(h(`<div><div class="eyebrow">Practice</div><h1>Train</h1></div>`));

  const rated = h(`<div class="card"><div class="row"><div class="grow"><h3 style="margin:0">Puzzles</h3>
      <span class="small soft">Rated to your level · 34,000 puzzles from Lichess${paid() ? "" : ` · ${await puzzlesLeft()} of ${FREE_PUZZLES_PER_DAY} left today`}</span></div>
      <div style="text-align:right"><b class="mono" style="font-size:1.4rem">${me.r}</b><br><span class="small soft">${me.n ? `${me.n} solved · best ${me.best}` : "your rating"}</span></div></div>
    <button class="btn primary block" style="margin-top:12px" data-go="practice" data-screen='{"mode":"puzzle"}'>Solve puzzles</button></div>`);
  root.append(rated);

  const chip = t => `<button class="chip" data-go="practice" data-screen='${JSON.stringify({ mode: "puzzle", theme: t })}'>${esc(pz.THEME_NAMES[t] || t)}</button>`;
  root.append(h(`<div class="card"><h3>Train by phase</h3>
    <div class="phase-row">
      <button class="phase" data-go="practice" data-screen='{"mode":"puzzle","theme":"opening"}'><b>Opening</b><span>early traps and tactics</span></button>
      <button class="phase" data-go="practice" data-screen='{"mode":"puzzle","theme":"middlegame"}'><b>Middlegame</b><span>attack and combinations</span></button>
      <button class="phase" data-go="practice" data-screen='{"mode":"puzzle","theme":"endgame"}'><b>Endgame</b><span>technique and calculation</span></button></div>
    <p class="small soft" style="margin:12px 0 6px">Endgames by type</p>
    <div class="chips">${pz.ENDGAMES.map(chip).join("")}</div></div>`));

  const wp = await pz.woodpecker();
  const wpCard = h(`<div class="card"><h3>The Woodpecker Method</h3>
    <p class="small soft" style="margin:0 0 10px">Solve one fixed set of puzzles, then solve the same set again and again, each
    cycle in about half the time. The patterns become automatic, which is what wins games on the clock.</p></div>`);
  if (!paid()) {
    wpCard.querySelector("h3").insertAdjacentHTML("beforeend", ` <span class="pill">Ply Pro</span>`);
    wpCard.append(upgradeNote("The Woodpecker Method comes with Ply Pro, along with unlimited puzzles."));
  } else if (wp) {
    const cyc = wp.cycles[wp.cycles.length - 1];
    const pct = Math.round(100 * cyc.done.length / wp.puzzles.length);
    const target = pz.cycleTarget(wp);
    wpCard.append(h(`<div><div class="row small"><span class="grow"><b>${esc(wp.label)}</b> · cycle ${wp.cycles.length}</span>
      <span class="mono">${cyc.done.length}/${wp.puzzles.length}</span></div>
      <div class="progressbar" style="margin:6px 0 4px"><i style="width:${pct}%"></i></div>
      <p class="small soft" style="margin:0 0 10px">${fmtTime(cyc.ms)} so far${target ? ` · target ${fmtTime(target)}` : ""}</p>
      <button class="btn primary block" data-go="practice" data-screen='{"mode":"woodpecker"}'>${cyc.done.length ? "Continue" : "Start"} cycle ${wp.cycles.length}</button></div>`));
  } else {
    wpCard.append(newWoodpeckerForm());
  }
  root.append(wpCard);

  root.append(h(`<div class="card"><h3>Themes</h3>
    <p class="small soft" style="margin:0 0 6px">Tactical motifs</p><div class="chips">${pz.MOTIFS.map(chip).join("")}</div>
    <p class="small soft" style="margin:12px 0 6px">Checkmates</p><div class="chips">${pz.MATES.map(chip).join("")}</div>
    <p class="small soft" style="margin:12px 0 6px">Results</p><div class="chips">${["crushing", "advantage", "equality"].map(chip).join("")}</div></div>`));

  // from your own games
  const tac = await practiceCounts("tactics"), mis = await practiceCounts("mistakes");
  const own = h(`<div class="card"><h3>From your games</h3></div>`);
  if (!app.links.length && !app.signedIn) {
    own.append(h(`<p class="small soft" style="margin:0 0 10px">Link your Chess.com or Lichess account and Plyra reviews your
      games on this phone, then drills the tactics you missed and the mistakes you made.</p>`));
    own.append(h(`<button class="btn block" data-go="account">Link an account</button>`));
  } else {
    own.append(h(`<div class="btn-row">
      <button class="btn" data-go="practice" data-screen='{"mode":"tactics"}'>Missed tactics${tac.due + tac.fresh ? ` · ${tac.due + tac.fresh}` : ""}</button>
      <button class="btn" data-go="practice" data-screen='{"mode":"mistakes"}'>Mistakes${mis.due + mis.fresh ? ` · ${mis.due + mis.fresh}` : ""}</button></div>`));
  }
  root.append(own);
  root.append(h(`<p class="small soft">Puzzles from the <a href="https://database.lichess.org/#puzzles" target="_blank" rel="noopener">Lichess puzzle database</a> (CC0). Thank you, Lichess.</p>`));
}

function fmtTime(ms) {
  const s = Math.round((ms || 0) / 1000);
  const hh = Math.floor(s / 3600), mm = Math.floor(s % 3600 / 60), ss = s % 60;
  return hh ? `${hh} h ${mm} min` : mm ? `${mm} min ${ss ? ss + " s" : ""}`.trim() : `${ss} s`;
}

function newWoodpeckerForm() {
  const f = h(`<form class="stack">
    <div><span class="small soft">Level</span><div class="seg" style="margin:4px 0 0" data-k="level">
      ${pz.WOODPECKER_LEVELS.map((l, i) => `<button type="button" data-v="${l.id}" aria-pressed="${i === 1}">${l.label}<br><span class="small soft">${l.min}–${l.max}</span></button>`).join("")}</div></div>
    <div><span class="small soft">Set size</span><div class="seg" style="margin:4px 0 0" data-k="size">
      ${[100, 300, 500, 1000].map((n, i) => `<button type="button" data-v="${n}" aria-pressed="${i === 1}">${n}</button>`).join("")}</div></div>
    <button class="btn primary block" type="submit">Create my set</button></form>`);
  const val = { level: "intermediate", size: "300" };
  f.querySelectorAll(".seg").forEach(seg => seg.addEventListener("click", e => {
    const b = e.target.closest("button[data-v]");
    if (!b) return;
    val[seg.dataset.k] = b.dataset.v;
    seg.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  }));
  f.addEventListener("submit", async e => {
    e.preventDefault();
    const btn = f.querySelector("button[type=submit]");
    btn.disabled = true; btn.textContent = "Choosing puzzles…";
    try { await pz.newWoodpecker(val.level, +val.size); go("practice", { mode: "woodpecker" }); }
    catch (x) { toast(x.message); btn.disabled = false; btn.textContent = "Create my set"; }
  });
  return f;
}

// plays one puzzle on a board: the opponent's first move, then yours, until the line ends or you go wrong
function puzzlePlayer(el, { onFinish }) {
  const $ = s => el.querySelector(s);
  const board = new Board($("#board"), { onMove: uci => answer(uci) });
  let p = null, fen, i, failed, done, timers = [], t0 = 0;
  const later = (fn, ms) => timers.push(setTimeout(fn, ms));
  const say = (cls, html) => { const m = $("#msg"); m.className = "msg " + cls; m.innerHTML = html; };
  const side = () => (p.fen.split(" ")[1] === "w" ? "black" : "white");  // you play the side NOT to move in the given FEN
  function load(puzzle) {
    timers.forEach(clearTimeout); timers = [];
    p = puzzle; fen = p.fen; i = 0; failed = false; done = false;
    board.set({ fen, orientation: side(), interactive: false, animate: false });
    say("info", `${side() === "white" ? "White" : "Black"} to move. Find the best move.`);
    later(() => opp(), 450);
  }
  function opp() {
    const u = p.moves[i];
    const r = playUci(fen, u);
    if (!r) return;
    fen = r[0]; i++;
    board.set({ fen, last: [u.slice(0, 2), u.slice(2, 4)], interactive: i < p.moves.length });
    if (i === 1) t0 = performance.now();
  }
  async function answer(uci) {
    const want = p.moves[i];
    const r = playUci(fen, uci);
    const last = i === p.moves.length - 1;
    const ok = uci.slice(0, 4) === want.slice(0, 4) && (uci.length === 4 || uci === want) || (last && r && r[1].endsWith("#"));
    if (ok) {
      fen = r[0]; i++;
      if (i >= p.moves.length) return finish(true);
      say("good", "Good. Keep going…");
      later(() => opp(), 300);
      return;
    }
    failed = true;
    shake($("#board"));
    say("bad", `${r ? esc(r[1]) : "That"} isn't it. Try again, or show the solution.`);
    later(() => board.set({ fen, interactive: true, animate: false, last: board.last }), 400);
    if (!p.reported) { p.reported = true; onFinish?.(p, false, performance.now() - t0, { firstMiss: true }); }
  }
  function finish(solved) {
    done = true;
    board.set({ fen, interactive: false, animate: false, last: board.last });
    onFinish?.(p, solved && !failed, performance.now() - t0, { complete: true });
  }
  function solution() {
    if (done) return;
    failed = true;
    board.set({ fen, interactive: false, animate: false, last: board.last });
    const step = () => {
      if (i >= p.moves.length) { finish(false); return; }
      const u = p.moves[i];
      const r = playUci(fen, u);
      if (!r) return;
      fen = r[0]; i++;
      board.set({ fen, last: [u.slice(0, 2), u.slice(2, 4)], interactive: false });
      later(step, 650);
    };
    step();
  }
  return { load, solution, say, stop: () => timers.forEach(clearTimeout), get puzzle() { return p; } };
}

function puzzleLayout(title) {
  return h(`<div>
    <button class="back" data-go="practice" style="min-height:36px;padding:0">‹ Practice</button>
    <div class="puzzle-head"><b>${esc(title)}</b><span class="small soft" id="sub"></span><span class="pill" id="rt" style="margin-left:auto"></span></div>
    <div class="board-wrap"><div id="board"></div></div>
    <div class="msg info" id="msg"></div>
    <div class="btn-row" style="margin-top:12px">
      <button class="btn" id="sol">Show solution</button>
      <button class="btn primary" id="next" hidden>Next puzzle</button></div>
    <div class="chips" id="tags" style="margin-top:10px"></div></div>`);
}

async function puzzleScreen(root, theme) {
  const el = puzzleLayout(theme ? pz.THEME_NAMES[theme] || theme : "Puzzles");
  root.append(el);
  const $ = s => el.querySelector(s);
  let me = await pz.rating();
  $("#rt").textContent = me.r;
  const player = puzzlePlayer(el, { onFinish: async (p, solved, ms, info) => {
    if (info.firstMiss) {  // rated on the first try, like Lichess
      const r = await pz.rate(p.rating, false); $("#rt").textContent = `${r.r} (${r.delta})`;
      return;
    }
    if (!p.reported) { const r = await pz.rate(p.rating, solved); $("#rt").textContent = `${r.r} (${r.delta >= 0 ? "+" : ""}${r.delta})`; p.reported = true; }
    await pz.markSeen(p.id);
    const days = (await svc.kvGet("practiceDays")) || {};
    days[today()] = (days[today()] || 0) + 1;
    await svc.kvSet("practiceDays", days);
    player.say(solved ? "good" : "info", solved ? `Solved! This puzzle is rated ${p.rating}.` : `That was the solution. This puzzle is rated ${p.rating}.`);
    $("#sol").hidden = true; $("#next").hidden = false;
    $("#tags").innerHTML = p.themes.filter(t => pz.THEME_NAMES[t]).map(t => `<span class="chip static">${esc(pz.THEME_NAMES[t])}</span>`).join("")
      + `<a class="chip static" href="https://lichess.org/training/${encodeURIComponent(p.id)}" target="_blank" rel="noopener">On Lichess ↗</a>`;
  } });
  async function next() {
    $("#sol").hidden = false; $("#next").hidden = true; $("#tags").innerHTML = "";
    me = await pz.rating();
    $("#rt").textContent = me.r;
    $("#sub").textContent = "";
    const al = await allowance("puzzle", true);
    if (!al.allowed) {
      $("#sol").hidden = true;
      player.say("info", `That's today's ${FREE_PUZZLES_PER_DAY} free puzzles; more tomorrow. Your own mistakes from your games have no daily limit.`);
      if (!el.querySelector(".upsell")) el.append(upgradeNote("Ply Pro: unlimited puzzles and the Woodpecker Method."));
      return;
    }
    player.say("info", "Loading…");
    try {
      const p = await pz.pick({ rating: me.r, theme });
      if (!p) { player.say("info", "You've seen every puzzle near your rating here. Starting the list over."); return later(next, 1200); }
      player.load(p);
    } catch (e) { player.say("bad", esc(e.message)); }
  }
  const later = (fn, ms) => setTimeout(fn, ms);
  $("#sol").addEventListener("click", () => player.solution());
  $("#next").addEventListener("click", next);
  app.cleanup = () => player.stop();
  app.onRendered = next;
}

async function woodpeckerScreen(root) {
  if (!paid()) return go("account", { screen: "plans" });
  const set = await pz.woodpecker();
  if (!set) return go("practice");
  const el = puzzleLayout("Woodpecker");
  root.append(el);
  const $ = s => el.querySelector(s);
  const cyc = () => set.cycles[set.cycles.length - 1];
  const target = pz.cycleTarget(set);
  const status = () => {
    const c = cyc();
    $("#sub").textContent = `cycle ${set.cycles.length} · ${c.done.length}/${set.puzzles.length}`;
    $("#rt").textContent = fmtTime(c.ms) + (target ? ` / ${fmtTime(target)}` : "");
  };
  let current = -1;
  const player = puzzlePlayer(el, { onFinish: async (p, solved, ms, info) => {
    if (info.firstMiss) return;
    const c = cyc();
    if (!c.done.includes(current)) { c.done.push(current); c.ms += Math.min(ms, 15 * 60 * 1000); if (solved) c.right++; }
    if (!c.start) c.start = Date.now();
    await pz.saveWoodpecker(set);
    const days = (await svc.kvGet("practiceDays")) || {};
    days[today()] = (days[today()] || 0) + 1;
    await svc.kvSet("practiceDays", days);
    status();
    player.say(solved ? "good" : "info", solved ? "Solved." : "That was the solution; it comes round again next cycle.");
    $("#sol").hidden = true; $("#next").hidden = false;
  } });
  function next() {
    $("#sol").hidden = false; $("#next").hidden = true;
    const c = cyc();
    current = set.puzzles.findIndex((_, k) => !c.done.includes(k));
    if (current < 0) return cycleDone();
    status();
    player.load(pz.parse(set.puzzles[current]));
  }
  function cycleDone() {
    const c = cyc();
    const acc = Math.round(100 * c.right / set.puzzles.length);
    $("#sol").hidden = true; $("#next").hidden = true;
    const box = h(`<div class="card" style="margin-top:12px"><h3>Cycle ${set.cycles.length} done</h3>
      <p class="small">${fmtTime(c.ms)} · ${acc}% solved first time${target ? ` · target was ${fmtTime(target)}` : ""}</p>
      <p class="small soft">The method: rest a day or two, then solve the same set again in about half the time
      (${fmtTime(Math.round(c.ms / 2))}). Most players stop after six or seven cycles, once a cycle takes a day or less.</p>
      <div class="btn-row"><button class="btn primary" id="again">Start cycle ${set.cycles.length + 1}</button>
      <button class="btn" id="newset">New set</button></div></div>`);
    el.append(box);
    player.say("good", `Cycle ${set.cycles.length} complete.`);
    box.querySelector("#again").onclick = async () => {
      set.cycles.push({ start: null, ms: 0, done: [], right: 0 });
      await pz.saveWoodpecker(set);
      go("practice", { mode: "woodpecker" });
    };
    box.querySelector("#newset").onclick = async () => { await svc.kvDel("wp/set"); go("practice"); };
  }
  $("#sol").addEventListener("click", () => player.solution());
  $("#next").addEventListener("click", next);
  const end = h(`<button class="btn small" style="margin-top:14px">Abandon this set</button>`);
  end.onclick = async () => { if (end.dataset.sure) { await svc.kvDel("wp/set"); go("practice"); } else { end.dataset.sure = 1; end.textContent = "Tap again to abandon the set"; } };
  el.append(end);
  app.cleanup = () => player.stop();
  app.onRendered = next;
}

// ---- Games: progress, your games, one game's review -------------------------------------------------------------------------------------
async function viewGames(root) {
  if (app.screen?.game) return gameScreen(root, app.screen.game, app.screen.ply);
  root.append(h(`<div><div class="eyebrow">Games</div><h1>How you're doing</h1></div>`));
  const desk = app.signedIn ? await svc.kvGet("progress/main") : null;
  // rating and results: your phone-imported games, else what Plyra on your computer sent
  const gs = app.games.length ? app.games.map(g => ({ t: g.t, rating: g.rating, result: g.result, speed: g.speed,
    acc: app.reviews[g.id]?.accuracy ?? null })) : (desk?.games || []).filter(g => g.t);
  if (!gs.length) {
    root.append(h(`<div class="card empty"><div class="glyph">♟</div><p class="soft">No games yet. Link your Chess.com or
      Lichess account and your rating, accuracy and results appear here.</p>
      <button class="btn primary block" data-go="account">Link an account</button></div>`));
  } else {
    const counts = {};
    gs.forEach(g => counts[g.speed] = (counts[g.speed] || 0) + 1);
    const speeds = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    let speed = app.progressSpeed && counts[app.progressSpeed] ? app.progressSpeed : speeds[0];
    const card = h(`<div class="card"><div class="seg" id="seg"></div><h3>Rating</h3><div id="rating"></div>
      <div class="stats" style="margin-top:12px" id="nums"></div>
      <h3 style="margin-top:16px">Last 50 games</h3><div class="results" id="res"></div>
      <div class="legend"><span style="--c:var(--felt)" id="lw"></span><span style="--c:color-mix(in srgb,var(--ink-soft) 55%,transparent)" id="ld"></span><span style="--c:var(--brass)" id="ll"></span></div>
      </div>`);
    root.append(card);
    const draw = () => {
      card.querySelector("#seg").innerHTML = speeds.map(s => `<button aria-pressed="${s === speed}" data-s="${s}">${cap(s)} · ${counts[s]}</button>`).join("");
      const sel = gs.filter(g => g.speed === speed).sort((a, b) => a.t - b.t);
      card.querySelector("#rating").innerHTML = lineChart(sel.filter(g => g.rating).map(g => [g.t, +g.rating]));
      const last = sel.slice(-50);
      const w = last.filter(g => g.result === "win").length, d = last.filter(g => g.result === "draw").length, l = last.length - w - d;
      const accs = last.map(g => g.acc).filter(a => a != null);
      const acc = accs.length ? (accs.reduce((a, b) => a + b, 0) / accs.length).toFixed(1) : "–";
      const rated = sel.filter(g => g.rating);
      card.querySelector("#nums").innerHTML = `<div class="stat"><b>${rated.length ? rated[rated.length - 1].rating : "–"}</b><span>rating now</span></div>
        <div class="stat"><b>${rated.length ? Math.max(...rated.map(g => +g.rating)) : "–"}</b><span>best</span></div><div class="stat"><b>${acc}</b><span>avg accuracy</span></div>`;
      card.querySelector("#res").innerHTML = (w ? `<i class="w" style="flex:${w}"></i>` : "") + (d ? `<i class="d" style="flex:${d}"></i>` : "") + (l ? `<i class="l" style="flex:${l}"></i>` : "");
      card.querySelector("#lw").textContent = `${w} won`;
      card.querySelector("#ld").textContent = `${d} drawn`;
      card.querySelector("#ll").textContent = `${l} lost`;
    };
    card.querySelector("#seg").addEventListener("click", e => {
      const b = e.target.closest("button[data-s]");
      if (b) { speed = app.progressSpeed = b.dataset.s; draw(); }
    });
    draw();
  }

  // where the points go: mistakes by phase in reviewed games
  const reviewed = app.games.filter(g => app.reviews[g.id]);
  if (reviewed.length) {
    const by = { opening: 0, middlegame: 0, endgame: 0 };
    let blunders = 0;
    reviewed.forEach(g => app.reviews[g.id].moves.forEach(m => { if (m.kind !== "inaccuracy") by[m.phase]++; if (m.kind === "blunder") blunders++; }));
    const tot = by.opening + by.middlegame + by.endgame || 1;
    root.append(h(`<div class="card"><h3>Where your mistakes happen</h3>
      <p class="small soft" style="margin:0 0 8px">${reviewed.length} reviewed games · ${blunders} blunders</p>
      ${Object.entries(by).map(([k, v]) => `<div style="margin:8px 0"><div class="row small"><span class="grow">${cap(k)}</span><span class="mono">${v} · ${Math.round(100 * v / tot)}%</span></div>
        <div class="progressbar"><i style="width:${Math.round(100 * v / tot)}%"></i></div></div>`).join("")}
      <button class="btn small" data-go="practice" data-screen='{"mode":"mistakes"}' style="margin-top:6px">Practise them</button></div>`));
  }

  // practice calendar
  const days = {};
  (desk?.practice_days || []).forEach(d => days[d.day] = (days[d.day] || 0) + (d.answers || 0));
  Object.entries((await svc.kvGet("practiceDays")) || {}).forEach(([d, n]) => days[d] = (days[d] || 0) + n);
  const cells = [];
  const start = new Date(); start.setHours(12, 0, 0, 0);
  start.setDate(start.getDate() - 7 * 15 - start.getDay());
  for (let d = new Date(start); d.toISOString().slice(0, 10) <= today(); d.setDate(d.getDate() + 1)) {
    const k = d.toISOString().slice(0, 10), n = days[k] || 0;
    cells.push(`<i class="${n >= 20 ? "l3" : n >= 8 ? "l2" : n ? "l1" : ""}" title="${k}: ${n}"></i>`);
  }
  let streak = 0;
  for (let d = new Date(); ; d.setDate(d.getDate() - 1)) {
    const k = d.toISOString().slice(0, 10);
    if (days[k]) streak++; else if (k !== today()) break;
  }
  root.append(h(`<div class="card"><div class="row"><h3 class="grow" style="margin:0">Practice</h3>
    <span class="pill">${streak} day streak</span></div><p class="small soft" style="margin:6px 0 10px">Positions answered each day, last 16 weeks.</p>
    <div class="heat">${cells.join("")}</div></div>`));

  // your games
  if (app.games.length) {
    const list = h(`<div><h2 style="margin:18px 0 10px">Your games</h2></div>`);
    app.games.slice(0, 40).forEach(g => list.append(gameRow(g)));
    const unreviewed = app.games.length - Object.keys(app.reviews).length;
    if (unreviewed > 0 && !app.reviewing) {
      const more = h(`<button class="btn block">Review ${Math.min(25, unreviewed)} more games</button>`);
      more.addEventListener("click", async () => {
        app.reviewTarget = Math.min(app.games.length, Object.keys(app.reviews).length + 25);
        await svc.kvSet("reviewTarget", app.reviewTarget);
        reviewLoop();
        toast("Reviewing… new mistakes appear in Practice as each game is done.");
        render();
      });
      list.append(more);
    }
    root.append(list);
  }
}

const MARK = { inaccuracy: "?!", mistake: "?", blunder: "??" };
async function gameScreen(root, id, startPly = null) {
  const g = app.games.find(x => x.id === id);
  if (!g) { root.append(h(`<div class="card"><p>That game isn't on the phone anymore.</p><button class="btn" data-go="progress">Back</button></div>`)); return; }
  const r = app.reviews[g.id];
  const opp = g.color === "white" ? g.black : g.white;
  const bad = {};
  (r?.moves || []).forEach(m => bad[m.ply] = m);
  const el = h(`<div>
    <button class="back" data-go="progress">‹ Games</button>
    <div class="row" style="margin-bottom:8px"><span class="res ${g.result}">${g.result === "win" ? "W" : g.result === "draw" ? "D" : "L"}</span>
      <div class="grow"><b>vs ${esc(opp)}</b> <span class="small soft">${g.oppRating ? `(${g.oppRating})` : ""}</span><br>
      <span class="small soft">${esc(g.opening || "")} · ${dateOf(g.t)}</span></div>
      ${r ? `<span class="mono small">${r.accuracy}%<br><span class="soft">accuracy</span></span>` : ""}</div>
    <div class="board-wrap"><div id="board"></div></div>
    <div class="row" style="gap:8px;margin-bottom:10px">
      <button class="btn small" id="first" aria-label="Start">⏮</button><button class="btn small" id="prev" aria-label="Back">◀</button>
      <span class="grow mono small" id="eval" style="text-align:center"></span>
      <button class="btn small" id="nextm" aria-label="Forward">▶</button><button class="btn small" id="nextbad">Next mistake</button></div>
    <div class="msg info" id="note"></div>
    <div class="movelist" id="ml"></div>
    <p class="small soft" style="margin-top:12px"><a href="${esc(g.url)}" target="_blank" rel="noopener">Open on ${g.platform === "lichess" ? "Lichess" : "Chess.com"}</a></p></div>`);
  root.append(el);
  const $ = s => el.querySelector(s);
  const board = new Board($("#board"));
  const fens = [startFen()];
  g.uci.forEach(u => fens.push(playUci(fens[fens.length - 1], u)[0]));
  const ml = $("#ml");
  ml.innerHTML = g.sans.map((s, i) => `${i % 2 === 0 ? `<span class="num">${i / 2 + 1}.</span>` : ""}<button data-i="${i + 1}" class="mv ${bad[i] ? bad[i].kind : ""}">${esc(s)}${bad[i] ? MARK[bad[i].kind] : ""}</button>`).join("");
  let ply = startPly != null ? Math.max(0, Math.min(g.uci.length, startPly)) : 0;
  function show(p, animate = true) {
    ply = Math.max(0, Math.min(g.uci.length, p));
    const u = g.uci[ply - 1];
    board.set({ fen: fens[ply], orientation: g.color, last: u ? [u.slice(0, 2), u.slice(2, 4)] : null, animate });
    ml.querySelectorAll(".mv").forEach(b => b.classList.toggle("cur", +b.dataset.i === ply));
    ml.querySelector(".mv.cur")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    const e = r?.evals?.[ply];
    if (e) {
      // evals are from the side to move; show them from White's side
      const whiteToMove = ply % 2 === 0;
      if (e.m != null) $("#eval").textContent = e.m === 0 ? "Checkmate" : `Mate in ${Math.abs(e.m)} for ${(e.m > 0) === whiteToMove ? "White" : "Black"}`;
      else { const v = (whiteToMove ? e.c : -e.c) / 100; $("#eval").textContent = (v > 0 ? "+" : "") + v.toFixed(1); }
    } else $("#eval").textContent = r ? "" : "Not reviewed yet";
    const m = bad[ply - 1];
    const $note = $("#note");
    if (m) {
      $note.className = "msg " + (m.kind === "inaccuracy" ? "info" : "bad");
      $note.innerHTML = `<b>${esc(m.playedSan)}${MARK[m.kind]}</b> ${m.kind === "blunder" ? "Blunder" : cap(m.kind)}: lost ${m.loss}% winning chances. Better was <b>${esc(m.bestSan)}</b>${m.line?.length ? ` <span class="small">(${esc(m.line.join(" "))})</span>` : ""}.`;
    } else { $note.className = "msg info"; $note.textContent = ply ? `${Math.ceil(ply / 2)}${ply % 2 ? "." : "…"} ${g.sans[ply - 1]}` : "Start position. Tap ▶ or a move."; }
  }
  $("#first").onclick = () => show(0, false);
  $("#prev").onclick = () => show(ply - 1);
  $("#nextm").onclick = () => show(ply + 1);
  $("#nextbad").onclick = () => {
    const plies = Object.keys(bad).map(Number).sort((a, b) => a - b);
    const n = plies.find(p => p + 1 > ply);
    if (n != null) show(n + 1, false); else toast(plies.length ? "No more mistakes after this move." : "No mistakes found in this game.");
  };
  ml.addEventListener("click", e => { const b = e.target.closest(".mv"); if (b) show(+b.dataset.i, false); });
  app.onRendered = () => show(ply, false);
  if (!r) {
    const btn = h(`<button class="btn primary block" style="margin-top:10px">Review this game now</button>`);
    btn.onclick = async () => {
      btn.disabled = true; btn.textContent = "Reviewing…";
      const idx = app.games.indexOf(g);
      app.reviewTarget = Math.max(app.reviewTarget, idx + 1);
      await svc.kvSet("reviewTarget", app.reviewTarget);
      reviewLoop();
    };
    el.insertBefore(btn, $("#ml"));
  }
}

function lineChart(pts) {
  if (pts.length < 2) return `<p class="small soft">Not enough rated games yet.</p>`;
  const W = 340, H = 150, L = 34, R = 40, T = 10, B = 20;
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  const pad = Math.max(20, (y1 - y0) * .1); y0 = Math.floor((y0 - pad) / 50) * 50; y1 = Math.ceil((y1 + pad) / 50) * 50;
  const X = x => L + (W - L - R) * (x1 === x0 ? .5 : (x - x0) / (x1 - x0));
  const Y = y => T + (H - T - B) * (1 - (y - y0) / (y1 - y0));
  const step = Math.max(50, Math.ceil((y1 - y0) / 4 / 50) * 50);
  let grid = "";
  for (let y = y0; y <= y1; y += step) grid += `<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(y)}" y2="${Y(y)}"/><text class="axis" x="${L - 6}" y="${Y(y) + 3}" text-anchor="end">${y}</text>`;
  const fmt = t => new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const d = pts.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("");
  const last = pts[pts.length - 1];
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Rating from ${pts[0][1]} to ${last[1]}">
    ${grid}<path class="line" d="${d}"/>
    <circle class="end" cx="${X(last[0])}" cy="${Y(last[1])}" r="4"/>
    <text class="label" x="${X(last[0]) + 7}" y="${Y(last[1]) + 4}">${last[1]}</text>
    <text class="axis" x="${L}" y="${H - 4}">${fmt(x0)}</text><text class="axis" x="${W - R}" y="${H - 4}" text-anchor="end">${fmt(x1)}</text>
  </svg>`;
}


// ---- plans and upgrading --------------------------------------------------------------------------------------------------
// Checkout is the website's (Stripe). The plan then follows the email you pay with: sign in here with it and it unlocks.
const CHECKOUT = {
  pro: "https://buy.stripe.com/aFa28r2EW2ZY9OReu7cIE00",
  max: "https://buy.stripe.com/aFa3cvcfw7ge3qt2LpcIE01",
  unlimited: "https://buy.stripe.com/fZuaEXfrIcAy2mpadRcIE02",
};
const REFERRALS = { squares: "SQUARES" };   // same creator codes as the website (it saves the referral in this origin)
const PLANS = [
  { id: "free", name: "Free", price: "$0", per: "forever", phone: ["Game reviews, mistakes and your openings", "20 puzzles a day: rated, by phase and by theme",
      "10 missed-tactics drills a day", "Drill 1 repertoire from Plyra on your computer"] },
  { id: "pro", name: "Ply Pro", price: "$12", per: "per month", fit: "For improving club players",
    phone: ["Unlimited puzzles: all 34,000, by phase and theme", "The Woodpecker Method", "Unlimited missed-tactics drills", "Drill up to 3 repertoires built in Plyra"],
    desk: ["The stronger AI coach in Plyra on your computer: deep investigations and coaching summaries", "150 AI explanations a month"] },
  { id: "max", name: "Ply Max", price: "$35", per: "per month", fit: "For tournament players", best: true,
    phone: ["Everything in Ply Pro", "Drill every repertoire you build"],
    desk: ["About 20 deep AI investigations a month", "600 detailed AI explanations a month"] },
  { id: "unlimited", name: "Ply Unlimited", price: "$59", per: "per month", fit: "For daily serious preparation",
    phone: ["Everything in Ply Max"], desk: ["The most AI: about 35 deep investigations, then unlimited Lite AI", "1,500 explanations a month at maximum depth"] },
];
function checkoutUrl(planId, email) {
  const u = new URL(CHECKOUT[planId]);
  if (email) u.searchParams.set("prefilled_email", email);
  try {
    const saved = JSON.parse(localStorage.getItem("plyra_ref") || "null");
    if (saved && REFERRALS[saved.ref] && Date.now() - saved.t < 60 * 864e5) {
      u.searchParams.set("prefilled_promo_code", REFERRALS[saved.ref]);
      u.searchParams.set("client_reference_id", "ref_" + saved.ref);
    }
  } catch { /* no referral */ }
  return u.toString();
}
function upgradeNote(text) {
  const n = h(`<div class="upsell"><span class="grow">${text}</span><button class="btn small primary">See plans</button></div>`);
  n.querySelector("button").addEventListener("click", () => go("account", { screen: "plans" }));
  return n;
}

async function plansScreen(root) {
  const email = app.signedIn ? await svc.kvGet("email") : "";
  const cur = plan();
  root.append(h(`<div><button class="back" data-go="account" style="min-height:36px;padding:0">‹ Account</button>
    <div class="eyebrow">Plans</div><h1>Train without limits</h1>
    <p class="soft">One plan works everywhere: on this phone and in Plyra on your computer (up to 3 computers and 2 phones).
    Cancel any time from your receipt email.</p></div>`));
  for (const p of PLANS) {
    const isCur = p.id === cur;
    const c = h(`<div class="card plan-card${p.best ? " best" : ""}${isCur ? " current" : ""}">
      ${p.best ? '<span class="badge">Most popular</span>' : ""}
      <div class="row"><div class="grow"><h3 style="margin:0">${p.name}</h3>${p.fit ? `<span class="small soft">${p.fit}</span>` : ""}</div>
        <div style="text-align:right"><b class="mono" style="font-size:1.5rem">${p.price}</b><br><span class="small soft">${p.per}</span></div></div>
      <p class="small soft" style="margin:10px 0 4px">On your phone</p>
      <ul class="ticks small">${p.phone.map(x => `<li>${esc(x)}</li>`).join("")}</ul>
      ${p.desk ? `<p class="small soft" style="margin:10px 0 4px">In Plyra on your computer</p><ul class="ticks small">${p.desk.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      ${isCur ? `<p class="small" style="margin:12px 0 0"><b>Your plan</b></p>` : p.id === "free" ? "" : `<a class="btn ${p.best ? "primary" : ""} block" style="margin-top:12px" href="${esc(checkoutUrl(p.id, email))}" target="_blank" rel="noopener">Get ${p.name}</a>`}
    </div>`);
    root.append(c);
  }
  const after = h(`<div class="card"><h3>After you pay</h3>
    <ol class="small" style="margin:0;padding-left:1.2em;display:grid;gap:6px">
      <li>Come back to this app.</li>
      <li>${app.signedIn ? "Tap <b>Check my plan</b> below." : "Sign in under <b>Account → Plyra account</b> with the email you paid with. We send a 6-digit code, no password."}</li>
      <li>Your plan unlocks here, and in Plyra on your computer.</li></ol>
    ${app.signedIn ? `<button class="btn block" id="chk" style="margin-top:12px">Check my plan</button>` : `<button class="btn block" style="margin-top:12px" data-go="account">Sign in</button>`}</div>`);
  after.querySelector("#chk")?.addEventListener("click", async () => {
    try { app.account = await svc.account(); toast(plan() === "free" ? "Still on Free. Payments can take a minute to arrive; try again shortly." : `You're on ${app.account.plan_label || plan()}.`); render(); }
    catch (e) { toast(e.message); }
  });
  root.append(after);
  root.append(h(`<p class="small soft">Payments are handled securely by Stripe. Questions: support@murrtech.pro</p>`));
}

// ---- Account ----------------------------------------------------------------------------------------------------------------------------------
function syncOffCard(inline = false) {
  const c = h(`<div class="${inline ? "" : "card "}stack">
    ${inline ? "" : "<h3>Turn on sync</h3>"}<p class="small soft" style="margin:0">Your repertoires and practice from Plyra on your computer
    reach the phone through sync. Turn it on here, then in Plyra on your computer (Account → Sync).</p>
    <button class="btn primary block">Turn on sync</button></div>`);
  c.querySelector("button").addEventListener("click", async () => {
    try { await svc.turnOnSync(); await syncNow({ quiet: true }); render(); toast("Sync is on."); }
    catch (e) { toast(e.message); }
  });
  return c;
}

async function viewAccount(root) {
  if (app.screen?.screen === "plans") return plansScreen(root);
  root.append(h(`<div><div class="eyebrow">Account</div><h1>Your accounts</h1></div>`));
  const pl = PLANS.find(p => p.id === plan()) || PLANS[0];
  const planCard = h(`<div class="card row"><div class="grow"><span class="small soft">Your plan</span><br><b style="font-size:1.1rem">${pl.name}</b></div>
    <button class="btn ${plan() === "free" ? "primary" : ""} small">${plan() === "free" ? "Upgrade" : "Plans"}</button></div>`);
  planCard.querySelector("button").addEventListener("click", () => go("account", { screen: "plans" }));
  root.append(planCard);
  // chess accounts
  const chess = h(`<div class="card"><h3>Chess accounts</h3></div>`);
  for (const l of app.links) {
    const row = h(`<div class="row list-item" style="cursor:default">
      <span class="grow"><b>${esc(l.username)}</b><br><span class="small soft">${l.platform === "lichess" ? "Lichess" : "Chess.com"} · games fetched ${ago(l.last)}</span></span>
      <button class="btn small" data-act="remove">Remove</button></div>`);
    row.querySelector("[data-act=remove]").addEventListener("click", async () => {
      if (!confirmInline(row, `Remove ${l.username}? Its games and reviews are taken off this phone.`)) return;
    });
    chess.append(row);
  }
  if (app.links.length) {
    const r = h(`<button class="btn block" style="margin-top:8px">Get new games now</button>`);
    r.addEventListener("click", async () => {
      r.disabled = true; r.textContent = "Getting new games…";
      const n = await refreshGames({ force: true });
      toast(n ? `${n} new game${n === 1 ? "" : "s"}.` : "No new games.");
      render();
    });
    chess.append(r);
    const add = h(`<details style="margin-top:10px"><summary class="small" style="cursor:pointer;color:var(--felt);font-weight:600">Link another account</summary></details>`);
    add.append(linkForm(true));
    chess.append(add);
  } else chess.append(linkForm(true));
  root.append(chess);

  // Plyra account
  const plyra = h(`<div class="card"><h3>Plyra account</h3></div>`);
  root.append(plyra);
  if (!app.signedIn) {
    plyra.append(h(`<p class="small soft" style="margin:0 0 10px">Optional. Sign in with the email of your Plyra account to
      bring your repertoires, tactics and progress from Plyra on your computer, and to use your plan on the phone.</p>`));
    signInFlow(plyra);
  } else {
    const email = await svc.kvGet("email");
    const a = app.account;
    const last = await svc.kvGet("lastPull");
    plyra.append(h(`<div class="stack">
      <div class="row"><span class="grow soft">Signed in as</span><b>${esc(email || "")}</b></div>
      <div class="row"><span class="grow soft">Plan</span><b>${esc(a?.plan_label || a?.plan || "–")}</b></div>
      <div class="row"><span class="grow soft">Last sync</span><b>${ago(last)}</b></div></div>`));
    const btns = h(`<div class="btn-row" style="margin-top:10px"><button class="btn" id="sync">Sync now</button><button class="btn" id="out">Sign out</button></div>`);
    btns.querySelector("#sync").addEventListener("click", async () => { await syncNow(); render(); });
    btns.querySelector("#out").addEventListener("click", async () => {
      await signedOut();
      toast("Signed out. Your games stay on this phone for when you sign in again.");
    });
    plyra.append(btns);
    if (app.syncOff) plyra.append(syncOffCard(true));
  }

  root.append(h(`<div class="card"><h3>Install on your home screen</h3>
    <p class="small soft" style="margin:0">iPhone: Safari → Share → Add to Home Screen. Android: Chrome → ⋮ → Install app.
    Plyra then opens full screen and works offline.</p></div>`));
  const theme = h(`<div class="card"><h3>Theme</h3><div class="seg" style="margin:0">
    ${["auto", "light", "dark"].map(t => `<button data-t="${t}" aria-pressed="${(localTheme() || "auto") === t}">${cap(t)}</button>`).join("")}</div></div>`);
  theme.addEventListener("click", e => { const b = e.target.closest("button[data-t]"); if (b) { setTheme(b.dataset.t); render(); } });
  root.append(theme);
  root.append(h(`<p class="small soft">Reviews run on this phone with Stockfish 19 (<a href="engine/SOURCE.txt">GPL v3, source</a>).
    <a href="../privacy.html">Privacy</a> · <a href="../terms.html">Terms</a></p>`));
}

// a two-step confirm inside the row (no browser dialogs)
function confirmInline(row, text) {
  if (row.dataset.confirm) return true;
  row.dataset.confirm = "1";
  const box = h(`<div class="note" style="margin-top:8px">${esc(text)}<div class="btn-row" style="margin-top:8px">
    <button class="btn small" data-a="no">Keep</button><button class="btn small primary" data-a="yes">Remove</button></div></div>`);
  row.after(box);
  box.addEventListener("click", async e => {
    const a = e.target.closest("button[data-a]")?.dataset.a;
    if (a === "no") { box.remove(); delete row.dataset.confirm; }
    if (a === "yes") {
      const name = row.querySelector("b").textContent;
      const link = app.links.find(l => l.username === name);
      const prefix = link.platform === "lichess" ? "li:" : "cc:";
      const u = link.username.toLowerCase();
      const gone = new Set(app.games.filter(g => g.id.startsWith(prefix) && (g.white.toLowerCase() === u || g.black.toLowerCase() === u)).map(g => g.id));
      app.links = app.links.filter(l => l !== link);
      app.games = app.games.filter(g => !gone.has(g.id));
      gone.forEach(id => delete app.reviews[id]);
      await svc.kvSet("links", app.links); await svc.kvSet("games", app.games); await svc.kvSet("reviews", app.reviews);
      await rebuildPractice();
      render(); toast("Removed.");
    }
  });
  return false;
}

function signInFlow(root) {
  const el = h(`<div>
    <form class="stack" id="f1" novalidate>
      <input class="field" id="email" type="email" inputmode="email" autocomplete="email" placeholder="Email" required>
      <button class="btn primary block" type="submit">Send me a code</button>
      <div class="err" id="e1"></div>
    </form>
    <form class="stack" id="f2" hidden novalidate>
      <p class="small soft" id="sent-to" style="margin:0"></p>
      <label for="code" class="small soft">The 6-digit code from the email</label>
      <input class="field code" id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*">
      <button class="btn primary block" type="submit">Sign in</button>
      <div class="btn-row"><button class="btn" type="button" id="resend">Send a new code</button><button class="btn" type="button" id="again">Use another email</button></div>
      <div class="err" id="e2"></div>
      <div id="devices"></div>
    </form></div>`);
  root.append(el);
  const f1 = el.querySelector("#f1"), f2 = el.querySelector("#f2");
  let email = "";
  const PENDING = "pendingSignIn", CODE_MINUTES = 10;
  const showCodeStep = () => {
    f1.hidden = true; f2.hidden = false;
    el.querySelector("#sent-to").textContent = `We sent a 6-digit code to ${email}. It works for ${CODE_MINUTES} minutes; check your spam folder if it isn't there.`;
  };
  // came back from the email app (or the phone reloaded the page): pick up where they were
  svc.kvGet(PENDING).then(p => {
    if (p && Date.now() - p.t < CODE_MINUTES * 60 * 1000 && f2.hidden) { email = p.email; el.querySelector("#email").value = email; showCodeStep(); }
  });
  f1.addEventListener("submit", async e => {
    e.preventDefault();
    email = el.querySelector("#email").value.trim();
    const err = el.querySelector("#e1");
    if (!/^\S+@\S+\.\S+$/.test(email)) { err.textContent = "Enter your email address."; return; }
    const btn = f1.querySelector("button"); btn.disabled = true; err.textContent = "";
    try {
      await svc.startSignIn(email);
      await svc.kvSet(PENDING, { email, t: Date.now() });
      showCodeStep();
      el.querySelector("#code").focus();
    } catch (x) { err.textContent = x.message; }
    btn.disabled = false;
  });
  el.querySelector("#again").addEventListener("click", async () => { await svc.kvDel(PENDING); f2.hidden = true; f1.hidden = false; });
  el.querySelector("#resend").addEventListener("click", async e => {
    const b = e.currentTarget; b.disabled = true;
    try { await svc.startSignIn(email); await svc.kvSet(PENDING, { email, t: Date.now() }); toast("New code sent."); }
    catch (x) { el.querySelector("#e2").textContent = x.message; }
    setTimeout(() => { b.disabled = false; }, 20000);
  });
  // a full code typed or pasted signs in straight away
  el.querySelector("#code").addEventListener("input", e => {
    const v = e.target.value.replace(/\D/g, "").slice(0, 6);
    if (v !== e.target.value) e.target.value = v;
    if (v.length === 6) verify();
  });
  const verify = async (replace = null) => {
    const code = el.querySelector("#code").value.trim();
    const err = el.querySelector("#e2");
    if (!/^\d{6}$/.test(code)) { err.textContent = "Enter the 6 digits from the email."; return; }
    err.textContent = "";
    try {
      await svc.verifySignIn(email, code, replace);
      await svc.kvDel(PENDING);
      app.signedIn = true;
      toast("Welcome to Plyra.");
      await syncNow({ quiet: true });
      go("today");
    } catch (x) {
      if (x.status === 409 && x.detail?.devices) {
        const box = el.querySelector("#devices");
        box.innerHTML = `<p class="small">${esc(x.detail.message)}</p>` + x.detail.devices.map(d =>
          `<button class="btn block small" type="button" data-id="${esc(d.id)}" style="margin-top:6px">Sign out ${esc(d.name || d.device_name || "phone")}</button>`).join("");
        box.querySelectorAll("button[data-id]").forEach(b => b.addEventListener("click", () => verify(b.dataset.id)));
      } else err.textContent = x.message;
    }
  };
  f2.addEventListener("submit", e => { e.preventDefault(); verify(); });
}

// ---- theme ---------------------------------------------------------------------------------------------------------------------------------------
function localTheme() { try { return localStorage.getItem("plyra-theme"); } catch { return null; } }
function setTheme(t) {
  try { t === "auto" ? localStorage.removeItem("plyra-theme") : localStorage.setItem("plyra-theme", t); } catch { /* ignore */ }
  applyTheme();
}
function applyTheme() {
  const t = localTheme();
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

// ---- installing on the home screen --------------------------------------------------------------------------------------------------
let installEvent = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvent = e; if (app.tab === "today" && !app.screen) render(); });
window.addEventListener("appinstalled", () => { installEvent = null; toast("Plyra is on your home screen."); });
const standalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) && !window.MSStream;
async function installCard() {
  if (standalone() || (await svc.kvGet("installHidden"))) return null;
  if (installEvent) {
    const c = h(`<div class="card row"><img src="icons/icon-192.png" alt="" style="width:40px;height:40px;border-radius:9px">
      <span class="grow"><b>Install Plyra</b><br><span class="small soft">Opens full screen, works offline.</span></span>
      <button class="btn small primary">Install</button></div>`);
    c.querySelector("button").addEventListener("click", async () => { installEvent.prompt(); await installEvent.userChoice; installEvent = null; c.remove(); });
    return c;
  }
  if (isIOS()) {
    const c = h(`<div class="card"><div class="row"><img src="icons/icon-192.png" alt="" style="width:40px;height:40px;border-radius:9px">
      <span class="grow"><b>Put Plyra on your home screen</b><br><span class="small soft">Tap <b>Share</b> <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-3px"><path d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg> below, then <b>Add to Home Screen</b>.</span></span>
      <button class="btn small" aria-label="Hide">✕</button></div></div>`);
    c.querySelector("button").addEventListener("click", async () => { await svc.kvSet("installHidden", 1); c.remove(); });
    return c;
  }
  return null;
}

// ---- start ---------------------------------------------------------------------------------------------------------------------------------------
async function start() {
  applyTheme();
  await loadLocal();
  drawTabs();
  await render();
  drawStatus();
  if (navigator.onLine) {
    if (app.signedIn) { await syncNow({ quiet: true }); refreshIfIdle(); }
    refreshGames();
  } else reviewLoop();
  window.addEventListener("online", () => { drawStatus(); syncNow({ quiet: true }); refreshGames(); });
  window.addEventListener("offline", drawStatus);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && navigator.onLine && !app.screen && app.signedIn) {
      syncNow({ quiet: true }).then(refreshIfIdle);
      refreshGames();
    }
    if (document.visibilityState === "hidden" && app.signedIn) svc.pushAll().catch(() => {});
  });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}
start();

// Plyra School trainers: the board with its message area, and every exercise type the lessons use.
// Endgames are judged by the Lichess tablebase API (perfect play, 7 pieces), Think First and the engine games by
// Stockfish running on the device, puzzles come from the Lichess puzzle database (CC0).
import { Chess } from "./vendor/chess.js";
import { Board, playUci } from "./board.js";
import { analyse, winPct } from "./engine.js";

const TB = "https://tablebase.lichess.ovh/standard?fen=";
const PIECE_NAMES = { K: "king", Q: "queen", R: "rook", B: "bishop", N: "knight", P: "pawn" };
// the app plugs in its storage: missed positions go to Review, seen puzzle ids are skipped next time
export const ctx = { onMiss: () => {}, seen: [], saveSeen: () => {} };
const addReview = (...a) => ctx.onMiss(...a);

export const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
export const stm = fen => fen.split(" ")[1];
export const colorName = c => (c === "w" ? "White" : "Black");
export function toast(text) {
  const t = document.createElement("div"); t.className = "toast"; t.textContent = text;
  document.body.appendChild(t); setTimeout(() => t.remove(), 2400);
}
export function el(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; }
export function sanOf(fen, uci) { const r = playUci(fen, uci); return r ? r[1] : uci; }
export function lineText(fen, ucis) {  // numbered SAN, e.g. "15... Qxf2+ 16. Kh1"
  const g = new Chess(fen); let n = +fen.split(" ")[5], out = [];
  ucis.forEach((u, i) => {
    const white = g.turn() === "w";
    let m; try { m = g.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); } catch { return; }
    out.push(white ? `${n}. ${m.san}` : (i === 0 ? `${n}... ${m.san}` : m.san));
    if (!white) n++;
  });
  return out.join(" ");
}

// ---------------- tablebase ----------------
const tbCache = new Map();
export async function tb(fen) {
  const key = fen.split(" ").slice(0, 4).join(" ");
  if (tbCache.has(key)) return tbCache.get(key);
  const p = (async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(TB + encodeURIComponent(fen));
      if (r.ok) return r.json();
      if (r.status !== 429) break;
      await sleep(1200 * (attempt + 1));
    }
    throw new Error("The tablebase didn't answer.");
  })();
  tbCache.set(key, p);
  p.catch(() => tbCache.delete(key));
  return p;
}
export const WINS = ["win", "syzygy-win", "maybe-win"];
export const LOSSES = ["loss", "syzygy-loss", "maybe-loss"];
// does the user's move keep the goal? `cat` is the category for the opponent after the move
export const keeps = (goal, cat) => goal === "win" ? LOSSES.includes(cat) : !WINS.includes(cat);
export function goodMoves(t, goal) { return t.moves.filter(m => keeps(goal, m.category)).map(m => m.san); }

// ---------------- puzzles ----------------
const bandCache = new Map();
export async function band(b) {
  if (!bandCache.has(b)) bandCache.set(b, fetch(`puzzles/${b}.json`).then(r => (r.ok ? r.json() : [])).catch(() => []));
  return bandCache.get(b);
}
export async function pickPuzzles({ themes = null, min = 1100, max = 1600, count = 8, minLine = 2 }) {
  let rows = [];
  for (let b = Math.floor(min / 100) * 100; b <= Math.min(2900, max); b += 100) rows = rows.concat(await band(b));
  rows = rows.filter(r => r[3] >= min && r[3] <= max && r[2].split(" ").length >= minLine &&
    (!themes || themes.some(t => r[4].split(" ").includes(t))));
  const seen = new Set(ctx.seen);
  const fresh = rows.filter(r => !seen.has(r[0]));
  const out = shuffle(fresh.length >= count ? fresh : rows).slice(0, count);
  ctx.seen = ctx.seen.concat(out.map(r => r[0])).slice(-3000);
  ctx.saveSeen();
  return out;
}

// ---------------- the board with its message area ----------------
export function makeBoard(host) {
  host.innerHTML = "";
  const top = el(`<div><div class="eyebrow" data-k="title"></div><h2 data-k="prompt"></h2></div>`);
  const bw = el(`<div class="board-wrap"><div></div></div>`);
  const msg = el(`<div class="msg" role="status"></div>`);
  const extra = el(`<div></div>`);
  const actions = el(`<div class="btn-row" style="margin-top:12px"></div>`);
  host.append(top, bw, msg, extra, actions);
  const board = new Board(bw.firstElementChild);
  window.__board = board;  // for automated tests
  board.ui = {
    title: t => (top.querySelector("[data-k=title]").textContent = t || ""),
    prompt: t => (top.querySelector("[data-k=prompt]").textContent = t || ""),
    msg: (t, kind = "") => { msg.className = "msg " + kind; msg.innerHTML = t || ""; },
    extra,
    actions: list => {
      actions.innerHTML = "";
      for (const [label, fn, primary] of list) {
        const b = el(`<button class="btn ${primary ? "primary" : ""}">${esc(label)}</button>`);
        b.onclick = fn; actions.appendChild(b);
      }
    },
    wrong: () => { board.el.classList.remove("wrong"); void board.el.offsetWidth; board.el.classList.add("wrong"); },
  };
  return board;
}
export const waitMove = board => new Promise(res => { board.onMove = uci => { board.onMove = () => {}; res(uci); }; });
export const waitClick = (board, label, primary = true) => new Promise(res => board.ui.actions([[label, res, primary]]));

// ---------------- step: puzzle ----------------
// resolves true when solved with no wrong move
export async function runPuzzle(board, row, { title = "", exam = false } = {}) {
  const [id, fen0, moves, rating] = row;
  const line = moves.split(" ");
  const you = stm(fen0) === "w" ? "b" : "w";
  let pos = fen0, i = 0, clean = true;
  board.ui.title(title + (exam ? "" : ` · rated ${rating}`));
  board.ui.prompt(`${colorName(you)} to play`);
  board.ui.extra.innerHTML = "";
  board.ui.msg("Watch the opponent's move, then find the best reply.");
  board.ui.actions([]);
  board.set({ fen: pos, orientation: you === "w" ? "white" : "black", interactive: false, last: null, marks: [] , animate: false });
  await sleep(650);
  const first = playUci(pos, line[0]); pos = first[0]; i = 1;
  const afterFirst = pos;
  board.set({ fen: pos, last: [line[0].slice(0, 2), line[0].slice(2, 4)] });
  board.ui.msg(`Opponent played <b class="mono">${esc(first[1])}</b>. Your move.`);
  while (i < line.length) {
    board.set({ fen: pos, interactive: true, last: board.last });
    if (!exam && !clean) board.ui.actions([["Show the solution", () => board.onMove("__show")]]);
    const uci = await waitMove(board);
    if (uci === "__show") {
      board.ui.actions([]);
      for (; i < line.length; i++) {
        const r = playUci(pos, line[i]); pos = r[0];
        board.set({ fen: pos, interactive: false, last: [line[i].slice(0, 2), line[i].slice(2, 4)] });
        board.ui.msg(`Solution: <span class="mono">${esc(lineText(afterFirst, line.slice(1, i + 1)))}</span>`);
        await sleep(800);
      }
      break;
    }
    const r = playUci(pos, uci);
    const mates = r && new Chess(r[0]).isCheckmate();
    if (uci === line[i] || mates) {
      pos = r[0]; i++;
      board.ui.actions([]);
      if (i >= line.length || mates) { i = line.length; break; }
      board.ui.msg(`<b class="mono">${esc(r[1])}</b>, right. Keep going.`, "good");
      await sleep(450);
      const reply = playUci(pos, line[i]); pos = reply[0];
      board.set({ fen: pos, interactive: false, last: [line[i].slice(0, 2), line[i].slice(2, 4)] });
      i++;
    } else {
      clean = false;
      board.ui.wrong();
      if (exam) { board.set({ fen: pos, interactive: false, last: board.last }); board.ui.msg(`Not it. The answer was <b class="mono">${esc(sanOf(pos, line[i]))}</b>.`, "bad"); break; }
      board.ui.msg(`<b class="mono">${esc(r ? r[1] : uci)}</b> isn't it. Look again: checks, captures, threats.`, "bad");
      await sleep(350);
      board.set({ fen: pos, interactive: false, last: board.last, animate: false });
    }
  }
  if (clean) board.ui.msg(`Solved. <span class="soft">${esc(row[4].split(" ").filter(t => !/^(short|long|veryLong|oneMove|middlegame|endgame|opening|crushing|advantage|mate)$/.test(t)).slice(0, 3).join(" · "))}</span>`, "good");
  else if (!exam) addReview("p:" + id, "puzzle", row);
  board.set({ fen: pos, interactive: false, last: board.last });
  return clean;
}

// ---------------- step: one tablebase move ("exercise") ----------------
export async function runTbItem(board, item, { title = "", exam = false } = {}) {
  board.ui.title(title);
  board.ui.prompt(item.prompt);
  board.ui.extra.innerHTML = "";
  board.ui.actions([]);
  board.set({ fen: item.fen, orientation: stm(item.fen) === "w" ? "white" : "black", interactive: true, last: null, marks: [], animate: false });
  board.ui.msg(item.goal === "win" ? "Find a move that keeps the win. Every move is checked against perfect play." : "Find a move that keeps the draw. Every move is checked against perfect play.");
  const tP = tb(item.fen).catch(() => null);
  const uci = await waitMove(board);
  board.ui.msg("Checking against the tablebase…");
  const t = await tP;
  if (!t) { board.ui.msg("Couldn't reach the tablebase. Check your connection.", "bad"); return false; }
  const mv = t.moves.find(m => m.uci === uci);
  const good = goodMoves(t, item.goal);
  const ok = !!mv && keeps(item.goal, mv.category);
  if (ok) board.ui.msg(`<b class="mono">${esc(mv.san)}</b> keeps the ${item.goal}. ${good.length > 1 ? `Also good: ${good.filter(s => s !== mv.san).map(esc).join(", ")}.` : "It was the only move."}`, "good");
  else {
    board.ui.wrong();
    board.ui.msg(`<b class="mono">${esc(mv?.san || uci)}</b> throws it away (perfect play turns it into a ${mv ? resultWord(mv.category) : "different result"}). ${good.length ? `The move${good.length > 1 ? "s were" : " was"}: <b class="mono">${good.map(esc).join(", ")}</b>.` : ""}`, "bad");
    if (!exam) addReview("t:" + item.fen, "tb", item);
  }
  return ok;
}
function resultWord(oppCat) {
  if (WINS.includes(oppCat)) return "loss for you";
  if (LOSSES.includes(oppCat)) return "win";
  return "draw";
}

// ---------------- step: play it out against perfect play ----------------
// resolves to a score: 1 clean, 0.5 finished after a take-back, 0 skipped
export async function runPlayout(board, step, alive) {
  const root = await tb(step.fen).catch(() => null);
  if (!root) { board.ui.msg("Couldn't reach the tablebase. Check your connection and try again.", "bad"); await waitClick(board, "Try again"); return runPlayout(board, step, alive); }
  const rootSide = stm(step.fen);
  const rootOk = step.goal === "win" ? WINS.includes(root.category) : !LOSSES.includes(root.category);
  const you = rootOk ? rootSide : (rootSide === "w" ? "b" : "w");
  let fen = step.fen, slips = 0, yourMoves = 0, history = [];
  board.ui.prompt(`You are ${colorName(you)}: ${step.goal === "win" ? "win it" : "hold the draw"}`);
  board.ui.extra.innerHTML = "";
  board.set({ fen, orientation: you === "w" ? "white" : "black", interactive: false, last: null, marks: [], animate: false });
  board.ui.msg(esc(step.text || ""));
  const opponentMove = async () => {
    const t = await tb(fen);
    if (!t.moves.length) return false;
    await sleep(500);
    const m = pickOpponentMove(fen, t.moves);
    fen = playUci(fen, m.uci)[0];
    board.set({ fen, last: [m.uci.slice(0, 2), m.uci.slice(2, 4)], interactive: false });
    return m.san;
  };
  if (stm(fen) !== you) { const san = await opponentMove(); board.ui.msg(`${esc(step.text || "")}<br><span class="soft">Perfect play opened with <b class="mono">${esc(san)}</b>.</span>`); }
  for (;;) {
    if (!alive()) return 0;
    const g = new Chess(fen);
    if (g.isGameOver()) break;
    board.set({ fen, interactive: true, last: board.last });
    board.ui.actions(slips ? [["Skip", () => board.onMove("__skip")]] : []);
    const uci = await waitMove(board);
    if (uci === "__skip") return 0;
    const before = fen;
    board.ui.actions([]);
    const t = await tb(before).catch(() => null);
    if (!t) { board.ui.msg("Lost the connection to the tablebase. Try the move again.", "bad"); fen = before; continue; }
    const mv = t.moves.find(m => m.uci === uci);
    if (!mv || !keeps(step.goal, mv.category)) {
      slips++;
      board.ui.wrong();
      const best = goodMoves(t, step.goal);
      board.ui.msg(`<b class="mono">${esc(mv?.san || uci)}</b> lets the ${step.goal} slip. ${best.length ? `Perfect play: <b class="mono">${best.slice(0, 3).map(esc).join(", ")}</b>.` : ""} Take it back and try again.`, "bad");
      await sleep(300);
      board.set({ fen: before, interactive: false, last: board.last });
      await waitClick(board, "Take back");
      continue;
    }
    history.push(mv.san);
    fen = playUci(before, uci)[0];
    yourMoves++;
    const g2 = new Chess(fen);
    const promoted = uci.length === 5;
    if (step.goal === "win" && !g2.isCheckmate() && bareKingWon(before, fen, you)) {
      board.ui.msg(`<b class="mono">${esc(mv.san)}</b>: only the king is left, and mating it from here is routine. Won against perfect defence.`, "good");
      break;
    }
    if (step.goal === "win" && (g2.isCheckmate() || promoted)) {
      board.ui.msg(g2.isCheckmate() ? "Checkmate. Won against perfect defence." : `Promoted with the win in hand (<b class="mono">${esc(mv.san)}</b>). That's the technique.`, "good");
      break;
    }
    if (step.goal === "draw" && (g2.isDraw() || g2.isStalemate() || g2.isInsufficientMaterial())) { board.ui.msg("Drawn. Perfect play couldn't break you.", "good"); break; }
    if (step.goal === "draw" && yourMoves >= 15) { board.ui.msg("Fifteen moves held against perfect play. That's a draw you know how to hold.", "good"); break; }
    board.ui.msg(`<b class="mono">${esc(mv.san)}</b> ✓ <span class="soft">${step.goal === "draw" ? `${yourMoves} of 15 moves held` : "still winning"}</span>`);
    let san = await opponentMove().catch(() => null);
    while (san === null) {
      board.ui.msg("Lost the connection to the tablebase.", "bad");
      await waitClick(board, "Try again");
      san = await opponentMove().catch(() => null);
    }
    if (san === false) { const g3 = new Chess(fen); board.ui.msg(g3.isCheckmate() ? "Checkmate." : "Game over.", "good"); break; }
    const g3 = new Chess(fen);
    if (step.goal === "draw" && (g3.isDraw() || g3.isInsufficientMaterial())) { board.ui.msg("Drawn. Perfect play couldn't break you.", "good"); break; }
  }
  board.set({ fen, interactive: false, last: board.last });
  return slips === 0 ? 1 : 0.5;
}

// The tablebase ranks moves by result only, so in a drawn position all drawing moves look alike to it, including
// ones that hang a piece. The opponent plays like a person trying to win: among the moves with the best result it
// prefers the ones that leave nothing en prise (in tablebase order otherwise).
const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
function hangingValue(fen) {
  const g = new Chess(fen);  // the user is to move here
  const me = g.turn() === "w" ? "b" : "w";  // the side that just moved
  let worst = 0;
  for (const mv of g.moves({ verbose: true })) {
    if (!mv.captured) continue;
    const after = new Chess(g.fen()); after.move(mv);
    const defended = after.isAttacked(mv.to, me);
    const loss = defended ? VAL[mv.captured] - VAL[mv.piece] : VAL[mv.captured];
    worst = Math.max(worst, loss);
  }
  return worst;
}
function pickOpponentMove(fen, moves) {
  const best = moves.filter(m => m.category === moves[0].category);
  if (best.length < 2) return moves[0];
  let pick = best[0], score = Infinity;
  for (const m of best) {
    const r = playUci(fen, m.uci); if (!r) continue;
    const h = hangingValue(r[0]);
    if (h < score) { score = h; pick = m; }
    if (h === 0) break;
  }
  return pick;
}

// a capture just left the opponent with a bare king while you keep a queen or a rook: the rest is a basic mate
function bareKingWon(before, after, you) {
  const count = (fen, color) => new Chess(fen).board().flat().filter(p => p && p.color === color);
  const opp = you === "w" ? "b" : "w";
  const was = count(before, opp).length, now = count(after, opp);
  return was > 1 && now.length === 1 && count(after, you).some(p => p.type === "q" || p.type === "r");
}

// ---------------- step: watch perfect play ----------------
export async function runWatch(board, step, alive) {
  board.ui.prompt("Perfect play");
  board.ui.msg(esc(step.text || ""));
  const plies = [];
  let fen = step.fen;
  try {
    for (let k = 0; k < step.plies; k++) {
      const t = await tb(fen); if (!t.moves.length) break;
      plies.push(t.moves[0].uci); fen = playUci(fen, t.moves[0].uci)[0];
    }
  } catch { board.ui.msg("Couldn't reach the tablebase for this part.", "bad"); return; }
  const play = async () => {
    let f = step.fen;
    board.set({ fen: f, orientation: stm(step.fen) === "w" ? "white" : "black", interactive: false, last: null, marks: [], animate: false });
    for (let k = 0; k < plies.length; k++) {
      if (!alive()) return;
      await sleep(900);
      f = playUci(f, plies[k])[0];
      board.set({ fen: f, last: [plies[k].slice(0, 2), plies[k].slice(2, 4)] });
      board.ui.extra.innerHTML = `<p class="line">${esc(lineText(step.fen, plies.slice(0, k + 1)))}</p>`;
    }
  };
  await play();
  for (;;) {
    const again = await new Promise(res => board.ui.actions([["Replay", () => res(true)], ["Continue", () => res(false), true]]));
    if (!again) return;
    await play();
  }
}

// ---------------- step: Think First ----------------
// returns [points, max]
export async function runThink(board, row, title, alive) {
  const [id, fen0, moves] = row;
  const line = moves.split(" ");
  const you = stm(fen0) === "w" ? "b" : "w";
  board.ui.title(title);
  board.ui.prompt(`${colorName(you)} to play · list your candidates`);
  board.set({ fen: fen0, orientation: you === "w" ? "white" : "black", interactive: false, last: null, marks: [], animate: false });
  await sleep(600);
  const pos = playUci(fen0, line[0])[0];
  const last0 = [line[0].slice(0, 2), line[0].slice(2, 4)];
  board.set({ fen: pos, last: last0 });
  const cands = []; let chosen = null;
  const draw = () => {
    board.ui.extra.innerHTML = "";
    const box = el(`<div class="cands"></div>`);
    cands.forEach(c => {
      const b = el(`<button class="cand ${c.uci === chosen ? "chosen" : ""}">${esc(c.san)}</button>`);
      b.onclick = () => { chosen = c.uci; draw(); };
      box.appendChild(b);
    });
    for (let k = cands.length; k < 3; k++) box.appendChild(el(`<span class="cand" style="opacity:.35;display:inline-flex;align-items:center">${k + 1}</span>`));
    board.ui.extra.appendChild(box);
    const acts = [];
    if (cands.length) acts.push(["Clear", () => board.onMove("__clear")]);
    if (chosen) acts.push(["Play my choice", () => board.onMove("__go"), true]);
    board.ui.actions(acts);
  };
  board.ui.msg(`Opponent played <b class="mono">${esc(sanOf(fen0, line[0]))}</b>. Play up to three candidate moves on the board: each goes on your list. Then tap the one you choose.`);
  draw();
  for (;;) {
    if (!alive()) return [0, 2];
    board.set({ fen: pos, interactive: cands.length < 3, last: last0 });
    const uci = await waitMove(board);
    if (uci === "__clear") { cands.length = 0; chosen = null; draw(); continue; }
    if (uci === "__go") break;
    if (!cands.some(c => c.uci === uci)) cands.push({ uci, san: sanOf(pos, uci) });
    chosen = uci;
    await sleep(350);
    board.set({ fen: pos, interactive: false, last: last0, animate: false });
    draw();
    if (cands.length === 3) board.ui.msg("Three candidates listed. Tap the one you're playing, then Play my choice.");
  }
  board.ui.actions([]);
  board.ui.msg("Stockfish is checking your list…");
  const sol = line[1];
  const listed = cands.some(c => c.uci === sol);
  const evalOf = async uci => {
    const after = playUci(pos, uci)[0];
    if (new Chess(after).isCheckmate()) return 100;
    try { const a = await analyse(after, { depth: 12, movetime: 600 }); return Math.round(100 - winPct(a.cp, a.mate)); } catch { return null; }
  };
  const evals = [];
  for (const c of cands) evals.push(await evalOf(c.uci));
  const solEval = listed ? evals[cands.findIndex(c => c.uci === sol)] : await evalOf(sol);
  const chosenIdx = cands.findIndex(c => c.uci === chosen);
  // a candidate as good as the solution (within 3 points of winning chances, or mate) counts as finding it
  const asGood = k => cands[k].uci === sol || (evals[k] != null && solEval != null && evals[k] >= solEval - 3);
  const foundListed = listed || cands.some((c, k) => asGood(k));
  const foundChosen = chosenIdx >= 0 && asGood(chosenIdx);
  const pts = foundChosen ? 2 : foundListed ? 1 : 0;
  board.ui.extra.innerHTML = "";
  const box = el(`<div class="cands"></div>`);
  cands.forEach((c, k) => box.appendChild(el(`<span class="cand ${asGood(k) ? "best" : ""} ${c.uci === chosen ? "chosen" : ""}" style="display:inline-flex;align-items:center">${esc(c.san)}<span class="ev">${evals[k] == null ? "" : evals[k] + "%"}</span></span>`)));
  if (!foundListed) box.appendChild(el(`<span class="cand best" style="display:inline-flex;align-items:center">${esc(sanOf(pos, sol))}<span class="ev">${solEval == null ? "" : solEval + "%"}</span></span>`));
  board.ui.extra.appendChild(box);
  board.ui.extra.appendChild(el(`<p class="small dim">Percent = your winning chances after the move (Stockfish, depth 12).</p>`));
  const solLine = lineText(pos, line.slice(1, 4));
  board.ui.msg(pts === 2 ? `Found and chosen. +2. <span class="soft">Line: <span class="mono">${esc(solLine)}</span></span>`
    : pts === 1 ? `It was on your list but you chose another. +1. <span class="soft">The line: <span class="mono">${esc(solLine)}</span></span>`
    : `The key move wasn't on your list. <span class="soft">It was <span class="mono">${esc(solLine)}</span>. Did you look at every check and capture?</span>`, pts === 2 ? "good" : pts ? "" : "bad");
  if (pts < 2) addReview("p:" + id, "puzzle", row);
  const shown = playUci(pos, sol);
  board.set({ fen: shown[0], interactive: false, last: [sol.slice(0, 2), sol.slice(2, 4)] });
  return [pts, 2];
}

// ---------------- step: Blind Steps ----------------
const CHOICES = ["wK", "wQ", "wR", "wB", "wN", "wP", "empty", "bK", "bQ", "bR", "bB", "bN", "bP"];
export function pieceAt(fen, sq) { const p = new Chess(fen).get(sq); return p ? p.color + p.type.toUpperCase() : "empty"; }
export function pieceWord(code) { return code === "empty" ? "empty" : `${code[0] === "w" ? "white" : "black"} ${PIECE_NAMES[code[1]]}`; }
// one round; resolves true/false
export async function runBlindRound(board, row, plies, title, alive) {
  const [, fen0, moves] = row;
  const line = moves.split(" ");
  const start = playUci(fen0, line[0])[0];
  const k = Math.max(1, Math.min(plies, line.length - 1));
  const steps = line.slice(1, 1 + k);
  let end = start; const touched = [];
  for (const u of steps) { end = playUci(end, u)[0]; touched.push(u.slice(0, 2), u.slice(2, 4)); }
  const lastTo = steps[steps.length - 1].slice(2, 4);
  let pool = [...new Set(touched)].filter(s => s !== lastTo);
  if (!pool.length) pool = [lastTo];
  const ask = pool[Math.floor(Math.random() * pool.length)];
  const answer = pieceAt(end, ask);
  board.ui.title(title);
  board.ui.prompt(`Memorise the position`);
  board.ui.actions([]);
  board.el.classList.remove("blind", "compact");
  board.set({ fen: start, orientation: stm(start) === "w" ? "white" : "black", interactive: false, last: [line[0].slice(0, 2), line[0].slice(2, 4)], marks: [], animate: false });
  for (let s = 6; s > 0; s--) {
    if (!alive()) return false;
    board.ui.extra.innerHTML = `<div class="countdown">${s}</div>`;
    board.ui.msg(`${colorName(stm(start))} to move. The pieces vanish in ${s}…`);
    await sleep(1000);
  }
  board.el.classList.add("blind", "compact");
  board.set({ fen: start, last: null, marks: [ask] });
  board.ui.prompt(`Which piece is on ${ask} now?`);
  board.ui.extra.innerHTML = `<p class="line">${esc(lineText(start, steps))}</p>`;
  board.ui.msg(`Play the line in your head (${k} move${k > 1 ? "s" : ""}). Then say what stands on <b class="mono">${ask}</b>.`);
  const grid = el(`<div class="choices"></div>`);
  const picked = await new Promise(res => {
    CHOICES.forEach(c => {
      const b = c === "empty" ? el(`<button class="empty" aria-label="Empty">empty</button>`)
        : el(`<button class="${c[0] === "b" ? "dark" : ""}" aria-label="${pieceWord(c)}"><img src="pieces/${c}.svg" alt=""></button>`);
      b.onclick = () => res(c);
      grid.appendChild(b);
    });
    board.ui.extra.appendChild(grid);
  });
  const ok = picked === answer;
  board.el.classList.remove("blind", "compact");
  const lu = steps[steps.length - 1];
  board.set({ fen: end, last: [lu.slice(0, 2), lu.slice(2, 4)], marks: [ask] });
  board.ui.extra.innerHTML = `<p class="line">${esc(lineText(start, steps))}</p>`;
  board.ui.msg(ok ? `Right: ${pieceWord(answer)} on ${ask}.` : `It's ${answer === "empty" ? "empty" : "the " + pieceWord(answer)} on ${ask} (you said ${pieceWord(picked)}).`, ok ? "good" : "bad");
  if (!ok) board.ui.wrong();
  return ok;
}

// ---------------- step: Convert / Hold against Stockfish ----------------
// Positions come from real games (Lichess puzzles): the position right after the puzzle's solution, so the material
// or the defence has just been won. Stockfish checks each one first and keeps only those that fit the round.
const userChances = a => Math.round(100 - winPct(a.cp, a.mate));  // `a` is from the side to move = the opponent
export async function findEnginePositions(step, onProgress = () => {}) {
  const rows = await pickPuzzles({ themes: step.themes, min: step.min, max: step.max, count: step.count * 4, minLine: 2 });
  const out = [];
  for (const [k, row] of rows.entries()) {
    if (out.length >= step.count) break;
    onProgress(k + 1, rows.length);
    let fen = row[1];
    for (const u of row[2].split(" ")) { const r = playUci(fen, u); if (!r) { fen = null; break; } fen = r[0]; }
    if (!fen || new Chess(fen).isGameOver()) continue;
    if (new Chess(fen).board().flat().filter(Boolean).length < 6) continue;  // not a bare-bones ending
    let a; try { a = await analyse(fen, { depth: 10, movetime: 500 }); } catch { continue; }
    const c = userChances(a);
    const fits = step.mode === "convert" ? c >= Math.min(97, step.keep + 10) && c < 100 : c >= step.keep + 5 && c <= 75;
    if (fits) out.push({ row, fen, start: c });
  }
  return out;
}

// resolves to a score: 1 clean, 0.5 finished after take-backs, 0 skipped
export async function runEngineGame(board, pos, step, title, alive) {
  const you = stm(pos.fen) === "w" ? "b" : "w";  // after the solution it is the opponent's turn
  let fen = pos.fen, slips = 0, yourMoves = 0, last = null, chances = pos.start;
  const goalText = step.mode === "convert" ? "convert the advantage" : "hold the position";
  board.ui.title(title);
  board.ui.prompt(`You are ${colorName(you)}: ${goalText}`);
  board.ui.actions([]);
  const bar = () => {
    board.ui.extra.innerHTML = `<div class="meter" role="img" aria-label="Your chances ${chances} percent, line at ${step.keep}">
      <i style="width:${chances}%"></i><b style="left:${step.keep}%"></b></div>
      <p class="small dim" style="margin:6px 0 0">Your chances (Stockfish): <b class="mono">${chances}%</b> · keep above ${step.keep}% · move ${Math.min(yourMoves + 1, step.moves)} of ${step.moves}</p>`;
  };
  bar();
  board.set({ fen, orientation: you === "w" ? "white" : "black", interactive: false, last: null, marks: [], animate: false });
  board.ui.msg(step.mode === "convert" ? "You've just won material in a real game. Stockfish takes the other side and fights back." : "You've just found the defence in a real game. Now Stockfish keeps pressing.");
  const engineMove = async () => {
    const a = await analyse(fen, { depth: 12, movetime: 600 });
    if (!a.best) return null;
    const r = playUci(fen, a.best);
    fen = r[0]; last = [a.best.slice(0, 2), a.best.slice(2, 4)];
    board.set({ fen, last, interactive: false });
    return r[1];
  };
  await sleep(700);
  let san = await engineMove();
  board.ui.msg(`Stockfish played <b class="mono">${esc(san)}</b>. Your move.`);
  for (;;) {
    if (!alive()) return 0;
    const g = new Chess(fen);
    if (g.isGameOver()) {
      board.ui.msg(g.isCheckmate() ? "You were checkmated." : "The game ended in a draw.", "bad");
      return 0;
    }
    board.set({ fen, interactive: true, last });
    board.ui.actions(slips ? [["Skip", () => board.onMove("__skip")]] : []);
    const uci = await waitMove(board);
    if (uci === "__skip") return 0;
    board.ui.actions([]);
    const before = fen;
    const r = playUci(before, uci);
    const after = r[0];
    board.ui.msg(`<b class="mono">${esc(r[1])}</b> · Stockfish is checking…`);
    const ga = new Chess(after);
    let c;
    if (ga.isCheckmate()) c = 100;
    else if (ga.isDraw()) c = 50;
    else { const a = await analyse(after, { depth: 12, movetime: 700 }); c = userChances(a); }
    if (c < step.keep) {
      slips++;
      board.ui.wrong();
      const b = await analyse(before, { depth: 12, movetime: 700 }).catch(() => null);
      chances = c; bar();
      board.ui.msg(`<b class="mono">${esc(r[1])}</b> drops your chances to ${c}%. ${b?.best ? `Stockfish preferred <b class="mono">${esc(sanOf(before, b.best))}</b>.` : ""} Take it back and try again.`, "bad");
      await waitClick(board, "Take back");
      fen = before; board.set({ fen, interactive: false, last });
      continue;
    }
    fen = after; last = [uci.slice(0, 2), uci.slice(2, 4)]; chances = c; yourMoves++;
    bar();
    if (ga.isCheckmate()) { board.ui.msg("Checkmate. Converted.", "good"); break; }
    if (ga.isDraw()) {
      if (step.mode === "hold") { board.ui.msg("A draw: held.", "good"); break; }
      board.ui.msg("That's a draw, and you were winning.", "bad"); return 0;
    }
    if (yourMoves >= step.moves) {
      board.ui.msg(step.mode === "convert" ? `${step.moves} moves and still ${c}%: the advantage is safe. Converted.` : `${step.moves} moves held at ${c}%. That's real defence.`, "good");
      break;
    }
    board.ui.msg(`<b class="mono">${esc(r[1])}</b> ✓ <span class="soft">Stockfish is thinking…</span>`);
    san = await engineMove();
    if (san === null) break;
    board.ui.msg(`Stockfish played <b class="mono">${esc(san)}</b>.`);
  }
  board.set({ fen, interactive: false, last });
  return slips === 0 ? 1 : 0.5;
}

// ---------------- step: positional choice (real positions, Stockfish-checked) ----------------
// `item`: {fen, good: [uci], best (centipawns for the side to move), played (the move in the real game), pv}
// A move outside the stored list is checked by Stockfish on the device and accepted if it's about as good.
export async function runChoice(board, item, { title = "", exam = false, prompt = "" } = {}) {
  const side = stm(item.fen);
  board.ui.title(title);
  board.ui.prompt(`${colorName(side)} to move${prompt ? `: ${prompt}` : ""}`);
  board.ui.extra.innerHTML = "";
  board.ui.actions([]);
  board.set({ fen: item.fen, orientation: side === "w" ? "white" : "black", interactive: true, last: null, marks: [], animate: false });
  board.ui.msg(exam ? "Find a good move." : "A real position, just before one player went wrong. Find a move that keeps the balance.");
  const uci = await waitMove(board);
  const r = playUci(item.fen, uci);
  let ok = item.good.includes(uci), note = "";
  if (!ok && uci !== item.played) {
    board.ui.msg(`<b class="mono">${esc(r[1])}</b> · Stockfish is checking…`);
    try {
      const g = new Chess(r[0]);
      const a = g.isCheckmate() ? { mate: -1, cp: null } : await analyse(r[0], { depth: 12, movetime: 800 });
      const mine = a.mate != null ? (a.mate < 0 ? 10000 : -10000) : -a.cp;  // from the mover's side
      if (mine >= item.best - 45) { ok = true; note = " Stockfish rates it about as good as its own choice."; }
    } catch { /* engine unavailable: judge by the stored list only */ }
  }
  const bestSan = sanOf(item.fen, item.good[0]);
  const line = lineText(item.fen, item.pv.slice(0, 4));
  if (ok) {
    board.ui.msg(`<b class="mono">${esc(r[1])}</b> keeps the balance.${note} ${item.good.length > 1 ? `<span class="soft">Stockfish's moves: ${item.good.map(u => esc(sanOf(item.fen, u))).join(", ")}.</span>` : ""}`, "good");
  } else {
    board.ui.wrong();
    const real = uci === item.played ? " That is the move played in the real game, and it was the mistake." : ` In the real game, ${esc(sanOf(item.fen, item.played))} was played, also a mistake.`;
    board.ui.msg(`<b class="mono">${esc(r[1])}</b> lets the position slip.${real} <span class="soft">Better was <b class="mono">${esc(bestSan)}</b>: <span class="mono">${esc(line)}</span></span>`, "bad");
    if (!exam) addReview("c:" + item.id, "choice", item);
  }
  await sleep(250);
  board.set({ fen: r[0], interactive: false, last: [uci.slice(0, 2), uci.slice(2, 4)] });
  return ok;
}

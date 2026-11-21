// Game review on the phone, and the practice it feeds:
//   mistakes   every move of yours that lost 10+ winning chances (Lichess's inaccuracy line), with the better move
//   tactics    the mistakes where the better move was forcing (a check, a capture or a mate): the shots you missed
//   openings   a repertoire from your own games: in each position you reached, your usual move if it holds up,
//              Stockfish's move where yours didn't; drilled against the replies your opponents actually played
import { Chess } from "./vendor/chess.js";
import { analyse, winPct } from "./engine.js";

export const DEPTH = 12;
export const INACCURACY = 10, MISTAKE = 20, BLUNDER = 30;  // lost winning chances (percentage points)
const OPENING_PLIES = 24;  // the first 12 moves

export const keyOf = fen => fen.split(" ").slice(0, 4).join(" ");

function sanOf(fen, uci) {
  try { const g = new Chess(fen); return g.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san; }
  catch { return uci; }
}
function pvSans(fen, pv, n = 6) {
  const g = new Chess(fen), out = [];
  for (const u of (pv || []).slice(0, n)) {
    try { out.push(g.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san); } catch { break; }
  }
  return out;
}

// evaluate every position of the game; returns the review (null if stopped)
export async function reviewGame(game, { onPly = () => {}, shouldStop = () => false } = {}) {
  const g = new Chess();
  const fens = [g.fen()];
  for (const u of game.uci) { g.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); fens.push(g.fen()); }
  const evals = [];  // from the side to move in that position
  for (let i = 0; i < fens.length; i++) {
    if (shouldStop()) return null;
    const pos = new Chess(fens[i]);
    if (pos.isCheckmate()) evals.push({ cp: null, mate: 0, best: null, pv: [] });
    else if (pos.isDraw() || pos.isStalemate()) evals.push({ cp: 0, mate: null, best: null, pv: [] });
    else evals.push(await analyse(fens[i], { depth: DEPTH }));
    onPly(i + 1, fens.length);
  }
  const mineFirst = game.color === "white" ? 0 : 1;
  const moves = [];
  let accSum = 0, accN = 0;
  for (let i = mineFirst; i < game.uci.length; i += 2) {
    const before = evals[i], after = evals[i + 1];
    const wb = winPct(before.cp, before.mate);
    // after my move it is the opponent's turn: their score, turned round; a mate given (mate 0) is a win for me
    const wa = after.mate === 0 ? 100 : 100 - winPct(after.cp, after.mate);
    const loss = Math.max(0, wb - wa);
    accSum += Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * loss) - 3.1669));
    accN++;
    const played = game.uci[i];
    if (loss < INACCURACY || !before.best || before.best === played) continue;
    const fen = fens[i];
    const bestSan = sanOf(fen, before.best);
    const line = pvSans(fen, before.pv);
    // a tactic: you had a forcing shot (a mate, or a check or capture) that would have won something, i.e. the
    // position was already in your favour; a plain recapture you missed in an equal position is a mistake, not a tactic
    const forcing = (before.mate != null && before.mate > 0) || (/[x+#]/.test(bestSan) && wb >= 62);
    moves.push({
      ply: i, move: Math.floor(i / 2) + 1, fen, played, playedSan: game.sans[i], best: before.best, bestSan, line,
      winBefore: Math.round(wb), winAfter: Math.round(wa), loss: Math.round(loss),
      kind: loss >= BLUNDER ? "blunder" : loss >= MISTAKE ? "mistake" : "inaccuracy",
      tactic: forcing && loss >= MISTAKE, missedWin: wb >= 75 && wa < 60,
      phase: i < OPENING_PLIES ? "opening" : (new Chess(fen).board().flat().filter(p => p && p.type !== "p" && p.type !== "k").length <= 6 ? "endgame" : "middlegame"),
    });
  }
  // the best move in every position of yours in the opening (for the repertoire from your games)
  const book = {};
  for (let i = mineFirst; i < Math.min(game.uci.length, OPENING_PLIES); i += 2) {
    const e = evals[i], wb = winPct(e.cp, e.mate);
    const a = evals[i + 1], wa = a.mate === 0 ? 100 : 100 - winPct(a.cp, a.mate);
    if (e.best) book[keyOf(fens[i])] = { best: e.best, bestSan: sanOf(fens[i], e.best), win: Math.round(wb), playedLoss: Math.round(Math.max(0, wb - wa)) };
  }
  return { v: 1, depth: DEPTH, accuracy: accN ? Math.round(accSum / accN * 10) / 10 : null, moves, book,
           evals: evals.map(e => e.mate != null ? { m: e.mate } : { c: e.cp }) };
}

// practice positions from all reviews: {id, fen, color, kind, tactic, phase, bestSan, best, playedSan, line, game info}
export function practiceItems(games, reviews) {
  const out = [];
  for (const g of games) {
    const r = reviews[g.id];
    if (!r) continue;
    for (const m of r.moves) {
      if (m.kind === "inaccuracy" && !m.tactic) continue;  // drill mistakes and blunders; inaccuracies stay in the review
      out.push({ id: `${g.id}#${m.ply}`, gameId: g.id, fen: m.fen, color: g.color, kind: m.kind, tactic: m.tactic,
                 missedWin: m.missedWin, phase: m.phase, best: m.best, bestSan: m.bestSan, played: m.played,
                 playedSan: m.playedSan, line: m.line, loss: m.loss, winBefore: m.winBefore, move: m.move, t: g.t, opp: g.color === "white" ? g.black : g.white,
                 opening: g.opening });
    }
  }
  return out.sort((a, b) => b.t - a.t || b.loss - a.loss);
}

// A drillable pack (same format as the computer's phone packs) of your openings as you play them, fixed by Stockfish.
export function openingsPack(games, reviews, color) {
  const mine = games.filter(g => g.color === color && reviews[g.id]);
  if (mine.length < 3) return null;
  const pos = new Map();  // key -> {fen, my: {uci: n}, theirs: {uci: n}}
  const best = {};
  for (const g of mine) {
    Object.assign(best, reviews[g.id].book);
    const b = new Chess();
    for (let i = 0; i < Math.min(g.uci.length, OPENING_PLIES); i++) {
      const fen = b.fen(), k = keyOf(fen), u = g.uci[i];
      const p = pos.get(k) || { fen, my: {}, theirs: {} };
      const isMine = (i % 2 === 0) === (color === "white");
      (isMine ? p.my : p.theirs)[u] = ((isMine ? p.my : p.theirs)[u] || 0) + 1;
      pos.set(k, p);
      b.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
    }
  }
  // your move in each position: the one you play most, unless it lost 10+ winning chances; then Stockfish's
  const nodes = [], index = new Map(), fixes = [];
  const nodeFor = fen => {
    const k = keyOf(fen);
    if (index.has(k)) return index.get(k);
    index.set(k, nodes.length);
    nodes.push({ k, fen });
    return nodes.length - 1;
  };
  const todo = [nodeFor(new Chess().fen())];
  const seen = new Set();
  while (todo.length) {
    const i = todo.pop();
    if (seen.has(i)) continue;
    seen.add(i);
    const n = nodes[i], p = pos.get(n.k);
    if (!p) continue;
    const turnMine = n.fen.split(" ")[1] === (color === "white" ? "w" : "b");
    if (turnMine) {
      const usual = Object.entries(p.my).sort((a, b) => b[1] - a[1])[0];
      const bk = best[n.k];
      if (!usual && !bk) continue;
      let uci = usual ? usual[0] : bk.best, note = "your move";
      if (bk && usual && usual[0] !== bk.best) {
        // was your usual move a real loss here? (measured when you played it)
        const lost = mine.some(g => reviews[g.id].moves.some(m => keyOf(m.fen) === n.k && m.played === usual[0] && m.loss >= INACCURACY));
        if (lost) { uci = bk.best; note = "fixed"; n.was = sanOf(n.fen, usual[0]); fixes.push({ from: n.was, to: bk.bestSan }); }
      }
      const g = new Chess(n.fen);
      let m;
      try { m = g.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); } catch { continue; }
      const c = nodeFor(g.fen());
      n.m = [uci, m.san, c];
      todo.push(c);
    } else {
      const reps = [];
      for (const [u, cnt] of Object.entries(p.theirs)) {
        const g = new Chess(n.fen);
        let m;
        try { m = g.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); } catch { continue; }
        const c = nodeFor(g.fen());
        reps.push([u, m.san, cnt, c]);
        todo.push(c);
      }
      if (reps.length) n.r = reps;
    }
  }
  // drop replies that lead nowhere you have a move (keeps the drill to lines you've actually played)
  const hasMine = i => !!nodes[i].m;
  for (const n of nodes) if (n.r) { n.r = n.r.filter(r => hasMine(r[3])); if (!n.r.length) delete n.r; }
  for (const n of nodes) delete n.fen;
  const positions = nodes.filter(n => n.m).length;
  if (!positions) return null;
  return { v: 1, id: `GAMES-${color}`, label: `Your ${color === "white" ? "White" : "Black"} openings`, color, kind: "games",
           start: [], nodes, fixes, positions, games: mine.length };
}

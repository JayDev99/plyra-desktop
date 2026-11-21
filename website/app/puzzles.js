// Puzzles from the Lichess puzzle database (CC0, database.lichess.org): a quality-picked subset served in rating bands
// (puzzles/<band>.json, band = rating rounded down to 100), loaded on demand and kept on the phone.
// Row format: [id, fen, moves (uci, space-separated; the first move is the opponent's), rating, themes, opening tag]
import * as svc from "./sync.js";

export const THEME_NAMES = {
  opening: "Opening", middlegame: "Middlegame", endgame: "Endgame",
  rookEndgame: "Rook endgames", pawnEndgame: "Pawn endgames", queenEndgame: "Queen endgames",
  bishopEndgame: "Bishop endgames", knightEndgame: "Knight endgames", queenRookEndgame: "Queen and rook endgames",
  mateIn1: "Mate in 1", mateIn2: "Mate in 2", mateIn3: "Mate in 3", mateIn4: "Mate in 4", mateIn5: "Mate in 5+", mate: "Checkmate",
  fork: "Fork", pin: "Pin", skewer: "Skewer", discoveredAttack: "Discovered attack", doubleCheck: "Double check",
  deflection: "Deflection", attraction: "Attraction", interference: "Interference", clearance: "Clearance",
  xRayAttack: "X-ray attack", sacrifice: "Sacrifice", quietMove: "Quiet move", defensiveMove: "Defensive move",
  zugzwang: "Zugzwang", trappedPiece: "Trapped piece", hangingPiece: "Hanging piece", capturingDefender: "Capture the defender",
  intermezzo: "Intermezzo", backRankMate: "Back-rank mate", smotheredMate: "Smothered mate", anastasiaMate: "Anastasia's mate",
  arabianMate: "Arabian mate", hookMate: "Hook mate", dovetailMate: "Dovetail mate", bodenMate: "Boden's mate",
  doubleBishopMate: "Double bishop mate", promotion: "Promotion", underPromotion: "Underpromotion",
  advancedPawn: "Advanced pawn", kingsideAttack: "Kingside attack", queensideAttack: "Queenside attack",
  exposedKing: "Exposed king", equality: "Save the game", advantage: "Win an advantage", crushing: "Crush",
  enPassant: "En passant", castling: "Castling",
};
export const PHASES = ["opening", "middlegame", "endgame"];
export const ENDGAMES = ["pawnEndgame", "rookEndgame", "bishopEndgame", "knightEndgame", "queenEndgame", "queenRookEndgame"];
export const MOTIFS = ["fork", "pin", "skewer", "discoveredAttack", "doubleCheck", "deflection", "attraction", "sacrifice",
  "hangingPiece", "trappedPiece", "capturingDefender", "intermezzo", "quietMove", "defensiveMove", "clearance",
  "interference", "xRayAttack", "zugzwang", "advancedPawn", "promotion", "exposedKing", "kingsideAttack"];
export const MATES = ["mateIn1", "mateIn2", "mateIn3", "mateIn4", "mateIn5", "backRankMate", "smotheredMate",
  "anastasiaMate", "arabianMate", "hookMate", "bodenMate", "doubleBishopMate", "dovetailMate"];

const BASE = "puzzles/";
let index = null;
const bands = new Map();

export async function loadIndex() {
  if (index) return index;
  try { index = await (await fetch(BASE + "index.json")).json(); await svc.kvSet("pz/index", index); }
  catch { index = await svc.kvGet("pz/index"); }
  if (!index) throw new Error("Puzzles need a connection the first time.");
  return index;
}

async function loadBand(b) {
  if (bands.has(b)) return bands.get(b);
  let rows = null;
  try { rows = await (await fetch(`${BASE}${b}.json`)).json(); svc.kvSet(`pz/${b}`, rows); }
  catch { rows = await svc.kvGet(`pz/${b}`); }
  if (!rows) throw new Error("This set isn't on the phone yet; connect once to get it.");
  bands.set(b, rows);
  return rows;
}

export function parse(row) {
  return { id: row[0], fen: row[1], moves: row[2].split(" "), rating: row[3], themes: row[4] ? row[4].split(" ") : [], opening: row[5] || "" };
}

const bandOf = r => Math.min(2900, Math.max(400, Math.floor(r / 100) * 100));

// a puzzle near `rating` (optionally with a theme) that you haven't seen lately
export async function pick({ rating = 1500, theme = null, spread = 150 } = {}) {
  const idx = await loadIndex();
  const seen = new Set((await svc.kvGet("pz/seen")) || []);
  let lo = bandOf(rating - spread), hi = bandOf(rating + spread);
  for (let widen = 0; widen < 12; widen++) {
    const cands = [];
    for (let b = lo; b <= hi; b += 100) {
      if (!idx.bands[b] || (theme && !idx.themes[theme]?.[b])) continue;
      const rows = await loadBand(b);
      for (const r of rows) {
        if (seen.has(r[0])) continue;
        if (theme && !(" " + r[4] + " ").includes(" " + theme + " ")) continue;
        if (Math.abs(r[3] - rating) > spread + widen * 100) continue;
        cands.push(r);
      }
    }
    if (cands.length) return parse(cands[Math.floor(Math.random() * cands.length)]);
    lo = Math.max(400, lo - 100); hi = Math.min(2900, hi + 100);
  }
  // everything nearby seen: start over on the seen list
  await svc.kvSet("pz/seen", []);
  return null;
}

export async function markSeen(id) {
  const seen = (await svc.kvGet("pz/seen")) || [];
  seen.push(id);
  await svc.kvSet("pz/seen", seen.slice(-4000));
}

// your puzzle rating: Elo with a K that settles as you play
export async function rating() {
  return (await svc.kvGet("pz/rating")) || { r: 1500, n: 0, streak: 0, best: 1500, history: [] };
}
export async function rate(puzzleRating, solved) {
  const me = await rating();
  const k = Math.max(16, 64 - me.n * 1.5);
  const exp = 1 / (1 + 10 ** ((puzzleRating - me.r) / 400));
  const delta = Math.round(k * ((solved ? 1 : 0) - exp));
  me.r = Math.max(400, me.r + delta);
  me.n++;
  me.streak = solved ? me.streak + 1 : 0;
  me.best = Math.max(me.best, me.r);
  me.history = [...(me.history || []), [Math.round(Date.now() / 1000), me.r]].slice(-500);
  await svc.kvSet("pz/rating", me);
  return { ...me, delta };
}

// ---- the Woodpecker Method: one fixed set, solved in cycles, each cycle in about half the time of the last ----
export const WOODPECKER_LEVELS = [
  { id: "easy", label: "Easy", min: 900, max: 1400 },
  { id: "intermediate", label: "Intermediate", min: 1300, max: 1800 },
  { id: "advanced", label: "Advanced", min: 1700, max: 2200 },
  { id: "expert", label: "Expert", min: 2100, max: 2700 },
];

export async function newWoodpecker(levelId, size) {
  const lvl = WOODPECKER_LEVELS.find(l => l.id === levelId);
  const idx = await loadIndex();
  const pool = [];
  for (let b = bandOf(lvl.min); b <= bandOf(lvl.max); b += 100) {
    if (!idx.bands[b]) continue;
    pool.push(...(await loadBand(b)).filter(r => r[3] >= lvl.min && r[3] <= lvl.max));
  }
  // spread over the whole range and over themes: shuffle, then take evenly by rating
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const chosen = pool.slice(0, size).sort((a, b) => a[3] - b[3]);
  const set = { id: "wp-" + Date.now(), level: lvl.id, label: `${lvl.label} · ${chosen.length} puzzles`, created: Date.now(),
                puzzles: chosen, cycles: [{ start: null, ms: 0, done: [], right: 0 }] };
  await svc.kvSet("wp/set", set);
  return set;
}
export async function woodpecker() { return svc.kvGet("wp/set"); }
export async function saveWoodpecker(set) { await svc.kvSet("wp/set", set); }
export function cycleTarget(set) {
  const n = set.cycles.length;
  if (n < 2) return null;
  return Math.round(set.cycles[n - 2].ms / 2);
}

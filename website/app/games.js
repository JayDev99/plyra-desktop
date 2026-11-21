// Your games from Chess.com and Lichess, straight from their public APIs (no Plyra account needed).
// Each game is stored as {id, platform, url, color, white, black, rating, oppRating, result, t, speed, opening, uci, sans}.
import { Chess } from "./vendor/chess.js";

const SPEEDS = { ultraBullet: "bullet", bullet: "bullet", blitz: "blitz", rapid: "rapid", classical: "classical",
                 correspondence: "daily", daily: "daily" };
const CC_DRAWS = new Set(["agreed", "repetition", "stalemate", "insufficient", "50move", "timevsinsufficient"]);

async function getJson(url, opts) {
  let r;
  try { r = await fetch(url, opts); } catch { throw new Error("Couldn't reach the server. Check your connection."); }
  if (r.status === 404) throw new Error("No such player.");
  if (r.status === 429) throw new Error("The site is busy (too many requests). Try again in a minute.");
  if (!r.ok) throw new Error(`The site answered ${r.status}.`);
  return r;
}

function movesFrom(sans) {
  const g = new Chess();
  const uci = [], out = [];
  for (const s of sans) {
    let m;
    try { m = g.move(s); } catch { break; }
    uci.push(m.from + m.to + (m.promotion || ""));
    out.push(m.san);
  }
  return { uci, sans: out };
}

function ccOpening(pgn) {
  const url = (pgn.match(/\[ECOUrl "([^"]+)"\]/) || [])[1];
  if (!url) return (pgn.match(/\[Opening "([^"]+)"\]/) || [])[1] || "";
  const slug = decodeURIComponent(url.split("/openings/")[1] || "");
  // "Sicilian-Defense-Najdorf-Variation-6.Be3" -> "Sicilian Defense Najdorf Variation"
  return slug.replace(/-\d+\..*$/, "").replace(/-/g, " ").replace(/\s+\.\.\..*$/, "").trim();
}

function family(name) {
  // "Sicilian Defense Najdorf Variation English Attack" -> "Sicilian Defense"; "Queen's Gambit Declined" stays
  const m = String(name || "").match(/^(.*?(?:Opening|Defense|Defence|Gambit|Game|Attack|System|Indian(?! (?:Game|Defense|Defence))|Variation))\b/);
  return (m ? m[1] : String(name || "").split(/[:,]/)[0]).replace(/\s+Variation$/, "").trim() || "Other";
}

export async function chesscom(username, { months = 3, onProgress = () => {} } = {}) {
  const u = username.trim().toLowerCase();
  const arch = await (await getJson(`https://api.chess.com/pub/player/${encodeURIComponent(u)}/games/archives`)).json();
  const urls = (arch.archives || []).slice(-months).reverse();
  const games = [];
  for (const [i, url] of urls.entries()) {
    onProgress(i + 1, urls.length);
    const data = await (await getJson(url)).json();
    for (const g of data.games || []) {
      if (g.rules !== "chess" || !g.pgn) continue;
      const color = g.white.username.toLowerCase() === u ? "white" : "black";
      const me = g[color], opp = g[color === "white" ? "black" : "white"];
      const body = g.pgn.split(/\n\n/).slice(1).join(" ");
      const sans = body.replace(/\{[^}]*\}/g, " ").replace(/\(\s*[^)]*\)/g, " ").replace(/\d+\.(\.\.)?/g, " ")
        .replace(/(1-0|0-1|1\/2-1\/2|\*)\s*$/, " ").split(/\s+/).filter(Boolean);
      const { uci, sans: clean } = movesFrom(sans);
      if (uci.length < 8) continue;
      const opening = ccOpening(g.pgn);
      games.push({
        id: "cc:" + (g.uuid || g.url), platform: "chess.com", url: g.url, color,
        white: g.white.username, black: g.black.username, rating: me.rating, oppRating: opp.rating,
        result: me.result === "win" ? "win" : CC_DRAWS.has(me.result) ? "draw" : "loss",
        t: g.end_time, speed: g.time_class, opening, family: family(opening), uci, sans: clean,
      });
    }
  }
  return games.sort((a, b) => b.t - a.t);
}

export async function lichess(username, { max = 100 } = {}) {
  const u = username.trim();
  const r = await getJson(`https://lichess.org/api/games/user/${encodeURIComponent(u)}?max=${max}&opening=true&moves=true&perfType=bullet,blitz,rapid,classical,correspondence`,
    { headers: { Accept: "application/x-ndjson" } });
  const text = await r.text();
  const games = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let g;
    try { g = JSON.parse(line); } catch { continue; }
    if (g.variant !== "standard" || !g.moves || ["aborted", "noStart", "created", "started"].includes(g.status)) continue;
    const wn = g.players?.white?.user?.name || "", bn = g.players?.black?.user?.name || "";
    const color = wn.toLowerCase() === u.toLowerCase() ? "white" : "black";
    const { uci, sans } = movesFrom(g.moves.split(" "));
    if (uci.length < 8) continue;
    const opening = g.opening?.name || "";
    games.push({
      id: "li:" + g.id, platform: "lichess", url: `https://lichess.org/${g.id}`, color, white: wn, black: bn,
      rating: g.players?.[color]?.rating, oppRating: g.players?.[color === "white" ? "black" : "white"]?.rating,
      result: g.winner ? (g.winner === color ? "win" : "loss") : (["draw", "stalemate"].includes(g.status) ? "draw" : "loss"),
      t: Math.round((g.lastMoveAt || g.createdAt) / 1000), speed: SPEEDS[g.speed] || g.speed, opening,
      family: family(opening.split(":")[0]), uci, sans,
    });
  }
  return games;
}

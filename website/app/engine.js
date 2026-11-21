// Stockfish on the phone: Stockfish 19 (lite NNUE, single-threaded) compiled to WebAssembly, in a Web Worker.
// One search at a time; callers queue. The engine starts on first use and is kept for the session.
const ENGINE_URL = "engine/stockfish-19-lite-single.js";

let worker = null, ready = null, busy = Promise.resolve();

function start() {
  if (ready) return ready;
  worker = new Worker(ENGINE_URL);
  ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("The engine didn't start.")), 30000);
    worker.onmessage = e => {
      if (String(e.data) === "uciok") { worker.postMessage("isready"); }
      if (String(e.data) === "readyok") { clearTimeout(t); resolve(); }
    };
    worker.onerror = err => { clearTimeout(t); reject(err); };
    worker.postMessage("uci");
    worker.postMessage("setoption name Hash value 32");
  });
  ready.catch(() => { ready = null; worker?.terminate(); worker = null; });
  return ready;
}

// {cp | mate} from the side to move, best (uci), pv (uci list), depth
export function analyse(fen, { depth = 12, movetime = 700 } = {}) {
  const job = busy.then(async () => {
    await start();
    return new Promise(resolve => {
      let last = null;
      worker.onmessage = e => {
        const line = String(e.data);
        if (line.startsWith("info") && line.includes(" pv ") && !line.includes(" multipv 2")) {
          const d = +(line.match(/ depth (\d+)/) || [])[1];
          const cp = line.match(/ score cp (-?\d+)/), mate = line.match(/ score mate (-?\d+)/);
          const pv = line.split(" pv ")[1].trim().split(/\s+/);
          if (cp || mate) last = { depth: d, cp: cp ? +cp[1] : null, mate: mate ? +mate[1] : null, pv };
        } else if (line.startsWith("bestmove")) {
          const best = line.split(/\s+/)[1];
          resolve({ ...(last || { cp: 0, mate: null, pv: [] }), best: best && best !== "(none)" ? best : null });
        }
      };
      worker.postMessage("ucinewgame");
      worker.postMessage(`position fen ${fen}`);
      worker.postMessage(`go depth ${depth} movetime ${movetime}`);
    });
  });
  busy = job.catch(() => {});
  return job;
}

export function stop() {
  if (worker) { worker.terminate(); worker = null; ready = null; busy = Promise.resolve(); }
}

// Lichess's conversion from engine score to winning chances (0..100) for the side the score is for
export function winPct(cp, mate) {
  if (mate != null) return mate > 0 ? 100 : 0;
  const c = Math.max(-1500, Math.min(1500, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
}

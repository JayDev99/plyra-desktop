// Plyra phone board: touch-first (tap a piece, tap a square; or drag), pieces slide to their squares.
// Legal moves come from chess.js. The board never decides whether a move is "right": it reports the move.
import { Chess } from "./vendor/chess.js";

const FILES = "abcdefgh";
const SLIDE_MS = 190;

export class Board {
  constructor(el, { onMove } = {}) {
    this.el = el;
    this.onMove = onMove || (() => {});
    this.orientation = "white";
    this.fen = new Chess().fen();
    this.interactive = false;
    this.last = null;           // [from, to]
    this.selected = null;
    this.shown = {};            // square -> piece code drawn now (for sliding)
    this.el.classList.add("board");
    this.el.setAttribute("role", "grid");
    this.el.setAttribute("aria-label", "Chess board");
    this._build();
    this._bindPointer();
  }

  _build() {
    this.el.innerHTML = "";
    this.sq = {};
    for (let i = 0; i < 64; i++) {
      const d = document.createElement("div");
      d.className = "sq";
      this.el.appendChild(d);
    }
    this.layer = document.createElement("div");
    this.layer.className = "pieces";
    this.el.appendChild(this.layer);
    this.promo = document.createElement("div");
    this.promo.className = "promo";
    this.promo.hidden = true;
    this.el.appendChild(this.promo);
  }

  squareAt(i) {  // grid index 0..63 (top-left first) -> square name for the current orientation
    const r = Math.floor(i / 8), c = i % 8;
    return this.orientation === "white" ? FILES[c] + (8 - r) : FILES[7 - c] + (r + 1);
  }

  _xy(sq) {  // square -> [col, row] on screen
    const f = FILES.indexOf(sq[0]), rk = +sq[1];
    return this.orientation === "white" ? [f, 8 - rk] : [7 - f, rk - 1];
  }

  set({ fen, orientation, interactive, last, animate = true } = {}) {
    const flip = orientation && orientation !== this.orientation;
    if (orientation) this.orientation = orientation;
    if (fen) this.fen = fen;
    if (interactive !== undefined) this.interactive = interactive;
    this.last = last || null;
    this.selected = null;
    this._draw(animate && !flip);
  }

  _pieces() {
    const out = {};
    new Chess(this.fen).board().forEach((row, r) => row.forEach((p, c) => {
      if (p) out[FILES[c] + (8 - r)] = p.color + p.type.toUpperCase();
    }));
    return out;
  }

  _draw(animate) {
    const squares = this.el.querySelectorAll(".sq");
    const turn = this.fen.split(" ")[1];
    const legal = this.selected ? new Chess(this.fen).moves({ square: this.selected, verbose: true }) : [];
    const targets = new Set(legal.map(m => m.to));
    const pieces = this._pieces();
    const relabel = this._labelsFor !== this.orientation;
    squares.forEach((d, i) => {
      const sq = this.squareAt(i);
      const f = FILES.indexOf(sq[0]), rk = +sq[1];
      // a1 is a dark square (file a = 0, rank 1): dark when file index + rank is odd
      let cls = "sq " + ((f + rk) % 2 === 1 ? "dark" : "light");
      if (this.last && this.last.includes(sq)) cls += " last";
      if (this.selected === sq) cls += " sel";
      if (targets.has(sq)) cls += pieces[sq] ? " cap" : " dot";
      if (d.className !== cls) d.className = cls;  // untouched squares are not redrawn (no flicker)
      d.dataset.sq = sq;
      if (relabel) {
        d.innerHTML = "";
        const r = Math.floor(i / 8), c = i % 8;
        if (c === 0) d.insertAdjacentHTML("beforeend", `<span class="rank">${sq[1]}</span>`);
        if (r === 7) d.insertAdjacentHTML("beforeend", `<span class="file">${sq[0]}</span>`);
      }
    });
    this._labelsFor = this.orientation;

    // pieces: keep every piece element that is still on its square; a piece that moved reuses its own element and
    // slides; only captured pieces are removed and only new pieces (promotions) are created. Nothing is rebuilt.
    const old = this.imgs || {};
    const els = {};
    const used = new Set();
    const place = (img, sq, slide) => {
      const [x, y] = this._xy(sq);
      const t = `translate(${x * 100}%, ${y * 100}%)`;
      if (img.style.transform === t) return;
      if (slide) {
        img.classList.add("moving");
        img.style.transition = `transform ${SLIDE_MS}ms ease-out`;
        clearTimeout(img._t);
        img._t = setTimeout(() => { img.classList.remove("moving"); img.style.transition = "none"; }, SLIDE_MS + 30);
      } else img.style.transition = "none";
      img.style.transform = t;
    };
    for (const [sq, code] of Object.entries(pieces)) {        // 1. pieces that stayed put
      const img = old[sq];
      if (img && img.dataset.code === code) { els[sq] = img; used.add(img); place(img, sq, false); }
    }
    const pool = Object.entries(old).filter(([, img]) => !used.has(img));
    for (const [sq, code] of Object.entries(pieces)) {        // 2. pieces that moved here: nearest same piece
      if (els[sq]) continue;
      const [x1, y1] = this._xy(sq);
      let best = null, bd = 1e9;
      for (const [from, img] of pool) {
        if (used.has(img)) continue;
        const promo = img.dataset.code === code[0] + "P" && code[1] !== "P" && (sq[1] === "8" || sq[1] === "1");
        if (img.dataset.code !== code && !promo) continue;
        const [x0, y0] = this._xy(from);
        const dist = Math.hypot(x1 - x0, y1 - y0) + (promo ? 0.5 : 0);
        if (dist < bd) { bd = dist; best = img; }
      }
      if (best) {
        used.add(best);
        if (best.dataset.code !== code) { best.dataset.code = code; best.src = `pieces/${code}.svg`; }
        els[sq] = best;
        place(best, sq, animate);
        continue;
      }
      const img = document.createElement("img");            // 3. a new piece
      img.src = `pieces/${code}.svg`;
      img.alt = "";
      img.draggable = false;
      img.className = "pc";
      img.dataset.code = code;
      img.style.transition = "none";
      const [x, y] = this._xy(sq);
      img.style.transform = `translate(${x * 100}%, ${y * 100}%)`;
      this.layer.appendChild(img);
      els[sq] = img;
      used.add(img);
    }
    for (const [, img] of Object.entries(old)) if (!used.has(img)) img.remove();  // captured
    for (const [sq, img] of Object.entries(els)) {
      img.classList.remove("dragging");
      img.classList.toggle("own", !!(turn && pieces[sq][0] === turn && this.interactive));
    }
    this.shown = pieces;
    this.imgs = els;
  }

  _bindPointer() {
    let drag = null;
    const sqFromPoint = (x, y) => {
      const r = this.el.getBoundingClientRect();
      const c = Math.floor((x - r.left) / (r.width / 8)), w = Math.floor((y - r.top) / (r.height / 8));
      if (c < 0 || c > 7 || w < 0 || w > 7) return null;
      return this.squareAt(w * 8 + c);
    };
    this.el.addEventListener("pointerdown", e => {
      if (!this.interactive || !this.promo.hidden) return;
      const sq = sqFromPoint(e.clientX, e.clientY);
      if (!sq) return;
      const pieces = this.shown, turn = this.fen.split(" ")[1];
      if (this.selected && sq !== this.selected && !(pieces[sq] && pieces[sq][0] === turn)) {
        this._try(this.selected, sq);
        return;
      }
      if (pieces[sq] && pieces[sq][0] === turn) {
        this.selected = sq;
        this._draw(false);
        const img = this.imgs[sq];
        if (img) {
          drag = { sq, img, moved: false, x: e.clientX, y: e.clientY };
          this.el.setPointerCapture(e.pointerId);
        }
      } else if (this.selected) {
        this.selected = null;
        this._draw(false);
      }
    });
    this.el.addEventListener("pointermove", e => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 6) return;
      drag.moved = true;
      const size = this.el.getBoundingClientRect().width / 8;
      const [x, y] = this._xy(drag.sq);
      drag.img.classList.add("dragging");
      drag.img.style.transition = "none";
      drag.img.style.transform = `translate(${x * 100 + dx / size * 100}%, ${y * 100 + dy / size * 100}%) scale(1.15)`;
    });
    const end = e => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (!d.moved) return;  // a tap: the piece stays selected, the next tap chooses the square
      const to = sqFromPoint(e.clientX, e.clientY);
      if (to && to !== d.sq && this._try(d.sq, to, true)) return;
      this._draw(false);
    };
    this.el.addEventListener("pointerup", end);
    this.el.addEventListener("pointercancel", end);
  }

  _try(from, to, dropped = false) {
    const game = new Chess(this.fen);
    const options = game.moves({ square: from, verbose: true }).filter(m => m.to === to);
    if (!options.length) {
      this.selected = null;
      this._draw(false);
      return false;
    }
    if (options.some(m => m.promotion)) {
      this._askPromotion(from, to);
      return true;
    }
    this._play(from + to, dropped);
    return true;
  }

  _askPromotion(from, to) {
    const color = this.fen.split(" ")[1];
    this.promo.innerHTML = "";
    for (const p of ["q", "r", "b", "n"]) {
      const b = document.createElement("button");
      b.innerHTML = `<img src="pieces/${color}${p.toUpperCase()}.svg" alt="${p}">`;
      b.onclick = () => { this.promo.hidden = true; this._play(from + to + p, false); };
      this.promo.appendChild(b);
    }
    this.promo.hidden = false;
  }

  _play(uci, dropped) {
    const game = new Chess(this.fen);
    try {
      game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    } catch { return; }
    this.interactive = false;
    this.set({ fen: game.fen(), last: [uci.slice(0, 2), uci.slice(2, 4)], animate: !dropped, interactive: false });
    this.onMove(uci);
  }
}

// play a move on a FEN: [newFen, san] (null when illegal)
export function playUci(fen, uci) {
  const g = new Chess(fen);
  try {
    const m = g.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return [g.fen(), m.san];
  } catch { return null; }
}

export function startFen() { return new Chess().fen(); }

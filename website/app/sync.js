// Talks to Plyra's service (sign-in, account, sync) and keeps a local copy on the phone (works offline).
//
// The computers send phone-sized copies (pack/<book>, practice/main, progress/main); the phone sends back only
// drill progress (drill/<book> and drill/TACTICS), merged position by position exactly like between two computers.
export const GATEWAY = "https://plyra-chess-gateway.onrender.com";

// ---- tiny IndexedDB key-value store ----------------------------------------------------------------
const DB_NAME = "plyra-phone", STORE = "kv";
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
export async function kvGet(k, dflt = null) {
  try {
    const d = await db();
    return await new Promise((res, rej) => {
      const r = d.transaction(STORE).objectStore(STORE).get(k);
      r.onsuccess = () => res(r.result === undefined ? dflt : r.result);
      r.onerror = () => rej(r.error);
    });
  } catch { return dflt; }
}
export async function kvSet(k, v) {
  try {
    const d = await db();
    await new Promise((res, rej) => {
      const t = d.transaction(STORE, "readwrite");
      t.objectStore(STORE).put(v, k);
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
  } catch { /* private mode etc.: the app still works for this visit */ }
}
export async function kvDel(k) {
  try {
    const d = await db();
    await new Promise(res => { const t = d.transaction(STORE, "readwrite"); t.objectStore(STORE).delete(k); t.oncomplete = res; });
  } catch { /* ignore */ }
}

// ---- gzip (the computers store every synced item as gzipped JSON) ---------------------------------
async function gunzipJson(buf) {
  const s = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(s).text());
}
async function gzipJson(obj) {
  const s = new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// ---- the service ------------------------------------------------------------------------------------
export class ServiceError extends Error {
  constructor(msg, status, detail) { super(msg); this.status = status; this.detail = detail; }
}

async function call(method, path, { body, headers = {}, session } = {}) {
  const h = { ...headers };
  if (session) h["X-Session"] = session;
  let r;
  try {
    r = await fetch(GATEWAY + path, { method, headers: h, body });
  } catch {
    throw new ServiceError("You're offline, or Plyra's service can't be reached. Your practice is saved on this phone and syncs when you're back online.", 0);
  }
  if (r.ok) return r;
  let detail = null, msg = `Error ${r.status}`;
  try {
    const j = await r.json();
    detail = j.detail;
    msg = typeof detail === "string" ? detail : (detail && detail.message) || msg;
  } catch { /* not JSON */ }
  throw new ServiceError(msg, r.status, detail);
}

export async function startSignIn(email) {
  await call("POST", "/v1/auth/start", { body: JSON.stringify({ email }), headers: { "Content-Type": "application/json" } });
}

export async function verifySignIn(email, code, replaceDevice = null) {
  const name = /iPhone|iPad/.test(navigator.userAgent) ? "iPhone" : /Android/.test(navigator.userAgent) ? "Android phone" : "Phone";
  const r = await call("POST", "/v1/auth/verify", {
    body: JSON.stringify({ email, code, device_name: name, platform: "phone-web", replace_device: replaceDevice }),
    headers: { "Content-Type": "application/json" },
  });
  const j = await r.json();
  await kvSet("session", j.session_token);
  await kvSet("email", email);
  return j;
}

export async function session() { return kvGet("session"); }

export async function signOut() {
  const s = await session();
  if (s) { try { await call("POST", "/v1/auth/signout", { session: s }); } catch { /* signed out locally anyway */ } }
  for (const k of ["session", "email", "state", "account"]) await kvDel(k);
}

// a stable id for this phone (the service's free allowance for an account without a plan is per install)
async function installId() {
  let id = await kvGet("installId");
  if (!id) { id = "phone-" + crypto.getRandomValues(new Uint32Array(4)).join("-"); await kvSet("installId", id); }
  return id;
}

export async function account() {
  const s = await session();
  const r = await call("GET", "/v1/account", { session: s, headers: { "X-Instance-Id": await installId() } });
  const j = await r.json();
  await kvSet("account", j);
  return j;
}

export async function turnOnSync() {
  const s = await session();
  await call("POST", "/v1/auth/sync", { session: s, body: JSON.stringify({ enabled: true }), headers: { "Content-Type": "application/json" } });
}

async function getItem(kind, id) {
  const s = await session();
  try {
    const r = await call("GET", `/v1/sync/item/${kind}/${encodeURIComponent(id)}`, { session: s });
    return { payload: await gunzipJson(await r.arrayBuffer()), version: +(r.headers.get("X-Version") || 0) };
  } catch (e) {
    if (e.status === 404) return { payload: null, version: 0 };
    throw e;
  }
}

async function putItem(kind, id, payload, base) {
  const s = await session();
  try {
    const r = await call("PUT", `/v1/sync/item/${kind}/${encodeURIComponent(id)}`, {
      session: s, body: await gzipJson(payload),
      headers: { "X-Base-Version": String(base), "X-Meta": "{}", "Content-Type": "application/octet-stream" },
    });
    return (await r.json()).version;
  } catch (e) {
    if (e.status === 409) return null;
    throw e;
  }
}

// ---- pulling the computers' copies ------------------------------------------------------------------
// Returns {enabled, books: [{id, label, color, nodes}], practice: bool, progress: bool}
export async function pull(onProgress = () => {}) {
  const s = await session();
  const r = await call("GET", "/v1/sync/state", { session: s });
  const st = await r.json();
  if (!st.enabled) return { enabled: false };
  const items = st.items || [];
  const gone = new Set(items.filter(i => i.kind === "book" && i.deleted).map(i => i.id));
  const have = (await kvGet("versions")) || {};
  const books = [];
  const wanted = items.filter(i => !i.deleted && (i.kind === "pack" ? !gone.has(i.id) : ["practice", "progress", "drill"].includes(i.kind)));
  let n = 0;
  for (const it of wanted) {
    const key = `${it.kind}/${it.id}`;
    if (it.kind === "pack") books.push({ id: it.id, ...(it.meta || {}) });
    if (have[key] === it.version) continue;
    onProgress(++n, wanted.length);
    const { payload, version } = await getItem(it.kind, it.id);
    if (payload === null) continue;
    if (it.kind === "drill") {
      // merge the account's progress with anything practised on this phone that hasn't been sent yet
      const local = (await kvGet(key)) || {};
      await kvSet(key, mergeDrill(local, payload));
      await kvSet(key + "#base", version);
    } else {
      await kvSet(key, payload);
    }
    have[key] = version;
  }
  await kvSet("versions", have);
  await kvSet("books", books);
  await kvSet("lastPull", Date.now());
  return { enabled: true, books, practice: items.some(i => i.kind === "practice" && !i.deleted),
           progress: items.some(i => i.kind === "progress" && !i.deleted) };
}

// position by position, keep the record with more answers (then the later due date): same rule as the computers
export function mergeDrill(a, b) {
  const out = { ...b };
  for (const [k, v] of Object.entries(a || {})) {
    const o = out[k];
    const n = r => (r.right_count || 0) + (r.wrong_count || 0);
    if (!o || n(v) > n(o) || (n(v) === n(o) && (v.due || 0) >= (o.due || 0))) out[k] = v;
  }
  return out;
}

// ---- sending drill progress -------------------------------------------------------------------------
// Pending changes are kept per book until the service has them, so practising offline is safe.
export async function pushDrill(bookId) {
  const key = `drill/${bookId}`;
  const dirty = (await kvGet("dirty")) || {};
  if (!dirty[bookId]) return true;
  for (let attempt = 0; attempt < 3; attempt++) {
    const local = (await kvGet(key)) || {};
    const base = (await kvGet(key + "#base")) || 0;
    const v = await putItem("drill", bookId, local, base);
    if (v !== null) {
      await kvSet(key + "#base", v);
      const vers = (await kvGet("versions")) || {};
      vers[key] = v;
      await kvSet("versions", vers);
      delete dirty[bookId];
      await kvSet("dirty", dirty);
      return true;
    }
    // changed on a computer meanwhile: fetch, merge, try again
    const { payload, version } = await getItem("drill", bookId);
    await kvSet(key, mergeDrill(local, payload || {}));
    await kvSet(key + "#base", version);
  }
  return false;
}

export async function pushAll() {
  const dirty = (await kvGet("dirty")) || {};
  for (const id of Object.keys(dirty)) {
    try { await pushDrill(id); } catch { return false; }
  }
  return true;
}

export async function markDirty(bookId) {
  const dirty = (await kvGet("dirty")) || {};
  dirty[bookId] = Date.now();
  await kvSet("dirty", dirty);
}

// The Free plan's daily allowances (puzzles, missed tactics), counted on the server per account.
// consume=true uses one: {allowed, used, limit}. Offline: null (the caller falls back to a count kept on the phone).
export async function usage(kind, consume = false) {
  const s = await session();
  try {
    const r = await call("POST", "/v1/phone/usage", {
      session: s, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, consume, utc_offset_minutes: -new Date().getTimezoneOffset() }),
    });
    return await r.json();
  } catch (e) {
    if (e.status === 401) throw e;
    return null;
  }
}

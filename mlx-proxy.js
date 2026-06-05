import { createServer, request } from "http";
const {
  MLX_HOST = "host.docker.internal", MLX_PORT = 8080, MLX_PROXY_PORT = 8081, TZ = "UTC",
  OMLX_API_KEY = "", OMLX_HEADROOM_MB = "1024", OMLX_API_TIMEOUT_MS = "5000",
} = process.env;

const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, weekday: "long", year: "numeric", month: "long",
  day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  timeZoneName: "short",
});

// ---------------------------------------------------------------------------
// oMLX (jundot/omlx) memory management.
//
// Before proxying a request that names a model, ask oMLX which models are
// loaded and how much memory is free, and proactively unload other models so
// the requested one fits. All three oMLX calls are bearer-authed, so we just
// send OMLX_API_KEY:
//   GET  /v1/models/status       - per-model loaded/pinned/size/alias, AND the
//                                  whole-server final_ceiling + current_model_memory
//                                  (one snapshot => consistent memory accounting)
//   GET  /api/status             - server-wide active/waiting request counts (idle gate)
//   POST /v1/models/{id}/unload  - unload a model (immediate abort of its requests)
//
// Policy (per project requirements):
//   - Unload the least-recently-used *non-pinned* models, one at a time, only
//     until the requested model fits. Pinned models are never touched; if only
//     pinned models block the fit, we proxy as-is and let oMLX cope.
//   - Admit loads one at a time and reserve their memory. oMLX's reported usage
//     lags while a model loads (seconds), so two requests arriving together would
//     each see free RAM and both be waved through, overcommitting the ceiling. We
//     serialize admission and, once a model is admitted, count its size against
//     free RAM until oMLX reports it loaded — so the next admission sees the
//     pending load and unloads (or rejects) accordingly.
//   - NEVER abort an in-flight request, and NEVER wait. oMLX's unload is an
//     *immediate abort* of that model's requests, and oMLX reports work only
//     SERVER-WIDE (active_requests + waiting_requests in /api/status; no per-model
//     busy flag) — so the only safe time to unload is when the whole server is
//     idle. If a request needs memory freed and oMLX is doing ANY work, we reject
//     it (503) immediately rather than wait for a lull or interrupt the work; the
//     idle state is re-checked right before each unload to keep the window tiny.
//   - Fail closed: return 503 rather than risk an OOM or an aborted request when
//     either (a) the memory check itself can't be completed (oMLX unreachable,
//     bad/missing key, unexpected response, unknown model), or (b) room must be
//     freed but oMLX is busy. When the fit is impossible anyway (only pinned models
//     block it, or the model exceeds the ceiling) and the server is idle, we proxy
//     as-is and let oMLX render its verdict.
//
// Enabled only when OMLX_API_KEY is set. It also auto-detects oMLX: if the
// upstream doesn't expose the oMLX management API (the endpoints 404 — e.g. a
// plain mlx_lm.server), memory management disables itself and the proxy falls
// back to a plain pass-through (date/time injection only). Either way, a
// non-oMLX or unconfigured backend still works unchanged.
// ---------------------------------------------------------------------------
const MEMORY_MGMT = OMLX_API_KEY.length > 0;
const HEADROOM = Number(OMLX_HEADROOM_MB) * 1024 * 1024;
const REQ_TIMEOUT = Number(OMLX_API_TIMEOUT_MS);

// Serialize load-admission. Two requests arriving close together would otherwise
// each read oMLX's current memory, each see the model fits, and both get waved
// through — overcommitting the ceiling once both models load (a time-of-check/
// time-of-use race). Only admissions that may load/unload take this lock;
// requests for already-loaded models skip it, so serving latency is unaffected.
let admitChain = Promise.resolve();
const withAdmitLock = fn => {
  const run = admitChain.then(fn, fn);
  admitChain = run.then(() => {}, () => {}); // keep the chain alive past rejections
  return run;
};

// Memory the proxy has admitted for models that are loading but which oMLX's
// current_model_memory doesn't reflect yet (loads take seconds). Keyed by model id
// -> { size, count }; ref-counted so concurrent requests for the same model
// reserve its size once. A reservation counts against free RAM until oMLX reports
// the model loaded (then used covers it), and is released when the request ends.
const reservations = new Map();
const reserve = (id, size) => {
  const r = reservations.get(id) || { size, count: 0 };
  r.size = size; r.count++; reservations.set(id, r);
};
const releaseReservation = id => {
  const r = reservations.get(id);
  if (r && --r.count <= 0) reservations.delete(id);
};
// Reserved bytes for still-loading models, excluding `exceptId` (the model whose
// fit we're checking) and any model oMLX already counts in used (loadedIds).
const reservedBytes = (exceptId, loadedIds) => {
  let total = 0;
  for (const [id, r] of reservations)
    if (id !== exceptId && !loadedIds.has(id)) total += r.size;
  return total;
};

class OmlxError extends Error {}
// Thrown when a management endpoint 404s — i.e. the upstream isn't oMLX. Unlike
// OmlxError (which fails closed), this disables memory management and proxies.
class NotOmlx extends Error {}

// null = not yet probed, true = oMLX, false = not oMLX (skip memory mgmt).
let omlxDetected = null;

// Every oMLX call we make is bearer-authed (verify_api_key), so we just send
// OMLX_API_KEY — no admin session/login/cookie needed.
const omlxRequest = (method, path, json) => new Promise((resolve, reject) => {
  const body = json ? Buffer.from(JSON.stringify(json)) : null;
  const headers = { authorization: `Bearer ${OMLX_API_KEY}` };
  if (body) { headers["content-type"] = "application/json"; headers["content-length"] = body.length; }
  const r = request(`http://${MLX_HOST}:${MLX_PORT}${path}`, { method, headers, agent: false }, resp => {
    const chunks = [];
    resp.on("data", c => chunks.push(c));
    resp.on("end", () => {
      let data = null;
      try { const t = Buffer.concat(chunks).toString("utf8"); data = t ? JSON.parse(t) : null; } catch {}
      resolve({ status: resp.statusCode, data });
    });
  });
  r.on("error", reject);
  r.setTimeout(REQ_TIMEOUT, () => r.destroy(new OmlxError(`oMLX ${method} ${path} timed out`)));
  if (body) r.write(body);
  r.end();
});

// GET /v1/models/status is the single source of truth for the memory decision: it
// returns every model's loaded/pinned state, size, last_access and alias, AND the
// whole-server memory picture in the same snapshot — final_ceiling (the ceiling
// oMLX's memory_guard actually enforces, in bytes; null == no limit) and
// current_model_memory (bytes in use). Reading loaded-state and usage from one
// response keeps them consistent: a model is counted via current_model_memory XOR
// via a reservation, never both and never neither, so we can't double-count or
// undercount across a reserved->loaded transition.
const fetchState = async () => {
  const res = await omlxRequest("GET", "/v1/models/status");
  if (res.status === 404) throw new NotOmlx();
  const models = res.data?.models;
  if (res.status !== 200 || !Array.isArray(models)) throw new OmlxError(`oMLX GET /v1/models/status failed (HTTP ${res.status})`);
  return { models, ceiling: res.data.final_ceiling, used: res.data.current_model_memory || 0 };
};

// GET /api/status carries the SERVER-WIDE active_requests (generations in flight)
// and waiting_requests (queued) counts — used only for the idle gate below.
const serverStatus = async () => {
  const res = await omlxRequest("GET", "/api/status");
  if (res.status === 404) throw new NotOmlx();
  if (res.status !== 200 || !res.data) throw new OmlxError(`oMLX GET /api/status failed (HTTP ${res.status})`);
  return res.data;
};

// The server is "idle" only when oMLX reports zero active AND zero waiting
// requests. Read defensively: if either field is missing/non-numeric we treat the
// server as busy, so a backend that doesn't surface these counts never gets an
// unload (fail safe — we never risk aborting an in-flight request we can't see).
const serverIdle = s => Number(s.active_requests) === 0 && Number(s.waiting_requests) === 0;

// True iff oMLX reports a fully idle server right now (single check — we never
// wait/poll, so an unload can't catch a generation that starts while we wait).
const isServerIdle = async () => serverIdle(await serverStatus());

const unload = async id => {
  const res = await omlxRequest("POST", `/v1/models/${encodeURIComponent(id)}/unload`);
  // 404 (not found) / 400 (not loaded) both mean it's already gone — fine.
  if (![200, 204, 400, 404].includes(res.status)) throw new OmlxError(`oMLX unload "${id}" failed (HTTP ${res.status})`);
};

const sizeOf = m => (m.actual_size > 0 ? m.actual_size : m.estimated_size) || 0;
const lastAccess = m => (typeof m.last_access === "number" ? m.last_access : Date.parse(m.last_access)) || 0;
// oMLX accepts either the directory id or the configured alias; /v1/models
// advertises the alias when set, so requests usually carry it. /v1/models/status
// surfaces it as model_alias on the entry.
const namesOf = m => [m.id, m.model_alias].filter(Boolean);

// Ensure `requested` fits, unloading LRU non-pinned models as needed. Returns the
// model id reserved for this request (to release when it ends), or null if nothing
// was reserved. Throws OmlxError on any condition that prevents a confident decision.
const ensureFits = async requested => {
  const { models } = await fetchState(); // also probes for oMLX (throws NotOmlx on 404)
  const lc = String(requested).toLowerCase();
  const want = models.find(m => namesOf(m).includes(requested))
    || models.find(m => namesOf(m).some(n => String(n).toLowerCase() === lc));
  if (!want) throw new OmlxError(`model "${requested}" not known to oMLX`);
  if (want.loaded) return null; // already resident — nothing to reserve or unload

  // A load (and any unload it needs) must happen one at a time, with the resulting
  // memory reserved before the next admission runs — otherwise concurrent requests
  // overcommit the ceiling. Re-fetch state inside the lock; it may have changed.
  return withAdmitLock(async () => {
    const st = await fetchState();
    const w = st.models.find(m => m.id === want.id) || want;
    if (w.loaded) return null; // loaded while we waited for the lock
    if (st.ceiling == null) return null; // oMLX is running unlimited — let it manage

    // Free RAM = ceiling − used − memory already promised to other in-flight loads.
    // `used` and the loaded flags come from the same snapshot, so a model is counted
    // once (via `used`) or as a reservation, never both — no double/under-count.
    const loadedIds = new Set(st.models.filter(m => m.loaded).map(m => m.id));
    const freeNoResv = st.ceiling - st.used;
    const reserved = reservedBytes(w.id, loadedIds);
    let free = freeNoResv - reserved;

    const need = (w.estimated_size || 0) + HEADROOM;
    if (free >= need) { reserve(w.id, w.estimated_size || 0); return w.id; }

    // Reaching here means the request needs room freed. oMLX's unload is an
    // immediate abort, and forwarding a load into a busy oMLX lets oMLX itself
    // evict-and-abort — so if oMLX is doing ANY work, reject now. We never wait:
    // the client retries when the server is idle.
    if (!(await isServerIdle()))
      throw new OmlxError(`"${requested}" needs memory freed but oMLX is busy; rejecting rather than abort an in-flight request — retry when idle`);

    // oMLX is idle. Candidates: loaded, non-pinned, not the target, and not held by
    // another in-flight request (reserved). Oldest first.
    const victims = st.models
      .filter(m => m.loaded && !m.pinned && m.id !== w.id && !reservations.has(m.id))
      .sort((a, b) => lastAccess(a) - lastAccess(b));

    if (free + victims.reduce((sum, v) => sum + sizeOf(v), 0) < need) {
      // Can't fit even after unloading every eligible model — blocked by pinned
      // models or simply too big for the ceiling. Unloading can't help; the server
      // is idle, so proxy as-is (unreserved) and let oMLX render its verdict.
      console.warn(`oMLX: "${requested}" cannot fit even after unloading all non-pinned models (need ${need}, free ${free}); proxying anyway`);
      return null;
    }

    // Unload oldest-first until it fits. Re-check idle immediately before each
    // abrupt unload (a generation may have just started) and bail out if so — we
    // would rather reject than abort.
    for (const v of victims) {
      if (free >= need) break;
      if (!(await isServerIdle()))
        throw new OmlxError(`"${requested}" needs memory freed but oMLX became busy; rejecting rather than abort an in-flight request — retry when idle`);
      await unload(v.id);
      free += sizeOf(v);
    }
    reserve(w.id, w.estimated_size || 0);
    return w.id;
  });
};

createServer((req, res) => {
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", async () => {
    let body = Buffer.concat(chunks);
    let payload = null;
    try {
      payload = JSON.parse(body);
      const msg = payload.messages?.findLast?.(m => m.role === "user");
      if (msg) {
        const prefix = `Current date and time: ${fmt.format(new Date())}\n\n`;
        if (typeof msg.content === "string") msg.content = prefix + msg.content;
        else if (Array.isArray(msg.content)) msg.content.unshift({ type: "text", text: prefix });
        body = Buffer.from(JSON.stringify(payload));
      }
    } catch {}

    let reservedId = null; // memory reserved for this request's pending load, if any
    if (MEMORY_MGMT && omlxDetected !== false && req.method === "POST" && typeof payload?.model === "string") {
      try {
        reservedId = await ensureFits(payload.model);
        omlxDetected = true;
      } catch (e) {
        if (e instanceof NotOmlx) {
          // Upstream isn't oMLX (endpoints 404). Disable for this run, proxy on.
          if (omlxDetected !== false) console.warn(`oMLX management API not found at ${MLX_HOST}:${MLX_PORT}; disabling memory management, proxying normally`);
          omlxDetected = false;
        } else {
          const detail = e instanceof OmlxError ? e.message : `oMLX memory check error: ${e.message}`;
          console.error(detail);
          if (!res.headersSent) {
            res.writeHead(503, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: detail, type: "omlx_memory_management" } }));
          }
          return;
        }
      }
    }

    const headers = { ...req.headers, host: `${MLX_HOST}:${MLX_PORT}`, "content-length": body.length };
    delete headers["transfer-encoding"];

    // Authenticate upstream with the configured key when the client didn't send
    // its own credentials, so callers can point at the proxy without a key.
    if (OMLX_API_KEY && !headers.authorization && !headers["x-api-key"])
      headers.authorization = `Bearer ${OMLX_API_KEY}`;

    // Release the memory reservation once the request settles: by then the model
    // has loaded (oMLX's used now covers it) or the load failed (no RAM taken).
    let released = false;
    const release = () => { if (released) return; released = true; if (reservedId) releaseReservation(reservedId); };

    const upstream = request(`http://${MLX_HOST}:${MLX_PORT}${req.url}`,
      { method: req.method, headers, agent: false },
      r => { res.writeHead(r.statusCode, r.headers); r.on("end", release); r.pipe(res); });

    upstream.on("error", e => { console.error(e.message); release(); if (!res.headersSent) res.writeHead(502).end(); });
    res.on("close", () => { if (!res.writableEnded) upstream.destroy(); release(); });
    upstream.end(body);
  });
}).listen(MLX_PROXY_PORT, () => console.log(`:${MLX_PROXY_PORT} → ${MLX_HOST}:${MLX_PORT}${MEMORY_MGMT ? " (oMLX memory mgmt on)" : ""}`));

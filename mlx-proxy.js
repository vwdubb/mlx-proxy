import { createServer, request } from "http";
const {
  MLX_HOST = "host.docker.internal", MLX_PORT = 8080, MLX_PROXY_PORT = 8081, TZ = "UTC",
  OMLX_API_KEY = "", OMLX_HEADROOM_MB = "1024", OMLX_API_TIMEOUT_MS = "5000",
  OMLX_UNLOAD_IDLE_TIMEOUT_MS = "30000", OMLX_IDLE_POLL_MS = "250",
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
//   GET  /v1/models/status       - per-model loaded/pinned/size/last_access/alias
//   GET  /api/status             - memory ceiling/usage + active/waiting requests
//   POST /v1/models/{id}/unload  - unload a model (immediate abort, hence idle-wait)
//
// Policy (per project requirements):
//   - Unload the least-recently-used *non-pinned* models, one at a time, only
//     until the requested model fits. Pinned models are never touched; if only
//     pinned models block the fit, we proxy as-is and let oMLX cope.
//   - NEVER abort an in-flight request. oMLX's unload is an *immediate abort*:
//     it kills whatever that model is generating. oMLX only reports request
//     counts SERVER-WIDE (active_requests + waiting_requests in /api/status) —
//     there is no per-model busy flag — so the only signal that guarantees a
//     given model is idle is the whole server being idle. We therefore wait for
//     oMLX to report zero active AND zero waiting requests before unloading
//     anything, polling up to OMLX_UNLOAD_IDLE_TIMEOUT_MS. (Relying on the
//     proxy's own per-model in-flight count is unsound: it misses requests that
//     bypass the proxy, that oMLX has queued, or whose model name didn't match
//     the key we tracked — any of which an immediate-abort unload would kill.)
//   - Fail closed: return 503 rather than risk an OOM on the oMLX host when
//     either (a) the memory check itself can't be completed (oMLX unreachable,
//     bad/missing key, unexpected response, unknown model), or (b) room *could*
//     have been made by unloading non-pinned models but the server wouldn't go
//     idle in time. When the fit is impossible anyway (only pinned models block
//     it, or the model exceeds the ceiling), we proxy as-is and let oMLX cope.
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
const IDLE_TIMEOUT = Number(OMLX_UNLOAD_IDLE_TIMEOUT_MS);
const IDLE_POLL = Number(OMLX_IDLE_POLL_MS);

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

// GET /v1/models/status lists every discoverable model with its loaded/pinned
// state, size, last_access, and alias (model_alias, present when configured).
const listModels = async () => {
  const res = await omlxRequest("GET", "/v1/models/status");
  if (res.status === 404) throw new NotOmlx();
  const models = res.data?.models;
  if (res.status !== 200 || !Array.isArray(models)) throw new OmlxError(`oMLX GET /v1/models/status failed (HTTP ${res.status})`);
  return models;
};

// GET /api/status reports the memory ceiling oMLX enforces (model_memory_max)
// and current usage (model_memory_used), in bytes (max is null == no limit), plus
// the SERVER-WIDE active_requests (generations in flight) and waiting_requests
// (queued) counts. These are not broken down per model.
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

// Wait until oMLX reports a fully idle server (so an immediate-abort unload can't
// kill anything), re-polling /api/status up to OMLX_UNLOAD_IDLE_TIMEOUT_MS.
// Returns the last status seen so the caller can recompute free memory from it.
const waitForServerIdle = async () => {
  const deadline = Date.now() + IDLE_TIMEOUT;
  let s = await serverStatus();
  while (!serverIdle(s)) {
    if (Date.now() >= deadline) return null;
    await sleep(IDLE_POLL);
    s = await serverStatus();
  }
  return s;
};

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

// Ensure `requested` fits, unloading LRU non-pinned models as needed.
// Throws OmlxError on any condition that prevents a confident decision.
const ensureFits = async requested => {
  const models = await listModels();
  const lc = String(requested).toLowerCase();
  const want = models.find(m => namesOf(m).includes(requested))
    || models.find(m => namesOf(m).some(n => String(n).toLowerCase() === lc));
  if (!want) throw new OmlxError(`model "${requested}" not known to oMLX`);
  if (want.loaded) return; // already resident — nothing to do

  const status = await serverStatus();
  if (status.model_memory_max == null) return; // oMLX is running unlimited — let it manage
  const freeFrom = s => s.model_memory_max - (s.model_memory_used || 0);
  let free = freeFrom(status);

  const need = (want.estimated_size || 0) + HEADROOM;
  if (free >= need) return;

  const victims = models
    .filter(m => m.loaded && !m.pinned && m.id !== want.id)
    .sort((a, b) => lastAccess(a) - lastAccess(b)); // oldest first

  // If unloading every non-pinned victim still wouldn't free enough, the fit is
  // blocked by pinned models (or the model is simply too big for the ceiling).
  // Unloading can't help, so per policy proxy as-is and let oMLX cope.
  if (free + victims.reduce((sum, v) => sum + sizeOf(v), 0) < need) {
    console.warn(`oMLX: "${requested}" cannot fit even after unloading all non-pinned models (need ${need}, free ${free}); proxying anyway`);
    return;
  }

  // The fit IS achievable by unloading non-pinned models — but oMLX's unload is an
  // immediate abort, so we must not unload while anything is generating. Wait for
  // the whole server to go idle (no per-model busy flag exists). If it won't go
  // idle in time, fail closed rather than abort an in-flight request or OOM.
  const idle = await waitForServerIdle();
  if (!idle) {
    console.warn(`oMLX: server still busy after ${IDLE_TIMEOUT}ms; not unloading for "${requested}"`);
    throw new OmlxError(`could not free enough for "${requested}" in time (need ${need}); oMLX did not go idle within ${IDLE_TIMEOUT}ms, and unloading now would abort an in-flight request`);
  }

  // Server is idle: every loaded model is quiescent, so unloading the LRU victims
  // can't interrupt anyone. Recompute free from the idle snapshot (usage may have
  // changed while we waited), then unload oldest-first until the request fits.
  free = freeFrom(idle);
  for (const v of victims) {
    if (free >= need) break;
    await unload(v.id);
    free += sizeOf(v);
  }
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

    if (MEMORY_MGMT && omlxDetected !== false && req.method === "POST" && typeof payload?.model === "string") {
      try {
        await ensureFits(payload.model);
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

    const upstream = request(`http://${MLX_HOST}:${MLX_PORT}${req.url}`,
      { method: req.method, headers, agent: false },
      r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });

    upstream.on("error", e => { console.error(e.message); if (!res.headersSent) res.writeHead(502).end(); });
    res.on("close", () => { if (!res.writableEnded) upstream.destroy(); });
    upstream.end(body);
  });
}).listen(MLX_PROXY_PORT, () => console.log(`:${MLX_PROXY_PORT} → ${MLX_HOST}:${MLX_PORT}${MEMORY_MGMT ? " (oMLX memory mgmt on)" : ""}`));

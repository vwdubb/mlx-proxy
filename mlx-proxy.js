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
//   GET  /api/status             - enforced memory ceiling + current usage
//   POST /v1/models/{id}/unload  - unload a model (hard abort, hence idle-wait)
//
// Policy (per project requirements):
//   - Unload the least-recently-used *non-pinned* models, one at a time, only
//     until the requested model fits. Pinned models are never touched; if only
//     pinned models block the fit, we proxy as-is and let oMLX cope.
//   - Wait for a model to go idle before unloading it: oMLX exposes only an
//     aggregate active-request count (no per-model busy flag), so we track the
//     requests THIS proxy has in flight per model and don't unload a model
//     until its in-flight count drops to zero. If it stays busy past
//     OMLX_UNLOAD_IDLE_TIMEOUT_MS, we leave it loaded and move on.
//   - Fail closed: return 503 rather than risk an OOM on the oMLX host when
//     either (a) the memory check itself can't be completed (oMLX unreachable,
//     bad/missing key, unexpected response, unknown model), or (b) room *could*
//     have been made by unloading non-pinned models but one wouldn't go idle in
//     time. When the fit is impossible anyway (only pinned models block it, or
//     the model exceeds the ceiling), we proxy as-is and let oMLX cope.
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

// Requests currently being proxied, counted under the (lower-cased) model name
// the client sent — which may be a directory id OR an alias — so we can wait for
// a model to drain before unloading it. A victim is "busy" if any of its names
// (id or alias) has in-flight requests.
const inflight = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const busy = names => names.some(n => (inflight.get(String(n).toLowerCase()) || 0) > 0);
const waitForIdle = async names => {
  const deadline = Date.now() + IDLE_TIMEOUT;
  while (busy(names)) {
    if (Date.now() >= deadline) return false;
    await sleep(IDLE_POLL);
  }
  return true;
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
// and current usage (model_memory_used), in bytes. max is null == no limit.
const serverStatus = async () => {
  const res = await omlxRequest("GET", "/api/status");
  if (res.status === 404) throw new NotOmlx();
  if (res.status !== 200 || !res.data) throw new OmlxError(`oMLX GET /api/status failed (HTTP ${res.status})`);
  return res.data;
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
  let free = status.model_memory_max - (status.model_memory_used || 0);

  const need = (want.estimated_size || 0) + HEADROOM;
  if (free >= need) return;

  const victims = models
    .filter(m => m.loaded && !m.pinned && m.id !== want.id)
    .sort((a, b) => lastAccess(a) - lastAccess(b)); // oldest first

  // The most we could reclaim by unloading every non-pinned victim. If even that
  // wouldn't fit, the request is blocked by pinned models (or is simply too big
  // for the ceiling): unloading can't help, so per policy we proxy as-is and let
  // oMLX cope. If it WOULD fit, the fit is achievable and any shortfall below is
  // only because a victim wouldn't go idle in time.
  const fitAchievable = free + victims.reduce((sum, v) => sum + sizeOf(v), 0) >= need;

  for (const v of victims) {
    if (free >= need) break;
    if (!(await waitForIdle(namesOf(v)))) {
      console.warn(`oMLX: "${v.id}" still serving requests after ${IDLE_TIMEOUT}ms; leaving it loaded`);
      continue;
    }
    await unload(v.id);
    free += sizeOf(v);
  }
  if (free < need) {
    // Fail closed: room could have been made, but a non-pinned model wouldn't go
    // idle within OMLX_UNLOAD_IDLE_TIMEOUT_MS, so forwarding now would risk an OOM
    // on the oMLX host. Return 503 (handled upstream) instead of proxying anyway.
    if (fitAchievable)
      throw new OmlxError(`could not free enough for "${requested}" in time (need ${need}, free ${free}); a busy model wouldn't go idle within ${IDLE_TIMEOUT}ms`);
    // Unloading every non-pinned model still wouldn't fit — blocked by pinned
    // models (or the model is too large for the ceiling). Proxy as-is per policy.
    console.warn(`oMLX: "${requested}" cannot fit even after unloading all non-pinned models (need ${need}, free ${free}); proxying anyway`);
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

    // Count this request against its model (lower-cased, as sent) while it's in
    // flight, so the memory logic can wait for a model to go idle before
    // unloading it. namesOf() checks both a model's id and alias against this.
    const model = MEMORY_MGMT && typeof payload?.model === "string" ? payload.model.toLowerCase() : null;
    if (model) inflight.set(model, (inflight.get(model) || 0) + 1);
    let released = false;
    const release = () => {
      if (released || !model) return;
      released = true;
      const n = (inflight.get(model) || 1) - 1;
      if (n > 0) inflight.set(model, n); else inflight.delete(model);
    };

    const upstream = request(`http://${MLX_HOST}:${MLX_PORT}${req.url}`,
      { method: req.method, headers, agent: false },
      r => { res.writeHead(r.statusCode, r.headers); r.on("end", release); r.pipe(res); });

    upstream.on("error", e => { console.error(e.message); release(); if (!res.headersSent) res.writeHead(502).end(); });
    res.on("close", () => { if (!res.writableEnded) upstream.destroy(); release(); });
    upstream.end(body);
  });
}).listen(MLX_PROXY_PORT, () => console.log(`:${MLX_PROXY_PORT} → ${MLX_HOST}:${MLX_PORT}${MEMORY_MGMT ? " (oMLX memory mgmt on)" : ""}`));

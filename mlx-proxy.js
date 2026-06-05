import { createServer, request } from "http";
const {
  MLX_HOST = "host.docker.internal", MLX_PORT = 8080, MLX_PROXY_PORT = 8081, TZ = "UTC",
  OMLX_API_KEY = "", OMLX_HEADROOM_MB = "1024", OMLX_ADMIN_TIMEOUT_MS = "5000",
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
// the requested one fits. The admin/status/unload endpoints require an admin
// *session cookie* (not a bearer key), so we exchange OMLX_API_KEY for a
// cookie via POST /admin/api/login and reuse it.
//
// Policy (per project requirements):
//   - Unload the least-recently-used *non-pinned* models, one at a time, only
//     until the requested model fits. Pinned models are never touched; if only
//     pinned models block the fit, we proxy as-is and let oMLX cope.
//   - Fail closed: if the memory check itself can't be completed (admin
//     unreachable, bad/again-missing key, unexpected response, unknown model),
//     return 503 rather than risk an OOM on the oMLX host.
//
// Enabled only when OMLX_API_KEY is set; otherwise the proxy behaves as a
// plain pass-through.
// ---------------------------------------------------------------------------
const MEMORY_MGMT = OMLX_API_KEY.length > 0;
const HEADROOM = Number(OMLX_HEADROOM_MB) * 1024 * 1024;
const ADMIN_TIMEOUT = Number(OMLX_ADMIN_TIMEOUT_MS);

class AdminError extends Error {}

let session = { cookie: null, expires: 0 };
let loginInFlight = null;

const adminRequest = (method, path, { cookie, json } = {}) => new Promise((resolve, reject) => {
  const body = json ? Buffer.from(JSON.stringify(json)) : null;
  const headers = {};
  if (body) { headers["content-type"] = "application/json"; headers["content-length"] = body.length; }
  if (cookie) headers.cookie = `omlx_admin_session=${cookie}`;
  const r = request(`http://${MLX_HOST}:${MLX_PORT}${path}`, { method, headers, agent: false }, resp => {
    const chunks = [];
    resp.on("data", c => chunks.push(c));
    resp.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch {}
      resolve({ status: resp.statusCode, headers: resp.headers, data });
    });
  });
  r.on("error", reject);
  r.setTimeout(ADMIN_TIMEOUT, () => r.destroy(new AdminError(`oMLX admin ${method} ${path} timed out`)));
  if (body) r.write(body);
  r.end();
});

const login = async () => {
  const res = await adminRequest("POST", "/admin/api/login", { json: { api_key: OMLX_API_KEY, remember: true } });
  if (res.status !== 200) throw new AdminError(`oMLX admin login failed (HTTP ${res.status})`);
  const raw = [].concat(res.headers["set-cookie"] || []).find(c => c.startsWith("omlx_admin_session="));
  if (!raw) throw new AdminError("oMLX admin login returned no session cookie");
  const cookie = raw.split(";")[0].slice("omlx_admin_session=".length);
  const maxAge = /max-age=(\d+)/i.exec(raw);
  const ttl = maxAge ? Number(maxAge[1]) * 1000 : 3600_000;
  session = { cookie, expires: Date.now() + ttl - 60_000 };
  return cookie;
};

const getCookie = () => {
  if (session.cookie && Date.now() < session.expires) return Promise.resolve(session.cookie);
  if (!loginInFlight) loginInFlight = login().finally(() => { loginInFlight = null; });
  return loginInFlight;
};

// GET/POST an admin endpoint, transparently re-logging-in once on a 401.
const adminCall = async (method, path, json) => {
  let res = await adminRequest(method, path, { cookie: await getCookie(), json });
  if (res.status === 401) {
    session = { cookie: null, expires: 0 };
    res = await adminRequest(method, path, { cookie: await getCookie(), json });
  }
  return res;
};

const listModels = async () => {
  const res = await adminCall("GET", "/admin/api/models");
  const models = Array.isArray(res.data) ? res.data : res.data?.models;
  if (res.status !== 200 || !Array.isArray(models)) throw new AdminError(`oMLX GET /admin/api/models failed (HTTP ${res.status})`);
  return models;
};

const systemMemory = async () => {
  const res = await adminCall("GET", "/admin/api/system-status");
  const mem = res.data?.memory ?? res.data;
  if (res.status !== 200 || !mem) throw new AdminError(`oMLX GET /admin/api/system-status failed (HTTP ${res.status})`);
  return mem;
};

const unload = async id => {
  const res = await adminCall("POST", `/admin/api/models/${encodeURIComponent(id)}/unload`);
  // 404 == already unloaded; anything else non-2xx is a real failure.
  if (res.status !== 200 && res.status !== 204 && res.status !== 404) throw new AdminError(`oMLX unload "${id}" failed (HTTP ${res.status})`);
};

const sizeOf = m => (m.actual_size > 0 ? m.actual_size : m.estimated_size) || 0;
const lastAccess = m => (typeof m.last_access === "number" ? m.last_access : Date.parse(m.last_access)) || 0;

// Ensure `requested` fits, unloading LRU non-pinned models as needed.
// Throws AdminError on any condition that prevents a confident decision.
const ensureFits = async requested => {
  const models = await listModels();
  const want = models.find(m => m.id === requested)
    || models.find(m => String(m.id).toLowerCase() === String(requested).toLowerCase());
  if (!want) throw new AdminError(`model "${requested}" not known to oMLX`);
  if (want.loaded) return; // already resident — nothing to do

  const mem = await systemMemory();
  let free = typeof mem.available_bytes === "number"
    ? mem.available_bytes
    : typeof mem.auto_limit_bytes === "number"
      ? mem.auto_limit_bytes - models.filter(m => m.loaded).reduce((s, m) => s + sizeOf(m), 0)
      : null;
  if (free === null) throw new AdminError("oMLX system-status missing memory fields");

  const need = (want.estimated_size || 0) + HEADROOM;
  if (free >= need) return;

  const victims = models
    .filter(m => m.loaded && !m.pinned && m.id !== want.id)
    .sort((a, b) => lastAccess(a) - lastAccess(b)); // oldest first
  for (const v of victims) {
    if (free >= need) break;
    await unload(v.id);
    free += sizeOf(v);
  }
  if (free < need) console.warn(`oMLX: could not free enough for "${requested}" (need ${need}, free ${free}); proxying anyway`);
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

    if (MEMORY_MGMT && req.method === "POST" && typeof payload?.model === "string") {
      try {
        await ensureFits(payload.model);
      } catch (e) {
        const detail = e instanceof AdminError ? e.message : `oMLX memory check error: ${e.message}`;
        console.error(detail);
        if (!res.headersSent) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: detail, type: "omlx_memory_management" } }));
        }
        return;
      }
    }

    const headers = { ...req.headers, host: `${MLX_HOST}:${MLX_PORT}`, "content-length": body.length };
    delete headers["transfer-encoding"];

    const upstream = request(`http://${MLX_HOST}:${MLX_PORT}${req.url}`,
      { method: req.method, headers, agent: false },
      r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });

    upstream.on("error", e => { console.error(e.message); if (!res.headersSent) res.writeHead(502).end(); });
    res.on("close", () => { if (!res.writableEnded) upstream.destroy(); });
    upstream.end(body);
  });
}).listen(MLX_PROXY_PORT, () => console.log(`:${MLX_PROXY_PORT} → ${MLX_HOST}:${MLX_PORT}${MEMORY_MGMT ? " (oMLX memory mgmt on)" : ""}`));

import { createServer } from "node:http";

// Starts a stub oMLX server. Returns { url, port, calls, settings, close, opts }.
// opts (mutable) controls behavior:
//   models: array of { id, settings: { model_alias } }
//   loginStatus: HTTP status for POST /admin/api/login (default 200)
export async function startStubOmlx(initial = {}) {
  const opts = {
    models: initial.models ?? [
      { id: "Qwen3.6-27B-4bit", settings: { model_alias: "qwen3.6-27B-4bit" } },
      { id: "Llama-3.2-1B-Instruct-4bit", settings: { model_alias: "llama-3.2-1B-Instruct-4bit" } },
    ],
    loginStatus: initial.loginStatus ?? 200,
    failGlobalSettings: initial.failGlobalSettings ?? false,
  };
  const settings = { cache: { ssd_cache_dir: initial.ssdCacheDir ?? null } };
  const calls = []; // { method, path, body, cookie }
  let loggedIn = false;
  let expireStatus = 0; // set by test to force a single 401/403 on next admin call

  const readBody = (req) =>
    new Promise((resolve) => {
      const c = [];
      req.on("data", (d) => c.push(d));
      req.on("end", () => resolve(Buffer.concat(c).toString() || ""));
    });

  const server = createServer(async (req, res) => {
    const bodyStr = await readBody(req);
    let body;
    if (bodyStr) {
      try { body = JSON.parse(bodyStr); } catch { body = undefined; }
    }
    const cookie = req.headers["cookie"] ?? null;
    calls.push({ method: req.method, path: req.url, body, cookie });
    const json = (status, obj, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(obj));
    };

    // Login
    if (req.method === "POST" && req.url === "/admin/api/login") {
      if (opts.loginStatus !== 200) return json(opts.loginStatus, { success: false });
      loggedIn = true;
      expireStatus = 0;
      return json(200, { success: true }, { "set-cookie": "omlx_session=abc; Path=/; HttpOnly" });
    }

    // Admin auth gate
    const isAdmin = req.url.startsWith("/admin/api/");
    if (isAdmin) {
      if (!loggedIn || !cookie) {
        return json(401, { detail: "Admin authentication required" });
      }
      if (expireStatus) {
        const status = expireStatus;
        expireStatus = 0;
        return json(status, { detail: "Admin authentication required" });
      }
    }

    if (req.method === "GET" && req.url === "/admin/api/models") {
      return json(200, opts.models);
    }
    if (req.url === "/admin/api/global-settings") {
      if (opts.failGlobalSettings) return json(500, { detail: "boom" });
      if (req.method === "GET") return json(200, settings);
      if (req.method === "POST") {
        if (typeof body?.ssd_cache_dir === "string") {
          settings.cache.ssd_cache_dir = body.ssd_cache_dir;
        }
        return json(200, {});
      }
    }

    // Upstream chat passthrough target
    if (req.url === "/v1/chat/completions" || req.url === "/v1/models") {
      return json(200, {
        ok: true,
        echoedModel: body?.model ?? null,
        echoedUserContent: body?.messages?.findLast?.((m) => m.role === "user")?.content ?? null,
        path: req.url,
      });
    }

    json(404, { detail: "not found" });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    host: "127.0.0.1",
    port,
    calls,
    settings,
    opts,
    expireSessionOnce(status = 401) { expireStatus = status; },
    close: () => new Promise((r) => server.close(r)),
  };
}

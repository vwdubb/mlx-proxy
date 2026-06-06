import { createServer, request } from "http";
import { fileURLToPath } from "node:url";
import { AdminSession, ModelResolver, isSyncEnabled, validateConfig, syncCacheDir } from "./omlx-admin.js";

export function buildProxyServer(env = process.env) {
  // Fail fast on misconfiguration at construction time rather than deferring an
  // opaque error to the first request. No-op when sync is off.
  if (isSyncEnabled(env)) validateConfig(env);

  const { MLX_HOST = "host.docker.internal", MLX_PORT = 8080, MLX_API_KEY, TZ = "UTC" } = env;

  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, weekday: "long", year: "numeric", month: "long",
    day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
    timeZoneName: "short",
  });

  const { OMLX_CACHE_ROOT } = env;
  const syncEnabled = isSyncEnabled(env);
  let session, resolver;
  if (syncEnabled) {
    const baseUrl = `http://${MLX_HOST}:${MLX_PORT}`;
    session = new AdminSession({ baseUrl, apiKey: MLX_API_KEY });
    resolver = new ModelResolver(session);
  }

  return createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      try {
        let body = Buffer.concat(chunks);
        let model;
        try {
          const payload = JSON.parse(body);
          model = payload.model;
          const msg = payload.messages?.findLast?.((m) => m.role === "user");
          if (msg) {
            const prefix = `Current date and time: ${fmt.format(new Date())}\n\n`;
            if (typeof msg.content === "string") msg.content = prefix + msg.content;
            else if (Array.isArray(msg.content)) msg.content.unshift({ type: "text", text: prefix });
            body = Buffer.from(JSON.stringify(payload));
          }
        } catch {}

        if (syncEnabled && model) {
          try {
            await syncCacheDir({ session, resolver, root: OMLX_CACHE_ROOT, model });
          } catch (e) {
            console.error("ssd_cache_dir sync failed:", e.message);
            if (!res.headersSent) res.writeHead(502).end();
            return;
          }
        }

        const headers = { ...req.headers, host: `${MLX_HOST}:${MLX_PORT}`, "content-length": body.length };
        delete headers["transfer-encoding"];
        if (MLX_API_KEY) headers["authorization"] = `Bearer ${MLX_API_KEY}`;

        const upstream = request(
          `http://${MLX_HOST}:${MLX_PORT}${req.url}`,
          { method: req.method, headers, agent: false },
          (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); },
        );

        upstream.on("error", (e) => { console.error(e.message); if (!res.headersSent) res.writeHead(502).end(); });
        res.on("close", () => { if (!res.writableEnded) upstream.destroy(); });
        upstream.end(body);
      } catch (e) {
        console.error("proxy handler error:", e.message);
        if (!res.headersSent) res.writeHead(502).end();
      }
    });
  });
}

function main() {
  const env = process.env;
  try {
    validateConfig(env);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const { MLX_HOST = "host.docker.internal", MLX_PORT = 8080, MLX_PROXY_PORT = 8081 } = env;
  buildProxyServer(env).listen(MLX_PROXY_PORT, () =>
    console.log(`:${MLX_PROXY_PORT} → ${MLX_HOST}:${MLX_PORT}${isSyncEnabled(env) ? " (cache-dir sync on)" : ""}`),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

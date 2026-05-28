const http = require("http");

const { MLX_HOST = "host.docker.internal", MLX_PORT = 8080, MLX_PROXY_PORT = 8081, TZ = "UTC" } = process.env;

http.createServer((req, res) => {
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", () => {
    let body = Buffer.concat(chunks);

    try {
      const payload = JSON.parse(body);
      const now = new Date().toLocaleString("en-CA", { timeZone: TZ, dateStyle: "full", timeStyle: "short" });
      const msg = payload.messages?.findLast?.(m => m.role === "user");
      if (msg) {
        if (typeof msg.content === "string") msg.content = `Current Date: ${now}\n${msg.content}`;
        else if (Array.isArray(msg.content)) msg.content.unshift({ type: "text", text: `Current Date: ${now}` });
      }
      body = Buffer.from(JSON.stringify(payload));
    } catch {}

    const fwd = { ...req.headers, host: `${MLX_HOST}:${MLX_PORT}`, "content-length": body.length };
    delete fwd["transfer-encoding"];
    delete fwd["accept-encoding"];

    const upstream = http.request(`http://${MLX_HOST}:${MLX_PORT}${req.url}`, {
      method: req.method,
      headers: fwd,
      agent: false,
    }, r => res.writeHead(r.statusCode, r.headers) && r.pipe(res));

    upstream.on("error", e => { console.error(e.message); if (!res.headersSent) res.writeHead(502).end(); });
    res.on("close", () => { if (!res.writableEnded) upstream.destroy(); });
    upstream.end(body);
  });
}).listen(MLX_PROXY_PORT, () => console.log(`:${MLX_PROXY_PORT} → ${MLX_HOST}:${MLX_PORT}`));

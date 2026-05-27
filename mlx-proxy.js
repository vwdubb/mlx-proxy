const http = require("http");

const MLX_HOST = process.env.MLX_HOST || "host.docker.internal";
const MLX_PORT = parseInt(process.env.MLX_PORT || "8080");
const MLX_PROXY_PORT = parseInt(process.env.MLX_PROXY_PORT || "8081");

http.createServer((req, res) => {
  let body = "";
  req.on("data", chunk => body += chunk);
  req.on("end", () => {
    try {
      const payload = JSON.parse(body);
      const now = new Date().toLocaleString("en-CA", {
        timeZone: process.env.TZ || "UTC",
        dateStyle: "full",
        timeStyle: "short",
      });

      const messages = payload.messages ?? [];
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          const content = messages[i].content;
          if (typeof content === "string") {
            messages[i].content = `Current Date: ${now}\n${content}`;
          } else if (Array.isArray(content)) {
            content.unshift({ type: "text", text: `Current Date: ${now}` });
          }
          break;
        }
      }
      payload.messages = messages;
      body = JSON.stringify(payload);
    } catch (e) {
      console.error("Failed to parse request body:", e.message);
    }

    const options = {
      hostname: MLX_HOST,
      port: MLX_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, "content-length": Buffer.byteLength(body) },
    };

    const proxy = http.request(options, mlxRes => {
      res.writeHead(mlxRes.statusCode, mlxRes.headers);
      mlxRes.pipe(res);
    });

    proxy.on("error", err => {
      console.error("Proxy error:", err.message);
      res.writeHead(502);
      res.end("Bad Gateway");
    });

    proxy.write(body);
    proxy.end();
  });
}).listen(MLX_PROXY_PORT, () => {
  console.log(`MLX proxy listening on :${MLX_PROXY_PORT} → ${MLX_HOST}:${MLX_PORT}`);
});

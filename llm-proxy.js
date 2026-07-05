import { createServer, request } from "http";
const { ENDPOINTS = "", API_KEY, TZ = "UTC" } = process.env;

const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, weekday: "long", year: "numeric", month: "long",
  day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  timeZoneName: "short",
});

const makeHandler = (host, port) => (req, res) => {
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", () => {
    let body = Buffer.concat(chunks);
    try {
      const payload = JSON.parse(body);
      const msg = payload.messages?.findLast?.(m => m.role === "user");
      if (msg) {
        const prefix = `Current date and time: ${fmt.format(new Date())}\n\n`;
        if (typeof msg.content === "string") msg.content = prefix + msg.content;
        else if (Array.isArray(msg.content)) msg.content.unshift({ type: "text", text: prefix });
        body = Buffer.from(JSON.stringify(payload));
      }
    } catch {}

    const headers = { ...req.headers, host: `${host}:${port}`, "content-length": body.length };
    delete headers["transfer-encoding"];
    if (API_KEY) headers["authorization"] = `Bearer ${API_KEY}`;

    const upstream = request(`http://${host}:${port}${req.url}`,
      { method: req.method, headers, agent: false },
      r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });

    upstream.on("error", e => { console.error(e.message); if (!res.headersSent) res.writeHead(502).end(); });
    res.on("close", () => { if (!res.writableEnded) upstream.destroy(); });
    upstream.end(body);
  });
};

const endpoints = ENDPOINTS.split(",").map(s => s.trim()).filter(Boolean).map(e => {
  const [listen, host, port] = e.split(":").map(s => s.trim());
  return { listen: Number(listen), host, port: Number(port) };
});

const invalid = ({ listen, host, port }) => !Number.isInteger(listen) || !host || !Number.isInteger(port);
if (!endpoints.length || endpoints.some(invalid)) {
  console.error('Set ENDPOINTS to comma-separated listen:host:port triples, e.g. ENDPOINTS="28080:localhost:8080,28001:spark:8001"');
  process.exit(1);
}

for (const { listen, host, port } of endpoints)
  createServer(makeHandler(host, port)).listen(listen, () => console.log(`:${listen} → ${host}:${port}`));

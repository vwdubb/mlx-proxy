import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

const listen = (server) =>
  new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

// Dummy upstream that records requests and echoes its id.
function startUpstream(id) {
  const received = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({ url: req.url, body: Buffer.concat(chunks).toString(), headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id }));
    });
  });
  return listen(server).then((port) => ({ server, received, port }));
}

// Grab a free port then release it, for use as a proxy listen port.
async function freePort() {
  const s = createServer();
  const port = await listen(s);
  await new Promise((r) => s.close(r));
  return port;
}

async function post(port, payload) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, json: await res.json() };
}

async function waitReady(port, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/v1/models`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`proxy on :${port} never came up`);
}

function chat(text) {
  return { model: "m", messages: [{ role: "user", content: text }] };
}

test("ENDPOINTS routes each listen port to its host:port and injects date", async () => {
  const upA = await startUpstream("A");
  const upB = await startUpstream("B");
  const listenA = await freePort();
  const listenB = await freePort();

  const proxy = spawn("node", ["mlx-proxy.js"], {
    env: {
      ...process.env,
      ENDPOINTS: `${listenA}:127.0.0.1:${upA.port},${listenB}:127.0.0.1:${upB.port}`,
      TZ: "UTC",
    },
    stdio: "inherit",
  });

  try {
    await waitReady(listenA);
    await waitReady(listenB);

    // waitReady's /v1/models probe is forwarded and recorded; discard it so the
    // counts below reflect only the chat requests.
    upA.received.length = 0;
    upB.received.length = 0;

    const rA = await post(listenA, chat("hello A"));
    const rB = await post(listenB, chat("hello B"));

    assert.equal(rA.json.id, "A");
    assert.equal(rB.json.id, "B");
    assert.equal(upA.received.length, 1);
    assert.equal(upB.received.length, 1);

    const sentToA = JSON.parse(upA.received[0].body);
    const userMsg = sentToA.messages.at(-1).content;
    assert.match(userMsg, /^Current date and time: /);
    assert.match(userMsg, /hello A$/);
  } finally {
    proxy.kill();
    await once(proxy, "exit");
    await new Promise((r) => upA.server.close(r));
    await new Promise((r) => upB.server.close(r));
  }
});

test("API_KEY overrides the Authorization header sent upstream", async () => {
  const up = await startUpstream("k");
  const listenPort = await freePort();

  const proxy = spawn("node", ["mlx-proxy.js"], {
    env: {
      ...process.env,
      ENDPOINTS: `${listenPort}:127.0.0.1:${up.port}`,
      API_KEY: "secret-key",
      TZ: "UTC",
    },
    stdio: "inherit",
  });

  try {
    await waitReady(listenPort);
    up.received.length = 0; // discard waitReady's /v1/models probe

    await fetch(`http://127.0.0.1:${listenPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer client-wrong" },
      body: JSON.stringify(chat("hi")),
    });

    assert.equal(up.received.length, 1);
    assert.equal(up.received[0].headers.authorization, "Bearer secret-key");
  } finally {
    proxy.kill();
    await once(proxy, "exit");
    await new Promise((r) => up.server.close(r));
  }
});

for (const [name, value] of [
  ["unset", ""],
  ["missing the port", "28080:localhost"],
]) {
  test(`exits with usage message when ENDPOINTS is ${name}`, async () => {
    const proxy = spawn("node", ["mlx-proxy.js"], {
      env: { ...process.env, ENDPOINTS: value },
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    proxy.stderr.on("data", (c) => (stderr += c));

    const [code] = await once(proxy, "exit");
    assert.equal(code, 1);
    assert.match(stderr, /Set ENDPOINTS/);
  });
}

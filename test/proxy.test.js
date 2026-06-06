import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProxyServer } from "../mlx-proxy.js";
import { startStubOmlx } from "./helpers/stub-omlx.js";

async function startProxy(env) {
  const server = buildProxyServer(env);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

const post = (url, obj) =>
  fetch(url + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(obj),
  });

test("sync OFF: no admin calls, request is forwarded", async () => {
  const stub = await startStubOmlx({ ssdCacheDir: "/root/old" });
  const proxy = await startProxy({ MLX_HOST: stub.host, MLX_PORT: String(stub.port) });
  try {
    const res = await post(proxy.url, { model: "qwen3.6-27B-4bit", messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 200);
    assert.equal(stub.calls.some((c) => c.path.startsWith("/admin/")), false);
    assert.equal(stub.calls.some((c) => c.path === "/v1/chat/completions"), true);
  } finally {
    await proxy.close();
    await stub.close();
  }
});

test("sync ON: updates cache dir to the canonical id then forwards", async () => {
  const stub = await startStubOmlx({ ssdCacheDir: "/root/old" });
  const proxy = await startProxy({
    MLX_HOST: stub.host, MLX_PORT: String(stub.port),
    OMLX_CACHE_SYNC: "1", OMLX_CACHE_ROOT: "/root", MLX_API_KEY: "k",
  });
  try {
    const res = await post(proxy.url, { model: "qwen3.6-27B-4bit", messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 200);
    assert.equal(stub.settings.cache.ssd_cache_dir, "/root/Qwen3.6-27B-4bit");
    assert.ok(stub.calls.some((c) => c.path === "/v1/chat/completions"), "request forwarded");
  } finally {
    await proxy.close();
    await stub.close();
  }
});

test("sync ON + already matching: forwards without POSTing settings", async () => {
  const stub = await startStubOmlx({ ssdCacheDir: "/root/Qwen3.6-27B-4bit" });
  const proxy = await startProxy({
    MLX_HOST: stub.host, MLX_PORT: String(stub.port),
    OMLX_CACHE_SYNC: "1", OMLX_CACHE_ROOT: "/root", MLX_API_KEY: "k",
  });
  try {
    const res = await post(proxy.url, { model: "qwen3.6-27B-4bit", messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 200);
    const posts = stub.calls.filter((c) => c.method === "POST" && c.path === "/admin/api/global-settings");
    assert.equal(posts.length, 0);
  } finally {
    await proxy.close();
    await stub.close();
  }
});

test("sync ON: admin failure fails closed (502, request NOT forwarded)", async () => {
  const stub = await startStubOmlx({ failGlobalSettings: true });
  const proxy = await startProxy({
    MLX_HOST: stub.host, MLX_PORT: String(stub.port),
    OMLX_CACHE_SYNC: "1", OMLX_CACHE_ROOT: "/root", MLX_API_KEY: "k",
  });
  try {
    const res = await post(proxy.url, { model: "qwen3.6-27B-4bit", messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 502);
    assert.equal(stub.calls.some((c) => c.path === "/v1/chat/completions"), false);
  } finally {
    await proxy.close();
    await stub.close();
  }
});

test("date injection: prefixes last user message with the current date/time", async () => {
  const stub = await startStubOmlx({ ssdCacheDir: "/root/old" });
  const proxy = await startProxy({ MLX_HOST: stub.host, MLX_PORT: String(stub.port) });
  try {
    const res = await post(proxy.url, { model: "qwen3.6-27B-4bit", messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 200);
    const { echoedUserContent } = await res.json();
    assert.equal(typeof echoedUserContent, "string");
    assert.ok(echoedUserContent.startsWith("Current date and time:"), "begins with date prefix");
    assert.ok(echoedUserContent.endsWith("hi"), "preserves original content");
  } finally {
    await proxy.close();
    await stub.close();
  }
});

test("sync ON: non-JSON body bypasses sync and forwards", async () => {
  const stub = await startStubOmlx({ ssdCacheDir: "/root/old" });
  const proxy = await startProxy({
    MLX_HOST: stub.host, MLX_PORT: String(stub.port),
    OMLX_CACHE_SYNC: "1", OMLX_CACHE_ROOT: "/root", MLX_API_KEY: "k",
  });
  try {
    const res = await fetch(proxy.url + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    assert.notEqual(res.status, 502);
    assert.equal(stub.calls.some((c) => c.path.startsWith("/admin/")), false);
    assert.equal(stub.calls.some((c) => c.path === "/v1/chat/completions"), true);
  } finally {
    await proxy.close();
    await stub.close();
  }
});

test("sync ON: request without a model bypasses sync and forwards", async () => {
  const stub = await startStubOmlx({ ssdCacheDir: "/root/old" });
  const proxy = await startProxy({
    MLX_HOST: stub.host, MLX_PORT: String(stub.port),
    OMLX_CACHE_SYNC: "1", OMLX_CACHE_ROOT: "/root", MLX_API_KEY: "k",
  });
  try {
    const res = await fetch(proxy.url + "/v1/models", { method: "GET" });
    assert.equal(res.status, 200);
    assert.equal(stub.calls.some((c) => c.path.startsWith("/admin/")), false);
  } finally {
    await proxy.close();
    await stub.close();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AdminSession,
  isSyncEnabled,
  ModelResolver,
  syncCacheDir,
  validateConfig,
} from "../omlx-admin.js";
import { startStubOmlx } from "./helpers/stub-omlx.js";

test("isSyncEnabled is false when unset or falsey", () => {
  assert.equal(isSyncEnabled({}), false);
  assert.equal(isSyncEnabled({ OMLX_CACHE_SYNC: "0" }), false);
  assert.equal(isSyncEnabled({ OMLX_CACHE_SYNC: "false" }), false);
});

test("isSyncEnabled is true for truthy strings (case-insensitive)", () => {
  for (const v of ["1", "true", "TRUE", "yes", "on", " On "]) {
    assert.equal(isSyncEnabled({ OMLX_CACHE_SYNC: v }), true, v);
  }
});

test("validateConfig is a no-op when sync is off", () => {
  assert.doesNotThrow(() => validateConfig({}));
});

test("validateConfig throws naming all missing vars when sync is on", () => {
  assert.throws(
    () => validateConfig({ OMLX_CACHE_SYNC: "1" }),
    /OMLX_CACHE_ROOT.*MLX_API_KEY|MLX_API_KEY.*OMLX_CACHE_ROOT/,
  );
});

test("validateConfig passes when sync is on and config complete", () => {
  assert.doesNotThrow(() =>
    validateConfig({ OMLX_CACHE_SYNC: "1", OMLX_CACHE_ROOT: "/c", MLX_API_KEY: "k" }),
  );
});

test("validateConfig treats whitespace-only OMLX_CACHE_ROOT as missing", () => {
  assert.throws(
    () => validateConfig({ OMLX_CACHE_SYNC: "1", OMLX_CACHE_ROOT: "  ", MLX_API_KEY: "k" }),
    /OMLX_CACHE_ROOT/,
  );
});

test("AdminSession logs in once then reuses the cookie", async () => {
  const stub = await startStubOmlx({ ssdCacheDir: "/c/old" });
  try {
    const s = new AdminSession({ baseUrl: stub.url, apiKey: "k" });
    const a = await s.getJson("/admin/api/global-settings");
    const b = await s.getJson("/admin/api/global-settings");
    assert.equal(a.cache.ssd_cache_dir, "/c/old");
    assert.equal(b.cache.ssd_cache_dir, "/c/old");
    const logins = stub.calls.filter((c) => c.path === "/admin/api/login");
    assert.equal(logins.length, 1, "should log in exactly once");
  } finally {
    await stub.close();
  }
});

test("AdminSession re-logs in once on a 401 and retries", async () => {
  const stub = await startStubOmlx({ ssdCacheDir: "/c/old" });
  try {
    const s = new AdminSession({ baseUrl: stub.url, apiKey: "k" });
    await s.getJson("/admin/api/global-settings"); // first login
    stub.expireSessionOnce(); // next admin call 401s once
    const res = await s.getJson("/admin/api/global-settings"); // should recover
    assert.equal(res.cache.ssd_cache_dir, "/c/old");
    const logins = stub.calls.filter((c) => c.path === "/admin/api/login");
    assert.equal(logins.length, 2, "should have logged in again after expiry");
  } finally {
    await stub.close();
  }
});

test("AdminSession coalesces concurrent logins into a single login call", async () => {
  const stub = await startStubOmlx({ ssdCacheDir: "/c/old" });
  try {
    const s = new AdminSession({ baseUrl: stub.url, apiKey: "k" });
    await Promise.all([
      s.getJson("/admin/api/global-settings"),
      s.getJson("/admin/api/global-settings"),
      s.getJson("/admin/api/global-settings"),
    ]);
    const logins = stub.calls.filter((c) => c.path === "/admin/api/login");
    assert.equal(logins.length, 1, "concurrent requests should log in exactly once");
  } finally {
    await stub.close();
  }
});

test("AdminSession re-logs in once on a 403 and retries", async () => {
  const stub = await startStubOmlx({ ssdCacheDir: "/c/old" });
  try {
    const s = new AdminSession({ baseUrl: stub.url, apiKey: "k" });
    await s.getJson("/admin/api/global-settings"); // first login
    stub.expireSessionOnce(403); // next admin call 403s once
    const res = await s.getJson("/admin/api/global-settings"); // should recover
    assert.equal(res.cache.ssd_cache_dir, "/c/old");
    const logins = stub.calls.filter((c) => c.path === "/admin/api/login");
    assert.equal(logins.length, 2, "should have logged in again after a 403");
  } finally {
    await stub.close();
  }
});

test("AdminSession rejects when re-login after expiry itself fails", async () => {
  const stub = await startStubOmlx({ ssdCacheDir: "/c/old" });
  try {
    const s = new AdminSession({ baseUrl: stub.url, apiKey: "k" });
    await s.getJson("/admin/api/global-settings"); // first login succeeds
    stub.expireSessionOnce(); // next admin call 401s once
    stub.opts.loginStatus = 401; // the retry login now fails
    await assert.rejects(() => s.getJson("/admin/api/global-settings"), /login failed/i);
    const logins = stub.calls.filter((c) => c.path === "/admin/api/login");
    assert.equal(logins.length, 2, "re-login attempted exactly once");
  } finally {
    await stub.close();
  }
});

test("AdminSession throws when login fails", async () => {
  const stub = await startStubOmlx({ loginStatus: 401 });
  try {
    const s = new AdminSession({ baseUrl: stub.url, apiKey: "bad" });
    await assert.rejects(() => s.getJson("/admin/api/global-settings"), /login failed/i);
  } finally {
    await stub.close();
  }
});

test("AdminSession.postJson sends the cookie and JSON body", async () => {
  const stub = await startStubOmlx({ ssdCacheDir: "/c/old" });
  try {
    const s = new AdminSession({ baseUrl: stub.url, apiKey: "k" });
    await s.postJson("/admin/api/global-settings", { ssd_cache_dir: "/c/new" });
    assert.equal(stub.settings.cache.ssd_cache_dir, "/c/new");
    const post = stub.calls.find(
      (c) => c.method === "POST" && c.path === "/admin/api/global-settings",
    );
    assert.ok(post.cookie, "POST must carry the session cookie");
  } finally {
    await stub.close();
  }
});

test("ModelResolver maps alias and canonical id to the canonical id", async () => {
  const stub = await startStubOmlx();
  try {
    const s = new AdminSession({ baseUrl: stub.url, apiKey: "k" });
    const r = new ModelResolver(s);
    assert.equal(await r.resolve("qwen3.6-27B-4bit"), "Qwen3.6-27B-4bit");
    assert.equal(await r.resolve("Qwen3.6-27B-4bit"), "Qwen3.6-27B-4bit");
  } finally {
    await stub.close();
  }
});

test("ModelResolver caches the map (one /admin/api/models call for known models)", async () => {
  const stub = await startStubOmlx();
  try {
    const s = new AdminSession({ baseUrl: stub.url, apiKey: "k" });
    const r = new ModelResolver(s);
    await r.resolve("qwen3.6-27B-4bit");
    await r.resolve("llama-3.2-1B-Instruct-4bit");
    const modelCalls = stub.calls.filter((c) => c.path === "/admin/api/models");
    assert.equal(modelCalls.length, 1);
  } finally {
    await stub.close();
  }
});

test("ModelResolver coalesces concurrent cold-start resolves into one /admin/api/models call", async () => {
  const stub = await startStubOmlx();
  try {
    const s = new AdminSession({ baseUrl: stub.url, apiKey: "k" });
    const r = new ModelResolver(s);
    const results = await Promise.all([
      r.resolve("qwen3.6-27B-4bit"),
      r.resolve("qwen3.6-27B-4bit"),
      r.resolve("qwen3.6-27B-4bit"),
    ]);
    for (const out of results) assert.equal(out, "Qwen3.6-27B-4bit");
    const modelCalls = stub.calls.filter((c) => c.path === "/admin/api/models");
    assert.equal(modelCalls.length, 1, "concurrent resolves should load the map exactly once");
  } finally {
    await stub.close();
  }
});

test("ModelResolver refreshes once on a miss then resolves a newly-added model", async () => {
  const stub = await startStubOmlx();
  try {
    const s = new AdminSession({ baseUrl: stub.url, apiKey: "k" });
    const r = new ModelResolver(s);
    assert.equal(await r.resolve("qwen3.6-27B-4bit"), "Qwen3.6-27B-4bit"); // loads map
    stub.opts.models.push({ id: "New-Model-4bit", settings: { model_alias: "new-4bit" } });
    assert.equal(await r.resolve("new-4bit"), "New-Model-4bit"); // triggers refresh
    const modelCalls = stub.calls.filter((c) => c.path === "/admin/api/models");
    assert.equal(modelCalls.length, 2);
  } finally {
    await stub.close();
  }
});

test("ModelResolver returns null for a model that does not exist after refresh", async () => {
  const stub = await startStubOmlx();
  try {
    const s = new AdminSession({ baseUrl: stub.url, apiKey: "k" });
    const r = new ModelResolver(s);
    assert.equal(await r.resolve("does-not-exist"), null);
  } finally {
    await stub.close();
  }
});

function wiring(stub) {
  const session = new AdminSession({ baseUrl: stub.url, apiKey: "k" });
  return { session, resolver: new ModelResolver(session) };
}

test("syncCacheDir POSTs the flat per-model dir when current differs", async () => {
  const stub = await startStubOmlx({ ssdCacheDir: "/root/old" });
  try {
    const { session, resolver } = wiring(stub);
    const out = await syncCacheDir({
      session, resolver, root: "/root", model: "qwen3.6-27B-4bit",
    });
    assert.deepEqual(out, { updated: true, canonicalId: "Qwen3.6-27B-4bit", target: "/root/Qwen3.6-27B-4bit" });
    assert.equal(stub.settings.cache.ssd_cache_dir, "/root/Qwen3.6-27B-4bit");
    const post = stub.calls.find((c) => c.method === "POST" && c.path === "/admin/api/global-settings");
    assert.deepEqual(post.body, { ssd_cache_dir: "/root/Qwen3.6-27B-4bit" });
  } finally {
    await stub.close();
  }
});

test("syncCacheDir does NOT POST when current already matches", async () => {
  const stub = await startStubOmlx({ ssdCacheDir: "/root/Qwen3.6-27B-4bit" });
  try {
    const { session, resolver } = wiring(stub);
    const out = await syncCacheDir({ session, resolver, root: "/root", model: "Qwen3.6-27B-4bit" });
    assert.equal(out.updated, false);
    const posts = stub.calls.filter((c) => c.method === "POST" && c.path === "/admin/api/global-settings");
    assert.equal(posts.length, 0);
  } finally {
    await stub.close();
  }
});

test("syncCacheDir throws on an unresolvable model and does not POST", async () => {
  const stub = await startStubOmlx({ ssdCacheDir: "/root/old" });
  try {
    const { session, resolver } = wiring(stub);
    await assert.rejects(
      () => syncCacheDir({ session, resolver, root: "/root", model: "nope" }),
      /resolve/i,
    );
    const posts = stub.calls.filter((c) => c.method === "POST" && c.path === "/admin/api/global-settings");
    assert.equal(posts.length, 0);
  } finally {
    await stub.close();
  }
});

test("syncCacheDir throws on an unsafe canonical id (path traversal) and does not POST", async () => {
  const stub = await startStubOmlx({
    ssdCacheDir: "/root/old",
    models: [{ id: "../evil", settings: { model_alias: "evil" } }],
  });
  try {
    const { session, resolver } = wiring(stub);
    await assert.rejects(
      () => syncCacheDir({ session, resolver, root: "/root", model: "evil" }),
      /unsafe canonical model id/i,
    );
    const posts = stub.calls.filter((c) => c.method === "POST" && c.path === "/admin/api/global-settings");
    assert.equal(posts.length, 0);
  } finally {
    await stub.close();
  }
});

test("syncCacheDir propagates admin errors (fail closed)", async () => {
  const stub = await startStubOmlx({ failGlobalSettings: true });
  try {
    const { session, resolver } = wiring(stub);
    await assert.rejects(() => syncCacheDir({ session, resolver, root: "/root", model: "qwen3.6-27B-4bit" }));
  } finally {
    await stub.close();
  }
});

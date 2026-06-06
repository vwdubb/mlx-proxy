import { join } from "node:path";

// oMLX admin API client: login/session, model id resolution, cache-dir sync.

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export function isSyncEnabled(env) {
  return TRUTHY.has(String(env.OMLX_CACHE_SYNC ?? "").trim().toLowerCase());
}

export function validateConfig(env) {
  if (!isSyncEnabled(env)) return;
  const missing = [];
  if (!env.OMLX_CACHE_ROOT?.trim()) missing.push("OMLX_CACHE_ROOT");
  if (!env.MLX_API_KEY) missing.push("MLX_API_KEY");
  if (missing.length) {
    throw new Error(
      `OMLX_CACHE_SYNC is enabled but missing required env var(s): ${missing.join(", ")}`,
    );
  }
}

export class AdminSession {
  constructor({ baseUrl, apiKey, fetchImpl = fetch }) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.cookie = null;
    this._loginPromise = null;
  }

  // Coalesce concurrent logins behind a single in-flight promise so that
  // simultaneous #send calls trigger only one POST /admin/api/login.
  async login() {
    if (this._loginPromise) return this._loginPromise;
    this._loginPromise = this._doLogin().finally(() => {
      this._loginPromise = null;
    });
    return this._loginPromise;
  }

  async _doLogin() {
    const res = await this.fetch(`${this.baseUrl}/admin/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: this.apiKey, remember: true }),
    });
    if (!res.ok) throw new Error(`oMLX admin login failed: ${res.status}`);
    // getSetCookie() returns each Set-Cookie header separately (Node 22+);
    // the get("set-cookie") fallback assumes a single Set-Cookie header.
    const cookies = res.headers.getSetCookie?.() ??
      (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
    if (cookies.length === 0) throw new Error("oMLX admin login returned no session cookie");
    this.cookie = cookies.map((c) => c.split(";")[0]).join("; ");
    return this.cookie;
  }

  async #send(method, path, body) {
    const doFetch = () =>
      this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(this.cookie ? { cookie: this.cookie } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

    if (!this.cookie) await this.login();
    let res = await doFetch();
    if (res.status === 401 || res.status === 403) {
      this.cookie = null;
      await this.login();
      res = await doFetch();
    }
    if (!res.ok) throw new Error(`oMLX admin ${method} ${path} failed: ${res.status}`);
    return res;
  }

  async getJson(path) {
    const res = await this.#send("GET", path);
    return res.json();
  }

  async postJson(path, body) {
    const res = await this.#send("POST", path, body);
    return res.json().catch(() => ({}));
  }
}

export class ModelResolver {
  constructor(session) {
    this.session = session;
    this.map = null; // Map<alias|id, canonicalId>
    this._loadPromise = null;
  }

  // Coalesce concurrent map loads behind a single in-flight promise so that
  // simultaneous resolve() calls trigger only one GET /admin/api/models.
  async #loadMap() {
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = this.#doLoadMap().finally(() => {
      this._loadPromise = null;
    });
    return this._loadPromise;
  }

  async #doLoadMap() {
    const data = await this.session.getJson("/admin/api/models");
    const list = Array.isArray(data) ? data : (data.models ?? data.data ?? []);
    const map = new Map();
    for (const m of list) {
      if (!m?.id) continue;
      map.set(m.id, m.id);
      const alias = m.settings?.model_alias;
      if (alias) map.set(alias, m.id);
    }
    this.map = map;
    return map;
  }

  async resolve(model) {
    if (!this.map) await this.#loadMap();
    if (this.map.has(model)) return this.map.get(model);
    await this.#loadMap(); // one refresh-on-miss
    return this.map.has(model) ? this.map.get(model) : null;
  }
}

export async function syncCacheDir({ session, resolver, root, model }) {
  const canonicalId = await resolver.resolve(model);
  if (!canonicalId) {
    throw new Error(`Cannot resolve model to a canonical oMLX id: ${model}`);
  }
  if (canonicalId.includes("/") || canonicalId.includes("\\") || canonicalId.includes("..")) {
    throw new Error(`Refusing unsafe canonical model id: ${canonicalId}`);
  }
  const target = join(root, canonicalId);
  const settings = await session.getJson("/admin/api/global-settings");
  const current = settings?.cache?.ssd_cache_dir ?? null;
  if (current === target) return { updated: false, canonicalId, target };
  await session.postJson("/admin/api/global-settings", { ssd_cache_dir: target });
  return { updated: true, canonicalId, target };
}

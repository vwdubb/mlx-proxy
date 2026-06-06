# mlx-proxy

A small, zero-dependency HTTP reverse proxy that sits in front of an
[MLX](https://github.com/ml-explore/mlx) / `mlx_lm.server` OpenAI-compatible
endpoint and does three things:

1. **Injects the current date and time** into the latest user message of every
   chat request, so the model always knows "now" without you having to add it to
   your prompts.
2. **Optionally attaches an upstream API key** (`Authorization: Bearer …`) to
   every forwarded request, so you can point clients at the proxy without baking
   the key into each one.
3. **Optionally syncs oMLX's `ssd_cache_dir` per model** (off by default), so
   each model gets its own SSD cache directory before requests are forwarded.

Everything else is passed through untouched, including streaming responses.

## How it works

For each incoming request the proxy:

- Buffers the body and tries to parse it as JSON. If it looks like a chat
  payload (`messages` array), it finds the **last** message with `role: "user"`
  and prepends `Current date and time: <formatted timestamp>` to its content
  (handles both string content and the array/`{type:"text"}` content form).
- If the body isn't JSON or has no user message, it's forwarded as-is.
- Rewrites the `Host` header and `Content-Length` to match the upstream and the
  (possibly modified) body.
- If `MLX_API_KEY` is set, overwrites the `Authorization` header with
  `Bearer <MLX_API_KEY>`.
- Forwards to `http://$MLX_HOST:$MLX_PORT<original path>` and pipes the upstream
  response straight back to the client.

On upstream error it returns `502`. If the client disconnects mid-flight, the
upstream request is destroyed.

## Configuration

All configuration is via environment variables:

| Variable         | Default                  | Description                                                                 |
| ---------------- | ------------------------ | --------------------------------------------------------------------------- |
| `MLX_HOST`       | `host.docker.internal`   | Hostname/IP of the upstream MLX server.                                     |
| `MLX_PORT`       | `8080`                   | Port of the upstream MLX server.                                            |
| `MLX_PROXY_PORT` | `8081`                   | Port the proxy listens on.                                                  |
| `MLX_API_KEY`    | _(unset)_                | If set, sent to the upstream as `Authorization: Bearer <key>`. Unset = no auth header added (passthrough). |
| `OMLX_CACHE_SYNC` | _(unset)_ | When truthy (`1`/`true`/`yes`/`on`), before forwarding any request that names a `model`, the proxy points oMLX's global `ssd_cache_dir` at `<OMLX_CACHE_ROOT>/<canonical-model-id>`, updating it only when it differs. Off = current behavior. |
| `OMLX_CACHE_ROOT` | _(unset)_ | Root cache directory, e.g. `/Users/you/.omlx/cache`. Required when `OMLX_CACHE_SYNC` is on. |
| `TZ`             | `UTC`                    | Timezone used to format the injected date/time (e.g. `America/Toronto`).    |

### About `MLX_API_KEY`

- When **unset**, the proxy does not add or modify the `Authorization` header —
  whatever the client sent (if anything) is forwarded as-is. Existing setups
  keep working unchanged.
- When **set**, the proxy **overrides** any incoming `Authorization` header with
  `Bearer <MLX_API_KEY>`. This means clients of the proxy don't need to know the
  upstream key — point them at the proxy and let it authenticate on their behalf.
- The key authenticates the proxy **to the upstream MLX server**; the proxy
  itself does not authenticate its own clients. If you need to restrict who can
  reach the proxy, put it on a trusted network or behind a gateway that does.
- When `OMLX_CACHE_SYNC` is enabled, `MLX_API_KEY` must also have oMLX admin
  rights — the proxy uses it to log in to the oMLX admin API.

### About `OMLX_CACHE_SYNC`

When enabled, the proxy keeps a separate SSD cache directory per model. Before
forwarding a request that names a `model`, it:

1. Resolves the model to its **canonical id** (aliases are mapped to the real id
   via oMLX's admin `models` list — issue: alias calls otherwise reuse the wrong
   per-model state).
2. Reads oMLX's current global `ssd_cache_dir`.
3. If it isn't already `<OMLX_CACHE_ROOT>/<canonical-id>`, updates it via the
   admin API. Otherwise does nothing.

It authenticates to the oMLX admin API by logging in with `MLX_API_KEY` (the
same key must have admin rights) and reusing the session cookie.

**Fail closed:** if the admin login/read/write fails, or the model can't be
resolved, the proxy returns `502` and does **not** forward the request — a
request never runs against the wrong cache directory.

**Caveats:** `ssd_cache_dir` is a *global* oMLX setting, so this assumes one
model is served at a time (concurrent calls to different models would race). The
proxy does not trigger a model reload after changing the directory.

## Running

### Docker Compose (recommended)

The included `docker-compose.yml` builds the image and runs the proxy:

```yaml
services:
  mlx-proxy:
    build: .
    image: vwdubb/mlx-proxy:latest
    container_name: mlx-proxy
    restart: unless-stopped
    ports:
      - 28081:28081
    environment:
      MLX_HOST: host.docker.internal
      MLX_PORT: 28080
      MLX_PROXY_PORT: 28081
      TZ: America/Toronto
      MLX_API_KEY: your-upstream-key   # optional
    extra_hosts:
      - "host.docker.internal:host-gateway"
    mem_limit: 4g
```

```sh
docker compose up -d --build
```

To supply the API key without committing it, leave `MLX_API_KEY` out of the
compose file and pass it through the environment instead:

```sh
MLX_API_KEY=your-upstream-key docker compose up -d --build
```

(and reference it in compose as `MLX_API_KEY: ${MLX_API_KEY}` if you prefer it
explicit).

### Plain Node

Requires Node 22+ (uses ES modules and modern syntax; no dependencies).

```sh
MLX_HOST=192.168.11.150 \
MLX_PORT=28080 \
MLX_PROXY_PORT=28081 \
TZ=America/Toronto \
MLX_API_KEY=your-upstream-key \
node mlx-proxy.js
```

On startup it logs the route it's proxying, e.g.:

```
:28081 → 192.168.11.150:28080
```

## Usage

Point any OpenAI-compatible client at the proxy instead of the MLX server. For
example:

```sh
curl http://localhost:28081/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "your-model",
    "messages": [{ "role": "user", "content": "What day is it?" }]
  }'
```

The upstream model receives the user message prefixed with the current date and
time, so it can answer accurately.

## Notes & limitations

- Date/time injection only applies to JSON bodies containing a `messages` array
  with a `user` message — i.e. chat-completion-style requests. Other endpoints
  (e.g. `/v1/models`) and non-JSON bodies pass through unmodified.
- The injected timestamp is always added to the **last** user message.
- The proxy speaks plain HTTP to the upstream (`http://$MLX_HOST:$MLX_PORT`).

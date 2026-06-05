# mlx-proxy

A tiny HTTP proxy that sits in front of an [oMLX](https://github.com/jundot/omlx)
(or any OpenAI-compatible MLX) server and adds two things:

1. **Date/time injection** — prepends the current date and time to the last user
   message of every chat request, so the model always knows "now."
2. **oMLX-aware model memory management** *(optional)* — before forwarding a
   request that names a model, it asks oMLX which models are loaded and how much
   RAM is free, and proactively unloads other models so the requested one fits.

The proxy is a single dependency-free file (`mlx-proxy.js`, Node 22+).

## How it works

```
client ──▶ mlx-proxy ──▶ oMLX (/v1/* inference + management)
```

For every request the proxy injects the date/time into the last user message and
forwards it upstream unchanged. If `OMLX_API_KEY` is set and the client didn't
send its own credentials, the proxy adds `Authorization: Bearer <key>` to the
forwarded request — so callers can point at the proxy without needing the key
(a client that sends its own `Authorization`/`x-api-key` is left untouched).

Memory management is **entirely optional**. It only runs when `OMLX_API_KEY` is
set, *and* only if the upstream is actually oMLX: on the first model request the
proxy probes the oMLX management API, and if those endpoints aren't there (they
`404` — e.g. a plain `mlx_lm.server`), it disables itself for the rest of the run
and proxies normally (date/time injection still applies). So pointing this at a
non-oMLX backend, or leaving the key unset, behaves exactly like the plain proxy.

When it is active, any `POST` whose JSON body names a `model` runs a memory check
first. All oMLX calls are bearer-authed, so the key is simply sent as
`Authorization: Bearer …` — no admin session/cookie needed.

1. **Inspect** — `GET /v1/models/status` for each model's loaded/pinned state,
   size, last-access, and alias; and `GET /api/status` for the memory ceiling oMLX
   enforces (`model_memory_max`), current usage (`model_memory_used`), so
   free = ceiling − used, and the server-wide `active_requests`/`waiting_requests`
   counts. (If oMLX runs with no ceiling, the check is skipped.)
2. **Decide & unload** — if the requested model's estimated size plus a headroom
   margin won't fit in free RAM, unload the **least-recently-used non-pinned**
   models one at a time, only until it fits. But first **wait for the server to go
   idle** (see below): oMLX's unload is an *immediate abort* that cancels whatever
   the model is generating, so the proxy never unloads while anything is in flight.
3. **Proxy** — forward the request as normal.

### Waiting for idle

Unloading a model that's mid-generation would interrupt whoever is using it, and
oMLX's unload is an **immediate abort** — it kills that model's active requests.
oMLX only reports request counts **server-wide** (`active_requests` +
`waiting_requests` in `/api/status`); there is no per-model busy flag. So the only
signal that *guarantees* a given model is idle is the whole server being idle.
Before unloading anything, the proxy therefore waits until oMLX reports **zero
active and zero waiting requests**, re-polling every `OMLX_IDLE_POLL_MS`. Once the
server is idle, every loaded model is quiescent, so the LRU victims can be unloaded
without interrupting anyone. If the server won't go idle within
`OMLX_UNLOAD_IDLE_TIMEOUT_MS`, the proxy **fails closed with `503`** rather than
abort an in-flight request or forward into a likely out-of-memory.

> **Why server-wide, not per-model?** An earlier version tracked only the requests
> flowing **through the proxy**, per model. That missed work oMLX knew about but
> the proxy didn't — requests that bypassed the proxy, ones oMLX had queued, or a
> request whose model name didn't match the proxy's bookkeeping key — and an
> immediate-abort unload would kill them. Gating on oMLX's own idle state closes
> that gap. The trade-off is that the proxy won't unload while oMLX is serving
> *any* model (it fails closed with `503` instead); model switches at idle — the
> common case — are unaffected.

### Policy

- **Pinned models are never unloaded.** If unloading every non-pinned model
  still wouldn't make the request fit — because pinned models hold the RAM, or
  the model is simply too large for the ceiling — unloading can't help, so the
  proxy forwards the request as-is and lets oMLX handle it.
- **Fails closed (when oMLX *is* the backend).** The proxy returns `503` rather
  than risk an out-of-memory on the oMLX host when **either**: (a) the memory
  check can't be completed — oMLX unreachable, missing/invalid key, unexpected
  response, or an unknown model; **or** (b) room *could* have been freed by
  unloading non-pinned models, but the server wouldn't go idle within
  `OMLX_UNLOAD_IDLE_TIMEOUT_MS`, so the proxy declines to unload (which would
  abort an in-flight request) or to forward into a likely OOM. (Both are distinct
  from the *not-oMLX* case above, where the endpoints `404`, which disables the
  feature and proxies normally.)
- **RAM is read from oMLX itself,** not the proxy's host. The proxy typically
  runs in a container on a different machine than oMLX, so it relies on oMLX's
  enforced memory ceiling from `/api/status` (which already reserves headroom to
  prevent system-wide OOM).

> **Note:** oMLX already performs LRU eviction and enforces a total-memory limit
> on its own. This proxy logic is proactive belt-and-suspenders. Because
> unloading is server-wide, a request through the proxy can evict a model another
> client is using — pin anything that should never be swapped out.

## Configuration

All configuration is via environment variables.

| Variable | Default | Description |
| --- | --- | --- |
| `MLX_HOST` | `host.docker.internal` | Upstream oMLX host. |
| `MLX_PORT` | `8080` | Upstream oMLX port. |
| `MLX_PROXY_PORT` | `8081` | Port the proxy listens on. |
| `TZ` | `UTC` | Timezone used for the injected date/time. |
| `OMLX_API_KEY` | *(empty)* | oMLX API key (`omlx serve --api-key …`). **Set this to enable memory management;** leave empty for plain pass-through. Auto-disables if the upstream isn't oMLX. |
| `OMLX_HEADROOM_MB` | `1024` | Free-RAM safety margin (MB) required on top of the model's estimated size. |
| `OMLX_API_TIMEOUT_MS` | `5000` | Timeout for each oMLX API call (model list, status, unload). |
| `OMLX_UNLOAD_IDLE_TIMEOUT_MS` | `30000` | Max time to wait for the oMLX server to go idle (zero active/waiting requests) before giving up on unloading and failing closed. |
| `OMLX_IDLE_POLL_MS` | `250` | How often to re-poll `/api/status` for the server's active/waiting request counts while waiting for idle. |

## Running

### Docker Compose

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
      MLX_HOST: 192.168.11.150
      MLX_PORT: 28080
      MLX_PROXY_PORT: 28081
      TZ: America/Toronto
      OMLX_API_KEY: ${OMLX_API_KEY:-}
      OMLX_HEADROOM_MB: 1024
    extra_hosts:
      - "host.docker.internal:host-gateway"
    mem_limit: 4g
```

Provide the key out-of-band (e.g. an `.env` file or your secrets manager) rather
than hardcoding it:

```sh
OMLX_API_KEY=$(openssl rand -hex 12) docker compose up -d
```

### Directly with Node

```sh
MLX_HOST=192.168.11.150 MLX_PORT=28080 MLX_PROXY_PORT=28081 \
OMLX_API_KEY=your-key node mlx-proxy.js
```

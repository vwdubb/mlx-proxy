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
   enforces (`model_memory_max`) and current usage (`model_memory_used`), so
   free = ceiling − used. (If oMLX runs with no ceiling, the check is skipped.)
2. **Decide & unload** — if the requested model's estimated size plus a headroom
   margin won't fit in free RAM, unload the **least-recently-used non-pinned**
   models one at a time, only until it fits. Before unloading a model, **wait for
   it to go idle** (see below) so in-flight requests aren't interrupted —
   oMLX's unload is a hard abort that cancels active generations.
3. **Proxy** — forward the request as normal.

### Waiting for idle

Unloading a model that's mid-generation would interrupt whoever is using it. oMLX
only exposes an *aggregate* active-request count (no per-model busy flag), so the
proxy instead tracks the requests **it** has in flight per model. Before unloading
a model it waits until that model's in-flight count drops to zero, polling every
`OMLX_IDLE_POLL_MS`. If the model is still busy after `OMLX_UNLOAD_IDLE_TIMEOUT_MS`,
the proxy leaves it loaded and moves on to the next candidate. If, after trying
every candidate, room *could* have been made by unloading non-pinned models but
one wouldn't go idle in time, the proxy **fails closed with `503`** rather than
forward into a likely out-of-memory (see Policy below).

> This covers traffic flowing **through the proxy** — which is the intended
> deployment (clients point at the proxy). Requests sent to oMLX directly,
> bypassing the proxy, are not visible to the idle check.

### Policy

- **Pinned models are never unloaded.** If unloading every non-pinned model
  still wouldn't make the request fit — because pinned models hold the RAM, or
  the model is simply too large for the ceiling — unloading can't help, so the
  proxy forwards the request as-is and lets oMLX handle it.
- **Fails closed (when oMLX *is* the backend).** The proxy returns `503` rather
  than risk an out-of-memory on the oMLX host when **either**: (a) the memory
  check can't be completed — oMLX unreachable, missing/invalid key, unexpected
  response, or an unknown model; **or** (b) room *could* have been freed by
  unloading non-pinned models, but one wouldn't go idle within
  `OMLX_UNLOAD_IDLE_TIMEOUT_MS`, so the proxy declines to forward into a likely
  OOM. (Both are distinct from the *not-oMLX* case above, where the endpoints
  `404`, which disables the feature and proxies normally.)
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
| `OMLX_UNLOAD_IDLE_TIMEOUT_MS` | `30000` | Max time to wait for a model to go idle before giving up on unloading it. |
| `OMLX_IDLE_POLL_MS` | `250` | How often to re-check a model's in-flight count while waiting for idle. |

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

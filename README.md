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

1. **Inspect** — `GET /v1/models/status` is the single source of truth for the
   memory decision: each model's loaded/pinned state, size and alias, **and** the
   whole-server `final_ceiling` (the ceiling oMLX's `memory_guard` actually
   enforces) and `current_model_memory` (bytes in use), so free = ceiling − used.
   Taking loaded-state and usage from one snapshot keeps them consistent. (If oMLX
   reports no ceiling, the check is skipped.) `GET /api/status` is consulted
   separately only for the server-wide `active_requests`/`waiting_requests` counts.
2. **Decide & unload** — if the requested model's estimated size plus a headroom
   margin won't fit in free RAM, unload the **least-recently-used non-pinned**
   models one at a time, only until it fits — but **only while oMLX is idle**. If
   oMLX is doing any work, the request is rejected with `503` instead (see below):
   oMLX's unload is an *immediate abort*, so the proxy never unloads, nor waits,
   while anything is in flight.
3. **Proxy** — forward the request as normal.

### Concurrent loads

The fit check is meaningless if two requests can pass it at the same time: each
would read oMLX's current usage, each see its model fit, and both get forwarded —
overcommitting the ceiling once both load (oMLX then rejects one with a memory
error, which is exactly the failure this guards against). oMLX's reported usage
also *lags* by several seconds while a model loads, widening the window. So the
proxy **serializes load-admission** (requests for already-loaded models skip this
and aren't slowed) and, the moment it admits a model, **reserves that model's
size**, counting it against free RAM until oMLX reports the model loaded. A
concurrent admission therefore sees the pending load and unloads for it — or, if
nothing can be freed because the blocker is itself an in-flight load, **fails
closed with `503` ("retry shortly")** so the client retries once it settles.

### Never abort, never wait

Unloading a model that's mid-generation would interrupt whoever is using it:
oMLX's unload is an **immediate abort** that kills that model's requests, and
forwarding a fresh load into a busy oMLX lets oMLX itself evict-and-abort to make
room. oMLX reports work only **server-wide** (`active_requests` +
`waiting_requests` in `/api/status`); there is no per-model busy flag, so the only
safe moment to free memory is when the whole server is idle.

So when a request needs memory freed and oMLX is doing **any** work, the proxy
**rejects it immediately with `503`** — it does *not* wait for a lull, and it does
*not* interrupt the work. The client should retry; once the server is idle the
retry unloads the LRU victims and proceeds. The idle state is re-checked right
before each unload, so a generation that starts in the gap still can't be aborted
(the proxy bails to `503` instead). There is no timeout to tune — a busy server
means a prompt `503`, every time.

> **Why reject instead of wait?** Waiting was the bug: the proxy would watch for a
> momentary lull and then unload a few calls later, by which point a new generation
> had started — and get aborted. Rejecting when busy is both safe and immediate.
> The trade-off is that under continuous load, model switches that need eviction
> return `503` until the server quiesces; switches at idle — the common case — are
> unaffected.

### Policy

- **Pinned models are never unloaded.** If unloading every eligible (loaded,
  non-pinned, not-reserved) model still wouldn't make the request fit — because
  pinned models hold the RAM, or the model is too large for the ceiling — unloading
  can't help; with the server idle the proxy forwards as-is and lets oMLX decide.
- **Fails closed (when oMLX *is* the backend).** The proxy returns `503` rather
  than risk an out-of-memory or an aborted request when **either**: (a) the memory
  check can't be completed — oMLX unreachable, missing/invalid key, unexpected
  response, or an unknown model; **or** (b) the request needs memory freed but oMLX
  is busy (any active or waiting request), so unloading would abort an in-flight
  request and forwarding would invite an oMLX-side eviction. (Both are distinct
  from the *not-oMLX* case above, where the endpoints `404`, which disables the
  feature and proxies normally.)
- **RAM is read from oMLX itself,** not the proxy's host. The proxy typically
  runs in a container on a different machine than oMLX, so it relies on oMLX's
  enforced ceiling (`final_ceiling` from `/v1/models/status`, the value oMLX's
  `memory_guard` actually applies — already reserving headroom to prevent
  system-wide OOM).

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

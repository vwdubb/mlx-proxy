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
client ──▶ mlx-proxy ──▶ oMLX (/v1/* inference + /admin/api/* management)
```

For every request the proxy injects the date/time into the last user message and
forwards it upstream unchanged.

When `OMLX_API_KEY` is set, any `POST` whose JSON body names a `model` also runs a
memory check first:

1. **Authenticate** — exchanges `OMLX_API_KEY` for an admin session cookie via
   `POST /admin/api/login`. oMLX's status and unload endpoints require a session
   cookie (not a bearer key), so the key is logged in once and the cookie cached
   (re-acquired automatically on a `401`).
2. **Inspect** — `GET /admin/api/models` for the loaded/pinned state and size of
   each model, and `GET /admin/api/system-status` for free RAM.
3. **Decide & unload** — if the requested model's estimated size plus a headroom
   margin won't fit in free RAM, unload the **least-recently-used non-pinned**
   models one at a time, only until it fits.
4. **Proxy** — forward the request as normal.

### Policy

- **Pinned models are never unloaded.** If only pinned models are blocking the
  fit, the proxy forwards the request as-is and lets oMLX handle it.
- **Fails closed.** If the memory check can't be completed — oMLX admin
  unreachable, missing/invalid key, unexpected response, or an unknown model —
  the proxy returns `503` rather than risk an out-of-memory on the oMLX host.
- **RAM is read from oMLX itself,** not the proxy's host. The proxy typically
  runs in a container on a different machine than oMLX, so it relies on oMLX's
  `system-status` (which already reserves headroom to prevent system-wide OOM).

> **Note:** oMLX already performs LRU eviction and enforces a total-memory limit
> on its own. This proxy logic is proactive belt-and-suspenders. Because
> unloading is server-wide, a request through the proxy can evict a model another
> client is using — pin anything that should never be swapped out.

## Configuration

All configuration is via environment variables.

| Variable | Default | Description |
| --- | --- | --- |
| `MLX_HOST` | `host.docker.internal` | Upstream oMLX host. |
| `MLX_PORT` | `8080` | Upstream oMLX port (inference **and** admin API). |
| `MLX_PROXY_PORT` | `8081` | Port the proxy listens on. |
| `TZ` | `UTC` | Timezone used for the injected date/time. |
| `OMLX_API_KEY` | *(empty)* | oMLX admin/API key. **Set this to enable memory management;** leave empty for plain pass-through. |
| `OMLX_HEADROOM_MB` | `1024` | Free-RAM safety margin (MB) required on top of the model's estimated size. |
| `OMLX_ADMIN_TIMEOUT_MS` | `5000` | Timeout for each oMLX admin API call. |

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

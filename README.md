# mlx-proxy

A tiny (~40 line, zero-dependency) HTTP reverse proxy that sits in front of an
[MLX](https://github.com/ml-explore/mlx) / `mlx_lm.server` OpenAI-compatible
endpoint and does two things:

1. **Injects the current date and time** into the latest user message of every
   chat request, so the model always knows "now" without you having to add it to
   your prompts.
2. **Optionally attaches an upstream API key** (`Authorization: Bearer …`) to
   every forwarded request, so you can point clients at the proxy without baking
   the key into each one.

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

# llm-proxy

A tiny (~50 line, zero-dependency) HTTP reverse proxy that sits in front of one
or more OpenAI-compatible LLM endpoints — such as
[MLX](https://github.com/ml-explore/mlx) / `mlx_lm.server` on a Mac, or
`sparkrun` on an NVIDIA DGX Spark — and does two things:

1. **Injects the current date and time** into the latest user message of every
   chat request, so the model always knows "now" without you having to add it to
   your prompts.
2. **Optionally attaches an upstream API key** (`Authorization: Bearer …`) to
   every forwarded request, so you can point clients at the proxy without baking
   the key into each one.

Everything else is passed through untouched, including streaming responses.

Each endpoint is a `listen:host:port` triple: the proxy opens one listener per
endpoint and forwards to that host:port. Because the host is per endpoint, a
single proxy can front several backends at once — e.g. an MLX box and a DGX
Spark, or one port per model as `sparkrun` exposes them.

## How it works

For each incoming request the proxy:

- Buffers the body and tries to parse it as JSON. If it looks like a chat
  payload (`messages` array), it finds the **last** message with `role: "user"`
  and prepends `Current date and time: <formatted timestamp>` to its content
  (handles both string content and the array/`{type:"text"}` content form).
- If the body isn't JSON or has no user message, it's forwarded as-is.
- Rewrites the `Host` header and `Content-Length` to match the upstream and the
  (possibly modified) body.
- If `API_KEY` is set, overwrites the `Authorization` header with
  `Bearer <API_KEY>`.
- Forwards to the `host:port` of the endpoint whose listen port the request
  arrived on, at the original path, and pipes the upstream response straight
  back to the client.

On upstream error it returns `502`. If the client disconnects mid-flight, the
upstream request is destroyed.

## Configuration

All configuration is via environment variables:

| Variable    | Default   | Description                                                                                                   |
| ----------- | --------- | ------------------------------------------------------------------------------------------------------------- |
| `ENDPOINTS` | _(unset)_ | Comma-separated `listen:host:port` triples, e.g. `28080:localhost:8080,28001:spark:8001`. Each opens a proxy listener on `listen` forwarding to `host:port`. Required — the proxy exits with a usage message if unset. |
| `API_KEY`   | _(unset)_ | If set, sent upstream as `Authorization: Bearer <key>` on every endpoint. Unset = passthrough (incoming auth forwarded as-is). |
| `TZ`        | `UTC`     | Timezone used to format the injected date/time (e.g. `America/Toronto`).                                       |

There is no shared host variable; the host is specified per endpoint in
`ENDPOINTS`.

### About `API_KEY`

- When **unset**, the proxy does not add or modify the `Authorization` header —
  whatever the client sent (if anything) is forwarded as-is.
- When **set**, the proxy **overrides** any incoming `Authorization` header with
  `Bearer <API_KEY>` on every endpoint. This means clients of the proxy don't
  need to know the upstream key — point them at the proxy and let it
  authenticate on their behalf.
- The key authenticates the proxy **to the upstream server**; the proxy itself
  does not authenticate its own clients. If you need to restrict who can reach
  the proxy, put it on a trusted network or behind a gateway that does.

## Endpoints

Set `ENDPOINTS` to a comma-separated list of `listen:host:port` triples. The
proxy opens one listener per triple and forwards to that host:port, applying
date-injection and the optional `API_KEY` to each. Clients pick a
model/backend by choosing the matching proxy port.

Single endpoint (MLX):

```sh
ENDPOINTS="8081:127.0.0.1:8080" TZ=America/Toronto node llm-proxy.js
```

Multiple endpoints (MLX + DGX/sparkrun, one port per model):

```sh
ENDPOINTS="28080:localhost:8080,28001:spark:8001,28002:spark:8002" \
TZ=America/Toronto \
API_KEY=your-upstream-key \
node llm-proxy.js
```

On startup it logs one line per endpoint:

```
:28080 → localhost:8080
:28001 → spark:8001
:28002 → spark:8002
```

## Running

### Docker Compose (recommended)

The included `docker-compose.yml` builds the image and runs the proxy:

```yaml
services:
  llm-proxy:
    build: .
    image: vwdubb/llm-proxy:latest
    container_name: llm-proxy
    restart: unless-stopped
    ports:
      - 28080:28080
      - 28001:28001
      - 28002:28002
    environment:
      ENDPOINTS: "28080:host.docker.internal:8080,28001:spark:8001,28002:spark:8002"
      TZ: America/Toronto
      API_KEY: your-upstream-key   # optional, applied to every endpoint
    extra_hosts:
      - "host.docker.internal:host-gateway"
    mem_limit: 4g
```

```sh
docker compose up -d --build
```

To supply the API key without committing it, leave `API_KEY` out of the compose
file and pass it through the environment instead:

```sh
API_KEY=your-upstream-key docker compose up -d --build
```

(and reference it in compose as `API_KEY: ${API_KEY}` if you prefer it explicit).

### Plain Node

Requires Node 22+ (uses ES modules and modern syntax; no dependencies).

```sh
ENDPOINTS="28080:192.168.11.150:8080" \
TZ=America/Toronto \
API_KEY=your-upstream-key \
node llm-proxy.js
```

On startup it logs the route(s) it's proxying, e.g.:

```
:28080 → 192.168.11.150:8080
```

## Usage

Point any OpenAI-compatible client at the proxy instead of the backend. For
example:

```sh
curl http://localhost:28080/v1/chat/completions \
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
- The proxy speaks plain HTTP to the upstream (`http://<host>:<port>`).
- A single shared `API_KEY` is applied to every endpoint; per-endpoint keys are
  not supported.

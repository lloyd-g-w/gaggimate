# Gaggibot

Gaggibot moves Discord shot feedback off the ESP32. It is a small Node 22 service which receives one shot upload from GaggiMate, drives the Discord conversation over the Gateway (no 10-second Discord polling), and exposes an ordered feedback queue that GaggiMate writes into its existing shot notes. SQLite in `/data` preserves shots, pending workflows and feedback across restarts.

## Portainer deployment

### 1. Discord application

Use an existing Discord application or create one in the Discord Developer Portal (Gaggibot cannot do this for you):

1. **Bot**: reset/copy the token. Enable the **Message Content Intent**.
2. **Installation / Guild Install**: include the `bot` scope and **Send Messages**, **Read Message History**, and **Add Reactions** permissions; install it to a server shared with each recipient.
3. Enable Developer Mode in Discord, copy each recipient's user ID, and allow DMs from members of that server.

Never paste the bot token into GaggiMate. It belongs only in the stack environment.

### 2. Deploy the stack

In Portainer, create a **Git repository stack**, point it at this repository, and set the compose path to:

```
gaggibot/compose.yaml
```

Portainer must support building a compose service from the checked-out repository. Set these stack environment variables:

| Variable | Required | Meaning |
|---|---:|---|
| `DISCORD_BOT_TOKEN` | yes | Discord bot token |
| `DISCORD_USER_IDS` | yes | Comma-separated Discord user IDs |
| `GAGGIBOT_SHARED_TOKEN` | yes | Random string of at least 32 characters; configure the same value in GaggiMate |
| `GAGGIBOT_PORT` | no | Published host port *and* container port, default `3000` |
| `LOG_LEVEL` | no | `debug`, `info`, `warn`, or `error` |
| `AI_URL` | no | OpenAI-compatible `/chat/completions` URL |
| `AI_API_KEY` | no | Key for `AI_URL` |
| `AI_MODEL` | no | Model name, default `gpt-4o-mini` |

Generate a shared token locally, for example:

```sh
openssl rand -hex 32
```

The named volume `gaggibot-data` owns `/data`. Recreating/updating the container does not remove it. Do not delete the volume unless you intend to discard pending workflows and feedback. The container runs as the unprivileged `node` user, with a read-only root filesystem, all Linux capabilities dropped, and only `/data` plus a small temporary filesystem writable.

For local Docker Compose deployment:

```sh
cp .env.example .env
# edit .env
docker compose up --build -d
docker compose logs -f gaggibot
```

Health is exposed without authentication at `GET /health`. A healthy response requires both SQLite and the Discord Gateway to be ready. Do not expose port 3000 directly to the public internet; put it on a trusted LAN/VPN, or behind an HTTPS reverse proxy. The shared bearer token protects API calls but does not encrypt HTTP traffic.

## GaggiMate bridge API

All `/api/v1` endpoints require `Authorization: Bearer <GAGGIBOT_SHARED_TOKEN>`. JSON request bodies are capped at 32 KiB and API clients are rate-limited.

### Upload a shot

`POST /api/v1/shots` is idempotent on `(deviceId, shot.id)`:

```json
{
  "deviceId": "kitchen-machine",
  "shot": {
    "id": 224,
    "profile": "Direct Lever [Automatic Pro] v3.1",
    "duration": 8.5,
    "weight": 0,
    "temperature": 79.2,
    "pressure": 6.2,
    "flow": 5.7
  },
  "previous": {
    "rating": 3,
    "grindSetting": "3.5",
    "doseIn": 18,
    "beanType": "Ethiopia Guji",
    "notes": "bright"
  }
}
```

A new shot returns `202 {"accepted":true,"created":true}`; a retry returns 200 with `created:false` and does not duplicate the Discord flow.

### Fetch and acknowledge notes patches

```
GET /api/v1/feedback/kitchen-machine?after=0
```

```json
{"events":[{"id":1,"shotId":224,"patch":{"rating":4}}],"through":0}
```

Each answered field creates its own ordered event immediately. After applying all returned patches to shot history, acknowledge the highest successfully applied event:

```
POST /api/v1/feedback/kitchen-machine/ack
{"through":1}
```

Acknowledgement is monotonic and idempotent. Gaggibot retains a replay tail while pruning old acknowledged events.

`through` is the durable acknowledgement watermark. The display keeps its cursor in RAM, so after a reboot it asks with `after=0` and adopts `through` rather than re-applying every patch it already wrote.

`previous` is validated strictly, but `null` values are dropped before validation, so a display that has no prior value for a field may send an explicit `null` (older firmware did) or omit the field entirely.

## Device configuration

On the display: **Settings → Plugins → Discord Shot Feedback**, then set:

| Field | Value |
|---|---|
| Gaggibot URL | Base URL as reachable *from the display*, e.g. `http://192.168.1.50:3000` (no trailing slash needed) |
| Bridge access token | The same value as `GAGGIBOT_SHARED_TOKEN` |
| Device ID (optional) | Stable per-machine label; empty uses `gaggimate-<wi-fi mac>` |

Save & Restart. The card shows a **Mode** badge: *External Gaggibot (recommended)* when the URL is set, otherwise *Direct from display (legacy)*.

In bridge mode the display makes only two kinds of small HTTP requests: it uploads each saved shot once, then polls `GET /api/v1/feedback/<deviceId>?after=N` every 2 s (backing off to at most 5 minutes on repeated failures) until it can acknowledge the patches. It never contacts Discord or an AI provider itself, and the Discord token never leaves the container. Leaving the URL empty keeps the original on-device implementation working.

## Discord flow

Gaggibot sends a shot summary, then **rating → grind → dose in → bean → note**. Rating receives 1️⃣–5️⃣ and ➡️ reactions. Other steps receive ↩️ when the previous shot has a value (except notes) and always ➡️. A message or reaction advances immediately:

- 1️⃣–5️⃣ or a number saves the rating.
- ↩️ saves the shown previous value.
- ➡️ skips without writing anything.
- `key: value` fields separated by lines or `|` can answer several steps at once.
- Optional AI mode parses natural language and falls back to the deterministic parser.

Every answer is queued before the next prompt is sent. A newer shot supersedes an unfinished workflow for the same Discord user; fields already queued from the older shot remain available to GaggiMate.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
docker compose config
```

The test suite covers deterministic parsing, multi-field state advancement/reuse, null-tolerant ingestion, authentication, the acknowledgement watermark, and ordered feedback persistence.

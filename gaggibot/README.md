# Gaggibot

Gaggibot moves Discord shot feedback off the ESP32. It is a small Node 22 service which receives one shot upload from GaggiMate, drives the Discord conversation over the Gateway (no 10-second Discord polling), and exposes an ordered feedback queue that GaggiMate writes into its existing shot notes. SQLite in `/data` preserves shots, pending workflows and feedback across restarts.

## Portainer deployment

### 1. Discord application

Use an existing Discord application or create one in the Discord Developer Portal (Gaggibot cannot do this for you):

1. **Bot**: reset/copy the token. Enable the **Message Content Intent**.
2. **Installation / Guild Install**: include the `bot` scope and **Send Messages** and **Read Message History** permissions; install it to a server shared with each recipient. (*Add Reactions* is not needed: prompts use buttons.)
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

## Testing it

### 1. Is the deployment wired up? (no shot needed)

Open **Settings → Plugins → Discord Shot Feedback** and press **Send test message**. With a real
token this sends an actual Discord DM to every user in `DISCORD_USER_IDS` with a **✅ Tap to confirm
buttons work** button on it. Nothing is recorded as a shot, so it is safe to press any time.

Tap that button: the message changes to *Buttons work too*, which proves interactions reach the
bot — that is how every real step is answered. The result of the send appears right in the card, and
each failure explains itself, e.g.

| What you see | What to fix |
|---|---|
| *Bridge rejected the token* | Copy `GAGGIBOT_SHARED_TOKEN` into **Bridge access token** and Save & Restart |
| *Could not reach the bridge* | Wrong URL/port, or the container is not running |
| *Bridge is running but not connected to Discord yet* | Check the container logs; usually a bad `DISCORD_BOT_TOKEN` |
| *Bridge reached Discord but the DM failed* | The bot must share a server with you and have **Send Messages** |
| *Bridge is in DRY RUN mode* | `GAGGIBOT_DRY_RUN` is set on the container; remove it to send for real |

The same check from a shell (this *does* DM your users):

```sh
docker exec -it gaggibot node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/test',{method:'POST',headers:{authorization:'Bearer '+process.env.GAGGIBOT_SHARED_TOKEN}}).then(r=>r.json()).then(console.log)"
```

`GET /api/v1/ping` is a cheaper probe that makes no Discord call: it only proves the display can
reach the bridge and that the token is accepted.

### 2. Full flow without Discord or a shot

```sh
npm ci && npm run build
npm run smoke     # starts in DRY RUN mode, uploads a shot, answers every step, checks the events
```

`npm run smoke` prints every message the bot would have sent (summary, each prompt, recap), then
the feedback events the display would poll for and acknowledge. `npm test` covers the same paths.

### 3. Full flow with Discord

Pull a shot. Within a couple of seconds you should get the summary and the rating prompt; the
answer reaches shot history within about 2 s of each reply.

### Troubleshooting

| Log line / symptom | Cause and fix |
|---|---|
| `Discord login failed ... Discord rejected the requested intents` (`Used disallowed intents`) | **Message Content** is a privileged intent and is off by default. Discord Developer Portal → your app → **Bot** → **Privileged Gateway Intents** → enable **Message Content Intent** → Save → restart the container. |
| `Discord login failed ... Discord rejected the bot token` | Reset the token in the portal (Bot → Reset Token) and update `DISCORD_BOT_TOKEN`. |
| `Discord login failed ... Could not reach Discord` | The container has no DNS/internet access. |
| `/health` returns 503 with a `reason` | Expected while Discord is unreachable. The service stays up and retries with backoff (2 s doubling to 5 min); it never exit-loops. |
| Test says *reached Discord but the DM failed* | The bot must share a server with you (Guild Install, `bot` scope) and have **Send Messages**. |

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

Gaggibot sends a shot summary, then **rating → grind → dose in → bean → note**, one prompt per
step. Each prompt carries its controls as **buttons**, so it is interactive the instant it appears:

| Step | Buttons |
|---|---|
| Rate this shot | **1 2 3 4 5**, **↩️ Reuse *n*/5** (if the last shot was rated), **➡️ Skip** |
| Grind / Dose in / Bean | **↩️ Reuse *value*** (if the last shot has one), **➡️ Skip** |
| Note | **➡️ Skip** (notes are never reused) |

```
-# Shot #224 · step 1/5
# Rate this shot

Your last shot was rated *3/5*.

Tap 1–5 below or send a number from *1 to 5*.

-# 1–5 to rate · ↩️ to reuse *3/5* · ➡️ to skip
[ 1 ] [ 2 ] [ 3 ] [ 4 ] [ 5 ]
[ ↩️ Reuse 3/5 ] [ ➡️ Skip ]
```

- A tap or a text reply advances immediately; the answered prompt's buttons are retired once the
  next prompt is out, so a stale tap cannot land.
- ↩️ saves the shown previous value; ➡️ skips without writing anything.
- `key: value` fields separated by lines or `|` can answer several steps at once.
- Optional AI mode parses natural language and falls back to the deterministic parser.
- Manually added reactions (1️⃣–5️⃣, ↩️, ➡️) still work, mapped onto the same actions.

Why buttons rather than reactions: Discord rate-limits adding reactions to roughly one per 250 ms
per channel, so a rating prompt's six reactions trickled in over 1.5 s+ after every message.
Buttons are part of the message itself — no extra requests, no rate limit.

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

# Discord Shot Feedback

After every saved shot, the display sends you a Discord DM with a summary and collects your
rating, grind size, doses, beans and tasting notes — straight into the normal shot notes
(`/h/<id>.json` + the rating in the shot index), so everything shows up in **Shot History**,
the **Shot Analyzer** and **Statistics** exactly as if you had typed it into the web UI.

Optionally, an **AI mode** lets you answer in plain language and has any OpenAI-compatible
model extract the structured fields for you.

It can run in two modes, chosen on the plugin card:

| Mode | Where the work happens | When to use it |
|---|---|---|
| **External Gaggibot** (recommended) | A small Docker container on your network ([gaggibot/](../gaggibot/)) talks to Discord over a Gateway connection; the display only uploads the shot and polls for the answers | Faster, more reliable, keeps the Discord token off the display |
| **Direct from display** (legacy) | The display itself calls the Discord REST API | No extra host needed |

Set the **Gaggibot URL** on the plugin card to switch to the container; leave it empty for direct
mode. The conversation is identical in both modes — see [gaggibot/README.md](../gaggibot/README.md)
for deploying the container.

In **External Gaggibot** mode the display makes only two kinds of request: one shot upload per
shot, and a 2-second poll for the feedback queue. Discord is contacted only by the container, which
is where the bot token and any AI key live, so the sections below about the Discord application
apply to the container's environment instead of the plugin card.

---

## 1. One-time Discord setup

You need a **bot token** and your **user ID**. Nothing is created for you — do this once in
your own Discord account.

### 1.1 Create the bot

1. Open <https://discord.com/developers/applications> → **New Application** → give it a name (e.g. `GaggiMate`).
2. Left menu → **Bot** → **Reset Token** → copy the token. It is shown **only once**; you can
   always reset it again later (the old one stops working).
   - **Direct from display** needs no *Privileged Gateway Intents* (REST only). The **Gaggibot**
     container needs the **Message Content Intent** enabled so it can read your DM replies.

### 1.2 Give it the `bot` scope and install it to a server you are in

A bot can only open a DM with users it **shares a server with**. A private server containing just
you and the bot is perfect.

1. Left menu → **Installation**.
2. Under **Default Install Settings → Guild Install → Scopes** tick **`bot`** (leave
   `applications.commands` if it is there; it is harmless but unused).
3. In the **Permissions** box that appears, tick **Send Messages** and **Add Reactions** (the plugin
   seeds the reaction buttons itself). In **Gaggibot** mode also tick **Read Message History**.
4. **Save Changes**, then copy the **Install Link** (it now contains `scope=bot…&permissions=2048`).
5. Open that link in a browser → **Add to Server** → choose your server → **Authorise**.
6. Check the bot now appears in the server's member list.

> *User Install* / `applications.commands` alone is **not** enough — without the `bot` scope no
> bot user exists in any server and `POST /users/@me/channels` fails.

### 1.3 Find your user ID

Discord → **User Settings → Advanced → Developer Mode** (on) → right-click your own name
anywhere → **Copy User ID**. It is an 17–19 digit number.

### 1.4 Allow DMs from the bot

In the server: right-click the server icon → **Privacy Settings** → **Direct Messages** must be
allowed (or globally: User Settings → Privacy & Safety → *Allow direct messages from server
members*).

---

## 2. Configure GaggiMate

Web UI → **Settings → Plugins → Discord Shot Feedback**.

First pick a mode:

| Field | Meaning |
|---|---|
| **Gaggibot URL** | Base URL of the container as reachable *from the display*, e.g. `http://192.168.1.50:3102`. Setting this switches to **External Gaggibot** mode; the card shows the active mode as a badge. Leave empty for direct-from-display. |
| **Bridge access token** | Must equal `GAGGIBOT_SHARED_TOKEN` on the container. Only shown in Gaggibot mode. |
| **Device ID** | Optional stable per-machine label; empty uses `gaggimate-<wi-fi mac>`. Only shown in Gaggibot mode. |

Then, in **direct-from-display** mode:

| Field | Meaning |
|---|---|
| **Enable** | Turns the plugin on (registered at boot — requires **Save & Restart**) |
| **Bot Token** | The token from step 1.1 |
| **Users** | One row per Discord user: *User ID* + *enabled* checkbox. Untick to pause a person without deleting them. |
| **Include in message** | Which shot fields go into the summary: profile, duration, yield, temperature, pressure, flow |
| **AI mode** | Off = keyword parser (section 3.2). On = natural-language parsing via an LLM (section 3.3) |
| **AI API URL** | An OpenAI-compatible *chat completions* endpoint. Default `https://api.openai.com/v1/chat/completions` |
| **AI API Key** | Sent as `Authorization: Bearer …` |
| **AI Model** | e.g. `gpt-4o-mini` (default), or whatever your provider offers |

In Gaggibot mode the Discord token, users and AI settings live on the container instead, so those
fields are hidden.

Changing the enable toggle, token, users or mode takes effect after **Save & Restart**.

### 2.1 Test it before pulling a shot

Press **Send test message** on the card (after saving). It sends a real DM to every configured
user — with a ✅ reaction, so it also proves the bot can react, which is how every step is answered.
Nothing is recorded as a shot, so it is safe to press any time.

The result appears under the button:

| Message | Fix |
|---|---|
| ✓ *Test message sent to N Discord user(s)* | Working — you should have a DM |
| ✗ *Bridge rejected the token* | Copy `GAGGIBOT_SHARED_TOKEN` into **Bridge access token** |
| ✗ *Could not reach the bridge* | Wrong URL/port, or the container isn't running |
| ✗ *…enable Message Content Intent…* | Discord Developer Portal → your app → **Bot** → **Privileged Gateway Intents** → enable **Message Content Intent**, then restart the container |
| ✗ *Bridge reached Discord but the DM failed* | The bot must share a server with you and have **Send Messages** |
| ✗ *Discord API … 401* (direct mode) | Bad/reset token |

The same check from a shell, against the container: `POST /api/v1/test` with the bearer token.
`GET /api/v1/ping` is a cheaper probe that makes no Discord call.

---

## 3. Using it

Feedback is collected **one field at a time**, each in its own message, in this order:
**rating → grind → dose in → bean → note**. About 10 s after a shot is saved you get the summary,
immediately followed by the first step.

### 3.1 The summary

```
☕ Shot #142 — Classic
⏱ 28.4 s   ⚖️ 36.2 g   🌡 93 °C   ⏫ 9.1 bar   💧 1.8 ml/s
Let's log it — answer each step, ↩️ reuses your last shot's value, ➡️ skips.
```

(Which stats appear is configurable — *Include in message*.)

### 3.2 The steps

Every step message shows what you entered for your **previous shot** (if anything) and already
carries the reactions you need — just click:

```
Shot #142 · step 3/5
# Dose in

Your last shot was *18.0 g* in.

Send the dose for this shot as a message, e.g. 18

-# React ↩️ to reuse *18.0 g* · ➡️ to skip
```

| Step | Answer by text | Reactions pre-added by the bot |
|---|---|---|
| **Rate this shot** | a number `1`–`5` | 1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣ ➡️ |
| **Grind** | e.g. `3.5` | ↩️ (if a last value exists) ➡️ |
| **Dose in** | e.g. `18` | ↩️ ➡️ |
| **Bean** | e.g. `Ethiopia Guji` | ↩️ ➡️ |
| **Note** | free text | ➡️ (notes are never reused) |

- **↩️ reuse** saves your previous shot's value for this field and moves on.
- **➡️ skip** saves nothing for this field and moves on.
- Typing a value saves it and moves on. Clicking a rating later overrides an earlier click.
- If you click both a value and ➡️, the value wins (skip is the likelier mis-click).

After the last step the bot sends a recap, e.g. `✅ Shot #142 logged: rating 4, grind 3.5, in 18.0 g, bean Ethiopia Guji, note.`
Each field is saved the moment you answer it, so you can stop halfway and keep what you entered.

### 3.3 Answering more than one field at once

A text reply may also contain `key: value` segments (separated by `|` or new lines) for other
fields; the bot saves all of them and **skips the steps you already answered**. Keys are
case-insensitive:

| Key(s) | Saved as |
|---|---|
| `rating`, `rate`, `stars` | rating (1–5) |
| `grind`, `grinder` | grindSetting |
| `in`, `dose`, `dosein` | doseIn (g) |
| `out`, `yield`, `doseout` | doseOut (g) — optional, the scale already provides yield |
| `bean`, `beans`, `coffee` | beanType |
| `note`, `notes` | notes |

Text without a key is the answer to the step being asked (on the note step, or a non-numeric
answer on the rating step, it becomes the note). Backticks and `<placeholder>` tokens are ignored.
Only the fields you mention are changed; the ratio (`out ÷ in`) is recalculated when both doses
are known.

### 3.4 AI mode

Same step flow, same reactions. The difference is that each text reply goes to your configured
model together with a hint naming the field being asked, so plain language works at any step:

> on the note step: *"bit sour, ran fast — grinder was 3.2 with the Ethiopian, 18 in, solid 4 stars"*

→ note saved, and grind 3.2, bean Ethiopian, dose in 18 and rating 4 are picked up too (the
remaining steps are skipped automatically). A bare value is assigned to the field being asked.

- Requests use `temperature: 0` and OpenAI JSON mode (`response_format: json_object`). If your
  provider rejects that with HTTP 400, the request is retried once without it, so Groq,
  OpenRouter, Ollama (`http://…/v1/chat/completions`), LM Studio etc. work too.
- If the AI call fails or returns unusable JSON, the keyword parser (3.3) is used as a fallback.
- The API key is never written to the log.

---

## 4. What gets stored

Exactly the shot-notes document the web UI edits (see [shot-notes-api.md](shot-notes-api.md)):

```json
{ "rating": 4, "grindSetting": "3.5", "doseIn": "18.0", "doseOut": "36.2",
  "ratio": "2.01", "beanType": "Ethiopia Guji", "notes": "bright, a bit sour" }
```

Only the keys you mention are overwritten; existing notes are kept. The shot index entry's
`rating` (and `volume` when `doseOut` is given) is updated the same way the web UI does it.
If the write fails (e.g. full filesystem) the bot says so instead of confirming, and reaction
ratings are retried on the next poll.

---

## 5. How it works (for the curious)

**Direct from display** — Discord's real-time Gateway (WebSocket) is too heavy for the ESP32, so
this mode uses the **REST API v10** with polling: `POST /users/@me/channels` (open DM, cached per
user), `POST /channels/{id}/messages` (send), `PUT /channels/{id}/messages/{id}/reactions/{emoji}/@me` (pre-seeded reactions), `GET /channels/{id}/messages/{id}` (read reactions),
`GET /channels/{id}/messages?after=…&limit=10` (replies; only *your* messages are processed,
so the bot's own acks are skipped).
- All networking runs on a dedicated FreeRTOS task; the shot-saved event only queues the shot id.
- HTTPS uses the firmware's bundled CA store (no insecure mode). 8 s timeouts, 16 KB body cap,
  `429 retry_after` honoured (capped at 30 s, one retry).
- State is in RAM only: a reboot during the 30-minute window ends that window (fields already answered stay saved).

**External Gaggibot** — the display makes only two kinds of request and never talks to Discord:
`POST <base>/api/v1/shots` once per saved shot (idempotent on device + shot id), then
`GET <base>/api/v1/feedback/<deviceId>?after=N` every 2 s (backing off to at most 5 minutes on
failure). Each answered field becomes an ordered feedback event; the display applies it to shot
history and only then acknowledges it with `POST …/ack`, so nothing is lost if it reboots — it
adopts the bridge's durable acknowledgement watermark instead of replaying. Uploads and feedback
both run on the plugin's own task, so neither blocks brewing or the web UI.

---

## 6. Troubleshooting

Start with **Send test message** (section 2.1): it reports the bridge's own diagnosis, which is
usually more specific than anything below. For direct mode, watch the display's serial log
(`pio device monitor` or the sim log) for lines tagged `DiscordPlugin`:

| Log / symptom | Cause / fix |
|---|---|
| `Failed to open DM channel for a configured user` | Bot doesn't share a server with that user (step 1.2), DMs blocked (1.4), or wrong user ID |
| `Discord API POST /users/@me/channels -> 401` | Bad/reset token — paste the current one |
| `Discord API … -> 403` | Bot lacks *Send Messages* in the shared server, or the user blocks DMs |
| `Discord API … -> 429` | Rate limited; the plugin backs off automatically |
| `Gaggibot shot upload failed for shot N -> 400` | Payload rejected by the bridge — a bug; the display sanitises the values it sends, so please report it |
| `Gaggibot shot upload failed for shot N -> 401` | Bridge token mismatch or leading/trailing space in the token field |
| `Gaggibot feedback poll failed -> 404` | URL points somewhere other than the container (the API lives under `/api/v1`) |
| `Gaggibot returned invalid feedback JSON` | Something other than Gaggibot answered on that URL (a proxy or another web server) |
| AI parse request failed: <code> | Wrong URL/key/model; `401` = key, `404` = URL, `400` = model/provider incompatibility (the `response_format` retry already happened) |
| No DM at all | Plugin not enabled + restarted; WiFi down (nothing is sent until reconnected); no enabled user rows. In bridge mode also check the container is up and the URL/port match |
| Reaction not picked up | Click the bot's own reactions on the **current** step message (older steps are no longer watched). Direct mode polls every 10 s; the bridge reacts instantly |
| `Failed to add reaction on message …` | Rate-limited or DM blocked; you can still add the reaction yourself or answer by text |
| `Failed to send step N …, will retry` | Transient network/rate-limit error; the step is re-sent on the next poll (10 s) |
| Container log: `Used disallowed intents` | Enable **Message Content Intent** in the Discord Developer Portal (Gaggibot mode only) |

Settings storage keys (NVS): direct mode `dsc`, `dsc_t`, `dsc_u`, `dsc_f`, `dsc_ai`, `dsc_url`, `dsc_key`, `dsc_m`; bridge mode `ggb_url`, `ggb_tok`, `ggb_dev`.

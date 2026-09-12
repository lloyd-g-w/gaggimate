# Discord Shot Feedback

After every saved shot, the display sends you a Discord DM with a summary and collects your
rating, grind size, doses, beans and tasting notes — straight into the normal shot notes
(`/h/<id>.json` + the rating in the shot index), so everything shows up in **Shot History**,
the **Shot Analyzer** and **Statistics** exactly as if you had typed it into the web UI.

Optionally, an **AI mode** lets you answer in plain language and has any OpenAI-compatible
model extract the structured fields for you.

> The plugin runs entirely on the display (ESP32). No companion server is needed.

---

## 1. One-time Discord setup

You need a **bot token** and your **user ID**. Nothing is created for you — do this once in
your own Discord account.

### 1.1 Create the bot

1. Open <https://discord.com/developers/applications> → **New Application** → give it a name (e.g. `GaggiMate`).
2. Left menu → **Bot** → **Reset Token** → copy the token. It is shown **only once**; you can
   always reset it again later (the old one stops working).
   - No *Privileged Gateway Intents* are needed. The plugin uses the REST API only.

### 1.2 Give it the `bot` scope and install it to a server you are in

A bot can only open a DM with users it **shares a server with**. A private server containing just
you and the bot is perfect.

1. Left menu → **Installation**.
2. Under **Default Install Settings → Guild Install → Scopes** tick **`bot`** (leave
   `applications.commands` if it is there; it is harmless but unused).
3. In the **Permissions** box that appears, tick **Send Messages** (that is all the plugin needs).
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

Web UI → **Settings → Plugins → Discord Shot Feedback**:

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

Changing the enable toggle, token or users takes effect after **Save & Restart**.

---

## 3. Using it

### 3.1 The message

About 10 s after a shot is saved you receive a DM like:

```
☕ Shot #142 — Classic
⏱ 28.4 s   ⚖️ 36.2 g   🌡 93 °C   ⏫ 9.1 bar   💧 1.8 ml/s
Rate it: react 1️⃣–5️⃣ or reply. Reply with lines like:
grind: 3.5 | in: 18 | out: 36 | bean: <name> | note: <text>
```

The plugin then watches that message for **30 minutes**, checking every **10 s**.

### 3.2 Answering — keyword mode (AI off)

- **Rating**: react to the message with **1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣**, or reply with just a digit `1`–`5`.
- **Everything else**: reply with `key: value` segments separated by `|` or new lines. Keys are
  case-insensitive:

| Key(s) | Saved as |
|---|---|
| `rating`, `rate`, `stars` | rating (1–5) |
| `grind`, `grinder` | grindSetting |
| `in`, `dose`, `dosein` | doseIn (g) |
| `out`, `yield`, `doseout` | doseOut (g) |
| `bean`, `beans`, `coffee` | beanType |
| `note`, `notes` | notes |

Text without a `key:` prefix is appended to **notes**. Several `note:` segments are joined.
The ratio (`out ÷ in`) is recalculated automatically when both doses are known.

Examples:

```
4
grind: 3.5 | note: bright, a bit sour
in: 18
out: 36.2
bean: Ethiopia Guji
```

You can send several replies; each one patches only the fields it mentions. The bot answers
with what it saved, e.g. `✅ Saved: rating 4, grind 3.5`.

### 3.3 Answering — AI mode

The summary ends with *"…or just tell me how it was"*. Reply naturally:

> pretty good but ran a bit fast, grinder on 3.2 with the Ethiopian, 18 in 38 out, nice acidity

The reply is sent to your configured endpoint with a fixed system prompt that asks for a JSON
object with `rating`, `grindSetting`, `doseIn`, `doseOut`, `beanType`, `notes` (null when not
mentioned; the model is told never to invent values). Anything about taste/experience becomes
**notes**. Reactions still work for the rating.

- Requests use `temperature: 0` and OpenAI JSON mode (`response_format: json_object`). If your
  provider rejects that with HTTP 400, the request is retried once without it, so Groq,
  OpenRouter, Ollama (`http://…/v1/chat/completions`), LM Studio etc. work too.
- If the AI call fails or returns unusable JSON, the keyword parser (3.2) is used as a fallback.
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

- Discord's real-time Gateway (WebSocket) is too heavy for the ESP32, so the plugin uses the
  **REST API v10** with polling: `POST /users/@me/channels` (open DM, cached per user),
  `POST /channels/{id}/messages` (send), `GET /channels/{id}/messages/{id}` (reactions),
  `GET /channels/{id}/messages?after=…&limit=10` (replies; only *your* messages are processed,
  so the bot's own acks are skipped).
- All networking runs on a dedicated FreeRTOS task; the shot-saved event only queues the shot id.
- HTTPS uses the firmware's bundled CA store (no insecure mode). 8 s timeouts, 16 KB body cap,
  `429 retry_after` honoured (capped at 30 s, one retry).
- State is in RAM only: a reboot during the 30-minute window ends that window.

---

## 6. Troubleshooting

Watch the display's serial log (`pio device monitor` or the sim log) for lines tagged `DiscordPlugin`:

| Log / symptom | Cause / fix |
|---|---|
| `Failed to open DM channel for a configured user` | Bot doesn't share a server with that user (step 1.2), DMs blocked (1.4), or wrong user ID |
| `Discord API POST /users/@me/channels -> 401` | Bad/reset token — paste the current one |
| `Discord API … -> 403` | Bot lacks *Send Messages* in the shared server, or the user blocks DMs |
| `Discord API … -> 429` | Rate limited; the plugin backs off automatically |
| `AI parse request failed: <code>` | Wrong URL/key/model; `401` = key, `404` = URL, `400` = model/provider incompatibility (the `response_format` retry already happened) |
| No DM at all | Plugin not enabled + restarted; WiFi down (nothing is sent until reconnected); no enabled user rows |
| Reaction not picked up | Only the **keycap** emojis 1️⃣–5️⃣ count; reactions are checked every 10 s within 30 min of the shot |

Settings storage keys (NVS): `dsc`, `dsc_t`, `dsc_u`, `dsc_f`, `dsc_ai`, `dsc_url`, `dsc_key`, `dsc_m`.

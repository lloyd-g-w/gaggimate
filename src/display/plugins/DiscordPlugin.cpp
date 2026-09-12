#include "DiscordPlugin.h"

#include <WiFi.h>
#include <algorithm>
#include <cstring>
#include <display/core/Controller.h>
#include <display/core/Event.h>
#include <display/core/utils.h>
#include <display/plugins/ShotHistoryPlugin.h>
#include <display/util/PsramAllocator.h>

// Same CA bundle symbol used by lib/OTA/src/GitHubOTA.h for HTTPS requests off the OTA path.
extern const uint8_t x509_crt_imported_bundle_bin_start[] asm("_binary_x509_crt_bundle_start");

namespace {
constexpr uint32_t DISCORD_MAX_BODY_BYTES = 16384;
constexpr float DISCORD_MAX_RETRY_AFTER_S = 30.0f;
constexpr const char *DISCORD_USER_AGENT = "GaggiMate (https://github.com/lloyd-g-w/gaggimate, 1.0)";
constexpr const char *DISCORD_API_BASE = "https://discord.com/api/v10";

constexpr const char *AI_SYSTEM_PROMPT =
    "You extract espresso shot feedback. Return ONLY a JSON object with keys rating (integer 1-5 or null), "
    "grindSetting (string or null), doseIn (number grams or null), doseOut (number grams or null), beanType (string "
    "or null), notes (string or null: everything else the user said about taste/experience, concise). Never invent "
    "values.";

// Discord keycap reaction emoji for a 1-5 rating, indexed 0-4.
const char *const RATING_KEYCAPS[5] = {"1\xEF\xB8\x8F\xE2\x83\xA3", "2\xEF\xB8\x8F\xE2\x83\xA3", "3\xEF\xB8\x8F\xE2\x83\xA3",
                                        "4\xEF\xB8\x8F\xE2\x83\xA3", "5\xEF\xB8\x8F\xE2\x83\xA3"};

// bit0 profile, bit1 duration, bit2 yield/volume, bit3 avgTemp, bit4 maxPressure, bit5 avgFlow
constexpr int FIELD_BIT_PROFILE = 0x01;
constexpr int FIELD_BIT_DURATION = 0x02;
constexpr int FIELD_BIT_VOLUME = 0x04;
constexpr int FIELD_BIT_TEMP = 0x08;
constexpr int FIELD_BIT_PRESSURE = 0x10;
constexpr int FIELD_BIT_FLOW = 0x20;
} // namespace

void DiscordPlugin::setup(Controller *c, PluginManager *pm) {
    controller = c;
    pluginManager = pm;
    wifiClient.setCACertBundle(x509_crt_imported_bundle_bin_start);
    pluginManager->on("evt:history-shot-saved", [this](Event const &e) { enqueueShot(e.getInt("id")); });
    xTaskCreatePinnedToCore(loopTask, "DiscordPlugin::loop", configMINIMAL_STACK_SIZE * 8, this, 1, &taskHandle, 0);
}

void DiscordPlugin::loopTask(void *arg) {
    auto *self = static_cast<DiscordPlugin *>(arg);
    for (;;) {
        self->taskLoop();
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

void DiscordPlugin::enqueueShot(uint32_t shotId) {
    std::lock_guard<std::mutex> guard(queueMutex);
    pendingShotIds.push_back(shotId);
}

std::vector<uint32_t> DiscordPlugin::drainQueue() {
    std::lock_guard<std::mutex> guard(queueMutex);
    std::vector<uint32_t> drained;
    drained.swap(pendingShotIds);
    return drained;
}

void DiscordPlugin::taskLoop() {
    if (WiFi.status() != WL_CONNECTED) {
        return;
    }

    for (uint32_t shotId : drainQueue()) {
        processNewShot(shotId);
    }

    uint32_t now = millis();
    if (now - lastPollMs < DISCORD_POLL_INTERVAL_MS) {
        return;
    }
    lastPollMs = now;

    for (auto it = pending.begin(); it != pending.end();) {
        if (now - it->startedMs > DISCORD_WINDOW_MS) {
            it = pending.erase(it);
            continue;
        }
        pollPendingShot(*it);
        ++it;
    }
}

void DiscordPlugin::processNewShot(uint32_t shotId) {
    Settings &settings = controller->getSettings();
    String summary = buildSummaryMessage(shotId);

    for (const String &entry : explode(settings.getDiscordUsers(), ';')) {
        std::vector<String> parts = explode(entry, ':');
        if (parts.size() < 2) {
            continue;
        }
        String userId = parts[0];
        userId.trim();
        bool enabled = parts[1].toInt() == 1;
        if (userId.isEmpty() || !enabled) {
            continue;
        }

        String channelId = getOrOpenDmChannel(userId);
        if (channelId.isEmpty()) {
            ESP_LOGW("DiscordPlugin", "Failed to open DM channel for a configured user");
            continue;
        }
        String messageId = sendMessage(channelId, summary);
        if (messageId.isEmpty()) {
            ESP_LOGW("DiscordPlugin", "Failed to send shot summary for shot %u", shotId);
            continue;
        }

        DiscordPendingShot p;
        p.shotId = shotId;
        p.userId = userId;
        p.channelId = channelId;
        p.messageId = messageId;
        p.lastSeenMessageId = messageId;
        p.startedMs = millis();
        pending.push_back(p);
    }
}

String DiscordPlugin::buildSummaryMessage(uint32_t shotId) {
    ShotIndexEntry entry{};
    bool ok = ShotHistory.getIndexEntry(shotId, entry);
    Settings &settings = controller->getSettings();
    int fields = settings.getDiscordFields();

    String title = "\u2615 Shot #" + String(shotId);
    if (ok && (fields & FIELD_BIT_PROFILE)) {
        title += " \u2014 " + String(entry.profileName);
    }
    String msg = title + "\n";

    if (ok) {
        std::vector<String> parts;
        if (fields & FIELD_BIT_DURATION) {
            parts.push_back("\u23F1 " + String(entry.duration / 1000.0f, 1) + " s");
        }
        if (fields & FIELD_BIT_VOLUME) {
            parts.push_back("\u2696\uFE0F " + String(entry.volume / 10.0f, 1) + " g");
        }
        if (fields & FIELD_BIT_TEMP) {
            parts.push_back("\U0001F321 " + String(entry.avgTemp / 10.0f, 1) + " \u00B0C");
        }
        if (fields & FIELD_BIT_PRESSURE) {
            parts.push_back("\u23EB " + String(entry.maxPressure / 10.0f, 1) + " bar");
        }
        if (fields & FIELD_BIT_FLOW) {
            parts.push_back("\U0001F4A7 " + String(entry.avgFlow / 100.0f, 1) + " ml/s");
        }
        if (!parts.empty()) {
            msg += implode(parts, "   ") + "\n";
        }
    }

    if (settings.isDiscordAi()) {
        msg += "Rate it: react 1\xEF\xB8\x8F\xE2\x83\xA3\u20135\xEF\xB8\x8F\xE2\x83\xA3 or just tell me how it was "
               "\u2014 grind size, doses, beans, tasting notes in plain language.";
    } else {
        msg += "Rate it: react 1\xEF\xB8\x8F\xE2\x83\xA3\u20135\xEF\xB8\x8F\xE2\x83\xA3 or reply. Reply with lines "
               "like:\n";
        msg += "grind: 3.5 | in: 18 | out: 36 | bean: <name> | note: <text>";
    }
    return msg;
}

DiscordPlugin::HttpResult DiscordPlugin::discordRequest(const char *method, const String &path, const String &jsonBody) {
    HttpResult result;
    String token = controller->getSettings().getDiscordBotToken();
    if (token.isEmpty()) {
        return result;
    }

    // One retry at most: only used to back off once after a 429 before giving up for this tick.
    for (int attempt = 0; attempt < 2; attempt++) {
        HTTPClient http;
        http.setTimeout(8000);
        String url = String(DISCORD_API_BASE) + path;
        if (!http.begin(wifiClient, url)) {
            ESP_LOGW("DiscordPlugin", "Failed to begin HTTPS request");
            return result;
        }
        http.addHeader("Authorization", "Bot " + token);
        http.addHeader("Content-Type", "application/json");
        http.addHeader("User-Agent", DISCORD_USER_AGENT);

        int code = strcmp(method, "POST") == 0 ? http.POST(jsonBody) : http.GET();
        String body;
        if (http.getSize() <= static_cast<int>(DISCORD_MAX_BODY_BYTES)) {
            body = http.getString();
        }
        http.end();

        // Always keep the latest status/body so callers (and the log) see the
        // real final outcome even when the retry budget is exhausted on a 429.
        result.status = code;
        result.body = body;

        if (code == 429 && attempt == 0) {
            float retryAfter = 1.0f;
            JsonDocument doc(&psramAllocator);
            if (deserializeJson(doc, body) == DeserializationError::Ok) {
                retryAfter = doc["retry_after"] | 1.0f;
            }
            retryAfter = std::max(0.0f, std::min(retryAfter, DISCORD_MAX_RETRY_AFTER_S));
            vTaskDelay(pdMS_TO_TICKS(static_cast<uint32_t>(retryAfter * 1000)));
            continue;
        }

        if (code < 200 || code >= 300) {
            ESP_LOGW("DiscordPlugin", "Discord API %s %s -> %d", method, path.c_str(), code);
        }
        return result;
    }
    return result;
}

String DiscordPlugin::getOrOpenDmChannel(const String &userId) {
    auto it = dmChannelByUser.find(userId);
    if (it != dmChannelByUser.end()) {
        return it->second;
    }

    JsonDocument doc(&psramAllocator);
    doc["recipient_id"] = userId;
    String body;
    serializeJson(doc, body);

    HttpResult result = discordRequest("POST", "/users/@me/channels", body);
    if (result.status < 200 || result.status >= 300) {
        return "";
    }
    JsonDocument resp(&psramAllocator);
    if (deserializeJson(resp, result.body) != DeserializationError::Ok) {
        return "";
    }
    String channelId = resp["id"] | "";
    if (!channelId.isEmpty()) {
        dmChannelByUser[userId] = channelId;
    }
    return channelId;
}

String DiscordPlugin::sendMessage(const String &channelId, const String &content) {
    JsonDocument doc(&psramAllocator);
    doc["content"] = content;
    String body;
    serializeJson(doc, body);

    HttpResult result = discordRequest("POST", "/channels/" + channelId + "/messages", body);
    if (result.status < 200 || result.status >= 300) {
        return "";
    }
    JsonDocument resp(&psramAllocator);
    if (deserializeJson(resp, result.body) != DeserializationError::Ok) {
        return "";
    }
    return resp["id"] | "";
}

int DiscordPlugin::pollReactionRating(const String &channelId, const String &messageId) {
    HttpResult result = discordRequest("GET", "/channels/" + channelId + "/messages/" + messageId, "");
    if (result.status < 200 || result.status >= 300) {
        return 0;
    }
    JsonDocument doc(&psramAllocator);
    if (deserializeJson(doc, result.body) != DeserializationError::Ok) {
        return 0;
    }
    JsonArray reactions = doc["reactions"].as<JsonArray>();
    if (reactions.isNull()) {
        return 0;
    }
    for (JsonObject r : reactions) {
        int count = r["count"] | 0;
        if (count < 1) {
            continue;
        }
        String name = r["emoji"]["name"] | "";
        for (int i = 0; i < 5; i++) {
            if (name == RATING_KEYCAPS[i]) {
                return i + 1;
            }
        }
    }
    return 0;
}

void DiscordPlugin::pollPendingShot(DiscordPendingShot &shot) {
    if (!shot.ratingSaved) {
        int rating = pollReactionRating(shot.channelId, shot.messageId);
        if (rating >= 1 && rating <= 5) {
            JsonDocument patch(&psramAllocator);
            patch["rating"] = rating;
            // Only stop polling for a rating once it is actually persisted; on a
            // failed write the next poll retries instead of silently losing it.
            if (ShotHistory.applyNotesPatch(shot.shotId, patch)) {
                shot.ratingSaved = true;
            }
        }
    }

    HttpResult result =
        discordRequest("GET", "/channels/" + shot.channelId + "/messages?after=" + shot.lastSeenMessageId + "&limit=10", "");
    if (result.status < 200 || result.status >= 300) {
        return;
    }
    JsonDocument doc(&psramAllocator);
    if (deserializeJson(doc, result.body) != DeserializationError::Ok) {
        return;
    }
    JsonArray messages = doc.as<JsonArray>();
    if (messages.isNull()) {
        return;
    }

    // Discord returns newest-first; collect then walk in reverse for chronological order.
    std::vector<JsonObject> ordered;
    for (JsonObject m : messages) {
        ordered.push_back(m);
    }

    Settings &settings = controller->getSettings();
    for (auto it = ordered.rbegin(); it != ordered.rend(); ++it) {
        JsonObject m = *it;
        String id = m["id"] | "";
        String authorId = m["author"]["id"] | "";
        if (!id.isEmpty()) {
            shot.lastSeenMessageId = id;
        }
        if (authorId.isEmpty() || authorId != shot.userId) {
            continue; // ignores other users and the bot's own messages (the ack reply)
        }
        String content = m["content"] | "";
        if (content.isEmpty()) {
            continue;
        }

        DiscordNotesPatch parsed;
        bool aiHandled = settings.isDiscordAi() && applyAiParse(content, parsed);
        if (!aiHandled) {
            parsed = parseReply(content);
        }

        JsonDocument patchDoc(&psramAllocator);
        String ackText;
        buildPatchDocument(parsed, patchDoc, ackText);
        if (patchDoc.as<JsonObjectConst>().size() > 0) {
            if (ShotHistory.applyNotesPatch(shot.shotId, patchDoc)) {
                if (parsed.hasRating) {
                    shot.ratingSaved = true;
                }
            } else {
                // Never acknowledge feedback that did not reach storage.
                ackText = "⚠️ Couldn't save that (storage error) — please try again.";
            }
        }

        String ackId = sendMessage(shot.channelId, ackText);
        if (!ackId.isEmpty()) {
            shot.lastSeenMessageId = ackId;
        }
    }
}

void DiscordPlugin::buildPatchDocument(const DiscordNotesPatch &patch, JsonDocument &out, String &ackText) {
    std::vector<String> ackParts;
    if (patch.hasRating && patch.rating >= 1 && patch.rating <= 5) {
        out["rating"] = patch.rating;
        ackParts.push_back("rating " + String(patch.rating));
    }
    if (patch.hasGrindSetting) {
        out["grindSetting"] = patch.grindSetting;
        ackParts.push_back("grind " + patch.grindSetting);
    }
    if (patch.hasDoseIn) {
        String formatted = String(patch.doseIn.toFloat(), 1);
        out["doseIn"] = formatted;
        ackParts.push_back("in " + formatted + "g");
    }
    if (patch.hasDoseOut) {
        String formatted = String(patch.doseOut.toFloat(), 1);
        out["doseOut"] = formatted;
        ackParts.push_back("out " + formatted + "g");
    }
    if (patch.hasBeanType) {
        out["beanType"] = patch.beanType;
        ackParts.push_back("bean " + patch.beanType);
    }
    if (patch.hasNotes) {
        out["notes"] = patch.notes;
        ackParts.push_back("notes updated");
    }

    ackText = "\u2705 Saved";
    if (!ackParts.empty()) {
        ackText += ": " + implode(ackParts, ", ");
    }
}

bool DiscordPlugin::extractJsonFromAiContent(const String &content, JsonDocument &out) {
    String trimmed = content;
    trimmed.trim();
    if (trimmed.startsWith("```")) {
        int firstNewline = trimmed.indexOf('\n');
        if (firstNewline >= 0) {
            trimmed = trimmed.substring(firstNewline + 1);
        }
        int fenceEnd = trimmed.lastIndexOf("```");
        if (fenceEnd >= 0) {
            trimmed = trimmed.substring(0, fenceEnd);
        }
        trimmed.trim();
    }
    return deserializeJson(out, trimmed) == DeserializationError::Ok;
}

bool DiscordPlugin::applyAiParse(const String &reply, DiscordNotesPatch &patchOut) {
    Settings &settings = controller->getSettings();
    String key = settings.getDiscordAiKey();
    if (key.isEmpty()) {
        return false;
    }

    // Try with response_format first; some OpenAI-compatible providers 400 on it, so retry once
    // without it before giving up (falls back to the non-AI parser on total failure).
    for (int useResponseFormat = 1; useResponseFormat >= 0; useResponseFormat--) {
        JsonDocument reqDoc(&psramAllocator);
        reqDoc["model"] = settings.getDiscordAiModel();
        reqDoc["temperature"] = 0;
        if (useResponseFormat) {
            reqDoc["response_format"]["type"] = "json_object";
        }
        JsonArray messages = reqDoc["messages"].to<JsonArray>();
        JsonObject sys = messages.add<JsonObject>();
        sys["role"] = "system";
        sys["content"] = AI_SYSTEM_PROMPT;
        JsonObject user = messages.add<JsonObject>();
        user["role"] = "user";
        user["content"] = reply;

        String body;
        serializeJson(reqDoc, body);

        HTTPClient http;
        http.setTimeout(8000);
        if (!http.begin(wifiClient, settings.getDiscordAiUrl())) {
            return false;
        }
        http.addHeader("Authorization", "Bearer " + key);
        http.addHeader("Content-Type", "application/json");
        http.addHeader("User-Agent", DISCORD_USER_AGENT);
        int code = http.POST(body);
        String respBody;
        if (http.getSize() <= static_cast<int>(DISCORD_MAX_BODY_BYTES)) {
            respBody = http.getString();
        }
        http.end();

        if (code == 400 && useResponseFormat) {
            continue;
        }
        if (code < 200 || code >= 300) {
            ESP_LOGW("DiscordPlugin", "AI parse request failed: %d", code);
            return false;
        }

        JsonDocument respDoc(&psramAllocator);
        if (deserializeJson(respDoc, respBody) != DeserializationError::Ok) {
            return false;
        }
        String content = respDoc["choices"][0]["message"]["content"] | "";
        JsonDocument parsedDoc(&psramAllocator);
        if (!extractJsonFromAiContent(content, parsedDoc)) {
            return false;
        }

        if (parsedDoc["rating"].is<int>()) {
            int r = parsedDoc["rating"].as<int>();
            if (r >= 1 && r <= 5) {
                patchOut.rating = r;
                patchOut.hasRating = true;
            }
        }
        if (!parsedDoc["grindSetting"].isNull()) {
            patchOut.grindSetting = parsedDoc["grindSetting"].as<String>();
            patchOut.hasGrindSetting = true;
        }
        if (!parsedDoc["doseIn"].isNull()) {
            patchOut.doseIn = String(parsedDoc["doseIn"].as<float>(), 1);
            patchOut.hasDoseIn = true;
        }
        if (!parsedDoc["doseOut"].isNull()) {
            patchOut.doseOut = String(parsedDoc["doseOut"].as<float>(), 1);
            patchOut.hasDoseOut = true;
        }
        if (!parsedDoc["beanType"].isNull()) {
            patchOut.beanType = parsedDoc["beanType"].as<String>();
            patchOut.hasBeanType = true;
        }
        if (!parsedDoc["notes"].isNull()) {
            patchOut.notes = parsedDoc["notes"].as<String>();
            patchOut.hasNotes = true;
        }
        return true;
    }
    return false;
}

DiscordNotesPatch DiscordPlugin::parseReply(const String &reply) {
    DiscordNotesPatch patch;

    String normalized = reply;
    normalized.replace("\r\n", "\n");
    normalized.replace("\r", "\n");
    normalized.replace("\n", "|");

    std::vector<String> noteParts;
    for (String segment : explode(normalized, '|')) {
        segment.trim();
        if (segment.isEmpty()) {
            continue;
        }

        int colonPos = segment.indexOf(':');
        if (colonPos < 0) {
            if (segment.length() == 1 && segment[0] >= '1' && segment[0] <= '5') {
                patch.rating = segment.toInt();
                patch.hasRating = true;
            } else {
                noteParts.push_back(segment);
            }
            continue;
        }

        String key = segment.substring(0, colonPos);
        String value = segment.substring(colonPos + 1);
        key.trim();
        key.toLowerCase();
        value.trim();

        if (key == "rating" || key == "rate" || key == "stars") {
            int r = value.toInt();
            if (r >= 1 && r <= 5) {
                patch.rating = r;
                patch.hasRating = true;
            }
        } else if (key == "grind" || key == "grinder") {
            patch.grindSetting = value;
            patch.hasGrindSetting = true;
        } else if (key == "in" || key == "dose" || key == "dosein") {
            patch.doseIn = value;
            patch.hasDoseIn = true;
        } else if (key == "out" || key == "yield" || key == "doseout") {
            patch.doseOut = value;
            patch.hasDoseOut = true;
        } else if (key == "bean" || key == "beans" || key == "coffee") {
            patch.beanType = value;
            patch.hasBeanType = true;
        } else if (key == "note" || key == "notes") {
            noteParts.push_back(value);
        } else {
            // Unknown key: keep the whole segment as free text rather than dropping it.
            noteParts.push_back(segment);
        }
    }

    if (!noteParts.empty()) {
        patch.notes = implode(noteParts, ". ");
        patch.hasNotes = true;
    }

    return patch;
}

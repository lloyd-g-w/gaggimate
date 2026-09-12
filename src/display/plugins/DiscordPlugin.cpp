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
constexpr uint32_t GAGGIBOT_MAX_BODY_BYTES = 16384;
constexpr uint32_t GAGGIBOT_HTTP_TIMEOUT_MS = 8000;
constexpr size_t GAGGIBOT_MAX_URL_BYTES = 512;
constexpr size_t GAGGIBOT_MAX_DEVICE_ID_BYTES = 64; // bridge validates 1-64 chars, ^[A-Za-z0-9._-]+$
constexpr float DISCORD_MAX_RETRY_AFTER_S = 30.0f;
constexpr const char *DISCORD_USER_AGENT = "GaggiMate (https://github.com/lloyd-g-w/gaggimate, 1.0)";
constexpr const char *DISCORD_API_BASE = "https://discord.com/api/v10";

constexpr const char *AI_SYSTEM_PROMPT =
    "You extract espresso shot feedback. Return ONLY a JSON object with keys rating (integer 1-5 or null), "
    "grindSetting (string or null), doseIn (number grams or null), doseOut (number grams or null), beanType (string "
    "or null), notes (string or null: everything else the user said about taste/experience, concise). Never invent "
    "values. The user is answering one question at a time; the message states which field is being asked, and a "
    "bare value with no other context belongs to that field. If the user mentions other fields too, extract them "
    "as well.";

// Discord keycap reaction emoji for a 1-5 rating ("1\uFE0F\u20E3" ...), raw UTF-8 as returned by the
// API in reactions[].emoji.name, and URL-encoded for the reactions endpoint path.
const char *const RATING_KEYCAPS[5] = {"1\xEF\xB8\x8F\xE2\x83\xA3", "2\xEF\xB8\x8F\xE2\x83\xA3", "3\xEF\xB8\x8F\xE2\x83\xA3",
                                       "4\xEF\xB8\x8F\xE2\x83\xA3", "5\xEF\xB8\x8F\xE2\x83\xA3"};
const char *const RATING_KEYCAPS_URLENC[5] = {"1%EF%B8%8F%E2%83%A3", "2%EF%B8%8F%E2%83%A3", "3%EF%B8%8F%E2%83%A3",
                                              "4%EF%B8%8F%E2%83%A3", "5%EF%B8%8F%E2%83%A3"};
// U+21A9 U+FE0F "↩️" = reuse last shot's value, U+27A1 U+FE0F "➡️" = skip this field.
constexpr const char *REUSE_EMOJI = "\xE2\x86\xA9\xEF\xB8\x8F";
constexpr const char *REUSE_EMOJI_URLENC = "%E2%86%A9%EF%B8%8F";
constexpr const char *SKIP_EMOJI = "\xE2\x9E\xA1\xEF\xB8\x8F";
constexpr const char *SKIP_EMOJI_URLENC = "%E2%9E%A1%EF%B8%8F";

struct StepDef {
    const char *title;    // message header
    const char *notesKey; // key in /h/<id>.json
    const char *unit;     // suffix when showing the last value ("" = none)
    const char *prompt;   // how to answer by text
};
// Order requested: rating, grind, dose in, bean, note.
const StepDef STEPS[DISCORD_STEP_COUNT] = {
    {"Rate this shot", "rating", "", "Click 1\xEF\xB8\x8F\xE2\x83\xA3\xE2\x80\x93" "5\xEF\xB8\x8F\xE2\x83\xA3 below or send a number 1-5."},
    {"Grind", "grindSetting", "", "Send the grind setting for this shot as a message, e.g. 3.5"},
    {"Dose in", "doseIn", " g", "Send the dose for this shot as a message, e.g. 18"},
    {"Bean", "beanType", "", "Send the beans you used, e.g. Ethiopia Guji"},
    {"Note", "notes", "", "Send tasting notes or anything worth remembering."},
};

constexpr int FIELD_BIT_PROFILE = 0x01;
constexpr int FIELD_BIT_DURATION = 0x02;
constexpr int FIELD_BIT_VOLUME = 0x04;
constexpr int FIELD_BIT_TEMP = 0x08;
constexpr int FIELD_BIT_PRESSURE = 0x10;
constexpr int FIELD_BIT_FLOW = 0x20;

constexpr uint32_t DISCORD_TASK_STACK_BYTES = 16384;
constexpr size_t DISCORD_MAX_MESSAGE_BYTES = 2000; // Discord hard limit on message content
constexpr size_t SHOWN_VALUE_MAX_BYTES = 120;       // previous value as rendered in a step prompt
constexpr size_t RECAP_PART_MAX_BYTES = 60;         // one "grind 3.5" entry in the recap

// "<grind>" style tokens mean "not filled in".
bool isPlaceholder(const String &value) { return value.length() >= 2 && value.startsWith("<") && value.endsWith(">"); }

// Cut a string to at most maxBytes without splitting a UTF-8 sequence; appends an ellipsis when cut.
String truncateUtf8(const String &s, size_t maxBytes) {
    if (s.length() <= maxBytes) {
        return s;
    }
    size_t cut = maxBytes >= 3 ? maxBytes - 3 : 0; // room for "..."
    while (cut > 0 && (static_cast<uint8_t>(s[cut]) & 0xC0) == 0x80) {
        cut--; // step back to a UTF-8 sequence start
    }
    return s.substring(0, cut) + "...";
}

String urlEncodeComponent(const String &value) {
    static constexpr char HEX_DIGITS[] = "0123456789ABCDEF";
    String encoded;
    encoded.reserve(value.length() * 3);
    for (size_t i = 0; i < value.length(); i++) {
        uint8_t c = static_cast<uint8_t>(value[i]);
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' ||
            c == '.' || c == '~') {
            encoded += static_cast<char>(c);
        } else {
            encoded += '%';
            encoded += HEX_DIGITS[c >> 4];
            encoded += HEX_DIGITS[c & 0x0F];
        }
    }
    return encoded;
}

bool timeReached(uint32_t now, uint32_t deadline) { return static_cast<int32_t>(now - deadline) >= 0; }

String stars(int rating) {
    String s;
    for (int i = 0; i < rating; i++) {
        s += "\xE2\xAD\x90"; // ⭐
    }
    return s;
}

// Fill exactly one field of a patch from a bare value, by step.
void setStepValue(DiscordNotesPatch &patch, int step, const String &value) {
    switch (step) {
    case DISCORD_STEP_RATING: {
        int r = value.toInt();
        if (r >= 1 && r <= 5) {
            patch.rating = r;
            patch.hasRating = true;
        }
        break;
    }
    case DISCORD_STEP_GRIND:
        patch.grindSetting = value;
        patch.hasGrindSetting = true;
        break;
    case DISCORD_STEP_DOSE_IN:
        patch.doseIn = value;
        patch.hasDoseIn = true;
        break;
    case DISCORD_STEP_BEAN:
        patch.beanType = value;
        patch.hasBeanType = true;
        break;
    case DISCORD_STEP_NOTE:
        patch.notes = value;
        patch.hasNotes = true;
        break;
    default:
        break;
    }
}

bool patchHasStep(const DiscordNotesPatch &patch, int step) {
    switch (step) {
    case DISCORD_STEP_RATING:
        return patch.hasRating;
    case DISCORD_STEP_GRIND:
        return patch.hasGrindSetting;
    case DISCORD_STEP_DOSE_IN:
        return patch.hasDoseIn;
    case DISCORD_STEP_BEAN:
        return patch.hasBeanType;
    case DISCORD_STEP_NOTE:
        return patch.hasNotes;
    default:
        return false;
    }
}
} // namespace

// ---------------------------------------------------------------------------------------------
// Lifecycle / task
// ---------------------------------------------------------------------------------------------

void DiscordPlugin::setup(Controller *c, PluginManager *pm) {
    controller = c;
    pluginManager = pm;
    wifiClient.setCACertBundle(x509_crt_imported_bundle_bin_start);
    pluginManager->on("evt:history-shot-saved", [this](Event const &e) { enqueueShot(e.getInt("id")); });
    // The web UI only sets a flag here (no I/O on the caller's task); the work happens on our task.
    pluginManager->on(GAGGIBOT_TEST_REQUEST_EVENT, [this](Event const &) { enqueueBridgeTest(); });
    // This task performs mbedTLS handshakes (HTTPClient + WiFiClientSecure), ArduinoJson work and
    // String building. configMINIMAL_STACK_SIZE is only 768 words on the S3, so *8 (~6 KB) was far
    // too small and overflowed on the second HTTPS request. TLS alone needs ~8-10 KB of stack.
    xTaskCreatePinnedToCore(loopTask, isBridgeMode() ? "Gaggibot::loop" : "DiscordPlugin::loop", DISCORD_TASK_STACK_BYTES,
                            this, 1, &taskHandle, 0);
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
    if (isBridgeMode()) {
        bridgeTaskLoop();
        return; // never contact Discord/OpenAI directly while an external bridge is configured
    }

    if (bridgeTestRequested.exchange(false)) {
        publishBridgeTestResult(GAGGIBOT_TEST_RUNNING, "Contacting Discord\xE2\x80\xA6");
        String message;
        bool ok = performDirectTest(message);
        publishBridgeTestResult(ok ? GAGGIBOT_TEST_OK : GAGGIBOT_TEST_FAILED, message);
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
        if (pollPendingShot(*it)) {
            it = pending.erase(it);
            continue;
        }
        ++it;
    }
}

// ---------------------------------------------------------------------------------------------
// External Gaggibot bridge mode
// ---------------------------------------------------------------------------------------------

bool DiscordPlugin::isBridgeMode() const {
    String configured = controller->getSettings().getGaggibotUrl();
    configured.trim();
    return !configured.isEmpty(); // invalid non-empty URLs fail closed; never fall through to direct Discord
}

String DiscordPlugin::bridgeBaseUrl() const {
    String url = controller->getSettings().getGaggibotUrl();
    url.trim();
    while (url.endsWith("/")) {
        url.remove(url.length() - 1);
    }
    if (url.length() > GAGGIBOT_MAX_URL_BYTES || !(url.startsWith("http://") || url.startsWith("https://"))) {
        return "";
    }
    return url;
}

String DiscordPlugin::bridgeDeviceId() const {
    String id = controller->getSettings().getGaggibotDeviceId();
    id.trim();
    if (id.isEmpty()) {
        id = "gaggimate-" + WiFi.macAddress();
        id.replace(":", "");
    }
    // The bridge validates the device id as ^[A-Za-z0-9._-]{1,64}$; sanitize locally so one stray
    // character cannot make every request fail with a 400 that we would retry forever.
    String clean;
    clean.reserve(GAGGIBOT_MAX_DEVICE_ID_BYTES);
    for (size_t i = 0; i < id.length() && clean.length() < GAGGIBOT_MAX_DEVICE_ID_BYTES; i++) {
        char c = id[i];
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '_' ||
            c == '-') {
            clean += c;
        } else if (c == ' ') {
            clean += '-';
        }
    }
    if (clean.isEmpty()) {
        clean = "gaggimate";
    }
    return clean;
}

void DiscordPlugin::bridgeTaskLoop() {
    if (bridgeTestRequested.exchange(false)) {
        publishBridgeTestResult(GAGGIBOT_TEST_RUNNING, "Contacting the bridge\xE2\x80\xA6");
        String message;
        bool ok = performBridgeTest(message);
        publishBridgeTestResult(ok ? GAGGIBOT_TEST_OK : GAGGIBOT_TEST_FAILED, message);
    }

    for (uint32_t shotId : drainQueue()) {
        if (std::find(bridgeUploadQueue.begin(), bridgeUploadQueue.end(), shotId) == bridgeUploadQueue.end()) {
            if (bridgeUploadQueue.size() >= 16) {
                ESP_LOGW("DiscordPlugin", "Gaggibot upload queue full; dropping oldest shot");
                bridgeUploadQueue.erase(bridgeUploadQueue.begin());
            }
            bridgeUploadQueue.push_back(shotId);
        }
    }

    uint32_t now = millis();
    if (!timeReached(now, bridgeNextAttemptMs)) {
        return;
    }

    bool ok = true;
    // Preserve ordering and stop on the first failure. POST /shots is idempotent by device + shot id.
    while (!bridgeUploadQueue.empty()) {
        if (!uploadBridgeShot(bridgeUploadQueue.front())) {
            ok = false;
            break;
        }
        bridgeUploadQueue.erase(bridgeUploadQueue.begin());
    }
    if (ok) {
        ok = pollBridgeFeedback();
    }

    if (ok) {
        bridgeBackoffMs = GAGGIBOT_POLL_INTERVAL_MS;
    } else {
        bridgeBackoffMs = std::min(bridgeBackoffMs * 2, GAGGIBOT_MAX_BACKOFF_MS);
    }
    bridgeNextAttemptMs = now + bridgeBackoffMs;
}

bool DiscordPlugin::uploadBridgeShot(uint32_t shotId) {
    ShotIndexEntry entry{};
    if (!ShotHistory.getIndexEntry(shotId, entry) || (entry.flags & SHOT_FLAG_DELETED)) {
        ESP_LOGW("DiscordPlugin", "Cannot upload missing/deleted shot %u to Gaggibot", shotId);
        return true; // permanent local condition: do not wedge later shots
    }

    JsonDocument doc(&psramAllocator);
    doc["deviceId"] = bridgeDeviceId();
    JsonObject shot = doc["shot"].to<JsonObject>();
    shot["id"] = shotId;
    shot["profile"] = entry.profileName;
    shot["duration"] = entry.duration / 1000.0f;
    shot["weight"] = entry.volume / 10.0f;
    shot["temperature"] = entry.avgTemp / 10.0f;
    shot["pressure"] = entry.maxPressure / 10.0f;
    shot["flow"] = entry.avgFlow / 100.0f;

    JsonDocument previousDoc(&psramAllocator);
    ShotHistory.getLastNotes(shotId, previousDoc);
    JsonObject previous = doc["previous"].to<JsonObject>();
    static constexpr const char *PREVIOUS_KEYS[] = {"rating", "grindSetting", "doseIn", "doseOut", "beanType", "notes"};
    for (const char *key : PREVIOUS_KEYS) {
        JsonVariantConst value = previousDoc[key];
        // Omit unknown fields entirely: the bridge validates `previous` against a strict schema and
        // an explicit null would be rejected as an invalid number/string.
        if (value.isNull()) {
            continue;
        }
        // Bound text fields to what the bridge accepts, so a long note cannot wedge the queue.
        if (value.is<const char *>()) {
            size_t maxBytes = strcmp(key, "notes") == 0 ? 1500 : (strcmp(key, "beanType") == 0 ? 200 : 100);
            String text = truncateUtf8(value.as<String>(), maxBytes);
            if (text.isEmpty()) {
                continue;
            }
            previous[key] = text;
        } else {
            previous[key] = value;
        }
    }

    String body;
    serializeJson(doc, body);
    HttpResult result = bridgeRequest("POST", bridgeBaseUrl() + "/api/v1/shots", body);
    if (result.status < 200 || result.status >= 300) {
        ESP_LOGW("DiscordPlugin", "Gaggibot shot upload failed for shot %u -> %d", shotId, result.status);
        return false;
    }
    ESP_LOGI("DiscordPlugin", "Uploaded shot %u to Gaggibot", shotId);
    return true;
}

bool DiscordPlugin::pollBridgeFeedback() {
    String endpoint = bridgeBaseUrl() + "/api/v1/feedback/" + urlEncodeComponent(bridgeDeviceId());
    HttpResult result = bridgeRequest("GET", endpoint + "?after=" + String(bridgeAfterEventId), "");
    if (result.status < 200 || result.status >= 300) {
        ESP_LOGW("DiscordPlugin", "Gaggibot feedback poll failed -> %d", result.status);
        return false;
    }

    JsonDocument doc(&psramAllocator);
    if (deserializeJson(doc, result.body) != DeserializationError::Ok) {
        ESP_LOGW("DiscordPlugin", "Gaggibot returned invalid feedback JSON");
        return false;
    }
    JsonArrayConst events = doc.is<JsonArray>() ? doc.as<JsonArrayConst>() : doc["events"].as<JsonArrayConst>();
    // Our cursor is RAM-only, so a reboot would replay every patch the bridge has ever queued. Adopt
    // the durable acknowledgement watermark the bridge reports instead.
    uint32_t cursor = bridgeAfterEventId;
    uint32_t serverWatermark = doc["through"] | 0u;
    if (serverWatermark > cursor) {
        cursor = serverWatermark;
        bridgeAfterEventId = cursor;
    }
    if (events.isNull() || events.size() == 0) {
        return true;
    }

    uint32_t maxAppliedId = cursor;
    static constexpr const char *PATCH_KEYS[] = {"rating", "grindSetting", "doseIn", "doseOut", "beanType", "notes"};
    for (JsonObjectConst event : events) {
        uint32_t eventId = event["id"] | 0;
        uint32_t shotId = event["shotId"] | 0;
        JsonObjectConst incoming = event["patch"].as<JsonObjectConst>();
        if (eventId <= cursor) {
            continue; // already applied and acknowledged on an earlier run
        }
        if (eventId == 0 || shotId == 0 || incoming.isNull()) {
            ESP_LOGW("DiscordPlugin", "Gaggibot feedback event is malformed; leaving it unacknowledged");
            return false;
        }

        JsonDocument patch(&psramAllocator);
        JsonObject sanitized = patch.to<JsonObject>();
        for (const char *key : PATCH_KEYS) {
            JsonVariantConst value = incoming[key];
            if (!value.isNull()) {
                sanitized[key] = value;
            }
        }
        if (sanitized.size() > 0 && !ShotHistory.applyNotesPatch(shotId, patch)) {
            ESP_LOGW("DiscordPlugin", "Failed to apply Gaggibot feedback event %u", eventId);
            return false;
        }
        maxAppliedId = eventId;
    }

    if (maxAppliedId == cursor) {
        return true;
    }
    JsonDocument ackDoc(&psramAllocator);
    ackDoc["through"] = maxAppliedId;
    String ackBody;
    serializeJson(ackDoc, ackBody);
    HttpResult ack = bridgeRequest("POST", endpoint + "/ack", ackBody);
    if (ack.status < 200 || ack.status >= 300) {
        ESP_LOGW("DiscordPlugin", "Gaggibot feedback acknowledgement failed -> %d", ack.status);
        return false; // patches are idempotent and will be replayed on the next poll
    }
    bridgeAfterEventId = maxAppliedId;
    return true;
}

DiscordPlugin::HttpResult DiscordPlugin::bridgeRequest(const char *method, const String &url, const String &jsonBody) {
    HttpResult result;
    if (url.isEmpty() || !(url.startsWith("http://") || url.startsWith("https://")) ||
        url.length() > GAGGIBOT_MAX_URL_BYTES + 160 || jsonBody.length() > GAGGIBOT_MAX_BODY_BYTES) {
        result.status = -2;
        return result;
    }

    HTTPClient http;
    http.setTimeout(GAGGIBOT_HTTP_TIMEOUT_MS);
    WiFiClient plainClient;
    bool begun = url.startsWith("https://") ? http.begin(wifiClient, url) : http.begin(plainClient, url);
    if (!begun) {
        return result;
    }
    String token = controller->getSettings().getGaggibotToken();
    token.trim(); // a pasted token with surrounding whitespace would otherwise 401 forever
    if (!token.isEmpty()) {
        http.addHeader("Authorization", "Bearer " + token);
    }
    http.addHeader("Accept", "application/json");
    if (strcmp(method, "POST") == 0) {
        http.addHeader("Content-Type", "application/json");
        result.status = http.POST(jsonBody);
    } else {
        result.status = http.GET();
    }

    int contentLength = http.getSize();
    if (contentLength > static_cast<int>(GAGGIBOT_MAX_BODY_BYTES)) {
        ESP_LOGW("DiscordPlugin", "Gaggibot response exceeded %u bytes", GAGGIBOT_MAX_BODY_BYTES);
        result.status = -3;
    } else if (result.status != 204 && result.status > 0) {
        if (contentLength >= 0) {
            result.body = http.getString();
        } else {
            // Bound chunked/unknown-length responses instead of allowing HTTPClient::getString()
            // to grow a String without limit.
            WiFiClient *stream = http.getStreamPtr();
            uint32_t deadline = millis() + GAGGIBOT_HTTP_TIMEOUT_MS;
            char buffer[256];
            while ((http.connected() || stream->available()) && !timeReached(millis(), deadline)) {
                size_t available = stream->available();
                if (available == 0) {
                    vTaskDelay(pdMS_TO_TICKS(10));
                    continue;
                }
                size_t take = std::min(available, sizeof(buffer));
                if (result.body.length() + take > GAGGIBOT_MAX_BODY_BYTES) {
                    result.status = -3;
                    break;
                }
                size_t read = stream->readBytes(buffer, take);
                for (size_t i = 0; i < read; i++) {
                    result.body += buffer[i];
                }
            }
        }
    }
    http.end();
    return result;
}

// ---------------------------------------------------------------------------------------------
// Test button
// ---------------------------------------------------------------------------------------------

void DiscordPlugin::enqueueBridgeTest() { bridgeTestRequested.store(true); }

void DiscordPlugin::publishBridgeTestResult(int state, const String &message) {
    if (pluginManager == nullptr) {
        return;
    }
    Event event{GAGGIBOT_TEST_RESULT_EVENT};
    event.setInt("state", state);
    event.setString("message", message);
    pluginManager->trigger(event);
}

// Turns a failed bridge request into something actionable for the user.
static String describeBridgeFailure(int status) {
    switch (status) {
    case 401:
    case 403:
        return "Bridge rejected the token \xE2\x80\x94 copy GAGGIBOT_SHARED_TOKEN into Bridge access token";
    case 404:
        return "Bridge replied 404 \xE2\x80\x94 check the URL and port (the API lives under /api/v1)";
    case 413:
        return "Bridge rejected the request as too large";
    case 429:
        return "Bridge rate-limited the request; try again in a minute";
    case 502:
        return "Bridge reached Discord but the DM failed \xE2\x80\x94 check the bot shares a server with you and has Send Messages";
    case 503:
        return "Bridge is running but not connected to Discord \xE2\x80\x94 check its logs (bad token or missing privileged intent?)";
    case -2:
        return "Gaggibot URL must start with http:// or https://";
    case -3:
        return "Bridge response was unexpectedly large";
    case 0:
    case -1:
        return "Could not reach the bridge \xE2\x80\x94 check the URL, port and that the container is running";
    default:
        return "Bridge returned HTTP " + String(status);
    }
}

bool DiscordPlugin::performBridgeTest(String &message) {
    String base = bridgeBaseUrl();
    if (base.isEmpty()) {
        message = "Set a Gaggibot URL that starts with http:// or https://";
        return false;
    }
    if (controller->getSettings().getGaggibotToken().isEmpty()) {
        message = "Set the bridge access token (same value as GAGGIBOT_SHARED_TOKEN)";
        return false;
    }

    HttpResult result = bridgeRequest("POST", base + "/api/v1/test", "{}");
    if (result.status < 200 || result.status >= 300) {
        ESP_LOGW("DiscordPlugin", "Gaggibot test failed -> %d", result.status);
        message = describeBridgeFailure(result.status);
        // The bridge explains exactly what is wrong (bad token, disabled privileged intent, no
        // internet); prefer its reason over our generic text.
        JsonDocument errorDoc(&psramAllocator);
        if (!result.body.isEmpty() && deserializeJson(errorDoc, result.body) == DeserializationError::Ok) {
            String reason = errorDoc["reason"] | "";
            if (!reason.isEmpty()) {
                message = reason;
            }
        }
        return false;
    }

    JsonDocument doc(&psramAllocator);
    if (deserializeJson(doc, result.body) != DeserializationError::Ok) {
        message = "Bridge replied with unreadable JSON";
        return false;
    }
    int delivered = 0;
    for (JsonObjectConst entry : doc["results"].as<JsonArrayConst>()) {
        if (entry["delivered"] | false) {
            delivered++;
        }
    }
    if (doc["dryRun"] | false) {
        message = "Bridge is in DRY RUN mode: message recorded, not sent (" + String(delivered) + " user(s))";
        return true;
    }
    if (delivered == 0) {
        message = "Bridge accepted the test but delivered to nobody \xE2\x80\x94 check DISCORD_USER_IDS";
        return false;
    }
    message = "Test message sent to " + String(delivered) + " Discord user(s) \xE2\x80\x94 check your DMs";
    return true;
}

// Direct mode has no bridge to test, so validate the on-device Discord setup itself by DMing every
// configured user through the same helpers the real flow uses.
bool DiscordPlugin::performDirectTest(String &message) {
    Settings &settings = controller->getSettings();
    if (!settings.isDiscord()) {
        message = "Enable the Discord plugin first";
        return false;
    }
    String token = settings.getDiscordBotToken();
    token.trim();
    if (token.isEmpty()) {
        message = "Set the Discord bot token first";
        return false;
    }
    std::vector<String> userIds = explode(settings.getDiscordUsers(), ',');
    if (userIds.empty()) {
        message = "Set at least one Discord user ID";
        return false;
    }

    int delivered = 0;
    int lastStatus = 0;
    for (String &userId : userIds) {
        userId.trim();
        if (userId.isEmpty()) {
            continue;
        }
        String channelId = getOrOpenDmChannel(userId);
        if (channelId.isEmpty()) {
            lastStatus = 403;
            continue;
        }
        String id = sendMessage(channelId, "\xF0\x9F\xA7\xAA GaggiMate test \xE2\x80\x94 the display can DM you "
                                             "directly. Nothing was recorded.");
        if (!id.isEmpty()) {
            delivered++;
        } else {
            lastStatus = 400;
        }
    }
    if (delivered == 0) {
        message = describeBridgeFailure(lastStatus);
        return false;
    }
    message = "Test message sent to " + String(delivered) + " Discord user(s) \xE2\x80\x94 check your DMs";
    return true;
}

// ---------------------------------------------------------------------------------------------
// New shot: summary, then the first step
// ---------------------------------------------------------------------------------------------

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
        // One live feedback flow per user: a newer shot supersedes an unfinished older one (its
        // already-answered fields stay saved), and a duplicated user row must not create two flows
        // that would both consume the same replies.
        bool duplicateRow = false;
        for (auto it = pending.begin(); it != pending.end();) {
            if (it->userId == userId) {
                if (it->shotId == shotId) {
                    duplicateRow = true;
                    break;
                }
                it = pending.erase(it);
                continue;
            }
            ++it;
        }
        if (duplicateRow) {
            continue;
        }

        String summaryId = sendMessage(channelId, summary);
        if (summaryId.isEmpty()) {
            ESP_LOGW("DiscordPlugin", "Failed to send shot summary for shot %u", shotId);
            continue;
        }

        DiscordPendingShot p;
        p.shotId = shotId;
        p.userId = userId;
        p.channelId = channelId;
        p.step = DISCORD_STEP_RATING;
        p.lastSeenMessageId = summaryId; // the only time the cursor is seeded from a bot message
        p.startedMs = millis();
        loadLastValues(p);
        if (!sendStepMessage(p)) {
            // Keep the flow; the first prompt is retried on the next poll like any other step.
            ESP_LOGW("DiscordPlugin", "Failed to send first step for shot %u, will retry", shotId);
            p.stepMessagePending = true;
        }
        pending.push_back(p);
    }
}

void DiscordPlugin::loadLastValues(DiscordPendingShot &shot) {
    JsonDocument last(&psramAllocator);
    if (!ShotHistory.getLastNotes(shot.shotId, last)) {
        return;
    }
    for (int i = 0; i < DISCORD_STEP_COUNT; i++) {
        JsonVariantConst v = last[STEPS[i].notesKey];
        if (v.isNull()) {
            continue;
        }
        String s = v.as<String>();
        s.trim();
        if (s.isEmpty() || isPlaceholder(s)) {
            continue;
        }
        if (i == DISCORD_STEP_RATING) {
            int r = s.toInt();
            if (r < 1 || r > 5) {
                continue; // 0 = unrated
            }
        }
        shot.lastValues[i] = s;
    }
    // A note is shot-specific: never offer to reuse it.
    shot.lastValues[DISCORD_STEP_NOTE] = "";
}

String DiscordPlugin::buildSummaryMessage(uint32_t shotId) {
    ShotIndexEntry entry{};
    bool ok = ShotHistory.getIndexEntry(shotId, entry);
    Settings &settings = controller->getSettings();
    int fields = settings.getDiscordFields();

    String title = "\xE2\x98\x95 Shot #" + String(shotId); // ☕
    if (ok && (fields & FIELD_BIT_PROFILE)) {
        title += " \xE2\x80\x94 " + String(entry.profileName);
    }
    String msg = title + "\n";

    if (ok) {
        std::vector<String> parts;
        if (fields & FIELD_BIT_DURATION) {
            parts.push_back("\xE2\x8F\xB1 " + String(entry.duration / 1000.0f, 1) + " s");
        }
        if (fields & FIELD_BIT_VOLUME) {
            parts.push_back("\xE2\x9A\x96\xEF\xB8\x8F " + String(entry.volume / 10.0f, 1) + " g");
        }
        if (fields & FIELD_BIT_TEMP) {
            parts.push_back("\xF0\x9F\x8C\xA1 " + String(entry.avgTemp / 10.0f, 1) + " \xC2\xB0" "C");
        }
        if (fields & FIELD_BIT_PRESSURE) {
            parts.push_back("\xE2\x8F\xAB " + String(entry.maxPressure / 10.0f, 1) + " bar");
        }
        if (fields & FIELD_BIT_FLOW) {
            parts.push_back("\xF0\x9F\x92\xA7 " + String(entry.avgFlow / 100.0f, 1) + " ml/s");
        }
        if (!parts.empty()) {
            msg += implode(parts, "   ") + "\n";
        }
    }
    msg += "Let's log it \xE2\x80\x94 answer each step, \xE2\x86\xA9\xEF\xB8\x8F reuses your last shot's value, "
           "\xE2\x9E\xA1\xEF\xB8\x8F skips.";
    return msg;
}

String DiscordPlugin::buildStepMessage(const DiscordPendingShot &shot) const {
    const StepDef &def = STEPS[shot.step];
    // Bound the previous value (it is rendered twice) so the prompt can never exceed Discord's limit.
    const String last = truncateUtf8(shot.lastValues[shot.step], SHOWN_VALUE_MAX_BYTES);
    Settings &settings = controller->getSettings();

    String msg = "-# Shot #" + String(shot.shotId) + " \xC2\xB7 step " + String(shot.step + 1) + "/" +
                 String(DISCORD_STEP_COUNT) + "\n";
    msg += "# " + String(def.title) + "\n\n";

    if (!last.isEmpty()) {
        if (shot.step == DISCORD_STEP_RATING) {
            msg += "Your last shot was " + stars(last.toInt()) + " (" + last + "/5).\n\n";
        } else if (shot.step == DISCORD_STEP_DOSE_IN) {
            msg += "Your last shot was *" + last + def.unit + "* in.\n\n";
        } else {
            msg += "Your last shot was *" + last + def.unit + "*.\n\n";
        }
    }

    if (shot.step == DISCORD_STEP_RATING) {
        msg += String(def.prompt) + "\n\n";
    } else if (settings.isDiscordAi() && shot.step == DISCORD_STEP_NOTE) {
        msg += String(def.prompt) + " Plain language is fine \xE2\x80\x94 anything else you mention (rating, grind, dose, "
               "beans) is picked up too.\n\n";
    } else {
        msg += String(def.prompt) + "\n\n";
    }

    // Small subtext legend for the reactions the bot adds below (the reactions are the controls).
    if (shot.step == DISCORD_STEP_RATING) {
        msg += "-# React 1\xEF\xB8\x8F\xE2\x83\xA3\xE2\x80\x93" "5\xEF\xB8\x8F\xE2\x83\xA3 to rate \xC2\xB7 \xE2\x9E\xA1\xEF\xB8\x8F to skip";
    } else if (!last.isEmpty()) {
        msg += "-# React \xE2\x86\xA9\xEF\xB8\x8F to reuse *" + last + def.unit + "* \xC2\xB7 \xE2\x9E\xA1\xEF\xB8\x8F to skip";
    } else {
        msg += "-# React \xE2\x9E\xA1\xEF\xB8\x8F to skip";
    }
    return msg;
}

bool DiscordPlugin::sendStepMessage(DiscordPendingShot &shot) {
    shot.stepMessageId = ""; // no live prompt until the new one is confirmed sent
    String id = sendMessage(shot.channelId, buildStepMessage(shot));
    if (id.isEmpty()) {
        return false;
    }
    // Anchor reactions on the new prompt. The reply cursor is deliberately NOT moved here: it only
    // advances from fetched batches, so a reply that arrived between our last GET and this POST is
    // still picked up next poll (the bot's own prompt is then skipped by the author filter).
    shot.stepMessageId = id;
    shot.stepMessagePending = false;

    // Discord rate-limits reactions (~1 per 250 ms per channel); pace them. discordRequest handles 429.
    if (shot.step == DISCORD_STEP_RATING) {
        for (int i = 0; i < 5; i++) {
            addReaction(shot.channelId, id, RATING_KEYCAPS_URLENC[i]);
            vTaskDelay(pdMS_TO_TICKS(300));
        }
    } else if (!shot.lastValues[shot.step].isEmpty()) {
        addReaction(shot.channelId, id, REUSE_EMOJI_URLENC);
        vTaskDelay(pdMS_TO_TICKS(300));
    }
    addReaction(shot.channelId, id, SKIP_EMOJI_URLENC);
    ESP_LOGI("DiscordPlugin", "Step %d sent for shot %u (task stack free: %u bytes)", shot.step + 1, shot.shotId,
             static_cast<unsigned>(uxTaskGetStackHighWaterMark(nullptr)));
    return true;
}

// ---------------------------------------------------------------------------------------------
// Polling: text replies first (more explicit), then reactions on the current step message
// ---------------------------------------------------------------------------------------------

bool DiscordPlugin::pollPendingShot(DiscordPendingShot &shot) {
    if (shot.finished) {
        // Every step is done; only the recap is still owed. Retry until it goes out.
        return sendRecap(shot);
    }
    if (shot.stepMessagePending) {
        // A previous send failed (network blip / rate limit): retry before reading anything.
        if (!sendStepMessage(shot)) {
            return false;
        }
    }
    PollResult r = handleReplies(shot);
    if (r == PollResult::DONE) {
        return true;
    }
    if (r == PollResult::CONSUMED || shot.stepMessagePending || shot.stepMessageId.isEmpty()) {
        // A text reply moved the flow this poll (reactions on the old prompt are stale now), or
        // there is no live prompt to read reactions from.
        return false;
    }
    return handleReactions(shot) == PollResult::DONE;
}

DiscordPlugin::PollResult DiscordPlugin::handleReplies(DiscordPendingShot &shot) {
    HttpResult result =
        discordRequest("GET", "/channels/" + shot.channelId + "/messages?after=" + shot.lastSeenMessageId + "&limit=10", "");
    if (result.status < 200 || result.status >= 300) {
        return PollResult::IDLE;
    }
    JsonDocument doc(&psramAllocator);
    if (deserializeJson(doc, result.body) != DeserializationError::Ok) {
        return PollResult::IDLE;
    }
    JsonArray messages = doc.as<JsonArray>();
    if (messages.isNull() || messages.size() == 0) {
        return PollResult::IDLE;
    }

    Settings &settings = controller->getSettings();
    PollResult outcome = PollResult::IDLE;
    // Discord returns newest first; process oldest first so multi-message answers apply in order.
    for (int i = static_cast<int>(messages.size()) - 1; i >= 0; i--) {
        JsonObject m = messages[i];
        String mid = m["id"] | "";
        if (!mid.isEmpty()) {
            shot.lastSeenMessageId = mid; // advance only over messages we have actually looked at
        }
        String author = m["author"]["id"] | "";
        if (author != shot.userId) {
            continue; // the bot's own prompts/recaps and anything else
        }
        String content = m["content"] | "";
        content.trim();
        if (content.isEmpty()) {
            continue;
        }

        DiscordNotesPatch parsed;
        if (!(settings.isDiscordAi() && applyAiParse(content, shot.step, parsed))) {
            parsed = parseReply(content, shot.step);
        }
        PollResult r = applyPatchAndAdvance(shot, parsed);
        if (r == PollResult::DONE) {
            return PollResult::DONE;
        }
        if (r == PollResult::CONSUMED) {
            outcome = PollResult::CONSUMED;
        }
        if (shot.finished) {
            // All steps done but the recap failed to send: stop consuming this batch. step ==
            // DISCORD_STEP_COUNT is not a valid prompt index, and the next poll goes straight to
            // the recap-retry branch.
            break;
        }
        if (shot.stepMessagePending) {
            // The next prompt could not be sent; stop here so later replies in this batch are
            // re-fetched and applied against the right step once the prompt is out.
            break;
        }
    }
    return outcome;
}

DiscordPlugin::PollResult DiscordPlugin::handleReactions(DiscordPendingShot &shot) {
    int rating = 0;
    switch (readReaction(shot, rating)) {
    case ReactionAction::RATE: {
        DiscordNotesPatch patch;
        patch.rating = rating;
        patch.hasRating = true;
        return applyPatchAndAdvance(shot, patch);
    }
    case ReactionAction::REUSE: {
        const String &last = shot.lastValues[shot.step];
        if (last.isEmpty()) {
            return PollResult::IDLE; // nothing to reuse; keep waiting
        }
        DiscordNotesPatch patch;
        setStepValue(patch, shot.step, last);
        return applyPatchAndAdvance(shot, patch);
    }
    case ReactionAction::SKIP:
        return advanceFrom(shot, shot.step + 1);
    default:
        return PollResult::IDLE;
    }
}

DiscordPlugin::ReactionAction DiscordPlugin::readReaction(const DiscordPendingShot &shot, int &ratingOut) {
    HttpResult result = discordRequest("GET", "/channels/" + shot.channelId + "/messages/" + shot.stepMessageId, "");
    if (result.status < 200 || result.status >= 300) {
        return ReactionAction::NONE;
    }
    JsonDocument doc(&psramAllocator);
    if (deserializeJson(doc, result.body) != DeserializationError::Ok) {
        return ReactionAction::NONE;
    }
    JsonArray reactions = doc["reactions"].as<JsonArray>();
    if (reactions.isNull()) {
        return ReactionAction::NONE;
    }

    // The bot seeds its own reactions ("me" == true, count 1); a user click is any count above
    // that. A value beats skip when both are present (skip is the likelier mis-click), and among
    // several ratings the highest user count wins so a later re-click overrides.
    int bestRating = 0;
    int bestUserCount = 0;
    bool reuse = false;
    bool skip = false;
    for (JsonObject r : reactions) {
        int count = r["count"] | 0;
        bool me = r["me"] | false;
        int userCount = count - (me ? 1 : 0);
        if (userCount < 1) {
            continue;
        }
        String name = r["emoji"]["name"] | "";
        if (shot.step == DISCORD_STEP_RATING) {
            for (int i = 0; i < 5; i++) {
                if (name == RATING_KEYCAPS[i] && userCount >= bestUserCount) {
                    bestUserCount = userCount;
                    bestRating = i + 1;
                }
            }
        }
        if (name == REUSE_EMOJI) {
            reuse = true;
        } else if (name == SKIP_EMOJI) {
            skip = true;
        }
    }
    if (bestRating > 0) {
        ratingOut = bestRating;
        return ReactionAction::RATE;
    }
    if (reuse) {
        return ReactionAction::REUSE;
    }
    if (skip) {
        return ReactionAction::SKIP;
    }
    return ReactionAction::NONE;
}

// ---------------------------------------------------------------------------------------------
// Step engine
// ---------------------------------------------------------------------------------------------

DiscordPlugin::PollResult DiscordPlugin::applyPatchAndAdvance(DiscordPendingShot &shot, const DiscordNotesPatch &patch) {
    JsonDocument patchDoc(&psramAllocator);
    std::vector<String> parts;
    buildPatchDocument(patch, patchDoc, parts);
    if (patchDoc.as<JsonObjectConst>().size() == 0) {
        return PollResult::IDLE; // nothing usable in the reply; stay on this step
    }
    if (!ShotHistory.applyNotesPatch(shot.shotId, patchDoc)) {
        // Never pretend it was saved; keep the step open so the user can retry.
        sendMessage(shot.channelId, "\xE2\x9A\xA0\xEF\xB8\x8F Couldn't save that (storage error) \xE2\x80\x94 please try again.");
        return PollResult::IDLE;
    }
    for (const String &p : parts) {
        shot.savedParts.push_back(truncateUtf8(p, RECAP_PART_MAX_BYTES));
    }
    for (int i = 0; i < DISCORD_STEP_COUNT; i++) {
        if (patchHasStep(patch, i)) {
            shot.answeredMask |= static_cast<uint8_t>(1u << i);
        }
    }

    // Only move on once the field being asked was actually answered (e.g. a free-text reply on
    // the rating step is saved as a note but the rating question stays open).
    if (!(shot.answeredMask & (1u << shot.step))) {
        return PollResult::CONSUMED;
    }
    return advanceFrom(shot, shot.step + 1);
}

DiscordPlugin::PollResult DiscordPlugin::advanceFrom(DiscordPendingShot &shot, int fromStep) {
    // Skip every step already answered (by an earlier multi-field reply), not just contiguous ones.
    int next = fromStep;
    while (next < DISCORD_STEP_COUNT && (shot.answeredMask & (1u << next))) {
        next++;
    }
    shot.step = next;
    shot.stepMessageId = "";
    if (shot.step >= DISCORD_STEP_COUNT) {
        shot.finished = true;
        return sendRecap(shot) ? PollResult::DONE : PollResult::CONSUMED;
    }
    if (!sendStepMessage(shot)) {
        ESP_LOGW("DiscordPlugin", "Failed to send step %d for shot %u, will retry", shot.step, shot.shotId);
        shot.stepMessagePending = true;
    }
    return PollResult::CONSUMED;
}

bool DiscordPlugin::sendRecap(DiscordPendingShot &shot) {
    String msg = "\xE2\x9C\x85 Shot #" + String(shot.shotId) + " logged"; // ✅
    if (shot.savedParts.empty()) {
        msg += " \xE2\x80\x94 nothing recorded this time.";
    } else {
        msg += ": " + implode(shot.savedParts, ", ") + ".";
    }
    if (sendMessage(shot.channelId, msg).isEmpty()) {
        ESP_LOGW("DiscordPlugin", "Failed to send recap for shot %u, will retry", shot.shotId);
        return false;
    }
    return true;
}

// ---------------------------------------------------------------------------------------------
// Discord REST
// ---------------------------------------------------------------------------------------------

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

        int code;
        if (strcmp(method, "POST") == 0) {
            code = http.POST(jsonBody);
        } else if (strcmp(method, "PUT") == 0) {
            code = http.PUT(jsonBody);
        } else {
            code = http.GET();
        }
        String body;
        // 204 (reactions) has no body: reading it would block until the keep-alive timeout.
        if (code != 204 && code > 0 && http.getSize() <= static_cast<int>(DISCORD_MAX_BODY_BYTES)) {
            body = http.getString();
        }
        http.end();

        // Always keep the latest status/body so callers (and the log) see the real final outcome
        // even when the retry budget is exhausted on a 429.
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
    // Final safety net for Discord's 2000-character limit (inputs are bounded upstream too).
    doc["content"] = truncateUtf8(content, DISCORD_MAX_MESSAGE_BYTES);
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

void DiscordPlugin::addReaction(const String &channelId, const String &messageId, const char *emojiUrlEncoded) {
    // PUT /channels/{c}/messages/{m}/reactions/{emoji}/@me -> 204 No Content
    HttpResult r = discordRequest("PUT", "/channels/" + channelId + "/messages/" + messageId + "/reactions/" +
                                             emojiUrlEncoded + "/@me",
                                  "");
    if (r.status < 200 || r.status >= 300) {
        ESP_LOGW("DiscordPlugin", "Failed to add reaction %s on message %s -> %d", emojiUrlEncoded, messageId.c_str(),
                 r.status);
    }
}

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

void DiscordPlugin::buildPatchDocument(const DiscordNotesPatch &patch, JsonDocument &out, std::vector<String> &savedParts) {
    if (patch.hasRating && patch.rating >= 1 && patch.rating <= 5) {
        out["rating"] = patch.rating;
        savedParts.push_back("rating " + String(patch.rating));
    }
    if (patch.hasGrindSetting) {
        out["grindSetting"] = patch.grindSetting;
        savedParts.push_back("grind " + patch.grindSetting);
    }
    if (patch.hasDoseIn) {
        String formatted = String(patch.doseIn.toFloat(), 1);
        out["doseIn"] = formatted;
        savedParts.push_back("in " + formatted + " g");
    }
    if (patch.hasDoseOut) {
        String formatted = String(patch.doseOut.toFloat(), 1);
        out["doseOut"] = formatted;
        savedParts.push_back("out " + formatted + " g");
    }
    if (patch.hasBeanType) {
        out["beanType"] = patch.beanType;
        savedParts.push_back("bean " + patch.beanType);
    }
    if (patch.hasNotes) {
        out["notes"] = patch.notes;
        savedParts.push_back("note");
    }
}

DiscordNotesPatch DiscordPlugin::parseReply(const String &reply, int currentStep) {
    DiscordNotesPatch patch;

    String normalized = reply;
    normalized.replace("`", "");
    normalized.replace("\r\n", "\n");
    normalized.replace("\r", "\n");
    normalized.replace("\n", "|");

    std::vector<String> bareParts;
    for (String segment : explode(normalized, '|')) {
        segment.trim();
        if (segment.isEmpty()) {
            continue;
        }

        int colonPos = segment.indexOf(':');
        if (colonPos < 0) {
            bareParts.push_back(segment);
            continue;
        }

        String key = segment.substring(0, colonPos);
        String value = segment.substring(colonPos + 1);
        key.trim();
        key.toLowerCase();
        value.trim();
        if (value.isEmpty() || isPlaceholder(value)) {
            continue;
        }

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
            patch.notes = patch.hasNotes ? patch.notes + ". " + value : value;
            patch.hasNotes = true;
        } else {
            // Unknown key: keep the whole segment as free text.
            bareParts.push_back(segment);
        }
    }

    // Anything without a key answers the step being asked. On the note step (or if the step's
    // field was already given explicitly) it is note text.
    if (!bareParts.empty()) {
        String bare = implode(bareParts, ". ");
        if (currentStep != DISCORD_STEP_NOTE && !patchHasStep(patch, currentStep) && !isPlaceholder(bare)) {
            setStepValue(patch, currentStep, bare);
            // A non-numeric answer on the rating step is not a rating; treat it as a note instead.
            if (currentStep == DISCORD_STEP_RATING && !patch.hasRating) {
                patch.notes = patch.hasNotes ? patch.notes + ". " + bare : bare;
                patch.hasNotes = true;
            }
        } else if (!isPlaceholder(bare)) {
            patch.notes = patch.hasNotes ? patch.notes + ". " + bare : bare;
            patch.hasNotes = true;
        }
    }
    return patch;
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

bool DiscordPlugin::applyAiParse(const String &reply, int currentStep, DiscordNotesPatch &patchOut) {
    Settings &settings = controller->getSettings();
    String key = settings.getDiscordAiKey();
    if (key.isEmpty()) {
        return false;
    }

    String userContent = "Field being asked: " + String(STEPS[currentStep].notesKey) + "\nUser reply: " + reply;

    // Try with response_format first; some OpenAI-compatible providers 400 on it, so retry once
    // without it before giving up (falls back to the keyword parser on total failure).
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
        user["content"] = userContent;

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
        // Valid JSON with nothing usable ({} / all null) must fall back to the keyword parser,
        // otherwise a bare answer like "3.5" would be swallowed.
        return patchOut.hasRating || patchOut.hasGrindSetting || patchOut.hasDoseIn || patchOut.hasDoseOut ||
               patchOut.hasBeanType || patchOut.hasNotes;
    }
    return false;
}

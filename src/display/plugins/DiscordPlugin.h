#ifndef DISCORDPLUGIN_H
#define DISCORDPLUGIN_H

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <display/core/Plugin.h>
#include <map>
#include <mutex>
#include <vector>

constexpr uint32_t DISCORD_POLL_INTERVAL_MS = 10000;
constexpr uint32_t DISCORD_WINDOW_MS = 30 * 60 * 1000;

// Structured result of the non-AI reply parser and the AI reply parser, both of which produce the
// same shape so applyNotesPatch() can be fed from either path uniformly.
struct DiscordNotesPatch {
    int rating = 0; // 0 = not set, 1-5 = rating
    bool hasRating = false;
    String grindSetting;
    bool hasGrindSetting = false;
    String doseIn;
    bool hasDoseIn = false;
    String doseOut;
    bool hasDoseOut = false;
    String beanType;
    bool hasBeanType = false;
    String notes;
    bool hasNotes = false;
};

// One shot awaiting user feedback in Discord. Owned exclusively by the plugin's background task;
// never touched from setup()/loop() or the event-subscription lambda, which only enqueue shot ids.
struct DiscordPendingShot {
    uint32_t shotId = 0;
    String userId;
    String channelId;
    String messageId;
    String lastSeenMessageId;
    uint32_t startedMs = 0;
    bool ratingSaved = false;
};

class Controller;
class PluginManager;

class DiscordPlugin : public Plugin {
  public:
    DiscordPlugin() = default;

    void setup(Controller *controller, PluginManager *pluginManager) override;
    void loop() override {};

    // Pure, side-effect-free reply parser exposed for testing/reporting. Splits on newlines and
    // '|', matches "key: value" segments case-insensitively, and appends anything else to notes.
    static DiscordNotesPatch parseReply(const String &reply);

  private:
    struct HttpResult {
        int status = -1;
        String body;
    };

    static void loopTask(void *arg);
    void taskLoop();

    void enqueueShot(uint32_t shotId);
    std::vector<uint32_t> drainQueue();

    void processNewShot(uint32_t shotId);
    void pollPendingShot(DiscordPendingShot &shot);

    String getOrOpenDmChannel(const String &userId);
    String sendMessage(const String &channelId, const String &content);
    HttpResult discordRequest(const char *method, const String &path, const String &jsonBody);

    int pollReactionRating(const String &channelId, const String &messageId);

    bool applyAiParse(const String &reply, DiscordNotesPatch &patchOut);
    static bool extractJsonFromAiContent(const String &content, JsonDocument &out);

    void buildPatchDocument(const DiscordNotesPatch &patch, JsonDocument &out, String &ackText);
    String buildSummaryMessage(uint32_t shotId);

    Controller *controller = nullptr;
    PluginManager *pluginManager = nullptr;

    std::mutex queueMutex;
    std::vector<uint32_t> pendingShotIds;

    // Task-owned state; only ever touched from taskLoop() and its callees on the DiscordPlugin task.
    std::vector<DiscordPendingShot> pending;
    std::map<String, String> dmChannelByUser; // userId -> channelId, cached for the process lifetime
    uint32_t lastPollMs = 0;

    WiFiClientSecure wifiClient;
    xTaskHandle taskHandle = nullptr;
};

#endif // DISCORDPLUGIN_H

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

// Feedback is collected as a sequence of step messages, one field each, in this order.
constexpr int DISCORD_STEP_RATING = 0;
constexpr int DISCORD_STEP_GRIND = 1;
constexpr int DISCORD_STEP_DOSE_IN = 2;
constexpr int DISCORD_STEP_BEAN = 3;
constexpr int DISCORD_STEP_NOTE = 4;
constexpr int DISCORD_STEP_COUNT = 5;

// Structured result of the keyword parser and the AI parser, both of which produce the same
// shape so applyNotesPatch() can be fed from either path uniformly.
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

// One shot walking through the feedback steps with one Discord user. Owned exclusively by the
// plugin's background task; never touched from setup()/loop() or the event-subscription lambda,
// which only enqueue shot ids.
struct DiscordPendingShot {
    uint32_t shotId = 0;
    String userId;
    String channelId;
    int step = 0;              // index into the step table; DISCORD_STEP_COUNT = all steps done
    uint8_t answeredMask = 0;  // bit i set once step i's field was saved (by reply, reuse or multi-field reply)
    String stepMessageId;      // the message carrying the current step's prompt + reactions ("" = none live)
    // Reply cursor: only ever advanced from fetched batches (never jumped to a bot prompt id), so a
    // reply that lands between our GET and our next POST is still returned by the next fetch.
    String lastSeenMessageId;
    bool stepMessagePending = false; // sending the current step failed; retry on the next poll
    bool finished = false;           // all steps done; the recap is still owed (retried until sent)
    uint32_t startedMs = 0;
    // Values from the most recent earlier shot that has notes; shown in each step and re-applied
    // by the "reuse" reaction. Stored as plain Strings so the vector stays trivially movable.
    String lastValues[DISCORD_STEP_COUNT];
    std::vector<String> savedParts; // "rating 4", "grind 3.5", ... for the final recap
};

class Controller;
class PluginManager;

class DiscordPlugin : public Plugin {
  public:
    DiscordPlugin() = default;

    void setup(Controller *controller, PluginManager *pluginManager) override;
    void loop() override {};

    // Pure, side-effect-free keyword parser. Splits on newlines and '|', matches "key: value"
    // segments case-insensitively; a segment without a key is the value of the step currently
    // being asked (currentStep), except on the note step where free text is the note itself.
    static DiscordNotesPatch parseReply(const String &reply, int currentStep);

  private:
    struct HttpResult {
        int status = -1;
        String body;
    };
    enum class ReactionAction { NONE, RATE, REUSE, SKIP };
    // Result of one poll sub-step: nothing happened, a reply/reaction was consumed (do not read
    // reactions after a consumed reply in the same poll), or the shot is complete and can be dropped.
    enum class PollResult { IDLE, CONSUMED, DONE };

    static void loopTask(void *arg);
    void taskLoop();

    void enqueueShot(uint32_t shotId);
    std::vector<uint32_t> drainQueue();

    void processNewShot(uint32_t shotId);
    // Returns true when the shot is complete (recap delivered) and must be dropped from `pending`.
    bool pollPendingShot(DiscordPendingShot &shot);
    PollResult handleReplies(DiscordPendingShot &shot);
    PollResult handleReactions(DiscordPendingShot &shot);
    // Apply a parsed patch, mark the steps it answered, advance only if the current step was
    // answered (skipping any later step already answered).
    PollResult applyPatchAndAdvance(DiscordPendingShot &shot, const DiscordNotesPatch &patch);
    PollResult advanceFrom(DiscordPendingShot &shot, int fromStep);
    bool sendStepMessage(DiscordPendingShot &shot);
    // Send the recap; true once it was actually delivered.
    bool sendRecap(DiscordPendingShot &shot);

    String getOrOpenDmChannel(const String &userId);
    String sendMessage(const String &channelId, const String &content);
    HttpResult discordRequest(const char *method, const String &path, const String &jsonBody);
    void addReaction(const String &channelId, const String &messageId, const char *emojiUrlEncoded);
    ReactionAction readReaction(const DiscordPendingShot &shot, int &ratingOut);

    bool applyAiParse(const String &reply, int currentStep, DiscordNotesPatch &patchOut);
    static bool extractJsonFromAiContent(const String &content, JsonDocument &out);

    static void buildPatchDocument(const DiscordNotesPatch &patch, JsonDocument &out, std::vector<String> &savedParts);
    String buildSummaryMessage(uint32_t shotId);
    String buildStepMessage(const DiscordPendingShot &shot) const;
    void loadLastValues(DiscordPendingShot &shot);

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

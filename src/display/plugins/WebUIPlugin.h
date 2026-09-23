#ifndef WEBUIPLUGIN_H
#define WEBUIPLUGIN_H

#define ELEGANTOTA_USE_ASYNC_WEBSERVER 1

#include <DNSServer.h>

#include "GitHubOTA.h"
#include <ArduinoJson.h>
#include <ESPAsyncWebServer.h>
#include <mutex>
#include <display/core/Plugin.h>
#include <display/plugins/WebSocketHandler.h>
#include <display/util/PsramAllocator.h>

constexpr size_t UPDATE_CHECK_INTERVAL = 30 * 60 * 1000;
constexpr size_t DNS_PERIOD = 50;

const String LOCAL_URL = "http://4.4.4.1/";
// Fork: OTA pulls from this fork's releases (nightly channel), which also carry the T8 asset.
const String RELEASE_URL = "https://github.com/lloyd-g-w/gaggimate/releases/";
// Headless builds must pull their own release assets; the screen firmware would not boot on them.
// (The filesystem name is recorded but never flashed: the web UI ships inside the app image.)
#if defined(GAGGIMATE_HEADLESS_T8)
#define OTA_DISPLAY_FIRMWARE "display-headless-t8-firmware.bin"
#define OTA_DISPLAY_FILESYSTEM "display-headless-filesystem.bin"
#elif defined(GAGGIMATE_HEADLESS)
#define OTA_DISPLAY_FIRMWARE "display-headless-firmware.bin"
#define OTA_DISPLAY_FILESYSTEM "display-headless-filesystem.bin"
#else
#define OTA_DISPLAY_FIRMWARE "display-firmware.bin"
#define OTA_DISPLAY_FILESYSTEM "display-filesystem.bin"
#endif

class ProfileManager;

class WebUIPlugin : public Plugin {
  public:
    WebUIPlugin();
    void setup(Controller *controller, PluginManager *pluginManager) override;
    void loop() override;

  private:
    void setupServer();
    void start();
    void stop();

    // OTA requests arrive over the WebSocket but are executed here, where GitHubOTA lives
    void handleOTASettings(JsonDocument &request);
    void handleOTAStart(JsonDocument &request);

    // HTTP handlers
    // Serves the web UI from the firmware-embedded, memory-mapped flash blob
    // (catch-all for any path not claimed by an explicit route). [GM-106]
    void serveWebAsset(AsyncWebServerRequest *request);
    void handleSettings(AsyncWebServerRequest *request) const;
    void handleBLEScaleList(AsyncWebServerRequest *request);
    void handleBLEScaleScan(AsyncWebServerRequest *request);
    void handleBLEScaleConnect(AsyncWebServerRequest *request);
    void handleBLEScaleInfo(AsyncWebServerRequest *request);
    void updateOTAStatus(const String &version);
    void updateOTAProgress(uint8_t phase, int progress);

    // Core dump download
    void handleCoreDumpDownload(AsyncWebServerRequest *request);
    // Gaggibot/Discord "Test" button. The plugin task owns the network stack, so these handlers only
    // relay: POST asks the plugin to run a test, GET reports the last result.
    void handleDiscordTestStatus(AsyncWebServerRequest *request);
    void handleDiscordTestRequest(AsyncWebServerRequest *request);

    GitHubOTA *ota = nullptr;
    AsyncWebServer server;
    WebSocketHandler wsHandler;
    Controller *controller = nullptr;
    PluginManager *pluginManager = nullptr;
    DNSServer *dnsServer = nullptr;
    ProfileManager *profileManager = nullptr;

    long lastUpdateCheck = 0;
    long lastDns = 0;
    bool updating = false;
    bool apMode = false;
    bool serverRunning = false;
    String updateComponent = "";

    // Last result of the plugin "Test" button, written from the Discord plugin's task and read from
    // the web task, hence the mutex.
    std::mutex discordTestMutex;
    int discordTestState = 0; // 0 idle, 1 running, 2 ok, 3 failed
    String discordTestMessage;
};

#endif // WEBUIPLUGIN_H

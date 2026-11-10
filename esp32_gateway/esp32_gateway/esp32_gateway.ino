/* =========================================================================
   SOLAR FAULT DETECTION - MASTER GATEWAY (ESP32-C6)
   =========================================================================
   Firmware: esp32_gateway.ino
   Target  : DFRobot Beetle ESP32-C6 (or standard ESP32-C6 dev board)

   Wiring (ESP32-C6 -> nRF24L01+):
     3.3V  -> VCC  (CRITICAL: never connect 5V to nRF24 VCC!)
     GND   -> GND
     GPIO20-> CSN  (Chip Select Not)
     GPIO19-> CE   (Chip Enable)
     GPIO23-> SCK  (SPI Clock)
     GPIO22-> MOSI (SPI Data In to module)
     GPIO21-> MISO (SPI Data Out from module)
   ========================================================================= */

#include <SPI.h>
#include <RF24.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

#define CE_PIN   19
#define CSN_PIN  20
#define SCK_PIN  23
#define MOSI_PIN 22
#define MISO_PIN 21

/* -- Radio configuration -------------------------------------------------- */
#define RF_CHANNEL   32
#define RF_DATARATE  RF24_1MBPS
#define NUM_NODES    4

const uint8_t NODE_ADDR[NUM_NODES][5] = {
    {0xA1, 0xC3, 0xC2, 0xC1, 0x20},  // Pipe 1 -> Node 1 (Panel 1)
    {0xA2, 0xC3, 0xC2, 0xC1, 0x20},  // Pipe 2 -> Node 2 (Panel 2)
    {0xA3, 0xC3, 0xC2, 0xC1, 0x20},  // Pipe 3 -> Node 3 (Panel 3)
    {0xA4, 0xC3, 0xC2, 0xC1, 0x20}   // Pipe 4 -> Node 4 (String Node)
};

RF24 radio(CE_PIN, CSN_PIN);
static bool radioHardwareReady = false;

/* -- WiFi & Backend ------------------------------------------------------- */
const char* WIFI_SSID     = "Hasheer's M35";
const char* WIFI_PASSWORD = "123456789";

/* Choose either Render Cloud (Worldwide) OR Local PC (Same Wi-Fi): */
// Option A: Live Worldwide Cloud Backend (Render) - Recommended
const char* BACKEND_URL   = "https://heliopv-solar.onrender.com/api/data";

// Option B: Local PC Backend (Check laptop IP via 'ipconfig')
// const char* BACKEND_URL   = "http://10.98.235.70:3000/api/data";

/* -- Data structures ------------------------------------------------------ */
#define NODE_STALE_MS   8000

typedef struct __attribute__((packed)) {
    uint8_t  node_id;       /* 1 = Panel 1, 2 = Panel 2, 3 = Panel 3, 4 = String */
    uint8_t  node_type;     /* 0 = panel_basic, 1 = panel_full, 2 = string      */
    uint8_t  continuity;    /* 1 = OK, 0 = BROKEN                                */
    int16_t  temp_c_x10;    /* 0.1 deg C (-999 = absent)                         */
    uint16_t voltage_mV;    /* mV                                                */
    uint16_t current_mA;    /* mA (Node 4 only)                                  */
    uint16_t ldr_raw;       /* LDR / aux data                                    */
} NodePacket;

struct NodeState {
    bool          seen;
    NodePacket    pkt;
    unsigned long lastMs;
    uint32_t      rxCount;
};

static NodeState         nodes[NUM_NODES];
static SemaphoreHandle_t nodeMutex;

static volatile uint32_t totalPacketsRx = 0;
static volatile uint32_t badLengthDrops = 0;
static volatile uint32_t badIdDrops     = 0;

void connectWiFi()
{
    Serial.println("\n-------------------------------------------");
    Serial.printf("[WiFi] Connecting to SSID: '%s'...\n", WIFI_SSID);
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    int retries = 0;
    while (WiFi.status() != WL_CONNECTED && retries < 30) {
        delay(400);
        Serial.print(".");
        retries++;
    }
    Serial.println();

    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("[WiFi] *** SUCCESS: CONNECTED! ***");
        Serial.printf("[WiFi] ESP32 IP Address : %s\n", WiFi.localIP().toString().c_str());
        Serial.printf("[WiFi] Signal (RSSI)    : %d dBm\n", WiFi.RSSI());
        Serial.printf("[WiFi] Target Backend   : %s\n", BACKEND_URL);
    } else {
        Serial.printf("[WiFi] *** ERROR: Failed to connect to '%s' (Status=%d) ***\n", WIFI_SSID, WiFi.status());
        Serial.println("[WiFi] Please check: 1. Is phone hotspot ON? 2. Is 2.4GHz band enabled? 3. Is password correct?");
    }
    Serial.println("-------------------------------------------\n");
}

static const char *type_name(uint8_t t)
{
    switch (t) {
        case 0:  return "panel_basic";
        case 1:  return "panel_full";
        case 2:  return "string";
        default: return "unknown";
    }
}

void printNodeCard(uint8_t id)
{
    uint8_t idx = id - 1;
    NodeState s;

    if (xSemaphoreTake(nodeMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
        s = nodes[idx];
        xSemaphoreGive(nodeMutex);
    } else {
        return;
    }

    Serial.println("+-----------------------------------------------+");
    if (!s.seen) {
        Serial.printf("| NODE %d  [%s]  - [NO DATA YET]\n",
                      id, (id == 4) ? "string" : ((id == 1) ? "panel_basic" : "panel_full"));
        Serial.println("|  Status      : WAITING FOR TRANSMISSION (check CH32 power/wiring)");
        Serial.println("+-----------------------------------------------+");
        return;
    }

    unsigned long age = millis() - s.lastMs;
    bool isStale = (age > NODE_STALE_MS);

    Serial.printf("| NODE %d  [%s]  rxCount=%lu%s\n",
                  id, type_name(s.pkt.node_type), s.rxCount,
                  isStale ? "  [STALE!]" : "  [LIVE]");
    Serial.println("|");

    if (s.pkt.node_type == 0 || s.pkt.node_type == 1) {
        Serial.printf("|  Voltage     : %u mV  (%.2f V)\n",
                      s.pkt.voltage_mV, s.pkt.voltage_mV / 1000.0f);
    }

    if (s.pkt.node_type == 1) {
        Serial.printf("|  Continuity  : %s\n",
                      s.pkt.continuity ? "OK  (wire intact)" : "*** BROKEN / FAULT ***");
        if (s.pkt.temp_c_x10 > -900) {
            Serial.printf("|  Temperature : %.1f C\n", s.pkt.temp_c_x10 / 10.0f);
        }
    }

    if (s.pkt.node_type == 2) {
        Serial.printf("|  Continuity  : %s\n",
                      s.pkt.continuity ? "OK  (string intact)" : "*** BROKEN / FAULT ***");
        Serial.printf("|  Voltage     : %u mV  (%.2f V)\n",
                      s.pkt.voltage_mV, s.pkt.voltage_mV / 1000.0f);
        Serial.printf("|  Current     : %u mA  (%.3f A)\n",
                      s.pkt.current_mA, s.pkt.current_mA / 1000.0f);
    }

    if (s.pkt.ldr_raw > 0) {
        Serial.printf("|  LDR Raw     : %u\n", s.pkt.ldr_raw);
    }

    Serial.println("+-----------------------------------------------+");
}

/* POST latest telemetry to backend with full HTTP/HTTPS fallback & Gateway Heartbeat */
void postToBackend()
{
    if (WiFi.status() != WL_CONNECTED) {
        return;
    }

    static unsigned long postBackoffUntil = 0;
    if (millis() < postBackoffUntil) {
        return;
    }

    String json = "{\"gateway\":\"online\",\"nodes\":[";
    bool first = true;
    int nodeCount = 0;

    if (xSemaphoreTake(nodeMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
        for (int i = 0; i < NUM_NODES; i++) {
            if (!nodes[i].seen) continue;

            unsigned long age = millis() - nodes[i].lastMs;
            if (age > NODE_STALE_MS) continue;

            NodePacket &p = nodes[i].pkt;
            if (!first) json += ",";
            first = false;
            nodeCount++;

            json += "{";
            json += "\"id\":"            + String(p.node_id)               + ",";
            json += "\"node_id\":"       + String(p.node_id)               + ",";
            json += "\"node_type\":"     + String(p.node_type)             + ",";
            json += "\"node_type_name\":\"" + String(type_name(p.node_type)) + "\",";
            json += "\"voltage_mV\":"    + String(p.voltage_mV)            + ",";
            json += "\"temp_c\":"        + String(p.temp_c_x10 / 10.0f, 1) + ",";
            json += "\"temp_c10\":"      + String(p.temp_c_x10)            + ",";
            json += "\"continuity\":"    + String(p.continuity == 1 ? "true" : "false") + ",";
            json += "\"current_mA\":"    + String(p.current_mA)            + ",";
            json += "\"ldr_raw\":"       + String(p.ldr_raw)               + ",";
            json += "\"ageMs\":"         + String(age);
            json += "}";
        }
        xSemaphoreGive(nodeMutex);
    }
    json += "]}";

    HTTPClient http;
    bool isHttps = (strncmp(BACKEND_URL, "https://", 8) == 0);

    bool beginSuccess = false;
    WiFiClientSecure secureClient;
    WiFiClient       plainClient;

    if (isHttps) {
        secureClient.setInsecure(); // No certificate check needed for cloud
        beginSuccess = http.begin(secureClient, BACKEND_URL);
    } else {
        beginSuccess = http.begin(plainClient, BACKEND_URL);
    }

    if (!beginSuccess) {
        Serial.printf("[HTTP] Failed to initiate connection to: %s\n", BACKEND_URL);
        postBackoffUntil = millis() + 4000;
        return;
    }

    http.addHeader("Content-Type", "application/json");
    http.setConnectTimeout(4000);
    http.setTimeout(4000);

    int httpCode = http.POST(json);

    if (httpCode > 0) {
        if (httpCode == HTTP_CODE_OK || httpCode == 204) {
            static unsigned long lastSuccessLog = 0;
            if (millis() - lastSuccessLog > 3000) {
                lastSuccessLog = millis();
                Serial.printf("[HTTP] POST OK (200) -> Web Gateway ONLINE | Active Nodes: %d\n", nodeCount);
            }
        } else {
            Serial.printf("[HTTP] Server responded with code: %d\n", httpCode);
        }
    } else {
        Serial.printf("[HTTP] POST FAILED: %d (%s) -> URL: %s\n",
                      httpCode, http.errorToString(httpCode).c_str(), BACKEND_URL);
        postBackoffUntil = millis() + 3000;
    }
    http.end();
}

void printSummary()
{
    Serial.println("=================== SYSTEM STATUS ===================");
    if (!radioHardwareReady) {
        Serial.println("RADIO HARDWARE WARNING: nRF24L01 did not respond on SPI boot!");
        Serial.println("Check: 3.3V power, GND, SCK=23, MOSI=22, MISO=21, CSN=20, CE=19");
    }
    if (xSemaphoreTake(nodeMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
        for (int i = 0; i < NUM_NODES; i++) {
            if (!nodes[i].seen) {
                Serial.printf("Node %d: [NO DATA YET]\n", i + 1);
                continue;
            }
            unsigned long age = millis() - nodes[i].lastMs;
            NodePacket &p = nodes[i].pkt;

            if (age > NODE_STALE_MS) {
                Serial.printf("Node %d [%s]: STALE - last seen %lu s ago\n",
                              i + 1, type_name(p.node_type), age / 1000);
                continue;
            }

            if (p.node_type == 0)
                Serial.printf("Node %d [panel_basic]: volt=%u mV (%.2f V)\n",
                              i + 1, p.voltage_mV, p.voltage_mV / 1000.0f);
            else if (p.node_type == 1)
                Serial.printf("Node %d [panel_full ]: volt=%u mV (%.2f V)  cont=%s  temp=%.1f C\n",
                              i + 1, p.voltage_mV, p.voltage_mV / 1000.0f,
                              p.continuity ? "OK" : "BROKEN", p.temp_c_x10 / 10.0f);
            else
                Serial.printf("Node %d [string     ]: volt=%u mV (%.2f V)  cont=%s  curr=%u mA (%.3f A)\n",
                              i + 1, p.voltage_mV, p.voltage_mV / 1000.0f,
                              p.continuity ? "OK" : "BROKEN", p.current_mA, p.current_mA / 1000.0f);
        }
        xSemaphoreGive(nodeMutex);
    }
    Serial.printf("Radio Stats: TotalRx=%lu | BadLen=%lu | BadId=%lu\n",
                  totalPacketsRx, badLengthDrops, badIdDrops);
    Serial.printf("WiFi Status: %s | Backend: %s\n",
                  (WiFi.status() == WL_CONNECTED) ? "CONNECTED" : "DISCONNECTED", BACKEND_URL);
    Serial.println("=====================================================");
}

void checkIncomingRadioPackets()
{
    if (!radioHardwareReady) return;

    uint8_t pipeNum;
    while (radio.available(&pipeNum)) {
        totalPacketsRx++;

        NodePacket pkt = {0};
        radio.read(&pkt, sizeof(pkt));

        if (pkt.node_id < 1 || pkt.node_id > NUM_NODES) {
            badIdDrops++;
            continue;
        }

        uint8_t idx = pkt.node_id - 1;
        if (xSemaphoreTake(nodeMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
            nodes[idx].seen    = true;
            nodes[idx].pkt     = pkt;
            nodes[idx].lastMs  = millis();
            nodes[idx].rxCount++;
            xSemaphoreGive(nodeMutex);
        }
    }
}

void radioTask(void *pvParameters)
{
    for (;;) {
        checkIncomingRadioPackets();
        vTaskDelay(pdMS_TO_TICKS(5));
    }
}

void setup()
{
    Serial.begin(115200);
    delay(1500);

    Serial.println("\n===========================================");
    Serial.println("  Solar Fault Detection - ESP32 Gateway    ");
    Serial.println("  Role: RECEIVER (PRX) - 4 Multiceiver Pipes");
    Serial.println("===========================================\n");

    nodeMutex = xSemaphoreCreateMutex();

    SPI.begin(SCK_PIN, MISO_PIN, MOSI_PIN, CSN_PIN);
    SPI.setFrequency(2000000);

    if (!radio.begin()) {
        Serial.println("\n[ERROR] nRF24L01 not responding! Check SPI wiring:");
        Serial.printf("  CE=%d, CSN=%d, SCK=%d, MOSI=%d, MISO=%d, VCC=3.3V\n",
                      CE_PIN, CSN_PIN, SCK_PIN, MOSI_PIN, MISO_PIN);
        Serial.println("[INFO] Gateway will continue to connect to Wi-Fi...\n");
        radioHardwareReady = false;
    } else {
        radioHardwareReady = true;
        radio.setChannel(RF_CHANNEL);
        radio.setDataRate(RF_DATARATE);
        radio.setAddressWidth(5);
        radio.setCRCLength(RF24_CRC_8);
        radio.setAutoAck(true);
        radio.setPayloadSize(sizeof(NodePacket));
        radio.enableDynamicPayloads();
        radio.setPALevel(RF24_PA_MAX);

        for (uint8_t i = 0; i < NUM_NODES; i++) {
            radio.openReadingPipe(i + 1, NODE_ADDR[i]);
        }

        radio.flush_rx();
        radio.flush_tx();
        radio.startListening();

        Serial.println("nRF24L01 initialized OK & Listening.");
    }

    xTaskCreate(radioTask, "RadioPoller", 4096, NULL, 2, NULL);
    Serial.println("Radio background polling task started (5ms interval)");

    connectWiFi();
    Serial.println("Ready. Cycling Node 1 -> Node 2 -> Node 3 -> String -> System Summary (1s each)\n");
}

void loop()
{
    static unsigned long lastDisplayMs = 0;
    static uint8_t displayStep = 0;

    if (millis() - lastDisplayMs >= 1000) {
        lastDisplayMs = millis();
        if (displayStep < 4) {
            printNodeCard(displayStep + 1);
        } else {
            printSummary();
        }
        displayStep = (displayStep + 1) % 5;
    }

    static unsigned long lastPostMs = 0;
    if (millis() - lastPostMs >= 1000) {
        lastPostMs = millis();
        postToBackend();
    }

    if (WiFi.status() != WL_CONNECTED) {
        static unsigned long lastTry = 0;
        if (millis() - lastTry > 8000) {
            lastTry = millis();
            Serial.println("[WiFi] Connection lost. Reconnecting...");
            WiFi.disconnect();
            WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
        }
    }
}

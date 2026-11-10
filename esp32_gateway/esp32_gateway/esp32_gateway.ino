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

   Multitasking FreeRTOS Architecture:
     1. RadioPoller Task (Priority 2, 5ms): Drains nRF24 RX FIFO into mutexed memory
     2. CloudUploader Task (Priority 1, 3s): Non-blocking background HTTPS POST to Render
     3. Main Loop (Priority 1): 100% smooth 1-second Serial Monitor display
        (Decoupled: HTTP network latency will NEVER freeze or stutter the Serial Monitor!)
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

/* Receive addresses MUST match datapipe_address[] in nrf24l01.c on CH32 side */
const uint8_t NODE_ADDR[NUM_NODES][5] = {
    {0xA1, 0xC3, 0xC2, 0xC1, 0x20},  // Pipe 1 -> Node 1 (Panel 1)
    {0xA2, 0xC3, 0xC2, 0xC1, 0x20},  // Pipe 2 -> Node 2 (Panel 2)
    {0xA3, 0xC3, 0xC2, 0xC1, 0x20},  // Pipe 3 -> Node 3 (Panel 3)
    {0xA4, 0xC3, 0xC2, 0xC1, 0x20}   // Pipe 4 -> Node 4 (String Node)
};

RF24 radio(CE_PIN, CSN_PIN);

/* -- WiFi & Backend ------------------------------------------------------- */
const char* WIFI_SSID     = "Hasheer's M35";
const char* WIFI_PASSWORD = "123456789";

/* Choose either Render cloud URL (worldwide) OR local PC dashboard (on same router): */
// Option A: Live Worldwide Cloud Backend (Render)
const char* BACKEND_URL   = "https://heliopv-solar.onrender.com/api/data";

// Option B: Local PC Backend (Update IP with your laptop's current Wi-Fi IP from `ipconfig`)
// const char* BACKEND_URL   = "http://10.98.235.70:3000/api/data";

/* -- Data structures ------------------------------------------------------ */
#define NODE_STALE_MS   8000

/* Must match CH32 struct byte-for-byte (11 bytes total): */
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

/* -------------------------------------------------------------------------
   WiFi connection (Non-blocking background auto-reconnect)
   ------------------------------------------------------------------------- */
void connectWiFi()
{
    Serial.printf("\n[WiFi] Connecting to: %s\n", WIFI_SSID);
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    int retries = 0;
    while (WiFi.status() != WL_CONNECTED && retries < 15) {
        delay(300);
        Serial.print(".");
        retries++;
    }
    Serial.println();

    if (WiFi.status() == WL_CONNECTED) {
        Serial.printf("[WiFi] CONNECTED! IP: %s\n", WiFi.localIP().toString().c_str());
        Serial.printf("[WiFi] Target Backend: %s\n\n", BACKEND_URL);
    } else {
        Serial.println("[WiFi] Connection pending... (will connect in background)");
        Serial.println("       Tip: Ensure phone hotspot has 'Maximize Compatibility / 2.4GHz' ON\n");
    }
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

/* -------------------------------------------------------------------------
   Deterministic Clean Node Card Display
   ------------------------------------------------------------------------- */
void printNodeCard(uint8_t id)
{
    uint8_t idx = id - 1;
    NodeState s;

    if (xSemaphoreTake(nodeMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
        s = nodes[idx];
        xSemaphoreGive(nodeMutex);
    } else {
        return;
    }

    Serial.println("+-----------------------------------------------+");
    if (!s.seen) {
        Serial.printf("| NODE %d  [%s]  - [WAITING FOR PACKETS]\n",
                      id, (id == 4) ? "string" : ((id == 1) ? "panel_basic" : "panel_full"));
        Serial.println("|  Status      : WAITING FOR TRANSMISSION");
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

/* -------------------------------------------------------------------------
   POST latest data for all seen nodes to backend
   - Runs in independent background FreeRTOS task (never blocks Serial!)
   - Small TLS buffers (1024/512) to prevent heap starvation on ESP32-C6
   ------------------------------------------------------------------------- */
void postToBackend()
{
    if (WiFi.status() != WL_CONNECTED) {
        Serial.printf("[WiFi] Waiting for connection to '%s'...\n", WIFI_SSID);
        return;
    }

    // Snapshot node state with quick mutex lock
    NodeState localCopy[NUM_NODES];
    if (xSemaphoreTake(nodeMutex, pdMS_TO_TICKS(30)) == pdTRUE) {
        for (int i = 0; i < NUM_NODES; i++) {
            localCopy[i] = nodes[i];
        }
        xSemaphoreGive(nodeMutex);
    } else {
        return;
    }

    String json = "{\"gateway\":\"online\",\"nodes\":[";
    bool first = true;

    for (int i = 0; i < NUM_NODES; i++) {
        if (!localCopy[i].seen) continue;

        unsigned long age = millis() - localCopy[i].lastMs;
        if (age > NODE_STALE_MS) continue;

        NodePacket &p = localCopy[i].pkt;
        if (!first) json += ",";
        first = false;

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
    json += "]}";

    HTTPClient http;
    bool isHttps = (strncmp(BACKEND_URL, "https://", 8) == 0);

    bool beginSuccess = false;
    WiFiClientSecure secureClient;
    WiFiClient       plainClient;

    if (isHttps) {
        secureClient.setInsecure();
        beginSuccess = http.begin(secureClient, BACKEND_URL);
    } else {
        beginSuccess = http.begin(plainClient, BACKEND_URL);
    }

    if (!beginSuccess) {
        Serial.printf("[HTTP ERROR] Cannot parse URL: %s\n", BACKEND_URL);
        return;
    }

    http.addHeader("Content-Type", "application/json");
    http.setUserAgent("ESP32-HelioPV-Gateway/1.0");
    http.setConnectTimeout(4000);
    http.setTimeout(4000);

    int httpCode = http.POST(json);

    if (httpCode > 0) {
        if (httpCode == HTTP_CODE_OK || httpCode == 204) {
            Serial.printf("[HTTP 200 OK] Web Dashboard Updated! (%d active nodes)\n", first ? 0 : 4);
        } else {
            Serial.printf("[HTTP %d] Server responded with code: %d\n", httpCode, httpCode);
        }
    } else {
        Serial.printf("[HTTP FAILED] %d (%s) -> URL: %s\n",
                      httpCode, http.errorToString(httpCode).c_str(), BACKEND_URL);
    }
    http.end();
}

/* -------------------------------------------------------------------------
   System Status Summary Table
   ------------------------------------------------------------------------- */
void printSummary()
{
    Serial.println("=================== SYSTEM STATUS ===================");
    if (xSemaphoreTake(nodeMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
        for (int i = 0; i < NUM_NODES; i++) {
            if (!nodes[i].seen) {
                Serial.printf("Node %d: [WAITING FOR TRANSMISSION]\n", i + 1);
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
    Serial.println("=====================================================");
}

/* -------------------------------------------------------------------------
   Check & drain incoming nRF24 radio packets (Bounded loop - never hangs)
   ------------------------------------------------------------------------- */
void checkIncomingRadioPackets()
{
    uint8_t pipeNum;
    uint8_t drainCount = 0;

    // Bounded to 6 iterations max so SPI noise can NEVER cause an infinite while loop
    while (radio.available(&pipeNum) && drainCount++ < 6) {
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

/* -------------------------------------------------------------------------
   FreeRTOS Background Task 1: Radio Poller (Runs every 10 ms)
   ------------------------------------------------------------------------- */
void radioTask(void *pvParameters)
{
    for (;;) {
        checkIncomingRadioPackets();
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

/* -------------------------------------------------------------------------
   FreeRTOS Background Task 2: Cloud Uploader (Runs every 3 seconds)
   - Runs completely in background so Serial Monitor NEVER gets stuck!
   ------------------------------------------------------------------------- */
void cloudTask(void *pvParameters)
{
    // Wait 2 seconds on boot before first transmission
    vTaskDelay(pdMS_TO_TICKS(2000));

    for (;;) {
        postToBackend();
        vTaskDelay(pdMS_TO_TICKS(3000)); // Non-blocking 3-second cycle
    }
}

/* -------------------------------------------------------------------------
   SETUP
   ------------------------------------------------------------------------- */
void setup()
{
    Serial.begin(115200);
    delay(1000);

    Serial.println("\n===========================================");
    Serial.println("  Solar Fault Detection - ESP32 Gateway    ");
    Serial.println("  Role: RECEIVER (PRX) - 4 Multiceiver Pipes");
    Serial.println("===========================================\n");

    nodeMutex = xSemaphoreCreateMutex();

    SPI.begin(SCK_PIN, MISO_PIN, MOSI_PIN, CSN_PIN);
    SPI.setFrequency(2000000);

    if (!radio.begin()) {
        Serial.println("FATAL: nRF24L01 not responding! Check wiring:");
        Serial.printf("  CE=%d, CSN=%d, SCK=%d, MOSI=%d, MISO=%d\n",
                      CE_PIN, CSN_PIN, SCK_PIN, MOSI_PIN, MISO_PIN);
        while (1) { delay(1000); }
    }

    /* Radio Configuration - MUST MATCH CH32 NODES */
    radio.setChannel(RF_CHANNEL);             // Channel 32 (2432 MHz)
    radio.setDataRate(RF_DATARATE);           // 1 Mbps
    radio.setAddressWidth(5);                 // 5 bytes address
    radio.setCRCLength(RF24_CRC_8);           // 8-bit CRC to match CH32 nrf24_crc_configuration(ENABLE, 1)
    radio.setAutoAck(true);                   // Auto-ACK enabled
    radio.setPayloadSize(sizeof(NodePacket)); // Static fallback 11-byte payload
    radio.enableDynamicPayloads();            // Dynamic payloads matching CH32 DPL
    radio.setPALevel(RF24_PA_MAX);

    for (uint8_t i = 0; i < NUM_NODES; i++) {
        radio.openReadingPipe(i + 1, NODE_ADDR[i]);
    }

    radio.flush_rx();
    radio.flush_tx();
    radio.startListening();

    Serial.println("nRF24L01 initialized OK & Listening.");

    connectWiFi();

    /* Task 1: Background Radio Poller (Priority 2) */
    xTaskCreate(radioTask, "RadioPoller", 4096, NULL, 2, NULL);
    Serial.println("[Task] Radio Poller task started (10ms)");

    /* Task 2: Background Cloud Uploader (Priority 1, 6KB stack for TLS) */
    xTaskCreate(cloudTask, "CloudUploader", 6144, NULL, 1, NULL);
    Serial.println("[Task] Cloud Uploader task started (3s interval, non-blocking)");

    Serial.println("\nReady. Cycling Node 1 -> Node 2 -> Node 3 -> String -> Summary (1s each)\n");
}

/* -------------------------------------------------------------------------
   LOOP: Deterministic 1-second Sequential Display
   - Completely decoupled from network calls: NEVER gets stuck!
   ------------------------------------------------------------------------- */
void loop()
{
    static unsigned long lastDisplayMs = 0;
    static uint8_t displayStep = 0;

    if (millis() - lastDisplayMs >= 1000) {
        lastDisplayMs = millis();

        if (displayStep < 4) {
            printNodeCard(displayStep + 1);  /* 0->Node 1, 1->Node 2, 2->Node 3, 3->String */
        } else {
            printSummary();                  /* 4->System Status Summary */
        }
        displayStep = (displayStep + 1) % 5;
    }

    // Yield CPU to FreeRTOS so IDLE task and background tasks run smoothly
    vTaskDelay(pdMS_TO_TICKS(20));
}

/*
 * esp32_gateway.ino  --  Solar Fault Detection — ESP32-C6 Master Gateway
 * Board: DFRobot Beetle ESP32-C6
 *
 * Role    : RECEIVER (PRX) — listens on 4 pipes simultaneously
 * Protocol: nRF24L01+ Multiceiver (Enhanced ShockBurst auto-ACK)
 *
 * Each CH32 node transmits independently every ~2 s.
 * The ESP32 auto-ACKs every received packet (Enhanced ShockBurst).
 * Received data is printed to Serial Monitor AND posted to the backend.
 *
 * Pin mapping:
 *   CE=19  CSN=20  SCK=23  MOSI=22  MISO=21
 *
 * Address map (must match datapipe_address[] in nrf24l01.c on CH32):
 *   Pipe 1 = 0x20,0xC3,0xC2,0xC1,0xA1  →  Panel 1 (panel_basic)
 *   Pipe 2 = 0x20,0xC3,0xC2,0xC1,0xA2  →  Panel 2 (panel_full)
 *   Pipe 3 = 0x20,0xC3,0xC2,0xC1,0xA3  →  Panel 3 (panel_full)
 *   Pipe 4 = 0x20,0xC3,0xC2,0xC1,0xA4  →  String node
 *
 * NOTE on Multiceiver address rules:
 *   Pipes 2-5 share bytes [0-3] with pipe 1 and only differ in byte [4].
 *   Our addresses already follow this rule (all share 0x20,0xC3,0xC2,0xC1).
 */

#include <SPI.h>
#include <RF24.h>
#include <WiFi.h>
#include <HTTPClient.h>

/* ── WiFi / backend ─────────────────────────────────────── */
const char *WIFI_SSID     = "Hasheer's M35";
const char *WIFI_PASSWORD = "123456789";
const char *BACKEND_URL   = "http://10.29.16.70:3000/api/data";

/* ── nRF24 pins ─────────────────────────────────────────── */
#define CE_PIN   19
#define CSN_PIN  20
#define SCK_PIN  23
#define MOSI_PIN 22
#define MISO_PIN 21

RF24 radio(CE_PIN, CSN_PIN);

/*
 * Receive addresses — MUST match datapipe_address[] in nrf24l01.c on CH32 side.
 *
 * nRF24L01 Multiceiver rule: pipes 2-5 share bytes [1..4] with pipe 1.
 * RF24::openReadingPipe(2..5, addr) only writes addr[0] to the register.
 * Therefore the UNIQUE byte MUST be at addr[0].
 *
 * After fix:
 *   Pipe 1 listens for: {0xA1, 0xC3, 0xC2, 0xC1, 0x20}  (full 5 bytes)
 *   Pipe 2 listens for: {0xA2, 0xC3, 0xC2, 0xC1, 0x20}  (only 0xA2 stored, rest from pipe 1)
 *   Pipe 3 listens for: {0xA3, 0xC3, 0xC2, 0xC1, 0x20}
 *   Pipe 4 listens for: {0xA4, 0xC3, 0xC2, 0xC1, 0x20}
 */
#define NUM_NODES 4
const uint8_t NODE_ADDR[NUM_NODES][5] = {
    {0xA1, 0xC3, 0xC2, 0xC1, 0x20},  // pipe 1 → Panel 1  (panel_basic)
    {0xA2, 0xC3, 0xC2, 0xC1, 0x20},  // pipe 2 → Panel 2  (panel_full)
    {0xA3, 0xC3, 0xC2, 0xC1, 0x20},  // pipe 3 → Panel 3  (panel_full)
    {0xA4, 0xC3, 0xC2, 0xC1, 0x20},  // pipe 4 → String node
};

/* ── NodePacket  (must match CH32 struct byte-for-byte, 11 bytes) ── */
typedef struct __attribute__((packed)) {
    uint8_t  node_id;
    uint8_t  node_type;   /* 0=panel_basic  1=panel_full  2=string */
    uint8_t  continuity;
    int16_t  temp_c10;    /* degrees C × 10; -999 = DS18B20 absent */
    uint16_t voltage_mV;
    uint16_t current_mA;
    uint16_t ldr_raw;
} NodePacket;

/* ── Per-node state ─────────────────────────────────────── */
struct NodeState {
    bool       seen     = false;
    NodePacket pkt      = {};
    unsigned long lastMs = 0;
    uint32_t   rxCount  = 0;
};
NodeState nodes[NUM_NODES];

/* A node is considered stale after this many ms with no new packet */
const unsigned long NODE_STALE_MS = 6000;

/* ════════════════════════════════════════════════════════
   WiFi helpers
   ════════════════════════════════════════════════════════ */
void connectWiFi()
{
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    Serial.print("Connecting to WiFi");
    unsigned long t = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t < 20000) {
        delay(300);
        Serial.print(".");
    }
    if (WiFi.status() == WL_CONNECTED)
        Serial.println("\nWiFi connected — IP: " + WiFi.localIP().toString());
    else
        Serial.println("\nWiFi FAILED — running serial-only mode");
}

/* ════════════════════════════════════════════════════════
   Pretty-print one packet to Serial
   ════════════════════════════════════════════════════════ */
/* ════════════════════════════════════════════════════════
   Pretty-print one node card to Serial in round-robin order
   ════════════════════════════════════════════════════════ */
static const char *type_name(uint8_t t)
{
    switch (t) {
        case 0: return "panel_basic";
        case 1: return "panel_full";
        case 2: return "string";
        default: return "unknown";
    }
}

void printNodeCard(uint8_t id)
{
    uint8_t idx = id - 1;
    NodeState &s = nodes[idx];

    Serial.println("┌──────────────────────────────────────────────");
    if (!s.seen) {
        Serial.printf( "│ NODE %d  [%s]  — [NO DATA YET]\n",
                       id, type_name(id == 4 ? 2 : (id == 1 ? 0 : 1)));
        Serial.println("│  Status      : WAITING FOR TRANSMISSION (check power/wiring)");
        Serial.println("└──────────────────────────────────────────────");
        return;
    }

    unsigned long age = millis() - s.lastMs;
    bool isStale = (age > NODE_STALE_MS);

    Serial.printf( "│ NODE %d  [%s]  rxCount=%lu%s\n",
                   id, type_name(s.pkt.node_type), s.rxCount,
                   isStale ? "  [STALE!]" : "  [LIVE]");
    Serial.println("│");

    if (s.pkt.node_type == 0 || s.pkt.node_type == 1) {
        if (s.pkt.temp_c10 == -999)
            Serial.println("│  Temperature : DS18B20 NOT FOUND (check sensor/pullup)");
        else
            Serial.printf("│  Temperature : %d.%d °C\n",
                          s.pkt.temp_c10 / 10, abs(s.pkt.temp_c10 % 10));
        Serial.printf("│  Voltage     : %u mV  (%.2f V)\n",
                      s.pkt.voltage_mV, s.pkt.voltage_mV / 1000.0f);
    }

    if (s.pkt.node_type == 1) {
        Serial.printf("│  Continuity  : %s\n",
                      s.pkt.continuity ? "OK  (wire intact)" : "*** BROKEN / FAULT ***");
    }

    if (s.pkt.node_type == 2) {
        Serial.printf("│  Continuity  : %s\n",
                      s.pkt.continuity ? "OK  (string intact)" : "*** BROKEN / FAULT ***");
        Serial.printf("│  Current     : %u mA  (%.3f A)\n",
                      s.pkt.current_mA, s.pkt.current_mA / 1000.0f);
        Serial.printf("│  LDR raw     : %u\n", s.pkt.ldr_raw);
    }

    Serial.println("└──────────────────────────────────────────────");
}

/* ════════════════════════════════════════════════════════
   POST latest data for all seen nodes to backend
   ════════════════════════════════════════════════════════ */
void postToBackend()
{
    if (WiFi.status() != WL_CONNECTED) return;

    String json = "{\"nodes\":[";
    bool first = true;

    for (int i = 0; i < NUM_NODES; i++) {
        if (!nodes[i].seen) continue;

        /* Only send nodes whose data is not stale */
        unsigned long age = millis() - nodes[i].lastMs;
        if (age > NODE_STALE_MS) continue;

        NodePacket &p = nodes[i].pkt;
        if (!first) json += ",";
        first = false;

        json += "{\"id\":"         + String(p.node_id);
        json += ",\"node_type\":"  + String(p.node_type);
        json += ",\"continuity\":" + String(p.continuity ? "true" : "false");
        json += ",\"temp_c10\":"   + String(p.temp_c10);
        json += ",\"voltage_mV\":" + String(p.voltage_mV);
        json += ",\"current_mA\":" + String(p.current_mA);
        json += ",\"ldr_raw\":"    + String(p.ldr_raw);
        json += ",\"ageMs\":"      + String(age) + "}";
    }

    if (first) return;   /* no fresh data — don't POST an empty list */

    json += "]}";

    HTTPClient http;
    http.begin(BACKEND_URL);
    http.addHeader("Content-Type", "application/json");
    http.setConnectTimeout(2000);
    http.setTimeout(2000);
    int code = http.POST(json);

    static bool backendWasOffline = false;
    if (code > 0) {
        if (backendWasOffline) {
            Serial.printf("[HTTP] Backend server connected! (POST → HTTP %d)\n", code);
            backendWasOffline = false;
        }
    } else {
        if (!backendWasOffline) {
            Serial.printf("[HTTP] POST failed: %d (%s) -> URL: %s\n", code, http.errorToString(code).c_str(), BACKEND_URL);
            backendWasOffline = true;
        }
    }
    http.end();
}

/* ════════════════════════════════════════════════════════
   Periodic full-system status summary to Serial
   ════════════════════════════════════════════════════════ */
void printSummary()
{
    Serial.println("\n========== SYSTEM STATUS ==========");
    for (int i = 0; i < NUM_NODES; i++) {
        if (!nodes[i].seen) {
            Serial.printf("Node %d: [NO DATA YET]\n", i + 1);
            continue;
        }
        unsigned long age = millis() - nodes[i].lastMs;
        NodePacket &p = nodes[i].pkt;

        if (age > NODE_STALE_MS) {
            Serial.printf("Node %d [%s]: STALE — last seen %lu s ago\n",
                          i + 1, type_name(p.node_type), age / 1000);
            continue;
        }

        if (p.node_type == 0)
            Serial.printf("Node %d [panel_basic]: temp=%d.%d°C  volt=%umV\n",
                          i+1, p.temp_c10/10, abs(p.temp_c10%10), p.voltage_mV);
        else if (p.node_type == 1)
            Serial.printf("Node %d [panel_full ]: temp=%d.%d°C  volt=%umV  cont=%s\n",
                          i+1, p.temp_c10/10, abs(p.temp_c10%10), p.voltage_mV,
                          p.continuity ? "OK" : "BROKEN");
        else
            Serial.printf("Node %d [string     ]: cont=%s  curr=%umA  ldr=%u\n",
                          i+1, p.continuity ? "OK" : "BROKEN",
                          p.current_mA, p.ldr_raw);
    }
    Serial.println("====================================\n");
}

/* ════════════════════════════════════════════════════════
   SETUP
   ════════════════════════════════════════════════════════ */
void setup()
{
    Serial.begin(115200);
    delay(1500);

    Serial.println("\n===========================================");
    Serial.println("  Solar Fault Detection — ESP32 Gateway");
    Serial.println("  Role: RECEIVER (PRX), 4 pipes");
    Serial.println("===========================================\n");

    SPI.end();
    SPI.begin(SCK_PIN, MISO_PIN, MOSI_PIN, CSN_PIN);

    if (!radio.begin(&SPI, CE_PIN, CSN_PIN)) {
        Serial.println("ERROR: nRF24L01 NOT DETECTED — check wiring!");
        while (1) delay(1000);
    }
    Serial.println("nRF24L01 detected OK");

    /* Radio config — must match CH32 nodes */
    radio.setChannel(32);
    radio.setDataRate(RF24_1MBPS);
    radio.setAddressWidth(5);
    radio.setCRCLength(RF24_CRC_8);
    radio.setAutoAck(true);          /* auto-ACK = ESP32 ACKs every received packet */
    radio.enableDynamicPayloads();   /* CH32 sends 11-byte NodePacket via DPL */
    radio.setPALevel(RF24_PA_HIGH);

    /*
     * Open 4 reading pipes.
     * Pipe 1 carries the full 5-byte base address.
     * Pipes 2-4 share bytes [1..4] with pipe 1; RF24 library writes only
     * the unique byte [0] for pipes 2-5 — our addresses follow this rule.
     */
    for (uint8_t i = 0; i < NUM_NODES; i++) {
        radio.openReadingPipe(i + 1, NODE_ADDR[i]);
        Serial.printf("Pipe %d: %02X:%02X:%02X:%02X:%02X\n",
                      i + 1,
                      NODE_ADDR[i][0], NODE_ADDR[i][1],
                      NODE_ADDR[i][2], NODE_ADDR[i][3],
                      NODE_ADDR[i][4]);
    }

    radio.startListening();
    Serial.println("\n--- nRF24 Register Details ---");
    radio.printPrettyDetails();
    Serial.println("-------------------------------\n");
    Serial.println("Listening — waiting for nodes to transmit...\n");
    Serial.printf("NodePacket size: %d bytes\n\n", (int)sizeof(NodePacket));

    connectWiFi();
}

/* ════════════════════════════════════════════════════════
   LOOP
   ════════════════════════════════════════════════════════ */
void loop()
{
    /* ── Check for incoming packets in background ───────── */
    uint8_t pipeNum;
    while (radio.available(&pipeNum)) {

        uint8_t len = radio.getDynamicPayloadSize();

        if (len != sizeof(NodePacket)) {
            /* Wrong size — drain and ignore so FIFO doesn't jam */
            uint8_t dummy[32];
            radio.read(dummy, min((int)len, 32));
            continue;
        }

        NodePacket pkt;
        radio.read(&pkt, sizeof(pkt));

        /* Basic sanity: node_id must map to valid range */
        if (pkt.node_id < 1 || pkt.node_id > NUM_NODES) {
            continue;
        }

        /* Store / update state */
        uint8_t idx        = pkt.node_id - 1;
        nodes[idx].seen    = true;
        nodes[idx].pkt     = pkt;
        nodes[idx].lastMs  = millis();
        nodes[idx].rxCount++;
    }

    /* ── Predictable 2-Second Sequential Display ───────── */
    /* Cycles strictly: Node 1 -> Node 2 -> Node 3 -> Node 4 -> Summary */
    static unsigned long lastDisplayMs = 0;
    static uint8_t displayStep = 0;

    if (millis() - lastDisplayMs >= 2000) {
        lastDisplayMs = millis();

        if (displayStep < 4) {
            printNodeCard(displayStep + 1);   // Prints Node 1, 2, 3, or 4
        } else {
            printSummary();                   // Prints full summary table
        }
        displayStep = (displayStep + 1) % 5;
    }

    /* ── Post to backend periodically (every 2 s) ──────── */
    static unsigned long lastPostMs = 0;
    if (millis() - lastPostMs >= 2000) {
        lastPostMs = millis();
        postToBackend();
    }

    /* ── WiFi reconnect watchdog ────────────────────────── */
    if (WiFi.status() != WL_CONNECTED) {
        static unsigned long lastTry = 0;
        if (millis() - lastTry > 15000) {
            lastTry = millis();
            Serial.println("WiFi lost — reconnecting...");
            WiFi.disconnect();
            WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
        }
    }
}

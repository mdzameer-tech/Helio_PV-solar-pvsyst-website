// Solar IoT Gateway & PVsyst EPC Studio — Combined Server
// Serves:
// 1. Integrated Dashboard (IoT String Monitor + PVsyst Solar Estimation)
// 2. ESP32 Telemetry Receiver (POST /api/data)
// 3. Status & Diagnostics Polling (GET /api/status)
// 4. Interactive Simulation & Testing (POST /api/simulate)

const express = require("express");
const path = require("path");
const os = require("os");

const app = express();
app.use(express.json());

// Enable CORS for all origins (localhost, 127.0.0.1, mobile, file://, etc.)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Serve static project files directly (HTML, JS, CSS, images)
app.use(express.static(path.join(__dirname, ".")));

const NODE_TIMEOUT_MS = 15000;    // 15 seconds margin
const GATEWAY_TIMEOUT_MS = 15000; // 15 seconds margin
const LOW_VOLTAGE_MV = 500;       // Threshold in mV

const NODE_TYPE_NAME = { 0: "panel_basic", 1: "panel_full", 2: "string" };

let latest = {
  nodes: [],
  receivedAt: 0,
  isSimulated: false,
  simulationScenario: "normal"
};
let lastLog = 0;

// Helper: Get active local IPv4 addresses
function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === "IPv4" && !net.internal) {
        addresses.push({ interface: name, address: net.address });
      }
    }
  }
  return addresses;
}

// Routes for web views
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/monitor", (req, res) => {
  res.redirect("/?view=monitor");
});

app.get("/estimate", (req, res) => {
  res.redirect("/?view=estimate");
});

app.get("/pvsyst", (req, res) => {
  res.redirect("/?view=estimate");
});

// Network information endpoint
app.get("/api/network-info", (req, res) => {
  res.json({
    localIPs: getLocalIPs(),
    port: 3000,
    serverTime: Date.now()
  });
});

// ESP32 posts telemetry packets here
app.post("/api/data", (req, res) => {
  const nodes = (req.body && req.body.nodes) || [];
  latest = {
    nodes,
    receivedAt: Date.now(),
    isSimulated: false,
    simulationScenario: null
  };

  if (Date.now() - lastLog > 2000) {
    lastLog = Date.now();
    console.log(`[${new Date().toLocaleTimeString()}] ESP32 Live Packet Received: ${nodes.length} active node(s)`);
  }
  res.sendStatus(200);
});

// Simulation endpoint for client demos & testing
app.post("/api/simulate", (req, res) => {
  const scenario = (req.body && req.body.scenario) || "normal";

  if (scenario === "live_hardware") {
    latest = {
      nodes: [],
      receivedAt: 0,
      isSimulated: false,
      simulationScenario: null
    };
    console.log(`[${new Date().toLocaleTimeString()}] Switched to Live Hardware Mode (waiting for ESP32)`);
    return res.json({ success: true, message: "Switched to Live Hardware Mode", scenario: "live_hardware" });
  }

  // Generate simulated nodes based on scenario
  let mockNodes = [];
  const now = Date.now();

  if (scenario === "normal") {
    // All 4 nodes connected and healthy
    mockNodes = [
      { id: 1, node_type: 0, continuity: true, temp_c10: 295, voltage_mV: 18450, current_mA: 0, ldr_raw: 0, ageMs: 120 },
      { id: 2, node_type: 1, continuity: true, temp_c10: 310, voltage_mV: 18200, current_mA: 0, ldr_raw: 0, ageMs: 150 },
      { id: 3, node_type: 1, continuity: true, temp_c10: 305, voltage_mV: 18350, current_mA: 0, ldr_raw: 0, ageMs: 110 },
      { id: 4, node_type: 2, continuity: true, temp_c10: -999, voltage_mV: 55000, current_mA: 5400, ldr_raw: 890, ageMs: 90 }
    ];
  } else if (scenario === "fault_p1_p2") {
    // Broken connection between Panel 1 and Panel 2 (reported by Node 2)
    mockNodes = [
      { id: 1, node_type: 0, continuity: true, temp_c10: 295, voltage_mV: 18450, current_mA: 0, ldr_raw: 0, ageMs: 120 },
      { id: 2, node_type: 1, continuity: false, temp_c10: 310, voltage_mV: 18200, current_mA: 0, ldr_raw: 0, ageMs: 150 },
      { id: 3, node_type: 1, continuity: false, temp_c10: 305, voltage_mV: 18350, current_mA: 0, ldr_raw: 0, ageMs: 110 },
      { id: 4, node_type: 2, continuity: false, temp_c10: -999, voltage_mV: 0, current_mA: 0, ldr_raw: 890, ageMs: 90 }
    ];
  } else if (scenario === "fault_p2_p3") {
    // Broken connection between Panel 2 and Panel 3 (reported by Node 3)
    mockNodes = [
      { id: 1, node_type: 0, continuity: true, temp_c10: 295, voltage_mV: 18450, current_mA: 0, ldr_raw: 0, ageMs: 120 },
      { id: 2, node_type: 1, continuity: true, temp_c10: 310, voltage_mV: 18200, current_mA: 0, ldr_raw: 0, ageMs: 150 },
      { id: 3, node_type: 1, continuity: false, temp_c10: 305, voltage_mV: 18350, current_mA: 0, ldr_raw: 0, ageMs: 110 },
      { id: 4, node_type: 2, continuity: false, temp_c10: -999, voltage_mV: 0, current_mA: 0, ldr_raw: 890, ageMs: 90 }
    ];
  } else if (scenario === "fault_p3_string") {
    // Broken connection between Panel 3 and String node (reported by Node 4)
    mockNodes = [
      { id: 1, node_type: 0, continuity: true, temp_c10: 295, voltage_mV: 18450, current_mA: 0, ldr_raw: 0, ageMs: 120 },
      { id: 2, node_type: 1, continuity: true, temp_c10: 310, voltage_mV: 18200, current_mA: 0, ldr_raw: 0, ageMs: 150 },
      { id: 3, node_type: 1, continuity: true, temp_c10: 305, voltage_mV: 18350, current_mA: 0, ldr_raw: 0, ageMs: 110 },
      { id: 4, node_type: 2, continuity: false, temp_c10: -999, voltage_mV: 0, current_mA: 0, ldr_raw: 890, ageMs: 90 }
    ];
  } else if (scenario === "low_voltage") {
    // Shading on Panel 2 causing low voltage drop
    mockNodes = [
      { id: 1, node_type: 0, continuity: true, temp_c10: 295, voltage_mV: 18450, current_mA: 0, ldr_raw: 0, ageMs: 120 },
      { id: 2, node_type: 1, continuity: true, temp_c10: 380, voltage_mV: 350, current_mA: 0, ldr_raw: 0, ageMs: 150 },
      { id: 3, node_type: 1, continuity: true, temp_c10: 305, voltage_mV: 18350, current_mA: 0, ldr_raw: 0, ageMs: 110 },
      { id: 4, node_type: 2, continuity: true, temp_c10: -999, voltage_mV: 37150, current_mA: 2100, ldr_raw: 410, ageMs: 90 }
    ];
  } else if (scenario === "gateway_offline") {
    latest = {
      nodes: [],
      receivedAt: 0,
      isSimulated: true,
      simulationScenario: "gateway_offline"
    };
    return res.json({ success: true, message: "Simulating Gateway Offline", scenario: "gateway_offline" });
  }

  latest = {
    nodes: mockNodes,
    receivedAt: now,
    isSimulated: true,
    simulationScenario: scenario
  };

  console.log(`[${new Date().toLocaleTimeString()}] Simulation Scenario Active: ${scenario}`);
  res.json({ success: true, message: `Active scenario: ${scenario}`, scenario });
});

// Status endpoint polled by frontend UI
app.get("/api/status", (req, res) => {
  const gatewayAge = Date.now() - latest.receivedAt;
  const gatewayOnline = latest.receivedAt !== 0 && gatewayAge < GATEWAY_TIMEOUT_MS;

  // 1. Identify ROOT CAUSE continuity break (LOWEST node ID reporting broken)
  let faultNodeId = null;
  let faultDescription = null;

  if (gatewayOnline) {
    for (let id = 2; id <= 4; id++) {
      const n = latest.nodes.find((x) => x.id === id);
      if (n) {
        const age = (n.ageMs || 0) + gatewayAge;
        if (age <= NODE_TIMEOUT_MS && n.continuity === false) {
          faultNodeId = id;
          if (id === 2) {
            faultDescription = "Disconnection detected between Panel 1 and Panel 2";
          } else if (id === 3) {
            faultDescription = "Disconnection detected between Panel 2 and Panel 3";
          } else if (id === 4) {
            faultDescription = "Disconnection detected between Panel 3 and String Node";
          }
          break; // Stop at the LOWEST panel number!
        }
      }
    }
  }

  // 2. Build cell statuses with cascade / gray zone support
  const cells = [1, 2, 3, 4].map((id) => {
    const n = latest.nodes.find((x) => x.id === id);
    const nodeType = n ? n.node_type : (id <= 3 ? (id === 1 ? 0 : 1) : 2);
    const typeName = NODE_TYPE_NAME[nodeType] || "unknown";

    if (!n || !gatewayOnline) {
      return { id, type: typeName, state: "no_signal" };
    }

    const age = (n.ageMs || 0) + gatewayAge;
    if (age > NODE_TIMEOUT_MS) {
      return { id, type: typeName, state: "no_signal" };
    }

    // Determine state based on fault isolation
    let state = "ok";
    if (faultNodeId !== null) {
      if (id === faultNodeId) {
        state = "broken"; // The actual break point!
      } else if (id > faultNodeId) {
        state = "gray_zone"; // Downstream: indeterminate until upstream wire fixed
      }
    }

    if (typeName === "panel_basic" || typeName === "panel_full") {
      const voltage = n.voltage_mV / 1000;
      const temp = n.temp_c10 === -999 ? null : n.temp_c10 / 10;
      if (state === "ok" && n.voltage_mV < LOW_VOLTAGE_MV) state = "low_voltage";
      return { id, type: typeName, state, temp, voltage };
    }

    // String node: continuity + current + LDR + string voltage + power
    const current = n.current_mA / 1000;

    let stringVoltage = 0;
    if (n.voltage_mV && n.voltage_mV > 0) {
      stringVoltage = n.voltage_mV / 1000;
    } else {
      for (let pId = 1; pId <= 3; pId++) {
        const pNode = latest.nodes.find((x) => x.id === pId);
        if (pNode && pNode.voltage_mV > 0) {
          stringVoltage += pNode.voltage_mV / 1000;
        }
      }
    }
    const power = stringVoltage * current;

    return {
      id,
      type: typeName,
      state,
      voltage: Number(stringVoltage.toFixed(2)),
      current: Number(current.toFixed(3)),
      power: Number(power.toFixed(2)),
      ldr: n.ldr_raw
    };
  });

  // 3. Compute wire states between adjacent nodes (P1-P2, P2-P3, P3-String)
  const wires = [
    { from: 1, to: 2, monitoredBy: 2 },
    { from: 2, to: 3, monitoredBy: 3 },
    { from: 3, to: 4, monitoredBy: 4 }
  ].map((w) => {
    if (!gatewayOnline) return { ...w, state: "no_signal" };

    if (faultNodeId === null) {
      return { ...w, state: "closed" };
    }
    if (w.monitoredBy < faultNodeId) {
      return { ...w, state: "closed" };
    }
    if (w.monitoredBy === faultNodeId) {
      return { ...w, state: "open" }; // Physical break point!
    }
    return { ...w, state: "gray_zone" }; // Downstream of break
  });

  res.json({
    gatewayOnline,
    faultNodeId,
    faultDescription,
    wires,
    cells,
    isSimulated: latest.isSimulated,
    simulationScenario: latest.simulationScenario,
    serverTime: Date.now()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  const localIPs = getLocalIPs();
  console.log("==============================================================");
  console.log("  ☀️  HelioPV EPC Studio + ESP32 Solar IoT Monitor Running!  ");
  console.log("==============================================================");
  console.log(`  Local Web Studio:      http://localhost:${PORT}`);
  console.log(`  Live IoT String View:  http://localhost:${PORT}/monitor`);
  console.log(`  PVsyst Estimation View:http://localhost:${PORT}/estimate`);
  console.log(`  Telemetry Polling API: http://localhost:${PORT}/api/status`);
  console.log("--------------------------------------------------------------");
  console.log("  ESP32 Gateway Configuration (esp32_gateway.ino):");
  if (localIPs.length > 0) {
    localIPs.forEach(ip => {
      console.log(`  -> Set BACKEND_URL = "http://${ip.address}:${PORT}/api/data"; (${ip.interface})`);
    });
  } else {
    console.log(`  -> Set BACKEND_URL = "http://<YOUR_PC_IP>:${PORT}/api/data";`);
  }
  console.log("==============================================================");
});

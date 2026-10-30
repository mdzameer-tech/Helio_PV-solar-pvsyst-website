// Solar IoT Gateway & PVsyst EPC Studio — Combined Server
// Serves:
// 1. Integrated Dashboard (IoT String Monitor + PVsyst Solar Estimation)
// 2. ESP32 Telemetry Receiver (POST /api/data)
// 3. Status & Diagnostics Polling (GET /api/status)
// 4. Interactive Simulation & Testing (POST /api/simulate)

const express = require("express");
const path = require("path");
const os = require("os");
const fs = require("fs");
const webpush = require("web-push");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// JWT Secret Key
const JWT_SECRET = process.env.JWT_SECRET || "heliopv_jwt_secret_secure_key_2026_solar_iot";
const USERS_FILE = path.join(__dirname, "users.json");
let users = [];

function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
    }
  } catch (e) {
    users = [];
  }
}

function saveUsers() {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
  } catch (e) {
    console.error("Failed to save users:", e.message);
  }
}
loadUsers();

// Middleware to authenticate JWT
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).json({ error: "Authentication token required" });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: "Session expired or invalid token" });
    }
    const user = users.find((u) => u.id === decoded.id);
    if (!user) {
      return res.status(404).json({ error: "User account not found" });
    }
    req.user = user;
    next();
  });
}

// VAPID Keys for Native Web Push (Alerts phone even when app is closed)
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "BFwo5xRNdlvZj3bMXhcPCPdu47mZgMMpZO3D1DO9OJ47Vg5jAkOdSEdhSZZID7OJW0sh2NK-5zqD6eqvNJWAcUU";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "adsHJqvAZFKolPeWBWcrnUKKnzUg4EX962zZ_5LKCzQ";

webpush.setVapidDetails(
  "mailto:support@heliopv.com",
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

// File-backed push subscriptions store so device tokens survive restarts
const SUBSCRIPTIONS_FILE = path.join(__dirname, "push_subscriptions.json");
let pushSubscriptions = [];

function loadSubscriptions() {
  try {
    if (fs.existsSync(SUBSCRIPTIONS_FILE)) {
      pushSubscriptions = JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, "utf8"));
    }
  } catch (e) {
    pushSubscriptions = [];
  }
}
function saveSubscriptions() {
  try {
    fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(pushSubscriptions, null, 2), "utf8");
  } catch (e) {}
}
loadSubscriptions();

// Broadcast push notification to all subscribed mobile & desktop devices
async function sendPushNotification(payload) {
  if (!pushSubscriptions || pushSubscriptions.length === 0) {
    console.log(`[Push Notification] No active subscribers. Notification queued in logs: ${payload.title}`);
    return;
  }

  console.log(`[Push Notification] Broadcasting to ${pushSubscriptions.length} device(s): ${payload.title}`);
  const payloadString = JSON.stringify(payload);
  const activeSubs = [];

  for (const sub of pushSubscriptions) {
    try {
      await webpush.sendNotification(sub, payloadString);
      activeSubs.push(sub);
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        console.log(`[Push Notification] Expired subscription removed.`);
      } else {
        console.error(`[Push Notification] Delivery issue:`, err.message);
        activeSubs.push(sub);
      }
    }
  }

  if (activeSubs.length !== pushSubscriptions.length) {
    pushSubscriptions = activeSubs;
    saveSubscriptions();
  }
}

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

// ─────────────────────────────────────────────────────────────
// AUTHENTICATION API ENDPOINTS (JWT + BCRYPT)
// ─────────────────────────────────────────────────────────────

// Register a new user
app.post("/api/auth/signup", async (req, res) => {
  try {
    const { name, email, password, profileImage } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ error: "Full name, email, and password are required" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    const normalizedEmail = email.trim().toLowerCase();
    if (users.some((u) => u.email.toLowerCase() === normalizedEmail)) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const defaultAvatar = `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(name.trim())}&backgroundColor=0f356b,0a254a`;

    const newUser = {
      id: "usr_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7),
      name: name.trim(),
      email: normalizedEmail,
      passwordHash,
      profileImage: profileImage || defaultAvatar,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    users.push(newUser);
    saveUsers();

    const token = jwt.sign(
      { id: newUser.id, email: newUser.email, name: newUser.name },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.status(201).json({
      message: "Account registered successfully",
      token,
      user: {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        profileImage: newUser.profileImage
      }
    });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ error: "Internal server error during registration" });
  }
});

// Log in an existing user
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = users.find((u) => u.email.toLowerCase() === normalizedEmail);
    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.json({
      message: "Login successful",
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        profileImage: user.profileImage
      }
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Internal server error during login" });
  }
});

// Get current user profile
app.get("/api/auth/me", authenticateToken, (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      profileImage: req.user.profileImage,
      createdAt: req.user.createdAt
    }
  });
});

// Change user password
app.post("/api/auth/change-password", authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Current password and new password are required" });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: "New password must be at least 6 characters" });
    }

    const isMatch = await bcrypt.compare(currentPassword, req.user.passwordHash);
    if (!isMatch) {
      return res.status(400).json({ error: "Current password does not match" });
    }

    const salt = await bcrypt.genSalt(10);
    req.user.passwordHash = await bcrypt.hash(newPassword, salt);
    req.user.updatedAt = new Date().toISOString();
    saveUsers();

    res.json({ message: "Password updated successfully" });
  } catch (err) {
    console.error("Change password error:", err);
    res.status(500).json({ error: "Internal server error updating password" });
  }
});

// Update user profile (Name, Profile Image)
app.post("/api/auth/update-profile", authenticateToken, async (req, res) => {
  try {
    const { name, profileImage } = req.body || {};
    if (name && name.trim()) {
      req.user.name = name.trim();
    }
    if (profileImage) {
      req.user.profileImage = profileImage;
    }
    req.user.updatedAt = new Date().toISOString();
    saveUsers();

    const token = jwt.sign(
      { id: req.user.id, email: req.user.email, name: req.user.name },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.json({
      message: "Profile updated successfully",
      token,
      user: {
        id: req.user.id,
        name: req.user.name,
        email: req.user.email,
        profileImage: req.user.profileImage
      }
    });
  } catch (err) {
    console.error("Update profile error:", err);
    res.status(500).json({ error: "Internal server error updating profile" });
  }
});

// ─────────────────────────────────────────────────────────────
// WEB PUSH NOTIFICATION API ENDPOINTS
// ─────────────────────────────────────────────────────────────

// Return VAPID Public Key for client browser subscription
app.get("/api/vapid-public-key", (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// Subscribe client device to push alerts
app.post("/api/push-subscribe", (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: "Invalid subscription payload" });
  }

  const exists = pushSubscriptions.some((s) => s.endpoint === subscription.endpoint);
  if (!exists) {
    pushSubscriptions.push(subscription);
    saveSubscriptions();
    console.log(`[Push Notification] New device subscribed! Total active devices: ${pushSubscriptions.length}`);
  }
  res.status(201).json({ success: true, count: pushSubscriptions.length });
});

// Unsubscribe client device
app.post("/api/push-unsubscribe", (req, res) => {
  const { endpoint } = req.body || {};
  pushSubscriptions = pushSubscriptions.filter((s) => s.endpoint !== endpoint);
  saveSubscriptions();
  res.json({ success: true, count: pushSubscriptions.length });
});

// Immediate test push notification endpoint (test while app/tab is closed)
app.post("/api/push-test", async (req, res) => {
  await sendPushNotification({
    title: "⚠️ Solar String Fault Detected! (Test Alert)",
    body: "Wire break simulation at Node 2: Open circuit detected.",
    icon: "https://cdn-icons-png.flaticon.com/512/564/564619.png",
    badge: "https://cdn-icons-png.flaticon.com/512/564/564619.png",
    vibrate: [250, 100, 250, 100, 250],
    url: "/?view=monitor"
  });
  res.json({ success: true, count: pushSubscriptions.length });
});

// Helper: Compute fault state consistently across endpoints
let lastFaultState = null;

function computeFaultState() {
  const gatewayAge = Date.now() - latest.receivedAt;
  const gatewayOnline = latest.receivedAt !== 0 && gatewayAge < GATEWAY_TIMEOUT_MS;

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
          break; // Stop at LOWEST numbered node
        }
      }
    }
  }

  return { gatewayAge, gatewayOnline, faultNodeId, faultDescription };
}

function checkFaultAndNotify() {
  const { gatewayOnline, faultNodeId, faultDescription } = computeFaultState();

  if (faultNodeId !== null && lastFaultState === null) {
    // A NEW fault just occurred!
    console.log(`[ALERT] 🚨 Solar String Fault at Node ${faultNodeId}! Triggering Native Push...`);
    sendPushNotification({
      title: "⚠️ Solar String Fault Detected!",
      body: `Wire break at Node ${faultNodeId}: ${faultDescription}`,
      icon: "https://cdn-icons-png.flaticon.com/512/564/564619.png",
      badge: "https://cdn-icons-png.flaticon.com/512/564/564619.png",
      vibrate: [250, 100, 250, 100, 250],
      url: "/?view=monitor"
    });
    lastFaultState = faultNodeId;
  } else if (faultNodeId === null && lastFaultState !== null) {
    // System recovered
    if (gatewayOnline) {
      console.log(`[ALERT] ✅ Solar String Fault Cleared! Triggering Recovery Push...`);
      sendPushNotification({
        title: "✅ Solar String Restored",
        body: "All panel connections are back to normal.",
        icon: "https://cdn-icons-png.flaticon.com/512/190/190411.png",
        badge: "https://cdn-icons-png.flaticon.com/512/190/190411.png",
        vibrate: [100, 50, 100],
        url: "/?view=monitor"
      });
      lastFaultState = null;
    }
  }
}

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

  // Trigger alert if open circuit fault was detected
  checkFaultAndNotify();
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
    checkFaultAndNotify();
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
    checkFaultAndNotify();
    return res.json({ success: true, message: "Simulating Gateway Offline", scenario: "gateway_offline" });
  }

  latest = {
    nodes: mockNodes,
    receivedAt: now,
    isSimulated: true,
    simulationScenario: scenario
  };

  console.log(`[${new Date().toLocaleTimeString()}] Simulation Scenario Active: ${scenario}`);
  checkFaultAndNotify();
  res.json({ success: true, message: `Active scenario: ${scenario}`, scenario });
});

// Status endpoint polled by frontend UI
app.get("/api/status", (req, res) => {
  const { gatewayAge, gatewayOnline, faultNodeId, faultDescription } = computeFaultState();

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

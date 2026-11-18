// Solar IoT Gateway & PVsyst EPC Studio — Combined Server
// Serves:
// 1. Integrated Dashboard (IoT String Monitor + PVsyst Solar Estimation)
// 2. ESP32 Telemetry Receiver (POST /api/data)
// 3. Status & Diagnostics Polling (GET /api/status)
// 4. Interactive Simulation & Testing (POST /api/simulate)

require("dotenv").config();
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

const dns = require("dns");
// On Windows only, default ISP DNS often fails SRV records.
// On Linux/Docker (e.g. Render containers), do NOT override system DNS by default as containers use internal DNS resolvers (e.g. 127.0.0.11).
if (process.platform === "win32") {
  try {
    dns.setServers(["8.8.8.8", "8.8.4.4"]);
  } catch (e) {
    console.warn("Could not set custom DNS servers on Windows:", e.message);
  }
}

const mongoose = require("mongoose");
// Disable buffering so queries never hang for 10,000ms if connection is delayed or firewalled
mongoose.set("bufferCommands", false);

// Connection URIs: Primary SRV and Direct Replica Set Fallback
const ATLAS_SRV_URI = process.env.MONGODB_URI || "mongodb+srv://mdzameer8618_db_user:xGEObXJ442Zru5EG@cluster0.uray226.mongodb.net/heliopv?retryWrites=true&w=majority";
const ATLAS_DIRECT_URI = "mongodb://mdzameer8618_db_user:xGEObXJ442Zru5EG@ac-pfkhhvp-shard-00-00.uray226.mongodb.net:27017,ac-pfkhhvp-shard-00-01.uray226.mongodb.net:27017,ac-pfkhhvp-shard-00-02.uray226.mongodb.net:27017/heliopv?ssl=true&replicaSet=atlas-57abev-shard-0&authSource=admin&retryWrites=true&w=majority";

// Local file-backed fallback store so auth NEVER fails or hangs if MongoDB Atlas is firewalled
const USERS_FILE = path.join(__dirname, "users.json");
let localUsers = [];

function loadLocalUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      localUsers = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
    }
  } catch (e) {
    localUsers = [];
  }
}
function saveLocalUsers() {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(localUsers, null, 2), "utf8");
  } catch (e) {
    console.warn("Failed to save local users cache:", e.message);
  }
}
loadLocalUsers();

let isMongoConnected = false;
let mongoLastError = null;
let mongoConnectionMethod = "none";

// Prevent Mongoose from buffering queries in memory during reconnects
mongoose.set("bufferCommands", false);

// MongoDB Mongoose Schemas & Models
const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  profileImage: { type: String, default: "" },
  savedLocation: {
    lat: { type: Number, default: 12.8398 },
    lon: { type: Number, default: 77.5815 },
    displayLocation: { type: String, default: "RHM7+RH8, Bilwaradahalli, Karnataka (Bengaluru region)" },
    updatedAt: { type: Date, default: Date.now }
  },
  savedSettings: {
    capacityKwp: { type: Number, default: 36.60 },
    tilt: { type: Number, default: 15 },
    azimuth: { type: Number, default: 180 },
    tariff: { type: Number, default: 7.50 },
    panelModel: { type: String, default: "Mono PERC 550W (Tier-1)" },
    inverterModel: { type: String, default: "SolarEdge String Inverter (98.5% Eff)" }
  }
}, { timestamps: true });

const User = mongoose.model("User", userSchema);

const pushSubscriptionSchema = new mongoose.Schema({
  endpoint: { type: String, required: true, unique: true },
  keys: {
    p256dh: { type: String },
    auth: { type: String }
  },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  userEmail: { type: String, default: null },
  createdAt: { type: Date, default: Date.now }
});

const PushSubscription = mongoose.model("PushSubscription", pushSubscriptionSchema);

// Auto-sync local fallback users to MongoDB Atlas when connection is online
async function syncLocalUsersToAtlas() {
  if (!isMongoConnected || !localUsers || localUsers.length === 0) return;
  try {
    for (const u of localUsers) {
      const existing = await User.findOne({ email: u.email }).catch(() => null);
      if (!existing) {
        const nu = new User({
          _id: (u.id && u.id.length === 24) ? new mongoose.Types.ObjectId(u.id) : undefined,
          name: u.name,
          email: u.email,
          passwordHash: u.passwordHash,
          profileImage: u.profileImage,
          savedLocation: u.savedLocation,
          savedSettings: u.savedSettings,
          createdAt: u.createdAt || new Date()
        });
        await nu.save().catch(() => {});
        console.log(`[MongoDB Atlas] Auto-synced user account (${u.email}) from local cache to cloud database!`);
      }
    }
  } catch (e) {
    console.warn("[MongoDB Atlas] Error syncing local users to Atlas:", e.message);
  }
}

// Connect to MongoDB Atlas with automatic SRV -> Direct Replica Set failover
async function connectToMongo() {
  const options = {
    serverSelectionTimeoutMS: 4000,
    connectTimeoutMS: 5000,
    socketTimeoutMS: 20000,
    bufferCommands: false
  };

  try {
    console.log("[MongoDB Atlas] Attempting SRV connection...");
    await mongoose.connect(ATLAS_SRV_URI, options);
    isMongoConnected = true;
    mongoLastError = null;
    mongoConnectionMethod = "srv";
    console.log("[MongoDB Atlas] Connected successfully via SRV URI!");
    await syncLocalUsersToAtlas();
    return;
  } catch (err) {
    console.warn("[MongoDB Atlas] SRV connection attempt timed out or failed:", err.message);
    mongoLastError = err.message;
  }

  // Attempt direct replica set connection
  try {
    console.log("[MongoDB Atlas] Retrying with Direct Replica Set URI...");
    await mongoose.connect(ATLAS_DIRECT_URI, options);
    isMongoConnected = true;
    mongoLastError = null;
    mongoConnectionMethod = "direct";
    console.log("[MongoDB Atlas] Connected successfully via Direct Replica Set URI!");
    await syncLocalUsersToAtlas();
    return;
  } catch (err2) {
    console.error("[MongoDB Atlas] Direct connection failed:", err2.message);
    mongoLastError = err2.message;
    isMongoConnected = false;
    console.warn("[MongoDB Atlas] Operating in resilient file-backed mode (users.json). If deployed on Render, please ensure 0.0.0.0/0 is added in MongoDB Atlas Network Access!");
  }
}

mongoose.connection.on("connected", () => {
  isMongoConnected = true;
  mongoLastError = null;
  syncLocalUsersToAtlas();
});

mongoose.connection.on("disconnected", () => {
  isMongoConnected = false;
});

mongoose.connection.on("error", (err) => {
  isMongoConnected = false;
  mongoLastError = err.message;
});

connectToMongo();

// Helper wrapper for local file-backed user items to maintain uniform API with Mongoose documents
function createLocalUserWrapper(u) {
  if (!u.id) {
    u.id = new mongoose.Types.ObjectId().toString();
  }
  return {
    _id: u.id,
    id: u.id,
    name: u.name,
    email: u.email,
    passwordHash: u.passwordHash,
    profileImage: u.profileImage || "",
    savedLocation: u.savedLocation || {
      lat: 12.8398,
      lon: 77.5815,
      displayLocation: "RHM7+RH8, Bilwaradahalli, Karnataka (Bengaluru region)",
      updatedAt: new Date()
    },
    savedSettings: u.savedSettings || {
      capacityKwp: 36.60,
      tilt: 15,
      azimuth: 180,
      tariff: 7.50,
      panelModel: "Mono PERC 550W (Tier-1)",
      inverterModel: "SolarEdge String Inverter (98.5% Eff)"
    },
    createdAt: u.createdAt || new Date(),
    save: async function() {
      const idx = localUsers.findIndex((x) => x.id === this.id || x.email === this.email);
      const data = {
        id: this.id,
        name: this.name,
        email: this.email,
        passwordHash: this.passwordHash,
        profileImage: this.profileImage,
        savedLocation: this.savedLocation,
        savedSettings: this.savedSettings,
        createdAt: this.createdAt,
        updatedAt: new Date()
      };
      if (idx >= 0) {
        localUsers[idx] = data;
      } else {
        localUsers.push(data);
      }
      saveLocalUsers();

      if (isMongoConnected) {
        try {
          await User.findOneAndUpdate(
            { email: this.email },
            {
              name: this.name,
              passwordHash: this.passwordHash,
              profileImage: this.profileImage,
              savedLocation: this.savedLocation,
              savedSettings: this.savedSettings
            },
            { upsert: true }
          );
        } catch (e) {}
      }
      return this;
    }
  };
}

// Helper to enforce strict database operation timeouts so requests NEVER hang indefinitely
function withDbTimeout(promise, ms = 3000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Database operation timed out")), ms))
  ]);
}

// Unified Database Access Functions (Fast, Resilient, Zero Buffer Hangs)
async function dbFindUserByEmail(email) {
  const normalized = email.trim().toLowerCase();
  if (isMongoConnected && mongoose.connection.readyState === 1) {
    try {
      const user = await withDbTimeout(User.findOne({ email: normalized }), 3500);
      if (user) return user;
    } catch (e) {
      console.warn("[DB] Mongo findOne error/timeout, falling back to local:", e.message);
    }
  }
  const local = localUsers.find((u) => u.email.toLowerCase() === normalized);
  if (!local) return null;
  return createLocalUserWrapper(local);
}

async function dbFindUserById(id) {
  if (isMongoConnected && mongoose.connection.readyState === 1) {
    try {
      if (mongoose.Types.ObjectId.isValid(id)) {
        const user = await withDbTimeout(User.findById(id), 3500);
        if (user) return user;
      }
    } catch (e) {
      console.warn("[DB] Mongo findById error/timeout, falling back to local:", e.message);
    }
  }
  const local = localUsers.find((u) => u.id === id || (u._id && u._id.toString() === id));
  if (!local) return null;
  return createLocalUserWrapper(local);
}

async function dbCreateUser({ name, email, passwordHash, profileImage, savedLocation }) {
  const newId = new mongoose.Types.ObjectId().toString();
  const localData = {
    id: newId,
    name,
    email,
    passwordHash,
    profileImage,
    savedLocation,
    savedSettings: {
      capacityKwp: 36.60,
      tilt: 15,
      azimuth: 180,
      tariff: 7.50,
      panelModel: "Mono PERC 550W (Tier-1)",
      inverterModel: "SolarEdge String Inverter (98.5% Eff)"
    },
    createdAt: new Date()
  };

  localUsers.push(localData);
  saveLocalUsers();

  if (isMongoConnected && mongoose.connection.readyState === 1) {
    try {
      const mongoUser = new User({
        _id: new mongoose.Types.ObjectId(newId),
        name,
        email,
        passwordHash,
        profileImage,
        savedLocation,
        savedSettings: localData.savedSettings
      });
      await withDbTimeout(mongoUser.save(), 4000);
      return mongoUser;
    } catch (e) {
      console.warn("[DB] Could not save user directly to Mongo:", e.message);
    }
  }

  return createLocalUserWrapper(localData);
}

// JWT Secret Key
const JWT_SECRET = process.env.JWT_SECRET || "heliopv_jwt_secret_secure_key_2026_solar_iot";

// Middleware to authenticate JWT - Resilient & never kicks logged-in users out
async function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).json({ error: "Authentication token required" });
  }

  jwt.verify(token, JWT_SECRET, async (err, decoded) => {
    if (err) {
      return res.status(401).json({ error: "Session expired or invalid token" });
    }
    try {
      let user = await dbFindUserById(decoded.id);
      if (!user) {
        // Fallback: If MongoDB or local store is recovering or syncing,
        // trust the cryptographically signed JWT payload so the session NEVER drops
        user = createLocalUserWrapper({
          id: decoded.id,
          email: decoded.email,
          name: decoded.name || "Solar User"
        });
      }
      req.user = user;
      next();
    } catch (e) {
      req.user = createLocalUserWrapper({
        id: decoded.id,
        email: decoded.email,
        name: decoded.name || "Solar User"
      });
      next();
    }
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

// Broadcast push notification to all subscribed mobile & desktop devices (or account devices)
async function sendPushNotification(payload, targetEmail = null) {
  try {
    let allSubs = [...pushSubscriptions];
    try {
      const mongoSubs = await PushSubscription.find({});
      mongoSubs.forEach((ms) => {
        if (!allSubs.some((s) => s.endpoint === ms.endpoint)) {
          allSubs.push({ endpoint: ms.endpoint, keys: ms.keys, userEmail: ms.userEmail });
        }
      });
    } catch (e) {}

    // If targetEmail is specified, filter to devices for that account, but fallback to all if none matched
    let targetSubs = allSubs;
    if (targetEmail) {
      const userSubs = allSubs.filter((s) => s.userEmail && s.userEmail.toLowerCase() === targetEmail.toLowerCase());
      if (userSubs.length > 0) {
        targetSubs = userSubs;
      }
    }

    if (!targetSubs || targetSubs.length === 0) {
      console.log(`[Push Notification] No active subscribers. Notification queued in logs: ${payload.title}`);
      return;
    }

    console.log(`[Push Notification] Broadcasting to ${targetSubs.length} device(s)${targetEmail ? ` for account: ${targetEmail}` : ""}: ${payload.title}`);
    const payloadString = JSON.stringify(payload);

    for (const sub of targetSubs) {
      try {
        await webpush.sendNotification(sub, payloadString);
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          console.log(`[Push Notification] Expired subscription removed.`);
          PushSubscription.deleteOne({ endpoint: sub.endpoint }).catch(() => {});
          pushSubscriptions = pushSubscriptions.filter((s) => s.endpoint !== sub.endpoint);
          saveSubscriptions();
        } else {
          console.error(`[Push Notification] Delivery issue:`, err.message);
        }
      }
    }
  } catch (e) {
    console.error("sendPushNotification exception:", e.message);
  }
}

// Enable CORS for all origins (localhost, 127.0.0.1, mobile, file://, etc.)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Serve static project files directly (HTML, JS, CSS, images) with cache invalidation for scripts & styles
app.use(express.static(path.join(__dirname, "."), {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

const NODE_TIMEOUT_MS = 10000;    // 10 seconds margin for stale detection
const GATEWAY_TIMEOUT_MS = 7000;  // Exactly 7 seconds delay before declaring ESP32 offline
const LOW_VOLTAGE_MV = 500;       // Threshold in mV

const NODE_TYPE_NAME = { 0: "panel_basic", 1: "panel_full", 2: "string" };

let latest = {
  nodes: [],
  receivedAt: 0,
  isSimulated: false,
  simulationScenario: "normal"
};
// History of last 2 polled ESP32 packets for 2-consecutive-poll fault confirmation
let packetHistory = [];
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

app.get("/login", (req, res) => {
  res.redirect("/?auth=login");
});

app.get("/signup", (req, res) => {
  res.redirect("/?auth=signup");
});

app.get("/register", (req, res) => {
  res.redirect("/?auth=signup");
});

app.get("/dashboard", (req, res) => {
  res.redirect("/?view=monitor");
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

// Database diagnostics & health status endpoint
app.get("/api/db-status", (req, res) => {
  res.json({
    mongoConnected: isMongoConnected,
    connectionMethod: mongoConnectionMethod,
    readyState: mongoose.connection.readyState,
    readyStateDesc: ["disconnected", "connected", "connecting", "disconnecting"][mongoose.connection.readyState] || "unknown",
    lastError: mongoLastError,
    totalLocalUsers: localUsers.length,
    platform: process.platform,
    atlasHelp: isMongoConnected ? "Connected to MongoDB Atlas!" : "To allow Render to connect to MongoDB Atlas: Go to MongoDB Atlas (cloud.mongodb.com) -> Security -> Network Access -> '+ Add IP Address' -> Select 'Allow Access from Anywhere' (0.0.0.0/0) -> Confirm."
  });
});

// Reset all users (Fresh slate)
app.post("/api/auth/fresh-slate", async (req, res) => {
  try {
    localUsers = [];
    saveLocalUsers();
    if (isMongoConnected) {
      await User.deleteMany({});
    }
    res.json({ success: true, message: "All user accounts cleared for a fresh start." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// AUTHENTICATION API ENDPOINTS (JWT + BCRYPT)
// ─────────────────────────────────────────────────────────────

// Register a new user in MongoDB / Resilient Local Store
app.post("/api/auth/signup", async (req, res) => {
  try {
    const { name, email, password, profileImage, location } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ error: "Full name, email, and password are required" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const existingUser = await dbFindUserByEmail(normalizedEmail);
    if (existingUser) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const defaultAvatar = `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(name.trim())}&backgroundColor=0f356b,0a254a`;

    const initialLocation = location && location.lat && location.lon ? {
      lat: Number(location.lat) || 12.8398,
      lon: Number(location.lon) || 77.5815,
      displayLocation: location.displayLocation || "RHM7+RH8, Bilwaradahalli, Karnataka (Bengaluru region)",
      updatedAt: new Date()
    } : {
      lat: 12.8398,
      lon: 77.5815,
      displayLocation: "RHM7+RH8, Bilwaradahalli, Karnataka (Bengaluru region)",
      updatedAt: new Date()
    };

    const newUser = await dbCreateUser({
      name: name.trim(),
      email: normalizedEmail,
      passwordHash,
      profileImage: profileImage || defaultAvatar,
      savedLocation: initialLocation
    });

    const userIdStr = (newUser._id || newUser.id).toString();
    console.log(`[Auth] New user registered: ${newUser.email} (${newUser.name})`);

    const token = jwt.sign(
      { id: userIdStr, email: newUser.email, name: newUser.name },
      JWT_SECRET,
      { expiresIn: "3650d" }
    );

    res.status(201).json({
      message: "Account registered successfully",
      token,
      user: {
        id: userIdStr,
        name: newUser.name,
        email: newUser.email,
        profileImage: newUser.profileImage,
        savedLocation: newUser.savedLocation,
        savedSettings: newUser.savedSettings
      }
    });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ error: "Internal server error during registration: " + err.message });
  }
});

// Log in an existing user from MongoDB / Resilient Local Store
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await dbFindUserByEmail(normalizedEmail);
    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const userIdStr = (user._id || user.id).toString();
    const token = jwt.sign(
      { id: userIdStr, email: user.email, name: user.name },
      JWT_SECRET,
      { expiresIn: "3650d" }
    );

    console.log(`[Auth] User logged in: ${user.email} (Location: ${user.savedLocation?.displayLocation})`);

    res.json({
      message: "Login successful",
      token,
      user: {
        id: userIdStr,
        name: user.name,
        email: user.email,
        profileImage: user.profileImage,
        savedLocation: user.savedLocation,
        savedSettings: user.savedSettings
      }
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Internal server error during login: " + err.message });
  }
});

// Get current user profile and saved location preferences
app.get("/api/auth/me", authenticateToken, (req, res) => {
  const userIdStr = (req.user._id || req.user.id).toString();
  res.json({
    user: {
      id: userIdStr,
      name: req.user.name,
      email: req.user.email,
      profileImage: req.user.profileImage,
      savedLocation: req.user.savedLocation,
      savedSettings: req.user.savedSettings,
      createdAt: req.user.createdAt
    }
  });
});

// Save / update chosen location preference for the user
const handleSaveLocation = async (req, res) => {
  try {
    const { lat, lon, displayLocation } = req.body || {};
    if (typeof lat !== "number" && typeof lat !== "string") {
      return res.status(400).json({ error: "Latitude is required" });
    }
    if (typeof lon !== "number" && typeof lon !== "string") {
      return res.status(400).json({ error: "Longitude is required" });
    }

    const parsedLat = Number(lat);
    const parsedLon = Number(lon);
    if (isNaN(parsedLat) || isNaN(parsedLon)) {
      return res.status(400).json({ error: "Valid numeric latitude and longitude are required" });
    }

    const currentLoc = req.user.savedLocation || {};
    req.user.savedLocation = {
      lat: Math.round(parsedLat * 10000) / 10000,
      lon: Math.round(parsedLon * 10000) / 10000,
      displayLocation: (displayLocation && String(displayLocation).trim()) || currentLoc.displayLocation || `Site Location (${parsedLat}°N, ${parsedLon}°E)`,
      updatedAt: new Date()
    };

    await req.user.save();
    console.log(`[MongoDB] Saved location for user ${req.user.email}: ${req.user.savedLocation.displayLocation} (${req.user.savedLocation.lat}, ${req.user.savedLocation.lon})`);

    res.json({
      message: "Location preference saved successfully",
      savedLocation: req.user.savedLocation
    });
  } catch (err) {
    console.error("Save location error:", err);
    res.status(500).json({ error: "Failed to save location preference: " + err.message });
  }
};

app.post("/api/auth/location", authenticateToken, handleSaveLocation);
app.put("/api/auth/location", authenticateToken, handleSaveLocation);

// Save / update project settings for the user
app.post("/api/auth/settings", authenticateToken, async (req, res) => {
  try {
    const { capacityKwp, tilt, azimuth, tariff, panelModel, inverterModel } = req.body || {};
    if (!req.user.savedSettings) req.user.savedSettings = {};

    if (capacityKwp) req.user.savedSettings.capacityKwp = Number(capacityKwp);
    if (tilt !== undefined) req.user.savedSettings.tilt = Number(tilt);
    if (azimuth !== undefined) req.user.savedSettings.azimuth = Number(azimuth);
    if (tariff !== undefined) req.user.savedSettings.tariff = Number(tariff);
    if (panelModel) req.user.savedSettings.panelModel = panelModel;
    if (inverterModel) req.user.savedSettings.inverterModel = inverterModel;

    await req.user.save();
    res.json({
      message: "Project settings saved successfully",
      savedSettings: req.user.savedSettings
    });
  } catch (err) {
    console.error("Save settings error:", err);
    res.status(500).json({ error: "Failed to save settings: " + err.message });
  }
});

// Change user password in MongoDB
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
    await req.user.save();

    res.json({ message: "Password updated successfully" });
  } catch (err) {
    console.error("Change password error:", err);
    res.status(500).json({ error: "Internal server error updating password: " + err.message });
  }
});

// Update user profile (Name, Profile Image) in MongoDB
app.post("/api/auth/update-profile", authenticateToken, async (req, res) => {
  try {
    const { name, profileImage } = req.body || {};
    if (name && name.trim()) {
      req.user.name = name.trim();
    }
    if (profileImage) {
      req.user.profileImage = profileImage;
    }
    await req.user.save();

    const token = jwt.sign(
      { id: req.user._id.toString(), email: req.user.email, name: req.user.name },
      JWT_SECRET,
      { expiresIn: "3650d" }
    );

    res.json({
      message: "Profile updated successfully",
      token,
      user: {
        id: req.user._id.toString(),
        name: req.user.name,
        email: req.user.email,
        profileImage: req.user.profileImage,
        savedLocation: req.user.savedLocation,
        savedSettings: req.user.savedSettings
      }
    });
  } catch (err) {
    console.error("Update profile error:", err);
    res.status(500).json({ error: "Internal server error updating profile: " + err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// WEB PUSH NOTIFICATION API ENDPOINTS
// ─────────────────────────────────────────────────────────────

// Return VAPID Public Key for client browser subscription
app.get("/api/vapid-public-key", (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// Subscribe client device to push alerts in MongoDB & local cache
app.post("/api/push-subscribe", async (req, res) => {
  try {
    const subscription = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: "Invalid subscription payload" });
    }

    let userEmail = subscription.userEmail || null;
    let userId = subscription.userId || null;

    if (req.headers.authorization && req.headers.authorization.startsWith("Bearer ")) {
      try {
        const token = req.headers.authorization.split(" ")[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded) {
          if (!userId) userId = decoded.userId;
          if (!userEmail) userEmail = decoded.email;
        }
      } catch (e) {}
    }

    // Upsert into MongoDB
    await PushSubscription.findOneAndUpdate(
      { endpoint: subscription.endpoint },
      {
        endpoint: subscription.endpoint,
        keys: subscription.keys,
        userEmail: userEmail,
        userId: userId,
        createdAt: new Date()
      },
      { upsert: true, new: true }
    ).catch(() => {});

    const subItem = {
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      userEmail: userEmail,
      userId: userId
    };

    const idx = pushSubscriptions.findIndex((s) => s.endpoint === subscription.endpoint);
    if (idx >= 0) {
      pushSubscriptions[idx] = subItem;
    } else {
      pushSubscriptions.push(subItem);
    }
    saveSubscriptions();

    const count = await PushSubscription.countDocuments().catch(() => pushSubscriptions.length);
    console.log(`[Push Notification] Device subscribed (Account: ${userEmail || "anonymous"})! Total active devices: ${count}`);
    res.status(201).json({ success: true, count });
  } catch (err) {
    console.error("Push subscribe error:", err.message);
    res.status(500).json({ error: "Could not save push subscription" });
  }
});

// Unsubscribe client device
app.post("/api/push-unsubscribe", async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (endpoint) {
      await PushSubscription.deleteOne({ endpoint }).catch(() => {});
      pushSubscriptions = pushSubscriptions.filter((s) => s.endpoint !== endpoint);
      saveSubscriptions();
    }
    const count = await PushSubscription.countDocuments().catch(() => pushSubscriptions.length);
    res.json({ success: true, count });
  } catch (err) {
    res.status(500).json({ error: "Could not remove subscription" });
  }
});

// Active pending test alert state (for cross-device synchronization between laptop and mobile)
let pendingTestAlert = null;

// Immediate test push notification endpoint (test while app/tab is closed)
app.post("/api/push-test", async (req, res) => {
  const { title, body, testId, userEmail, userId } = req.body || {};
  const alertTitle = title || "⚠️ Solar String Fault Detected! (Test Alert)";
  const alertBody = body || "Wire break simulation at Node 2: Open circuit detected.";

  let callerEmail = userEmail || null;
  let callerUserId = userId || null;

  if (req.headers.authorization && req.headers.authorization.startsWith("Bearer ")) {
    try {
      const token = req.headers.authorization.split(" ")[1];
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded) {
        if (!callerUserId) callerUserId = decoded.userId;
        if (!callerEmail) callerEmail = decoded.email;
      }
    } catch (e) {}
  }

  pendingTestAlert = {
    id: testId || Date.now(),
    title: alertTitle,
    body: alertBody,
    userEmail: callerEmail,
    userId: callerUserId,
    timestamp: Date.now()
  };

  console.log(`[Push Notification] Test alert dispatched for account: ${callerEmail || "All devices"}`);

  await sendPushNotification({
    title: alertTitle,
    body: alertBody,
    icon: "https://cdn-icons-png.flaticon.com/512/564/564619.png",
    badge: "https://cdn-icons-png.flaticon.com/512/564/564619.png",
    vibrate: [250, 100, 250, 100, 250],
    url: "/?view=monitor"
  }, callerEmail);

  res.json({ success: true, count: pushSubscriptions.length, pendingAlert: pendingTestAlert });
});

// Broadcast client-triggered or hardware-detected fault to all push subscribers
app.post("/api/push-fault", async (req, res) => {
  const { title, body, faultNodeId, faultDescription } = req.body || {};
  const alertTitle = title || "🚨 Solar String Fault Detected!";
  const alertBody = body || (faultDescription ? `Break at Node ${faultNodeId}: ${faultDescription}` : "Solar PV circuit disconnection detected.");

  console.log(`[Push Notification] Broadcasting fault alert: ${alertTitle} - ${alertBody}`);
  await sendPushNotification({
    title: alertTitle,
    body: alertBody,
    icon: "https://cdn-icons-png.flaticon.com/512/564/564619.png",
    badge: "https://cdn-icons-png.flaticon.com/512/564/564619.png",
    vibrate: [300, 150, 300, 150, 300],
    url: "/?view=monitor"
  });
  res.json({ success: true, count: pushSubscriptions.length });
});

// Helper: Compute fault state consistently across endpoints
let lastFaultKey = null;

function getNodeLabel(id) {
  switch (id) {
    case 1:  return "STRING 1 - PANEL 1";
    case 2:  return "STRING 1 - PANEL 2";
    case 3:  return "STRING 1 - PANEL 3";
    case 4:  return "STRING 1 - MASTER";
    case 5:  return "STRING 2 - PANEL 1";
    case 6:  return "STRING 2 - PANEL 2";
    case 7:  return "STRING 2 - PANEL 3";
    case 8:  return "STRING 2 - MASTER";
    default: return `NODE ${id}`;
  }
}

function isNodeBroken(id, gatewayAge) {
  if (latest.isSimulated) {
    const n = latest.nodes.find((x) => (x.id === id || x.node_id === id));
    if (!n) return false;
    const age = (n.ageMs || 0) + gatewayAge;
    if (age > NODE_TIMEOUT_MS) return false;
    return (n.continuity === false || n.continuity === "false" || n.continuity === 0);
  }

  if (packetHistory.length >= 2) {
    const prevPacket = packetHistory[packetHistory.length - 2];
    const currPacket = packetHistory[packetHistory.length - 1];

    const prevNode = prevPacket.find((x) => (x.id === id || x.node_id === id));
    const currNode = currPacket.find((x) => (x.id === id || x.node_id === id));

    if (prevNode && currNode) {
      const prevBroken = (prevNode.continuity === false || prevNode.continuity === "false" || prevNode.continuity === 0);
      const currBroken = (currNode.continuity === false || currNode.continuity === "false" || currNode.continuity === 0);
      return prevBroken && currBroken;
    }
  } else if (packetHistory.length === 1) {
    const currNode = packetHistory[0].find((x) => (x.id === id || x.node_id === id));
    if (currNode) {
      return (currNode.continuity === false || currNode.continuity === "false" || currNode.continuity === 0);
    }
  }
  return false;
}

// Evaluate diagnostic truth table for a 3-panel + string-monitor branch
function evaluateStringDiagnostic(stringNum, cAId, cBId, cCId, gatewayAge) {
  const pA = (stringNum === 1) ? "Panel 1" : "Panel 4";
  const pB = (stringNum === 1) ? "Panel 2" : "Panel 5";
  const pC = (stringNum === 1) ? "Panel 3" : "Panel 6";
  const strName = (stringNum === 1) ? "String Monitor 1" : "String Monitor 2";
  const strLabel = `String ${stringNum}`;

  const cABroken = isNodeBroken(cAId, gatewayAge);
  const cBBroken = isNodeBroken(cBId, gatewayAge);
  const cCBroken = isNodeBroken(cCId, gatewayAge);

  const wP1P2Pwr   = (stringNum === 1) ? "W_S1_P1_P2_PWR"   : "W_S2_P4_P5_PWR";
  const wP1P2Sense = (stringNum === 1) ? "W_S1_P1_P2_SENSE" : "W_S2_P4_P5_SENSE";
  const wP2P3Pwr   = (stringNum === 1) ? "W_S1_P2_P3_PWR"   : "W_S2_P5_P6_PWR";
  const wP2P3Sense = (stringNum === 1) ? "W_S1_P2_P3_SENSE" : "W_S2_P5_P6_SENSE";
  const wP3StrPwr  = (stringNum === 1) ? "W_S1_P3_STR_PWR"  : "W_S2_P6_STR_PWR";
  const wStrGnd    = (stringNum === 1) ? "W_S1_STRING_GND"  : "W_S2_STRING_GND";

  // Case 1: Ca = Broken, but Cb = OK -> Power (+) wire broken between Panel 1 & 2
  if (cABroken && !cBBroken) {
    return {
      hasFault: true,
      faultNodeId: cAId,
      rootFaultNodeId: cAId,
      faultType: "power",
      brokenWireId: wP1P2Pwr,
      description: `${strLabel}: Power (+) wire broken between ${pA} and ${pB}`,
      wireStates: {
        [wP1P2Pwr]: "open",
        [wP1P2Sense]: "closed",
        [wP2P3Pwr]: "closed",
        [wP2P3Sense]: "closed",
        [wP3StrPwr]: cCBroken ? "open" : "closed",
        [wStrGnd]: "closed"
      },
      cellStates: {
        [cAId - 1]: "ok",
        [cAId]: "broken",
        [cBId]: "ok",
        [cCId]: cCBroken ? "broken" : "ok"
      }
    };
  }

  // Case 2: Ca = Broken AND Cb = Broken -> Sense GND broken between Panel 1 & 2
  if (cABroken && cBBroken) {
    return {
      hasFault: true,
      faultNodeId: cAId,
      rootFaultNodeId: cAId,
      faultType: "sense_gnd",
      brokenWireId: wP1P2Sense,
      description: `${strLabel}: Sense GND broken between ${pA} and ${pB}`,
      wireStates: {
        [wP1P2Pwr]: "closed",
        [wP1P2Sense]: "open",
        [wP2P3Pwr]: "gray_zone",
        [wP2P3Sense]: "gray_zone",
        [wP3StrPwr]: "gray_zone",
        [wStrGnd]: "gray_zone"
      },
      cellStates: {
        [cAId - 1]: "ok",
        [cAId]: "broken",
        [cBId]: "gray_zone",
        [cCId]: "gray_zone"
      }
    };
  }

  // Case 3: Ca = OK, Cb = Broken, but Cc = OK -> Power (+) wire broken between Panel 2 & 3
  if (!cABroken && cBBroken && !cCBroken) {
    return {
      hasFault: true,
      faultNodeId: cBId,
      rootFaultNodeId: cBId,
      faultType: "power",
      brokenWireId: wP2P3Pwr,
      description: `${strLabel}: Power (+) wire broken between ${pB} and ${pC}`,
      wireStates: {
        [wP1P2Pwr]: "closed",
        [wP1P2Sense]: "closed",
        [wP2P3Pwr]: "open",
        [wP2P3Sense]: "closed",
        [wP3StrPwr]: "closed",
        [wStrGnd]: "closed"
      },
      cellStates: {
        [cAId - 1]: "ok",
        [cAId]: "ok",
        [cBId]: "broken",
        [cCId]: "ok"
      }
    };
  }

  // Case 4: Ca = OK, Cb = Broken, AND Cc = Broken -> Sense GND broken between Panel 2 & 3
  if (!cABroken && cBBroken && cCBroken) {
    return {
      hasFault: true,
      faultNodeId: cBId,
      rootFaultNodeId: cBId,
      faultType: "sense_gnd",
      brokenWireId: wP2P3Sense,
      description: `${strLabel}: Sense GND broken between ${pB} and ${pC}`,
      wireStates: {
        [wP1P2Pwr]: "closed",
        [wP1P2Sense]: "closed",
        [wP2P3Pwr]: "closed",
        [wP2P3Sense]: "open",
        [wP3StrPwr]: "gray_zone",
        [wStrGnd]: "gray_zone"
      },
      cellStates: {
        [cAId - 1]: "ok",
        [cAId]: "ok",
        [cBId]: "broken",
        [cCId]: "gray_zone"
      }
    };
  }

  // Case 5: Ca = OK, Cb = OK, but Cc = Broken -> Terminal break between Panel 3 & String Monitor
  if (!cABroken && !cBBroken && cCBroken) {
    return {
      hasFault: true,
      faultNodeId: cCId,
      rootFaultNodeId: cCId,
      faultType: "terminal",
      brokenWireId: `${wP3StrPwr}, ${wStrGnd}`,
      description: `${strLabel}: Terminal break between ${pC} and ${strName} (BOTH Power (+) and STRING GND disconnected)`,
      wireStates: {
        [wP1P2Pwr]: "closed",
        [wP1P2Sense]: "closed",
        [wP2P3Pwr]: "closed",
        [wP2P3Sense]: "closed",
        [wP3StrPwr]: "open",
        [wStrGnd]: "open"
      },
      cellStates: {
        [cAId - 1]: "ok",
        [cAId]: "ok",
        [cBId]: "ok",
        [cCId]: "broken"
      }
    };
  }

  // Case 6: All intact
  return {
    hasFault: false,
    faultNodeId: null,
    rootFaultNodeId: null,
    faultType: "none",
    brokenWireId: null,
    description: null,
    wireStates: {
      [wP1P2Pwr]: "closed",
      [wP1P2Sense]: "closed",
      [wP2P3Pwr]: "closed",
      [wP2P3Sense]: "closed",
      [wP3StrPwr]: "closed",
      [wStrGnd]: "closed"
    },
    cellStates: {
      [cAId - 1]: "ok",
      [cAId]: "ok",
      [cBId]: "ok",
      [cCId]: "ok"
    }
  };
}

function computeFaultState() {
  const gatewayAge = Date.now() - latest.receivedAt;
  const gatewayOnline = latest.receivedAt !== 0 && gatewayAge < GATEWAY_TIMEOUT_MS;

  if (!gatewayOnline) {
    return {
      gatewayAge,
      gatewayOnline: false,
      faultNodeId: null,
      faultDescription: null,
      brokenWireId: null,
      faultType: "none",
      string1Fault: { hasFault: false },
      string2Fault: { hasFault: false },
      faults: []
    };
  }

  const s1Diag = evaluateStringDiagnostic(1, 2, 3, 4, gatewayAge);
  const s2Diag = evaluateStringDiagnostic(2, 6, 7, 8, gatewayAge);

  const faults = [];
  if (s1Diag.hasFault) faults.push(s1Diag);
  if (s2Diag.hasFault) faults.push(s2Diag);

  let faultNodeId = null;
  let faultDescription = null;
  let brokenWireId = null;
  let faultType = "none";

  if (faults.length > 0) {
    faultNodeId = faults[0].rootFaultNodeId;
    brokenWireId = faults.map(f => f.brokenWireId).filter(Boolean).join("; ");
    faultType = faults[0].faultType;
    faultDescription = faults.map(f => f.description).join(" | ");
  }

  return {
    gatewayAge,
    gatewayOnline,
    faultNodeId,
    faultDescription,
    brokenWireId,
    faultType,
    string1Fault: s1Diag,
    string2Fault: s2Diag,
    faults
  };
}

function checkFaultAndNotify() {
  const { gatewayOnline, faultNodeId, faultDescription } = computeFaultState();
  const currentFaultKey = faultDescription || null;

  if (currentFaultKey && currentFaultKey !== lastFaultKey) {
    console.log(`[ALERT] 🚨 Solar 3S2P Array Fault at Node ${faultNodeId}! Triggering Native Push...`);
    sendPushNotification({
      title: "🚨 Solar 3S2P Array Fault Detected!",
      body: `CRITICAL ALERT: ${faultDescription}`,
      icon: "https://cdn-icons-png.flaticon.com/512/564/564619.png",
      badge: "https://cdn-icons-png.flaticon.com/512/564/564619.png",
      vibrate: [300, 150, 300, 150, 300],
      url: "/?view=monitor"
    });
    lastFaultKey = currentFaultKey;
  } else if (!currentFaultKey && lastFaultKey !== null) {
    if (gatewayOnline) {
      console.log(`[ALERT] ✅ Solar Array Fault Cleared! Triggering Recovery Push...`);
      sendPushNotification({
        title: "✅ Solar 3S2P Array Restored",
        body: "All series strings and panel connections are intact.",
        icon: "https://cdn-icons-png.flaticon.com/512/190/190411.png",
        badge: "https://cdn-icons-png.flaticon.com/512/190/190411.png",
        vibrate: [100, 50, 100],
        url: "/?view=monitor"
      });
      lastFaultKey = null;
    }
  }
}

// ==========================================================================
// ML Solar Forecasting Microservice Integration (FastAPI / LightGBM / RF)
// ==========================================================================
const ML_SERVICE_URL = process.env.ML_API_URL || "https://solar-ml-api-z414.onrender.com";

// Health check for ML Microservice
app.get("/api/ml/health", async (req, res) => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const r = await fetch(`${ML_SERVICE_URL}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    res.json({ online: true, serviceUrl: ML_SERVICE_URL, ...data });
  } catch (err) {
    res.json({ online: false, serviceUrl: ML_SERVICE_URL, error: err.message });
  }
});

// Proxy prediction request to ML Microservice with graceful fallback to PVsyst engine
app.get("/api/ml/predict", async (req, res) => {
  const lat = parseFloat(req.query.lat) || 12.8342;
  const lon = parseFloat(req.query.lon) || 77.5891;
  const kw = parseFloat(req.query.kw) || 36.60;
  const monthly = req.query.monthly !== "false";

  // Check distance to Bengaluru center (12.9716, 77.5946)
  const dLat = (lat - 12.9716) * 111.0;
  const dLon = (lon - 77.5946) * 111.0 * Math.cos(12.9716 * Math.PI / 180);
  const distKm = Math.sqrt(dLat * dLat + dLon * dLon);

  // If outside ML model training boundary (> 25 km), report fallback
  if (distKm > 25.0) {
    return res.json({
      success: false,
      isFallback: true,
      reason: `Site is ${Math.round(distKm)} km from Bengaluru centre. ML ensemble is trained within 25 km radius; using Universal PVsyst engine.`
    });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000); // 8s timeout
    const url = `${ML_SERVICE_URL}/predict?lat=${lat}&lon=${lon}&kw=${kw}&monthly=${monthly}`;

    let mlRes = null;
    try {
      mlRes = await fetch(url, { signal: controller.signal });
    } catch (netErr) {
      // Local fallback for offline / lab testing
      const localUrl = `http://127.0.0.1:8000/predict?lat=${lat}&lon=${lon}&kw=${kw}&monthly=${monthly}`;
      const localCtrl = new AbortController();
      const localTimeout = setTimeout(() => localCtrl.abort(), 2000);
      try {
        mlRes = await fetch(localUrl, { signal: localCtrl.signal });
      } catch (localErr) {}
      clearTimeout(localTimeout);
    }
    clearTimeout(timeout);

    if (mlRes && mlRes.ok) {
      const data = await mlRes.json();
      return res.json({
        success: true,
        isFallback: false,
        source: "ml_ensemble",
        ...data
      });
    }

    throw new Error(`ML Service returned status ${mlRes ? mlRes.status : "offline"}`);
  } catch (err) {
    console.warn(`[ML Service] Prediction unavailable (${err.message}), falling back to PVsyst engine.`);
    return res.json({
      success: false,
      isFallback: true,
      reason: "ML service is cold-starting or offline; using calibrated PVsyst physics engine."
    });
  }
});

// Helper to generate 8-node 3S2P mock telemetry
function generate3S2PMockNodes({
  s1_c2 = true, s1_c3 = true, s1_c4 = true,
  s2_c6 = true, s2_c7 = true, s2_c8 = true,
  p2_low_v = false,
  s1_dead = false, s2_dead = false
} = {}) {
  const s1_current = (s1_dead || !s1_c4) ? 0 : 350;
  const s2_current = (s2_dead || !s2_c8) ? 0 : 345;

  return [
    // STRING 1 (Nodes 1-4)
    { id: 1, node_id: 1, string_id: 1, panel_id: 1, label: "STRING 1 - PANEL 1", node_type: 0, continuity: true, temp_c10: 295, temp_c: 29.5, voltage_mV: 2450, current_mA: 0, ageMs: 80 },
    { id: 2, node_id: 2, string_id: 1, panel_id: 2, label: "STRING 1 - PANEL 2", node_type: 1, continuity: s1_c2, temp_c10: 310, temp_c: 31.0, voltage_mV: p2_low_v ? 350 : 2420, current_mA: 0, ageMs: 90 },
    { id: 3, node_id: 3, string_id: 1, panel_id: 3, label: "STRING 1 - PANEL 3", node_type: 1, continuity: s1_c3, temp_c10: 305, temp_c: 30.5, voltage_mV: 2410, current_mA: 0, ageMs: 70 },
    { id: 4, node_id: 4, string_id: 1, panel_id: 0, label: "STRING 1 - MASTER",  node_type: 2, continuity: s1_c4, temp_c10: -999, temp_c: null, voltage_mV: s1_dead ? 0 : 7280, current_mA: s1_current, ageMs: 60 },

    // STRING 2 (Nodes 5-8)
    { id: 5, node_id: 5, string_id: 2, panel_id: 1, label: "STRING 2 - PANEL 1", node_type: 0, continuity: true, temp_c10: 298, temp_c: 29.8, voltage_mV: 2440, current_mA: 0, ageMs: 85 },
    { id: 6, node_id: 6, string_id: 2, panel_id: 2, label: "STRING 2 - PANEL 2", node_type: 1, continuity: s2_c6, temp_c10: 312, temp_c: 31.2, voltage_mV: 2430, current_mA: 0, ageMs: 95 },
    { id: 7, node_id: 7, string_id: 2, panel_id: 3, label: "STRING 2 - PANEL 3", node_type: 1, continuity: s2_c7, temp_c10: 302, temp_c: 30.2, voltage_mV: 2410, current_mA: 0, ageMs: 75 },
    { id: 8, node_id: 8, string_id: 2, panel_id: 0, label: "STRING 2 - MASTER",  node_type: 2, continuity: s2_c8, temp_c10: -999, temp_c: null, voltage_mV: s2_dead ? 0 : 7280, current_mA: s2_current, ageMs: 65 }
  ];
}

// ESP32 posts telemetry packets here (all 8 nodes of 3S2P array)
app.post("/api/data", (req, res) => {
  const rawNodes = (req.body && req.body.nodes) || [];
  const normalizedNodes = rawNodes.map((raw) => {
    const id = raw.id !== undefined ? Number(raw.id) : (raw.node_id !== undefined ? Number(raw.node_id) : null);
    let node_type = 0;
    if (typeof raw.node_type === "number") {
      node_type = raw.node_type;
    } else if (typeof raw.node_type === "string") {
      if (raw.node_type === "string") node_type = 2;
      else if (raw.node_type === "panel_full") node_type = 1;
      else node_type = 0;
    } else {
      node_type = (id === 4 || id === 8) ? 2 : ((id === 1 || id === 5) ? 0 : 1);
    }

    const string_id = raw.string_id !== undefined ? Number(raw.string_id) : (id <= 4 ? 1 : 2);
    const panel_id  = raw.panel_id !== undefined ? Number(raw.panel_id) : (node_type === 2 ? 0 : (id <= 4 ? id : id - 4));
    const label     = raw.label || getNodeLabel(id);

    let continuity = true;
    if (raw.continuity === false || raw.continuity === "false" || raw.continuity === 0) {
      continuity = false;
    }

    let temp_c10 = -999;
    if (raw.temp_c10 !== undefined) {
      temp_c10 = Number(raw.temp_c10);
    } else if (raw.temp_c !== undefined) {
      const tc = Number(raw.temp_c);
      temp_c10 = (tc <= -90) ? -999 : Math.round(tc * 10);
    }

    return {
      id,
      node_id: id,
      string_id,
      panel_id,
      label,
      node_type,
      continuity,
      temp_c10,
      temp_c: temp_c10 === -999 ? null : temp_c10 / 10,
      voltage_mV: Number(raw.voltage_mV) || 0,
      current_mA: Number(raw.current_mA) || 0,
      ldr_raw: Number(raw.ldr_raw) || 0,
      ageMs: Number(raw.ageMs) || 0
    };
  });

  latest = {
    nodes: normalizedNodes,
    receivedAt: Date.now(),
    isSimulated: false,
    simulationScenario: null
  };

  // Maintain last 2 polled ESP32 packets for 2-consecutive-poll fault confirmation
  packetHistory.push(normalizedNodes);
  if (packetHistory.length > 2) {
    packetHistory.shift();
  }

  if (Date.now() - lastLog > 2000) {
    lastLog = Date.now();
    console.log(`[${new Date().toLocaleTimeString()}] ESP32 Live Packet Received: ${normalizedNodes.length} active node(s) across 3S2P array (History depth: ${packetHistory.length})`);
  }

  // Trigger alert if open circuit fault was detected
  checkFaultAndNotify();
  res.sendStatus(200);
});

// Simulation endpoint for client demos & testing 3S2P diagnostic truth table
app.post("/api/simulate", (req, res) => {
  const scenario = (req.body && req.body.scenario) || "normal";

  if (scenario === "live_hardware") {
    packetHistory = [];
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

  const now = Date.now();
  let mockNodes = [];

  switch (scenario) {
    case "normal":
      // All 8 nodes healthy
      mockNodes = generate3S2PMockNodes();
      break;

    // String 1 Scenarios
    case "s1_fault_p1_p2_pwr":
    case "fault_p1_p2": // backward compat alias
      // Case 1: C2 = Broken, but C3 = OK -> Power (+) wire broken between Panel 1 & 2
      mockNodes = generate3S2PMockNodes({ s1_c2: false, s1_c3: true, s1_c4: true });
      break;

    case "s1_fault_p1_p2_gnd":
      // Case 2: C2 = Broken AND C3 = Broken -> Sense GND broken between Panel 1 & 2
      mockNodes = generate3S2PMockNodes({ s1_c2: false, s1_c3: false, s1_c4: false, s1_dead: true });
      break;

    case "s1_fault_p2_p3_pwr":
    case "fault_p2_p3": // backward compat alias
      // Case 3: C2 = OK, C3 = Broken, but C4 = OK -> Power (+) wire broken between Panel 2 & 3
      mockNodes = generate3S2PMockNodes({ s1_c2: true, s1_c3: false, s1_c4: true });
      break;

    case "s1_fault_p2_p3_gnd":
      // Case 4: C2 = OK, C3 = Broken, AND C4 = Broken -> Sense GND broken between Panel 2 & 3
      mockNodes = generate3S2PMockNodes({ s1_c2: true, s1_c3: false, s1_c4: false, s1_dead: true });
      break;

    case "s1_fault_p3_str":
    case "fault_p3_string": // backward compat alias
      // Case 5: C2 = OK, C3 = OK, but C4 = Broken -> Terminal break between Panel 3 & String 1
      mockNodes = generate3S2PMockNodes({ s1_c2: true, s1_c3: true, s1_c4: false, s1_dead: true });
      break;

    // String 2 Scenarios
    case "s2_fault_p4_p5_pwr":
      // Case 1 on S2: C6 = Broken, but C7 = OK -> Power (+) wire broken between Panel 4 & 5
      mockNodes = generate3S2PMockNodes({ s2_c6: false, s2_c7: true, s2_c8: true });
      break;

    case "s2_fault_p4_p5_gnd":
      // Case 2 on S2: C6 = Broken AND C7 = Broken -> Sense GND broken between Panel 4 & 5
      mockNodes = generate3S2PMockNodes({ s2_c6: false, s2_c7: false, s2_c8: false, s2_dead: true });
      break;

    case "s2_fault_p5_p6_pwr":
      // Case 3 on S2: C6 = OK, C7 = Broken, but C8 = OK -> Power (+) wire broken between Panel 5 & 6
      mockNodes = generate3S2PMockNodes({ s2_c6: true, s2_c7: false, s2_c8: true });
      break;

    case "s2_fault_p5_p6_gnd":
      // Case 4 on S2: C6 = OK, C7 = Broken, AND C8 = Broken -> Sense GND broken between Panel 5 & 6
      mockNodes = generate3S2PMockNodes({ s2_c6: true, s2_c7: false, s2_c8: false, s2_dead: true });
      break;

    case "s2_fault_p6_str":
      // Case 5 on S2: C6 = OK, C7 = OK, but C8 = Broken -> Terminal break between Panel 6 & String 2
      mockNodes = generate3S2PMockNodes({ s2_c6: true, s2_c7: true, s2_c8: false, s2_dead: true });
      break;

    case "low_voltage":
      // Partial shading on Panel 2
      mockNodes = generate3S2PMockNodes({ p2_low_v: true });
      break;

    case "gateway_offline":
      latest = {
        nodes: [],
        receivedAt: 0,
        isSimulated: true,
        simulationScenario: "gateway_offline"
      };
      checkFaultAndNotify();
      return res.json({ success: true, message: "Simulating Gateway Offline", scenario: "gateway_offline" });

    default:
      mockNodes = generate3S2PMockNodes();
      break;
  }

  latest = {
    nodes: mockNodes,
    receivedAt: now,
    isSimulated: true,
    simulationScenario: scenario
  };
  packetHistory = [mockNodes, mockNodes];

  console.log(`[${new Date().toLocaleTimeString()}] 3S2P Simulation Scenario Active: ${scenario}`);
  checkFaultAndNotify();
  res.json({ success: true, message: `Active scenario: ${scenario}`, scenario });
});

// Status endpoint polled by frontend UI (Comprehensive 3S2P Topology + Combiner Box)
app.get("/api/status", (req, res) => {
  const {
    gatewayAge,
    gatewayOnline,
    faultNodeId,
    faultDescription,
    brokenWireId,
    faultType,
    string1Fault,
    string2Fault
  } = computeFaultState();

  // 1. Build all 8 cell statuses with truth table diagnostic states
  const cells = [1, 2, 3, 4, 5, 6, 7, 8].map((id) => {
    const n = latest.nodes.find((x) => (x.id === id || x.node_id === id));
    let nodeType = n ? n.node_type : ((id === 4 || id === 8) ? 2 : ((id === 1 || id === 5) ? 0 : 1));
    if (typeof nodeType === "string") {
      if (nodeType === "string") nodeType = 2;
      else if (nodeType === "panel_full") nodeType = 1;
      else nodeType = 0;
    }
    const typeName = NODE_TYPE_NAME[nodeType] || "unknown";

    const string_id = (id <= 4) ? 1 : 2;
    const panel_id  = (nodeType === 2) ? 0 : (id <= 4 ? id : id - 4);
    const label     = n ? (n.label || getNodeLabel(id)) : getNodeLabel(id);

    if (!n || !gatewayOnline) {
      return { id, node_id: id, string_id, panel_id, label, type: typeName, state: "no_signal" };
    }

    const age = (n.ageMs || 0) + gatewayAge;
    if (age > NODE_TIMEOUT_MS) {
      return { id, node_id: id, string_id, panel_id, label, type: typeName, state: "no_signal" };
    }

    // Determine state based on truth table evaluation for this node's string
    const stringDiag = (string_id === 1) ? string1Fault : string2Fault;
    let state = (stringDiag && stringDiag.cellStates && stringDiag.cellStates[id]) ? stringDiag.cellStates[id] : "ok";

    if (typeName === "panel_basic" || typeName === "panel_full") {
      const voltage = (n.voltage_mV || 0) / 1000;
      let temp = null;
      if (typeof n.temp_c === "number") {
        temp = (n.temp_c <= -90) ? null : n.temp_c;
      } else if (typeof n.temp_c10 === "number") {
        temp = (n.temp_c10 <= -900) ? null : n.temp_c10 / 10;
      }
      if (state === "ok" && (n.voltage_mV || 0) < LOW_VOLTAGE_MV) state = "low_voltage";
      return { id, node_id: id, string_id, panel_id, label, type: typeName, state, temp, voltage, continuity: n.continuity };
    }

    // String monitor node (id 4 or 8)
    const current = (n.current_mA || 0) / 1000;
    let stringVoltage = 0;
    if (n.voltage_mV && n.voltage_mV > 0) {
      stringVoltage = n.voltage_mV / 1000;
    } else {
      const startP = (string_id === 1) ? 1 : 5;
      for (let pId = startP; pId < startP + 3; pId++) {
        const pNode = latest.nodes.find((x) => (x.id === pId || x.node_id === pId));
        if (pNode && pNode.voltage_mV > 0) {
          stringVoltage += pNode.voltage_mV / 1000;
        }
      }
    }
    const power = stringVoltage * current;

    return {
      id,
      node_id: id,
      string_id,
      panel_id,
      label,
      type: typeName,
      state,
      voltage: Number(stringVoltage.toFixed(2)),
      current: Number(current.toFixed(3)),
      power: Number(power.toFixed(2)),
      continuity: n.continuity
    };
  });

  // 2. Compute String 1, String 2, and 3S2P Array Combiner Box Metrics
  const s1WireStates = (string1Fault && string1Fault.wireStates) || {};
  const s2WireStates = (string2Fault && string2Fault.wireStates) || {};

  const s1Node = latest.nodes.find((x) => (x.id === 4 || x.node_id === 4));
  const s2Node = latest.nodes.find((x) => (x.id === 8 || x.node_id === 8));

  const s1Current_mA = (s1Node && gatewayOnline) ? (s1Node.current_mA || 0) : 0;
  const s2Current_mA = (s2Node && gatewayOnline) ? (s2Node.current_mA || 0) : 0;
  const totalCurrent_mA = s1Current_mA + s2Current_mA;

  const s1Volt_mV = (s1Node && gatewayOnline) ? (s1Node.voltage_mV || 0) : 0;
  const s2Volt_mV = (s2Node && gatewayOnline) ? (s2Node.voltage_mV || 0) : 0;
  const avgVolt_mV = (s1Volt_mV > 0 && s2Volt_mV > 0) ? Math.round((s1Volt_mV + s2Volt_mV) / 2) : Math.max(s1Volt_mV, s2Volt_mV);

  const arrayVolt_V    = Number((avgVolt_mV / 1000).toFixed(2));
  const arrayCurrent_A = Number((totalCurrent_mA / 1000).toFixed(3));
  const arrayPower_W   = Number((arrayVolt_V * arrayCurrent_A).toFixed(2));

  // Determine wire states for Combiner Box inputs and outputs
  let combS1State = !gatewayOnline ? "no_signal" : (string1Fault && string1Fault.hasFault ? "open" : "closed");
  let combS2State = !gatewayOnline ? "no_signal" : (string2Fault && string2Fault.hasFault ? "open" : "closed");
  let combOutState = !gatewayOnline ? "no_signal" : (totalCurrent_mA > 15 ? "closed" : ((string1Fault && string1Fault.hasFault) && (string2Fault && string2Fault.hasFault) ? "open" : "closed"));

  const wires = [
    // String 1 wires
    { id: "W_S1_P1_P2_PWR",   string_id: 1, from: 1, to: 2, role: "power",        state: !gatewayOnline ? "no_signal" : (s1WireStates["W_S1_P1_P2_PWR"] || "closed") },
    { id: "W_S1_P1_P2_SENSE", string_id: 1, from: 1, to: 2, role: "sensing_gnd",   state: !gatewayOnline ? "no_signal" : (s1WireStates["W_S1_P1_P2_SENSE"] || "closed") },
    { id: "W_S1_STRING_GND",  string_id: 1, from: 1, to: 4, role: "string_gnd",    state: !gatewayOnline ? "no_signal" : (s1WireStates["W_S1_STRING_GND"] || "closed") },
    { id: "W_S1_P2_P3_PWR",   string_id: 1, from: 2, to: 3, role: "power",        state: !gatewayOnline ? "no_signal" : (s1WireStates["W_S1_P2_P3_PWR"] || "closed") },
    { id: "W_S1_P2_P3_SENSE", string_id: 1, from: 2, to: 3, role: "sensing_gnd",   state: !gatewayOnline ? "no_signal" : (s1WireStates["W_S1_P2_P3_SENSE"] || "closed") },
    { id: "W_S1_P3_STR_PWR",  string_id: 1, from: 3, to: 4, role: "power",        state: !gatewayOnline ? "no_signal" : (s1WireStates["W_S1_P3_STR_PWR"] || "closed") },

    // String 2 wires
    { id: "W_S2_P4_P5_PWR",   string_id: 2, from: 5, to: 6, role: "power",        state: !gatewayOnline ? "no_signal" : (s2WireStates["W_S2_P4_P5_PWR"] || "closed") },
    { id: "W_S2_P4_P5_SENSE", string_id: 2, from: 5, to: 6, role: "sensing_gnd",   state: !gatewayOnline ? "no_signal" : (s2WireStates["W_S2_P4_P5_SENSE"] || "closed") },
    { id: "W_S2_STRING_GND",  string_id: 2, from: 5, to: 8, role: "string_gnd",    state: !gatewayOnline ? "no_signal" : (s2WireStates["W_S2_STRING_GND"] || "closed") },
    { id: "W_S2_P5_P6_PWR",   string_id: 2, from: 6, to: 7, role: "power",        state: !gatewayOnline ? "no_signal" : (s2WireStates["W_S2_P5_P6_PWR"] || "closed") },
    { id: "W_S2_P5_P6_SENSE", string_id: 2, from: 6, to: 7, role: "sensing_gnd",   state: !gatewayOnline ? "no_signal" : (s2WireStates["W_S2_P5_P6_SENSE"] || "closed") },
    { id: "W_S2_P6_STR_PWR",  string_id: 2, from: 7, to: 8, role: "power",        state: !gatewayOnline ? "no_signal" : (s2WireStates["W_S2_P6_STR_PWR"] || "closed") },

    // Combiner Box input and output wires
    { id: "W_COMB_S1_POS", string_id: 1, from: 4, to: "combiner", role: "combiner_in_pos", state: combS1State },
    { id: "W_COMB_S1_NEG", string_id: 1, from: 4, to: "combiner", role: "combiner_in_neg", state: combS1State },
    { id: "W_COMB_S2_POS", string_id: 2, from: 8, to: "combiner", role: "combiner_in_pos", state: combS2State },
    { id: "W_COMB_S2_NEG", string_id: 2, from: 8, to: "combiner", role: "combiner_in_neg", state: combS2State },
    { id: "W_ARRAY_OUT_POS", from: "combiner", to: "load", role: "array_out_pos", state: combOutState },
    { id: "W_ARRAY_OUT_NEG", from: "combiner", to: "load", role: "array_out_neg", state: combOutState }
  ];

  let activeAlert = null;
  if (pendingTestAlert && (Date.now() - pendingTestAlert.timestamp < 45000)) {
    activeAlert = {
      id: pendingTestAlert.id,
      title: pendingTestAlert.title,
      body: pendingTestAlert.body,
      userEmail: pendingTestAlert.userEmail,
      timestamp: pendingTestAlert.timestamp
    };
  }

  res.json({
    gatewayOnline,
    faultNodeId,
    brokenWireId,
    faultType,
    faultDescription,
    string1Fault,
    string2Fault,
    string1: {
      voltage: Number((s1Volt_mV / 1000).toFixed(2)),
      current: Number((s1Current_mA / 1000).toFixed(3)),
      power: Number(((s1Volt_mV / 1000) * (s1Current_mA / 1000)).toFixed(2)),
      fault: string1Fault
    },
    string2: {
      voltage: Number((s2Volt_mV / 1000).toFixed(2)),
      current: Number((s2Current_mA / 1000).toFixed(3)),
      power: Number(((s2Volt_mV / 1000) * (s2Current_mA / 1000)).toFixed(2)),
      fault: string2Fault
    },
    combiner: {
      voltage: arrayVolt_V,
      current: arrayCurrent_A,
      power: arrayPower_W,
      current_mA: totalCurrent_mA,
      voltage_mV: avgVolt_mV,
      power_W: arrayPower_W,
      s1Current_mA,
      s2Current_mA,
      status: (!gatewayOnline ? "no_signal" : ((string1Fault && string1Fault.hasFault) && (string2Fault && string2Fault.hasFault) ? "fault" : ((string1Fault && string1Fault.hasFault) || (string2Fault && string2Fault.hasFault) ? "degraded" : "normal")))
    },
    arrayTotals: {
      voltage_V: arrayVolt_V,
      current_A: arrayCurrent_A,
      power_W: arrayPower_W,
      totalCurrent_mA,
      avgVoltage_mV: avgVolt_mV
    },
    isPowerFlowing: totalCurrent_mA > 15,
    stringCurrent_mA: totalCurrent_mA,
    serverTime: Date.now(),
    cells,
    wires,
    pendingAlert: activeAlert,
    isSimulated: latest.isSimulated,
    simulationScenario: latest.simulationScenario
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

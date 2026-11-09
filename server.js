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

// Serve static project files directly (HTML, JS, CSS, images)
app.use(express.static(path.join(__dirname, ".")));

const NODE_TIMEOUT_MS = 10000;    // 10 seconds margin for stale detection
const GATEWAY_TIMEOUT_MS = 15000; // 15 seconds margin for faster offline detection with cloud latency tolerance
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
let lastFaultState = null;

function computeFaultState() {
  const gatewayAge = Date.now() - latest.receivedAt;
  const gatewayOnline = latest.receivedAt !== 0 && gatewayAge < GATEWAY_TIMEOUT_MS;

  let faultNodeId = null;
  let faultDescription = null;

  if (gatewayOnline) {
    for (let id = 2; id <= 4; id++) {
      const n = latest.nodes.find((x) => (x.id === id || x.node_id === id));
      if (n) {
        const age = (n.ageMs || 0) + gatewayAge;
        const isContinuityBroken = (n.continuity === false || n.continuity === "false" || n.continuity === 0);
        if (age <= NODE_TIMEOUT_MS && isContinuityBroken) {
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

  if (faultNodeId !== null && faultNodeId !== lastFaultState) {
    // A NEW or CHANGED fault occurred!
    console.log(`[ALERT] 🚨 Solar String Fault at Node ${faultNodeId}! Triggering Native Push...`);
    sendPushNotification({
      title: "🚨 Solar String Fault Detected!",
      body: `CRITICAL ALERT: Wire break at Node ${faultNodeId}! ${faultDescription}`,
      icon: "https://cdn-icons-png.flaticon.com/512/564/564619.png",
      badge: "https://cdn-icons-png.flaticon.com/512/564/564619.png",
      vibrate: [300, 150, 300, 150, 300],
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

// ESP32 posts telemetry packets here
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
      node_type = id === 4 ? 2 : (id === 1 ? 0 : 1);
    }

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

  if (Date.now() - lastLog > 2000) {
    lastLog = Date.now();
    console.log(`[${new Date().toLocaleTimeString()}] ESP32 Live Packet Received: ${normalizedNodes.length} active node(s)`);
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
    const n = latest.nodes.find((x) => (x.id === id || x.node_id === id));
    let nodeType = n ? n.node_type : (id <= 3 ? (id === 1 ? 0 : 1) : 2);
    if (typeof nodeType === "string") {
      if (nodeType === "string") nodeType = 2;
      else if (nodeType === "panel_full") nodeType = 1;
      else nodeType = 0;
    }
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
      const voltage = (n.voltage_mV || 0) / 1000;
      let temp = null;
      if (typeof n.temp_c === "number") {
        temp = (n.temp_c <= -90) ? null : n.temp_c;
      } else if (typeof n.temp_c10 === "number") {
        temp = (n.temp_c10 <= -900) ? null : n.temp_c10 / 10;
      }
      if (state === "ok" && (n.voltage_mV || 0) < LOW_VOLTAGE_MV) state = "low_voltage";
      return { id, type: typeName, state, temp, voltage };
    }

    // String node: continuity + current + LDR + string voltage + power
    const current = (n.current_mA || 0) / 1000;

    let stringVoltage = 0;
    if (n.voltage_mV && n.voltage_mV > 0) {
      stringVoltage = n.voltage_mV / 1000;
    } else {
      for (let pId = 1; pId <= 3; pId++) {
        const pNode = latest.nodes.find((x) => (x.id === pId || x.node_id === pId));
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
      ldr: n.ldr_raw || 0
    };
  });

  // 3. Compute 7 distinct physical wires across the array
  const stringNodeData = latest.nodes.find((x) => (x.id === 4 || x.node_id === 4));
  const stringCurrent_mA = stringNodeData ? (stringNodeData.current_mA || 0) : 0;
  const isPowerFlowing = stringCurrent_mA > 15;

  let brokenWireId = null;
  let faultType = "none";

  if (faultNodeId === 2) {
    brokenWireId = "W_P1_P2_PWR";
    faultType = "power";
  } else if (faultNodeId === 3) {
    brokenWireId = "W_P2_P3_PWR";
    faultType = "power";
  } else if (faultNodeId === 4) {
    brokenWireId = "W_P3_STR_PWR";
    faultType = "power";
  }

  const rawWires = [
    { id: "W_P1_P2_PWR",   from: 1, to: 2, role: "power" },
    { id: "W_P1_P2_SENSE", from: 1, to: 2, role: "sensing_gnd" },
    { id: "W_P1_STR_RET",  from: 1, to: 4, role: "return_gnd" },
    { id: "W_P2_P3_PWR",   from: 2, to: 3, role: "power" },
    { id: "W_P2_P3_SENSE", from: 2, to: 3, role: "sensing_gnd" },
    { id: "W_P3_STR_PWR",  from: 3, to: 4, role: "power" },
    { id: "W_P3_STR_SENSE",from: 3, to: 4, role: "sensing_wire" }
  ];

  const wires = rawWires.map((w) => {
    if (!gatewayOnline) return { ...w, state: "no_signal" };

    if (faultNodeId === null) {
      return { ...w, state: "closed" };
    }

    if (faultNodeId === 2) {
      if (w.id === "W_P1_P2_PWR") return { ...w, state: "open" };
      if (w.id === "W_P1_P2_SENSE" || w.id === "W_P1_STR_RET") return { ...w, state: "closed" };
      return { ...w, state: "gray_zone" };
    }

    if (faultNodeId === 3) {
      if (w.from === 1 && w.to === 2) return { ...w, state: "closed" };
      if (w.id === "W_P1_STR_RET") return { ...w, state: "closed" };
      if (w.id === "W_P2_P3_PWR") return { ...w, state: "open" };
      if (w.id === "W_P2_P3_SENSE") return { ...w, state: "closed" };
      return { ...w, state: "gray_zone" };
    }

    if (faultNodeId === 4) {
      if (w.from < 3) return { ...w, state: "closed" };
      if (w.id === "W_P1_STR_RET") return { ...w, state: "closed" };
      if (w.id === "W_P3_STR_PWR") return { ...w, state: "open" };
      return { ...w, state: "gray_zone" };
    }

    return { ...w, state: "closed" };
  });

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
    isPowerFlowing,
    stringCurrent_mA,
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

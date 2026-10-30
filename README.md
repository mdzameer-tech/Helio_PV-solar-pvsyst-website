# HelioPV EPC Studio + ESP32 Solar IoT Monitor & Simulator

A unified, professional solar PV engineering, financial estimation, and **Live IoT Hardware Monitoring** web application built specifically for **Solar EPC (Engineering, Procurement, and Construction) companies** and solar hardware engineers.

This system integrates:
1. **Live ESP32 Solar String Monitor & Fault Detection**:
   - Multi-point series continuity monitoring via CH32V003 micro-nodes + ESP32-C6 master gateway.
   - Real-time detection of connection vs. open circuit disconnection between panels.
   - Animated SVG electrical circuit switches (Closed, Open with spark pulse, Downstream Gray Zone).
   - Root cause isolation algorithm (identifies the lowest numbered panel with a break).
   - Real-time voltage, current, power, temperature, and LDR light sensor telemetry.
   - Interactive client presentation demo buttons to simulate wire breaks on-demand.
2. **PVsyst Solar Generation & ROI Simulator**:
   - Exact PVsyst-calibrated generation and financial payback reports.
   - Month-wise Generation Report (kWh/kWp yield, kWh output, and ₹ bill offset).
   - Indicative ROI / Simple Payback (Installed CAPEX, 25-year gross offset, net benefit).
   - Interactive rooftop satellite mapping (Esri High-Res Satellite + Google Maps API).
   - Live satellite solar radiation integration (Open-Meteo ERA5 satellite model).
   - Client-ready PDF proposal printing and Excel/CSV download.
3. **Seamless Window & View Navigation**:
   - Switch between **Live String Monitor** and **Solar Estimation Studio** with one click.
   - **Pop-out Window Button**: Open both windows side-by-side for dual-screen client presentations.
   - Direct URLs: `http://localhost:3000/monitor` and `http://localhost:3000/estimate`.

---

## 🚀 How to Run the Complete System

### Option 1: 1-Click Complete System Launcher (Recommended)
Double-click:
```
start_all.bat
```
*(or `run_website.bat`)*

This starts the Node.js server on **port 3000** and automatically opens `http://localhost:3000` in your browser. Both the IoT String Monitor and the PVsyst Estimation window are fully active!

### Option 2: Run via Node.js Command Line
Open PowerShell or Command Prompt in the project folder:
```powershell
node server.js
```
Then visit:
- **Unified App:** `http://localhost:3000`
- **IoT String Monitor View:** `http://localhost:3000/monitor`
- **Solar Estimation Window:** `http://localhost:3000/estimate`

### Option 3: Standalone / Offline in Browser
Double-click `index.html`. Even without the Node server running, the full PVsyst simulation works 100%, and the IoT monitor includes a client demo simulator to test all connection and disconnection scenarios!

---

## 📡 Connecting the Physical ESP32 Hardware

1. Open `esp32_gateway/esp32_gateway/esp32_gateway.ino` in the Arduino IDE.
2. Set your Wi-Fi credentials:
   ```cpp
   const char *WIFI_SSID     = "Your_WiFi_Name";
   const char *WIFI_PASSWORD = "Your_WiFi_Password";
   ```
3. Set `BACKEND_URL` to your computer's local Wi-Fi IP address (displayed on the dashboard when clicking **"ESP32 Setup"**):
   ```cpp
   const char *BACKEND_URL   = "http://10.116.126.159:3000/api/data";
   ```
4. Flash the code to your DFRobot Beetle ESP32-C6.
5. The ESP32 receives data from the 4 sensor nodes over nRF24L01+ and posts to `http://<your-ip>:3000/api/data`. The web interface updates in real-time every 800ms!

---

## 🌟 Benchmark Calibration (Matching Screenshot)

The system is pre-configured with a 1-click preset button: **"Load Bengaluru Benchmark (36.6 kWp)"** which exactly matches your sample report:

- **Location:** `RHM7+RH8, Bilwaradahalli, Karnataka (Bengaluru region)`
- **Plant Capacity:** `36.60 kWp`
- **Assumed Installed Cost:** `₹65,000/kWp × 36.60 kWp = ₹2,379,000 (₹23.79 Lakh)`
- **Electricity Tariff:** `₹7.50 per unit`
- **Annual Energy Generation:** `58,634 kWh` (1,602 kWh/kWp specific yield)
- **Estimated Annual Bill Offset:** `₹439,755` (average `₹36,646/month`)
- **Simple Payback:** `5.4 Years`
- **25-Year Gross Bill Offset:** `₹10,993,875`
- **25-Year Simple Net Benefit:** `₹8,614,875`

---

## 🚀 How to Run the Website

### Option 1: Double-Click Launcher (Recommended on Windows)
Simply double-click the included file:
```
run_website.bat
```
This automatically starts the local HTTP server and opens `http://localhost:8080/` in your default web browser (Chrome, Brave, Edge).

### Option 2: Open `index.html` Directly
You can also directly double-click:
```
index.html
```
The entire application is self-contained and runs immediately in any modern web browser without requiring Node.js, Python, or database installations.

### Option 3: PowerShell Server
Open PowerShell in the folder and run:
```powershell
powershell -ExecutionPolicy Bypass -File .\serve.ps1 -Port 8080
```

---

## 🛰️ API Integrations

### 1. Satellite Weather & Solar Irradiance (Active by Default)
- **API Provider:** [Open-Meteo Historical & Forecast Solar API](https://open-meteo.com/en/docs/historical-weather-api) (powered by ERA5-Land reanalysis & satellite models).
- **Features:**
  - Queries daily solar radiation sums (`shortwave_radiation_sum` in MJ/m²) and ambient temperatures.
  - Automatically converts solar insolation into Plane-of-Array (POA) irradiance based on panel tilt and azimuth angles.
  - **No API key required** — free and unlimited for your EPC team.

### 2. Location Geocoding & Plus Codes
- Automatically resolves addresses, landmarks, city names, and Google Plus Codes (such as `RHM7+RH8, Bilwaradahalli, Karnataka`).
- Powered by Open-Meteo Geocoding & OpenStreetMap Nominatim.

### 3. Rooftop Satellite Mapping
- **Default:** High-resolution Esri World Imagery with hybrid street/locality labels. Allows zooming directly into building rooftops, dragging the solar installation marker, and inspecting site orientation.
- **Optional Google Maps API:** Click **"Map & API Settings"** in the top navigation bar and enter your Google Maps JavaScript API key. The application will instantly switch to Google Satellite Hybrid imagery with Google Places Autocomplete.

---

## 📊 Features for Solar EPC Presentations

| Feature | Description |
| :--- | :--- |
| **Month-Wise Generation Report** | Displays the exact table with monthly yield (kWh/kWp), total generation (kWh), and monthly savings (₹) at your customer's utility tariff. |
| **Indicative ROI Table** | Calculates simple payback period, capital investment (in ₹ Lakh), 25-year gross savings, and net lifetime benefit after initial CAPEX. |
| **PVsyst Loss Cascade** | Visualizes temperature derating, soiling loss, DC ohmic resistance, inverter efficiency, and mismatch losses down to overall Performance Ratio (PR ~ 79%). |
| **25-Year Cash Flow** | Year-by-year financial forecast incorporating 0.5% annual solar module degradation and customizable utility tariff inflation. |
| **Client PDF Export** | Click **"Print / PDF Proposal"** to print or save a clean, high-contrast, professional 2-page solar proposal for client presentations. |
| **Excel Export** | Click **"Export Excel/CSV"** to download all monthly generation numbers and financial assumptions directly into spreadsheet format. |

---

## 🛠️ Project File Structure

```
solar-pvsyst-website/
├── index.html         # Main user interface & client report layout
├── styles.css         # Styling matching PVsyst EPC reports & print stylesheets
├── pv-engine.js       # Mathematical engine (transposition, thermal loss, ROI formulas)
├── weather-api.js     # Open-Meteo solar irradiance & Google Maps/geocoding service
├── app.js             # UI state management, map rendering, and Chart.js integration
├── serve.ps1          # Lightweight PowerShell local web server
├── run_website.bat    # 1-click Windows batch launcher
└── README.md          # Comprehensive documentation
```

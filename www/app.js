/**
 * Main Application Logic for HelioPV EPC Studio / PVsyst Simulator
 * Handles UI interactions, map rendering, chart updates, API integrations, and report exports.
 */

// User provided Google API Key configured as default
const DEFAULT_GOOGLE_API_KEY = 'AIzaSyCOu9sS27zZW88e4r9FpztHAggOJeqzuLs';

// Application State
const AppState = {
  project: {
    name: 'Commercial Rooftop Solar Plant',
    searchQuery: 'RHM7+RH8, Bilwaradahalli, Karnataka',
    displayLocation: 'RHM7+RH8, Bilwaradahalli, Karnataka (Bengaluru region)',
    lat: 12.8342,
    lon: 77.5891,
    elevation: 915
  },
  pv: {
    capacityKwp: 36.60,
    moduleType: 'mono_550',
    inverterType: 'string_30',
    tiltDeg: 13,
    azimuthDeg: 180,
    losses: {
      soiling: 2.5,
      wiring: 1.5,
      inverter: 2.0,
      mismatch: 2.0
    }
  },
  financials: {
    costPerKwp: 65000,
    tariff: 7.50,
    degradationPct: 0.5,
    escalationPct: 2.5
  },
  weatherData: null,
  simulationResult: null,
  map: null,
  marker: null,
  mapLayers: {
    satellite: null,
    streets: null,
    labels: null
  },
  currentMapType: 'satellite',
  googleMap: null,
  googleMarker: null,
  charts: {
    monthlyGen: null,
    cashflow: null,
    hourlyForecast: null,
    dailyForecast: null
  },
  forecastSelectedDayOffset: 0,
  forecastUnit: 'kW',
  googleApiKey: localStorage.getItem('heliopv_google_api_key') || DEFAULT_GOOGLE_API_KEY
};

// Global fallback handler if Google Maps API throws auth failure (e.g. billing not enabled)
window.onGoogleMapsAuthFailed = function () {
  console.warn('Google Maps auth error caught. Seamlessly switching to high-res Esri Satellite.');
  const indicator = document.getElementById('map-mode-indicator');
  if (indicator) indicator.textContent = 'Esri High-Res Satellite';
  initLeafletMap(AppState.project.lat, AppState.project.lon);
};

// Initialize Application when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  if (window.lucide) {
    lucide.createIcons();
  }

  // Pre-save key in localStorage if not set
  if (!localStorage.getItem('heliopv_google_api_key')) {
    localStorage.setItem('heliopv_google_api_key', DEFAULT_GOOGLE_API_KEY);
  }

  const printDateEl = document.getElementById('print-date');
  if (printDateEl) {
    printDateEl.textContent = 'Generated on: ' + new Date().toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    });
  }

  // Initialize Map
  initMap(AppState.project.lat, AppState.project.lon);

  // Setup Event Listeners
  setupEventListeners();

  // Run initial simulation
  runSimulation();

  // View mode check from URL (defaults to monitor)
  const urlParams = new URLSearchParams(window.location.search);
  const initialView = urlParams.get('view') || 'monitor';
  switchView(initialView);

  // Initialize IoT Monitoring
  initIoTMonitor();

  // Initialize Native Background Web Push Notifications
  setupPushNotifications();

  // Initialize JWT User Authentication & Hamburger Profile Drawer
  initAuth();
});

/**
 * Initialize Interactive Map
 * Attempts Google Maps first, safely falls back to Leaflet Esri satellite if billing is not enabled
 */
function initMap(lat, lon) {
  if (AppState.googleApiKey) {
    tryLoadGoogleMaps(lat, lon);
    return;
  }
  initLeafletMap(lat, lon);
}

function initLeafletMap(lat, lon) {
  const mapContainer = document.getElementById('map-container');
  if (!mapContainer) return;

  if (AppState.map) {
    AppState.map.remove();
    AppState.map = null;
  }

  // Create Leaflet Map centered on site
  AppState.map = L.map('map-container', {
    center: [lat, lon],
    zoom: 18,
    zoomControl: true,
    maxZoom: 20
  });

  // Esri World Imagery (high-resolution satellite imagery for rooftop viewing)
  AppState.mapLayers.satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri &mdash; High-Res Satellite',
    maxZoom: 20
  });

  // OpenStreetMap Standard Street layer
  AppState.mapLayers.streets = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19
  });

  // Street labels overlay
  AppState.mapLayers.labels = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd',
    maxZoom: 20
  });

  if (AppState.currentMapType === 'satellite') {
    AppState.mapLayers.satellite.addTo(AppState.map);
    AppState.mapLayers.labels.addTo(AppState.map);
    document.getElementById('map-mode-indicator').textContent = 'Esri High-Res Satellite';
  } else {
    AppState.mapLayers.streets.addTo(AppState.map);
    document.getElementById('map-mode-indicator').textContent = 'OpenStreetMap';
  }

  // Custom Solar Pin
  const solarPinIcon = L.divIcon({
    className: 'custom-solar-pin',
    html: `<div style="background-color: #F59E0B; border: 2.5px solid #0F356B; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 8px rgba(0,0,0,0.5); cursor: grab;"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0F356B" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15]
  });

  AppState.marker = L.marker([lat, lon], {
    icon: solarPinIcon,
    draggable: true
  }).addTo(AppState.map);

  AppState.marker.bindPopup(`<b>${AppState.project.displayLocation}</b><br><span style="font-size:11px;color:#666;">Solar Installation Rooftop</span>`).openPopup();

  // On marker drag end, reverse geocode and update
  AppState.marker.on('dragend', async (e) => {
    const pos = e.target.getLatLng();
    await onMapLocationSelected(pos.lat, pos.lng);
  });

  // On map click, move marker and update
  AppState.map.on('click', async (e) => {
    AppState.marker.setLatLng(e.latlng);
    await onMapLocationSelected(e.latlng.lat, e.latlng.lng);
  });
}

function tryLoadGoogleMaps(lat, lon) {
  WeatherService.loadGoogleMapsApi(AppState.googleApiKey)
    .then((gMaps) => {
      const container = document.getElementById('map-container');
      container.innerHTML = '';

      const mapOptions = {
        center: { lat: lat, lng: lon },
        zoom: 19,
        mapTypeId: 'hybrid',
        tilt: 0,
        mapTypeControl: false,
        streetViewControl: false
      };

      AppState.googleMap = new gMaps.Map(container, mapOptions);

      AppState.googleMarker = new gMaps.Marker({
        position: { lat: lat, lng: lon },
        map: AppState.googleMap,
        draggable: true,
        title: AppState.project.displayLocation,
        animation: gMaps.Animation.DROP
      });

      AppState.googleMarker.addListener('dragend', async () => {
        const p = AppState.googleMarker.getPosition();
        await onMapLocationSelected(p.lat(), p.lng());
      });

      AppState.googleMap.addListener('click', async (e) => {
        AppState.googleMarker.setPosition(e.latLng);
        await onMapLocationSelected(e.latLng.lat(), e.latLng.lng());
      });

      // Attach Google Places Autocomplete if search box exists
      const searchBoxInput = document.getElementById('input-search-location');
      if (searchBoxInput && gMaps.places) {
        try {
          const autocomplete = new gMaps.places.Autocomplete(searchBoxInput);
          autocomplete.addListener('place_changed', async () => {
            const place = autocomplete.getPlace();
            if (place.geometry && place.geometry.location) {
              const pLat = place.geometry.location.lat();
              const pLng = place.geometry.location.lng();
              AppState.googleMap.setCenter({ lat: pLat, lng: pLng });
              AppState.googleMap.setZoom(19);
              AppState.googleMarker.setPosition({ lat: pLat, lng: pLng });
              await onMapLocationSelected(pLat, pLng, place.formatted_address);
            }
          });
        } catch (autoErr) {
          console.warn('Google Places Autocomplete init notice:', autoErr);
        }
      }

      document.getElementById('map-mode-indicator').textContent = 'Google Satellite Hybrid';
    })
    .catch((err) => {
      console.warn('Google Maps initialization failed, using high-res Esri Satellite:', err.message);
      initLeafletMap(lat, lon);
    });
}

/**
 * Handle new location selected on Map (Click, Drag, or Autocomplete)
 */
async function onMapLocationSelected(lat, lon, knownAddress = null) {
  AppState.project.lat = Math.round(lat * 10000) / 10000;
  AppState.project.lon = Math.round(lon * 10000) / 10000;

  document.getElementById('input-lat').value = AppState.project.lat;
  document.getElementById('input-lon').value = AppState.project.lon;

  // Reverse geocode to get exact address and Plus Code
  let displayLoc = knownAddress;
  if (!displayLoc) {
    const rev = await WeatherService.reverseGeocode(lat, lon, AppState.googleApiKey);
    if (rev && rev.displayName) {
      displayLoc = rev.displayName;
    } else {
      const plus = WeatherService.encodePlusCode(lat, lon).substring(0, 9);
      displayLoc = `${plus}, Site Location (${AppState.project.lat}°N, ${AppState.project.lon}°E)`;
    }
  }

  AppState.project.displayLocation = displayLoc;
  document.getElementById('input-display-location').value = displayLoc;
  document.getElementById('input-search-location').value = displayLoc;
  document.getElementById('report-location-subtitle').textContent = `Project location: ${displayLoc}`;

  if (AppState.marker) {
    AppState.marker.bindPopup(`<b>${displayLoc}</b>`).openPopup();
  }

  // Fetch solar insolation and recalculate
  fetchWeatherAndUpdate();
}

/**
 * Update coordinates and trigger recalculation
 */
function updateCoordinates(lat, lon, fetchWeather = false) {
  AppState.project.lat = Math.round(lat * 10000) / 10000;
  AppState.project.lon = Math.round(lon * 10000) / 10000;

  document.getElementById('input-lat').value = AppState.project.lat;
  document.getElementById('input-lon').value = AppState.project.lon;

  if (fetchWeather) {
    fetchWeatherAndUpdate();
  } else {
    runSimulation();
  }
}

/**
 * Fetch Satellite Solar Irradiance from Open-Meteo
 */
async function fetchWeatherAndUpdate() {
  const badge = document.getElementById('weather-badge');
  if (badge) {
    badge.textContent = 'Syncing Satellite Solar...';
    badge.className = 'text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/40 px-2 py-0.5 rounded font-mono calculating';
  }

  const res = await WeatherService.fetchSolarData(AppState.project.lat, AppState.project.lon);
  if (res && res.success && res.monthlyData) {
    AppState.weatherData = res.monthlyData;
    if (badge) {
      badge.textContent = 'Satellite Solar Active (ERA5)';
      badge.className = 'text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-2 py-0.5 rounded font-mono';
    }
  } else {
    AppState.weatherData = null; // Uses Universal Physics Climatology model
    if (badge) {
      badge.textContent = 'PVsyst Climatology Active';
      badge.className = 'text-[10px] bg-blue-500/20 text-blue-300 border border-blue-500/40 px-2 py-0.5 rounded font-mono';
    }
  }

  runSimulation();
}

/**
 * Main Simulation Execution
 */
function runSimulation() {
  const params = {
    systemCapacity: AppState.pv.capacityKwp,
    lat: AppState.project.lat,
    lon: AppState.project.lon,
    tilt: AppState.pv.tiltDeg,
    azimuth: AppState.pv.azimuthDeg,
    installedCostPerKwp: AppState.financials.costPerKwp,
    electricityTariff: AppState.financials.tariff,
    annualDegradation: AppState.financials.degradationPct,
    tariffEscalation: AppState.financials.escalationPct,
    soilingLoss: AppState.pv.losses.soiling,
    wiringLoss: AppState.pv.losses.wiring,
    inverterLoss: AppState.pv.losses.inverter,
    mismatchLoss: AppState.pv.losses.mismatch,
    weatherMonthlyData: AppState.weatherData
  };

  const result = PVEngine.simulate(params);
  AppState.simulationResult = result;

  renderDashboard(result);
}

/**
 * Render all tables, KPIs, charts, and diagrams
 */
function renderDashboard(res) {
  const { summary, monthlyReport, inputs, losses } = res;

  // 1. Update KPI Summary Cards
  document.getElementById('kpi-capacity').textContent = `${inputs.capacityKwp.toFixed(2)} kWp`;
  document.getElementById('kpi-generation').textContent = `${PVEngine.formatNumber(summary.annualGenerationKwh)} kWh`;
  document.getElementById('kpi-avg-monthly').textContent = `${PVEngine.formatNumber(summary.monthlyAverageGen)} kWh / month`;
  document.getElementById('kpi-yield').textContent = PVEngine.formatNumber(summary.annualYieldKwhPerKwp);
  document.getElementById('kpi-bill-offset').textContent = PVEngine.formatINR(summary.annualBillOffset);
  document.getElementById('kpi-avg-offset').textContent = `${PVEngine.formatINR(summary.monthlyAverageOffset)} / month`;
  document.getElementById('kpi-payback').textContent = `${summary.simplePaybackYears} Yrs`;
  document.getElementById('kpi-capex-sub').textContent = `₹${summary.installedCostLakh} Lakh CAPEX`;
  document.getElementById('kpi-net-benefit').textContent = `₹${(summary.net25YearBenefit / 100000).toFixed(2)} L`;

  document.getElementById('badge-kwp-top').textContent = `${inputs.capacityKwp.toFixed(2)} kWp`;

  // Roof & Panels estimation
  const estPanels = Math.round((inputs.capacityKwp * 1000) / 550);
  const estRoofSqFt = Math.round(inputs.capacityKwp * 100);
  const estRoofSqM = Math.round(estRoofSqFt * 0.0929);
  const statPanelEl = document.getElementById('stat-panel-count');
  if (statPanelEl) {
    statPanelEl.textContent = `${estPanels} to ${estPanels + 2} Modules`;
  }

  // Environmental
  document.getElementById('env-annual-co2').textContent = `${summary.annualCo2Tons} Tons`;
  document.getElementById('env-lifetime-co2').textContent = `${summary.lifetimeCo2Tons} Tons`;
  document.getElementById('env-trees').textContent = `${PVEngine.formatNumber(summary.equivalentTrees)} Trees`;

  // 2. Render Section 2: Month-Wise Generation Report Table
  const reportSubtitle = document.getElementById('report-location-subtitle');
  if (reportSubtitle) {
    reportSubtitle.textContent = `Project location: ${AppState.project.displayLocation}`;
  }

  const thTariff = document.getElementById('th-tariff-header');
  if (thTariff) {
    thTariff.textContent = `Bill offset @ ₹${inputs.tariff.toFixed(2)}/unit`;
  }

  const tbodyMonthly = document.getElementById('tbody-monthly-generation');
  tbodyMonthly.innerHTML = '';

  monthlyReport.forEach((row) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="font-medium">${row.monthName}</td>
      <td>${PVEngine.formatNumber(row.yieldKwhPerKwp)}</td>
      <td>${PVEngine.formatNumber(row.generationKwh)}</td>
      <td class="text-right sm:text-left">${PVEngine.formatINR(row.billOffset)}</td>
    `;
    tbodyMonthly.appendChild(tr);
  });

  document.getElementById('td-total-yield').textContent = PVEngine.formatNumber(summary.annualYieldKwhPerKwp);
  document.getElementById('td-total-generation').textContent = PVEngine.formatNumber(summary.annualGenerationKwh);
  document.getElementById('td-total-offset').textContent = PVEngine.formatINR(summary.annualBillOffset);

  // Dynamic disclaimer mentioning the exact location
  document.getElementById('report-generation-disclaimer').textContent = 
    `Estimated annual generation: ${PVEngine.formatNumber(summary.annualGenerationKwh)} kWh (${PVEngine.formatNumber(summary.monthlyAverageGen)} kWh/month average). These are planning estimates based on an indicative profile for ${AppState.project.displayLocation}, not guaranteed output or a site-specific simulation.`;

  // 3. Render Section 3: Indicative ROI / Simple Payback Table
  document.getElementById('roi-installed-cost').textContent = 
    `₹${PVEngine.formatNumber(inputs.costPerKwp)}/kWp × ${inputs.capacityKwp.toFixed(2)} kWp = ${PVEngine.formatINR(summary.totalInstalledCost)} (₹${summary.installedCostLakh} lakh)`;
  document.getElementById('roi-annual-generation').textContent = 
    `${PVEngine.formatNumber(summary.annualGenerationKwh)} units`;
  document.getElementById('roi-electricity-tariff').textContent = 
    `₹${inputs.tariff.toFixed(2)} per unit`;
  document.getElementById('roi-annual-offset').textContent = 
    `${PVEngine.formatINR(summary.annualBillOffset)} (average ${PVEngine.formatINR(summary.monthlyAverageOffset)}/month)`;
  document.getElementById('roi-simple-payback').textContent = 
    `${summary.simplePaybackYears} years before O&M, degradation, financing and replacement costs`;
  document.getElementById('roi-gross-offset').textContent = 
    `${PVEngine.formatINR(summary.gross25YearOffset)}, assuming constant generation and tariff`;
  document.getElementById('roi-net-benefit').textContent = 
    `${PVEngine.formatINR(summary.net25YearBenefit)} after initial cost only; excludes O&M/replacements`;

  // 4. Render Charts
  renderCharts(monthlyReport, res.cashFlow25);

  // 4b. Render Hourly and 7-Day Forecast Tab
  renderForecastTab(res);

  // 5. Render PVsyst Loss Tree
  renderLossTree(losses, summary.annualGenerationKwh);

  // 6. Render 25-Year Cash Flow Table
  renderCashFlowTable(res.cashFlow25);

  // 7. Update BOM specs
  document.getElementById('tech-pr').textContent = `${losses.overallPR}%`;
  document.getElementById('bom-dc-size').textContent = `${inputs.capacityKwp.toFixed(2)} kWp`;
  const invSize = (inputs.capacityKwp / 1.22).toFixed(1);
  document.getElementById('bom-ac-size').textContent = `${invSize} kW`;
  document.getElementById('bom-module-count').textContent = `${estPanels} Modules`;
  document.getElementById('bom-roof-sqft').textContent = `~${PVEngine.formatNumber(estRoofSqFt)} sq ft`;
  document.getElementById('bom-daily-units').textContent = `${(summary.annualGenerationKwh / 365).toFixed(1)} Units/day`;
}

/**
 * Render Interactive Charts using Chart.js
 */
function renderCharts(monthlyReport, cashflow) {
  const ctxGen = document.getElementById('chart-monthly-generation');
  if (ctxGen) {
    if (AppState.charts.monthlyGen) {
      AppState.charts.monthlyGen.destroy();
    }

    const labels = monthlyReport.map(r => r.monthName.substring(0, 3));
    const genData = monthlyReport.map(r => r.generationKwh);
    const yieldData = monthlyReport.map(r => r.yieldKwhPerKwp);

    AppState.charts.monthlyGen = new Chart(ctxGen, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            type: 'bar',
            label: 'Generation (kWh)',
            data: genData,
            backgroundColor: '#0F356B',
            borderRadius: 4,
            yAxisID: 'y'
          },
          {
            type: 'line',
            label: 'Specific Yield (kWh/kWp)',
            data: yieldData,
            borderColor: '#F59E0B',
            backgroundColor: '#F59E0B',
            borderWidth: 2.5,
            pointRadius: 4,
            pointHoverRadius: 6,
            yAxisID: 'y1'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: (ctx) => ctx.dataset.type === 'line'
                ? `Yield: ${ctx.raw} kWh/kWp`
                : `Generation: ${PVEngine.formatNumber(ctx.raw)} kWh`
            }
          }
        },
        scales: {
          y: {
            type: 'linear',
            position: 'left',
            title: { display: true, text: 'Energy Generation (kWh)' },
            grid: { color: '#F1F5F9' }
          },
          y1: {
            type: 'linear',
            position: 'right',
            title: { display: true, text: 'Yield (kWh/kWp)' },
            grid: { drawOnChartArea: false }
          }
        }
      }
    });
  }

  const ctxCash = document.getElementById('chart-cashflow');
  if (ctxCash) {
    if (AppState.charts.cashflow) {
      AppState.charts.cashflow.destroy();
    }

    const years = cashflow.map(c => `Yr ${c.year}`);
    const cumulative = cashflow.map(c => c.cumulativeSavings);

    AppState.charts.cashflow = new Chart(ctxCash, {
      type: 'line',
      data: {
        labels: years,
        datasets: [
          {
            label: 'Cumulative Net Position (₹)',
            data: cumulative,
            borderColor: '#10B981',
            backgroundColor: 'rgba(16, 185, 129, 0.1)',
            fill: true,
            tension: 0.2,
            borderWidth: 3,
            pointRadius: 3
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => `Cumulative Savings: ${PVEngine.formatINR(ctx.raw)}`
            }
          }
        },
        scales: {
          y: {
            grid: { color: '#F1F5F9' },
            ticks: {
              callback: (val) => `₹${(val / 100000).toFixed(1)} L`
            }
          }
        }
      }
    });
  }
}

/**
 * Render Hourly (current hour to 12 AM midnight) and Next 7-Day Forecast Tab
 */
function renderForecastTab(res) {
  const capacityKwp = res?.inputs?.capacityKwp || AppState.pv.capacityKwp || 36.6;
  const tariff = res?.inputs?.tariff || AppState.financials.tariff || 7.5;
  const pr = ((res?.losses?.overallPR || 79) / 100);
  const isWatt = (AppState.forecastUnit === 'W');

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const now = new Date();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const selectedDayOffset = AppState.forecastSelectedDayOffset || 0;
  const targetDate = new Date(now.getTime() + selectedDayOffset * 86400000);
  const isToday = selectedDayOffset === 0;
  const isTomorrow = selectedDayOffset === 1;

  // 1. Update Unit Toggle Buttons (kW vs W)
  const activeBtnClass = 'px-2.5 py-1 rounded-md bg-[#0F356B] text-white shadow-xs transition';
  const inactiveBtnClass = 'px-2.5 py-1 rounded-md text-slate-600 hover:text-slate-900 transition';

  const btnForecastKw = document.getElementById('btn-forecast-unit-kw');
  const btnForecastW = document.getElementById('btn-forecast-unit-w');
  const btnDailyKw = document.getElementById('btn-daily-unit-kw');
  const btnDailyW = document.getElementById('btn-daily-unit-w');

  if (btnForecastKw) btnForecastKw.className = !isWatt ? activeBtnClass : inactiveBtnClass;
  if (btnForecastW) btnForecastW.className = isWatt ? activeBtnClass : inactiveBtnClass;
  if (btnDailyKw) btnDailyKw.className = !isWatt ? activeBtnClass : inactiveBtnClass;
  if (btnDailyW) btnDailyW.className = isWatt ? activeBtnClass : inactiveBtnClass;

  // Update table header labels
  const thColPower = document.getElementById('th-col-power');
  if (thColPower) thColPower.textContent = isWatt ? 'Est. Power (W)' : 'Est. Power (kW)';
  const thColEnergy = document.getElementById('th-col-energy');
  if (thColEnergy) thColEnergy.textContent = isWatt ? 'Energy Yield (Wh)' : 'Energy Yield (kWh)';

  // Update chart header labels
  const lblHourlyUnits = document.getElementById('lbl-hourly-chart-units');
  if (lblHourlyUnits) lblHourlyUnits.textContent = isWatt ? 'Hourly Solar Power Generation Curve (W / Wh)' : 'Hourly Solar Power Generation Curve (kW / kWh)';
  const lblDailyUnits = document.getElementById('lbl-daily-chart-units');
  if (lblDailyUnits) lblDailyUnits.textContent = isWatt ? 'Daily Projected Generation (Wh/day)' : 'Daily Projected Generation (kWh/day)';

  // 2. Update Title and Day Label
  const titleTextEl = document.getElementById('forecast-hourly-title-text');
  if (titleTextEl) {
    if (isToday) {
      titleTextEl.textContent = "TODAY'S HOURLY SOLAR ESTIMATION (UNTIL 12:00 AM MIDNIGHT)";
    } else if (isTomorrow) {
      titleTextEl.textContent = "TOMORROW'S HOURLY SOLAR ESTIMATION (UNTIL 12:00 AM MIDNIGHT)";
    } else {
      const dName = dayNames[targetDate.getDay()].toUpperCase();
      const dFormatted = `${targetDate.getDate()} ${monthNames[targetDate.getMonth()]}`;
      titleTextEl.textContent = `${dName}'S HOURLY SOLAR ESTIMATION (${dFormatted} UNTIL 12:00 AM MIDNIGHT)`;
    }
  }

  const dayLabelEl = document.getElementById('hourly-selected-day-label');
  if (dayLabelEl) {
    if (isToday) {
      dayLabelEl.textContent = `Today (${now.getDate()} ${monthNames[now.getMonth()]})`;
    } else if (isTomorrow) {
      dayLabelEl.textContent = `Tomorrow (${targetDate.getDate()} ${monthNames[targetDate.getMonth()]})`;
    } else {
      dayLabelEl.textContent = `${dayNames[targetDate.getDay()]} (${targetDate.getDate()} ${monthNames[targetDate.getMonth()]})`;
    }
  }

  const btnPrev = document.getElementById('btn-hourly-prev');
  const btnNext = document.getElementById('btn-hourly-next');
  if (btnPrev) btnPrev.disabled = isToday;
  if (btnNext) btnNext.disabled = selectedDayOffset >= 7;

  // Subtitle
  const locSubtitle = document.getElementById('forecast-location-subtitle');
  if (locSubtitle) {
    const targetLabel = isToday ? 'Today' : (isTomorrow ? 'Tomorrow' : `${dayNames[targetDate.getDay()]}, ${targetDate.getDate()} ${monthNames[targetDate.getMonth()]}`);
    const plantCapacityStr = isWatt ? `${Math.round(capacityKwp * 1000).toLocaleString()} Wp` : `${capacityKwp.toFixed(2)} kWp`;
    locSubtitle.textContent = `Location: ${AppState.project.displayLocation} • Plant: ${plantCapacityStr} • Viewing ${targetLabel}`;
  }

  // Current time badge
  const timeBadge = document.getElementById('forecast-current-time-badge');
  if (timeBadge) {
    timeBadge.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span> Current Time: ${timeStr}`;
  }

  // 2. Build Hourly Data
  const dailyVariances = [1.03, 0.97, 1.05, 0.98, 1.02, 0.99, 1.01];
  const variance = isToday ? 1.0 : (dailyVariances[selectedDayOffset - 1] || 1.0);
  const startHour = isToday ? currentHour : 0;

  const hourlyRows = [];
  const hourlyLabels = [];
  const hourlyKwData = [];
  const hourlyKwhData = [];

  let totalDayKwh = 0;
  let totalDaySavings = 0;
  let peakPower = 0;
  let sumGhi = 0;
  let hoursWithSun = 0;

  for (let h = startHour; h <= 24; h++) {
    let timeLabel = '';
    let chartLabel = '';
    if (h === 0 || h === 24) {
      timeLabel = '12:00 AM (Midnight)';
      chartLabel = '12 AM';
    } else if (h < 12) {
      timeLabel = `${h}:00 AM – ${h + 1}:00 AM`;
      chartLabel = `${h} AM`;
    } else if (h === 12) {
      timeLabel = '12:00 PM – 1:00 PM';
      chartLabel = '12 PM';
    } else {
      timeLabel = `${h - 12}:00 PM – ${h === 23 ? '12:00 AM' : (h - 11) + ':00 PM'}`;
      chartLabel = `${h - 12} PM`;
    }

    if (isToday && h === currentHour) {
      chartLabel += ' (Now)';
      timeLabel = `${timeStr} – ${h === 23 ? '12:00 AM' : (h >= 12 ? (h === 12 ? 1 : h - 11) + ':00 PM' : (h + 1) + ':00 AM')}`;
    }

    let ghi = 0;
    if (h >= 6 && h <= 18) {
      const solarTime = (isToday && h === currentHour) ? (h + currentMinute / 60) : (h + 0.5);
      const angle = ((solarTime - 6) / 12) * Math.PI;
      if (angle > 0 && angle < Math.PI) {
        ghi = Math.round(920 * variance * Math.pow(Math.sin(angle), 1.2));
      }
    } else if (isToday && h === 18 && currentMinute < 45) {
      ghi = 25; // twilight
    }

    const hourFraction = (isToday && h === currentHour) ? Math.max(0.05, (60 - currentMinute) / 60) : 1.0;
    const powerKw = Math.max(0, capacityKwp * (ghi / 1000) * pr);
    const energyKwh = powerKw * hourFraction;
    const savings = energyKwh * tariff;

    if (ghi > 0) {
      sumGhi += ghi;
      hoursWithSun++;
    }
    if (powerKw > peakPower) peakPower = powerKw;
    totalDayKwh += energyKwh;
    totalDaySavings += savings;

    let sunStatus = '';
    let statusClass = '';
    if (ghi >= 600) {
      sunStatus = 'High Solar Yield';
      statusClass = 'text-amber-600 font-bold';
    } else if (ghi >= 250) {
      sunStatus = 'Moderate Solar';
      statusClass = 'text-amber-500 font-medium';
    } else if (ghi > 0) {
      sunStatus = 'Twilight / Low Sun';
      statusClass = 'text-orange-400 font-medium';
    } else {
      sunStatus = 'Night (Standby)';
      statusClass = 'text-slate-400 font-mono';
    }

    hourlyRows.push({
      timeLabel,
      ghi,
      powerKw,
      energyKwh,
      savings,
      sunStatus,
      statusClass,
      isCurrent: isToday && (h === currentHour)
    });

    hourlyLabels.push(chartLabel);
    hourlyKwData.push(isWatt ? Math.round(powerKw * 1000) : (Math.round(powerKw * 100) / 100));
    hourlyKwhData.push(isWatt ? Math.round(energyKwh * 1000) : (Math.round(energyKwh * 100) / 100));
  }

  // Update badges
  const remainingBadge = document.getElementById('forecast-remaining-today-badge');
  if (remainingBadge) {
    const badgeLabel = isToday ? 'Remaining Today' : (isTomorrow ? 'Tomorrow Projected' : `${dayNames[targetDate.getDay()]} Projected`);
    const formattedYield = isWatt ? `${Math.round(totalDayKwh * 1000).toLocaleString()} Wh` : `${totalDayKwh.toFixed(2)} kWh`;
    remainingBadge.textContent = `${badgeLabel}: ${formattedYield} (₹${totalDaySavings.toFixed(0)})`;
  }
  const thGhi = document.getElementById('th-remaining-ghi');
  if (thGhi) thGhi.textContent = hoursWithSun > 0 ? `${Math.round(sumGhi / hoursWithSun)} W/m² avg` : '0 W/m²';
  const thPeak = document.getElementById('th-remaining-peak-power');
  if (thPeak) {
    thPeak.textContent = isWatt ? `${Math.round(peakPower * 1000).toLocaleString()} W max` : `${peakPower.toFixed(2)} kW max`;
  }
  const thKwh = document.getElementById('th-remaining-kwh');
  if (thKwh) {
    thKwh.textContent = isWatt ? `${Math.round(totalDayKwh * 1000).toLocaleString()} Wh` : `${totalDayKwh.toFixed(2)} kWh`;
  }
  const thSavings = document.getElementById('th-remaining-savings');
  if (thSavings) thSavings.textContent = `₹${totalDaySavings.toFixed(2)}`;

  // Populate Hourly Table
  const tbodyHourly = document.getElementById('tbody-hourly-forecast');
  if (tbodyHourly) {
    tbodyHourly.innerHTML = hourlyRows.map(r => {
      const powerStr = isWatt
        ? (r.powerKw > 0 ? `${Math.round(r.powerKw * 1000).toLocaleString()} W` : '<span class="text-slate-400">0 W</span>')
        : (r.powerKw > 0 ? `${r.powerKw.toFixed(2)} kW` : '<span class="text-slate-400">0.00 kW</span>');
      const energyStr = isWatt
        ? (r.energyKwh > 0 ? `${Math.round(r.energyKwh * 1000).toLocaleString()} Wh` : '<span class="text-slate-400">0 Wh</span>')
        : (r.energyKwh > 0 ? `${r.energyKwh.toFixed(2)} kWh` : '<span class="text-slate-400">0.00 kWh</span>');

      return `
        <tr class="${r.isCurrent ? 'bg-amber-50/70 font-semibold' : ''}">
          <td class="font-medium text-slate-800">${r.timeLabel} ${r.isCurrent ? '<span class="text-[10px] bg-amber-200 text-amber-900 px-1 rounded ml-1 font-bold">Current</span>' : ''}</td>
          <td class="font-mono text-slate-700">${r.ghi > 0 ? r.ghi + ' W/m²' : '<span class="text-slate-400">0 W/m²</span>'}</td>
          <td class="font-mono font-bold text-[#0F356B]">${powerStr}</td>
          <td class="font-mono font-bold text-emerald-600">${energyStr}</td>
          <td class="${r.statusClass}">${r.sunStatus}</td>
        </tr>
      `;
    }).join('');
  }

  // Render Hourly Chart
  const ctxHourly = document.getElementById('chart-hourly-forecast');
  if (ctxHourly) {
    if (AppState.charts.hourlyForecast) {
      AppState.charts.hourlyForecast.destroy();
    }
    const powerUnit = isWatt ? 'W' : 'kW';
    const energyUnit = isWatt ? 'Wh' : 'kWh';

    AppState.charts.hourlyForecast = new Chart(ctxHourly, {
      type: 'line',
      data: {
        labels: hourlyLabels,
        datasets: [
          {
            label: `Solar Power (${powerUnit})`,
            data: hourlyKwData,
            borderColor: '#F59E0B',
            backgroundColor: 'rgba(245, 158, 11, 0.15)',
            borderWidth: 2.5,
            fill: true,
            tension: 0.35,
            pointRadius: 3,
            pointBackgroundColor: '#F59E0B'
          },
          {
            label: `Energy Yield (${energyUnit})`,
            data: hourlyKwhData,
            borderColor: '#3B82F6',
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            borderWidth: 2,
            borderDash: [4, 4],
            fill: false,
            tension: 0.3,
            pointRadius: 2,
            pointBackgroundColor: '#3B82F6'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11, weight: 'bold' } } },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.dataset.label}: ${ctx.raw.toLocaleString()} ${ctx.datasetIndex === 0 ? powerUnit : energyUnit}`
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            title: { display: true, text: `Power (${powerUnit}) / Yield (${energyUnit})`, font: { size: 10, weight: 'bold' } },
            ticks: { font: { size: 10 } }
          },
          x: {
            ticks: { font: { size: 10 } }
          }
        }
      }
    });
  }

  // 3. Build Next 7-Day Solar Forecast Cards & Chart
  const currentMonthIdx = now.getMonth();
  const baseDailyGhi = (res?.monthlyReport && res.monthlyReport[currentMonthIdx])
    ? res.monthlyReport[currentMonthIdx].yieldKwhPerKwp / 30
    : 4.8;

  const weatherConditions = [
    { text: 'Clear / Sunny', icon: 'sun', color: 'text-amber-500' },
    { text: 'Mostly Sunny', icon: 'sun-medium', color: 'text-amber-500' },
    { text: 'Clear Sky', icon: 'sun', color: 'text-amber-500' },
    { text: 'Scattered Clouds', icon: 'cloud-sun', color: 'text-blue-500' },
    { text: 'High Solar Yield', icon: 'sun', color: 'text-amber-500' },
    { text: 'Mostly Sunny', icon: 'sun-medium', color: 'text-amber-500' },
    { text: 'Clear Sky', icon: 'sun', color: 'text-amber-500' }
  ];

  const dailyLabels = [];
  const dailyChartData = [];
  const dailyCardsHtml = [];
  let total7DayKwh = 0;
  let total7DaySavings = 0;

  for (let d = 1; d <= 7; d++) {
    const dDate = new Date(now.getTime() + d * 86400000);
    const shortLabel = `${dayNames[dDate.getDay()]} ${dDate.getDate()}`;
    const isSelected = selectedDayOffset === d;

    const factor = dailyVariances[d - 1];
    const cond = weatherConditions[d - 1];

    const dayYieldKwhPerKwp = Math.round(baseDailyGhi * factor * 100) / 100;
    const dayKwh = Math.round(capacityKwp * dayYieldKwhPerKwp * pr * 10) / 10;
    const daySavings = Math.round(dayKwh * tariff);

    total7DayKwh += dayKwh;
    total7DaySavings += daySavings;

    dailyLabels.push(shortLabel);
    const dayEnergyChartVal = isWatt ? Math.round(dayKwh * 1000) : dayKwh;
    dailyChartData.push(dayEnergyChartVal);

    const cardEnergyDisp = isWatt ? Math.round(dayKwh * 1000).toLocaleString() : dayKwh.toFixed(0);
    const cardUnitDisp = isWatt ? 'Wh' : 'kWh';
    const cardYieldDisp = isWatt ? `${dayYieldKwhPerKwp.toFixed(2)} Wh/Wp` : `${dayYieldKwhPerKwp.toFixed(2)} kWh/kWp`;

    dailyCardsHtml.push(`
      <div class="rounded-xl p-3 flex flex-col justify-between transition cursor-pointer ${
        isSelected
          ? 'bg-blue-50/80 border-2 border-blue-600 shadow-md ring-2 ring-blue-200'
          : 'bg-slate-50 border border-slate-200 hover:border-blue-400 hover:shadow-xs'
      }" data-day-offset="${d}">
        <div>
          <div class="flex items-center justify-between">
            <span class="text-xs font-bold ${isSelected ? 'text-blue-900 font-black' : 'text-slate-800'}">${shortLabel}</span>
            <i data-lucide="${cond.icon}" class="w-4 h-4 ${cond.color}"></i>
          </div>
          <span class="text-[10px] text-slate-500 block mb-1.5">${cond.text}</span>
          <div class="text-lg font-black text-emerald-600 font-mono">${cardEnergyDisp} <span class="text-[10px] font-normal text-slate-500">${cardUnitDisp}</span></div>
        </div>
        <div class="pt-2 border-t border-slate-200 mt-2 text-[11px] font-mono">
          <div class="text-slate-600 flex justify-between">
            <span>Yield:</span>
            <span class="font-bold text-slate-800">${cardYieldDisp}</span>
          </div>
        </div>
        <button type="button" class="btn-day-card-hourly flex items-center justify-between text-[11px] font-bold ${
          isSelected
            ? 'bg-blue-600 text-white'
            : 'text-blue-700 hover:text-blue-900 bg-white hover:bg-blue-100/60 border border-blue-200'
        } px-2 py-1.5 rounded-md mt-2 w-full transition shadow-2xs" data-day-offset="${d}">
          <span>${isSelected ? '✓ Active View' : 'Hourly Data'}</span>
          <i data-lucide="chevron-right" class="w-3.5 h-3.5 ${isSelected ? 'text-white' : 'text-blue-600'}"></i>
        </button>
      </div>
    `);
  }

  const badge7Day = document.getElementById('forecast-7day-total-badge');
  if (badge7Day) {
    const formatted7DayYield = isWatt ? `${Math.round(total7DayKwh * 1000).toLocaleString()} Wh` : `${total7DayKwh.toFixed(0)} kWh`;
    badge7Day.textContent = `7-Day Total: ${formatted7DayYield}`;
  }

  const grid7Day = document.getElementById('grid-daily-forecast');
  if (grid7Day) {
    grid7Day.innerHTML = dailyCardsHtml.join('');

    // Attach click listener to each card and its right button
    grid7Day.querySelectorAll('.btn-day-card-hourly, [data-day-offset]').forEach(el => {
      el.addEventListener('click', (e) => {
        const offset = parseInt(el.getAttribute('data-day-offset'), 10);
        if (!isNaN(offset)) {
          AppState.forecastSelectedDayOffset = offset;
          renderForecastTab(AppState.simulationResult);
          document.getElementById('forecast-hourly-title-text')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
    });

    if (window.lucide) lucide.createIcons();
  }

  const ctxDaily = document.getElementById('chart-daily-forecast');
  if (ctxDaily) {
    if (AppState.charts.dailyForecast) {
      AppState.charts.dailyForecast.destroy();
    }
    const dailyUnit = isWatt ? 'Wh' : 'kWh';

    AppState.charts.dailyForecast = new Chart(ctxDaily, {
      type: 'bar',
      data: {
        labels: dailyLabels,
        datasets: [
          {
            label: `Daily Generation (${dailyUnit})`,
            data: dailyChartData,
            backgroundColor: dailyLabels.map((_, idx) => (selectedDayOffset === idx + 1 ? '#0F356B' : '#10B981')),
            borderRadius: 6,
            hoverBackgroundColor: '#059669'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => `Estimated: ${ctx.raw.toLocaleString()} ${dailyUnit}`
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            title: { display: true, text: `Energy (${dailyUnit}/day)`, font: { size: 10, weight: 'bold' } },
            ticks: { font: { size: 10 } }
          },
          x: {
            ticks: { font: { size: 10, weight: 'bold' } }
          }
        }
      }
    });
  }

  if (window.lucide) lucide.createIcons();
}

/**
 * Render PVsyst Waterfall Loss Tree
 */
function renderLossTree(losses, finalGen) {
  const container = document.getElementById('loss-tree-container');
  if (!container) return;

  const steps = [
    { name: 'Nominal Incident Solar Irradiance on Array Plane', loss: null, pctRemaining: 100 },
    { name: 'Soiling & Dust Accumulation Loss', loss: `- ${losses.soiling}%`, pctRemaining: 100 - losses.soiling },
    { name: 'PV Cell Temperature Derate (Thermal Loss)', loss: `- ${losses.temperature}%`, pctRemaining: 100 - losses.soiling - losses.temperature },
    { name: 'DC Cable & Ohmic Resistance Loss', loss: `- ${losses.wiring}%`, pctRemaining: 100 - losses.soiling - losses.temperature - losses.wiring },
    { name: 'Inverter Efficiency & Conversion Loss', loss: `- ${losses.inverter}%`, pctRemaining: 100 - losses.soiling - losses.temperature - losses.wiring - losses.inverter },
    { name: 'Module Mismatch, Shading & LID Loss', loss: `- ${losses.mismatch}%`, pctRemaining: losses.overallPR },
    { name: 'Net AC Energy Injected to Grid / Load (PR)', loss: null, pctRemaining: losses.overallPR, isFinal: true }
  ];

  let html = '';
  steps.forEach((s) => {
    const barWidth = Math.max(10, Math.min(100, s.pctRemaining));
    const bgClass = s.isFinal ? 'bg-emerald-600' : 'bg-[#0F356B]';
    html += `
      <div class="space-y-1">
        <div class="flex justify-between text-xs">
          <span class="font-medium text-slate-700">${s.name}</span>
          <span class="font-bold font-mono ${s.isFinal ? 'text-emerald-700' : 'text-slate-500'}">
            ${s.loss ? `<span class="text-red-500 mr-2">${s.loss}</span>` : ''}
            ${s.pctRemaining.toFixed(1)}%
          </span>
        </div>
        <div class="w-full bg-slate-100 rounded-full h-3 overflow-hidden">
          <div class="${bgClass} h-3 rounded-full transition-all duration-500" style="width: ${barWidth}%"></div>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

/**
 * Render 25-Year Cash Flow Table
 */
function renderCashFlowTable(cashflow) {
  const tbody = document.getElementById('tbody-cashflow-25');
  if (!tbody) return;

  tbody.innerHTML = '';
  cashflow.forEach((c) => {
    const tr = document.createElement('tr');
    const isPositive = c.cumulativeSavings >= 0;
    tr.className = c.year % 5 === 0 ? 'bg-slate-50 font-semibold' : '';
    tr.innerHTML = `
      <td class="py-1.5 px-3">Year ${c.year}</td>
      <td class="py-1.5 px-3 font-mono">${PVEngine.formatNumber(c.generationKwh)}</td>
      <td class="py-1.5 px-3 font-mono">₹${c.tariffPerUnit}</td>
      <td class="py-1.5 px-3 font-mono text-emerald-700">${PVEngine.formatINR(c.annualSavings)}</td>
      <td class="py-1.5 px-3 font-mono ${isPositive ? 'text-emerald-700 font-bold' : 'text-red-600'}">
        ${PVEngine.formatINR(c.cumulativeSavings)}
      </td>
    `;
    tbody.appendChild(tr);
  });
}

/**
 * Event Listeners Setup
 */
function setupEventListeners() {
  // Capacity Input, Unit Toggle (kW vs W) & Slider
  const inputCap = document.getElementById('input-capacity');
  const sliderCap = document.getElementById('slider-capacity');
  const btnUnitKw = document.getElementById('btn-unit-kw');
  const btnUnitW = document.getElementById('btn-unit-w');
  const unitLabel = document.getElementById('capacity-unit-label');
  let currentCapacityUnit = 'kW';

  const updateCapacityUnitUI = () => {
    if (currentCapacityUnit === 'kW') {
      if (btnUnitKw) btnUnitKw.className = 'px-2 py-0.5 rounded-md bg-[#0F356B] text-white shadow-xs transition';
      if (btnUnitW) btnUnitW.className = 'px-2 py-0.5 rounded-md text-slate-600 hover:text-slate-900 transition';
      if (unitLabel) unitLabel.textContent = 'kWp';
      inputCap.step = '0.1';
      inputCap.min = '0.1';
      inputCap.max = '50000';
      inputCap.value = parseFloat(AppState.pv.capacityKwp.toFixed(2));
      sliderCap.min = '1';
      sliderCap.max = '250';
      sliderCap.step = '0.5';
      sliderCap.value = Math.min(250, AppState.pv.capacityKwp);
    } else {
      if (btnUnitW) btnUnitW.className = 'px-2 py-0.5 rounded-md bg-[#0F356B] text-white shadow-xs transition';
      if (btnUnitKw) btnUnitKw.className = 'px-2 py-0.5 rounded-md text-slate-600 hover:text-slate-900 transition';
      if (unitLabel) unitLabel.textContent = 'Wp';
      inputCap.step = '100';
      inputCap.min = '100';
      inputCap.max = '50000000';
      inputCap.value = Math.round(AppState.pv.capacityKwp * 1000);
      sliderCap.min = '1000';
      sliderCap.max = '250000';
      sliderCap.step = '500';
      sliderCap.value = Math.min(250000, Math.round(AppState.pv.capacityKwp * 1000));
    }
  };

  btnUnitKw?.addEventListener('click', () => {
    if (currentCapacityUnit === 'kW') return;
    currentCapacityUnit = 'kW';
    updateCapacityUnitUI();
  });

  btnUnitW?.addEventListener('click', () => {
    if (currentCapacityUnit === 'W') return;
    currentCapacityUnit = 'W';
    updateCapacityUnitUI();
  });

  const setCapacity = (valKw) => {
    const parsed = Math.max(0.01, parseFloat(valKw) || 1);
    AppState.pv.capacityKwp = parsed;

    if (currentCapacityUnit === 'kW') {
      inputCap.value = parsed;
      sliderCap.value = Math.min(250, parsed);
    } else {
      inputCap.value = Math.round(parsed * 1000);
      sliderCap.value = Math.min(250000, Math.round(parsed * 1000));
    }

    const roofAreaInput = document.getElementById('input-roof-area');
    if (roofAreaInput) roofAreaInput.value = Math.round(parsed * 100);

    runSimulation();
  };

  inputCap.addEventListener('input', (e) => {
    const raw = parseFloat(e.target.value) || 0;
    const kwVal = currentCapacityUnit === 'kW' ? raw : raw / 1000;
    AppState.pv.capacityKwp = Math.max(0.01, kwVal);

    if (currentCapacityUnit === 'kW') {
      sliderCap.value = Math.min(250, kwVal);
    } else {
      sliderCap.value = Math.min(250000, raw);
    }

    const roofAreaInput = document.getElementById('input-roof-area');
    if (roofAreaInput) roofAreaInput.value = Math.round(AppState.pv.capacityKwp * 100);

    runSimulation();
  });

  sliderCap.addEventListener('input', (e) => {
    const raw = parseFloat(e.target.value) || 0;
    const kwVal = currentCapacityUnit === 'kW' ? raw : raw / 1000;
    AppState.pv.capacityKwp = Math.max(0.01, kwVal);

    if (currentCapacityUnit === 'kW') {
      inputCap.value = kwVal;
    } else {
      inputCap.value = Math.round(raw);
    }

    const roofAreaInput = document.getElementById('input-roof-area');
    if (roofAreaInput) roofAreaInput.value = Math.round(AppState.pv.capacityKwp * 100);

    runSimulation();
  });

  // Quick Capacity Chips
  document.querySelectorAll('.cap-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kw = parseFloat(btn.getAttribute('data-kw'));
      if (kw) setCapacity(kw);
    });
  });

  // Roof Area Calculator button (safely optional)
  document.getElementById('btn-calc-from-roof')?.addEventListener('click', () => {
    const roofSqFt = parseFloat(document.getElementById('input-roof-area')?.value) || 3660;
    const calcKw = Math.round((roofSqFt / 100) * 10) / 10;
    setCapacity(calcKw);
  });

  // Map Layer toggle (Satellite vs Street)
  document.getElementById('btn-map-sat').addEventListener('click', () => {
    AppState.currentMapType = 'satellite';
    document.getElementById('btn-map-sat').className = 'px-1.5 py-0.5 text-[10px] font-bold rounded bg-blue-700 text-white';
    document.getElementById('btn-map-street').className = 'px-1.5 py-0.5 text-[10px] font-medium rounded bg-slate-100 text-slate-700 hover:bg-slate-200';

    if (AppState.googleMap) {
      AppState.googleMap.setMapTypeId('hybrid');
      document.getElementById('map-mode-indicator').textContent = 'Google Satellite Hybrid';
    } else if (AppState.map) {
      if (AppState.mapLayers.streets) AppState.map.removeLayer(AppState.mapLayers.streets);
      AppState.mapLayers.satellite.addTo(AppState.map);
      AppState.mapLayers.labels.addTo(AppState.map);
      document.getElementById('map-mode-indicator').textContent = 'Esri High-Res Satellite';
    }
  });

  document.getElementById('btn-map-street').addEventListener('click', () => {
    AppState.currentMapType = 'street';
    document.getElementById('btn-map-street').className = 'px-1.5 py-0.5 text-[10px] font-bold rounded bg-blue-700 text-white';
    document.getElementById('btn-map-sat').className = 'px-1.5 py-0.5 text-[10px] font-medium rounded bg-slate-100 text-slate-700 hover:bg-slate-200';

    if (AppState.googleMap) {
      AppState.googleMap.setMapTypeId('roadmap');
      document.getElementById('map-mode-indicator').textContent = 'Google Street Map';
    } else if (AppState.map) {
      if (AppState.mapLayers.satellite) AppState.map.removeLayer(AppState.mapLayers.satellite);
      if (AppState.mapLayers.labels) AppState.map.removeLayer(AppState.mapLayers.labels);
      AppState.mapLayers.streets.addTo(AppState.map);
      document.getElementById('map-mode-indicator').textContent = 'OpenStreetMap';
    }
  });

  // Tilt & Azimuth
  document.getElementById('input-tilt').addEventListener('input', (e) => {
    AppState.pv.tiltDeg = parseFloat(e.target.value) || 13;
    runSimulation();
  });

  document.getElementById('btn-auto-tilt').addEventListener('click', () => {
    const opt = PVEngine.calculateOptimalTilt(AppState.project.lat);
    AppState.pv.tiltDeg = opt;
    document.getElementById('input-tilt').value = opt;
    runSimulation();
  });

  document.getElementById('select-azimuth').addEventListener('change', (e) => {
    AppState.pv.azimuthDeg = parseFloat(e.target.value);
    runSimulation();
  });

  // Financial inputs
  document.getElementById('input-cost-per-kwp').addEventListener('input', (e) => {
    AppState.financials.costPerKwp = parseFloat(e.target.value) || 65000;
    runSimulation();
  });

  document.getElementById('input-tariff').addEventListener('input', (e) => {
    AppState.financials.tariff = parseFloat(e.target.value) || 7.50;
    runSimulation();
  });

  document.getElementById('input-degradation').addEventListener('input', (e) => {
    AppState.financials.degradationPct = parseFloat(e.target.value) || 0.5;
    runSimulation();
  });

  document.getElementById('input-escalation').addEventListener('input', (e) => {
    AppState.financials.escalationPct = parseFloat(e.target.value) || 2.5;
    runSimulation();
  });

  // PV Losses
  ['soiling', 'wiring', 'inverter', 'mismatch'].forEach((key) => {
    const el = document.getElementById(`input-loss-${key}`);
    if (el) {
      el.addEventListener('input', (e) => {
        AppState.pv.losses[key] = parseFloat(e.target.value) || 1.5;
        runSimulation();
      });
    }
  });

  // Manual display location edits
  document.getElementById('input-display-location').addEventListener('input', (e) => {
    AppState.project.displayLocation = e.target.value;
    document.getElementById('report-location-subtitle').textContent = `Project location: ${e.target.value}`;
  });

  // Location search button & Enter key
  const searchInput = document.getElementById('input-search-location');
  const searchBtn = document.getElementById('btn-search-loc');

  const executeSearch = async () => {
    const q = searchInput.value;
    if (!q) return;

    searchBtn.innerHTML = '<i data-lucide="loader" class="w-3.5 h-3.5 animate-spin"></i>';
    if (window.lucide) lucide.createIcons();

    const res = await WeatherService.searchLocation(q, AppState.googleApiKey);
    searchBtn.innerHTML = '<i data-lucide="search" class="w-3.5 h-3.5"></i>';
    if (window.lucide) lucide.createIcons();

    if (res) {
      await onMapLocationSelected(res.lat, res.lon, res.displayName);

      // Pan map
      if (AppState.googleMap) {
        AppState.googleMap.setCenter({ lat: res.lat, lng: res.lon });
        AppState.googleMap.setZoom(19);
        if (AppState.googleMarker) AppState.googleMarker.setPosition({ lat: res.lat, lng: res.lon });
      } else if (AppState.map) {
        AppState.map.setView([res.lat, res.lon], 18);
        if (AppState.marker) AppState.marker.setLatLng([res.lat, res.lon]);
      }
    } else {
      alert('Location could not be found. Please enter a city, street, or coordinates.');
    }
  };

  searchBtn.addEventListener('click', executeSearch);
  searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') executeSearch();
  });

  // "Use My GPS Location" button
  document.getElementById('btn-gps-loc').addEventListener('click', () => {
    if (!navigator.geolocation) {
      alert('Geolocation is not supported by your browser.');
      return;
    }

    const gpsBtn = document.getElementById('btn-gps-loc');
    gpsBtn.innerHTML = '<i data-lucide="loader" class="w-3.5 h-3.5 animate-spin"></i>';
    if (window.lucide) lucide.createIcons();

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        gpsBtn.innerHTML = '<i data-lucide="crosshair" class="w-3.5 h-3.5"></i>';
        if (window.lucide) lucide.createIcons();

        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        await onMapLocationSelected(lat, lon);

        if (AppState.googleMap) {
          AppState.googleMap.setCenter({ lat: lat, lng: lon });
          AppState.googleMap.setZoom(19);
          if (AppState.googleMarker) AppState.googleMarker.setPosition({ lat: lat, lng: lon });
        } else if (AppState.map) {
          AppState.map.setView([lat, lon], 18);
          if (AppState.marker) AppState.marker.setLatLng([lat, lon]);
        }
      },
      (err) => {
        gpsBtn.innerHTML = '<i data-lucide="crosshair" class="w-3.5 h-3.5"></i>';
        if (window.lucide) lucide.createIcons();
        alert(`GPS location error: ${err.message}. Please check browser location permissions.`);
      },
      { timeout: 10000, enableHighAccuracy: true }
    );
  });

  // Quick Regional Location Chips
  document.querySelectorAll('.loc-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const loc = btn.getAttribute('data-loc');
      searchInput.value = loc;
      executeSearch();
    });
  });

  // Direct Coordinates input
  document.getElementById('input-lat').addEventListener('change', async (e) => {
    const lat = parseFloat(e.target.value) || 12.8342;
    await onMapLocationSelected(lat, AppState.project.lon);
    if (AppState.map) AppState.map.setView([lat, AppState.project.lon], 18);
    if (AppState.googleMap) AppState.googleMap.setCenter({ lat: lat, lng: AppState.project.lon });
  });

  document.getElementById('input-lon').addEventListener('change', async (e) => {
    const lon = parseFloat(e.target.value) || 77.5891;
    await onMapLocationSelected(AppState.project.lat, lon);
    if (AppState.map) AppState.map.setView([AppState.project.lat, lon], 18);
    if (AppState.googleMap) AppState.googleMap.setCenter({ lat: AppState.project.lat, lng: lon });
  });

  // Weather Sync button
  document.getElementById('btn-fetch-weather').addEventListener('click', () => {
    fetchWeatherAndUpdate();
  });

  // Tab navigation
  const tabs = [
    { btn: 'tab-btn-forecast', pane: 'tab-pane-forecast' },
    { btn: 'tab-btn-report', pane: 'tab-pane-report' },
    { btn: 'tab-btn-charts', pane: 'tab-pane-charts' },
    { btn: 'tab-btn-pvsyst', pane: 'tab-pane-pvsyst' },
    { btn: 'tab-btn-cashflow', pane: 'tab-pane-cashflow' }
  ];

  tabs.forEach((tab) => {
    const btnEl = document.getElementById(tab.btn);
    if (!btnEl) return;
    btnEl.addEventListener('click', () => {
      tabs.forEach((t) => {
        const p = document.getElementById(t.pane);
        const b = document.getElementById(t.btn);
        if (p) p.classList.add('hidden');
        if (b) {
          b.classList.remove('text-[#0F356B]', 'border-b-2', 'border-[#0F356B]');
          b.classList.add('text-slate-500');
        }
      });

      const activePane = document.getElementById(tab.pane);
      if (activePane) activePane.classList.remove('hidden');
      btnEl.classList.add('text-[#0F356B]', 'border-b-2', 'border-[#0F356B]');
      btnEl.classList.remove('text-slate-500');

      if (tab.btn === 'tab-btn-forecast') {
        if (AppState.charts.hourlyForecast) AppState.charts.hourlyForecast.resize();
        if (AppState.charts.dailyForecast) AppState.charts.dailyForecast.resize();
      } else if (tab.btn === 'tab-btn-charts') {
        if (AppState.charts.monthlyGen) AppState.charts.monthlyGen.resize();
        if (AppState.charts.cashflow) AppState.charts.cashflow.resize();
      }
    });
  });

  // Hourly Estimation Day Navigation (Right Button: Next Day, Left Button: Prev Day)
  document.getElementById('btn-hourly-next')?.addEventListener('click', () => {
    AppState.forecastSelectedDayOffset = Math.min(7, (AppState.forecastSelectedDayOffset || 0) + 1);
    if (AppState.simulationResult) {
      renderForecastTab(AppState.simulationResult);
    } else {
      runSimulation();
    }
  });

  document.getElementById('btn-hourly-prev')?.addEventListener('click', () => {
    AppState.forecastSelectedDayOffset = Math.max(0, (AppState.forecastSelectedDayOffset || 0) - 1);
    if (AppState.simulationResult) {
      renderForecastTab(AppState.simulationResult);
    } else {
      runSimulation();
    }
  });

  // Unit Toggles for Hourly Estimation and 7-Day Forecast (kW vs W)
  const setForecastUnit = (unit) => {
    AppState.forecastUnit = unit;
    if (AppState.simulationResult) {
      renderForecastTab(AppState.simulationResult);
    } else {
      runSimulation();
    }
  };

  document.getElementById('btn-forecast-unit-kw')?.addEventListener('click', () => setForecastUnit('kW'));
  document.getElementById('btn-forecast-unit-w')?.addEventListener('click', () => setForecastUnit('W'));
  document.getElementById('btn-daily-unit-kw')?.addEventListener('click', () => setForecastUnit('kW'));
  document.getElementById('btn-daily-unit-w')?.addEventListener('click', () => setForecastUnit('W'));

  // Settings Modal
  const modalSettings = document.getElementById('modal-settings');
  const btnOpenSettings = document.getElementById('btn-open-settings');
  if (btnOpenSettings) {
    btnOpenSettings.addEventListener('click', () => {
      document.getElementById('input-google-api-key').value = AppState.googleApiKey;
      modalSettings.classList.remove('hidden');
    });
  }

  document.getElementById('btn-close-settings').addEventListener('click', () => modalSettings.classList.add('hidden'));
  document.getElementById('btn-cancel-settings').addEventListener('click', () => modalSettings.classList.add('hidden'));

  document.getElementById('btn-save-settings').addEventListener('click', () => {
    const key = document.getElementById('input-google-api-key').value.trim();
    AppState.googleApiKey = key;
    localStorage.setItem('heliopv_google_api_key', key);
    modalSettings.classList.add('hidden');

    if (key) {
      tryLoadGoogleMaps(AppState.project.lat, AppState.project.lon);
    }
  });

  // Print / PDF Proposal
  document.getElementById('btn-print-report').addEventListener('click', () => {
    document.getElementById('tab-btn-report').click();
    setTimeout(() => window.print(), 200);
  });

  // Export CSV for Excel
  document.getElementById('btn-export-csv').addEventListener('click', () => exportToCSV());

  // View Switcher Tabs & Navigation
  document.getElementById('tab-btn-monitor')?.addEventListener('click', () => switchView('monitor'));
  document.getElementById('tab-btn-estimate')?.addEventListener('click', () => switchView('estimate'));
  document.getElementById('btn-goto-estimation')?.addEventListener('click', () => switchView('estimate'));
  document.getElementById('btn-goto-monitor')?.addEventListener('click', () => switchView('monitor'));
  document.getElementById('btn-metric-to-estimation')?.addEventListener('click', () => switchView('estimate'));

  // Mobile Bottom Navigation Bar Listeners
  document.getElementById('mobile-nav-monitor')?.addEventListener('click', () => switchView('monitor'));
  document.getElementById('mobile-nav-estimate')?.addEventListener('click', () => switchView('estimate'));
  document.getElementById('mobile-nav-faults')?.addEventListener('click', () => {
    switchView('monitor');
    document.getElementById('iot-alert-box')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  // Pop-out Window
  document.getElementById('btn-popout-window')?.addEventListener('click', () => {
    const currentView = IoTMonitorState.currentView;
    const targetView = currentView === 'monitor' ? 'estimate' : 'monitor';
    openPopoutWindow(targetView);
  });

  // Force Poll Refresh
  document.getElementById('btn-poll-refresh')?.addEventListener('click', () => {
    pollIoTStatus(true);
  });

  // Hardware Setup Modal
  const modalHwInfo = document.getElementById('modal-hw-info');
  document.getElementById('btn-open-hw-info')?.addEventListener('click', () => {
    modalHwInfo?.classList.remove('hidden');
    fetchNetworkInfo();
  });
  document.getElementById('btn-close-hw-info')?.addEventListener('click', () => modalHwInfo?.classList.add('hidden'));
  document.getElementById('btn-close-hw-info-2')?.addEventListener('click', () => modalHwInfo?.classList.add('hidden'));

  // Copy Server IP
  document.getElementById('btn-copy-server-ip')?.addEventListener('click', () => {
    const input = document.getElementById('input-server-ip');
    if (input) {
      navigator.clipboard.writeText(input.value).then(() => {
        alert('Server URL copied to clipboard: ' + input.value);
      });
    }
  });

  // Scenario buttons (Client Demo & Simulation)
  document.querySelectorAll('.scenario-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const scenario = btn.getAttribute('data-scenario');
      if (scenario) triggerScenario(scenario);
    });
  });

  // Test Background Push Notification Button
  document.getElementById('btn-test-push-alert')?.addEventListener('click', async () => {
    try {
      const res = await fetch(`${getBackendBaseUrl()}/api/push-test`, { method: 'POST' });
      if (res.ok) {
        alert('🔔 Test push notification dispatched!\nIf your browser/app is closed or in background, your device will receive the system alert.');
      } else {
        alert('Please enable push notifications first by clicking "Push Alerts" in the top bar.');
      }
    } catch (e) {
      alert('Could not reach server to trigger test push.');
    }
  });
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function setupPushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.log('Web Push is not supported in this browser environment.');
    return;
  }

  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;

    let sub = await reg.pushManager.getSubscription();
    const btnToggle = document.getElementById('btn-toggle-push-notif');
    const lblStatus = document.getElementById('lbl-push-notif-status');

    function updatePushUI(isSubscribed) {
      if (lblStatus) {
        lblStatus.textContent = isSubscribed ? 'Push: Active' : 'Push Alerts';
      }
      if (btnToggle) {
        if (isSubscribed) {
          btnToggle.className = 'flex items-center gap-1.5 bg-emerald-900/60 text-emerald-300 border border-emerald-500/60 text-xs px-2.5 py-1.5 rounded-lg font-bold transition shadow-sm';
        } else {
          btnToggle.className = 'flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs px-2.5 py-1.5 rounded-lg font-medium border border-slate-700 transition';
        }
      }
    }

    updatePushUI(!!sub);

    async function subscribeUser() {
      const res = await fetch(`${getBackendBaseUrl()}/api/vapid-public-key`);
      if (!res.ok) throw new Error('Failed to fetch VAPID key');
      const { publicKey } = await res.json();
      const convertedKey = urlBase64ToUint8Array(publicKey);

      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: convertedKey
      });

      await fetch(`${getBackendBaseUrl()}/api/push-subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub)
      });

      updatePushUI(true);
      return true;
    }

    btnToggle?.addEventListener('click', async () => {
      if (Notification.permission === 'denied') {
        alert('⚠️ Push notifications are blocked in your browser settings. Please click the lock icon next to the URL and set Notifications to "Allow".');
        return;
      }

      if (sub) {
        try {
          await sub.unsubscribe();
          await fetch(`${getBackendBaseUrl()}/api/push-unsubscribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: sub.endpoint })
          });
        } catch (e) {}
        sub = null;
        updatePushUI(false);
        alert('🔕 Background push notifications have been disabled.');
      } else {
        const perm = await Notification.requestPermission();
        if (perm === 'granted') {
          try {
            await subscribeUser();
            alert('🔔 Background Push Alerts Active!\n\nYou will now receive system notifications on your phone or PC screen whenever an open-circuit wire fault occurs—even when this app is closed or minimized!');
          } catch (err) {
            console.error('Subscription error:', err);
            alert('Could not complete push subscription. Ensure server is running.');
          }
        }
      }
    });

    // Auto-prompt on first open if permission is 'default'
    if (Notification.permission === 'default') {
      try {
        const perm = await Notification.requestPermission();
        if (perm === 'granted') {
          await subscribeUser();
          console.log('[Push] Notification permission granted and subscribed on first launch.');
        }
      } catch (e) {
        console.warn('[Push] Auto-request failed:', e);
      }
    } else if (Notification.permission === 'granted') {
      if (!sub) {
        // Permission was granted (e.g. via Android native prompt) but push subscription not yet stored
        try {
          await subscribeUser();
        } catch (e) {
          console.warn('[Push] Auto-subscribe failed:', e);
        }
      } else {
        // Sync subscription with server to ensure it is registered
        fetch(`${getBackendBaseUrl()}/api/push-subscribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sub)
        }).catch(() => {});
      }
    }

  } catch (err) {
    console.warn('Push notification service worker init failed:', err);
  }
}

/**
 * Export Simulation Results to CSV
 */
function exportToCSV() {
  if (!AppState.simulationResult) return;
  const { summary, monthlyReport, inputs } = AppState.simulationResult;

  let csv = 'HELIOPV SOLAR EPC GENERATION & ROI REPORT\r\n';
  csv += `Project Location,"${AppState.project.displayLocation}"\r\n`;
  csv += `Installed Capacity (kWp),${inputs.capacityKwp}\r\n`;
  csv += `Tariff (INR/unit),${inputs.tariff}\r\n`;
  csv += `Cost per kWp (INR),${inputs.costPerKwp}\r\n\r\n`;

  csv += '2. MONTH-WISE GENERATION REPORT\r\n';
  csv += 'Month,Indicative yield (kWh/kWp),Generation (kWh),Bill offset (INR)\r\n';

  monthlyReport.forEach((r) => {
    csv += `${r.monthName},${r.yieldKwhPerKwp},${r.generationKwh},${r.billOffset}\r\n`;
  });

  csv += `Annual total,${summary.annualYieldKwhPerKwp},${summary.annualGenerationKwh},${summary.annualBillOffset}\r\n\r\n`;

  csv += '3. INDICATIVE ROI / SIMPLE PAYBACK\r\n';
  csv += 'Parameter,Assumption / estimate\r\n';
  csv += `"Assumed installed cost","₹${inputs.costPerKwp}/kWp × ${inputs.capacityKwp} kWp = ₹${summary.totalInstalledCost} (₹${summary.installedCostLakh} lakh)"\r\n`;
  csv += `"Annual energy generation","${summary.annualGenerationKwh} units"\r\n`;
  csv += `"Assumed electricity tariff","₹${inputs.tariff} per unit"\r\n`;
  csv += `"Estimated annual bill offset","₹${summary.annualBillOffset} (average ₹${summary.monthlyAverageOffset}/month)"\r\n`;
  csv += `"Simple payback","${summary.simplePaybackYears} years"\r\n`;
  csv += `"25-year gross bill offset","₹${summary.gross25YearOffset}"\r\n`;
  csv += `"25-year simple net benefit","₹${summary.net25YearBenefit}"\r\n`;

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Solar_Generation_Report_${inputs.capacityKwp}kWp_${AppState.project.lat}_${AppState.project.lon}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ==========================================================================
// ESP32 Solar IoT String Monitor & Fault Detection Subsystem
// ==========================================================================

const IoTMonitorState = {
  currentView: 'monitor',
  gatewayOnline: false,
  faultNodeId: null,
  faultDescription: null,
  wires: [],
  cells: [],
  isSimulated: false,
  simulationScenario: null,
  pollIntervalId: null,
  lastPollTimestamp: 0,
  serverReachable: false
};

const IOT_LABELS = {
  ok: "CONNECTED",
  broken: "OPEN CIRCUIT HERE",
  gray_zone: "GRAY ZONE",
  low_voltage: "LOW VOLTAGE",
  no_signal: "NO SIGNAL"
};

const IOT_NOTES = {
  ok: "Series continuity intact. EL817 conducting.",
  broken: "Break detected at this input connection!",
  gray_zone: "Downstream of break. Status unverified until upstream wire repaired.",
  low_voltage: "Connected but voltage is below normal operating threshold.",
  no_signal: "No radio packet received from this node."
};

function getBackendBaseUrl() {
  if (window.location.protocol.startsWith('http')) {
    // When served over HTTP/HTTPS (e.g. Render, local server),
    // use relative URL '' so requests hit the hosting server directly without mixed-content errors.
    return '';
  }
  // When running inside local file:// or Capacitor native shell, fallback to live Render server
  return 'https://heliopv-solar.onrender.com';
}

function switchView(viewName) {
  IoTMonitorState.currentView = viewName;
  const monitorView = document.getElementById('view-iot-monitor');
  const estimateView = document.getElementById('view-solar-estimation');
  const tabMonitor = document.getElementById('tab-btn-monitor');
  const tabEstimate = document.getElementById('tab-btn-estimate');
  const popoutBtnLabel = document.getElementById('popout-btn-label');
  const mobMonitor = document.getElementById('mobile-nav-monitor');
  const mobEstimate = document.getElementById('mobile-nav-estimate');

  if (viewName === 'monitor') {
    monitorView?.classList.remove('hidden');
    estimateView?.classList.add('hidden');
    tabMonitor?.classList.add('active-tab');
    tabEstimate?.classList.remove('active-tab');
    if (mobMonitor) {
      mobMonitor.classList.add('text-emerald-400');
      mobMonitor.classList.remove('text-slate-400');
    }
    if (mobEstimate) {
      mobEstimate.classList.add('text-slate-400');
      mobEstimate.classList.remove('text-amber-400', 'text-emerald-400');
    }
    if (popoutBtnLabel) popoutBtnLabel.textContent = 'Pop-out Estimation Window';
    try {
      history.replaceState(null, '', '?view=monitor');
    } catch (e) {}
  } else {
    monitorView?.classList.add('hidden');
    estimateView?.classList.remove('hidden');
    tabMonitor?.classList.remove('active-tab');
    tabEstimate?.classList.add('active-tab');
    if (mobEstimate) {
      mobEstimate.classList.add('text-amber-400');
      mobEstimate.classList.remove('text-slate-400');
    }
    if (mobMonitor) {
      mobMonitor.classList.add('text-slate-400');
      mobMonitor.classList.remove('text-emerald-400');
    }
    if (popoutBtnLabel) popoutBtnLabel.textContent = 'Pop-out Monitor Window';
    try {
      history.replaceState(null, '', '?view=estimate');
    } catch (e) {}

    // Invalidate Leaflet map & Chart sizes after unhiding
    setTimeout(() => {
      if (AppState.map) AppState.map.invalidateSize();
      if (AppState.googleMap && window.google) google.maps.event.trigger(AppState.googleMap, 'resize');
      if (AppState.charts.hourlyForecast) AppState.charts.hourlyForecast.resize();
      if (AppState.charts.dailyForecast) AppState.charts.dailyForecast.resize();
      if (AppState.charts.monthlyGen) AppState.charts.monthlyGen.resize();
      if (AppState.charts.cashflow) AppState.charts.cashflow.resize();
    }, 60);
  }

  if (window.lucide) lucide.createIcons();
}

function openPopoutWindow(targetView) {
  const url = `${window.location.origin}${window.location.pathname}?view=${targetView}`;
  window.open(url, `Solar_${targetView}_Window`, 'width=1280,height=900,menubar=no,toolbar=no');
}

function initIoTMonitor() {
  pollIoTStatus();
  if (IoTMonitorState.pollIntervalId) clearInterval(IoTMonitorState.pollIntervalId);
  IoTMonitorState.pollIntervalId = setInterval(() => pollIoTStatus(false), 800);
  fetchNetworkInfo();
}

async function fetchNetworkInfo() {
  try {
    const res = await fetch(`${getBackendBaseUrl()}/api/network-info`);
    if (res.ok) {
      const data = await res.json();
      const primaryIP = (data.localIPs && data.localIPs.length > 0) ? data.localIPs[0].address : 'localhost';
      const targetUrl = `http://${primaryIP}:${data.port || 3000}/api/data`;

      const inputServerIp = document.getElementById('input-server-ip');
      if (inputServerIp) inputServerIp.value = targetUrl;

      const codeSnippet = document.getElementById('code-snippet-esp32');
      if (codeSnippet) {
        codeSnippet.textContent = `const char *BACKEND_URL = "${targetUrl}";`;
      }
    }
  } catch (err) {
    const inputServerIp = document.getElementById('input-server-ip');
    if (inputServerIp) inputServerIp.value = 'http://localhost:3000/api/data';
  }
}

async function pollIoTStatus(force = false) {
  try {
    const res = await fetch(`${getBackendBaseUrl()}/api/status`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    IoTMonitorState.serverReachable = true;
    renderIoTMonitor(data);
  } catch (err) {
    IoTMonitorState.serverReachable = false;
    renderIoTMonitorOffline(err.message);
  }
}

let lastNotifiedFaultId = null;

function playFaultAlertAudio() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.35);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.35);
  } catch (e) {}
}

function sendFaultPushNotification(title, body) {
  playFaultAlertAudio();
  if ('Notification' in window) {
    if (Notification.permission === 'granted') {
      try {
        new Notification(title, {
          body: body,
          icon: 'https://cdn-icons-png.flaticon.com/512/564/564619.png',
          vibrate: [250, 100, 250]
        });
      } catch (e) {}
    } else if (Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }
}

// Request permission once on first click on mobile/desktop
document.addEventListener('click', function initNotifyPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
  document.removeEventListener('click', initNotifyPermission);
}, { once: true });

function renderIoTMonitor(data) {
  IoTMonitorState.gatewayOnline = data.gatewayOnline;
  IoTMonitorState.faultNodeId = data.faultNodeId;
  IoTMonitorState.faultDescription = data.faultDescription;
  IoTMonitorState.wires = data.wires || [];
  IoTMonitorState.cells = data.cells || [];
  IoTMonitorState.isSimulated = data.isSimulated;
  IoTMonitorState.simulationScenario = data.simulationScenario;

  // 1. Gateway Status Badge & Header Indicators
  const gwBadge = document.getElementById('iot-gateway-status');
  const navGwText = document.getElementById('nav-gateway-status-text');
  const pingDot = document.getElementById('gateway-ping-dot');
  const statusDot = document.getElementById('gateway-status-dot');

  if (data.gatewayOnline) {
    if (gwBadge) {
      gwBadge.innerHTML = `<span class="inline-block w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse"></span> <span class="text-emerald-400">ESP32 Gateway: ONLINE</span> ${data.isSimulated ? '<span class="text-[10px] text-blue-300 font-mono">(Simulated)</span>' : ''}`;
      gwBadge.className = 'inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-bold border border-emerald-500/50 bg-emerald-950/40 text-emerald-300';
    }
    if (navGwText) {
      navGwText.textContent = 'ONLINE';
      navGwText.className = 'font-bold text-emerald-400';
    }
    if (pingDot) pingDot.className = 'animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75';
    if (statusDot) statusDot.className = 'relative inline-flex rounded-full h-2 w-2 bg-emerald-500';
  } else {
    if (gwBadge) {
      gwBadge.innerHTML = '<span class="inline-block w-2.5 h-2.5 rounded-full bg-red-500"></span> <span class="text-red-400">ESP32 Gateway: OFFLINE</span>';
      gwBadge.className = 'inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-bold border border-red-500/50 bg-red-950/40 text-red-300';
    }
    if (navGwText) {
      navGwText.textContent = 'OFFLINE';
      navGwText.className = 'font-bold text-red-400';
    }
    if (pingDot) pingDot.className = 'hidden';
    if (statusDot) statusDot.className = 'relative inline-flex rounded-full h-2 w-2 bg-red-500';
  }

  // 2. Alert Box (Root Cause Fault Isolation) & Notifications
  const alertBox = document.getElementById('iot-alert-box');
  const navFaultText = document.getElementById('nav-fault-summary-text');
  const estIotBadge = document.getElementById('estimation-iot-status-badge');
  const mobileFaultBadge = document.getElementById('mobile-nav-fault-badge');

  if (data.faultDescription) {
    if (mobileFaultBadge) mobileFaultBadge.classList.remove('hidden');
    if (lastNotifiedFaultId !== data.faultNodeId) {
      lastNotifiedFaultId = data.faultNodeId;
      sendFaultPushNotification(
        '⚠️ Solar String Fault Detected!',
        `Break at Node ${data.faultNodeId}: ${data.faultDescription}`
      );
    }
    if (alertBox) {
      alertBox.className = 'monitor-alert-box danger';
      alertBox.innerHTML = `
        <div class="alert-title">&#9888; ROOT CAUSE FAULT DETECTED: ${data.faultDescription}</div>
        <div class="text-xs mt-1">
          <strong>Fault Isolation Analysis:</strong> Node ${data.faultNodeId} is the <em>lowest numbered node</em> reporting broken continuity.
          All subsequent downstream nodes (shaded in gray) cannot verify continuity until this upstream open circuit is repaired.
        </div>
      `;
    }
    if (navFaultText) {
      navFaultText.textContent = `Fault: Node ${data.faultNodeId} Open`;
      navFaultText.className = 'text-red-400 font-bold';
    }
    if (estIotBadge) {
      estIotBadge.textContent = `⚠ Break: ${data.faultDescription}`;
      estIotBadge.className = 'font-mono text-red-700 font-bold bg-red-50 px-2 py-0.5 rounded border border-red-300';
    }
  } else if (!data.gatewayOnline) {
    if (alertBox) {
      alertBox.className = 'monitor-alert-box warning';
      alertBox.innerHTML = `
        <div class="alert-title">&#9888; ESP32 Gateway Waiting for Data</div>
        <div class="text-xs mt-1">
          Gateway has not received packets within the last 15 seconds. Ensure ESP32-C6 is powered and transmitting to <code>/api/data</code>, or click any simulation scenario button above.
        </div>
      `;
    }
    if (navFaultText) {
      navFaultText.textContent = 'Waiting for ESP32';
      navFaultText.className = 'text-amber-400';
    }
    if (estIotBadge) {
      estIotBadge.textContent = 'ESP32 Offline (Click to view)';
      estIotBadge.className = 'font-mono text-amber-700 font-semibold bg-amber-50 px-2 py-0.5 rounded border border-amber-200';
    }
  } else {
    const lowV = (data.cells || []).filter(c => c.state === 'low_voltage');
    if (lowV.length > 0) {
      if (alertBox) {
        alertBox.className = 'monitor-alert-box warning';
        alertBox.innerHTML = `
          <div class="alert-title">&#9888; Low Voltage / Partial Shading Detected</div>
          <div class="text-xs mt-1">
            Voltage below 500 mV on: ${lowV.map(c => (c.type === 'string' ? 'String Node' : 'Panel ' + c.id)).join(', ')}. Check for panel soiling or shade.
          </div>
        `;
      }
      if (navFaultText) {
        navFaultText.textContent = 'Low Voltage Warning';
        navFaultText.className = 'text-amber-400 font-bold';
      }
      if (estIotBadge) {
        estIotBadge.textContent = '⚠ Low Voltage on Array';
        estIotBadge.className = 'font-mono text-amber-700 font-bold bg-amber-50 px-2 py-0.5 rounded border border-amber-300';
      }
    } else {
      if (mobileFaultBadge) mobileFaultBadge.classList.add('hidden');
      if (lastNotifiedFaultId !== null) {
        lastNotifiedFaultId = null;
        sendFaultPushNotification(
          '✅ Solar String Restored',
          'All series continuity connections are intact and continuous.'
        );
      }
      if (alertBox) {
        alertBox.className = 'monitor-alert-box success';
        alertBox.innerHTML = `
          <div class="alert-title">&#10003; Solar PV String Normal &amp; Continuous</div>
          <div class="text-xs mt-1">
            All 4 nodes reporting intact series connections. Photovoltaic series circuit is complete and conducting.
          </div>
        `;
      }
      if (navFaultText) {
        navFaultText.textContent = 'All Nodes Intact (Continuous)';
        navFaultText.className = 'text-emerald-400 font-semibold';
      }
      if (estIotBadge) {
        estIotBadge.textContent = '● All 4 Nodes Connected';
        estIotBadge.className = 'font-mono text-emerald-700 font-semibold bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200';
      }
    }
  }

  // 3. Render Visual Schematic Array with SVG switches
  const container = document.getElementById('iot-string-row');
  if (container && data.cells && data.cells.length > 0) {
    let html = '';
    const wires = data.wires || [];

    data.cells.forEach((c, i) => {
      const isString = (c.type === 'string');
      const label = isString ? 'String Monitor' : (`Panel ${c.id}`);
      const cardClass = isString ? 'string-node' : 'panel';

      html += `
        <div class="iot-cell ${cardClass} ${c.state}">
          <h3>${label}</h3>
          <div class="iot-badge ${c.state}">${IOT_LABELS[c.state] || c.state}</div>
          <div class="iot-vals">${renderCellBody(c)}</div>
          <div class="iot-note ${c.state === 'broken' ? 'warn' : ''}">${IOT_NOTES[c.state] || ''}</div>
        </div>
      `;

      if (i < data.cells.length - 1) {
        const wireState = (wires[i] && wires[i].state) ? wires[i].state : 'no_signal';
        html += `
          <div class="wire-box" title="Series connection between Node ${c.id} and ${c.id + 1}">
            ${renderSwitchSvg(wireState)}
          </div>
        `;
      }
    });

    container.innerHTML = html;
  }

  // 4. Update Bottom Live Telemetry Metrics
  const stringNode = (data.cells || []).find(c => c.type === 'string');
  const panels = (data.cells || []).filter(c => c.type !== 'string');

  if (stringNode && typeof stringNode.voltage === 'number') {
    document.getElementById('metric-string-voltage').textContent = `${stringNode.voltage.toFixed(2)} V`;
    document.getElementById('metric-string-current').textContent = `${stringNode.current.toFixed(3)} A`;
    document.getElementById('metric-string-power').textContent = `${stringNode.power.toFixed(2)} W`;
  } else {
    document.getElementById('metric-string-voltage').textContent = '-- V';
    document.getElementById('metric-string-current').textContent = '-- A';
    document.getElementById('metric-string-power').textContent = '-- W';
  }

  const temps = panels.map(p => p.temp).filter(t => typeof t === 'number');
  const tempEl = document.getElementById('metric-string-temp');
  if (tempEl) {
    if (temps.length > 0) {
      const avgT = (temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1);
      tempEl.textContent = `${avgT} °C`;
    } else {
      tempEl.textContent = '-- °C';
    }
  }

  const scenarioBadge = document.getElementById('active-scenario-badge');
  if (scenarioBadge) {
    scenarioBadge.textContent = data.isSimulated
      ? `Simulated: ${data.simulationScenario || 'Active'}`
      : (data.gatewayOnline ? 'Mode: Live Hardware (ESP32)' : 'Mode: Waiting for Hardware');
  }
}

function renderCellBody(c) {
  if (c.state === 'no_signal') return '<span class="text-slate-500">No packet data</span>';
  if (c.type === 'string') {
    const volt = typeof c.voltage === 'number' ? c.voltage.toFixed(2) + ' V' : '—';
    const cur  = typeof c.current === 'number' ? c.current.toFixed(3) + ' A' : '—';
    const pwr  = typeof c.power === 'number' ? c.power.toFixed(2) + ' W' : '—';
    const ldr  = c.ldr !== undefined ? c.ldr : '—';
    return `Volt: <span class="val-highlight">${volt}</span><br>` +
           `Curr: <span class="val-highlight">${cur}</span><br>` +
           `Power: <span class="val-highlight" style="color:#F59E0B;">${pwr}</span><br>` +
           `LDR: <span class="val-highlight">${ldr}</span>`;
  }
  const temp = typeof c.temp === 'number' ? c.temp.toFixed(1) + ' °C' : 'Sensor absent';
  const volt = typeof c.voltage === 'number' ? c.voltage.toFixed(2) + ' V' : '—';
  return `Temp: <span class="val-highlight">${temp}</span><br>Volt: <span class="val-highlight">${volt}</span>`;
}

function renderSwitchSvg(state) {
  if (state === 'closed') {
    return `
      <svg class="wire-svg" viewBox="0 0 68 34">
        <line x1="0" y1="17" x2="16" y2="17" stroke="#3FB950" stroke-width="3" />
        <line x1="52" y1="17" x2="68" y2="17" stroke="#3FB950" stroke-width="3" />
        <circle cx="16" cy="17" r="4.5" fill="#3FB950" />
        <circle cx="52" cy="17" r="4.5" fill="#3FB950" />
        <line x1="16" y1="17" x2="52" y2="17" stroke="#3FB950" stroke-width="3.5" stroke-linecap="round" />
      </svg>
      <div class="wire-status-text closed">&#10003; CLOSED</div>
    `;
  } else if (state === 'open') {
    return `
      <svg class="wire-svg" viewBox="0 0 68 34">
        <line x1="0" y1="17" x2="16" y2="17" stroke="#F85149" stroke-width="3" />
        <line x1="52" y1="17" x2="68" y2="17" stroke="#F85149" stroke-width="3" />
        <circle cx="16" cy="17" r="4.5" fill="#F85149" />
        <circle cx="52" cy="17" r="4.5" fill="#F85149" />
        <line class="wire-open-arm" x1="16" y1="17" x2="44" y2="4" stroke="#F85149" stroke-width="3.5" stroke-linecap="round" />
        <line x1="42" y1="9" x2="48" y2="15" stroke="#FFEB3B" stroke-width="1.5" stroke-dasharray="2,2" />
      </svg>
      <div class="wire-status-text open">&#9888; OPEN CKT</div>
    `;
  } else if (state === 'gray_zone') {
    return `
      <svg class="wire-svg" viewBox="0 0 68 34">
        <line x1="0" y1="17" x2="16" y2="17" stroke="#6E7681" stroke-width="2.5" stroke-dasharray="3,3" />
        <line x1="52" y1="17" x2="68" y2="17" stroke="#6E7681" stroke-width="2.5" stroke-dasharray="3,3" />
        <circle cx="16" cy="17" r="4" fill="#6E7681" />
        <circle cx="52" cy="17" r="4" fill="#6E7681" />
        <line class="wire-gray-arm" x1="16" y1="17" x2="52" y2="17" stroke="#8B949E" stroke-width="2" stroke-dasharray="4,4" />
      </svg>
      <div class="wire-status-text gray_zone">&#63; BLOCKED</div>
    `;
  } else {
    return `
      <svg class="wire-svg" viewBox="0 0 68 34">
        <line x1="0" y1="17" x2="68" y2="17" stroke="#30363D" stroke-width="2" stroke-dasharray="4,4" />
      </svg>
      <div class="wire-status-text no_signal">&mdash;</div>
    `;
  }
}

function renderIoTMonitorOffline(errMsg) {
  const gwBadge = document.getElementById('iot-gateway-status');
  if (gwBadge) {
    gwBadge.innerHTML = '<span class="inline-block w-2.5 h-2.5 rounded-full bg-slate-500"></span> <span class="text-slate-400">Server Offline (:3000)</span>';
    gwBadge.className = 'inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-bold border border-slate-700 bg-slate-900 text-slate-400';
  }

  const alertBox = document.getElementById('iot-alert-box');
  if (alertBox) {
    alertBox.className = 'monitor-alert-box warning';
    alertBox.innerHTML = `
      <div class="alert-title">&#9888; Backend Server Offline on Port 3000</div>
      <div class="text-xs mt-1">
        Run <code>node server.js</code> or double click <code>start_all.bat</code> to connect live ESP32 hardware. 
        <strong>You can still test and present all scenarios using the simulation buttons above!</strong>
      </div>
    `;
  }

  const container = document.getElementById('iot-string-row');
  if (container && (!container.children || container.children.length <= 1)) {
    runClientSideSimulation('normal');
  }
}

async function triggerScenario(scenario) {
  document.querySelectorAll('.scenario-btn').forEach(btn => {
    if (btn.getAttribute('data-scenario') === scenario) {
      btn.classList.add('active-scenario');
    } else {
      btn.classList.remove('active-scenario');
    }
  });

  try {
    const res = await fetch(`${getBackendBaseUrl()}/api/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario })
    });
    if (res.ok) {
      pollIoTStatus(true);
      return;
    }
  } catch (err) {
    // Server is not running; run client-side simulation fallback
  }

  runClientSideSimulation(scenario);
}

function runClientSideSimulation(scenario) {
  const now = Date.now();
  let mockNodes = [];

  if (scenario === 'normal') {
    mockNodes = [
      { id: 1, node_type: 0, continuity: true, temp_c10: 295, voltage_mV: 18450, current_mA: 0, ldr_raw: 0, ageMs: 100 },
      { id: 2, node_type: 1, continuity: true, temp_c10: 310, voltage_mV: 18200, current_mA: 0, ldr_raw: 0, ageMs: 120 },
      { id: 3, node_type: 1, continuity: true, temp_c10: 305, voltage_mV: 18350, current_mA: 0, ldr_raw: 0, ageMs: 110 },
      { id: 4, node_type: 2, continuity: true, temp_c10: -999, voltage_mV: 55000, current_mA: 5400, ldr_raw: 890, ageMs: 90 }
    ];
  } else if (scenario === 'fault_p1_p2') {
    mockNodes = [
      { id: 1, node_type: 0, continuity: true, temp_c10: 295, voltage_mV: 18450, current_mA: 0, ldr_raw: 0, ageMs: 100 },
      { id: 2, node_type: 1, continuity: false, temp_c10: 310, voltage_mV: 18200, current_mA: 0, ldr_raw: 0, ageMs: 120 },
      { id: 3, node_type: 1, continuity: false, temp_c10: 305, voltage_mV: 18350, current_mA: 0, ldr_raw: 0, ageMs: 110 },
      { id: 4, node_type: 2, continuity: false, temp_c10: -999, voltage_mV: 0, current_mA: 0, ldr_raw: 890, ageMs: 90 }
    ];
  } else if (scenario === 'fault_p2_p3') {
    mockNodes = [
      { id: 1, node_type: 0, continuity: true, temp_c10: 295, voltage_mV: 18450, current_mA: 0, ldr_raw: 0, ageMs: 100 },
      { id: 2, node_type: 1, continuity: true, temp_c10: 310, voltage_mV: 18200, current_mA: 0, ldr_raw: 0, ageMs: 120 },
      { id: 3, node_type: 1, continuity: false, temp_c10: 305, voltage_mV: 18350, current_mA: 0, ldr_raw: 0, ageMs: 110 },
      { id: 4, node_type: 2, continuity: false, temp_c10: -999, voltage_mV: 0, current_mA: 0, ldr_raw: 890, ageMs: 90 }
    ];
  } else if (scenario === 'fault_p3_string') {
    mockNodes = [
      { id: 1, node_type: 0, continuity: true, temp_c10: 295, voltage_mV: 18450, current_mA: 0, ldr_raw: 0, ageMs: 100 },
      { id: 2, node_type: 1, continuity: true, temp_c10: 310, voltage_mV: 18200, current_mA: 0, ldr_raw: 0, ageMs: 120 },
      { id: 3, node_type: 1, continuity: true, temp_c10: 305, voltage_mV: 18350, current_mA: 0, ldr_raw: 0, ageMs: 110 },
      { id: 4, node_type: 2, continuity: false, temp_c10: -999, voltage_mV: 0, current_mA: 0, ldr_raw: 890, ageMs: 90 }
    ];
  } else if (scenario === 'low_voltage') {
    mockNodes = [
      { id: 1, node_type: 0, continuity: true, temp_c10: 295, voltage_mV: 18450, current_mA: 0, ldr_raw: 0, ageMs: 100 },
      { id: 2, node_type: 1, continuity: true, temp_c10: 380, voltage_mV: 350, current_mA: 0, ldr_raw: 0, ageMs: 120 },
      { id: 3, node_type: 1, continuity: true, temp_c10: 305, voltage_mV: 18350, current_mA: 0, ldr_raw: 0, ageMs: 110 },
      { id: 4, node_type: 2, continuity: true, temp_c10: -999, voltage_mV: 37150, current_mA: 2100, ldr_raw: 410, ageMs: 90 }
    ];
  } else if (scenario === 'live_hardware') {
    renderIoTMonitor({
      gatewayOnline: false,
      faultNodeId: null,
      faultDescription: null,
      wires: [],
      cells: [1, 2, 3, 4].map(id => ({ id, type: id === 4 ? 'string' : (id === 1 ? 'panel_basic' : 'panel_full'), state: 'no_signal' })),
      isSimulated: false,
      simulationScenario: 'live_hardware'
    });
    return;
  }

  let faultNodeId = null;
  let faultDescription = null;
  for (let id = 2; id <= 4; id++) {
    const n = mockNodes.find(x => x.id === id);
    if (n && n.continuity === false) {
      faultNodeId = id;
      if (id === 2) faultDescription = "Disconnection detected between Panel 1 and Panel 2";
      else if (id === 3) faultDescription = "Disconnection detected between Panel 2 and Panel 3";
      else if (id === 4) faultDescription = "Disconnection detected between Panel 3 and String Node";
      break;
    }
  }

  const cells = [1, 2, 3, 4].map(id => {
    const n = mockNodes.find(x => x.id === id);
    const typeName = id === 4 ? 'string' : (id === 1 ? 'panel_basic' : 'panel_full');
    let state = 'ok';
    if (faultNodeId !== null) {
      if (id === faultNodeId) state = 'broken';
      else if (id > faultNodeId) state = 'gray_zone';
    }

    if (typeName !== 'string') {
      const v = n.voltage_mV / 1000;
      const t = n.temp_c10 === -999 ? null : n.temp_c10 / 10;
      if (state === 'ok' && n.voltage_mV < 500) state = 'low_voltage';
      return { id, type: typeName, state, temp: t, voltage: v };
    }

    const cur = n.current_mA / 1000;
    const volt = n.voltage_mV / 1000;
    return {
      id,
      type: typeName,
      state,
      voltage: volt,
      current: cur,
      power: Number((volt * cur).toFixed(2)),
      ldr: n.ldr_raw
    };
  });

  const wires = [
    { from: 1, to: 2, monitoredBy: 2 },
    { from: 2, to: 3, monitoredBy: 3 },
    { from: 3, to: 4, monitoredBy: 4 }
  ].map(w => {
    if (faultNodeId === null) return { ...w, state: 'closed' };
    if (w.monitoredBy < faultNodeId) return { ...w, state: 'closed' };
    if (w.monitoredBy === faultNodeId) return { ...w, state: 'open' };
    return { ...w, state: 'gray_zone' };
  });

  renderIoTMonitor({
    gatewayOnline: true,
    faultNodeId,
    faultDescription,
    wires,
    cells,
    isSimulated: true,
    simulationScenario: scenario
  });
}

// ==========================================================================
// User Authentication, Profile & JWT Session Management
// ==========================================================================

const AuthState = {
  token: localStorage.getItem('heliopv_jwt_token') || null,
  user: null
};

function getAuthHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (AuthState.token) {
    headers['Authorization'] = `Bearer ${AuthState.token}`;
  }
  return headers;
}

async function initAuth() {
  setupAuthEventListeners();

  if (AuthState.token) {
    try {
      const res = await fetch(`${getBackendBaseUrl()}/api/auth/me`, {
        headers: getAuthHeaders()
      });
      if (res.ok) {
        const data = await res.json();
        AuthState.user = data.user;
        updateAuthUI(AuthState.user);
        return;
      }
    } catch (e) {
      console.warn('Session verification error:', e);
    }
  }

  // Not authenticated
  AuthState.token = null;
  AuthState.user = null;
  localStorage.removeItem('heliopv_jwt_token');
  updateAuthUI(null);
}

function updateAuthUI(user) {
  const loggedOutBox = document.getElementById('auth-header-logged-out');
  const loggedInBox = document.getElementById('auth-header-logged-in');

  if (user) {
    loggedOutBox?.classList.add('hidden');
    loggedOutBox?.classList.remove('flex');
    loggedInBox?.classList.remove('hidden');
    loggedInBox?.classList.add('flex');

    const headerAvatar = document.getElementById('header-user-avatar');
    const headerName = document.getElementById('header-user-name');
    const drawerAvatar = document.getElementById('drawer-user-avatar');
    const drawerName = document.getElementById('drawer-user-name');
    const drawerEmail = document.getElementById('drawer-user-email');

    const avatarUrl = user.profileImage || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(user.name)}`;
    if (headerAvatar) headerAvatar.src = avatarUrl;
    if (headerName) headerName.textContent = user.name || 'User';
    if (drawerAvatar) drawerAvatar.src = avatarUrl;
    if (drawerName) drawerName.textContent = user.name || 'User';
    if (drawerEmail) drawerEmail.textContent = user.email || '';
  } else {
    loggedOutBox?.classList.remove('hidden');
    loggedOutBox?.classList.add('flex');
    loggedInBox?.classList.add('hidden');
    loggedInBox?.classList.remove('flex');
  }

  if (window.lucide) lucide.createIcons();
}

function showAuthError(msg) {
  const banner = document.getElementById('auth-error-banner');
  const text = document.getElementById('auth-error-text');
  if (banner && text) {
    text.textContent = msg;
    banner.classList.remove('hidden');
  }
}

function clearAuthError() {
  const banner = document.getElementById('auth-error-banner');
  if (banner) banner.classList.add('hidden');
}

function setupAuthEventListeners() {
  const authModal = document.getElementById('modal-auth');
  const btnOpenAuth = document.getElementById('btn-open-auth-modal');
  const btnCloseAuth = document.getElementById('btn-close-auth-modal');

  btnOpenAuth?.addEventListener('click', () => {
    authModal?.classList.remove('hidden');
    clearAuthError();
  });

  btnCloseAuth?.addEventListener('click', () => {
    authModal?.classList.add('hidden');
  });

  authModal?.addEventListener('click', (e) => {
    if (e.target === authModal) authModal.classList.add('hidden');
  });

  // Modal Tab switching
  const tabLogin = document.getElementById('tab-auth-login');
  const tabSignup = document.getElementById('tab-auth-signup');
  const formLogin = document.getElementById('form-login');
  const formSignup = document.getElementById('form-signup');

  tabLogin?.addEventListener('click', () => {
    tabLogin.className = 'py-2 rounded-lg transition text-white bg-slate-800 shadow';
    tabSignup.className = 'py-2 rounded-lg transition text-slate-400 hover:text-slate-200';
    formLogin?.classList.remove('hidden');
    formSignup?.classList.add('hidden');
    clearAuthError();
  });

  tabSignup?.addEventListener('click', () => {
    tabSignup.className = 'py-2 rounded-lg transition text-white bg-slate-800 shadow';
    tabLogin.className = 'py-2 rounded-lg transition text-slate-400 hover:text-slate-200';
    formSignup?.classList.remove('hidden');
    formLogin?.classList.add('hidden');
    clearAuthError();
  });

  // Toggle password visibility
  document.querySelectorAll('.btn-toggle-pwd-vis').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = btn.previousElementSibling;
      if (input && input.type === 'password') {
        input.type = 'text';
      } else if (input) {
        input.type = 'password';
      }
    });
  });

  // Avatar preset seeds
  let selectedSignupAvatar = 'https://api.dicebear.com/7.x/bottts/svg?seed=SolarUser';
  document.querySelectorAll('.avatar-seed-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      const seed = btn.getAttribute('data-seed');
      selectedSignupAvatar = `https://api.dicebear.com/7.x/bottts/svg?seed=${seed}&backgroundColor=0f356b,0a254a`;
      const img = document.getElementById('img-signup-avatar-preview');
      if (img) img.src = selectedSignupAvatar;
    });
  });

  // Submit Login
  formLogin?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAuthError();
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;
    const btnSubmit = document.getElementById('btn-submit-login');

    btnSubmit.disabled = true;
    btnSubmit.innerHTML = '<span>Signing In...</span>';

    try {
      const res = await fetch(`${getBackendBaseUrl()}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');

      AuthState.token = data.token;
      AuthState.user = data.user;
      localStorage.setItem('heliopv_jwt_token', data.token);
      updateAuthUI(data.user);
      authModal?.classList.add('hidden');
      alert(`Welcome back, ${data.user.name}!`);
    } catch (err) {
      showAuthError(err.message);
    } finally {
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = '<i data-lucide="log-in" class="w-4 h-4"></i><span>Sign In to Dashboard</span>';
      if (window.lucide) lucide.createIcons();
    }
  });

  // Submit Signup
  formSignup?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAuthError();
    const name = document.getElementById('signup-name').value;
    const email = document.getElementById('signup-email').value;
    const password = document.getElementById('signup-password').value;
    const btnSubmit = document.getElementById('btn-submit-signup');

    btnSubmit.disabled = true;
    btnSubmit.innerHTML = '<span>Creating Account...</span>';

    try {
      const res = await fetch(`${getBackendBaseUrl()}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password, profileImage: selectedSignupAvatar })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Registration failed');

      AuthState.token = data.token;
      AuthState.user = data.user;
      localStorage.setItem('heliopv_jwt_token', data.token);
      updateAuthUI(data.user);
      authModal?.classList.add('hidden');
      alert(`Account created successfully! Welcome to HelioPV, ${data.user.name}.`);
    } catch (err) {
      showAuthError(err.message);
    } finally {
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = '<i data-lucide="user-plus" class="w-4 h-4"></i><span>Create Account & Sign In</span>';
      if (window.lucide) lucide.createIcons();
    }
  });

  // User Profile Drawer (Hamburger Menu ≡)
  const drawer = document.getElementById('drawer-user-profile');
  const backdrop = document.getElementById('drawer-backdrop');
  const btnToggleDrawer = document.getElementById('btn-toggle-user-drawer');
  const btnCloseDrawer = document.getElementById('btn-close-user-drawer');

  function openDrawer() {
    drawer?.classList.remove('translate-x-full');
    drawer?.classList.add('translate-x-0');
    backdrop?.classList.remove('hidden');
  }

  function closeDrawer() {
    drawer?.classList.remove('translate-x-0');
    drawer?.classList.add('translate-x-full');
    backdrop?.classList.add('hidden');
  }

  btnToggleDrawer?.addEventListener('click', openDrawer);
  btnCloseDrawer?.addEventListener('click', closeDrawer);
  backdrop?.addEventListener('click', closeDrawer);

  // Profile Image Upload & Randomize
  const avatarWrapper = document.getElementById('profile-avatar-clickable');
  const btnUploadPhoto = document.getElementById('btn-trigger-upload-photo');
  const fileInput = document.getElementById('input-profile-file');
  const btnRandomAvatar = document.getElementById('btn-random-avatar');

  function triggerFilePick() {
    fileInput?.click();
  }

  avatarWrapper?.addEventListener('click', triggerFilePick);
  btnUploadPhoto?.addEventListener('click', triggerFilePick);

  fileInput?.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      alert('Photo must be smaller than 5MB.');
      return;
    }

    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = reader.result;
      try {
        const res = await fetch(`${getBackendBaseUrl()}/api/auth/update-profile`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ profileImage: base64 })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to update photo');
        AuthState.user = data.user;
        updateAuthUI(data.user);
        alert('Profile picture updated successfully!');
      } catch (err) {
        alert(err.message);
      }
    };
    reader.readAsDataURL(file);
  });

  btnRandomAvatar?.addEventListener('click', async () => {
    const randomSeed = 'Solar_' + Math.random().toString(36).substring(2, 8);
    const newAvatar = `https://api.dicebear.com/7.x/bottts/svg?seed=${randomSeed}&backgroundColor=0f356b,0a254a`;
    try {
      const res = await fetch(`${getBackendBaseUrl()}/api/auth/update-profile`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ profileImage: newAvatar })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update avatar');
      AuthState.user = data.user;
      updateAuthUI(data.user);
    } catch (err) {
      alert(err.message);
    }
  });

  // Change Password Accordion & Submit
  const btnTogglePwd = document.getElementById('btn-toggle-pwd-section');
  const formChangePwd = document.getElementById('form-change-password');
  const iconChevron = document.getElementById('icon-pwd-chevron');
  const pwdStatusBanner = document.getElementById('pwd-status-banner');

  btnTogglePwd?.addEventListener('click', () => {
    const isHidden = formChangePwd?.classList.contains('hidden');
    if (isHidden) {
      formChangePwd?.classList.remove('hidden');
      iconChevron?.classList.add('rotate-180');
    } else {
      formChangePwd?.classList.add('hidden');
      iconChevron?.classList.remove('rotate-180');
    }
  });

  formChangePwd?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const currentPassword = document.getElementById('input-curr-pwd').value;
    const newPassword = document.getElementById('input-new-pwd').value;
    const confirmPassword = document.getElementById('input-confirm-pwd').value;
    const btnSubmit = document.getElementById('btn-submit-change-pwd');

    if (newPassword !== confirmPassword) {
      pwdStatusBanner.className = 'p-2.5 rounded-lg text-xs font-medium bg-red-950/80 text-red-300 border border-red-500/40 block';
      pwdStatusBanner.textContent = 'New passwords do not match.';
      return;
    }

    btnSubmit.disabled = true;
    try {
      const res = await fetch(`${getBackendBaseUrl()}/api/auth/change-password`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ currentPassword, newPassword })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to change password');

      pwdStatusBanner.className = 'p-2.5 rounded-lg text-xs font-medium bg-emerald-950/80 text-emerald-300 border border-emerald-500/40 block';
      pwdStatusBanner.textContent = 'Password updated successfully!';
      formChangePwd.reset();
    } catch (err) {
      pwdStatusBanner.className = 'p-2.5 rounded-lg text-xs font-medium bg-red-950/80 text-red-300 border border-red-500/40 block';
      pwdStatusBanner.textContent = err.message;
    } finally {
      btnSubmit.disabled = false;
    }
  });

  // Logout Button
  document.getElementById('btn-logout-user')?.addEventListener('click', () => {
    if (confirm('Are you sure you want to sign out?')) {
      AuthState.token = null;
      AuthState.user = null;
      localStorage.removeItem('heliopv_jwt_token');
      updateAuthUI(null);
      closeDrawer();
      alert('Signed out successfully.');
    }
  });
}

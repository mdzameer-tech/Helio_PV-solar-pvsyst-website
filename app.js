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
  mlPrediction: null,
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

  // Load cached location & settings from prior visit for instant restoration on revisit
  loadCachedLocationAndSettings();

  // Initialize Map with saved location
  initMap(AppState.project.lat, AppState.project.lon);

  // Setup Event Listeners
  setupEventListeners();

  // Automatically sync satellite weather & run PV prediction for this location on revisit
  fetchWeatherAndUpdate();

  // View mode check from URL (defaults to monitor)
  const urlParams = new URLSearchParams(window.location.search);
  const initialView = urlParams.get('view') || 'monitor';
  AuthState.intendedView = initialView;

  // Initialize Native Background Web Push Notifications
  setupPushNotifications();

  // Initialize JWT User Authentication Guard & Hamburger Profile Drawer
  initAuth();

  // Initialize Native-Feel Mobile Pull-to-Refresh Gesture
  setupPullToRefresh();
});

/**
 * Mobile Native-Feel Pull-To-Refresh Gesture
 * When user is at the top of the screen and drags down, displays a sleek floating spinner
 * and smoothly reloads the app upon release.
 */
function setupPullToRefresh() {
  const indicator = document.getElementById('pull-refresh-indicator');
  const iconWrap = document.getElementById('pull-refresh-icon-wrap');
  const textEl = document.getElementById('pull-refresh-text');
  if (!indicator || !iconWrap || !textEl) return;

  let startY = 0;
  let startX = 0;
  let currentY = 0;
  let isPulling = false;
  let isRefreshing = false;
  const PULL_THRESHOLD = 58; // px threshold to trigger refresh

  window.addEventListener('touchstart', (e) => {
    if (isRefreshing) return;

    // Only allow pull-to-refresh if user is at the very top of the window
    const scrollTop = window.scrollY || document.documentElement.scrollTop || 0;
    if (scrollTop > 4) return;

    // Do not trigger if touching interactive modals or form inputs
    const target = e.target;
    if (target.closest('input, textarea, select, button, #map-container, .leaflet-container')) return;

    // Check if an open modal or the drawer is currently open
    const openModal = document.querySelector('.fixed:not(.hidden):not(#pull-refresh-indicator)');
    if (openModal && (openModal.id === 'modal-site-location' || openModal.id === 'modal-hardware-info' || openModal.id === 'modal-panel-detail' || openModal.id === 'modal-auth')) {
      return;
    }
    const drawer = document.getElementById('user-account-drawer');
    if (drawer && !drawer.classList.contains('translate-x-full')) {
      return;
    }

    const touch = e.touches[0];
    startY = touch.clientY;
    startX = touch.clientX;
    isPulling = false;
    indicator.style.transition = 'none';
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (isRefreshing || startY === 0) return;

    const scrollTop = window.scrollY || document.documentElement.scrollTop || 0;
    if (scrollTop > 4) {
      if (isPulling) {
        isPulling = false;
        resetIndicator();
      }
      return;
    }

    const touch = e.touches[0];
    const diffY = touch.clientY - startY;
    const diffX = touch.clientX - startX;

    // Must be dragging downwards primarily vertically
    if (diffY > 8 && diffY > Math.abs(diffX) * 1.2) {
      isPulling = true;
      currentY = diffY;

      // Apply parabolic damping so pull feels weighted and natural
      const pullDist = Math.min(Math.pow(diffY, 0.85) * 1.35, 78);
      const rotateDeg = Math.min(pullDist * 5, 360);
      const opacity = Math.min(pullDist / 28, 1);

      indicator.style.transform = `translate(-50%, ${pullDist - 55}px)`;
      indicator.style.opacity = opacity.toString();
      iconWrap.style.transform = `rotate(${rotateDeg}deg)`;

      if (pullDist >= PULL_THRESHOLD) {
        textEl.textContent = 'Release to refresh';
        indicator.classList.add('border-amber-400');
        iconWrap.classList.add('text-amber-300');
      } else {
        textEl.textContent = 'Pull to refresh';
        indicator.classList.remove('border-amber-400');
        iconWrap.classList.remove('text-amber-300');
      }
    }
  }, { passive: true });

  window.addEventListener('touchend', () => {
    if (isRefreshing || !isPulling) {
      startY = 0;
      return;
    }

    const pullDist = Math.min(Math.pow(currentY, 0.85) * 1.35, 78);

    if (pullDist >= PULL_THRESHOLD) {
      isRefreshing = true;
      indicator.style.transition = 'transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease';
      indicator.style.transform = 'translate(-50%, 14px)';
      indicator.style.opacity = '1';
      textEl.textContent = 'Refreshing...';
      iconWrap.classList.add('animate-spin');

      if (navigator.vibrate) {
        try { navigator.vibrate(25); } catch (e) {}
      }

      // Smooth brief delay so user sees spinner before page reload
      setTimeout(() => {
        window.location.reload();
      }, 350);
    } else {
      resetIndicator();
    }

    startY = 0;
    currentY = 0;
    isPulling = false;
  }, { passive: true });

  window.addEventListener('touchcancel', () => {
    if (!isRefreshing) resetIndicator();
    startY = 0;
    currentY = 0;
    isPulling = false;
  }, { passive: true });

  function resetIndicator() {
    indicator.style.transition = 'transform 0.25s ease-out, opacity 0.25s ease-out';
    indicator.style.transform = 'translate(-50%, -65px)';
    indicator.style.opacity = '0';
    setTimeout(() => {
      if (!isRefreshing) {
        textEl.textContent = 'Pull to refresh';
        indicator.classList.remove('border-amber-400');
        iconWrap.classList.remove('text-amber-300', 'animate-spin');
        iconWrap.style.transform = 'rotate(0deg)';
      }
    }, 250);
  }
}

/**
 * Load cached location and project settings from localStorage on revisit
 */
function loadCachedLocationAndSettings() {
  try {
    const cachedLoc = localStorage.getItem('heliopv_saved_location');
    if (cachedLoc) {
      const loc = JSON.parse(cachedLoc);
      if (loc && typeof loc.lat === 'number' && typeof loc.lon === 'number' && !isNaN(loc.lat) && !isNaN(loc.lon)) {
        AppState.project.lat = Math.round(loc.lat * 10000) / 10000;
        AppState.project.lon = Math.round(loc.lon * 10000) / 10000;
        if (loc.displayLocation) {
          AppState.project.displayLocation = loc.displayLocation;
        }

        // Pre-fill DOM inputs
        const inputLat = document.getElementById('input-lat');
        const inputLon = document.getElementById('input-lon');
        const inputDisp = document.getElementById('input-display-location');
        const inputSearch = document.getElementById('input-search-location');
        const reportSubtitle = document.getElementById('report-location-subtitle');
        const drawerLblLoc = document.getElementById('drawer-lbl-location');
        const quickLblLoc = document.getElementById('quick-lbl-site-loc');

        if (inputLat) inputLat.value = AppState.project.lat;
        if (inputLon) inputLon.value = AppState.project.lon;
        if (inputDisp && loc.displayLocation) inputDisp.value = loc.displayLocation;
        if (inputSearch && loc.displayLocation) inputSearch.value = loc.displayLocation;
        if (reportSubtitle && loc.displayLocation) reportSubtitle.textContent = `Project location: ${loc.displayLocation}`;
        if (drawerLblLoc && loc.displayLocation) drawerLblLoc.textContent = loc.displayLocation;
        if (quickLblLoc && loc.displayLocation) quickLblLoc.textContent = loc.displayLocation;
      }
    }

    const cachedSettings = localStorage.getItem('heliopv_saved_settings');
    if (cachedSettings) {
      const s = JSON.parse(cachedSettings);
      if (s.capacityKwp && !isNaN(s.capacityKwp)) {
        AppState.project.capacityKwp = s.capacityKwp;
        const inpCap = document.getElementById('input-capacity');
        const sldCap = document.getElementById('slider-capacity');
        if (inpCap) inpCap.value = s.capacityKwp;
        if (sldCap) sldCap.value = s.capacityKwp;
      }
      if (s.tilt !== undefined && !isNaN(s.tilt)) {
        AppState.project.tilt = s.tilt;
        const inpTilt = document.getElementById('input-tilt');
        if (inpTilt) inpTilt.value = s.tilt;
      }
      if (s.azimuth !== undefined && !isNaN(s.azimuth)) {
        AppState.project.azimuth = s.azimuth;
        const inpAzimuth = document.getElementById('input-azimuth');
        if (inpAzimuth) inpAzimuth.value = s.azimuth;
      }
      if (s.tariff !== undefined && !isNaN(s.tariff)) {
        AppState.project.tariffPerKwh = s.tariff;
        const inpTariff = document.getElementById('input-tariff');
        if (inpTariff) inpTariff.value = s.tariff;
      }
    }
    updateHardwarePreviewBadge();
  } catch (e) {
    console.warn('Error loading cached location/settings on revisit:', e);
  }
}

/**
 * Update the Hardware Info summary pill in the operator profile drawer
 */
function updateHardwarePreviewBadge() {
  const lbl = document.getElementById('drawer-lbl-hw-preview');
  if (lbl) {
    const costK = Math.round((AppState.financials.costPerKwp || 65000) / 1000);
    const tariff = AppState.financials.tariff || 7.50;
    const tilt = AppState.pv.tiltDeg || 13;
    lbl.textContent = `₹${costK}k/kWp • ₹${tariff}/u • Tilt ${tilt}°`;
  }
}

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
  
  const drawerLblLoc = document.getElementById('drawer-lbl-location');
  if (drawerLblLoc) drawerLblLoc.textContent = displayLoc;
  const quickLblLoc = document.getElementById('quick-lbl-site-loc');
  if (quickLblLoc) quickLblLoc.textContent = displayLoc;

  if (AppState.marker) {
    AppState.marker.bindPopup(`<b>${displayLoc}</b>`).openPopup();
  }

  // Persist chosen location preference to MongoDB Atlas for the user
  saveUserLocationPreference(AppState.project.lat, AppState.project.lon, displayLoc);

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
 * Fetch ML Model Predictions from FastAPI Microservice (LightGBM + Random Forest)
 */
async function fetchMLPrediction(lat, lon, capacityKwp) {
  try {
    const res = await fetch(`${getBackendBaseUrl()}/api/ml/predict?lat=${lat}&lon=${lon}&kw=${capacityKwp}&monthly=true`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.success && !data.isFallback) {
      AppState.mlPrediction = data;
      console.log('[HelioPV] ML Ensemble predictions loaded:', data);
      return data;
    }
  } catch (e) {
    console.warn('[HelioPV] ML prediction fetch error, using PVsyst engine:', e);
  }
  AppState.mlPrediction = null;
  return null;
}

/**
 * Fetch Satellite Solar Irradiance from Open-Meteo & ML Model
 */
async function fetchWeatherAndUpdate() {
  const badges = document.querySelectorAll('#weather-badge, #weather-badge-modal');
  badges.forEach((b) => {
    b.textContent = 'Syncing Satellite Solar...';
    b.className = 'text-[9px] bg-amber-500/20 text-amber-300 border border-amber-500/40 px-1.5 py-0.2 rounded font-mono calculating';
  });

  // Concurrently fetch Satellite ERA5 Data and Python ML Predictions
  await Promise.allSettled([
    (async () => {
      const res = await WeatherService.fetchSolarData(AppState.project.lat, AppState.project.lon);
      if (res && res.success && res.monthlyData) {
        AppState.weatherData = res.monthlyData;
        badges.forEach((b) => {
          b.textContent = 'Satellite Active';
          b.className = 'text-[9px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-1.5 py-0.2 rounded font-mono';
        });
      } else {
        AppState.weatherData = null; // Uses Universal Physics Climatology model
        badges.forEach((b) => {
          b.textContent = 'PVsyst Climatology Active';
          b.className = 'text-[9px] bg-blue-500/20 text-blue-300 border border-blue-500/40 px-1.5 py-0.2 rounded font-mono';
        });
      }
    })(),
    fetchMLPrediction(AppState.project.lat, AppState.project.lon, AppState.pv.capacityKwp)
  ]);

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

  // Update ML Status & Next-Hour Prediction Badge
  const mlBadge = document.getElementById('forecast-ml-badge');
  const mlBadgeText = document.getElementById('forecast-ml-badge-text');
  const mlNextHour = AppState.mlPrediction?.next_hour;

  if (mlBadge && mlBadgeText) {
    if (AppState.mlPrediction && mlNextHour) {
      mlBadge.classList.remove('hidden');
      mlBadge.classList.add('flex');
      if (isToday) {
        const p50Str = isWatt ? `${Math.round(mlNextHour.p50_w).toLocaleString()} W` : `${(mlNextHour.p50_w / 1000).toFixed(2)} kW`;
        const p10Str = isWatt ? `${Math.round(mlNextHour.p10_w).toLocaleString()} W` : `${(mlNextHour.p10_w / 1000).toFixed(2)} kW`;
        const p90Str = isWatt ? `${Math.round(mlNextHour.p90_w).toLocaleString()} W` : `${(mlNextHour.p90_w / 1000).toFixed(2)} kW`;
        mlBadgeText.textContent = `AI Next Hour: ${p50Str} (Conf: ${p10Str}–${p90Str})`;
      } else {
        mlBadgeText.textContent = 'AI Ensemble Active';
      }
    } else {
      mlBadge.classList.add('hidden');
      mlBadge.classList.remove('flex');
    }
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

    // Check if ML model prediction has an entry for this hour
    let mlPowerKw = null;
    if (AppState.mlPrediction && (isToday || isTomorrow)) {
      const targetHourStr = `${(h === 24 ? 0 : h).toString().padStart(2, '0')}:00:00`;
      const mlItem = AppState.mlPrediction.next_24h_physics?.find(x => x.hour_ending && x.hour_ending.includes(targetHourStr));
      if (mlItem && mlItem.p50_w !== undefined) {
        mlPowerKw = mlItem.p50_w / 1000;
      }
      // For the immediate next hour, use the LightGBM ML model directly
      if (isToday && (h === currentHour || h === currentHour + 1) && mlNextHour?.p50_w !== undefined && mlNextHour.p50_w > 0) {
        mlPowerKw = mlNextHour.p50_w / 1000;
      }
    }

    let ghi = 0;
    if (mlPowerKw !== null) {
      // Powered directly by ML model output
      ghi = mlPowerKw > 0 ? Math.round((mlPowerKw / Math.max(0.1, capacityKwp * pr)) * 1000) : 0;
    } else if (h >= 6 && h <= 18) {
      const solarTime = (isToday && h === currentHour) ? (h + currentMinute / 60) : (h + 0.5);
      const angle = ((solarTime - 6) / 12) * Math.PI;
      if (angle > 0 && angle < Math.PI) {
        ghi = Math.round(920 * variance * Math.pow(Math.sin(angle), 1.2));
      }
    } else if (isToday && h === 18 && currentMinute < 45) {
      ghi = 25; // twilight
    }

    const hourFraction = (isToday && h === currentHour) ? Math.max(0.05, (60 - currentMinute) / 60) : 1.0;
    const powerKw = (mlPowerKw !== null) ? mlPowerKw : Math.max(0, capacityKwp * (ghi / 1000) * pr);
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

    const cond = weatherConditions[d - 1];

    let dayYieldKwhPerKwp = 0;
    let dayKwh = 0;
    let mlSubtitle = cond.text;
    let mlBandHtml = '';

    const mlDay = AppState.mlPrediction?.daily?.find(x => x.lead_days === d);
    if (mlDay) {
      dayKwh = Math.round(mlDay.p50_kwh * 10) / 10;
      dayYieldKwhPerKwp = Math.round((dayKwh / capacityKwp) * 100) / 100;
      mlSubtitle = 'AI Ensemble: Lags + RF + Physics';
      const loVal = isWatt ? Math.round(mlDay.p10_kwh * 1000).toLocaleString() : mlDay.p10_kwh.toFixed(1);
      const hiVal = isWatt ? Math.round(mlDay.p90_kwh * 1000).toLocaleString() : mlDay.p90_kwh.toFixed(1);
      mlBandHtml = `<div class="text-[9px] text-purple-700 font-medium mt-0.5">80% Conf: ${loVal}–${hiVal}</div>`;
    } else {
      const factor = dailyVariances[d - 1];
      dayYieldKwhPerKwp = Math.round(baseDailyGhi * factor * 100) / 100;
      dayKwh = Math.round(capacityKwp * dayYieldKwhPerKwp * pr * 10) / 10;
    }

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
          <span class="text-[10px] text-slate-500 block mb-1">${mlSubtitle}</span>
          <div class="text-lg font-black text-emerald-600 font-mono">${cardEnergyDisp} <span class="text-[10px] font-normal text-slate-500">${cardUnitDisp}</span></div>
          ${mlBandHtml}
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
  document.getElementById('input-tilt')?.addEventListener('input', (e) => {
    AppState.pv.tiltDeg = parseFloat(e.target.value) || 13;
    updateHardwarePreviewBadge();
    runSimulation();
  });

  document.getElementById('btn-auto-tilt')?.addEventListener('click', () => {
    const opt = PVEngine.calculateOptimalTilt(AppState.project.lat);
    AppState.pv.tiltDeg = opt;
    const inpTilt = document.getElementById('input-tilt');
    if (inpTilt) inpTilt.value = opt;
    updateHardwarePreviewBadge();
    runSimulation();
  });

  document.getElementById('select-azimuth')?.addEventListener('change', (e) => {
    AppState.pv.azimuthDeg = parseFloat(e.target.value);
    runSimulation();
  });

  // Financial inputs
  document.getElementById('input-cost-per-kwp')?.addEventListener('input', (e) => {
    AppState.financials.costPerKwp = parseFloat(e.target.value) || 65000;
    updateHardwarePreviewBadge();
    runSimulation();
  });

  document.getElementById('input-tariff')?.addEventListener('input', (e) => {
    AppState.financials.tariff = parseFloat(e.target.value) || 7.50;
    updateHardwarePreviewBadge();
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

  // Floating View Mode Dropdown Tab (Hover/Float on Laptop, Click on Mobile & Laptop)
  const viewDropdownWrap = document.getElementById('schematic-view-dropdown-wrap');
  const btnToggleViewMenu = document.getElementById('btn-toggle-schematic-view-menu');

  btnToggleViewMenu?.addEventListener('click', (e) => {
    e.stopPropagation();
    viewDropdownWrap?.classList.toggle('menu-open');
  });

  // Close dropdown if clicked outside
  document.addEventListener('click', (e) => {
    if (viewDropdownWrap && !viewDropdownWrap.contains(e.target)) {
      viewDropdownWrap.classList.remove('menu-open');
    }
  });

  document.getElementById('btn-schematic-fit')?.addEventListener('click', () => setSchematicMode('fit'));
  document.getElementById('btn-schematic-zoom')?.addEventListener('click', () => setSchematicMode('zoomed'));

  // Mobile Panel Detail Modal Controls
  document.getElementById('btn-close-panel-modal')?.addEventListener('click', hidePanelTelemetryModal);
  document.getElementById('modal-panel-detail')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('modal-panel-detail')) {
      hidePanelTelemetryModal();
    }
  });
  document.getElementById('btn-modal-zoom-view')?.addEventListener('click', () => {
    hidePanelTelemetryModal();
    setSchematicMode('zoomed');
    setTimeout(() => {
      const container = document.getElementById('iot-string-row');
      container?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 100);
  });

  // Copy Cloud Backend URL
  document.getElementById('btn-copy-cloud-ip')?.addEventListener('click', () => {
    const input = document.getElementById('input-cloud-ip');
    if (input) {
      navigator.clipboard.writeText(input.value).then(() => {
        alert('Live Cloud URL copied to clipboard:\n' + input.value);
      });
    }
  });

  // Copy Server IP
  document.getElementById('btn-copy-server-ip')?.addEventListener('click', () => {
    const input = document.getElementById('input-server-ip');
    if (input) {
      navigator.clipboard.writeText(input.value).then(() => {
        alert('Local Server URL copied to clipboard:\n' + input.value);
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
    await triggerDirectTestNotification();
  });
}

function isPushAlertsEnabled() {
  return localStorage.getItem('heliopv_push_alerts_enabled') !== 'false';
}

function updatePushUI(isActive) {
  const btnToggle = document.getElementById('btn-toggle-push-notif');
  const lblStatus = document.getElementById('lbl-push-notif-status');
  const drawerLbl = document.getElementById('drawer-lbl-push-status');
  const drawerBadge = document.getElementById('drawer-badge-push');
  const drawerBell = document.getElementById('drawer-icon-push-bell');

  if (lblStatus) {
    lblStatus.textContent = isActive ? 'Push: Active' : 'Push: Disabled';
  }
  if (btnToggle) {
    if (isActive) {
      btnToggle.className = 'flex items-center gap-1.5 bg-emerald-900/60 text-emerald-300 border border-emerald-500/60 text-xs px-2.5 py-1.5 rounded-lg font-bold transition shadow-sm';
    } else {
      btnToggle.className = 'flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs px-2.5 py-1.5 rounded-lg font-medium border border-slate-700 transition';
    }
  }

  if (drawerLbl) {
    drawerLbl.textContent = isActive ? 'Active: Alerts enabled (Works in background)' : 'Disabled: Click to enable';
  }
  if (drawerBadge) {
    if (isActive) {
      drawerBadge.className = 'px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/40';
      drawerBadge.textContent = 'Active';
    } else {
      drawerBadge.className = 'px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-800 text-slate-400 border border-slate-700';
      drawerBadge.textContent = 'Disabled';
    }
  }
  if (drawerBell) {
    drawerBell.className = isActive ? 'w-4 h-4 text-emerald-400' : 'w-4 h-4 text-slate-500';
  }
}

async function scheduleCapacitorNotification(title, body) {
  const LocalNotifications = window.Capacitor?.Plugins?.LocalNotifications;
  if (!LocalNotifications) return false;
  try {
    const perm = await LocalNotifications.requestPermissions();
    if (perm && perm.display === 'granted') {
      await LocalNotifications.schedule({
        notifications: [
          {
            title: title,
            body: body,
            id: Math.floor(Math.random() * 90000) + 1000,
            schedule: { at: new Date(Date.now() + 100) },
            sound: null,
            attachments: null,
            actionTypeId: '',
            extra: null
          }
        ]
      });
      return true;
    }
  } catch (e) {
    console.warn('[Capacitor LocalNotification] schedule error:', e);
  }
  return false;
}

async function showServiceWorkerNotification(title, body) {
  if (!('serviceWorker' in navigator)) return false;
  try {
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 1500))
    ]).catch(() => null);

    if (reg && reg.showNotification) {
      await reg.showNotification(title, {
        body: body,
        icon: 'https://cdn-icons-png.flaticon.com/512/564/564619.png',
        badge: 'https://cdn-icons-png.flaticon.com/512/564/564619.png',
        vibrate: [250, 100, 250, 100, 250],
        tag: 'solar-fault-' + Date.now(),
        renotify: true,
        requireInteraction: true,
        data: { url: '/?view=monitor' }
      });
      return true;
    }
  } catch (e) {
    console.warn('[ServiceWorker Notification] error:', e);
  }
  return false;
}

function showWindowNotification(title, body) {
  if (!('Notification' in window)) return false;
  try {
    if (Notification.permission === 'granted') {
      new Notification(title, {
        body: body,
        icon: 'https://cdn-icons-png.flaticon.com/512/564/564619.png',
        vibrate: [250, 100, 250]
      });
      return true;
    }
  } catch (e) {
    console.warn('[Window Notification] error:', e);
  }
  return false;
}

async function dispatchSystemNotification(title, body) {
  // 1. Native Capacitor (Android Mobile App)
  let dispatched = await scheduleCapacitorNotification(title, body);

  // 2. ServiceWorker notification fallback
  if (!dispatched) {
    dispatched = await showServiceWorkerNotification(title, body);
  }

  // 3. Desktop browser Window Notification fallback
  if (!dispatched) {
    dispatched = showWindowNotification(title, body);
  }

  return dispatched;
}

let lastSeenTestAlertId = null;

async function triggerDirectTestNotification() {
  playFaultAlertAudio();

  const title = '⚠️ Solar String Fault Detected! (Test Alert)';
  const body = 'Wire break simulation at Node 2: Open circuit detected. Real-time background push alert test.';

  // Dispatch locally on this triggering device (laptop)
  await dispatchSystemNotification(title, body);

  const testId = Date.now();
  lastSeenTestAlertId = testId;

  const payload = {
    testId: testId,
    title: title,
    body: body,
    userEmail: AuthState.user ? AuthState.user.email : null,
    userId: AuthState.user ? (AuthState.user._id || AuthState.user.id) : null
  };

  const headers = getAuthHeaders();

  // 1. Broadcast to local/current backend
  try {
    fetch(`${getBackendBaseUrl()}/api/push-test`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload)
    }).catch(() => {});

    // 2. If running locally on localhost, ALSO forward to cloud Render backend so the phone gets it!
    if (!window.location.hostname.includes('onrender.com')) {
      fetch('https://heliopv-solar.onrender.com/api/push-test', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(payload)
      }).catch(() => {});
    }
  } catch (e) {}

  // Immediate confirmation alert so user knows test executed
  alert('🔔 Test Background Push Alert Dispatched!\n\nA system alert was triggered. Because your account is synced, this alert is now landing on your mobile phone as well!');
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

/**
 * Ensure device is registered for notifications and subscribed to Web Push backend
 */
async function ensurePushSubscription() {
  if (!isPushAlertsEnabled()) return;

  // 1. Request Native permissions if in Capacitor
  if (window.Capacitor?.Plugins?.LocalNotifications) {
    try {
      await window.Capacitor.Plugins.LocalNotifications.requestPermissions();
    } catch (e) {}
  }

  // 2. Request Web permissions if in browser
  if ('Notification' in window && Notification.permission === 'default') {
    try {
      await Notification.requestPermission();
    } catch (e) {}
  }

  // 3. Register ServiceWorker and auto-subscribe to backend Web Push
  if ('serviceWorker' in navigator && 'PushManager' in window) {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();

      if (!sub && ('Notification' in window && Notification.permission === 'granted')) {
        const res = await fetch(`${getBackendBaseUrl()}/api/vapid-public-key`);
        if (res.ok) {
          const { publicKey } = await res.json();
          const convertedKey = urlBase64ToUint8Array(publicKey);
          sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: convertedKey
          });
        }
      }

      if (sub) {
        const subData = sub.toJSON ? sub.toJSON() : sub;
        const payload = {
          endpoint: sub.endpoint,
          keys: subData.keys,
          userEmail: AuthState.user ? AuthState.user.email : null,
          userId: AuthState.user ? (AuthState.user._id || AuthState.user.id) : null
        };
        const headers = getAuthHeaders();
        await fetch(`${getBackendBaseUrl()}/api/push-subscribe`, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(payload)
        }).catch(() => {});

        // Also sync subscription to Cloud backend if running locally
        if (!window.location.hostname.includes('onrender.com')) {
          fetch('https://heliopv-solar.onrender.com/api/push-subscribe', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(payload)
          }).catch(() => {});
        }
      }
    } catch (e) {
      console.warn('[WebPush] ensurePushSubscription info:', e.message);
    }
  }
}

async function togglePushNotificationAlerts() {
  const currentActive = isPushAlertsEnabled();

  if (currentActive) {
    localStorage.setItem('heliopv_push_alerts_enabled', 'false');
    updatePushUI(false);

    if ('serviceWorker' in navigator && 'PushManager' in window) {
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await sub.unsubscribe();
          fetch(`${getBackendBaseUrl()}/api/push-unsubscribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: sub.endpoint })
          }).catch(() => {});
        }
      } catch (e) {}
    }
    alert('🔕 Background Push Alerts Disabled.\n\nYou will no longer receive notifications on this device.');
  } else {
    localStorage.setItem('heliopv_push_alerts_enabled', 'true');
    updatePushUI(true);

    await ensurePushSubscription();

    alert('🔔 Background Push Alerts Active!\n\nYou will now receive system notifications on your phone or PC whenever a wire fault or open-circuit break occurs—even when the app is closed or in the background!');
  }
}

async function setupPushNotifications() {
  // Always initialize UI based on user preference
  updatePushUI(isPushAlertsEnabled());

  // Attach click listener to both drawer button and hidden header button
  document.getElementById('btn-toggle-push-notif')?.addEventListener('click', togglePushNotificationAlerts);
  document.getElementById('drawer-btn-push-alerts')?.addEventListener('click', togglePushNotificationAlerts);

  // Auto-register service worker & push subscription if enabled
  if (isPushAlertsEnabled()) {
    ensurePushSubscription().catch(() => {});
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
  if (!AuthState.token) {
    AuthState.intendedView = viewName;
    lockAuthWall('login', 'Please sign in or create an account to access ' + (viewName === 'monitor' ? 'Live String Monitor' : 'Solar Estimation'));
    return;
  }
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

function startIoTMonitoring() {
  if (IoTMonitorState.pollIntervalId) clearInterval(IoTMonitorState.pollIntervalId);
  pollIoTStatus();
  // High-frequency responsive polling (350ms) for real-time ESP32 telemetry updates
  IoTMonitorState.pollIntervalId = setInterval(() => pollIoTStatus(false), 350);
  fetchNetworkInfo();

  // Set initial schematic mode: Fit on mobile, Zoom (PC View) on laptop/desktop
  const container = document.getElementById('iot-string-row');
  if (container && !container.classList.contains('schematic-fit-mode') && !container.classList.contains('schematic-zoom-mode')) {
    setSchematicMode(window.innerWidth <= 768 ? 'fit' : 'zoomed');
  }
}

function stopIoTMonitoring() {
  if (IoTMonitorState.pollIntervalId) {
    clearInterval(IoTMonitorState.pollIntervalId);
    IoTMonitorState.pollIntervalId = null;
  }
}

function initIoTMonitor() {
  if (AuthState.token) {
    startIoTMonitoring();
  }
}

async function fetchNetworkInfo() {
  const cloudUrl = 'https://heliopv-solar.onrender.com/api/data';
  const inputCloudIp = document.getElementById('input-cloud-ip');
  if (inputCloudIp) inputCloudIp.value = cloudUrl;

  const codeSnippet = document.getElementById('code-snippet-esp32');
  if (codeSnippet) {
    codeSnippet.textContent = `const char *BACKEND_URL = "${cloudUrl}";`;
  }

  try {
    const res = await fetch(`${getBackendBaseUrl()}/api/network-info`);
    if (res.ok) {
      const data = await res.json();
      const primaryIP = (data.localIPs && data.localIPs.length > 0) ? data.localIPs[0].address : 'localhost';
      const localTargetUrl = `http://${primaryIP}:${data.port || 3000}/api/data`;

      const inputServerIp = document.getElementById('input-server-ip');
      if (inputServerIp) inputServerIp.value = localTargetUrl;
    }
  } catch (err) {
    const inputServerIp = document.getElementById('input-server-ip');
    if (inputServerIp) inputServerIp.value = 'http://localhost:3000/api/data';
  }
}

async function pollIoTStatus(force = false) {
  if (!AuthState.token) return;
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

async function sendFaultPushNotification(title, body) {
  if (!isPushAlertsEnabled()) return;
  playFaultAlertAudio();
  await dispatchSystemNotification(title, body);

  // Broadcast to backend Web Push so all subscriber devices get the notification immediately
  try {
    fetch(`${getBackendBaseUrl()}/api/push-fault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body })
    }).catch(() => {});
  } catch (e) {}
}

function updateDrawerGatewayStatus(gatewayOnline, faultDescription, faultNodeId, isSimulated, simulationScenario) {
  const tag = document.getElementById('drawer-gateway-status-tag');
  const pingDot = document.getElementById('drawer-gw-ping-dot');
  const statusDot = document.getElementById('drawer-gw-status-dot');
  const stateText = document.getElementById('drawer-gw-state-text');
  const statementText = document.getElementById('drawer-gw-statement-text');

  if (!tag || !stateText || !statementText) return;

  if (isSimulated && simulationScenario !== 'live_hardware') {
    tag.className = 'w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl border border-blue-500/40 bg-blue-950/30 text-blue-300 font-mono text-xs shadow-sm transition-all duration-200';
    if (pingDot) pingDot.className = 'hidden';
    if (statusDot) statusDot.className = 'relative inline-flex rounded-full h-2 w-2 bg-blue-400';
    stateText.className = 'font-extrabold text-blue-400 tracking-wider';
    stateText.textContent = 'SIMULATED';
    statementText.className = 'text-[11px] text-blue-300/90 font-sans font-medium';
    statementText.textContent = faultDescription ? `Fault at Node ${faultNodeId}` : (simulationScenario ? `Scenario: ${simulationScenario}` : 'Demo Simulation');
    return;
  }

  if (gatewayOnline) {
    if (faultNodeId) {
      tag.className = 'w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl border border-red-500/50 bg-red-950/40 text-red-300 font-mono text-xs shadow-sm transition-all duration-200';
      if (pingDot) pingDot.className = 'animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75';
      if (statusDot) statusDot.className = 'relative inline-flex rounded-full h-2 w-2 bg-red-500';
      stateText.className = 'font-extrabold text-red-400 tracking-wider';
      stateText.textContent = 'BREAK DETECTED';
      statementText.className = 'text-[11px] text-red-300/90 font-sans font-medium truncate max-w-[170px]';
      statementText.textContent = `Node ${faultNodeId} Open Circuit`;
    } else {
      tag.className = 'w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl border border-emerald-500/40 bg-emerald-950/30 text-emerald-300 font-mono text-xs shadow-sm transition-all duration-200';
      if (pingDot) pingDot.className = 'animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75';
      if (statusDot) statusDot.className = 'relative inline-flex rounded-full h-2 w-2 bg-emerald-500';
      stateText.className = 'font-extrabold text-emerald-400 tracking-wider';
      stateText.textContent = 'ONLINE';
      statementText.className = 'text-[11px] text-emerald-300/90 font-sans font-medium';
      statementText.textContent = 'ESP32 Gateway Active';
    }
  } else {
    tag.className = 'w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl border border-red-500/40 bg-red-950/30 text-red-300 font-mono text-xs shadow-sm transition-all duration-200';
    if (pingDot) pingDot.className = 'hidden';
    if (statusDot) statusDot.className = 'relative inline-flex rounded-full h-2 w-2 bg-red-500';
    stateText.className = 'font-extrabold text-red-400 tracking-wider';
    stateText.textContent = 'OFFLINE';
    statementText.className = 'text-[11px] text-amber-300/90 font-sans font-medium';
    statementText.textContent = 'Waiting for ESP32';
  }
}

// Request permission once on first click on mobile/desktop and ensure WebPush registration
document.addEventListener('click', function initNotifyPermission() {
  if (isPushAlertsEnabled()) {
    ensurePushSubscription().catch(() => {});
  }
  document.removeEventListener('click', initNotifyPermission);
}, { once: true });

let lastGatewayOnlineTimestamp = 0;
const GATEWAY_OFFLINE_GRACE_MS = 7000; // 7-second grace delay before showing offline

function renderIoTMonitor(data) {
  if (data.gatewayOnline) {
    lastGatewayOnlineTimestamp = Date.now();
  }
  const isWithin7sGrace = (lastGatewayOnlineTimestamp > 0 && (Date.now() - lastGatewayOnlineTimestamp < GATEWAY_OFFLINE_GRACE_MS));
  const effectiveGatewayOnline = data.gatewayOnline || isWithin7sGrace;

  IoTMonitorState.gatewayOnline = effectiveGatewayOnline;
  IoTMonitorState.faultNodeId = data.faultNodeId;
  IoTMonitorState.faultDescription = data.faultDescription;
  IoTMonitorState.wires = data.wires || [];
  IoTMonitorState.cells = data.cells || [];
  IoTMonitorState.isSimulated = data.isSimulated;
  IoTMonitorState.simulationScenario = data.simulationScenario;

  // 1. Gateway Status Badge & Dot Indicators
  const gwBadge = document.getElementById('iot-gateway-status');
  const pingDot = document.getElementById('gateway-ping-dot');
  const statusDot = document.getElementById('gateway-status-dot');

  if (effectiveGatewayOnline) {
    if (gwBadge) {
      const extraTag = data.isSimulated
        ? '<span class="text-[10px] text-blue-300 font-mono">(Simulated)</span>'
        : (!data.gatewayOnline && isWithin7sGrace ? '<span class="text-[10px] text-emerald-300/80 font-mono">(Syncing)</span>' : '');
      gwBadge.innerHTML = `<span class="inline-block w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse"></span> <span class="text-emerald-400">ESP32 Gateway: ONLINE</span> ${extraTag}`;
      gwBadge.className = 'inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-bold border border-emerald-500/50 bg-emerald-950/40 text-emerald-300';
    }
    if (pingDot) pingDot.className = 'animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75';
    if (statusDot) statusDot.className = 'relative inline-flex rounded-full h-2 w-2 bg-emerald-500';
  } else {
    if (gwBadge) {
      gwBadge.innerHTML = '<span class="inline-block w-2.5 h-2.5 rounded-full bg-red-500"></span> <span class="text-red-400">ESP32 Gateway: OFFLINE</span>';
      gwBadge.className = 'inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-bold border border-red-500/50 bg-red-950/40 text-red-300';
    }
    if (pingDot) pingDot.className = 'hidden';
    if (statusDot) statusDot.className = 'relative inline-flex rounded-full h-2 w-2 bg-red-500';
  }

  // Update Operator Profile Statement Tag (below profile info & above System Controls & Tools)
  updateDrawerGatewayStatus(effectiveGatewayOnline, data.faultDescription, data.faultNodeId, data.isSimulated, data.simulationScenario);

  // 2. Alert Box (Root Cause Fault Isolation) & Notifications
  const alertBox = document.getElementById('iot-alert-box');
  const estIotBadge = document.getElementById('estimation-iot-status-badge');
  const mobileFaultBadge = document.getElementById('mobile-nav-fault-badge');

  // Cross-device test alert synchronization (e.g. from laptop to mobile with same account)
  if (data.pendingAlert && data.pendingAlert.id) {
    const alertId = data.pendingAlert.id;
    const alertAge = Date.now() - (data.pendingAlert.timestamp || 0);
    if (alertId !== lastSeenTestAlertId && alertAge < 45000) {
      lastSeenTestAlertId = alertId;
      playFaultAlertAudio();
      dispatchSystemNotification(
        data.pendingAlert.title || '⚠️ Solar String Fault Detected! (Test Alert)',
        data.pendingAlert.body || 'Wire break simulation at Node 2: Open circuit detected.'
      );
    }
  }

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
      const wireDetail = data.brokenWireId
        ? `<div class="mt-1 font-mono text-[11px] text-red-200">Severed Wire: <strong>${data.brokenWireId}</strong> (${data.faultType === 'power' ? 'Power Flow Severed' : 'Continuity / Ground'})</div>`
        : '';
      alertBox.innerHTML = `
        <div class="alert-title">&#9888; ROOT CAUSE FAULT DETECTED: ${data.faultDescription}</div>
        ${wireDetail}
        <div class="text-xs mt-1">
          <strong>Fault Isolation Analysis:</strong> Node ${data.faultNodeId} is the <em>lowest numbered node</em> reporting broken continuity.
          All subsequent downstream nodes (shaded in gray unverified zone) cannot verify continuity until this upstream open circuit is repaired.
        </div>
      `;
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
      if (estIotBadge) {
        estIotBadge.textContent = '● All 4 Nodes Connected';
        estIotBadge.className = 'font-mono text-emerald-700 font-semibold bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200';
      }
    }
  }

  // 3. Render Visual Schematic Array with SVG switches & Multi-Wire Topology
  const container = document.getElementById('iot-string-row');
  if (container && data.cells && data.cells.length > 0) {
    latestSchematicCells = data.cells;
    const wires = data.wires || [];

    const p1 = data.cells.find(c => c.id === 1) || data.cells[0];
    const p2 = data.cells.find(c => c.id === 2) || data.cells[1];
    const p3 = data.cells.find(c => c.id === 3) || data.cells[2];
    const str = data.cells.find(c => c.id === 4) || data.cells[3];

    const retState = getWireState(wires, 'W_P1_STR_RET');

    function renderCellHtml(c) {
      if (!c) return '';
      const isString = (c.type === 'string');
      const label = isString ? 'String Monitor' : (`Panel ${c.id}`);
      const shortLabel = isString ? 'String' : (`P${c.id}`);
      const cardClass = isString ? 'string-node' : 'panel';

      return `
        <div class="iot-cell ${cardClass} ${c.state}" data-node-id="${c.id}" data-node-type="${c.type}" title="${label}: hold or tap for details">
          <!-- Desktop Full View Title -->
          <h3 class="cell-title-full">${label}</h3>
          <!-- Mobile Fit View Compact Title -->
          <h3 class="cell-title-compact">${shortLabel}</h3>

          <div class="iot-badge ${c.state}">${IOT_LABELS[c.state] || c.state}</div>

          <!-- Primary Metric for Mobile Fit View -->
          <div class="cell-compact-metric">
            <span class="compact-volt">${typeof c.voltage === 'number' ? c.voltage.toFixed(1) + 'V' : '--'}</span>
          </div>

          <div class="iot-vals">${renderCellBody(c)}</div>
          <div class="iot-note ${c.state === 'broken' ? 'warn' : ''}">${(c.id === 1 && c.state === 'ok') ? 'String Origin (+/-). Reference Lead.' : (IOT_NOTES[c.state] || '')}</div>
        </div>
      `;
    }

    const html = `
      <div class="schematic-cards-flex">
        ${renderCellHtml(p1)}

        <!-- Inter-Panel Wire Junction 1-2 -->
        <div class="wire-junction-column" title="Panel 1 to Panel 2 Multi-Wire Junction">
          <div class="wire-junction-item" title="W_P1_P2_PWR: Main Power (+) Line">
            <span class="wire-role-label power">Power +</span>
            ${renderSwitchSvg(getWireState(wires, 'W_P1_P2_PWR'))}
          </div>
          <div class="wire-junction-item" title="W_P1_P2_SENSE: Optocoupler Sensing GND">
            <span class="wire-role-label sense">Sense GND</span>
            ${renderSwitchSvg(getWireState(wires, 'W_P1_P2_SENSE'))}
          </div>
        </div>

        ${renderCellHtml(p2)}

        <!-- Inter-Panel Wire Junction 2-3 -->
        <div class="wire-junction-column" title="Panel 2 to Panel 3 Multi-Wire Junction">
          <div class="wire-junction-item" title="W_P2_P3_PWR: Main Power (+) Line">
            <span class="wire-role-label power">Power +</span>
            ${renderSwitchSvg(getWireState(wires, 'W_P2_P3_PWR'))}
          </div>
          <div class="wire-junction-item" title="W_P2_P3_SENSE: Daisy-Chained Sensing GND">
            <span class="wire-role-label sense">Sense GND</span>
            ${renderSwitchSvg(getWireState(wires, 'W_P2_P3_SENSE'))}
          </div>
        </div>

        ${renderCellHtml(p3)}

        <!-- Inter-Panel Wire Junction 3-String -->
        <div class="wire-junction-column" title="Panel 3 to String Module Junction">
          <div class="wire-junction-item" title="W_P3_STR_PWR: String Power (+) Line">
            <span class="wire-role-label power">String +</span>
            ${renderSwitchSvg(getWireState(wires, 'W_P3_STR_PWR'))}
          </div>
          <div class="wire-junction-item" title="W_P3_STR_SENSE: Continuity Signal Wire">
            <span class="wire-role-label sense">Sense In</span>
            ${renderSwitchSvg(getWireState(wires, 'W_P3_STR_SENSE'))}
          </div>
        </div>

        ${renderCellHtml(str)}
      </div>

      <!-- Direct Ground Return Bus (W_P1_STR_RET) -->
      <div class="ground-return-bus-wrap" title="Direct Ground Return Bus: Panel 1(-) directly to String Node (-)">
        <div class="ground-bus-header">
          <div class="flex items-center gap-1.5 font-mono text-[11px] font-semibold text-emerald-400">
            <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            Direct Return Ground Bus (Continuous Ground)
          </div>
          <div class="text-[11px] font-mono text-slate-400">
            Topology: Optocoupler EL817 Multi-Wire Array
          </div>
        </div>
        <div class="ground-bus-track">
          <div class="ground-terminal">
            <span class="terminal-node-dot"></span>
            <span>P1 (-) Ground Lead</span>
          </div>
          <div class="ground-bus-wire-lead ${retState}"></div>
          <div class="ground-switch-center">
            <span class="wire-role-label ret">W_P1_STR_RET (Return GND)</span>
            ${renderSwitchSvg(retState)}
          </div>
          <div class="ground-bus-wire-lead ${retState}"></div>
          <div class="ground-terminal">
            <span>String Node (-) Input</span>
            <span class="terminal-node-dot"></span>
          </div>
        </div>
      </div>
    `;

    container.innerHTML = html;
    setupCellTouchEvents();

    // If panel detail modal is open on mobile, update its real-time values
    if (currentModalNodeId !== null) {
      const currentCell = latestSchematicCells.find(c => c.id === currentModalNodeId);
      if (currentCell) updateModalTelemetryValues(currentCell);
    }
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

function getWireState(wires, wireId) {
  if (!wires || !Array.isArray(wires)) return 'no_signal';
  const match = wires.find(w => w.id === wireId);
  if (match && match.state) return match.state;

  // Fallback for legacy 3-wire format:
  if (wireId === 'W_P1_P2_PWR' || wireId === 'W_P1_P2_SENSE') {
    const leg = wires.find(w => w.from === 1 && w.to === 2);
    return leg ? (leg.state || 'no_signal') : 'no_signal';
  }
  if (wireId === 'W_P2_P3_PWR' || wireId === 'W_P2_P3_SENSE') {
    const leg = wires.find(w => w.from === 2 && w.to === 3);
    return leg ? (leg.state || 'no_signal') : 'no_signal';
  }
  if (wireId === 'W_P3_STR_PWR' || wireId === 'W_P3_STR_SENSE') {
    const leg = wires.find(w => w.from === 3 && w.to === 4);
    return leg ? (leg.state || 'no_signal') : 'no_signal';
  }
  if (wireId === 'W_P1_STR_RET') {
    const leg = wires.find(w => w.id === 'W_P1_STR_RET');
    return leg ? (leg.state || 'closed') : 'closed';
  }
  return 'no_signal';
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
  // SVG Dimensions: 72 x 24. Contact terminals at x=14 and x=58 (y=12).
  if (state === "closed") {
    return `
      <svg class="wire-svg" viewBox="0 0 72 24">
        <line x1="0" y1="12" x2="14" y2="12" stroke="#3fb950" stroke-width="2.5" />
        <line x1="58" y1="12" x2="72" y2="12" stroke="#3fb950" stroke-width="2.5" />
        <circle cx="14" cy="12" r="3.5" fill="#3fb950" />
        <circle cx="58" cy="12" r="3.5" fill="#3fb950" />
        <line x1="14" y1="12" x2="58" y2="12" stroke="#3fb950" stroke-width="3" stroke-linecap="round" />
      </svg>
      <div class="wire-status-text closed">✔️ CLOSED</div>
    `;
  } else if (state === "open") {
    return `
      <svg class="wire-svg" viewBox="0 0 72 24">
        <line x1="0" y1="12" x2="14" y2="12" stroke="#f85149" stroke-width="2.5" />
        <line x1="58" y1="12" x2="72" y2="12" stroke="#f85149" stroke-width="2.5" />
        <circle cx="14" cy="12" r="3.5" fill="#f85149" />
        <circle cx="58" cy="12" r="3.5" fill="#f85149" />
        <!-- Blade swung up 45 degrees -->
        <line class="wire-open-arm" x1="14" y1="12" x2="48" y2="2" stroke="#f85149" stroke-width="3" stroke-linecap="round" />
        <!-- Yellow spark indicator -->
        <line x1="44" y1="6" x2="50" y2="11" stroke="#ffeb3b" stroke-width="1.5" stroke-dasharray="2,2" />
      </svg>
      <div class="wire-status-text open">⚠️ OPEN CKT</div>
    `;
  } else if (state === "gray_zone") {
    return `
      <svg class="wire-svg" viewBox="0 0 72 24">
        <line x1="0" y1="12" x2="14" y2="12" stroke="#6e7681" stroke-width="2" stroke-dasharray="3,3" />
        <line x1="58" y1="12" x2="72" y2="12" stroke="#6e7681" stroke-width="2" stroke-dasharray="3,3" />
        <circle cx="14" cy="12" r="3" fill="#6e7681" />
        <circle cx="58" cy="12" r="3" fill="#6e7681" />
        <line class="wire-gray-arm" x1="14" y1="12" x2="58" y2="12" stroke="#8b949e" stroke-width="2" stroke-dasharray="3,3" />
      </svg>
      <div class="wire-status-text gray_zone">? UNVERIFIED</div>
    `;
  } else {
    return `
      <svg class="wire-svg" viewBox="0 0 72 24">
        <line x1="0" y1="12" x2="72" y2="12" stroke="#30363d" stroke-width="2" stroke-dasharray="3,3" />
      </svg>
      <div class="wire-status-text no_signal">—</div>
    `;
  }
}

// ==========================================================================
// Mobile Responsive Schematic Controls, Short-Hold Long Press & Telemetry Popover
// ==========================================================================

let latestSchematicCells = [];
let currentModalNodeId = null;

function setSchematicMode(mode) {
  const container = document.getElementById('iot-string-row');
  const checkFit = document.getElementById('check-schematic-fit');
  const checkZoom = document.getElementById('check-schematic-zoom');
  const btnFit = document.getElementById('btn-schematic-fit');
  const btnZoom = document.getElementById('btn-schematic-zoom');
  const modeText = document.getElementById('current-schematic-mode-text');
  const modeIcon = document.getElementById('current-schematic-mode-icon');
  const dropdownWrap = document.getElementById('schematic-view-dropdown-wrap');

  if (mode === 'zoomed') {
    container?.classList.remove('schematic-fit-mode', 'mobile-fit-screen');
    container?.classList.add('schematic-zoom-mode', 'mobile-zoomed');

    if (modeText) modeText.textContent = 'Zoom (PC View)';
    if (modeIcon) {
      modeIcon.setAttribute('data-lucide', 'zoom-in');
      modeIcon.className = 'w-3 h-3 text-amber-400';
    }

    if (checkZoom) checkZoom.classList.remove('hidden');
    if (checkFit) checkFit.classList.add('hidden');

    if (btnZoom) {
      btnZoom.className = 'w-full text-left px-2.5 py-1.5 text-xs font-semibold rounded-lg flex items-center justify-between transition text-white bg-amber-500/20 border border-amber-500/40 mt-1';
    }
    if (btnFit) {
      btnFit.className = 'w-full text-left px-2.5 py-1.5 text-xs font-semibold rounded-lg flex items-center justify-between transition text-slate-300 hover:text-white hover:bg-slate-800';
    }
  } else {
    container?.classList.remove('schematic-zoom-mode', 'mobile-zoomed');
    container?.classList.add('schematic-fit-mode', 'mobile-fit-screen');

    if (modeText) modeText.textContent = 'Fit Screen';
    if (modeIcon) {
      modeIcon.setAttribute('data-lucide', 'smartphone');
      modeIcon.className = 'w-3 h-3 text-blue-400';
    }

    if (checkFit) checkFit.classList.remove('hidden');
    if (checkZoom) checkZoom.classList.add('hidden');

    if (btnFit) {
      btnFit.className = 'w-full text-left px-2.5 py-1.5 text-xs font-semibold rounded-lg flex items-center justify-between transition text-white bg-blue-600/20 border border-blue-500/40';
    }
    if (btnZoom) {
      btnZoom.className = 'w-full text-left px-2.5 py-1.5 text-xs font-semibold rounded-lg flex items-center justify-between transition text-slate-300 hover:text-white hover:bg-slate-800 mt-1';
    }
  }

  // Close dropdown on click selection
  dropdownWrap?.classList.remove('menu-open');
  if (window.lucide) lucide.createIcons();
}

function setSchematicMobileMode(mode) {
  setSchematicMode(mode);
}

function toggleMobileSchematicZoom() {
  const container = document.getElementById('iot-string-row');
  if (!container) return;
  const isZoomed = container.classList.contains('schematic-zoom-mode') || container.classList.contains('mobile-zoomed');
  setSchematicMode(isZoomed ? 'fit' : 'zoomed');
}

function showPanelTelemetryModal(nodeId) {
  currentModalNodeId = nodeId;
  const cell = latestSchematicCells.find(c => c.id === nodeId);
  if (!cell) return;

  const modal = document.getElementById('modal-panel-detail');
  updateModalTelemetryValues(cell);

  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    if (window.lucide) lucide.createIcons();
  }
}

function hidePanelTelemetryModal() {
  currentModalNodeId = null;
  const modal = document.getElementById('modal-panel-detail');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
}

function updateModalTelemetryValues(cell) {
  if (!cell) return;
  const iconWrap = document.getElementById('panel-modal-icon-wrap');
  const title = document.getElementById('panel-modal-title');
  const typeText = document.getElementById('panel-modal-type');
  const badge = document.getElementById('panel-modal-badge');
  const statusText = document.getElementById('panel-modal-status-text');
  const voltEl = document.getElementById('panel-modal-volt');
  const tempEl = document.getElementById('panel-modal-temp');
  const currEl = document.getElementById('panel-modal-curr');
  const pwrEl = document.getElementById('panel-modal-pwr');
  const noteText = document.getElementById('panel-modal-note-text');

  const isString = (cell.type === 'string');
  if (title) title.textContent = isString ? 'String Monitor 4' : `Solar Panel ${cell.id}`;
  if (iconWrap) iconWrap.textContent = isString ? 'STR' : `P${cell.id}`;
  if (typeText) {
    typeText.textContent = isString
      ? 'Master String Monitor (DFRobot Beetle ESP32-C6)'
      : `Series Micro-Node (CH32V003 • Pipe ${cell.id})`;
  }

  const voltStr = typeof cell.voltage === 'number' ? `${cell.voltage.toFixed(2)} V` : '-- V';
  const tempStr = typeof cell.temp === 'number' ? `${cell.temp.toFixed(1)} °C` : (isString ? 'Panel Avg' : 'Sensor absent');
  const currStr = typeof cell.current === 'number' ? `${cell.current.toFixed(3)} A` : '-- A';
  const pwrStr = typeof cell.power === 'number' ? `${cell.power.toFixed(2)} W` : '-- W';

  if (voltEl) voltEl.textContent = voltStr;
  if (tempEl) tempEl.textContent = tempStr;
  if (currEl) currEl.textContent = currStr;
  if (pwrEl) pwrEl.textContent = pwrStr;

  const stateLabel = IOT_LABELS[cell.state] || cell.state;
  if (statusText) statusText.textContent = stateLabel;

  if (badge) {
    badge.className = `px-3 py-1.5 rounded-lg text-xs font-bold flex items-center justify-between iot-badge ${cell.state}`;
  }

  const noteStr = (cell.id === 1 && cell.state === 'ok')
    ? 'String Origin (+/-). Positive & Return Ground Reference.'
    : (IOT_NOTES[cell.state] || 'All series connections continuous and active.');
  if (noteText) noteText.textContent = noteStr;
}

let touchTimer = null;
let touchStartX = 0;
let touchStartY = 0;
let hasLongPressed = false;

function setupCellTouchEvents() {
  const container = document.getElementById('iot-string-row');
  if (!container) return;

  container.querySelectorAll('.iot-cell').forEach(cell => {
    const nodeId = parseInt(cell.getAttribute('data-node-id'), 10);
    let lastTapTime = 0;

    const onStart = (e) => {
      hasLongPressed = false;
      const touch = e.touches ? e.touches[0] : e;
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;

      cell.classList.add('cell-pressed');

      if (touchTimer) clearTimeout(touchTimer);
      // Short duration: 240ms triggers long-press info
      touchTimer = setTimeout(() => {
        hasLongPressed = true;
        cell.classList.remove('cell-pressed');
        if (navigator.vibrate) {
          try { navigator.vibrate(35); } catch (e) {}
        }
        showPanelTelemetryModal(nodeId);
      }, 240);
    };

    const onMove = (e) => {
      const touch = e.touches ? e.touches[0] : e;
      const diffX = Math.abs(touch.clientX - touchStartX);
      const diffY = Math.abs(touch.clientY - touchStartY);
      if (diffX > 10 || diffY > 10) {
        if (touchTimer) clearTimeout(touchTimer);
        cell.classList.remove('cell-pressed');
      }
    };

    const onEnd = (e) => {
      cell.classList.remove('cell-pressed');
      if (touchTimer) {
        clearTimeout(touchTimer);
        touchTimer = null;
      }

      // Check double-tap
      const now = Date.now();
      if (now - lastTapTime < 300) {
        toggleMobileSchematicZoom();
        lastTapTime = 0;
        return;
      }
      lastTapTime = now;

      // If user tapped without waiting full long-press, show telemetry info if in mobile-fit mode
      if (!hasLongPressed && window.innerWidth <= 768) {
        const isFit = container.classList.contains('mobile-fit-screen');
        if (isFit) {
          showPanelTelemetryModal(nodeId);
        }
      }
    };

    cell.addEventListener('touchstart', onStart, { passive: true });
    cell.addEventListener('touchmove', onMove, { passive: true });
    cell.addEventListener('touchend', onEnd);
    cell.addEventListener('touchcancel', () => {
      cell.classList.remove('cell-pressed');
      if (touchTimer) clearTimeout(touchTimer);
    });

    cell.addEventListener('click', (e) => {
      if (window.innerWidth <= 768 && container.classList.contains('mobile-fit-screen')) {
        showPanelTelemetryModal(nodeId);
      }
    });
  });
}

function renderIoTMonitorOffline(errMsg) {
  // If the gateway was seen online within the last 7 seconds, give it a 7-second grace period before switching to offline
  if (lastGatewayOnlineTimestamp > 0 && (Date.now() - lastGatewayOnlineTimestamp < GATEWAY_OFFLINE_GRACE_MS)) {
    return;
  }

  const gwBadge = document.getElementById('iot-gateway-status');
  if (gwBadge) {
    gwBadge.innerHTML = '<span class="inline-block w-2.5 h-2.5 rounded-full bg-slate-500"></span> <span class="text-slate-400">Server Offline (:3000)</span>';
    gwBadge.className = 'inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-bold border border-slate-700 bg-slate-900 text-slate-400';
  }

  const pingDot = document.getElementById('gateway-ping-dot');
  const statusDot = document.getElementById('gateway-status-dot');
  if (pingDot) pingDot.className = 'hidden';
  if (statusDot) statusDot.className = 'relative inline-flex rounded-full h-2 w-2 bg-red-500';

  updateDrawerGatewayStatus(false, null, null, false, null);

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
      if (id === 2) faultDescription = "Disconnection detected between Panel 1 and Panel 2! String current dropped to 0.";
      else if (id === 3) faultDescription = "Disconnection detected between Panel 2 and Panel 3! String current dropped to 0.";
      else if (id === 4) faultDescription = "Disconnection detected between Panel 3 and String Node! String current dropped to 0.";
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
      return { id, type: typeName, state, temp: t, voltage: v, continuity: n.continuity };
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
      continuity: n.continuity,
      ldr: n.ldr_raw
    };
  });

  const stringNode = mockNodes.find(x => x.id === 4);
  const stringCurrent_mA = stringNode ? (stringNode.current_mA || 0) : 0;
  const isPowerFlowing = stringCurrent_mA > 15;

  let brokenWireId = null;
  let faultType = 'none';

  if (faultNodeId === 2) {
    brokenWireId = 'W_P1_P2_PWR';
    faultType = 'power';
  } else if (faultNodeId === 3) {
    brokenWireId = 'W_P2_P3_PWR';
    faultType = 'power';
  } else if (faultNodeId === 4) {
    brokenWireId = 'W_P3_STR_PWR';
    faultType = 'power';
  }

  const rawWires = [
    { id: 'W_P1_P2_PWR',    from: 1, to: 2, role: 'power' },
    { id: 'W_P1_P2_SENSE',  from: 1, to: 2, role: 'sensing_gnd' },
    { id: 'W_P1_STR_RET',   from: 1, to: 4, role: 'return_gnd' },
    { id: 'W_P2_P3_PWR',    from: 2, to: 3, role: 'power' },
    { id: 'W_P2_P3_SENSE',  from: 2, to: 3, role: 'sensing_gnd' },
    { id: 'W_P3_STR_PWR',   from: 3, to: 4, role: 'power' },
    { id: 'W_P3_STR_SENSE', from: 3, to: 4, role: 'sensing_wire' }
  ];

  const wires = rawWires.map(w => {
    if (faultNodeId === null) return { ...w, state: 'closed' };

    if (faultNodeId === 2) {
      if (w.id === 'W_P1_P2_PWR') return { ...w, state: 'open' };
      if (w.id === 'W_P1_P2_SENSE' || w.id === 'W_P1_STR_RET') return { ...w, state: 'closed' };
      return { ...w, state: 'gray_zone' };
    }

    if (faultNodeId === 3) {
      if (w.from === 1 && w.to === 2) return { ...w, state: 'closed' };
      if (w.id === 'W_P1_STR_RET') return { ...w, state: 'closed' };
      if (w.id === 'W_P2_P3_PWR') return { ...w, state: 'open' };
      if (w.id === 'W_P2_P3_SENSE') return { ...w, state: 'closed' };
      return { ...w, state: 'gray_zone' };
    }

    if (faultNodeId === 4) {
      if (w.from < 3) return { ...w, state: 'closed' };
      if (w.id === 'W_P1_STR_RET') return { ...w, state: 'closed' };
      if (w.id === 'W_P3_STR_PWR') return { ...w, state: 'open' };
      return { ...w, state: 'gray_zone' };
    }

    return { ...w, state: 'closed' };
  });

  renderIoTMonitor({
    gatewayOnline: true,
    faultNodeId,
    brokenWireId,
    faultType,
    faultDescription,
    isPowerFlowing,
    stringCurrent_mA,
    wires,
    cells,
    serverTime: Date.now(),
    isSimulated: true,
    simulationScenario: scenario
  });

  if (faultDescription) {
    if (lastNotifiedFaultId !== faultNodeId) {
      lastNotifiedFaultId = faultNodeId;
      sendFaultPushNotification(
        '🚨 Solar String Fault Detected!',
        `Break at Node ${faultNodeId}: ${faultDescription}`
      );
    }
  } else if (lastNotifiedFaultId !== null) {
    lastNotifiedFaultId = null;
    sendFaultPushNotification(
      '✅ Solar String Restored',
      'All series continuity connections are intact and continuous.'
    );
  }
}

// ==========================================================================
// User Authentication, Profile & JWT Session Management
// ==========================================================================

const AuthState = {
  token: localStorage.getItem('heliopv_jwt_token') || null,
  user: null,
  isGuarded: false,
  intendedView: 'monitor'
};

function getAuthHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (AuthState.token) {
    headers['Authorization'] = `Bearer ${AuthState.token}`;
  }
  return headers;
}

function setAuthModalTab(tabName) {
  const tabLogin = document.getElementById('tab-auth-login');
  const tabSignup = document.getElementById('tab-auth-signup');
  const formLogin = document.getElementById('form-login');
  const formSignup = document.getElementById('form-signup');

  if (tabName === 'signup') {
    if (tabSignup) tabSignup.className = 'py-2 rounded-lg transition text-white bg-slate-800 shadow';
    if (tabLogin) tabLogin.className = 'py-2 rounded-lg transition text-slate-400 hover:text-slate-200';
    formSignup?.classList.remove('hidden');
    formLogin?.classList.add('hidden');
  } else {
    if (tabLogin) tabLogin.className = 'py-2 rounded-lg transition text-white bg-slate-800 shadow';
    if (tabSignup) tabSignup.className = 'py-2 rounded-lg transition text-slate-400 hover:text-slate-200';
    formLogin?.classList.remove('hidden');
    formSignup?.classList.add('hidden');
  }
  clearAuthError();
  if (window.lucide) lucide.createIcons();
}

function lockAuthWall(mode = 'login', noticeText = null) {
  AuthState.isGuarded = true;
  stopIoTMonitoring();

  const authModal = document.getElementById('modal-auth');
  const btnCloseAuth = document.getElementById('btn-close-auth-modal');
  const guardNotice = document.getElementById('auth-guard-notice');
  const guardNoticeText = document.getElementById('auth-guard-notice-text');
  const monitorView = document.getElementById('view-iot-monitor');
  const estimateView = document.getElementById('view-solar-estimation');

  // Hide protected views from unauthenticated viewers
  monitorView?.classList.add('hidden');
  estimateView?.classList.add('hidden');

  // Display Auth Window as a persistent modal wall
  if (authModal) {
    authModal.classList.remove('hidden');
    authModal.classList.add('flex');
  }
  if (btnCloseAuth) {
    btnCloseAuth.classList.add('hidden'); // Cannot dismiss without authenticating
  }

  if (guardNotice) {
    guardNotice.classList.remove('hidden');
    if (noticeText && guardNoticeText) {
      guardNoticeText.textContent = noticeText;
    }
  }

  setAuthModalTab(mode);
}

function unlockAuthWall() {
  AuthState.isGuarded = false;

  const authModal = document.getElementById('modal-auth');
  const btnCloseAuth = document.getElementById('btn-close-auth-modal');
  const guardNotice = document.getElementById('auth-guard-notice');

  if (authModal) {
    authModal.classList.add('hidden');
    authModal.classList.remove('flex');
  }
  if (btnCloseAuth) {
    btnCloseAuth.classList.remove('hidden');
  }
  if (guardNotice) {
    guardNotice.classList.add('hidden');
  }

  // Display the user's intended view
  const targetView = AuthState.intendedView || 'monitor';
  switchView(targetView);

  // Start live IoT telemetry monitoring
  startIoTMonitoring();
}

async function initAuth() {
  setupAuthEventListeners();

  const urlParams = new URLSearchParams(window.location.search);
  const actionParam = urlParams.get('action');
  const authParam = urlParams.get('auth');
  const viewParam = urlParams.get('view');

  if (viewParam) {
    AuthState.intendedView = viewParam;
  }

  // Handle explicit logout request e.g. /?action=logout
  if (actionParam === 'logout') {
    AuthState.token = null;
    AuthState.user = null;
    localStorage.removeItem('heliopv_jwt_token');
    localStorage.removeItem('heliopv_user_profile');
    updateAuthUI(null);
    lockAuthWall('login', 'You have been signed out. Please sign in to continue.');
    return;
  }

  const requestedAuthMode = authParam === 'signup' ? 'signup' : 'login';

  // 1. Permanent Session & Offline-First Restore
  // If token is stored locally, the user NEVER gets logged out across browser/app restarts
  const storedToken = localStorage.getItem('heliopv_jwt_token');
  const storedUserJson = localStorage.getItem('heliopv_user_profile');
  let cachedUser = null;
  if (storedUserJson) {
    try {
      cachedUser = JSON.parse(storedUserJson);
    } catch (e) {}
  }

  if (storedToken) {
    AuthState.token = storedToken;
    AuthState.user = cachedUser || { name: 'Solar User', email: '' };

    // Instantly unlock the dashboard! No loading spinners, no lock screen!
    updateAuthUI(AuthState.user);
    if (AuthState.user && AuthState.user.savedLocation) {
      applyUserSavedLocation(AuthState.user);
    }
    unlockAuthWall();
    ensurePushSubscription().catch(() => {});

    // In the background, gently sync and refresh profile from server without disturbing user
    fetch(`${getBackendBaseUrl()}/api/auth/me`, {
      headers: getAuthHeaders()
    }).then(async (res) => {
      if (res.ok) {
        const data = await res.json();
        if (data && data.user) {
          AuthState.user = data.user;
          localStorage.setItem('heliopv_user_profile', JSON.stringify(data.user));
          updateAuthUI(data.user);
          if (data.user.savedLocation) {
            applyUserSavedLocation(data.user);
          }
        }
      }
      // If server returns error, 502, 503, or cold-starts: DO NOTHING!
      // The session remains permanently active!
    }).catch(() => {
      // Offline / network disconnect: keep active session intact!
    });

    return;
  }

  // If NO token exists, guard all views and present the Login/Signup screen
  updateAuthUI(null);
  lockAuthWall(requestedAuthMode, 'Authentication Required: Please sign in or create an account to access the dashboard.');
}

// Debounced auto-save of chosen location to user profile in MongoDB Atlas
let locationSaveTimeout = null;
function saveUserLocationPreference(lat, lon, displayLocation) {
  // Cache to localStorage for instant restoration on any page revisit
  try {
    localStorage.setItem('heliopv_saved_location', JSON.stringify({
      lat: Math.round(lat * 10000) / 10000,
      lon: Math.round(lon * 10000) / 10000,
      displayLocation
    }));
  } catch (e) {}

  if (!AuthState.token || !AuthState.user) return; // Only if signed in

  clearTimeout(locationSaveTimeout);
  locationSaveTimeout = setTimeout(async () => {
    try {
      const res = await fetch(`${getBackendBaseUrl()}/api/auth/location`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ lat, lon, displayLocation })
      });
      if (res.ok) {
        const data = await res.json();
        if (AuthState.user && data.savedLocation) {
          AuthState.user.savedLocation = data.savedLocation;
        }
        console.log('[HelioPV] Updated location preference in MongoDB Atlas:', displayLocation);
      }
    } catch (err) {
      console.warn('Failed to auto-save location preference to MongoDB:', err);
    }
  }, 400);
}

// Restore user's saved location & automatically sync satellite weather prediction
function applyUserSavedLocation(user) {
  if (!user || !user.savedLocation) return;
  const { lat, lon, displayLocation } = user.savedLocation;
  if (typeof lat !== 'number' || typeof lon !== 'number' || isNaN(lat) || isNaN(lon)) return;

  // Apply to AppState
  AppState.project.lat = Math.round(lat * 10000) / 10000;
  AppState.project.lon = Math.round(lon * 10000) / 10000;
  if (displayLocation) {
    AppState.project.displayLocation = displayLocation;
  }

  // Cache to localStorage for instant 0ms restoration on future page revisits
  try {
    localStorage.setItem('heliopv_saved_location', JSON.stringify({
      lat: AppState.project.lat,
      lon: AppState.project.lon,
      displayLocation: AppState.project.displayLocation
    }));
    if (user.savedSettings) {
      localStorage.setItem('heliopv_saved_settings', JSON.stringify(user.savedSettings));
    }
  } catch (e) {}

  // Restore saved project settings if present in MongoDB profile
  if (user.savedSettings) {
    const s = user.savedSettings;
    if (s.capacityKwp && !isNaN(s.capacityKwp)) {
      AppState.project.capacityKwp = s.capacityKwp;
      const inpCap = document.getElementById('input-capacity');
      const sldCap = document.getElementById('slider-capacity');
      if (inpCap) inpCap.value = s.capacityKwp;
      if (sldCap) sldCap.value = s.capacityKwp;
    }
    if (s.tilt !== undefined && !isNaN(s.tilt)) {
      AppState.project.tilt = s.tilt;
      const inpTilt = document.getElementById('input-tilt');
      if (inpTilt) inpTilt.value = s.tilt;
    }
    if (s.azimuth !== undefined && !isNaN(s.azimuth)) {
      AppState.project.azimuth = s.azimuth;
      const inpAzimuth = document.getElementById('input-azimuth');
      if (inpAzimuth) inpAzimuth.value = s.azimuth;
    }
    if (s.tariff !== undefined && !isNaN(s.tariff)) {
      AppState.project.tariffPerKwh = s.tariff;
      const inpTariff = document.getElementById('input-tariff');
      if (inpTariff) inpTariff.value = s.tariff;
    }
  }

  // Update input fields in the DOM
  const inputLat = document.getElementById('input-lat');
  const inputLon = document.getElementById('input-lon');
  const inputDisp = document.getElementById('input-display-location');
  const inputSearch = document.getElementById('input-search-location');
  const reportSubtitle = document.getElementById('report-location-subtitle');

  if (inputLat) inputLat.value = AppState.project.lat;
  if (inputLon) inputLon.value = AppState.project.lon;
  if (inputDisp && displayLocation) inputDisp.value = displayLocation;
  if (inputSearch && displayLocation) inputSearch.value = displayLocation;
  if (reportSubtitle && displayLocation) reportSubtitle.textContent = `Project location: ${displayLocation}`;

  const drawerLblLoc = document.getElementById('drawer-lbl-location');
  if (drawerLblLoc && displayLocation) drawerLblLoc.textContent = displayLocation;
  const quickLblLoc = document.getElementById('quick-lbl-site-loc');
  if (quickLblLoc && displayLocation) quickLblLoc.textContent = displayLocation;

  // Pan Leaflet map and marker if initialized
  if (AppState.map) {
    try {
      AppState.map.setView([AppState.project.lat, AppState.project.lon], 17);
      if (AppState.marker) {
        AppState.marker.setLatLng([AppState.project.lat, AppState.project.lon]);
        if (displayLocation) {
          AppState.marker.bindPopup(`<b>${displayLocation}</b><br><span style="font-size:11px;color:#666;">Solar Installation Rooftop</span>`).openPopup();
        }
      }
    } catch (e) {}
  }

  // Pan Google Maps if initialized
  if (AppState.googleMap && AppState.googleMarker) {
    try {
      AppState.googleMap.setCenter({ lat: AppState.project.lat, lng: AppState.project.lon });
      AppState.googleMarker.setPosition({ lat: AppState.project.lat, lng: AppState.project.lon });
    } catch (e) {}
  }

  // Automatically fetch weather API & compute instant solar predictions for their saved location!
  console.log(`[HelioPV] Auto-syncing satellite weather and prediction for saved location: ${displayLocation} (${AppState.project.lat}, ${AppState.project.lon})`);
  fetchWeatherAndUpdate();
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
    authModal?.classList.add('flex');
    clearAuthError();
  });

  btnCloseAuth?.addEventListener('click', () => {
    if (AuthState.isGuarded) return; // Cannot close if unauthenticated
    authModal?.classList.add('hidden');
    authModal?.classList.remove('flex');
  });

  authModal?.addEventListener('click', (e) => {
    if (e.target === authModal) {
      if (AuthState.isGuarded) return; // Cannot close if unauthenticated
      authModal.classList.add('hidden');
      authModal.classList.remove('flex');
    }
  });

  // Modal Tab switching
  const tabLogin = document.getElementById('tab-auth-login');
  const tabSignup = document.getElementById('tab-auth-signup');
  const formLogin = document.getElementById('form-login');
  const formSignup = document.getElementById('form-signup');

  tabLogin?.addEventListener('click', () => setAuthModalTab('login'));
  tabSignup?.addEventListener('click', () => setAuthModalTab('signup'));

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
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const btnSubmit = document.getElementById('btn-submit-login');

    btnSubmit.disabled = true;
    btnSubmit.innerHTML = '<span class="inline-flex items-center gap-2"><svg class="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path></svg> Connecting...</span>';

    // Timer to notify user if Render is waking from sleep (> 3.5s)
    const wakeTimer = setTimeout(() => {
      if (btnSubmit && btnSubmit.disabled) {
        btnSubmit.innerHTML = '<span class="inline-flex items-center gap-2"><svg class="animate-spin h-3.5 w-3.5 text-amber-300" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path></svg> Waking server up... (few sec)</span>';
      }
    }, 3500);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 28000); // 28s timeout

    try {
      const res = await fetch(`${getBackendBaseUrl()}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      clearTimeout(wakeTimer);

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Invalid email or password');

      AuthState.token = data.token;
      AuthState.user = data.user;
      localStorage.setItem('heliopv_jwt_token', data.token);
      localStorage.setItem('heliopv_user_profile', JSON.stringify(data.user));
      updateAuthUI(data.user);
      applyUserSavedLocation(data.user);
      unlockAuthWall();
      ensurePushSubscription().catch(() => {});
    } catch (err) {
      clearTimeout(timeoutId);
      clearTimeout(wakeTimer);
      if (err.name === 'AbortError') {
        showAuthError('Connection timed out. The cloud server may be cold-starting; please tap "Sign In" once more.');
      } else {
        showAuthError(err.message || 'Login failed. Please check your credentials.');
      }
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
    const name = document.getElementById('signup-name').value.trim();
    const email = document.getElementById('signup-email').value.trim();
    const password = document.getElementById('signup-password').value;
    const btnSubmit = document.getElementById('btn-submit-signup');

    btnSubmit.disabled = true;
    btnSubmit.innerHTML = '<span class="inline-flex items-center gap-2"><svg class="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path></svg> Creating Account...</span>';

    const wakeTimer = setTimeout(() => {
      if (btnSubmit && btnSubmit.disabled) {
        btnSubmit.innerHTML = '<span class="inline-flex items-center gap-2"><svg class="animate-spin h-3.5 w-3.5 text-amber-300" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path></svg> Waking server up... (few sec)</span>';
      }
    }, 3500);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 28000);

    try {
      const res = await fetch(`${getBackendBaseUrl()}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          email,
          password,
          profileImage: selectedSignupAvatar,
          location: {
            lat: AppState.project.lat,
            lon: AppState.project.lon,
            displayLocation: AppState.project.displayLocation
          }
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      clearTimeout(wakeTimer);

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Registration failed');

      AuthState.token = data.token;
      AuthState.user = data.user;
      localStorage.setItem('heliopv_jwt_token', data.token);
      localStorage.setItem('heliopv_user_profile', JSON.stringify(data.user));
      updateAuthUI(data.user);
      applyUserSavedLocation(data.user);
      unlockAuthWall();
      ensurePushSubscription().catch(() => {});
    } catch (err) {
      clearTimeout(timeoutId);
      clearTimeout(wakeTimer);
      if (err.name === 'AbortError') {
        showAuthError('Connection timed out. Please check your connection and tap "Create Account" again.');
      } else {
        showAuthError(err.message || 'Registration failed. Please try again.');
      }
    } finally {
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = '<i data-lucide="user-plus" class="w-4 h-4"></i><span>Create Account &amp; Sign In</span>';
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

  document.querySelectorAll('.btn-open-user-drawer, #btn-toggle-user-drawer, #btn-toggle-user-drawer-guest').forEach(btn => {
    btn.addEventListener('click', openDrawer);
  });
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

  // Site Location Settings Modal (Claude-style centered window)
  const modalSiteLoc = document.getElementById('modal-site-location');
  const btnOpenSiteLocDrawer = document.getElementById('drawer-btn-open-site-location');
  const btnCloseSiteLocModal = document.getElementById('btn-close-site-loc-modal');
  const btnDoneSiteLocModal = document.getElementById('btn-done-site-loc-modal');

  function openSiteLocationModal() {
    closeDrawer(); // Smoothly close operator drawer
    modalSiteLoc?.classList.remove('hidden');
    if (window.lucide) lucide.createIcons();
    setTimeout(() => {
      if (AppState.map) AppState.map.invalidateSize();
      if (AppState.googleMap && window.google) google.maps.event.trigger(AppState.googleMap, 'resize');
    }, 150);
  }

  function closeSiteLocationModal() {
    modalSiteLoc?.classList.add('hidden');
  }

  btnOpenSiteLocDrawer?.addEventListener('click', openSiteLocationModal);
  btnCloseSiteLocModal?.addEventListener('click', closeSiteLocationModal);
  btnDoneSiteLocModal?.addEventListener('click', closeSiteLocationModal);

  // Close when clicking modal backdrop
  modalSiteLoc?.addEventListener('click', (e) => {
    if (e.target === modalSiteLoc) {
      closeSiteLocationModal();
    }
  });

  // ESC key closes modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalSiteLoc && !modalSiteLoc.classList.contains('hidden')) {
      closeSiteLocationModal();
    }
  });

  // Hardware Info Settings Modal (Claude-style centered window)
  const modalHwInfoModal = document.getElementById('modal-hardware-info');
  const btnOpenHwInfoDrawer = document.getElementById('drawer-btn-open-hardware-info');
  const btnCloseHwInfoModal = document.getElementById('btn-close-hw-info-modal');
  const btnDoneHwInfoModal = document.getElementById('btn-done-hw-info-modal');

  function openHardwareInfoModal() {
    closeDrawer(); // Smoothly close operator drawer
    modalHwInfoModal?.classList.remove('hidden');
    if (window.lucide) lucide.createIcons();
  }

  function closeHardwareInfoModal() {
    modalHwInfoModal?.classList.add('hidden');
  }

  btnOpenHwInfoDrawer?.addEventListener('click', openHardwareInfoModal);
  btnCloseHwInfoModal?.addEventListener('click', closeHardwareInfoModal);
  btnDoneHwInfoModal?.addEventListener('click', closeHardwareInfoModal);

  // Close when clicking modal backdrop
  modalHwInfoModal?.addEventListener('click', (e) => {
    if (e.target === modalHwInfoModal) {
      closeHardwareInfoModal();
    }
  });

  // ESC key closes hardware info modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalHwInfoModal && !modalHwInfoModal.classList.contains('hidden')) {
      closeHardwareInfoModal();
    }
  });

  // Quick Action Buttons from Solar Estimation View
  document.getElementById('btn-quick-open-site-loc')?.addEventListener('click', () => {
    openSiteLocationModal();
  });

  document.getElementById('btn-quick-open-hw-capex')?.addEventListener('click', () => {
    openHardwareInfoModal();
  });

  // Drawer Push Notification Toggle Button
  document.getElementById('drawer-btn-push-alerts')?.addEventListener('click', () => {
    togglePushNotificationAlerts();
  });

  // Drawer ESP32 Gateway Setup Button
  document.getElementById('drawer-btn-esp32-setup')?.addEventListener('click', () => {
    closeDrawer();
    const modalHwInfo = document.getElementById('modal-hw-info');
    modalHwInfo?.classList.remove('hidden');
    fetchNetworkInfo();
  });

  // Drawer Export Options Accordion Toggle
  const btnToggleExports = document.getElementById('drawer-btn-toggle-exports');
  const exportOptions = document.getElementById('drawer-export-options');
  const iconExportChevron = document.getElementById('drawer-icon-export-chevron');

  btnToggleExports?.addEventListener('click', () => {
    const isHidden = exportOptions?.classList.contains('hidden');
    if (isHidden) {
      exportOptions?.classList.remove('hidden');
      iconExportChevron?.classList.add('rotate-180');
    } else {
      exportOptions?.classList.add('hidden');
      iconExportChevron?.classList.remove('rotate-180');
    }
  });

  // Drawer Export as Excel (.CSV)
  document.getElementById('drawer-btn-export-excel')?.addEventListener('click', () => {
    exportToCSV();
  });

  // Drawer Export as PDF Proposal
  document.getElementById('drawer-btn-export-pdf')?.addEventListener('click', () => {
    closeDrawer();
    setTimeout(() => {
      window.print();
    }, 300);
  });

  // Logout Button
  document.getElementById('btn-logout-user')?.addEventListener('click', () => {
    if (confirm('Are you sure you want to sign out?')) {
      AuthState.token = null;
      AuthState.user = null;
      localStorage.removeItem('heliopv_jwt_token');
      localStorage.removeItem('heliopv_user_profile');
      updateAuthUI(null);
      closeDrawer();
      lockAuthWall('login', 'You have been signed out. Please sign in to continue.');
      try {
        history.replaceState(null, '', '?auth=login');
      } catch (e) {}
    }
  });
}

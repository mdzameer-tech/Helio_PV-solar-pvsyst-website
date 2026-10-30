/**
 * Weather & Geolocation API Service
 * Integrates:
 * 1. Open-Meteo Solar Radiation & Climatology API (Free, high-precision ERA5 satellite solar data)
 * 2. Nominatim OpenStreetMap Geocoding & Reverse Geocoding
 * 3. Native Open Location Code (Google Plus Code) Encoder & Decoder
 * 4. Google Maps Dynamic API loader with Billing-aware error handling & Esri Satellite fallback
 */

const WeatherService = (function () {
  // Open Location Code (Plus Code) Base-20 alphabet
  const OLC_CHARSET = '23456789CFGHJMPQRVWX';

  /**
   * Encode Latitude and Longitude into a Google Plus Code (Open Location Code)
   */
  function encodePlusCode(lat, lon, codeLength = 10) {
    let latVal = Math.min(90.0, Math.max(-90.0, lat)) + 90.0;
    let lonVal = lon + 180.0;
    while (lonVal >= 360.0) lonVal -= 360.0;
    while (lonVal < 0.0) lonVal += 360.0;

    let code = '';
    let latRes = 20.0;
    let lonRes = 20.0;

    for (let i = 0; i < 5; i++) {
      const latDigit = Math.floor(latVal / latRes);
      const lonDigit = Math.floor(lonVal / lonRes);
      latVal -= latDigit * latRes;
      lonVal -= lonDigit * lonRes;
      latRes /= 20.0;
      lonRes /= 20.0;

      code += OLC_CHARSET[latDigit] + OLC_CHARSET[lonDigit];
      if (i === 3) code += '+';
    }

    return code.substring(0, codeLength + 1);
  }

  /**
   * Decode an Open Location Code to lat/lon bounding box
   */
  function decodePlusCode(code) {
    const clean = code.replace('+', '').toUpperCase();
    if (clean.length < 8) return null;

    let lat = -90.0;
    let lon = -180.0;
    let latRes = 20.0;
    let lonRes = 20.0;

    for (let i = 0; i < clean.length; i += 2) {
      const latIdx = OLC_CHARSET.indexOf(clean[i]);
      const lonIdx = OLC_CHARSET.indexOf(clean[i + 1]);
      if (latIdx === -1 || lonIdx === -1) return null;

      lat += latIdx * latRes;
      lon += lonIdx * lonRes;
      latRes /= 20.0;
      lonRes /= 20.0;
    }

    // Center of bounding box
    return {
      lat: Math.round((lat + latRes * 10) * 10000) / 10000,
      lon: Math.round((lon + lonRes * 10) * 10000) / 10000
    };
  }

  /**
   * Fetch solar climatology and temperature data for a specific location
   * Uses Open-Meteo Historical Archive API (ERA5-Land reanalysis / Satellite)
   */
  async function fetchSolarData(lat, lon, year = 2023) {
    try {
      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${year}-01-01&end_date=${year}-12-31&daily=shortwave_radiation_sum,temperature_2m_mean&timezone=auto`;
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Open-Meteo API status ${response.status}`);
      }

      const data = await response.json();
      if (!data.daily || !data.daily.time || !data.daily.shortwave_radiation_sum) {
        throw new Error('Invalid weather data structure');
      }

      const monthlySums = Array(12).fill(0);
      const monthlyTempSums = Array(12).fill(0);
      const monthlyDays = Array(12).fill(0);

      const times = data.daily.time;
      const radSums = data.daily.shortwave_radiation_sum;
      const temps = data.daily.temperature_2m_mean;

      for (let i = 0; i < times.length; i++) {
        const month = parseInt(times[i].substring(5, 7), 10) - 1;
        const radMj = radSums[i] !== null ? radSums[i] : 20.0;
        const temp = temps && temps[i] !== null ? temps[i] : 25.0;

        const radKwh = radMj * 0.277778; // 1 MJ = 0.27778 kWh

        monthlySums[month] += radKwh;
        monthlyTempSums[month] += temp;
        monthlyDays[month] += 1;
      }

      const monthlyData = [];
      for (let m = 0; m < 12; m++) {
        const days = monthlyDays[m] || 30;
        const totalGhi = Math.round(monthlySums[m]);
        const avgTemp = Math.round((monthlyTempSums[m] / days) * 10) / 10;
        const dailyAvgGhi = Math.round((totalGhi / days) * 100) / 100;

        monthlyData.push({
          monthIndex: m,
          ghiKwh: totalGhi,
          dailyAvgGhi: dailyAvgGhi,
          temp: avgTemp,
          days: days
        });
      }

      return {
        success: true,
        source: 'Open-Meteo Satellite ERA5',
        year: year,
        monthlyData: monthlyData
      };
    } catch (err) {
      console.warn('Weather API fetch failed, falling back to universal physics model:', err);
      return {
        success: false,
        error: err.message
      };
    }
  }

  /**
   * Geocode a search query (Address, Landmark, Coordinates, or Plus Code)
   */
  async function searchLocation(query, googleApiKey = null) {
    if (!query || query.trim().length === 0) return null;
    const cleanQuery = query.trim();

    // Check if query is raw coordinates like "12.834, 77.589"
    const coordMatch = cleanQuery.match(/^([-+]?\d{1,2}(?:\.\d+)?)[,\s]+([-+]?\d{1,3}(?:\.\d+)?)$/);
    if (coordMatch) {
      const lat = parseFloat(coordMatch[1]);
      const lon = parseFloat(coordMatch[2]);
      if (!isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
        const rev = await reverseGeocode(lat, lon, googleApiKey);
        return rev || {
          lat: lat,
          lon: lon,
          displayName: `Custom Site (${lat.toFixed(4)}°N, ${lon.toFixed(4)}°E)`,
          plusCode: encodePlusCode(lat, lon)
        };
      }
    }

    // Check if query is a pure global Plus Code (e.g. 7J4V9W34+8Q)
    const purePlusMatch = cleanQuery.match(/^([23456789CFGHJMPQRVWX]{8}\+[23456789CFGHJMPQRVWX]{2,3})$/i);
    if (purePlusMatch) {
      const decoded = decodePlusCode(purePlusMatch[1]);
      if (decoded) {
        const rev = await reverseGeocode(decoded.lat, decoded.lon, googleApiKey);
        return rev || {
          lat: decoded.lat,
          lon: decoded.lon,
          displayName: `${purePlusMatch[1]}, Custom Site`,
          plusCode: purePlusMatch[1]
        };
      }
    }

    // Try Google Maps Geocoder if key exists and Google is ready
    if (googleApiKey && window.google && window.google.maps && window.google.maps.Geocoder) {
      try {
        const geocoder = new google.maps.Geocoder();
        const res = await new Promise((resolve, reject) => {
          geocoder.geocode({ address: cleanQuery }, (results, status) => {
            if (status === 'OK' && results && results[0]) {
              resolve(results[0]);
            } else {
              reject(new Error(`Google Geocoder status: ${status}`));
            }
          });
        });

        if (res && res.geometry && res.geometry.location) {
          const lat = res.geometry.location.lat();
          const lon = res.geometry.location.lng();
          const plusCode = encodePlusCode(lat, lon).substring(0, 9);
          return {
            lat: lat,
            lon: lon,
            displayName: `${plusCode}, ${res.formatted_address}`,
            plusCode: plusCode,
            source: 'Google Geocoding API'
          };
        }
      } catch (gErr) {
        console.warn('Google Geocoding failed, trying Open-Meteo & Nominatim:', gErr.message);
      }
    }

    // Parse compound plus code like "RHM7+RH8, Bilwaradahalli, Karnataka"
    let parsedQuery = cleanQuery;
    let extractedPlusCode = null;
    const compoundPlusMatch = cleanQuery.match(/^([23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3})(?:,\s*(.+))?$/i);
    if (compoundPlusMatch) {
      extractedPlusCode = compoundPlusMatch[1].toUpperCase();
      parsedQuery = compoundPlusMatch[2] ? compoundPlusMatch[2].trim() : parsedQuery;
    }

    // Try Open-Meteo Geocoding API
    try {
      const omUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(parsedQuery)}&count=5&language=en&format=json`;
      const omRes = await fetch(omUrl);
      if (omRes.ok) {
        const data = await omRes.json();
        if (data.results && data.results.length > 0) {
          const item = data.results[0];
          const nameParts = [item.name, item.admin2, item.admin1, item.country].filter(Boolean);
          const computedPlus = extractedPlusCode || encodePlusCode(item.latitude, item.longitude).substring(0, 9);
          return {
            lat: item.latitude,
            lon: item.longitude,
            displayName: `${computedPlus}, ${nameParts.join(', ')}`,
            plusCode: computedPlus,
            elevation: item.elevation,
            source: 'Open-Meteo Geocoding'
          };
        }
      }
    } catch (e) {
      console.warn('Open-Meteo Geocoding error:', e);
    }

    // Fallback: OpenStreetMap Nominatim
    try {
      const nomUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(parsedQuery)}&format=json&limit=1`;
      const nomRes = await fetch(nomUrl, {
        headers: { 'Accept': 'application/json' }
      });
      if (nomRes.ok) {
        const results = await nomRes.json();
        if (results && results.length > 0) {
          const lat = parseFloat(results[0].lat);
          const lon = parseFloat(results[0].lon);
          const computedPlus = extractedPlusCode || encodePlusCode(lat, lon).substring(0, 9);
          return {
            lat: lat,
            lon: lon,
            displayName: `${computedPlus}, ${results[0].display_name}`,
            plusCode: computedPlus,
            source: 'OpenStreetMap Nominatim'
          };
        }
      }
    } catch (e) {
      console.warn('Nominatim error:', e);
    }

    // Default Bilwaradahalli fallback if related query
    if (cleanQuery.toLowerCase().includes('bilwaradahalli') || cleanQuery.toLowerCase().includes('rhm7+rh8')) {
      return {
        lat: 12.8342,
        lon: 77.5891,
        displayName: 'RHM7+RH8, Bilwaradahalli, Karnataka (Bengaluru region)',
        plusCode: 'RHM7+RH8',
        source: 'Calibrated Project Baseline'
      };
    }

    return null;
  }

  /**
   * Reverse Geocode (Lat, Lon -> Human Readable Address + Plus Code)
   */
  async function reverseGeocode(lat, lon, googleApiKey = null) {
    const computedPlus = encodePlusCode(lat, lon).substring(0, 9);

    // Try Google Reverse Geocoding if available
    if (googleApiKey && window.google && window.google.maps && window.google.maps.Geocoder) {
      try {
        const geocoder = new google.maps.Geocoder();
        const res = await new Promise((resolve, reject) => {
          geocoder.geocode({ location: { lat: lat, lng: lon } }, (results, status) => {
            if (status === 'OK' && results && results[0]) {
              resolve(results[0]);
            } else {
              reject(new Error(`Google reverse geocode failed: ${status}`));
            }
          });
        });

        if (res && res.formatted_address) {
          return {
            lat: lat,
            lon: lon,
            displayName: `${computedPlus}, ${res.formatted_address}`,
            plusCode: computedPlus,
            source: 'Google Reverse Geocode'
          };
        }
      } catch (err) {
        // Fall through to Nominatim
      }
    }

    // Fallback: OpenStreetMap Nominatim reverse
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`;
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (res.ok) {
        const data = await res.json();
        if (data && data.display_name) {
          return {
            lat: lat,
            lon: lon,
            displayName: `${computedPlus}, ${data.display_name}`,
            plusCode: computedPlus,
            source: 'Nominatim Reverse Geocode'
          };
        }
      }
    } catch (err) {
      console.warn('Reverse geocode fetch failed:', err);
    }

    return {
      lat: lat,
      lon: lon,
      displayName: `${computedPlus}, Site (${lat.toFixed(4)}°N, ${lon.toFixed(4)}°E)`,
      plusCode: computedPlus
    };
  }

  /**
   * Dynamically loads Google Maps JavaScript API with satellite view
   * Handles billing errors and auth failure gracefully
   */
  function loadGoogleMapsApi(apiKey) {
    return new Promise((resolve, reject) => {
      if (window.google && window.google.maps) {
        resolve(window.google.maps);
        return;
      }
      if (!apiKey || apiKey.trim() === '') {
        reject(new Error('No Google Maps API Key provided'));
        return;
      }

      // Handle Google Maps authentication error safely
      window.gm_authFailure = function () {
        console.warn('Google Maps authentication failed (billing or referrer restriction).');
        if (window.onGoogleMapsAuthFailed) {
          window.onGoogleMapsAuthFailed();
        }
      };

      const scriptId = 'google-maps-script';
      const existingScript = document.getElementById(scriptId);
      if (existingScript) existingScript.remove();

      const script = document.createElement('script');
      script.id = scriptId;
      script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey.trim()}&libraries=places,geometry`;
      script.async = true;
      script.defer = true;
      script.onload = () => resolve(window.google.maps);
      script.onerror = (e) => reject(new Error('Failed to load Google Maps script.'));
      document.head.appendChild(script);
    });
  }

  return {
    encodePlusCode: encodePlusCode,
    decodePlusCode: decodePlusCode,
    fetchSolarData: fetchSolarData,
    searchLocation: searchLocation,
    reverseGeocode: reverseGeocode,
    loadGoogleMapsApi: loadGoogleMapsApi
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = WeatherService;
}

import os, json, math, time
from types import SimpleNamespace
import numpy as np, pandas as pd, requests, joblib, lightgbm as lgb
from scipy import stats
from pvlib.location import Location
from pvlib import irradiance, temperature, pvsystem

HERE = os.path.dirname(os.path.abspath(__file__))
B = os.environ.get("BUNDLE_DIR", os.path.join(HERE, "bundle"))
CFG = json.load(open(os.path.join(B, "config.json")))
LOC, HF, DC, PV = CFG["location"], CFG["hourly"], CFG["daily"], CFG["pv_reference_system"]
TZ = "Asia/Kolkata"
VARS = ["shortwave_radiation", "direct_radiation", "diffuse_radiation", "direct_normal_irradiance", "cloud_cover",
        "temperature_2m", "relative_humidity_2m", "wind_speed_10m", "precipitation"]
FILL = {"shortwave_radiation": 0, "direct_radiation": 0, "diffuse_radiation": 0, "direct_normal_irradiance": 0,
        "cloud_cover": 0, "temperature_2m": 25.0, "relative_humidity_2m": 60.0, "wind_speed_10m": 3.0, "precipitation": 0}
TP = temperature.TEMPERATURE_MODEL_PARAMETERS["sapm"]["open_rack_glass_glass"]
TILT, AZ, PDC0, GAM, LOSS, ALB = PV["tilt"], PV["azimuth"], PV["pdc0_w"], PV["gamma"], PV["losses"], PV["albedo"]
FORECAST = "https://api.open-meteo.com/v1/forecast"; ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"

MH = joblib.load(os.path.join(B, HF["model"])); Q10 = lgb.Booster(model_file=os.path.join(B, HF["q10"]))
Q90 = lgb.Booster(model_file=os.path.join(B, HF["q90"])); QOFF = HF["conformal_offset_w"]
MA = {L: joblib.load(os.path.join(B, DC["A_models"][str(L)])) for L in DC["leads"]}
MB = {L: joblib.load(os.path.join(B, DC["B_models"][str(L)])) for L in DC["leads"]}
for m in [MH, *MA.values(), *MB.values()]:
    m.set_params(n_jobs=1)

def _km(a, b, c, d):
    p = math.pi / 180; x = math.sin((c - a) * p / 2) ** 2 + math.cos(a * p) * math.cos(c * p) * math.sin((d - b) * p / 2) ** 2
    return 12742 * math.asin(math.sqrt(x))

def _get(url, params, tries=3):
    for k in range(tries):
        r = requests.get(url, params=params, timeout=30)
        if r.status_code == 200: return r.json()
        time.sleep(1.5 * (k + 1))
    raise RuntimeError(f"Open-Meteo HTTP {r.status_code}: {r.text[:100]}")

def _sun(idx, r):
    mid = idx.tz_localize(TZ) - pd.Timedelta(minutes=30)
    site = Location(r.latitude, r.longitude, tz=TZ, altitude=r.elevation)
    sp = site.get_solarposition(mid)
    try: cs = site.get_clearsky(mid, model="ineichen")
    except Exception: cs = site.get_clearsky(mid, model="ineichen", linke_turbidity=3.5)
    return mid, sp, cs, irradiance.get_extra_radiation(mid)

def _poa(sp, dni, ghi, dhi, ex):
    return irradiance.get_total_irradiance(TILT, AZ, sp["apparent_zenith"], sp["azimuth"], dni, ghi, dhi,
        dni_extra=ex, albedo=ALB, model="haydavies")["poa_global"].clip(lower=0).fillna(0)

def _power(poa, tair, wind_ms):
    tc = temperature.sapm_cell(poa, tair, wind_ms, **TP)
    return np.clip(np.asarray(pvsystem.pvwatts_dc(poa, tc, PDC0, GAM) * (1 - LOSS)), 0, None)

def clear_power(idx, r):
    mid, sp, cs, ex = _sun(idx, r)
    return pd.Series(_power(_poa(sp, cs["dni"], cs["ghi"], cs["dhi"], ex), PV["clear_sky_air_temp_c"], PV["clear_sky_wind_ms"]), index=idx)

def physics(idx, r, ghi, tair, wind_kmh):
    mid, sp, cs, ex = _sun(idx, r)
    g = pd.Series(np.asarray(ghi, float), index=mid); er = irradiance.erbs(g, sp["zenith"], mid)
    poa = _poa(sp, er["dni"].fillna(0), g, er["dhi"].fillna(0), ex)
    return _power(poa, pd.Series(np.asarray(tair, float), index=mid), pd.Series(np.asarray(wind_kmh, float) / 3.6, index=mid))

def process(df, r):
    mid, sp, cs, ex = _sun(df.index, r)
    S = lambda c: pd.Series(df[c].values, index=mid)
    poa = _poa(sp, S("direct_normal_irradiance"), S("shortwave_radiation"), S("diffuse_radiation"), ex)
    out = df.copy(); out["solar_elevation"] = sp["apparent_elevation"].values; out["clearsky_ghi"] = cs["ghi"].values
    out["csi"] = (S("shortwave_radiation") / cs["ghi"]).where(sp["apparent_elevation"] > 0, 0).clip(0, 1.2).fillna(0).values
    out["power_w"] = _power(poa, S("temperature_2m"), S("wind_speed_10m") / 3.6)
    return out

def build_features(d, r):
    d = d.copy(); d["csi_f"] = d["csi"].fillna(0.0); pcf = clear_power(d.index, r)
    nxt = d.shift(-1); tgt = d.index + pd.Timedelta(hours=1); f = {}
    for k in range(6):
        f[f"csi_lag{k}"] = d["csi_f"].shift(k); f[f"cloud_lag{k}"] = d["cloud_cover"].shift(k)
        f[f"temp_lag{k}"] = d["temperature_2m"].shift(k); f[f"power_lag{k}"] = d["power_w"].shift(k)
    f["csi_same_hour_yday"] = d["csi_f"].shift(23); f["power_same_hour_yday"] = d["power_w"].shift(23)
    f["csi_roll24"] = d["csi_f"].rolling(24).mean()
    f["solar_elev_next"] = nxt["solar_elevation"]; f["clearsky_ghi_next"] = nxt["clearsky_ghi"]; f["power_clear_next"] = pcf.shift(-1)
    for nm, v, per in (("hour", tgt.hour, 24), ("doy", tgt.dayofyear, 365.25)):
        f[nm + "_sin"] = pd.Series(np.sin(2 * np.pi * v / per), index=d.index); f[nm + "_cos"] = pd.Series(np.cos(2 * np.pi * v / per), index=d.index)
    f["latitude"], f["longitude"], f["elevation"] = r.latitude, r.longitude, r.elevation
    out = pd.DataFrame(f, index=d.index).dropna()
    return out[out.solar_elev_next > 0]

_MA_CACHE = {}
def _month_actual(lat, lon, elev, year, month):
    key = (lat, lon, year, month)
    if key in _MA_CACHE: return _MA_CACHE[key]
    try:
        end = (pd.Timestamp(year, month, 1) + pd.offsets.MonthEnd(0)).strftime("%Y-%m-%d")
        js = _get(ARCHIVE, {"latitude": lat, "longitude": lon, "start_date": f"{year}-{month:02d}-01", "end_date": end,
                            "hourly": ",".join(VARS), "timezone": TZ})
        df = pd.DataFrame(js["hourly"]); df["time"] = pd.to_datetime(df["time"]); df = df.set_index("time")[VARS]
        if df.isna().any().any(): return None
        v = float(process(df, SimpleNamespace(latitude=lat, longitude=lon, elevation=elev)).power_w.sum() / 1000)
        _MA_CACHE[key] = v; return v
    except Exception:
        return None

def _monthly(lat, lon, elev, kw, today):
    clim = CFG["monthly"]["climatology"]; rows, total = [], 0.0
    for m in range(1, 13):
        c = clim[str(m)]; n = c["n_years"]; half = stats.t.ppf(0.9, n - 1) * c["std"] * math.sqrt(1 + 1 / n)
        row = {"month": m, "expected_kwh": c["mean"] * kw, "p10_kwh": max(c["mean"] - half, 0) * kw, "p90_kwh": (c["mean"] + half) * kw}
        a = _month_actual(round(lat, 2), round(lon, 2), round(elev), today.year, m) if m < today.month else None
        if a is not None: row["actual_kwh"] = a * kw
        total += (a if a is not None else c["mean"]) * kw; rows.append(row)
    return {"year": today.year, "months": rows, "expected_year_total_kwh": total}

def predict(lat, lon, kw=1.0, now=None, monthly=True):
    dist = _km(lat, lon, LOC["centre_lat"], LOC["centre_lon"])
    if dist > LOC["max_distance_km"]:
        raise ValueError(f"Location is {dist:.0f} km from Bengaluru centre; supported radius is {LOC['max_distance_km']} km.")
    js = _get(FORECAST, {"latitude": lat, "longitude": lon, "hourly": ",".join(VARS), "past_days": 14, "forecast_days": 8, "timezone": TZ})
    elev = float(js.get("elevation", 900.0)); r = SimpleNamespace(latitude=lat, longitude=lon, elevation=elev)
    df = pd.DataFrame(js["hourly"]); df["time"] = pd.to_datetime(df["time"]); df = df.set_index("time")[VARS]
    now = pd.Timestamp(now) if now is not None else pd.Timestamp.now(tz=TZ).tz_localize(None)
    last = now.floor("h"); today = last.normalize(); h1 = pd.Timedelta(hours=1)
    df = df.interpolate(limit=3, limit_area="inside")
    if df.loc[today - pd.Timedelta(days=13):last].isna().any().any(): raise RuntimeError("Recent observation history incomplete")
    df = df.fillna(FILL)
    p = process(df, r); ph = pd.Series(physics(df.index, r, df.shortwave_radiation, df.temperature_2m, df.wind_speed_10m), index=df.index)
    pw = p.power_w.copy(); fut = pw.index > last; pw[fut] = ph[fut]          # observed-based up to now, forecast physics after

    fe = build_features(p.loc[:last + h1], r); nh = {"for_hour_ending": str(last + h1)}
    if last in fe.index:
        x = fe.loc[[last], HF["features"]]; pt = max(float(MH.predict(x)[0]), 0)
        a, b = float(Q10.predict(x)[0]), float(Q90.predict(x)[0])
        nh.update(p10_w=max(min(a, b) - QOFF, 0) * kw, p50_w=pt * kw, p90_w=(max(a, b) + QOFF) * kw)
    else:
        nh.update(p10_w=0.0, p50_w=0.0, p90_w=0.0, note="next hour is after sunset or before sunrise")

    e = pw.resample("D").sum() / 1000; cl = clear_power(df.index, r).resample("D").sum() / 1000
    roll7 = float(e.loc[today - pd.Timedelta(days=6):today].mean()); daily = []
    for L in DC["leads"]:
        D = today + pd.Timedelta(days=L); dd = df.loc[D:D + pd.Timedelta(hours=23)]
        if len(dd) < 24: continue
        row = {"clear_energy_kwh": float(cl[D]), "energy_yday": float(e[today]), "energy_roll7": roll7,
               "doy_sin": math.sin(2 * math.pi * D.dayofyear / 365.25), "doy_cos": math.cos(2 * math.pi * D.dayofyear / 365.25),
               "latitude": lat, "longitude": lon, "elevation": elev, "cloud_mean": dd.cloud_cover.mean(), "temp_max": dd.temperature_2m.max(),
               "temp_min": dd.temperature_2m.min(), "humidity_mean": dd.relative_humidity_2m.mean(), "wind_mean": dd.wind_speed_10m.mean(),
               "precip_sum": dd.precipitation.sum()}
        x = pd.DataFrame([row]); pa = max(float(MA[L].predict(x[DC["A_features"]])[0]), 0)
        pb = max(float(MB[L].predict(x[DC["B_features"]])[0]), 0); pp = float(e[D]); ens = (pa + pb + pp) / 3; o = DC["interval_offsets"][str(L)]
        daily.append({"date": str(D.date()), "lead_days": L, "p10_kwh": max(ens + o["lo"], 0) * kw, "p50_kwh": ens * kw,
                      "p90_kwh": (ens + o["hi"]) * kw, "members_kwh": {"lags_model": pa * kw, "forecast_model": pb * kw, "physics": pp * kw}})
    nxt24 = [{"hour_ending": str(t), "p50_w": float(ph[t]) * kw} for t in ph.loc[last + h1:last + 24 * h1].index]
    return {"generated_at_ist": str(now), "location": {"lat": lat, "lon": lon, "elevation_m": elev, "km_from_centre": round(dist, 1)},
            "system_kw": kw, "next_hour": nh, "next_24h_physics": nxt24, "daily": daily, "monthly": (_monthly(lat, lon, elev, kw, today) if monthly else None),
            "notes": ["Simulated 1 kW reference system (tilt 13 deg, south-facing, 14% losses) scaled by kW; real systems differ.",
                      "Hourly/daily bands were calibrated on held-out years; monthly bands under-cover by about 7 points in recent years.",
                      "Today's energy in the daily features is observed-so-far plus forecast for the rest of today."]}

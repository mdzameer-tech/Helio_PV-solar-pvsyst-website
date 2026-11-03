import os, time
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
import solar_core as sc

app = FastAPI(title="Solar forecast API (Bengaluru)")
app.add_middleware(CORSMiddleware, allow_origins=os.environ.get("ALLOW_ORIGINS", "*").split(","), allow_methods=["GET"], allow_headers=["*"])
_cache = {}

@app.get("/health")
def health(): return {"ok": True, "trained_through": sc.CFG["trained_through"]}

@app.get("/predict")
def predict(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180), kw: float = Query(1.0, gt=0, le=1000), monthly: bool = Query(True)):
    key = (round(lat, 2), round(lon, 2), round(kw, 2), int(time.time() // 600), monthly)
    if key in _cache: return _cache[key]
    try: res = sc.predict(lat, lon, kw, monthly=monthly)
    except ValueError as e: raise HTTPException(422, str(e))
    except Exception as e: raise HTTPException(502, str(e))
    if len(_cache) > 500: _cache.clear()
    _cache[key] = res; return res

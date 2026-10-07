"""Diagnostic: compare Databento continuous-contract roll rules for GC. Output goes to docs/diag.log."""
import os, time
import pandas as pd
import databento as db
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
client = db.Historical(os.environ["DATABENTO_API_KEY"])

def sessions(symbol):
    d = client.timeseries.get_range(dataset="GLBX.MDP3", symbols=[symbol], stype_in="continuous",
                                    schema="ohlcv-1h", start="2026-09-14", end="2026-10-07T06:00").to_df().reset_index()
    ts = pd.to_datetime(d["ts_event"], utc=True)
    d["trade_date"] = (ts.dt.tz_convert(NY) + pd.Timedelta(hours=6)).dt.normalize().dt.tz_localize(None)
    g = d.groupby("trade_date")
    out = pd.DataFrame({"open": g["open"].first(), "high": g["high"].max(), "low": g["low"].min(),
                        "close": g["close"].last(), "vol": g["volume"].sum(), "bars": g.size(),
                        "raw": g["symbol"].last()})
    return out

for roll in ["c", "v", "n"]:
    for sym in [f"GC.{roll}.0", f"GC.{roll}.1"]:
        try:
            t0 = time.time(); s = sessions(sym)
            print(f"\n=== {sym} ({time.time()-t0:.0f}s) ===")
            print(s.to_string())
        except Exception as e:
            print(f"\n=== {sym}: FAILED {e}")

# which raw contracts are these?
defs = client.timeseries.get_range(dataset="GLBX.MDP3", symbols=["GC.c.0", "GC.v.0", "GC.n.0"], stype_in="continuous",
                                   schema="definition", start="2026-10-05", end="2026-10-07").to_df().reset_index()
cols = [c for c in ["symbol", "raw_symbol", "expiration", "instrument_id"] if c in defs.columns]
print("\n=== definitions ===")
print(defs[cols].drop_duplicates().to_string())

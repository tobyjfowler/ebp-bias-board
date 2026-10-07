"""Diagnostic: time a few Databento requests and show their shape. Output goes to docs/diag.log."""
import os, sys, time
import pandas as pd
import databento as db

client = db.Historical(os.environ["DATABENTO_API_KEY"])
rng = client.metadata.get_dataset_range("GLBX.MDP3")
print("range:", rng)

def timed(label, **kw):
    t0 = time.time()
    try:
        d = client.timeseries.get_range(dataset="GLBX.MDP3", **kw).to_df().reset_index()
        print(f"{label}: {len(d)} rows in {time.time()-t0:.1f}s; cols={list(d.columns)}")
        return d
    except Exception as e:
        print(f"{label}: FAILED after {time.time()-t0:.1f}s: {e}")
        return pd.DataFrame()

d = timed("stats NQ.c.0 7d", symbols=["NQ.c.0"], stype_in="continuous", schema="statistics", start="2026-09-28", end="2026-10-07")
if not d.empty:
    print(d[["ts_event", "ts_ref", "stat_type", "price", "symbol"]].head(40).to_string())
    print("stat_type counts:", d["stat_type"].value_counts().to_dict())
d2 = timed("stats NQZ6 raw 7d", symbols=["NQZ6"], stype_in="raw_symbol", schema="statistics", start="2026-09-28", end="2026-10-07")
if not d2.empty:
    s = d2[d2.stat_type == 3]
    print(s[["ts_event", "ts_ref", "price"]].to_string())
d3 = timed("stats NQ.c.0 1y", symbols=["NQ.c.0"], stype_in="continuous", schema="statistics", start="2025-01-01", end="2026-01-01")
d4 = timed("ohlcv-1d NQ.c.0 7d", symbols=["NQ.c.0"], stype_in="continuous", schema="ohlcv-1d", start="2026-09-28", end="2026-10-07")
if not d4.empty:
    print(d4[["ts_event", "open", "high", "low", "close"]].to_string())
d5 = timed("ohlcv-1h NQ.c.0 last 3d", symbols=["NQ.c.0"], stype_in="continuous", schema="ohlcv-1h", start="2026-10-05", end="2026-10-07T06:00")
if not d5.empty:
    print(d5[["ts_event", "open", "high", "low", "close", "volume"]].tail(12).to_string())

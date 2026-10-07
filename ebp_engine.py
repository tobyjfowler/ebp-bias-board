#!/usr/bin/env python3
"""
EBP bias engine.

For each asset and each higher timeframe (Daily, 3-Day, Weekly, Monthly):
  - take the last CLOSED candle on that timeframe
  - bullish EBP  = it swept the prior candle's low  and closed above the prior candle's open
  - bearish EBP  = it swept the prior candle's high and closed below the prior candle's open
  - otherwise neutral
  - invalidation = the sweep extreme (EBP low for bullish, EBP high for bearish)
  - intact       = price has not traded through the invalidation since the EBP candle closed

Candles are built from daily bars the way TradingView builds them for CME futures:
  - Daily   : the 18:00-17:00 New York session, labelled by the date it ends
  - Weekly  : Monday to Friday
  - Monthly : calendar month
  - 3-Day   : groups of three trading days counted from the first trading day of each year
              (TradingView restarts multi-day bars at the start of every year)

Usage:
  python ebp_engine.py                      # fetch from Yahoo Finance, write docs/data.json
  python ebp_engine.py --csv-dir ./csv      # use TradingView CSV exports instead (NQ.csv, ES.csv ...)
  python ebp_engine.py --out path.json
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd

NY = ZoneInfo("America/New_York")
SESSION_CLOSE_HOUR = 17  # 17:00 New York, CME equity index / metals / energy daily close for charting

ASSETS = [
    # key, display name, Yahoo symbol, TradingView symbol, decimals
    ("NQ",  "Nasdaq 100",   "NQ=F",  "CME_MINI:NQ1!",  2),
    ("ES",  "S&P 500",      "ES=F",  "CME_MINI:ES1!",  2),
    ("YM",  "Dow Jones",    "YM=F",  "CBOT_MINI:YM1!", 0),
    ("RTY", "Russell 2000", "RTY=F", "CME_MINI:RTY1!", 1),
    ("GC",  "Gold",         "GC=F",  "COMEX:GC1!",     1),
    ("CL",  "Crude Oil",    "CL=F",  "NYMEX:CL1!",     2),
]

# Databento continuous-contract roll rule per asset: c = calendar (nearest expiry), n = open interest,
# v = volume. Equity indices and crude track the nearest expiry like TradingView's 1! symbols;
# gold's nearest expiry is a thin off-cycle month, so TradingView's GC1! follows the open-interest leader.
ROLL_RULE = {"GC": "n"}
DEFAULT_ROLL = "c"


def cont_symbol(key: str) -> str:
    return f"{key}.{ROLL_RULE.get(key, DEFAULT_ROLL)}.0"


TIMEFRAMES = ["D", "3D", "W", "M"]
TF_LABELS = {"D": "Daily", "3D": "3-Day", "W": "Weekly", "M": "Monthly"}


# ─────────────────────────────────────────────────────────────
# Data loading
# ─────────────────────────────────────────────────────────────
def load_yahoo(symbol: str, years: int = 3) -> pd.DataFrame:
    import yfinance as yf

    df = yf.download(symbol, period=f"{years}y", interval="1d", progress=False, auto_adjust=False)
    if df is None or df.empty:
        raise RuntimeError(f"No data returned for {symbol}")
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    df = df.rename(columns=str.lower)[["open", "high", "low", "close"]].copy()
    df.index = pd.to_datetime(df.index).tz_localize(None).normalize()
    df.index.name = "date"
    return df.dropna()


def cme_holidays(years: range) -> set[pd.Timestamp]:
    """
    US exchange holidays on which a shortened Globex session trades but CME assigns the
    activity to the NEXT trade date (so TradingView shows no bar for the holiday itself).
    Good Friday is deliberately excluded: when the exchange opens for it, it is its own trade date.
    """
    from pandas.tseries.holiday import (
        AbstractHolidayCalendar, Holiday, USMartinLutherKingJr, USPresidentsDay,
        USMemorialDay, USLaborDay, USThanksgivingDay, nearest_workday,
    )

    class _Cal(AbstractHolidayCalendar):
        rules = [
            Holiday("NewYear", month=1, day=1, observance=nearest_workday),
            USMartinLutherKingJr, USPresidentsDay, USMemorialDay,
            Holiday("Juneteenth", month=6, day=19, observance=nearest_workday),
            Holiday("Independence", month=7, day=4, observance=nearest_workday),
            USLaborDay, USThanksgivingDay,
            Holiday("Christmas", month=12, day=25, observance=nearest_workday),
        ]

    cal = _Cal()
    out: set[pd.Timestamp] = set()
    for y in years:
        out.update(pd.Timestamp(d) for d in cal.holidays(pd.Timestamp(y, 1, 1), pd.Timestamp(y, 12, 31)))
    return out


def merge_holiday_sessions(daily: pd.DataFrame) -> pd.DataFrame:
    """Fold any holiday-dated session into the next trading day's bar (CME trade-date convention)."""
    if daily.empty:
        return daily
    hols = cme_holidays(range(daily.index.min().year, daily.index.max().year + 1))
    daily = daily.sort_index().copy()
    dates = list(daily.index)
    for i, d in enumerate(dates):
        if d in hols and i + 1 < len(dates):
            nxt = dates[i + 1]
            daily.loc[nxt, "open"] = daily.loc[d, "open"]
            daily.loc[nxt, "high"] = max(daily.loc[d, "high"], daily.loc[nxt, "high"])
            daily.loc[nxt, "low"] = min(daily.loc[d, "low"], daily.loc[nxt, "low"])
            daily = daily.drop(d)
    return daily


def load_databento_all(keys: list[str], history_dir: Path | None, api_key: str, backfill_from: str = "2024-01-01") -> dict[str, pd.DataFrame]:
    """
    Daily session bars (18:00-17:00 New York) built from Databento hourly bars for the
    continuous contracts (see ROLL_RULE; unadjusted, like TradingView's 1! symbols with back-adjustment off).
    Keeps a per-asset CSV cache in history_dir so each run only fetches recent days.
    """
    import databento as db

    client = db.Historical(api_key)
    rng = client.metadata.get_dataset_range("GLBX.MDP3")
    avail_end = pd.Timestamp(rng["end"]).tz_convert("UTC") if pd.Timestamp(rng["end"]).tzinfo else pd.Timestamp(rng["end"]).tz_localize("UTC")
    now_utc = pd.Timestamp.now(tz="UTC")
    end = min(avail_end, now_utc)
    print(f"databento GLBX.MDP3 available through {avail_end}", file=sys.stderr)

    cache: dict[str, pd.DataFrame] = {}
    full_start = pd.Timestamp(backfill_from, tz="UTC")
    if history_dir:
        history_dir.mkdir(parents=True, exist_ok=True)
        for k in keys:
            f = history_dir / f"{k}.csv"
            if f.exists():
                cache[k] = pd.read_csv(f, parse_dates=["date"]).set_index("date")

    def start_for(k: str) -> pd.Timestamp:
        # refetch the last few sessions so any partial day is rebuilt; full backfill if no cache
        if k in cache and len(cache[k]):
            return (pd.Timestamp(cache[k].index.max()) - pd.Timedelta(days=4)).tz_localize("UTC")
        return full_start

    import time as _time

    def fetch(symbol: str, s0: pd.Timestamp, s1: pd.Timestamp, schema: str = "ohlcv-1h") -> pd.DataFrame:
        last_err: Exception | None = None
        for attempt in range(4):
            try:
                data = client.timeseries.get_range(
                    dataset="GLBX.MDP3", symbols=[symbol], stype_in="continuous",
                    schema=schema, start=s0, end=s1,
                )
                d = data.to_df().reset_index()
                d["req_symbol"] = symbol
                return d
            except Exception as e:  # noqa: BLE001
                last_err = e
                wait = 5 * (attempt + 1)
                print(f"  {symbol} {s0.date()}..{s1.date()} attempt {attempt + 1} failed: {e}; retry in {wait}s", file=sys.stderr)
                _time.sleep(wait)
        raise RuntimeError(f"{symbol}: {last_err}")

    chunks: list[pd.DataFrame] = []
    for k in keys:
        s0 = start_for(k)
        while s0 < end:
            s1 = min(end, pd.Timestamp(year=s0.year + 1, month=1, day=1, tz="UTC"))
            d = fetch(cont_symbol(k), s0, s1)
            print(f"  {cont_symbol(k)} {s0.date()}..{s1.date()}: {len(d)} hourly bars", file=sys.stderr)
            chunks.append(d)
            s0 = s1
    df = pd.concat(chunks, ignore_index=True)
    if df.empty:
        raise RuntimeError("Databento returned no rows")
    print(f"databento columns: {list(df.columns)}", file=sys.stderr)
    if "symbol" in df.columns:
        print(f"databento symbols: {sorted(df['symbol'].astype(str).unique())[:40]}", file=sys.stderr)
    ts = pd.to_datetime(df["ts_event"], utc=True)
    df["trade_date"] = (ts.dt.tz_convert(NY) + pd.Timedelta(hours=6)).dt.normalize().dt.tz_localize(None)
    df["hour_ny"] = ts.dt.tz_convert(NY).dt.hour

    out: dict[str, pd.DataFrame] = {}
    for k in keys:
        part = df[df["req_symbol"] == cont_symbol(k)]
        if part.empty:
            raise RuntimeError(f"{k}: no rows from Databento (symbol {cont_symbol(k)})")
        # The 17:00-18:00 hour is the maintenance break; any bar there belongs to the closed session
        g = part.groupby("trade_date")
        daily = pd.DataFrame({
            "open": g["open"].first(), "high": g["high"].max(),
            "low": g["low"].min(), "close": g["close"].last(),
        })
        daily.index.name = "date"
        daily = daily[daily.index.weekday < 5]
        daily = merge_holiday_sessions(daily)
        daily["settle"] = float("nan")
        if k in cache:
            old_rows = cache[k][~cache[k].index.isin(daily.index)]
            if "settle" not in old_rows.columns:
                old_rows = old_rows.assign(settle=float("nan"))
            if "settle" in cache[k].columns:
                daily["settle"] = cache[k]["settle"].reindex(daily.index)  # keep known settlements
            merged = pd.concat([old_rows, daily]).sort_index()
        else:
            merged = daily.sort_index()
        merged = merge_holiday_sessions(merged[~merged.index.duplicated(keep="last")])

        # TradingView uses the settlement price as the daily close for futures.
        # Fetch it only for the dates whose close the board depends on.
        needed = settlement_dates_needed(merged[["open", "high", "low", "close"]], now_ny=datetime.now(NY))
        todo = [d for d in needed if d in merged.index and pd.isna(merged.loc[d, "settle"])]
        got = 0
        for d in todo:
            px = fetch_settlement(fetch, cont_symbol(k), d)
            if px is not None:
                merged.loc[d, "settle"] = px
                got += 1
        print(f"  {k}: settlement needed for {len(needed)} dates, fetched {got} of {len(todo)} new", file=sys.stderr)

        if history_dir:
            merged.to_csv(history_dir / f"{k}.csv")
        final = merged[["open", "high", "low"]].copy()
        final["close"] = merged["settle"].fillna(merged["close"])
        final["close_is_settlement"] = merged["settle"].notna()
        out[k] = final
    return out


def settlement_dates_needed(daily: pd.DataFrame, now_ny: datetime) -> list[pd.Timestamp]:
    """Last day of the most recent closed candles on every timeframe, plus the last few sessions."""
    last_daily = daily.index[-1]
    last_closed = last_bar_is_closed(last_daily, now_ny)
    dates: set[pd.Timestamp] = set()
    for tf in TIMEFRAMES:
        bars = resample(daily, tf)
        idx = len(bars) - 1
        while idx >= 0 and not candle_is_closed(tf, bars.iloc[idx], last_daily, last_closed, now_ny):
            idx -= 1
        for j in (idx, idx - 1):
            if j >= 0:
                dates.add(pd.Timestamp(bars.iloc[j]["end"]))
    closed_days = daily.index[:-1] if not last_closed else daily.index
    dates.update(pd.Timestamp(d) for d in closed_days[-5:])
    return sorted(dates)


def fetch_settlement(fetch, symbol: str, day: pd.Timestamp) -> float | None:
    """Final settlement for one trade date: statistics stat_type 3, published after the 16:00 NY settle
    (earlier on half days), so query a 12:55-17:30 NY window on that date."""
    s0 = pd.Timestamp(datetime(day.year, day.month, day.day, 12, 55, tzinfo=NY)).tz_convert("UTC")
    s1 = pd.Timestamp(datetime(day.year, day.month, day.day, 17, 30, tzinfo=NY)).tz_convert("UTC")
    try:
        st = fetch(symbol, s0, s1, schema="statistics")
    except Exception as e:  # noqa: BLE001
        print(f"  settlement {symbol} {day.date()}: {e}", file=sys.stderr)
        return None
    if st.empty or "stat_type" in st.columns and (st["stat_type"] == 3).sum() == 0:
        return None
    st = st[st["stat_type"] == 3].sort_values("ts_event")
    if "ts_ref" in st.columns:
        ref = pd.to_datetime(st["ts_ref"], utc=True).dt.date
        same = st[ref == day.date()]
        if not same.empty:
            st = same
    return float(st["price"].iloc[-1])


def load_tradingview_csv(path: Path) -> pd.DataFrame:
    """TradingView 'Export chart data' CSV: time (unix seconds or ISO), open, high, low, close, ..."""
    df = pd.read_csv(path)
    df.columns = [c.strip().lower() for c in df.columns]
    t = df["time"]
    if pd.api.types.is_numeric_dtype(t):
        ts = pd.to_datetime(t, unit="s", utc=True)
        # A UNIX stamp marks the session OPEN (18:00 NY the evening before); label by the date it ends.
        trade_date = (ts.dt.tz_convert(NY) + pd.Timedelta(hours=6)).dt.normalize().dt.tz_localize(None)
    elif t.astype(str).str.len().le(10).all():
        # Date-only export: already the trading date shown on the chart
        trade_date = pd.to_datetime(t)
    else:
        ts = pd.to_datetime(t, utc=True)
        trade_date = (ts.dt.tz_convert(NY) + pd.Timedelta(hours=6)).dt.normalize().dt.tz_localize(None)
    out = df[["open", "high", "low", "close"]].copy()
    out.index = trade_date
    out.index.name = "date"
    return out.sort_index().dropna()


def last_bar_is_closed(last_date: pd.Timestamp, now_ny: datetime) -> bool:
    """A daily bar labelled D is closed once it is past 17:00 NY on D."""
    close_time = datetime(last_date.year, last_date.month, last_date.day, SESSION_CLOSE_HOUR, tzinfo=NY)
    return now_ny >= close_time


# ─────────────────────────────────────────────────────────────
# Candle building
# ─────────────────────────────────────────────────────────────
def group_keys(dates: pd.DatetimeIndex, tf: str) -> pd.Series:
    if tf == "D":
        return pd.Series(dates, index=dates)
    if tf == "W":
        # Monday-anchored week start
        return pd.Series(dates - pd.to_timedelta(dates.weekday, unit="D"), index=dates)
    if tf == "M":
        return pd.Series(dates.to_period("M").to_timestamp(), index=dates)
    if tf == "3D":
        # Count trading days from the first trading day of each year, groups of 3
        s = pd.Series(dates, index=dates)
        ordinal = s.groupby(dates.year).cumcount()
        first_of_group = s.index[(ordinal % 3 == 0)]
        key = pd.Series(pd.NaT, index=dates, dtype="datetime64[ns]")
        key.loc[first_of_group] = first_of_group
        return key.ffill()
    raise ValueError(tf)


def resample(daily: pd.DataFrame, tf: str) -> pd.DataFrame:
    keys = group_keys(daily.index, tf)
    g = daily.groupby(keys.values)
    out = pd.DataFrame({
        "open":  g["open"].first(),
        "high":  g["high"].max(),
        "low":   g["low"].min(),
        "close": g["close"].last(),
        "start": g.apply(lambda x: x.index.min()),
        "end":   g.apply(lambda x: x.index.max()),
        "days":  g.size(),
    })
    out.index.name = "key"
    return out.sort_index()


def expected_days(tf: str, start: pd.Timestamp) -> int | None:
    """How many trading days a candle on this timeframe normally has. None = variable."""
    return {"D": 1, "3D": 3, "W": None, "M": None}[tf]


def candle_is_closed(tf: str, candle: pd.Series, last_daily: pd.Timestamp, last_daily_closed: bool, now_ny: datetime) -> bool:
    """Is this higher-timeframe candle finished, given what daily bars we have?"""
    end = candle["end"]
    if end < last_daily:
        return True  # a later daily bar exists, so this candle is history
    # candle ends on the latest daily bar: closed only if the daily is closed AND the period has ended
    if not last_daily_closed:
        return False
    today = pd.Timestamp(now_ny.date())
    if tf == "D":
        return True
    if tf == "3D":
        return candle["days"] >= 3 or _year_ended(end, today)
    if tf == "W":
        return end.weekday() == 4 or today > end + pd.Timedelta(days=(6 - end.weekday()))
    if tf == "M":
        next_month = (end.to_period("M") + 1).to_timestamp()
        return today >= next_month
    return False


def _year_ended(end: pd.Timestamp, today: pd.Timestamp) -> bool:
    return today.year > end.year


def forming_close_time(tf: str, forming_start: pd.Timestamp) -> datetime:
    """Expected close time of the candle currently forming (calendar-based, not holiday-aware)."""
    if tf == "D":
        d = forming_start
    elif tf == "3D":
        d = forming_start + pd.offsets.BDay(2)
    elif tf == "W":
        d = forming_start + pd.Timedelta(days=4 - forming_start.weekday())
    else:
        d = (forming_start.to_period("M") + 1).to_timestamp() - pd.Timedelta(days=1)
        while d.weekday() >= 5:
            d -= pd.Timedelta(days=1)
    return datetime(d.year, d.month, d.day, SESSION_CLOSE_HOUR, tzinfo=NY)


# ─────────────────────────────────────────────────────────────
# EBP logic
# ─────────────────────────────────────────────────────────────
def classify(cur: pd.Series, prev: pd.Series) -> str:
    if cur["low"] < prev["low"] and cur["close"] > prev["open"]:
        return "bullish"
    if cur["high"] > prev["high"] and cur["close"] < prev["open"]:
        return "bearish"
    return "neutral"


def analyse_asset(daily: pd.DataFrame, decimals: int, now_ny: datetime) -> dict:
    daily = daily.sort_index()
    last_daily = daily.index[-1]
    last_closed = last_bar_is_closed(last_daily, now_ny)
    price = float(daily["close"].iloc[-1])

    result = {
        "price": round(price, decimals),
        "price_as_of": _iso(last_daily, last_closed, now_ny),
        "last_daily_bar": str(last_daily.date()),
        "last_daily_closed": last_closed,
        "timeframes": {},
    }

    for tf in TIMEFRAMES:
        bars = resample(daily, tf)
        # find last closed candle
        idx = len(bars) - 1
        while idx >= 0 and not candle_is_closed(tf, bars.iloc[idx], last_daily, last_closed, now_ny):
            idx -= 1
        if idx < 1:
            result["timeframes"][tf] = {"bias": "neutral", "note": "insufficient data"}
            continue
        cur, prev = bars.iloc[idx], bars.iloc[idx - 1]
        bias = classify(cur, prev)

        inval = None
        intact = None
        if bias == "bullish":
            inval = float(cur["low"])
        elif bias == "bearish":
            inval = float(cur["high"])

        # price action since the EBP candle closed (partial candle + any later daily bars)
        after = daily[daily.index > cur["end"]]
        if inval is not None:
            if bias == "bullish":
                intact = bool((after["low"] > inval).all()) if len(after) else True
            else:
                intact = bool((after["high"] < inval).all()) if len(after) else True

        forming = bars.iloc[idx + 1] if idx + 1 < len(bars) else None
        forming_bias = None
        if forming is not None:
            forming_bias = classify(forming, cur)

        close_settled = bool(daily.loc[cur["end"], "close_is_settlement"]) if "close_is_settlement" in daily.columns else None
        result["timeframes"][tf] = {
            "label": TF_LABELS[tf],
            "bias": bias,
            "close_is_settlement": close_settled,
            "candle_start": str(cur["start"].date()),
            "candle_end": str(cur["end"].date()),
            "open": round(float(cur["open"]), decimals),
            "high": round(float(cur["high"]), decimals),
            "low": round(float(cur["low"]), decimals),
            "close": round(float(cur["close"]), decimals),
            "prior_open": round(float(prev["open"]), decimals),
            "prior_high": round(float(prev["high"]), decimals),
            "prior_low": round(float(prev["low"]), decimals),
            "invalidation": round(inval, decimals) if inval is not None else None,
            "intact": intact,
            "forming_bias": forming_bias,
            "forming_start": str(forming["start"].date()) if forming is not None else None,
            "next_close": forming_close_time(tf, forming["start"]).isoformat() if forming is not None else None,
        }

    biases = [v["bias"] for v in result["timeframes"].values()]
    bull = biases.count("bullish")
    bear = biases.count("bearish")
    result["alignment"] = {
        "bullish": bull,
        "bearish": bear,
        "net": bull - bear,
        "summary": "bullish" if bull >= 3 else "bearish" if bear >= 3 else "mixed",
    }
    return result


def _iso(last_daily: pd.Timestamp, closed: bool, now_ny: datetime) -> str:
    if closed:
        return datetime(last_daily.year, last_daily.month, last_daily.day, SESSION_CLOSE_HOUR, tzinfo=NY).isoformat()
    return now_ny.isoformat()


# ─────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv-dir", type=Path, help="Folder of TradingView CSV exports named NQ.csv, ES.csv ... (skips Yahoo)")
    ap.add_argument("--out", type=Path, default=Path("docs/data.json"))
    ap.add_argument("--now", help="Override 'now' (ISO, New York time) for testing")
    ap.add_argument("--raw-dir", type=Path, help="Also save the daily bars used, one CSV per asset")
    ap.add_argument("--source", choices=["yahoo", "databento"], default="yahoo")
    ap.add_argument("--history-dir", type=Path, default=Path("docs/history"), help="Databento mode: per-asset daily cache")
    args = ap.parse_args()

    now_ny = datetime.fromisoformat(args.now).replace(tzinfo=NY) if args.now else datetime.now(NY)

    assets_out = []
    errors = []
    dbdata: dict[str, pd.DataFrame] = {}
    if args.source == "databento" and not args.csv_dir:
        import os
        api_key = os.environ.get("DATABENTO_API_KEY", "")
        if not api_key:
            print("DATABENTO_API_KEY not set", file=sys.stderr)
            return 1
        try:
            dbdata = load_databento_all([a[0] for a in ASSETS], args.history_dir, api_key)
        except Exception as e:  # noqa: BLE001
            print(f"databento: ERROR {e}", file=sys.stderr)
            errors.append(f"databento: {e}")
    for key, name, ysym, tvsym, dec in ASSETS:
        try:
            if args.csv_dir:
                p = args.csv_dir / f"{key}.csv"
                if not p.exists():
                    errors.append(f"{key}: no CSV at {p}")
                    continue
                daily = load_tradingview_csv(p)
                source = f"tradingview-csv:{p.name}"
            elif args.source == "databento":
                if key not in dbdata:
                    raise RuntimeError("no Databento data")
                daily = dbdata[key]
                source = f"databento:{cont_symbol(key)}"
            else:
                daily = load_yahoo(ysym)
                source = f"yahoo:{ysym}"
            if args.raw_dir:
                args.raw_dir.mkdir(parents=True, exist_ok=True)
                daily.to_csv(args.raw_dir / f"{key}.csv")
            a = analyse_asset(daily, dec, now_ny)
            a.update({"key": key, "name": name, "tv_symbol": tvsym, "source": source})
            assets_out.append(a)
            print(f"{key:4} {a['alignment']['summary']:8} " + "  ".join(f"{tf}:{a['timeframes'][tf]['bias'][:4]}" for tf in TIMEFRAMES), file=sys.stderr)
        except Exception as e:  # noqa: BLE001
            errors.append(f"{key}: {e}")
            print(f"{key}: ERROR {e}", file=sys.stderr)

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "generated_at_ny": now_ny.isoformat(),
        "timeframes": TIMEFRAMES,
        "timeframe_labels": TF_LABELS,
        "assets": assets_out,
        "errors": errors,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2))
    print(f"wrote {args.out} ({len(assets_out)} assets, {len(errors)} errors)", file=sys.stderr)
    return 0 if assets_out else 1


if __name__ == "__main__":
    sys.exit(main())

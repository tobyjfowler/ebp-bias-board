#!/usr/bin/env python3
"""
Post a higher-timeframe EBP bias summary to Telegram after the board refreshes.

Usage: python telegram_summary.py docs/data.json [previous.json]
Sends only if the biases changed versus previous.json (or if no previous is given).
Needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in the environment.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

TFS = ["M", "W", "3D", "D"]
TF_NAME = {"M": "monthly", "W": "weekly", "3D": "3-day", "D": "daily"}
DOT = {"bullish": "🟢", "bearish": "🔴", "neutral": "⚪"}


def state(data: dict) -> dict:
    """What we compare between runs: bias + intact + candle end per asset/timeframe."""
    out = {}
    for a in data.get("assets", []):
        for tf in TFS:
            t = a["timeframes"].get(tf, {})
            out[(a["key"], tf)] = (t.get("bias", "neutral"), t.get("intact"), t.get("candle_end"))
    return out


def describe(asset: dict) -> str:
    dots, bull, bear = [], 0, 0
    for tf in TFS:
        t = asset["timeframes"].get(tf, {})
        bias = t.get("bias", "neutral")
        failed = bias != "neutral" and t.get("intact") is False
        dots.append("✖" if failed else DOT[bias])
        if not failed:
            bull += bias == "bullish"
            bear += bias == "bearish"
    if bull and not bear:
        verdict = f"bullish ×{bull}"
    elif bear and not bull:
        verdict = f"bearish ×{bear}"
    elif bull and bear:
        verdict = f"mixed ({bull} bull / {bear} bear)"
    else:
        verdict = "neutral"
    return f"<code>{asset['key']:<3}</code> {' '.join(dots)}  {verdict}"


def changes(prev: dict, cur: dict) -> list[str]:
    out = []
    for (key, tf), (bias, intact, end) in cur.items():
        pb, pi, pe = prev.get((key, tf), ("neutral", None, None))
        if bias != pb:
            out.append(f"{key} {TF_NAME[tf]} {pb} → {bias}")
        elif bias != "neutral" and pi is True and intact is False:
            out.append(f"{key} {TF_NAME[tf]} {bias} EBP failed")
    return out


def main() -> int:
    path = sys.argv[1]
    prev_path = sys.argv[2] if len(sys.argv) > 2 else None
    data = json.load(open(path))
    prev = json.load(open(prev_path)) if prev_path and os.path.exists(prev_path) else None

    cur_state = state(data)
    prev_state = state(prev) if prev else {}
    force = os.environ.get("FORCE_SUMMARY", "").lower() == "true"
    if prev and cur_state == prev_state and not force:
        print("no change in HTF biases; not sending", file=sys.stderr)
        return 0

    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    if not token or not chat:
        print("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set; not sending", file=sys.stderr)
        return 0

    # Date of the close this data reflects (latest closed daily bar)
    ends = [a["timeframes"]["D"].get("candle_end") for a in data["assets"] if "D" in a["timeframes"]]
    close_day = max(e for e in ends if e) if any(ends) else datetime.now(ZoneInfo("America/New_York")).date().isoformat()
    close_label = datetime.fromisoformat(close_day).strftime("%a %-d %b")

    lines = [f"📊 <b>HTF bias · {close_label} close</b>"]
    lines += [describe(a) for a in data["assets"]]
    lines.append("<i>(M · W · 3D · D)</i>")
    ch = changes(prev_state, cur_state) if prev else []
    if ch:
        lines.append("")
        lines.append("<b>Changes:</b> " + " · ".join(ch))
    text = "\n".join(lines)

    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=json.dumps({"chat_id": chat, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        print(f"telegram: {r.status}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

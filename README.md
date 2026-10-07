# EBP Bias Board

Higher-timeframe engulfing-bar-pattern bias for NQ, ES, YM, RTY, GC and CL.

- `ebp_engine.py` fetches daily futures data, builds daily / 3-day / weekly / monthly candles the way TradingView does, classifies the last closed candle on each as a bullish EBP, bearish EBP or neutral, and writes `docs/data.json`.
- `docs/index.html` is the dashboard. It reads `data.json` from the same folder.
- `.github/workflows/refresh.yml` runs the engine after the daily close and commits the new `data.json`.

## Setup (once)

1. Create a GitHub repository and push this folder to it.
2. Settings → Pages → Source: "Deploy from a branch", branch `main`, folder `/docs`.
3. Actions → "Refresh EBP bias board" → Run workflow, to generate the first `data.json`.
4. The board is then at `https://<your-username>.github.io/<repo>/`.

## Verifying against TradingView

Export daily data from TradingView (chart → Export chart data) for a symbol, save it as `csv/NQ.csv` etc., and run:

    python ebp_engine.py --csv-dir csv --out check.json

Compare the biases and levels to the chart.

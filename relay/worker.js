/**
 * EBP signal relay — Cloudflare Worker
 *
 * POST /            TradingView webhook. Body: the JSON built by the EBP MTF indicator.
 *                   Accepts "signal" and "fail" events. Requires a matching "secret".
 * GET  /signals     Latest signal per asset/timeframe plus recent history, for the board.
 * GET  /health      Plain OK.
 *
 * Bindings (set in the Worker's Settings):
 *   KV namespace  SIGNALS
 *   Secret        SIGNAL_SECRET   (same value as the indicator's "Shared secret" input)
 */

const ASSETS = ["NQ", "ES", "YM", "RTY", "GC", "CL"];
const TFS = ["6H", "4H", "1H"];
const RECENT_MAX = 300;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method === "GET" && url.pathname === "/health") return new Response("ok", { headers: cors });

    if (request.method === "GET" && url.pathname === "/signals") {
      const [latestRaw, recentRaw] = await Promise.all([env.SIGNALS.get("latest"), env.SIGNALS.get("recent")]);
      return json({
        latest: latestRaw ? JSON.parse(latestRaw) : {},
        recent: recentRaw ? JSON.parse(recentRaw) : [],
        served_at: new Date().toISOString(),
      });
    }

    if (request.method === "POST" && (url.pathname === "/" || url.pathname === "/signal")) {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "body is not JSON" }, 400);
      }
      if (!env.SIGNAL_SECRET || body.secret !== env.SIGNAL_SECRET) return json({ error: "bad secret" }, 401);

      const asset = String(body.asset || "").toUpperCase();
      const tf = String(body.tf || "").toUpperCase();
      const event = String(body.event || "");
      if (!ASSETS.includes(asset)) return json({ error: `unknown asset ${asset}` }, 400);
      if (!TFS.includes(tf)) return json({ error: `unknown tf ${tf}` }, 400);
      if (!["signal", "fail"].includes(event)) return json({ error: `unknown event ${event}` }, 400);

      const latest = JSON.parse((await env.SIGNALS.get("latest")) || "{}");
      const recent = JSON.parse((await env.SIGNALS.get("recent")) || "[]");
      const now = new Date().toISOString();
      latest[asset] = latest[asset] || {};

      if (event === "signal") {
        const sig = {
          asset, tf,
          dir: body.dir === "bearish" ? "bearish" : "bullish",
          close: num(body.close),
          sweep: num(body.sweep),
          prior_open: num(body.prior_open),
          candle_open: isoFromMs(body.candle_open),
          candle_close: isoFromMs(body.candle_close),
          received_at: now,
          failed: false,
          failed_at: null,
        };
        latest[asset][tf] = sig;
        recent.unshift({ event: "signal", ...sig });
      } else {
        const cur = latest[asset][tf];
        // Only fail the signal this message refers to (same candle), so a late "fail" can't hit a newer signal
        if (cur && (!body.candle_close || cur.candle_close === isoFromMs(body.candle_close))) {
          cur.failed = true;
          cur.failed_at = isoFromMs(body.failed_at) || now;
        }
        recent.unshift({ event: "fail", asset, tf, dir: body.dir, sweep: num(body.sweep), candle_close: isoFromMs(body.candle_close), received_at: now });
      }

      while (recent.length > RECENT_MAX) recent.pop();
      await Promise.all([env.SIGNALS.put("latest", JSON.stringify(latest)), env.SIGNALS.put("recent", JSON.stringify(recent))]);
      return json({ ok: true, asset, tf, event });
    }

    return json({ error: "not found" }, 404);
  },
};

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isoFromMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n).toISOString();
}

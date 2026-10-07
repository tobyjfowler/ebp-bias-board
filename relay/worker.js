/**
 * EBP signal relay — Cloudflare Worker
 *
 * POST /            TradingView webhook. Body: the JSON built by the EBP MTF indicator.
 *                   Accepts "signal" and "fail" events. Requires a matching "secret".
 * GET  /signals     Latest signal per asset/timeframe plus recent history, for the board.
 * GET  /health      Plain OK.
 *
 * Bindings (Worker → Settings):
 *   KV namespace  SIGNALS
 *   Secret        SIGNAL_SECRET        same value as the indicator's "Shared secret" input
 *   Secret        TELEGRAM_BOT_TOKEN   from @BotFather (optional: no Telegram without it)
 *   Secret        TELEGRAM_CHAT_ID     your numeric Telegram ID (or a group's -100… id)
 *
 * Telegram: a message is sent when a signal arrives that is QUALIFIED — at least one
 * higher timeframe (M/W/3D/D) on the board has an intact EBP in the same direction —
 * and when a signal that was announced later fails.
 */

const ASSETS = ["NQ", "ES", "YM", "RTY", "GC", "CL"];
const TFS = ["6H", "4H", "1H"];
const RECENT_MAX = 300;
const BOARD_DATA_URL = "https://tobyjfowler.github.io/ebp-bias-board/data.json";
const HTF_ORDER = ["M", "W", "3D", "D"];
const HTF_LABEL = { M: "Monthly", W: "Weekly", "3D": "3-Day", D: "Daily" };
const DECIMALS = { NQ: 2, ES: 2, YM: 0, RTY: 1, GC: 1, CL: 2 };

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors } });

export default {
  async fetch(request, env, ctx) {
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

      const event = String(body.event || "");

      // Manual test: {"event":"test","secret":"…"} → sends a Telegram message, stores nothing
      if (event === "test") {
        const diag = {
          has_bot_token: Boolean(env.TELEGRAM_BOT_TOKEN),
          bot_token_looks_right: /^\d+:[A-Za-z0-9_-]{20,}$/.test(String(env.TELEGRAM_BOT_TOKEN || "").trim()),
          has_chat_id: Boolean(env.TELEGRAM_CHAT_ID),
          chat_id_is_number: /^-?\d+$/.test(String(env.TELEGRAM_CHAT_ID || "").trim()),
        };
        const result = await sendTelegram(env, "✅ EBP relay connected. Qualified intraday signals will arrive here.", true);
        return json({ ok: result === true, telegram: result, diag });
      }

      const asset = String(body.asset || "").toUpperCase();
      const tf = String(body.tf || "").toUpperCase();
      if (!ASSETS.includes(asset)) return json({ error: `unknown asset ${asset}` }, 400);
      if (!TFS.includes(tf)) return json({ error: `unknown tf ${tf}` }, 400);
      if (!["signal", "fail"].includes(event)) return json({ error: `unknown event ${event}` }, 400);

      const latest = JSON.parse((await env.SIGNALS.get("latest")) || "{}");
      const recent = JSON.parse((await env.SIGNALS.get("recent")) || "[]");
      const now = new Date().toISOString();
      latest[asset] = latest[asset] || {};
      const cur = latest[asset][tf];
      let telegram = "none";

      if (event === "signal") {
        const candleClose = isoFromMs(body.candle_close);
        const dir = body.dir === "bearish" ? "bearish" : "bullish";

        // TradingView re-sends the current state whenever an alert is (re)saved: ignore exact repeats
        if (cur && cur.candle_close === candleClose && cur.dir === dir) {
          return json({ ok: true, asset, tf, event, duplicate: true });
        }

        const sig = {
          asset, tf, dir,
          close: num(body.close),
          sweep: num(body.sweep),
          prior_open: num(body.prior_open),
          candle_open: isoFromMs(body.candle_open),
          candle_close: candleClose,
          received_at: now,
          failed: false,
          failed_at: null,
          qualified_by: [],
          notified: false,
        };

        const support = await qualifiedBy(asset, dir);
        sig.qualified_by = support;
        if (support.length) {
          const sent = await sendTelegram(env, signalMessage(sig, support));
          sig.notified = sent;
          telegram = sent ? "sent" : "failed";
        } else {
          telegram = "unqualified";
        }

        latest[asset][tf] = sig;
        recent.unshift({ event: "signal", ...sig });
      } else {
        // Only fail the signal this message refers to (same candle), so a late "fail" can't hit a newer signal
        if (cur && !cur.failed && (!body.candle_close || cur.candle_close === isoFromMs(body.candle_close))) {
          cur.failed = true;
          cur.failed_at = isoFromMs(body.failed_at) || now;
          if (cur.notified) {
            const sent = await sendTelegram(env, failMessage(cur));
            telegram = sent ? "sent" : "failed";
          }
          recent.unshift({ event: "fail", asset, tf, dir: cur.dir, sweep: cur.sweep, candle_close: cur.candle_close, received_at: now });
        } else {
          return json({ ok: true, asset, tf, event, ignored: "no matching open signal" });
        }
      }

      while (recent.length > RECENT_MAX) recent.pop();
      await Promise.all([env.SIGNALS.put("latest", JSON.stringify(latest)), env.SIGNALS.put("recent", JSON.stringify(recent))]);
      return json({ ok: true, asset, tf, event, telegram });
    }

    return json({ error: "not found" }, 404);
  },
};

// ── Qualification against the board's higher-timeframe biases ──────────────
async function qualifiedBy(asset, dir) {
  try {
    const r = await fetch(BOARD_DATA_URL, { cf: { cacheTtl: 120 } });
    if (!r.ok) return [];
    const data = await r.json();
    const a = (data.assets || []).find(x => x.key === asset);
    if (!a) return [];
    return HTF_ORDER.filter(tf => {
      const t = a.timeframes && a.timeframes[tf];
      return t && t.bias === dir && t.intact === true;
    });
  } catch {
    return [];
  }
}

// ── Telegram ───────────────────────────────────────────────────────────────
async function sendTelegram(env, text, verbose = false) {
  const token = String(env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = String(env.TELEGRAM_CHAT_ID || "").trim();
  if (!token || !chatId) return verbose ? "not configured" : false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    if (r.ok) return true;
    if (!verbose) return false;
    let detail = "";
    try { detail = (await r.json()).description || ""; } catch {}
    return `telegram ${r.status}: ${detail}`;
  } catch (e) {
    return verbose ? `request failed: ${e.message}` : false;
  }
}

function signalMessage(sig, support) {
  const dec = DECIMALS[sig.asset] ?? 2;
  const icon = sig.dir === "bullish" ? "🟢" : "🔴";
  const failWord = sig.dir === "bullish" ? "fails below" : "fails above";
  return [
    `${icon} <b>${sig.asset} ${sig.tf} ${sig.dir.toUpperCase()} EBP</b>`,
    `Qualified by: ${support.map(tf => HTF_LABEL[tf]).join(", ")}`,
    `Close ${fmt(sig.close, dec)} · ${failWord} ${fmt(sig.sweep, dec)}`,
    `Candle closed ${nyTime(sig.candle_close)} NY`,
  ].join("\n");
}

function failMessage(sig) {
  const dec = DECIMALS[sig.asset] ?? 2;
  return [
    `⚪ <b>${sig.asset} ${sig.tf} ${sig.dir} EBP failed</b>`,
    `Price traded through ${fmt(sig.sweep, dec)} at ${nyTime(sig.failed_at)} NY`,
  ].join("\n");
}

// ── helpers ────────────────────────────────────────────────────────────────
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isoFromMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n).toISOString();
}

function fmt(n, dec) {
  return n == null ? "—" : Number(n).toLocaleString("en-GB", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function nyTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-GB", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit" });
}

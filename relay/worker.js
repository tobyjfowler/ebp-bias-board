/**
 * EBP signal relay — Cloudflare Worker
 *
 * POST /            TradingView webhooks (JSON built by the EBP indicators). Requires "secret".
 *                     event "signal"   intraday EBP confirmed (6H/4H/1H)        → EBP MTF indicator
 *                     event "fail"     intraday EBP's sweep level traded through
 *                     event "htf"      daily close / session open update of D/3D/W/M biases → EBP HTF indicator
 *                     event "htf_fail" an HTF EBP's sweep level traded through
 *                     event "test"     sends a Telegram test message
 * POST /telegram    Telegram bot webhook: /bias, /signals, /nq … /cl, /help. Register it once by opening
 *                     https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<worker>/telegram&secret_token=<SIGNAL_SECRET>
 * GET  /signals     Everything the board needs: htf (per asset), latest intraday, recent events.
 * GET  /health      Plain OK.
 *
 * Bindings (Worker → Settings):
 *   KV namespace  SIGNALS
 *   Secret        SIGNAL_SECRET        same as the indicators' "Shared secret"
 *   Secret        TELEGRAM_BOT_TOKEN   from @BotFather
 *   Secret        TELEGRAM_CHAT_ID     your numeric Telegram ID
 *   Cron trigger  (Settings → Triggers) e.g. "25 21 * * 1-5" and "25 22 * * 1-5": fallback summary at 17:25 New York
 *
 * Telegram messages:
 *   - qualified intraday signal (an intact HTF EBP in the same direction exists), and its later failure
 *   - HTF bias summary once all six assets have reported the daily close (or at the fallback time)
 *   - an HTF EBP failing during the day
 */

const ASSETS = ["NQ", "ES", "YM", "RTY", "GC", "CL"];
const ASSET_NAMES = { NQ: "Nasdaq 100", ES: "S&P 500", YM: "Dow Jones", RTY: "Russell 2000", GC: "Gold", CL: "Crude Oil" };
const ITFS = ["6H", "4H", "1H"];
const HTFS = ["M", "W", "3D", "D"];
const HTF_LABEL = { M: "Monthly", W: "Weekly", "3D": "3-Day", D: "Daily" };
const DECIMALS = { NQ: 2, ES: 2, YM: 0, RTY: 1, GC: 1, CL: 2 };
const RECENT_MAX = 300;
const DOT = { bullish: "🟢", bearish: "🔴", neutral: "⚪" };

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors } });

const kvGet = async (env, k, dflt) => { const v = await env.SIGNALS.get(k); return v ? JSON.parse(v) : dflt; };
const kvPut = (env, k, v) => env.SIGNALS.put(k, JSON.stringify(v));

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method === "GET" && url.pathname === "/health") return new Response("ok", { headers: cors });

    if (request.method === "GET" && url.pathname === "/signals") {
      const [htf, latest, recent, meta] = await Promise.all([
        kvGet(env, "htf", {}), kvGet(env, "latest", {}), kvGet(env, "recent", []), kvGet(env, "meta", {}),
      ]);
      return json({ htf, latest, recent, meta, served_at: new Date().toISOString() });
    }

    // Telegram bot commands (Telegram → relay webhook)
    if (request.method === "POST" && url.pathname === "/telegram") return handleTelegramUpdate(request, env);

    if (request.method === "POST" && (url.pathname === "/" || url.pathname === "/signal")) {
      let body;
      try { body = await request.json(); } catch { return json({ error: "body is not JSON" }, 400); }
      if (!env.SIGNAL_SECRET || body.secret !== env.SIGNAL_SECRET) return json({ error: "bad secret" }, 401);

      const event = String(body.event || "");
      if (event === "test") return handleTest(env);

      const asset = String(body.asset || "").toUpperCase();
      if (!ASSETS.includes(asset)) return json({ error: `unknown asset ${asset}` }, 400);

      if (event === "htf") return handleHtf(env, body, asset);
      if (event === "htf_fail") return handleHtfFail(env, body, asset);
      if (event === "signal") return handleSignal(env, body, asset);
      if (event === "fail") return handleFail(env, body, asset);
      return json({ error: `unknown event ${event}` }, 400);
    }
    return json({ error: "not found" }, 404);
  },

  // Fallback: send the daily summary if it has not gone out yet (cron at ~17:25 New York)
  async scheduled(event, env, ctx) {
    const nyHour = Number(new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }));
    if (nyHour !== 17) return;
    await maybeSendSummary(env, true);
  },
};

// ── HTF updates ────────────────────────────────────────────────────────────
async function handleHtf(env, body, asset) {
  const htf = await kvGet(env, "htf", {});
  const tfs = {};
  for (const tf of HTFS) {
    const t = body[tf] || {};
    tfs[tf] = {
      bias: ["bullish", "bearish"].includes(t.bias) ? t.bias : "neutral",
      open: num(t.open), high: num(t.high), low: num(t.low), close: num(t.close),
      prior_open: num(t.prior_open), prior_high: num(t.prior_high), prior_low: num(t.prior_low),
      sweep: t.bias === "neutral" ? null : num(t.sweep),
      intact: t.bias === "neutral" ? null : t.intact !== false,
      candle_start: t.candle_start || null, candle_end: t.candle_end || null,
      forming_bias: t.forming_bias || "neutral", forming_start: t.forming_start || null,
    };
  }
  const prev = htf[asset];
  // keep a failure already recorded today for the same closed candle
  if (prev) for (const tf of HTFS) {
    const p = prev.timeframes[tf], n = tfs[tf];
    if (p && p.candle_end === n.candle_end && p.bias === n.bias && p.intact === false) n.intact = false;
  }
  htf[asset] = {
    asset, name: ASSET_NAMES[asset], trade_date: body.trade_date || null, reason: body.reason || "close",
    price: num(body.price), bar_time: isoFromMs(body.bar_time), as_of: isoFromMs(body.as_of),
    received_at: new Date().toISOString(), timeframes: tfs,
  };
  await kvPut(env, "htf", htf);

  let telegram = "none";
  if (body.reason === "close") {
    telegram = await maybeSendSummary(env, false) ? "summary sent" : "waiting for other assets";
  } else if (body.reason === "correction" && prev) {
    const ch = biasChanges({ [asset]: prev }, { [asset]: htf[asset] });
    if (ch.length) telegram = (await sendTelegram(env, `🔁 <b>HTF correction</b>\n${ch.join("\n")}`)) ? "sent" : "failed";
  }
  return json({ ok: true, asset, event: "htf", telegram });
}

async function handleHtfFail(env, body, asset) {
  const htf = await kvGet(env, "htf", {});
  const tf = String(body.tf || "").toUpperCase();
  const a = htf[asset];
  if (!a || !HTFS.includes(tf)) return json({ ok: true, ignored: "no HTF state" });
  const t = a.timeframes[tf];
  if (t.bias === "neutral" || t.intact === false) return json({ ok: true, ignored: "nothing to fail" });
  t.intact = false;
  t.failed_at = isoFromMs(body.failed_at) || new Date().toISOString();
  await kvPut(env, "htf", htf);
  const dec = DECIMALS[asset] ?? 2;
  const sent = await sendTelegram(env, `⚪ <b>${asset} ${HTF_LABEL[tf].toLowerCase()} ${t.bias} EBP failed</b>\nPrice traded through ${fmt(t.sweep, dec)} at ${nyTime(t.failed_at)} NY`);
  return json({ ok: true, asset, tf, event: "htf_fail", telegram: sent ? "sent" : "failed" });
}

// ── Daily summary ──────────────────────────────────────────────────────────
async function maybeSendSummary(env, force) {
  const [htf, meta] = await Promise.all([kvGet(env, "htf", {}), kvGet(env, "meta", {})]);
  const closes = ASSETS.map(k => htf[k]).filter(a => a && a.reason === "close" && a.trade_date);
  if (!closes.length) return false;
  const date = closes.map(a => a.trade_date).sort().pop();
  if (meta.summary_date === date) return false;
  const todays = closes.filter(a => a.trade_date === date);
  if (!force && todays.length < ASSETS.length) return false;

  const prevSnap = meta.summary_snapshot || {};
  const lines = [`📊 <b>HTF bias · ${dayLabel(date)} close</b>`];
  for (const k of ASSETS) {
    const a = htf[k];
    if (!a) { lines.push(`<code>${k.padEnd(3)}</code> no data`); continue; }
    lines.push(describe(a) + (a.trade_date !== date ? ` <i>(as of ${dayLabel(a.trade_date)})</i>` : ""));
  }
  lines.push("<i>(M · W · 3D · D)</i>");
  const ch = biasChanges(prevSnap, htf);
  if (ch.length) lines.push("", "<b>Changes:</b> " + ch.join(" · "));
  if (force && todays.length < ASSETS.length) lines.push("", `<i>${ASSETS.length - todays.length} asset(s) have not reported today's close yet.</i>`);

  const sent = await sendTelegram(env, lines.join("\n"));
  if (sent) {
    meta.summary_date = date;
    meta.summary_sent_at = new Date().toISOString();
    meta.summary_snapshot = snapshot(htf);
    await kvPut(env, "meta", meta);
  }
  return sent;
}

function describe(a) {
  const dots = [];
  let bull = 0, bear = 0;
  for (const tf of HTFS) {
    const t = a.timeframes[tf];
    const failed = t.bias !== "neutral" && t.intact === false;
    dots.push(failed ? "✖" : DOT[t.bias]);
    if (!failed) { bull += t.bias === "bullish"; bear += t.bias === "bearish"; }
  }
  const verdict = bull && !bear ? `bullish ×${bull}` : bear && !bull ? `bearish ×${bear}` : bull && bear ? `mixed (${bull} bull / ${bear} bear)` : "neutral";
  return `<code>${a.asset.padEnd(3)}</code> ${dots.join(" ")}  ${verdict}`;
}

function snapshot(htf) {
  const out = {};
  for (const k of ASSETS) {
    const a = htf[k];
    if (!a) continue;
    out[k] = { timeframes: {} };
    for (const tf of HTFS) {
      const t = a.timeframes[tf];
      out[k].timeframes[tf] = { bias: t.bias, intact: t.intact, candle_end: t.candle_end };
    }
  }
  return out;
}

function biasChanges(prevHtf, curHtf) {
  const out = [];
  for (const k of ASSETS) {
    const c = curHtf[k], p = prevHtf[k];
    if (!c) continue;
    for (const tf of HTFS) {
      const ct = c.timeframes[tf], pt = p && p.timeframes[tf];
      const pb = pt ? pt.bias : "neutral";
      if (ct.bias !== pb) out.push(`${k} ${HTF_LABEL[tf].toLowerCase()} ${pb} → ${ct.bias}`);
      else if (ct.bias !== "neutral" && pt && pt.intact === true && ct.intact === false) out.push(`${k} ${HTF_LABEL[tf].toLowerCase()} ${ct.bias} EBP failed`);
    }
  }
  return out;
}

// ── Intraday signals ───────────────────────────────────────────────────────
async function handleSignal(env, body, asset) {
  const tf = String(body.tf || "").toUpperCase();
  if (!ITFS.includes(tf)) return json({ error: `unknown tf ${tf}` }, 400);
  const [latest, recent, htf] = await Promise.all([kvGet(env, "latest", {}), kvGet(env, "recent", []), kvGet(env, "htf", {})]);
  latest[asset] = latest[asset] || {};
  const cur = latest[asset][tf];
  const candleClose = isoFromMs(body.candle_close);
  const dir = body.dir === "bearish" ? "bearish" : "bullish";
  if (cur && cur.candle_close === candleClose && cur.dir === dir) return json({ ok: true, asset, tf, duplicate: true });

  const sig = {
    asset, tf, dir, close: num(body.close), sweep: num(body.sweep), prior_open: num(body.prior_open),
    candle_open: isoFromMs(body.candle_open), candle_close: candleClose,
    received_at: new Date().toISOString(), failed: false, failed_at: null, qualified_by: [], notified: false,
  };
  const support = qualifiedBy(htf, asset, dir);
  sig.qualified_by = support;
  let telegram = "unqualified";
  if (support.length) {
    const sent = await sendTelegram(env, signalMessage(sig, support));
    sig.notified = sent;
    telegram = sent ? "sent" : "failed";
  }
  latest[asset][tf] = sig;
  recent.unshift({ event: "signal", ...sig });
  while (recent.length > RECENT_MAX) recent.pop();
  await Promise.all([kvPut(env, "latest", latest), kvPut(env, "recent", recent)]);
  return json({ ok: true, asset, tf, event: "signal", telegram });
}

async function handleFail(env, body, asset) {
  const tf = String(body.tf || "").toUpperCase();
  if (!ITFS.includes(tf)) return json({ error: `unknown tf ${tf}` }, 400);
  const [latest, recent] = await Promise.all([kvGet(env, "latest", {}), kvGet(env, "recent", [])]);
  const cur = latest[asset] && latest[asset][tf];
  if (!cur || cur.failed || (body.candle_close && cur.candle_close !== isoFromMs(body.candle_close))) {
    return json({ ok: true, asset, tf, ignored: "no matching open signal" });
  }
  cur.failed = true;
  cur.failed_at = isoFromMs(body.failed_at) || new Date().toISOString();
  let telegram = "none";
  if (cur.notified) telegram = (await sendTelegram(env, failMessage(cur))) ? "sent" : "failed";
  recent.unshift({ event: "fail", asset, tf, dir: cur.dir, sweep: cur.sweep, candle_close: cur.candle_close, received_at: new Date().toISOString() });
  while (recent.length > RECENT_MAX) recent.pop();
  await Promise.all([kvPut(env, "latest", latest), kvPut(env, "recent", recent)]);
  return json({ ok: true, asset, tf, event: "fail", telegram });
}

function qualifiedBy(htf, asset, dir) {
  const a = htf[asset];
  if (!a) return [];
  return HTFS.filter(tf => { const t = a.timeframes[tf]; return t && t.bias === dir && t.intact === true; });
}

// ── Telegram bot commands ──────────────────────────────────────────────────
async function handleTelegramUpdate(request, env) {
  // Telegram sends the secret_token we registered in this header
  if (!env.SIGNAL_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.SIGNAL_SECRET) return json({ ok: false }, 401);
  let update;
  try { update = await request.json(); } catch { return json({ ok: true }); }
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return json({ ok: true });
  if (String(msg.chat.id) !== String(env.TELEGRAM_CHAT_ID || "").trim()) return json({ ok: true }); // only answer the owner

  const cmd = msg.text.trim().split(/\s+/)[0].toLowerCase().replace(/@.*$/, "");
  const [htf, latest] = await Promise.all([kvGet(env, "htf", {}), kvGet(env, "latest", {})]);
  let reply;
  if (cmd === "/bias" || cmd === "/htf") reply = biasText(htf);
  else if (cmd === "/signals" || cmd === "/intraday") reply = signalsText(htf, latest);
  else if (ASSETS.includes(cmd.slice(1).toUpperCase())) reply = assetText(cmd.slice(1).toUpperCase(), htf, latest);
  else if (cmd === "/start" || cmd === "/help") reply = helpText();
  else reply = "Unknown command.\n" + helpText();
  await sendTelegram(env, reply);
  return json({ ok: true });
}

function helpText() {
  return [
    "<b>EBP bot</b>",
    "/bias – higher-timeframe biases (M · W · 3D · D)",
    "/signals – qualified 6H/4H/1H signals",
    "/nq /es /ym /rty /gc /cl – one asset in detail",
  ].join("\n");
}

function biasText(htf) {
  const dates = ASSETS.map(k => htf[k] && htf[k].timeframes.D.candle_end).filter(Boolean).sort();
  const date = dates.pop();
  const lines = [`📊 <b>HTF bias${date ? " · as of " + dayLabel(date) + " close" : ""}</b>`];
  for (const k of ASSETS) {
    const a = htf[k];
    if (!a) { lines.push(`<code>${k.padEnd(3)}</code> no data yet`); continue; }
    const d = a.timeframes.D.candle_end;
    lines.push(describe(a) + (d && d !== date ? ` <i>(${dayLabel(d)})</i>` : ""));
  }
  lines.push("<i>(M · W · 3D · D)</i>");
  return lines.join("\n");
}

function signalsText(htf, latest) {
  // Qualified intraday signals only (an intact HTF EBP in the same direction), newest first
  const rows = [];
  for (const k of ASSETS) {
    const sigs = latest[k] || {};
    for (const tf of ITFS) {
      const s = sigs[tf];
      if (!s) continue;
      const q = qualifiedBy(htf, k, s.dir);
      if (!q.length) continue;
      const dec = DECIMALS[k] ?? 2;
      rows.push({ t: s.candle_close || "", text:
        `${s.failed ? "✖" : DOT[s.dir]} <b>${k} ${tf}</b> ${s.dir} · ${ago(s.candle_close)} · ${s.failed ? "failed at" : s.dir === "bullish" ? "fails below" : "fails above"} ${fmt(s.sweep, dec)} · by ${q.map(x => HTF_LABEL[x]).join(", ")}` });
    }
  }
  rows.sort((a, b) => (a.t < b.t ? 1 : -1));
  const lines = ["⚡ <b>Qualified intraday signals</b>"];
  if (!rows.length) lines.push("None at the moment.");
  else lines.push(...rows.map(r => r.text));
  lines.push("<i>✖ = sweep level has since been traded through</i>");
  return lines.join("\n");
}

function assetText(k, htf, latest) {
  const dec = DECIMALS[k] ?? 2;
  const a = htf[k];
  const lines = [`<b>${k} · ${ASSET_NAMES[k]}</b>`];
  if (!a) {
    lines.push("No higher-timeframe data yet.");
  } else {
    lines.push(`Price ${fmt(a.price, dec)} · as of ${dayLabel(a.timeframes.D.candle_end)} close`);
    for (const tf of HTFS) {
      const t = a.timeframes[tf];
      const failed = t.bias !== "neutral" && t.intact === false;
      let txt = `${failed ? "✖" : DOT[t.bias]} <b>${HTF_LABEL[tf]}</b> ${t.bias}`;
      if (t.bias !== "neutral") txt += ` · ${failed ? "failed at" : t.bias === "bullish" ? "fails below" : "fails above"} ${fmt(t.sweep, dec)}`;
      if (t.forming_bias && t.forming_bias !== "neutral") txt += ` · <i>${t.forming_bias} forming</i>`;
      lines.push(txt);
    }
  }
  const sigs = latest[k] || {};
  const parts = [];
  for (const tf of ITFS) {
    const s = sigs[tf];
    if (!s) continue;
    const q = qualifiedBy(htf, k, s.dir);
    parts.push(`${s.failed ? "✖" : DOT[s.dir]} <b>${tf}</b> ${s.dir} ${ago(s.candle_close)} · ${s.failed ? "failed at" : s.dir === "bullish" ? "fails below" : "fails above"} ${fmt(s.sweep, dec)} · ${q.length ? "qualified (" + q.map(x => HTF_LABEL[x]).join(", ") + ")" : "unqualified"}`);
  }
  lines.push("", parts.length ? "<b>Intraday</b>\n" + parts.join("\n") : "<i>No intraday signals yet.</i>");
  return lines.join("\n");
}

function ago(iso) {
  if (!iso) return "";
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h${m % 60 ? " " + (m % 60) + "m" : ""} ago` : Math.floor(h / 24) + "d ago";
}

// ── Telegram ───────────────────────────────────────────────────────────────
async function handleTest(env) {
  const diag = {
    has_bot_token: Boolean(env.TELEGRAM_BOT_TOKEN),
    has_chat_id: Boolean(env.TELEGRAM_CHAT_ID),
  };
  const result = await sendTelegram(env, "✅ EBP relay connected.", true);
  return json({ ok: result === true, telegram: result, diag });
}

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
  return [`⚪ <b>${sig.asset} ${sig.tf} ${sig.dir} EBP failed</b>`, `Price traded through ${fmt(sig.sweep, dec)} at ${nyTime(sig.failed_at)} NY`].join("\n");
}

// ── helpers ────────────────────────────────────────────────────────────────
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function isoFromMs(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null; }
function fmt(n, dec) { return n == null ? "—" : Number(n).toLocaleString("en-GB", { minimumFractionDigits: dec, maximumFractionDigits: dec }); }
function nyTime(iso) { return iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit" }) : ""; }
function dayLabel(d) { return d ? new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) : ""; }

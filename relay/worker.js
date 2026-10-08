/**
 * EBP signal relay — Cloudflare Worker
 *
 * POST /            TradingView webhooks (JSON built by the EBP indicators). Requires "secret".
 *                     event "signal"    intraday EBP confirmed (6H/4H/1H)         → EBP MTF indicator
 *                     event "fail"      intraday EBP's sweep level traded through
 *                     event "eq_cross"  intraday close crossed the daily EBP's equilibrium (early warning)
 *                     event "htf"       daily close / session open update of D/3D/W/M → EBP HTF indicator
 *                     event "htf_fail"  an HTF EBP's sweep level traded through
 *                     event "test"      sends a Telegram test message
 * POST /telegram    Telegram bot webhook: /bias, /signals, /nq … /cl, /help. Register once by opening
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
 * Bias model
 *   Each HTF EBP candle has an equilibrium (EQ) = midpoint of its range and a state:
 *     intact    nothing has closed through EQ against it
 *     violated  a lower-timeframe EBP in the opposite direction closed through EQ → the bias FLIPS to that
 *               direction, labelled "EQ violation"; the violator's sweep level becomes the new fail level
 *     failed    the candle's own sweep level has been traded through
 *   A same-direction EBP closing back through EQ (or the violator failing) reclaims the original bias.
 *   Which timeframes may violate which is in VIOLATORS. The violating signal itself counts as qualified.
 *   Intraday signals qualify when at least one HTF's effective bias (after flips) matches and is not failed.
 */

const ASSETS = ["NQ", "ES", "YM", "RTY", "GC", "CL"];
const ASSET_NAMES = { NQ: "Nasdaq 100", ES: "S&P 500", YM: "Dow Jones", RTY: "Russell 2000", GC: "Gold", CL: "Crude Oil" };
const ITFS = ["6H", "4H", "1H"];
const HTFS = ["M", "W", "3D", "D"];
const HTF_LABEL = { M: "Monthly", W: "Weekly", "3D": "3-Day", D: "Daily" };
const TF_LABEL = { ...HTF_LABEL, "6H": "6H", "4H": "4H", "1H": "1H" };
const DECIMALS = { NQ: 2, ES: 2, YM: 0, RTY: 1, GC: 1, CL: 2 };
const RECENT_MAX = 300;
const DOT = { bullish: "🟢", bearish: "🔴", neutral: "⚪" };
const DOT_EQ = { bullish: "🔺", bearish: "🔻" }; // bias reached by EQ violation
// which (lower) timeframes' EBPs can violate / reclaim each HTF's equilibrium
const VIOLATORS = { D: ["6H", "4H", "1H"], "3D": ["6H", "4H", "1H"], W: ["3D", "D", "6H", "4H"], M: ["W", "3D", "D"] };
const OPP = { bullish: "bearish", bearish: "bullish" };

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
      if (event === "eq_cross") return handleEqCross(env, body, asset);
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

// ── Bias state helpers ─────────────────────────────────────────────────────
// derive(): fills eq / state / eff_bias from the raw fields
function derive(t) {
  if (t.bias === "neutral" || t.high == null || t.low == null) {
    t.eq = null; t.state = "none"; t.eff_bias = "neutral"; t.violation = null; t.eq_tested = null;
    return t;
  }
  t.eq = (t.high + t.low) / 2;
  if (t.intact === false) { t.state = "failed"; t.eff_bias = "neutral"; }
  else if (t.violation) { t.state = "violated"; t.eff_bias = OPP[t.bias]; }
  else { t.state = "intact"; t.eff_bias = t.bias; }
  return t;
}

const closedThrough = (dir, close, eq) => (dir === "bearish" ? close < eq : close > eq);

/**
 * An EBP (intraday or HTF) just confirmed on `ebpTf` with direction `dir` and close `close`.
 * Flip or reclaim any higher-timeframe EBPs whose EQ it closed through. Returns the changes.
 */
function applyEbp(a, ebpTf, dir, close, sweep, ref, at) {
  const changes = [];
  if (!a || close == null) return changes;
  for (const htfTf of HTFS) {
    if (!(VIOLATORS[htfTf] || []).includes(ebpTf)) continue;
    const t = derive(a.timeframes[htfTf]);
    if (t.state === "none" || t.state === "failed") continue;
    if (t.state === "intact" && dir === OPP[t.bias] && closedThrough(dir, close, t.eq)) {
      t.violation = { by_tf: ebpTf, by_dir: dir, close, sweep, ref, at };
      t.eq_tested = null;
      derive(t);
      changes.push({ type: "violation", htfTf, t });
    } else if (t.state === "violated" && dir === t.bias && closedThrough(dir, close, t.eq)) {
      const old = t.violation;
      t.violation = null;
      t.reclaimed = { by_tf: ebpTf, close, at, was: old };
      derive(t);
      changes.push({ type: "reclaim", htfTf, t, how: "ebp" });
    }
  }
  return changes;
}

function changeMessages(asset, changes) {
  const dec = DECIMALS[asset] ?? 2;
  return changes.map(c => {
    const t = c.t;
    if (c.type === "violation") {
      const v = t.violation;
      return [
        `⚠️ <b>${asset} ${HTF_LABEL[c.htfTf].toLowerCase()} EQ violated</b>`,
        `${TF_LABEL[v.by_tf]} ${v.by_dir} EBP closed ${fmt(v.close, dec)} ${v.by_dir === "bearish" ? "below" : "above"} EQ ${fmt(t.eq, dec)}`,
        `${HTF_LABEL[c.htfTf]} bias → <b>${t.eff_bias.toUpperCase()}</b> (EQ violation) · ${t.eff_bias === "bullish" ? "fails below" : "fails above"} ${fmt(v.sweep, dec)}`,
      ].join("\n");
    }
    const how = c.how === "violator_failed" ? "the violating EBP failed" : `${TF_LABEL[t.reclaimed.by_tf]} ${t.bias} EBP closed back ${t.bias === "bullish" ? "above" : "below"} EQ ${fmt(t.eq, dec)}`;
    return [
      `✅ <b>${asset} ${HTF_LABEL[c.htfTf].toLowerCase()} EQ reclaimed</b>`,
      how,
      `${HTF_LABEL[c.htfTf]} bias back to <b>${t.bias.toUpperCase()}</b> · ${t.bias === "bullish" ? "fails below" : "fails above"} ${fmt(t.sweep, dec)}`,
    ].join("\n");
  });
}

function failLevel(t) {
  return t.state === "violated" ? t.violation.sweep : t.sweep;
}

// ── HTF updates ────────────────────────────────────────────────────────────
async function handleHtf(env, body, asset) {
  const htf = await kvGet(env, "htf", {});
  const prev = htf[asset];
  const tfs = {};
  for (const tf of HTFS) {
    const t = body[tf] || {};
    const n = {
      bias: ["bullish", "bearish"].includes(t.bias) ? t.bias : "neutral",
      open: num(t.open), high: num(t.high), low: num(t.low), close: num(t.close),
      prior_open: num(t.prior_open), prior_high: num(t.prior_high), prior_low: num(t.prior_low),
      sweep: t.bias === "neutral" ? null : num(t.sweep),
      intact: t.bias === "neutral" ? null : t.intact !== false,
      candle_start: t.candle_start || null, candle_end: t.candle_end || null,
      forming_bias: t.forming_bias || "neutral", forming_start: t.forming_start || null,
      violation: null, eq_tested: null, reclaimed: null, failed_at: null,
    };
    // same closed candle as before → keep what happened to it today (failure, EQ violation, EQ test)
    const p = prev && prev.timeframes[tf];
    if (p && p.candle_end === n.candle_end && p.bias === n.bias) {
      if (p.intact === false) { n.intact = false; n.failed_at = p.failed_at || null; }
      n.violation = p.violation || null;
      n.eq_tested = p.eq_tested || null;
      n.reclaimed = p.reclaimed || null;
    }
    tfs[tf] = derive(n);
  }
  htf[asset] = {
    asset, name: ASSET_NAMES[asset], trade_date: body.trade_date || null, reason: body.reason || "close",
    price: num(body.price), bar_time: isoFromMs(body.bar_time), as_of: isoFromMs(body.as_of),
    received_at: new Date().toISOString(), timeframes: tfs,
  };

  // A newly closed HTF candle can itself violate / reclaim a higher timeframe's EQ (D → W/M, W → M …)
  let changes = [];
  if (body.reason === "close") {
    for (const tf of ["D", "3D", "W"]) {
      const n = tfs[tf], p = prev && prev.timeframes[tf];
      const isNew = !p || p.candle_end !== n.candle_end;
      if (isNew && n.bias !== "neutral") changes = changes.concat(applyEbp(htf[asset], tf, n.bias, n.close, n.sweep, n.candle_end, new Date().toISOString()));
    }
  }
  await kvPut(env, "htf", htf);

  let telegram = "none";
  if (changes.length) {
    for (const m of changeMessages(asset, changes)) await sendTelegram(env, m);
    telegram = `${changes.length} EQ change(s) sent`;
  }
  if (body.reason === "close") {
    const sent = await maybeSendSummary(env, false);
    telegram += sent ? " · summary sent" : " · waiting for other assets";
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
  const t = derive(a.timeframes[tf]);
  if (t.state === "none" || t.state === "failed") return json({ ok: true, ignored: "nothing to fail" });
  const wasViolated = t.state === "violated";
  t.intact = false;
  t.failed_at = isoFromMs(body.failed_at) || new Date().toISOString();
  derive(t);
  await kvPut(env, "htf", htf);
  const dec = DECIMALS[asset] ?? 2;
  const text = wasViolated
    ? `⚪ <b>${asset} ${HTF_LABEL[tf].toLowerCase()} ${t.bias} EBP's sweep level taken</b>\nPrice traded through ${fmt(t.sweep, dec)} at ${nyTime(t.failed_at)} NY (the EQ-violation bias played out). Structure now spent until the next ${HTF_LABEL[tf].toLowerCase()} close.`
    : `⚪ <b>${asset} ${HTF_LABEL[tf].toLowerCase()} ${t.bias} EBP failed</b>\nPrice traded through ${fmt(t.sweep, dec)} at ${nyTime(t.failed_at)} NY`;
  const sent = await sendTelegram(env, text);
  return json({ ok: true, asset, tf, event: "htf_fail", telegram: sent ? "sent" : "failed" });
}

// Early warning: an intraday candle closed through the daily EBP's EQ without an EBP
async function handleEqCross(env, body, asset) {
  const htf = await kvGet(env, "htf", {});
  const a = htf[asset];
  const t = a && derive(a.timeframes.D);
  if (!t || t.state === "none" || t.state === "failed") return json({ ok: true, ignored: "no daily EBP" });
  const side = body.side === "below" ? "below" : "above";
  const close = num(body.close);
  const against = (t.bias === "bullish" && side === "below") || (t.bias === "bearish" && side === "above");
  let telegram = "none";
  if (t.state === "intact" && against && !t.eq_tested) {
    t.eq_tested = { by_tf: String(body.tf || "").toUpperCase(), close, at: new Date().toISOString() };
    const dec = DECIMALS[asset] ?? 2;
    telegram = (await sendTelegram(env, `👀 <b>${asset} daily EQ tested</b>\n${t.eq_tested.by_tf} closed ${fmt(close, dec)} ${side} EQ ${fmt(t.eq, dec)} with no EBP yet · daily ${t.bias} still intact`)) ? "sent" : "failed";
  } else if (t.state === "intact" && !against && t.eq_tested) {
    t.eq_tested = null; // back on the right side
  }
  await kvPut(env, "htf", htf);
  return json({ ok: true, asset, event: "eq_cross", telegram });
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
  lines.push(legendLine());
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

function legendLine() { return "<i>(M · W · 3D · D · 🔺🔻 = bias by EQ violation · ✖ = failed)</i>"; }

function dotFor(t) {
  derive(t);
  if (t.state === "failed") return "✖";
  if (t.state === "violated") return DOT_EQ[t.eff_bias];
  return DOT[t.eff_bias];
}

function describe(a) {
  const dots = [];
  let bull = 0, bear = 0;
  for (const tf of HTFS) {
    const t = derive(a.timeframes[tf]);
    dots.push(dotFor(t));
    if (t.state === "intact" || t.state === "violated") { bull += t.eff_bias === "bullish"; bear += t.eff_bias === "bearish"; }
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
      const t = derive(a.timeframes[tf]);
      out[k].timeframes[tf] = { bias: t.bias, eff_bias: t.eff_bias, state: t.state, candle_end: t.candle_end };
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
      const ct = derive(c.timeframes[tf]);
      const pt = p && p.timeframes[tf] ? derive({ ...p.timeframes[tf] }) : null;
      const pe = pt ? pt.eff_bias : "neutral", ps = pt ? pt.state : "none";
      const label = `${k} ${HTF_LABEL[tf].toLowerCase()}`;
      if (ct.eff_bias !== pe) out.push(`${label} ${pe} → ${ct.eff_bias}${ct.state === "violated" ? " (EQ)" : ""}`);
      else if (ct.state === "failed" && ps !== "failed" && ct.bias !== "neutral") out.push(`${label} ${ct.bias} EBP failed`);
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

  const now = new Date().toISOString();
  const sig = {
    asset, tf, dir, close: num(body.close), sweep: num(body.sweep), prior_open: num(body.prior_open),
    candle_open: isoFromMs(body.candle_open), candle_close: candleClose,
    received_at: now, failed: false, failed_at: null, qualified_by: [], notified: false, flips: [], reclaims: [],
  };

  // 1) does this EBP violate or reclaim a higher-timeframe EQ?
  const changes = applyEbp(htf[asset], tf, dir, sig.close, sig.sweep, candleClose, now);
  sig.flips = changes.filter(c => c.type === "violation").map(c => c.htfTf);
  sig.reclaims = changes.filter(c => c.type === "reclaim").map(c => c.htfTf);

  // 2) qualify against the (possibly just flipped) state
  const support = qualifiedBy(htf, asset, dir);
  sig.qualified_by = support;
  let telegram = "unqualified";
  const msgs = changeMessages(asset, changes);
  if (support.length) msgs.push(signalMessage(sig, support, htf[asset]));
  if (msgs.length) {
    const sent = await sendTelegram(env, msgs.join("\n\n"));
    sig.notified = sent && support.length > 0;
    telegram = sent ? (support.length ? "sent" : "EQ change sent") : "failed";
  }

  latest[asset][tf] = sig;
  recent.unshift({ event: "signal", ...sig });
  while (recent.length > RECENT_MAX) recent.pop();
  await Promise.all([kvPut(env, "latest", latest), kvPut(env, "recent", recent), kvPut(env, "htf", htf)]);
  return json({ ok: true, asset, tf, event: "signal", telegram, flips: sig.flips, reclaims: sig.reclaims });
}

async function handleFail(env, body, asset) {
  const tf = String(body.tf || "").toUpperCase();
  if (!ITFS.includes(tf)) return json({ error: `unknown tf ${tf}` }, 400);
  const [latest, recent, htf] = await Promise.all([kvGet(env, "latest", {}), kvGet(env, "recent", []), kvGet(env, "htf", {})]);
  const cur = latest[asset] && latest[asset][tf];
  if (!cur || cur.failed || (body.candle_close && cur.candle_close !== isoFromMs(body.candle_close))) {
    return json({ ok: true, asset, tf, ignored: "no matching open signal" });
  }
  const now = new Date().toISOString();
  cur.failed = true;
  cur.failed_at = isoFromMs(body.failed_at) || now;

  // if this signal was the violator of an HTF EQ, its failure hands the bias back
  const changes = [];
  const a = htf[asset];
  if (a) for (const htfTf of HTFS) {
    const t = derive(a.timeframes[htfTf]);
    if (t.state === "violated" && t.violation.by_tf === tf && t.violation.ref === cur.candle_close) {
      t.reclaimed = { by_tf: tf, close: null, at: now, was: t.violation };
      t.violation = null;
      derive(t);
      changes.push({ type: "reclaim", htfTf, t, how: "violator_failed" });
    }
  }

  const msgs = changeMessages(asset, changes);
  if (cur.notified) msgs.unshift(failMessage(cur));
  let telegram = "none";
  if (msgs.length) telegram = (await sendTelegram(env, msgs.join("\n\n"))) ? "sent" : "failed";
  recent.unshift({ event: "fail", asset, tf, dir: cur.dir, sweep: cur.sweep, candle_close: cur.candle_close, received_at: now });
  while (recent.length > RECENT_MAX) recent.pop();
  await Promise.all([kvPut(env, "latest", latest), kvPut(env, "recent", recent), kvPut(env, "htf", htf)]);
  return json({ ok: true, asset, tf, event: "fail", telegram });
}

function qualifiedBy(htf, asset, dir) {
  const a = htf[asset];
  if (!a) return [];
  return HTFS.filter(tf => { const t = derive(a.timeframes[tf]); return (t.state === "intact" || t.state === "violated") && t.eff_bias === dir; });
}

function supportLabel(a, tfs) {
  return tfs.map(tf => HTF_LABEL[tf] + (a && a.timeframes[tf].state === "violated" ? " (EQ)" : "")).join(", ");
}

// ── Telegram bot commands ──────────────────────────────────────────────────
async function handleTelegramUpdate(request, env) {
  if (!env.SIGNAL_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.SIGNAL_SECRET) return json({ ok: false }, 401);
  let update;
  try { update = await request.json(); } catch { return json({ ok: true }); }
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return json({ ok: true });
  if (String(msg.chat.id) !== String(env.TELEGRAM_CHAT_ID || "").trim()) return json({ ok: true });

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
  lines.push(legendLine());
  return lines.join("\n");
}

function signalsText(htf, latest) {
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
        `${s.failed ? "✖" : DOT[s.dir]} <b>${k} ${tf}</b> ${s.dir} · ${ago(s.candle_close)} · ${s.failed ? "failed at" : s.dir === "bullish" ? "fails below" : "fails above"} ${fmt(s.sweep, dec)} · by ${supportLabel(htf[k], q)}${s.flips && s.flips.length ? " · ⚠️ flipped " + s.flips.map(x => HTF_LABEL[x].toLowerCase()).join("/") : ""}` });
    }
  }
  rows.sort((a, b) => (a.t < b.t ? 1 : -1));
  const lines = ["⚡ <b>Qualified intraday signals</b>"];
  if (!rows.length) lines.push("None at the moment.");
  else lines.push(...rows.map(r => r.text));
  lines.push("<i>✖ = sweep level has since been traded through · (EQ) = support comes from an EQ-flipped bias</i>");
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
      const t = derive(a.timeframes[tf]);
      let txt = `${dotFor(t)} <b>${HTF_LABEL[tf]}</b> `;
      if (t.state === "none") txt += "neutral";
      else if (t.state === "failed") txt += `${t.bias} · failed at ${fmt(t.sweep, dec)}`;
      else if (t.state === "violated") txt += `${t.eff_bias} (EQ violation of ${t.bias} EBP by ${TF_LABEL[t.violation.by_tf]}) · fails ${t.eff_bias === "bullish" ? "below" : "above"} ${fmt(t.violation.sweep, dec)} · EQ ${fmt(t.eq, dec)}`;
      else txt += `${t.bias} · fails ${t.bias === "bullish" ? "below" : "above"} ${fmt(t.sweep, dec)} · EQ ${fmt(t.eq, dec)}${t.eq_tested ? " · 👀 EQ tested by " + t.eq_tested.by_tf : ""}`;
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
    parts.push(`${s.failed ? "✖" : DOT[s.dir]} <b>${tf}</b> ${s.dir} ${ago(s.candle_close)} · ${s.failed ? "failed at" : s.dir === "bullish" ? "fails below" : "fails above"} ${fmt(s.sweep, dec)} · ${q.length ? "qualified (" + supportLabel(a, q) + ")" : "unqualified"}${s.flips && s.flips.length ? " · ⚠️ flipped " + s.flips.map(x => HTF_LABEL[x].toLowerCase()).join("/") : ""}`);
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
  const diag = { has_bot_token: Boolean(env.TELEGRAM_BOT_TOKEN), has_chat_id: Boolean(env.TELEGRAM_CHAT_ID) };
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

function signalMessage(sig, support, a) {
  const dec = DECIMALS[sig.asset] ?? 2;
  const icon = sig.dir === "bullish" ? "🟢" : "🔴";
  const failWord = sig.dir === "bullish" ? "fails below" : "fails above";
  return [
    `${icon} <b>${sig.asset} ${sig.tf} ${sig.dir.toUpperCase()} EBP</b>`,
    `Qualified by: ${supportLabel(a, support)}`,
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

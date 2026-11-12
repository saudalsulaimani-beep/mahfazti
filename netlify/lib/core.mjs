// أدوات مشتركة لدوال Netlify: الأسعار من Yahoo، التخزين، والإشعارات
import { getStore } from '@netlify/blobs';
import * as webpush from 'web-push';

export const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
export const APP_URL = "https://saudalsulaimani-beep.github.io/mahfazti/";
const LIVE_RAW = 'https://raw.githubusercontent.com/saudalsulaimani-beep/mahfazti/live/live.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
export const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra } });
export const preflight = () => new Response(null, { status: 204, headers: CORS });

export const store = () => getStore({ name: 'mahfazti', consistency: 'strong' });

// رمز تداول ← رمز Yahoo
export const ysym = (code) => (code === 'TASI' ? '^TASI.SR' : `${code}.SR`);
export const validCode = (c) => c === 'TASI' || /^\d{4}$/.test(c);

export const riyadh = (ms = Date.now()) => {
  const d = new Date(ms + 3 * 3600e3);
  return { dow: d.getUTCDay(), hm: d.getUTCHours() * 100 + d.getUTCMinutes(), day: d.toISOString().slice(0, 10) };
};

export async function yChart(code, range = '1d', interval = '5m') {
  const q = `range=${range}&interval=${interval}&includePrePost=false`;
  for (const host of ['query1', 'query2']) {
    for (let a = 0; a < 2; a++) {
      try {
        const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ysym(code))}?${q}`,
          { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
        if (r.status === 429 || r.status >= 500) { await sleep(500 * (a + 1)); continue; }
        if (!r.ok) break;
        const res = (await r.json())?.chart?.result?.[0];
        if (res?.meta) return res;
        break;
      } catch { await sleep(300); }
    }
  }
  return null;
}

// آخر سعر لكل رمز: Yahoo أولاً، ولو فشل نرجع لملف الأسعار الحية في GitHub
export async function quotes(codes) {
  const out = {}; const list = [...new Set(codes)].filter(validCode).slice(0, 60);
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const code = list[i++];
      const r = await yChart(code, '1d', '5m');
      const m = r?.meta;
      if (m?.regularMarketPrice != null) {
        out[code] = { p: m.regularMarketPrice, pc: m.chartPreviousClose ?? m.previousClose ?? null,
          dh: m.regularMarketDayHigh ?? null, dl: m.regularMarketDayLow ?? null, v: m.regularMarketVolume ?? null, t: m.regularMarketTime ?? null };
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  const missing = list.filter((c) => !out[c]);
  if (missing.length) {
    try {
      const L = await (await fetch(LIVE_RAW + '?x=' + Date.now(), { signal: AbortSignal.timeout(5000) })).json();
      for (const c of missing) {
        const a = L?.q?.[c]; if (!a) continue;
        out[c] = { p: a[0], pc: a[1], dh: a[2], dl: a[3], v: a[4], t: a[5], src: 'gh' };
      }
    } catch { /* نكمل بالموجود */ }
  }
  return out;
}

// مفاتيح الإشعارات (VAPID): تنصنع تلقائياً أول مرة وتنحفظ في التخزين الخاص
export async function vapid() {
  const s = store();
  let k = await s.get('cfg/vapid', { type: 'json' });
  if (!k?.publicKey) { k = webpush.generateVAPIDKeys(); await s.setJSON('cfg/vapid', k); }
  return k;
}

// قابل للاستبدال في الاختبار
export const _t = { send: (...a) => webpush.sendNotification(...a) };

export async function push(sub, payload) {
  const k = await vapid();
  try {
    await _t.send(sub, JSON.stringify(payload), { TTL: 3600, urgency: 'high',
      vapidDetails: { subject: APP_URL, publicKey: k.publicKey, privateKey: k.privateKey } });
    return 'ok';
  } catch (e) {
    return e?.statusCode === 404 || e?.statusCode === 410 ? 'gone' : 'fail:' + (e?.statusCode || e?.message);
  }
}

export const fmt = (n) => (n == null ? '—' : Number(n).toFixed(2));

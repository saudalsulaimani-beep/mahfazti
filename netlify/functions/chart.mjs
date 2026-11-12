// رسم السهم خلال اليوم (كل ٥ دقائق) أو آخر ٥ أيام (كل ساعة) — Yahoo ما يسمح للمتصفح يطلبه مباشرة
import { yChart, json, preflight, validCode } from '../lib/core.mjs';

const RANGES = { '1d': ['1d', '5m'], '5d': ['5d', '60m'], '1mo': ['1mo', '1d'] };

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  const u = new URL(req.url);
  const code = u.searchParams.get('code') || '';
  const r = RANGES[u.searchParams.get('r')] ? u.searchParams.get('r') : '1d';
  if (!validCode(code)) return json({ error: 'code' }, 400);
  const res = await yChart(code, ...RANGES[r]);
  if (!res) return json({ error: 'source' }, 502);
  const ts = res.timestamp || [], q = res.indicators?.quote?.[0] || {};
  const t = [], c = [];
  for (let i = 0; i < ts.length; i++) if (q.close?.[i] != null) { t.push(ts[i]); c.push(+q.close[i].toFixed(3)); }
  const m = res.meta || {};
  return json({ code, r, t, c, p: m.regularMarketPrice ?? null, pc: m.chartPreviousClose ?? m.previousClose ?? null, at: m.regularMarketTime ?? null },
    200, { 'Cache-Control': 'public, max-age=60' });
};
export const config = { path: '/api/chart' };

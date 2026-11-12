// يحفظ تنبيهاتك واشتراك الإشعارات، ويرجع حالة التنبيهات (اللي انطلقت)
import { store, vapid, push, json, preflight, validCode } from '../lib/core.mjs';

const okId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(id);
const clean = (a) => ({
  id: String(a.id || '').slice(0, 20), code: String(a.code || ''), op: a.op === '<=' ? '<=' : '>=',
  price: +a.price, act: ['buy', 'sell', 'note'].includes(a.act) ? a.act : 'note',
  note: String(a.note || '').slice(0, 120), on: a.on !== false, rev: +a.rev || 0,
});

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  const u = new URL(req.url);
  if (u.searchParams.has('vapid')) return json({ key: (await vapid()).publicKey });
  const s = store();

  if (req.method === 'GET') {
    const id = u.searchParams.get('id');
    if (!okId(id)) return json({ error: 'id' }, 400);
    const d = await s.get('u/' + id, { type: 'json' });
    return json({ alerts: d?.alerts || [], push: !!d?.sub, log: (d?.log || []).slice(-20) });
  }

  let b; try { b = await req.json(); } catch { return json({ error: 'body' }, 400); }
  if (!okId(b.id)) return json({ error: 'id' }, 400);
  const key = 'u/' + b.id;
  const old = (await s.get(key, { type: 'json' })) || {};
  const prev = Object.fromEntries((old.alerts || []).map((a) => [a.id, a]));
  const alerts = (Array.isArray(b.alerts) ? b.alerts : []).slice(0, 80).map(clean)
    .filter((a) => a.id && validCode(a.code) && a.price > 0)
    .map((a) => {
      const p = prev[a.id];
      // نفس النسخة؟ نحتفظ بحالة «انطلق» اللي عند السيرفر
      return p && p.rev === a.rev && p.firedAt ? { ...a, firedAt: p.firedAt, firedP: p.firedP } : a;
    });
  const d = {
    ...old, alerts,
    sub: b.sub === null ? null : (b.sub?.endpoint ? b.sub : old.sub || null),
    move: Math.max(0, Math.min(20, +b.move || 0)),
    hold: (Array.isArray(b.hold) ? b.hold : []).slice(0, 40).filter((h) => validCode(h.code)).map((h) => ({ code: h.code, n: String(h.n || '').slice(0, 40) })),
    names: Object.fromEntries(Object.entries(b.names || {}).slice(0, 120).map(([k, v]) => [k, String(v).slice(0, 40)])),
    at: new Date().toISOString(),
  };
  await s.setJSON(key, d);
  let test = null;
  if (b.test && d.sub) {
    test = await push(d.sub, { title: 'محفظتي 1 🔔', body: 'تمام! الإشعارات شغالة، وبتجيك هنا لما يوصل أي سهم للسعر اللي حددته.', tag: 'test' });
    if (test === 'gone') { d.sub = null; await s.setJSON(key, d); }
  }
  return json({ alerts: d.alerts, push: !!d.sub, test });
};
export const config = { path: '/api/sync' };

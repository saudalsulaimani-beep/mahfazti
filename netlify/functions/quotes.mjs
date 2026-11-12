// أسعار حية لأسهم محددة (التطبيق يطلبها كل ٣٠ ثانية وقت السوق)
import { quotes, json, preflight } from '../lib/core.mjs';

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  const codes = (new URL(req.url).searchParams.get('codes') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!codes.length) return json({ q: {} });
  const q = await quotes(codes);
  return json({ t: new Date().toISOString(), q }, 200, { 'Cache-Control': 'public, max-age=20' });
};
export const config = { path: '/api/quotes' };

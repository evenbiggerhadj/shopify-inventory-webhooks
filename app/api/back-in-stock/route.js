import { kv } from '@vercel/kv';

export async function POST(req) {
  const { email, product_id } = await req.json();
  const key = `subscribers:${product_id}`;
  let subscribers = (await kv.get(key)) || [];
  subscribers.push({ email, notified: false });
  await kv.set(key, subscribers);
  return Response.json({ success: true });
}

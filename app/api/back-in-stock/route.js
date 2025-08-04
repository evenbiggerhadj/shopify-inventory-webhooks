import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export async function POST(req) {
  const { email, product_id } = await req.json();
  if (!email || !product_id) {
    return Response.json({ success: false, error: 'Missing email or product_id' }, { status: 400 });
  }
  const key = `subscribers:${product_id}`;
  let subscribers = (await redis.get(key)) || [];
  // Prevent duplicate
  if (!subscribers.some(sub => sub.email === email)) {
    subscribers.push({ email, notified: false });
    await redis.set(key, subscribers);
  }
  return Response.json({ success: true });
}

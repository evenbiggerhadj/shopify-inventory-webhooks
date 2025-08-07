// app/api/back-in-stock/route.js
// Shopify Back-in-Stock + SMS Subscription Handler (Fully Featured)

import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

/* ========== ENVIRONMENT VARIABLES & REDIS SETUP ========== */
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
  retry: { retries: 3, retryDelayOnFailover: 100 }
});
const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;

/* ========== CORS PRE-FLIGHT ========== */
export async function OPTIONS(request) {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

/* ========== POST: SUBSCRIBE TO BACK-IN-STOCK ========== */
export async function POST(request) {
  try {
    const body = await request.json();
    const {
      email,
      phone,
      product_id,
      product_title,
      product_handle,
      first_name,
      last_name
    } = body;

    // 1. Validation: Required fields
    if (!email || !product_id) {
      return jsonError(
        'Missing required fields: email and product_id', 400,
        { email: !!email, product_id: !!product_id }
      );
    }

    // 2. Email format
    if (!isValidEmail(email)) {
      return jsonError('Invalid email format', 400, { email });
    }

    // 3. Phone number (optional, validate if present)
    let phoneNormalized = '';
    if (phone && phone.trim() !== '') {
      if (!isValidPhone(phone)) {
        return jsonError('Invalid phone format. Use +15555555555.', 400, { phone });
      }
      phoneNormalized = phone.trim();
    }

    // 4. Redis connection check
    try {
      await redis.ping();
    } catch (err) {
      return jsonError('Database connection failed', 500, { details: err.message });
    }

    // 5. Find all current subscribers for this product
    const key = `subscribers:${product_id}`;
    let subscribers = await safeGetRedisArray(key);

    // 6. Prevent duplicate (same email for this product)
    const existing = subscribers.find(sub => sub && sub.email === email);
    if (existing) {
      return NextResponse.json({
        success: true,
        message: 'You are already subscribed to notifications for this product',
        alreadySubscribed: true,
        subscriber_count: subscribers.length
      }, { headers: { 'Access-Control-Allow-Origin': '*' } });
    }

    // 7. Build new subscriber object (including phone)
    const newSubscriber = {
      email,
      phone: phoneNormalized,
      product_id: product_id.toString(),
      product_title: product_title || 'Unknown Product',
      product_handle: product_handle || '',
      first_name: first_name || '',
      last_name: last_name || '',
      notified: false,
      subscribed_at: new Date().toISOString(),
      ip_address: getClientIp(request)
    };
    subscribers.push(newSubscriber);

    // 8. Save to Redis
    try {
      await redis.set(key, subscribers, { ex: 30 * 24 * 60 * 60 }); // 30 days
    } catch (err) {
      return jsonError('Failed to save subscription. Please try again.', 500, { details: err.message });
    }

    // 9. Klaviyo confirmation event (non-blocking)
    try {
      await sendKlaviyoSubscribeEvent(newSubscriber);
    } catch (klaviyoErr) {
      // Log only
      console.error('Klaviyo subscribe event error:', klaviyoErr.message);
    }

    // 10. Return success
    return NextResponse.json({
      success: true,
      message: 'Successfully subscribed to back-in-stock notifications',
      subscriber_count: subscribers.length
    }, { headers: { 'Access-Control-Allow-Origin': '*' } });

  } catch (error) {
    return jsonError('Server error. Please try again.', 500, { details: error.message });
  }
}

/* ========== GET: CHECK SUBSCRIPTION STATUS ========== */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const email = searchParams.get('email');
    const product_id = searchParams.get('product_id');

    if (!email || !product_id) {
      return jsonError('Missing email or product_id parameters', 400);
    }
    await redis.ping();
    const key = `subscribers:${product_id}`;
    let subscribers = await safeGetRedisArray(key);

    const subscription = subscribers.find(sub => sub && sub.email === email);
    const isSubscribed = !!subscription;

    return NextResponse.json({
      success: true,
      subscribed: isSubscribed,
      total_subscribers: subscribers.length,
      subscription_details: subscription ? {
        subscribed_at: subscription.subscribed_at,
        notified: subscription.notified,
        phone: subscription.phone
      } : null
    }, { headers: { 'Access-Control-Allow-Origin': '*' } });

  } catch (error) {
    return jsonError('Server error.', 500, { details: error.message });
  }
}

/* ========== HELPERS ========== */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function isValidPhone(phone) {
  // E.164: +, no spaces, min 8, max 15 digits
  return /^\+?[1-9]\d{7,14}$/.test(phone.trim());
}
function getClientIp(request) {
  return request.headers.get('x-forwarded-for') ||
    request.headers.get('x-real-ip') ||
    'unknown';
}
async function safeGetRedisArray(key) {
  let val = await redis.get(key);
  if (!val) return [];
  if (typeof val === 'string') {
    try { val = JSON.parse(val); } catch { val = []; }
  }
  if (!Array.isArray(val)) return [];
  return val;
}
function jsonError(msg, status = 500, details = {}) {
  return NextResponse.json(
    { success: false, error: msg, ...details },
    { status, headers: { 'Access-Control-Allow-Origin': '*' } }
  );
}

/* ========== KLAVIYO EVENT SENDER ========== */
async function sendKlaviyoSubscribeEvent(subscriber) {
  if (!KLAVIYO_API_KEY) return;
  let profileAttrs = { email: subscriber.email };
  if (subscriber.phone) profileAttrs.phone_number = subscriber.phone;
  if (subscriber.first_name) profileAttrs.first_name = subscriber.first_name;
  if (subscriber.last_name) profileAttrs.last_name = subscriber.last_name;

  const eventData = {
    data: {
      type: 'event',
      attributes: {
        properties: {
          ProductName: subscriber.product_title,
          ProductID: subscriber.product_id,
          ProductHandle: subscriber.product_handle,
          SubscriptionDate: subscriber.subscribed_at,
          NotificationType: 'Subscription Confirmation'
        },
        metric: {
          data: { type: 'metric', attributes: { name: 'Back in Stock Subscription' } }
        },
        profile: {
          data: { type: 'profile', attributes: profileAttrs }
        }
      }
    }
  };
  const resp = await fetch('https://a.klaviyo.com/api/events/', {
    method: 'POST',
    headers: {
      'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      'Content-Type': 'application/json',
      'revision': '2024-10-15'
    },
    body: JSON.stringify(eventData)
  });
  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`Klaviyo API error: ${resp.status} ${errorText}`);
  }
}

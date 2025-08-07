// app/api/back-in-stock/route.js
// Shopify Back-in-Stock + SMS Subscription Handler (Klaviyo SMS Consent Compliant)

import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

// --- ENV VARS ---
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
  retry: { retries: 3, retryDelayOnFailover: 100 }
});
const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;

// --- CORS PRE-FLIGHT ---
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

// --- POST: SUBSCRIBE TO BACK-IN-STOCK ---
export async function POST(request) {
  try {
    const body = await request.json();
    const {
      email,
      phone,
      sms_consent, // <-- from form checkbox
      product_id,
      product_title,
      product_handle,
      first_name,
      last_name
    } = body;

    // 1. Validation: require email or phone (one must be present)
    if ((!email && !phone) || !product_id) {
      return jsonError(
        'Provide at least one contact (email or phone) and product_id', 400
      );
    }

    if (email && !isValidEmail(email)) {
      return jsonError('Invalid email format', 400, { email });
    }
    let phoneNormalized = '';
    if (phone && phone.trim() !== '') {
      if (!isValidPhone(phone)) {
        return jsonError('Invalid phone format. Use +15555555555.', 400, { phone });
      }
      phoneNormalized = phone.trim();
    }
    // At least one valid contact method required
    if (!email && !phoneNormalized) {
      return jsonError('Provide either a valid email or phone number.', 400);
    }

    // Redis connection check
    await redis.ping();

    // Find all current subscribers for this product
    const key = `subscribers:${product_id}`;
    let subscribers = await safeGetRedisArray(key);

    // Prevent duplicate (same email or phone for this product)
    const existing = subscribers.find(sub =>
      (email && sub.email === email) ||
      (phoneNormalized && sub.phone === phoneNormalized)
    );
    if (existing) {
      return NextResponse.json({
        success: true,
        message: 'You are already subscribed to notifications for this product',
        alreadySubscribed: true,
        subscriber_count: subscribers.length
      }, { headers: { 'Access-Control-Allow-Origin': '*' } });
    }

    const newSubscriber = {
      email: email || "",
      phone: phoneNormalized || "",
      sms_consent: !!sms_consent,
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

    await redis.set(key, subscribers, { ex: 30 * 24 * 60 * 60 }); // 30 days

    // --- 1. Update Klaviyo profile for SMS consent if provided ---
    if (phoneNormalized && sms_consent === true) {
      await updateKlaviyoProfileWithConsent({
        email,
        phone: phoneNormalized,
        sms_consent: true
      });
    }

    // --- 2. Send Klaviyo event (phone only if consented) ---
    await sendKlaviyoSubscribeEvent({
      ...newSubscriber,
      phone: (sms_consent === true ? phoneNormalized : null)
    });

    return NextResponse.json({
      success: true,
      message: 'Successfully subscribed to back-in-stock notifications',
      subscriber_count: subscribers.length
    }, { headers: { 'Access-Control-Allow-Origin': '*' } });
  } catch (error) {
    return jsonError('Server error. Please try again.', 500, { details: error.message });
  }
}

// --- GET: CHECK SUBSCRIPTION STATUS ---
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const email = searchParams.get('email');
    const phone = searchParams.get('phone');
    const product_id = searchParams.get('product_id');
    if ((!email && !phone) || !product_id) {
      return jsonError('Missing email or phone or product_id parameters', 400);
    }
    await redis.ping();
    const key = `subscribers:${product_id}`;
    let subscribers = await safeGetRedisArray(key);

    const subscription = subscribers.find(sub =>
      (email && sub.email === email) ||
      (phone && sub.phone === phone)
    );
    const isSubscribed = !!subscription;

    return NextResponse.json({
      success: true,
      subscribed: isSubscribed,
      total_subscribers: subscribers.length,
      subscription_details: subscription ? {
        subscribed_at: subscription.subscribed_at,
        notified: subscription.notified,
        phone: subscription.phone,
        sms_consent: !!subscription.sms_consent,
        email: subscription.email
      } : null
    }, { headers: { 'Access-Control-Allow-Origin': '*' } });

  } catch (error) {
    return jsonError('Server error.', 500, { details: error.message });
  }
}

// --- HELPERS ---
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

// --- KLAVIYO PROFILE CONSENT UPDATER ---
async function updateKlaviyoProfileWithConsent({ email, phone, sms_consent }) {
  if (!KLAVIYO_API_KEY || !phone || !sms_consent) return;
  const consentTimestamp = new Date().toISOString();
  const body = {
    data: {
      type: "profile",
      attributes: {
        ...(phone ? { phone_number: phone } : {}),
        ...(email ? { email: email } : {}),
        subscriptions: {
          sms: {
            marketing: {
              consent: true,
              timestamp: consentTimestamp
            }
          }
        }
      }
    }
  };
  const resp = await fetch('https://a.klaviyo.com/api/profiles/', {
    method: 'POST',
    headers: {
      'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      'Content-Type': 'application/json',
      'revision': '2024-10-15'
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`Klaviyo Profile API error: ${resp.status} ${errorText}`);
  }
}

// --- KLAVIYO EVENT SENDER ---
async function sendKlaviyoSubscribeEvent(subscriber) {
  if (!KLAVIYO_API_KEY) return;
  let profileAttrs = {};
  if (subscriber.email) profileAttrs.email = subscriber.email;
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

// app/api/back-in-stock/route.js
// Production-ready endpoint for Back-in-Stock subscriptions.
// - Strict CORS (OPTIONS/POST/GET + all error paths)
// - Validates payload (email, optional E.164 phone, consent gate)
// - Stores subscriber in Upstash Redis
// - Subscribes to Klaviyo List (v2 /list/{LIST_ID}/subscribe) with SMS consent
// - Returns explicit errors so the storefront can show real messages

import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

// ====== ENV ======
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
const KLAVIYO_LIST_ID = process.env.KLAVIYO_LIST_ID || process.env.KLAVIYO_BACK_IN_STOCK_LIST_ID || 'REPLACE_ME';

// ====== Redis ======
const redis = new Redis({
  url: KV_URL,
  token: KV_TOKEN,
  retry: { retries: 3, retryDelayOnFailover: 100 }
});

// ====== CORS ======
const ALLOWED_ORIGINS = [
  'https://armadillotough.com',
  'https://www.armadillotough.com',
  'https://armadillotough.myshopify.com',
  'http://localhost:3000'
];

function pickOrigin(req) {
  const o = req.headers.get('origin');
  if (!o) return '*'; // server-to-server or curl
  return ALLOWED_ORIGINS.includes(o) ? o : 'https://armadillotough.com';
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function withCORS(resp, origin) {
  const h = corsHeaders(origin);
  Object.entries(h).forEach(([k, v]) => resp.headers.set(k, v));
  return resp;
}

// ====== Helpers ======
function json(body, status = 200) {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function isEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
}

// Strict E.164 formatter (accepts several common NG/US inputs and normalizes)
function toE164(raw) {
  if (!raw) return null;
  let v = String(raw).trim();
  // strip spaces, dashes, parentheses
  v = v.replace(/[^\d+]/g, '');

  // Already E.164?
  if (v.startsWith('+')) return /^\+\d{8,15}$/.test(v) ? v : null;

  // Nigeria: 0XXXXXXXXXX => +234XXXXXXXXXX
  if (/^0\d{10}$/.test(v)) return '+234' + v.slice(1);

  // Nigeria: local 10-digit starting with 70/80/81/90/91
  if (/^(70|80|81|90|91)\d{8}$/.test(v)) return '+234' + v;

  // US 10-digit => +1XXXXXXXXXX
  if (/^\d{10}$/.test(v)) return '+1' + v;

  // Fallback: reject
  return null;
}

async function klaviyoSubscribe({ email, phoneE164, smsConsent }) {
  if (!KLAVIYO_API_KEY || !KLAVIYO_LIST_ID) {
    throw new Error('Klaviyo env missing (KLAVIYO_API_KEY or KLAVIYO_LIST_ID)');
  }

  // Klaviyo v2 list subscribe payload
  const payload = {
    profiles: [
      {
        email,
        ...(smsConsent && phoneE164
          ? { phone_number: phoneE164, sms_consent: true }
          : {})
      }
    ]
  };

  const res = await fetch(`https://a.klaviyo.com/api/v2/list/${KLAVIYO_LIST_ID}/subscribe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Klaviyo subscribe failed: ${res.status} ${res.statusText} :: ${t.slice(0, 800)}`);
  }

  return true;
}

// ====== OPTIONS (preflight) ======
export async function OPTIONS(request) {
  const origin = pickOrigin(request);
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

// ====== POST (subscribe) ======
export async function POST(request) {
  const origin = pickOrigin(request);

  try {
    const body = await request.json().catch(() => null);
    if (!body) {
      return withCORS(json({ success: false, error: 'Invalid JSON body' }, 400), origin);
    }

    const {
      email,
      phone,
      full_name,           // optional
      product_id,
      product_title,       // optional
      product_handle,      // optional
      sms_consent          // boolean
    } = body;

    // Validation
    if (!email || !product_id) {
      return withCORS(json({ success: false, error: 'Missing required fields: email and product_id' }, 400), origin);
    }
    if (!isEmail(email)) {
      return withCORS(json({ success: false, error: 'Invalid email format' }, 400), origin);
    }

    let phoneE164 = null;
    if (phone) {
      phoneE164 = toE164(phone);
      if (!phoneE164) {
        return withCORS(json({ success: false, error: 'Invalid phone number. Use E.164, e.g. +15616023947 or +2348123456789' }, 400), origin);
      }
      if (!sms_consent) {
        return withCORS(json({ success: false, error: 'SMS consent is required when a phone number is provided' }, 400), origin);
      }
    }

    // Redis health
    try {
      await redis.ping();
    } catch (e) {
      console.error('Redis ping failed:', e);
      return withCORS(json({ success: false, error: 'Database unavailable. Try again shortly.' }, 503), origin);
    }

    // Load + dedupe by email
    const key = `subscribers:${String(product_id)}`;
    let subscribers = [];
    try {
      const existing = await redis.get(key);
      if (existing) {
        subscribers = Array.isArray(existing) ? existing : JSON.parse(existing);
        if (!Array.isArray(subscribers)) subscribers = [];
      }
    } catch {
      subscribers = [];
    }

    const already = subscribers.find(s => s && s.email === email);
    if (already) {
      // Update consent/phone if newly provided
      if (phoneE164) {
        already.phone = phoneE164;
        already.sms_consent = !!sms_consent;
      }
      await redis.set(key, subscribers, { ex: 30 * 24 * 60 * 60 });
      return withCORS(json({
        success: true,
        message: 'Already subscribed',
        alreadySubscribed: true,
        subscriber_count: subscribers.length,
        klaviyo_success: false
      }), origin);
    }

    const nowIso = new Date().toISOString();
    const newSub = {
      email,
      phone: phoneE164 || '',
      full_name: full_name || '',
      sms_consent: !!sms_consent,
      product_id: String(product_id),
      product_title: product_title || '',
      product_handle: product_handle || '',
      subscribed_at: nowIso,
      notified: false,
      ip_address: request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown'
    };

    subscribers.push(newSub);
    await redis.set(key, subscribers, { ex: 30 * 24 * 60 * 60 });

   // Non-blocking: subscribe to Klaviyo (but we still report success if it fails)
let klaviyoSuccess = false;
let klaviyoError = null;
try {
  klaviyoSuccess = await klaviyoSubscribe({
    email,
    phoneE164,
    smsConsent: !!sms_consent
  });
} catch (e) {
  klaviyoError = e.message;     // <--- capture the reason
  console.warn('Klaviyo subscribe warning:', klaviyoError);
}

return withCORS(json({
  success: true,
  message: 'Successfully subscribed to back-in-stock notifications',
  subscriber_count: subscribers.length,
  klaviyo_success: !!klaviyoSuccess,
  ...(klaviyoError ? { klaviyo_error: klaviyoError } : {})  // <--- include it
}), origin);


  } catch (error) {
    console.error('POST /back-in-stock fatal:', error);
    return withCORS(json({ success: false, error: 'Server error. Please try again.' }, 500), origin);
  }
}

// ====== GET (check subscription) ======
export async function GET(request) {
  const origin = pickOrigin(request);
  try {
    const { searchParams } = new URL(request.url);
    const email = searchParams.get('email');
    const product_id = searchParams.get('product_id');

    if (!email || !product_id) {
      return withCORS(json({ success: false, error: 'Missing email or product_id' }, 400), origin);
    }

    await redis.ping();

    const key = `subscribers:${String(product_id)}`;
    let subscribers = await redis.get(key);
    subscribers = Array.isArray(subscribers) ? subscribers : (subscribers ? JSON.parse(subscribers) : []);
    if (!Array.isArray(subscribers)) subscribers = [];

    const sub = subscribers.find(s => s && s.email === email);

    return withCORS(json({
      success: true,
      subscribed: !!sub,
      total_subscribers: subscribers.length,
      subscription_details: sub ? {
        subscribed_at: sub.subscribed_at,
        sms_consent: !!sub.sms_consent,
        phone_present: !!sub.phone
      } : null
    }), origin);

  } catch (error) {
    console.error('GET /back-in-stock error:', error);
    return withCORS(json({ success: false, error: 'Server error' }, 500), origin);
  }
}

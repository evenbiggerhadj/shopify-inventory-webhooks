// app/api/back-in-stock/route.js - Production-ready subscription handler with DIRECT LIST ADDITION
// Works with your existing flow. Improvements:
// - Accepts full_name or first/last; records sms_consent
// - Strict phone normalization to E.164 (US/NG shortcuts supported)
// - Klaviyo v2 list/subscribe (with sms_consent) -> fallback to v3 (profile + add-to-list)
// - Surfaces klaviyo_error in response so you can see why it failed
// - CORS headers on ALL paths (OPTIONS/GET/POST + errors)

import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
  retry: { retries: 3, retryDelayOnFailover: 100 }
});

const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
const BACK_IN_STOCK_LIST_ID = process.env.KLAVIYO_BACK_IN_STOCK_LIST_ID || 'WG9GbK';

/* ----------------------- helpers: CORS + JSON ----------------------- */
function json(body, status = 200, origin = '*') {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin
    }
  });
}

function corsHeaders(origin = '*') {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  };
}

function withCORS(resp, origin = '*') {
  const h = corsHeaders(origin);
  Object.entries(h).forEach(([k, v]) => resp.headers.set(k, v));
  return resp;
}

/* ----------------------- helpers: validation ----------------------- */
function isEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
}

// Normalize to E.164 for common US/NG cases; return null if invalid
function toE164(raw) {
  if (!raw) return null;
  let v = String(raw).trim().replace(/[^\d+]/g, '');

  if (v.startsWith('+')) return /^\+\d{8,15}$/.test(v) ? v : null;

  // NG: 0XXXXXXXXXX -> +234XXXXXXXXXX
  if (/^0\d{10}$/.test(v)) return '+234' + v.slice(1);

  // NG: 70/80/81/90/91 + 8 digits -> +234XXXXXXXXXX
  if (/^(70|80|81|90|91)\d{8}$/.test(v)) return '+234' + v;

  // US: 10 digits -> +1XXXXXXXXXX
  if (/^\d{10}$/.test(v)) return '+1' + v;

  return null;
}

function splitFullName(full_name) {
  const s = String(full_name || '').trim();
  if (!s) return { first_name: '', last_name: '' };
  const parts = s.split(/\s+/);
  if (parts.length === 1) return { first_name: parts[0], last_name: '' };
  return { first_name: parts.slice(0, -1).join(' '), last_name: parts.slice(-1).join(' ') };
}

/* ----------------------- CORS preflight ----------------------- */
export async function OPTIONS(request) {
  // If you want to lock this down, replace '*' with your domain
  return new NextResponse(null, { status: 204, headers: corsHeaders('*') });
}

/* ----------------------- POST: subscribe ----------------------- */
export async function POST(request) {
  const origin = request.headers.get('origin') || '*';

  try {
    const body = await request.json();
    const {
      email,
      phone,
      product_id,
      product_title,
      product_handle,
      first_name,     // optional
      last_name,      // optional
      full_name,      // optional (preferred)
      sms_consent     // boolean
    } = body || {};

    console.log('🚀 Processing BIS subscription', {
      email, product_id, has_phone: !!phone, sms_consent: !!sms_consent, ts: new Date().toISOString()
    });

    // Basic validation
    if (!email || !product_id) {
      return json({ success: false, error: 'Missing required fields: email and product_id' }, 400, origin);
    }
    if (!isEmail(email)) {
      return json({ success: false, error: 'Invalid email format' }, 400, origin);
    }

    // Phone + consent
    let phoneE164 = null;
    if (phone) {
      phoneE164 = toE164(phone);
      if (!phoneE164) return json({ success: false, error: 'Invalid phone number. Use E.164, e.g., +15616023947 or +2348123456789' }, 400, origin);
      if (!sms_consent) return json({ success: false, error: 'SMS consent is required when a phone is provided' }, 400, origin);
    }

    // Name handling (prefer full_name if provided)
    let fName = first_name || '';
    let lName = last_name || '';
    if (full_name) {
      const split = splitFullName(full_name);
      fName = split.first_name;
      lName = split.last_name;
    }

    // Redis health
    try {
      await redis.ping();
    } catch (e) {
      console.error('❌ Redis ping failed:', e?.message || e);
      return json({ success: false, error: 'Database connection failed. Please try again.' }, 503, origin);
    }

    // Fetch existing
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

    // Dedupe by email
    const existingSubscriber = subscribers.find((s) => s && s.email === email);
    if (existingSubscriber) {
      // Update phone/consent if newly given
      if (phoneE164) {
        existingSubscriber.phone = phoneE164;
        existingSubscriber.sms_consent = !!sms_consent;
      }
      await redis.set(key, subscribers, { ex: 30 * 24 * 60 * 60 });
      return json({
        success: true,
        message: 'You are already subscribed to notifications for this product',
        alreadySubscribed: true,
        subscriber_count: subscribers.length,
        klaviyo_success: false
      }, 200, origin);
    }

    // New subscriber record (keep your shape)
    const newSubscriber = {
      email,
      phone: phoneE164 || '',
      product_id: String(product_id),
      product_title: product_title || 'Unknown Product',
      product_handle: product_handle || '',
      first_name: fName,
      last_name: lName,
      sms_consent: !!sms_consent,
      notified: false,
      subscribed_at: new Date().toISOString(),
      ip_address: request.headers.get('x-forwarded-for') ||
                  request.headers.get('x-real-ip') || 'unknown'
    };

    subscribers.push(newSubscriber);

    try {
      await redis.set(key, subscribers, { ex: 30 * 24 * 60 * 60 });
      console.log(`✅ Saved ${subscribers.length} subscribers to Redis for product ${product_id}`);
    } catch (e) {
      console.error('❌ Redis set failed:', e?.message || e);
      return json({ success: false, error: 'Failed to save subscription. Please try again.' }, 500, origin);
    }

    // Klaviyo (non-blocking for UX, but we do report status + error)
    let klaviyoSuccess = false;
    let klaviyoError = null;
    try {
      klaviyoSuccess = await subscribeToKlaviyoList(newSubscriber);
      console.log(klaviyoSuccess
        ? `✅ Klaviyo add success for ${email}`
        : `⚠️ Klaviyo add failed for ${email}`);
    } catch (e) {
      klaviyoError = e?.message || 'unknown Klaviyo error';
      console.warn('⚠️ Klaviyo error (non-fatal):', klaviyoError);
    }

    return json({
      success: true,
      message: 'Successfully subscribed to back-in-stock notifications',
      subscriber_count: subscribers.length,
      klaviyo_success: !!klaviyoSuccess,
      ...(klaviyoError ? { klaviyo_error: klaviyoError } : {})
    }, 200, origin);

  } catch (error) {
    console.error('❌ Back-in-stock POST error:', error);
    return json({
      success: false,
      error: 'Server error. Please try again.',
      details: process.env.NODE_ENV === 'development' ? (error?.message || String(error)) : undefined
    }, 500, origin);
  }
}

/* ----------------------- GET: check subscription ----------------------- */
export async function GET(request) {
  const origin = request.headers.get('origin') || '*';

  try {
    const { searchParams } = new URL(request.url);
    const email = searchParams.get('email');
    const product_id = searchParams.get('product_id');

    if (!email || !product_id) {
      return json({ success: false, error: 'Missing email or product_id parameters' }, 400, origin);
    }

    await redis.ping();

    const key = `subscribers:${String(product_id)}`;
    let subscribers = await redis.get(key) || [];
    if (typeof subscribers === 'string') {
      try { subscribers = JSON.parse(subscribers); } catch { subscribers = []; }
    }
    if (!Array.isArray(subscribers)) subscribers = [];

    const sub = subscribers.find(s => s && s.email === email);

    return json({
      success: true,
      subscribed: !!sub,
      total_subscribers: subscribers.length,
      subscription_details: sub ? {
        subscribed_at: sub.subscribed_at,
        notified: sub.notified,
        sms_consent: !!sub.sms_consent,
        phone_present: !!sub.phone
      } : null
    }, 200, origin);

  } catch (error) {
    console.error('❌ GET /back-in-stock error:', error);
    return json({ success: false, error: error?.message || 'Server error' }, 500, origin);
  }
}

/* ----------------------- Klaviyo: v2 -> v3 fallback ----------------------- */
// DIRECT LIST ADDITION - uses v2 /list/{id}/subscribe (records sms_consent) and
// falls back to v3 (create/get profile + lists/{id}/relationships/profiles)

async function subscribeToKlaviyoList(subscriber) {
  if (!KLAVIYO_API_KEY) {
    console.log('❌ No KLAVIYO_API_KEY set');
    return false;
  }
  if (!BACK_IN_STOCK_LIST_ID) {
    console.log('❌ No BACK_IN_STOCK_LIST_ID set');
    return false;
  }

  console.log('🔍 Klaviyo debug:', {
    apiKeyPresent: !!KLAVIYO_API_KEY,
    listId: BACK_IN_STOCK_LIST_ID,
    email: subscriber.email,
    sms_consent: !!subscriber.sms_consent,
    hasPhone: !!subscriber.phone
  });

  // First attempt: v2 list subscribe (best for SMS consent)
  try {
    const v2Payload = {
      profiles: [
        {
          email: subscriber.email,
          ...(subscriber.sms_consent && subscriber.phone
            ? { phone_number: subscriber.phone, sms_consent: true }
            : {})
        }
      ]
    };

    const v2 = await fetch(`https://a.klaviyo.com/api/v2/list/${BACK_IN_STOCK_LIST_ID}/subscribe`, {
      method: 'POST',
      headers: {
        'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(v2Payload)
    });

    if (v2.ok) {
      console.log('✅ v2 list/subscribe OK');
      return true;
    }

    const t = await v2.text().catch(() => '');
    console.warn(`⚠️ v2 subscribe failed: ${v2.status} ${v2.statusText} :: ${t.slice(0, 400)}`);
    // fall through to v3
  } catch (e) {
    console.warn('⚠️ v2 subscribe threw:', e?.message || e);
  }

  // Fallback: v3 profile create/get, then add to list via relationships
  return await alternativeListAddition(subscriber, BACK_IN_STOCK_LIST_ID);
}

// Alternative method: Add using relationships endpoint (v3)
async function alternativeListAddition(subscriber, listId) {
  try {
    const profileId = await createOrGetProfile(subscriber);
    if (!profileId) {
      throw new Error('Could not create or find profile in v3 fallback');
    }

    // Add profile to list
    const addToListData = { data: [{ type: 'profile', id: profileId }] };

    const listResponse = await fetch(`https://a.klaviyo.com/api/lists/${listId}/relationships/profiles/`, {
      method: 'POST',
      headers: {
        'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        'Content-Type': 'application/json',
        'revision': '2024-10-15'
      },
      body: JSON.stringify(addToListData)
    });

    console.log('📥 v3 add-to-list status:', listResponse.status);

    if (listResponse.ok || listResponse.status === 204) {
      console.log(`✅ v3 add-to-list SUCCESS for ${subscriber.email}`);
      return true;
    } else {
      const errorText = await listResponse.text();
      console.error(`❌ v3 add-to-list failed:`, errorText);
      return false;
    }
  } catch (error) {
    console.error('❌ v3 alternativeListAddition error:', error?.message || error);
    return false;
  }
}

// Create or get profile ID (v3)
// If sms_consent & E.164 phone are present, we set phone_number on profile.
// NOTE: true SMS opt-in recording in v3 can use subscription endpoints;
// for your list-trigger flow, phone_number + list add is typically enough.
async function createOrGetProfile(subscriber) {
  try {
    const attrs = {
      email: subscriber.email,
      first_name: subscriber.first_name || '',
      last_name: subscriber.last_name || '',
      ...(subscriber.sms_consent && subscriber.phone ? { phone_number: subscriber.phone } : {}),
      properties: {
        'Back in Stock Subscriber': true,
        'Subscription Source': 'Bundle Notifications',
        'Product Subscribed': subscriber.product_title
      }
    };

    const profileData = { data: { type: 'profile', attributes: attrs } };

    const profileResponse = await fetch('https://a.klaviyo.com/api/profiles/', {
      method: 'POST',
      headers: {
        'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        'Content-Type': 'application/json',
        'revision': '2024-10-15'
      },
      body: JSON.stringify(profileData)
    });

    if (profileResponse.ok) {
      const result = await profileResponse.json();
      return result?.data?.id || null;
    }

    if (profileResponse.status === 409) {
      // Exists → lookup by email
      const lookup = await fetch(
        `https://a.klaviyo.com/api/profiles/?filter=equals(email,"${encodeURIComponent(subscriber.email)}")`,
        { headers: { 'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`, 'revision': '2024-10-15' } }
      );
      if (lookup.ok) {
        const result = await lookup.json();
        return result?.data?.[0]?.id || null;
      }
    }

    const errText = await profileResponse.text().catch(() => '');
    console.error(`❌ v3 profile create failed (${profileResponse.status}): ${errText}`);
    return null;

  } catch (error) {
    console.error('❌ v3 profile create/get error:', error?.message || error);
    return null;
  }
}

/* ----------------------- Optional: event (unchanged) ----------------------- */
async function sendSubscriptionEvent(subscriber) {
  try {
    const eventData = {
      data: {
        type: 'event',
        attributes: {
          properties: {
            ProductName: subscriber.product_title,
            ProductID: subscriber.product_id,
            ProductHandle: subscriber.product_handle,
            SubscriptionDate: subscriber.subscribed_at,
            NotificationType: 'Subscription Confirmation',
            Method: 'Direct List Addition'
          },
          metric: { data: { type: 'metric', attributes: { name: 'Back in Stock Subscription' } } },
          profile: {
            data: {
              type: 'profile',
              attributes: { email: subscriber.email, first_name: subscriber.first_name, last_name: subscriber.last_name }
            }
          }
        }
      }
    };

    const response = await fetch('https://a.klaviyo.com/api/events/', {
      method: 'POST',
      headers: {
        'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        'Content-Type': 'application/json',
        'revision': '2024-10-15'
      },
      body: JSON.stringify(eventData)
    });

    if (!response.ok) {
      const t = await response.text().catch(() => '');
      console.log(`⚠️ event warn (${response.status}):`, t);
    }
  } catch (error) {
    console.error('❌ event error:', error?.message || error);
  }
}

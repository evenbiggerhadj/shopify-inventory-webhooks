// app/api/back-in-stock/route.js
// Back-in-stock subscription + Klaviyo list add + SMS consent (E.164) + audit trail

import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

/* =========================
   ENV + REDIS
   ========================= */
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
  retry: { retries: 3, retryDelayOnFailover: 100 }
});

const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
const BACK_IN_STOCK_LIST_ID = process.env.KLAVIYO_BACK_IN_STOCK_LIST_ID; // required
const ALLOW_ORIGIN = '*'; // set to your storefront domain if you want to lock it down

/* =========================
   UTILITIES
   ========================= */
function jsonRes(body, status = 200, extraHeaders = {}) {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': ALLOW_ORIGIN,
      ...extraHeaders
    }
  });
}

function parseFullName(full) {
  if (!full) return { first: '', last: '' };
  const parts = String(full).trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: '' };
  const first = parts.slice(0, -1).join(' ');
  const last = parts.slice(-1).join(' ');
  return { first, last };
}

// Very light E.164 formatter (handles common US & NG cases and generic "+")
function formatPhoneE164(raw) {
  if (!raw) return null;
  let v = String(raw).replace(/[^\d+]/g, '');

  // Already looks like E.164
  if (v.startsWith('+') && v.length >= 8) return v;

  // Nigeria local leading 0 -> +234
  if (/^0\d{10}$/.test(v)) return '+234' + v.slice(1);

  // Nigeria 10-digit starting 70/80/90/81/91 -> +234
  if (/^(70|80|90|81|91)\d{8}$/.test(v)) return '+234' + v;

  // US/Canada 10-digit -> +1
  if (/^\d{10}$/.test(v)) return '+1' + v;

  // If it’s 11-15 digits without +, assume user included country code
  if (/^\d{11,15}$/.test(v)) return '+' + v;

  return null; // invalid/unhandled
}

async function klaviyoFetch(url, { method = 'GET', body, headers = {} } = {}) {
  if (!KLAVIYO_API_KEY) {
    throw new Error('KLAVIYO_API_KEY not configured');
  }
  return fetch(url, {
    method,
    headers: {
      'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      'Content-Type': 'application/json',
      'revision': '2024-10-15',
      ...headers
    },
    body
  });
}

/* =========================
   KLAVIYO HELPERS
   ========================= */

// Create (or get existing) profile; we avoid setting phone_number here to dodge strict validations
async function createOrGetProfile({ email, first_name = '', last_name = '', properties = {} }) {
  // Try create
  const createPayload = {
    data: {
      type: 'profile',
      attributes: {
        email,
        first_name,
        last_name,
        properties
      }
    }
  };

  let res = await klaviyoFetch('https://a.klaviyo.com/api/profiles/', {
    method: 'POST',
    body: JSON.stringify(createPayload)
  });

  if (res.ok) {
    const j = await res.json();
    return j?.data?.id || null;
  }

  // If profile exists, pull it
  if (res.status === 409) {
    res = await klaviyoFetch(
      `https://a.klaviyo.com/api/profiles/?filter=equals(email,"${encodeURIComponent(email)}")`
    );
    if (res.ok) {
      const j = await res.json();
      return j?.data?.[0]?.id || null;
    }
  }

  // Some other failure
  const t = await res.text();
  console.warn('createOrGetProfile failed:', res.status, t);
  return null;
}

// Add an existing profile (by ID) to a list
async function addToListByProfileId({ listId, profileId }) {
  return klaviyoFetch(`https://a.klaviyo.com/api/lists/${listId}/relationships/profiles/`, {
    method: 'POST',
    body: JSON.stringify({ data: [{ type: 'profile', id: profileId }] })
  });
}

// Set SMS marketing consent + phone number (PATCH profile)
async function setSmsMarketingConsent({ profileId, phoneE164, method = 'Back in Stock Modal', ip }) {
  const payload = {
    data: {
      type: 'profile',
      id: profileId,
      attributes: {
        phone_number: phoneE164,
        subscriptions: {
          sms: {
            marketing: {
              consent: true,
              // Klaviyo accepts ISO timestamps; include optional metadata
              consented_at: new Date().toISOString(),
              method,
              ip
            }
          }
        }
      }
    }
  };

  return klaviyoFetch(`https://a.klaviyo.com/api/profiles/${profileId}/`, {
    method: 'PATCH',
    body: JSON.stringify(payload)
  });
}

// Store human-readable proof in profile.properties for UI visibility
async function storeSmsConsentProof({ profileId, phoneE164, ip, consentText }) {
  if (!profileId) return;
  const props = {
    'SMS Consent': true,
    'SMS Consent Timestamp': new Date().toISOString(),
    'SMS Consent IP': ip || '',
    'SMS Consent Text':
      consentText ||
      'I agree to receive SMS updates about this waitlist and back-in-stock alerts. Msg & data rates may apply. Reply STOP to opt out.',
    'Phone (E164)': phoneE164 || ''
  };

  const payload = {
    data: {
      type: 'profile',
      id: profileId,
      attributes: { properties: props }
    }
  };

  const res = await klaviyoFetch(`https://a.klaviyo.com/api/profiles/${profileId}/`, {
    method: 'PATCH',
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    console.warn('storeSmsConsentProof warn:', res.status, await res.text());
  }
}

// Optional: send a custom event (handy for segments/flows)
async function sendSmsConsentEvent({ email, phoneE164 }) {
  try {
    const payload = {
      data: {
        type: 'event',
        attributes: {
          metric: { data: { type: 'metric', attributes: { name: 'SMS Consent Captured' } } },
          properties: { 'Phone (E164)': phoneE164 || '' },
          profile: { data: { type: 'profile', attributes: { email } } },
          time: new Date().toISOString()
        }
      }
    };
    const r = await klaviyoFetch('https://a.klaviyo.com/api/events/', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    if (!r.ok) console.warn('sendSmsConsentEvent warn:', r.status, await r.text());
  } catch (e) {
    console.warn('sendSmsConsentEvent error:', e.message);
  }
}

/* =========================
   CORS
   ========================= */
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': ALLOW_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
}

/* =========================
   POST  (subscribe)
   ========================= */
export async function POST(request) {
  try {
    const ip =
      request.headers.get('x-forwarded-for') ||
      request.headers.get('x-real-ip') ||
      '';

    const body = await request.json();
    const {
      email,
      phone,
      product_id,
      product_title,
      product_handle,
      first_name = '',
      last_name = '',
      full_name = '', // optional (if your form uses a single full name field)
      sms_consent = false
    } = body || {};

    if (!email || !product_id) {
      return jsonRes({ success: false, error: 'Missing required fields: email, product_id' }, 400);
    }

    // Basic email format check
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
      return jsonRes({ success: false, error: 'Invalid email format' }, 400);
    }

    // Split name if you prefer a single field in the form
    let fName = first_name;
    let lName = last_name;
    if (!fName && !lName && full_name) {
      const parsed = parseFullName(full_name);
      fName = parsed.first;
      lName = parsed.last;
    }

    // Redis guard
    await redis.ping();

    // De-dup per product
    const key = `subscribers:${product_id}`;
    let subscribers = await redis.get(key);
    if (typeof subscribers === 'string') {
      try {
        subscribers = JSON.parse(subscribers);
      } catch {
        subscribers = [];
      }
    }
    if (!Array.isArray(subscribers)) subscribers = [];

    if (subscribers.find((s) => s?.email === email)) {
      return jsonRes({
        success: true,
        alreadySubscribed: true,
        message: 'Already subscribed for this product',
        subscriber_count: subscribers.length
      });
    }

    // Create subscriber record
    const newSubscriber = {
      email,
      phone: phone || '',
      product_id: String(product_id),
      product_title: product_title || 'Unknown Product',
      product_handle: product_handle || '',
      first_name: fName || '',
      last_name: lName || '',
      sms_consent: !!sms_consent,
      notified: false,
      subscribed_at: new Date().toISOString(),
      ip_address: ip || 'unknown'
    };

    subscribers.push(newSubscriber);
    await redis.set(key, subscribers, { ex: 30 * 24 * 60 * 60 });

    /* =========================
       KLAVIYO INTEGRATION
       ========================= */
    let klaviyo_list_success = false;
    let klaviyo_sms_success = false;

    if (!KLAVIYO_API_KEY || !BACK_IN_STOCK_LIST_ID) {
      // If not configured, still return success so the modal UX is smooth
      return jsonRes({
        success: true,
        message: 'Subscribed locally. (Klaviyo not configured)',
        subscriber_count: subscribers.length,
        klaviyo_success: false,
        klaviyo_sms_success: false
      });
    }

    // 1) Create/get profile
    const profileId = await createOrGetProfile({
      email,
      first_name: newSubscriber.first_name,
      last_name: newSubscriber.last_name,
      properties: {
        'Back in Stock Subscriber': true,
        'Subscription Source': 'Bundle Notifications',
        'Product Subscribed': newSubscriber.product_title
      }
    });

    if (profileId) {
      // 2) Add to email list (to trigger your email flow)
      const addRes = await addToListByProfileId({
        listId: BACK_IN_STOCK_LIST_ID,
        profileId
      });
      klaviyo_list_success = addRes.ok;

      // 3) If consent + phone provided, set SMS marketing consent
      if (newSubscriber.sms_consent && newSubscriber.phone) {
        const phoneE164 = formatPhoneE164(newSubscriber.phone);
        if (phoneE164) {
          const smsRes = await setSmsMarketingConsent({
            profileId,
            phoneE164,
            method: 'Back in Stock Modal',
            ip
          });
          klaviyo_sms_success = smsRes.ok;

          // 4) Store visible proof for auditing in Klaviyo UI
          await storeSmsConsentProof({
            profileId,
            phoneE164,
            ip,
            consentText:
              'I agree to receive SMS updates about this waitlist and back-in-stock alerts. Msg & data rates may apply. Reply STOP to opt out.'
          });

          // 5) Optional event
          await sendSmsConsentEvent({ email, phoneE164 });
        }
      }
    } else {
      console.error('Could not create/get Klaviyo profile for', email);
    }

    return jsonRes({
      success: true,
      message: 'Successfully subscribed to back-in-stock notifications',
      subscriber_count: subscribers.length,
      klaviyo_success: klaviyo_list_success,
      klaviyo_sms_success
    });
  } catch (error) {
    console.error('Back-in-stock POST error:', error);
    return jsonRes(
      {
        success: false,
        error: 'Server error. Please try again.',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      },
      500
    );
  }
}

/* =========================
   GET (subscription status)
   ========================= */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const email = searchParams.get('email');
    const product_id = searchParams.get('product_id');

    if (!email || !product_id) {
      return jsonRes({ success: false, error: 'Missing email or product_id' }, 400);
    }

    await redis.ping();

    const key = `subscribers:${product_id}`;
    let subscribers = await redis.get(key);
    if (typeof subscribers === 'string') {
      try {
        subscribers = JSON.parse(subscribers);
      } catch {
        subscribers = [];
      }
    }
    if (!Array.isArray(subscribers)) subscribers = [];

    const sub = subscribers.find((s) => s?.email === email);

    return jsonRes({
      success: true,
      subscribed: !!sub,
      total_subscribers: subscribers.length,
      subscription_details: sub
        ? { subscribed_at: sub.subscribed_at, notified: sub.notified, sms_consent: sub.sms_consent }
        : null
    });
  } catch (error) {
    console.error('Back-in-stock GET error:', error);
    return jsonRes({ success: false, error: error.message }, 500);
  }
}

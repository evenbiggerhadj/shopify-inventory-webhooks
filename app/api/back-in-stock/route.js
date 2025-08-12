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

// support your env names seen in Vercel
const BACK_IN_STOCK_LIST_ID =
  process.env.KLAVIYO_BACK_IN_STOCK_LIST_ID ||
  process.env.KLAVIYO_BACK_IN_STOCK_ALERT_LIST_ID ||
  process.env.KLAVIYO_LIST_ID;

const ALLOW_ORIGIN = '*'; // optionally set to your storefront domain

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
  return { first: parts.slice(0, -1).join(' '), last: parts.slice(-1).join(' ') };
}

// very light E.164 helper (US/CA/NG + generic)
function formatPhoneE164(raw) {
  if (!raw) return null;
  let v = String(raw).replace(/[^\d+]/g, '');
  if (v.startsWith('+') && v.length >= 8) return v;
  if (/^0\d{10}$/.test(v)) return '+234' + v.slice(1);                      // NG local
  if (/^(70|80|90|81|91)\d{8}$/.test(v)) return '+234' + v;                  // NG 10-digit
  if (/^\d{10}$/.test(v)) return '+1' + v;                                   // US/CA
  if (/^\d{11,15}$/.test(v)) return '+' + v;                                 // generic
  return null;
}

async function klaviyoFetch(url, { method = 'GET', body, headers = {} } = {}) {
  if (!KLAVIYO_API_KEY) throw new Error('KLAVIYO_API_KEY not configured');
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
async function createOrGetProfile({ email, first_name = '', last_name = '', properties = {} }) {
  const createPayload = {
    data: { type: 'profile', attributes: { email, first_name, last_name, properties } }
  };

  let res = await klaviyoFetch('https://a.klaviyo.com/api/profiles/', {
    method: 'POST',
    body: JSON.stringify(createPayload)
  });

  if (res.ok) {
    const j = await res.json();
    return j?.data?.id || null;
  }

  if (res.status === 409) {
    res = await klaviyoFetch(
      `https://a.klaviyo.com/api/profiles/?filter=equals(email,"${encodeURIComponent(email)}")`
    );
    if (res.ok) {
      const j = await res.json();
      return j?.data?.[0]?.id || null;
    }
  }

  console.warn('createOrGetProfile failed:', res.status, await res.text());
  return null;
}

async function addToListByProfileId({ listId, profileId }) {
  return klaviyoFetch(`https://a.klaviyo.com/api/lists/${listId}/relationships/profiles/`, {
    method: 'POST',
    body: JSON.stringify({ data: [{ type: 'profile', id: profileId }] })
  });
}

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

async function storeSmsConsentProof({ profileId, phoneE164, ip, consentText }) {
  if (!profileId) return;
  const payload = {
    data: {
      type: 'profile',
      id: profileId,
      attributes: {
        properties: {
          'SMS Consent': true,
          'SMS Consent Timestamp': new Date().toISOString(),
          'SMS Consent IP': ip || '',
          'SMS Consent Text': consentText || 'Back-in-stock SMS consent collected on modal.',
          'Phone (E164)': phoneE164 || ''
        }
      }
    }
  };

  const res = await klaviyoFetch(`https://a.klaviyo.com/api/profiles/${profileId}/`, {
    method: 'PATCH',
    body: JSON.stringify(payload)
  });
  if (!res.ok) console.warn('storeSmsConsentProof warn:', res.status, await res.text());
}

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
    const r = await klaviyoFetch('https://a.klaviyo.com/api/events/', { method: 'POST', body: JSON.stringify(payload) });
    if (!r.ok) console.warn('sendSmsConsentEvent warn:', r.status, await r.text());
  } catch (e) { console.warn('sendSmsConsentEvent error:', e.message); }
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
   POST (subscribe)
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
      full_name = '',
      sms_consent = false
    } = body || {};

    if (!email || !product_id) {
      return jsonRes({ success: false, error: 'Missing required fields: email, product_id' }, 400);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
      return jsonRes({ success: false, error: 'Invalid email format' }, 400);
    }

    const { first: first_name, last: last_name } = parseFullName(full_name);

    await redis.ping();

    const key = `subscribers:${product_id}`;
    let subscribers = await redis.get(key);
    if (typeof subscribers === 'string') { try { subscribers = JSON.parse(subscribers); } catch { subscribers = []; } }
    if (!Array.isArray(subscribers)) subscribers = [];

    if (subscribers.find(s => s?.email === email)) {
      return jsonRes({ success: true, alreadySubscribed: true, message: 'Already subscribed for this product', subscriber_count: subscribers.length });
    }

    const newSubscriber = {
      email,
      phone: phone || '',
      product_id: String(product_id),
      product_title: product_title || 'Unknown Product',
      product_handle: product_handle || '',
      first_name: first_name || '',
      last_name: last_name || '',
      sms_consent: !!sms_consent,
      notified: false,
      subscribed_at: new Date().toISOString(),
      ip_address: ip || 'unknown'
    };

    subscribers.push(newSubscriber);
    await redis.set(key, subscribers, { ex: 30 * 24 * 60 * 60 });

    // If Klaviyo not configured, return success for UX and log local
    if (!KLAVIYO_API_KEY || !BACK_IN_STOCK_LIST_ID) {
      return jsonRes({
        success: true,
        message: 'Subscribed locally. (Klaviyo not configured)',
        subscriber_count: subscribers.length,
        klaviyo_success: false,
        klaviyo_sms_success: false
      });
    }

    // Create or fetch profile
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

    let klaviyo_list_success = false;
    let klaviyo_sms_success = false;

    if (profileId) {
      // Add to email list (triggers your BIS flow)
      const addRes = await addToListByProfileId({ listId: BACK_IN_STOCK_LIST_ID, profileId });
      klaviyo_list_success = addRes.ok;

      // Handle SMS consent
      if (newSubscriber.sms_consent && newSubscriber.phone) {
        const phoneE164 = formatPhoneE164(newSubscriber.phone);
        if (phoneE164) {
          const smsRes = await setSmsMarketingConsent({ profileId, phoneE164, method: 'Back in Stock Modal', ip });
          klaviyo_sms_success = smsRes.ok;
          await storeSmsConsentProof({
            profileId,
            phoneE164,
            ip,
            consentText: 'I agree to receive SMS updates about this waitlist and back-in-stock alerts. Msg & data rates may apply. Reply STOP to opt out.'
          });
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
      { success: false, error: 'Server error. Please try again.', details: process.env.NODE_ENV === 'development' ? error.message : undefined },
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
    if (typeof subscribers === 'string') { try { subscribers = JSON.parse(subscribers); } catch { subscribers = []; } }
    if (!Array.isArray(subscribers)) subscribers = [];

    const sub = subscribers.find(s => s?.email === email);

    return jsonRes({
      success: true,
      subscribed: !!sub,
      total_subscribers: subscribers.length,
      subscription_details: sub ? {
        subscribed_at: sub.subscribed_at,
        notified: sub.notified,
        sms_consent: sub.sms_consent
      } : null
    });
  } catch (error) {
    console.error('Back-in-stock GET error:', error);
    return jsonRes({ success: false, error: error.message }, 500);
  }
}

// app/api/back-in-stock/route.js — WAITLIST signup (Subscribe Profiles + Redis + product props + event)
import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

/* ----------------- Redis ----------------- */
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
  retry: { retries: 3, retryDelayOnFailover: 100 },
});

/* ----------------- Env ----------------- */
const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
const WAITLIST_LIST_ID = process.env.KLAVIYO_LIST_ID; // waitlist list (form signups)
const PUBLIC_STORE_DOMAIN = process.env.PUBLIC_STORE_DOMAIN || 'armadillotough.com'; // used for product URLs

/* ----------------- utils ----------------- */
function cors(resp, origin = '*') {
  resp.headers.set('Access-Control-Allow-Origin', origin);
  resp.headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  resp.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return resp;
}
function toE164(raw) {
  if (!raw) return null;
  let v = String(raw).trim().replace(/[^\d+]/g, '');
  if (v.startsWith('+')) return /^\+\d{8,15}$/.test(v) ? v : null; // strict E.164
  if (/^0\d{10}$/.test(v)) return '+234' + v.slice(1);            // NG local 0XXXXXXXXXX
  if (/^(70|80|81|90|91)\d{8}$/.test(v)) return '+234' + v;       // NG 10-digit
  if (/^\d{10}$/.test(v)) return '+1' + v;                         // US 10-digit
  return null;
}
function splitName(full) {
  const s = String(full || '').trim();
  if (!s) return { first_name: '', last_name: '' };
  const parts = s.split(/\s+/);
  if (parts.length === 1) return { first_name: parts[0], last_name: '' };
  const first_name = parts.shift();
  const last_name = parts.join(' ');
  return { first_name, last_name };
}
const findIdxByEmail = (arr, email) =>
  arr.findIndex(s => String(s?.email || '').toLowerCase() === String(email || '').toLowerCase());

const productUrlFrom = (handle) =>
  handle ? `https://${PUBLIC_STORE_DOMAIN}/products/${handle}` : '';

/* ----------------- CORS preflight ----------------- */
export async function OPTIONS(request) {
  return cors(new NextResponse(null, { status: 204 }), request.headers.get('origin') || '*');
}

/* ----------------- POST — create/merge waitlist signup ----------------- */
export async function POST(request) {
  const origin = request.headers.get('origin') || '*';

  try {
    if (!KLAVIYO_API_KEY || !WAITLIST_LIST_ID) {
      return cors(
        NextResponse.json(
          { success: false, error: 'Server misconfigured: missing KLAVIYO_API_KEY or KLAVIYO_LIST_ID' },
          { status: 500 }
        ),
        origin
      );
    }

    const body = await request.json();
    let {
      email,
      phone,
      product_id,
      product_title,
      product_handle,
      full_name,
      first_name,
      last_name,
      sms_consent = false,
      source = 'BIS modal',
    } = body || {};

    // required
    if (!email || !product_id) {
      return cors(
        NextResponse.json({ success: false, error: 'Missing required fields: email and product_id' }, { status: 400 }),
        origin
      );
    }
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim());
    if (!emailOk) {
      return cors(NextResponse.json({ success: false, error: 'Invalid email format' }, { status: 400 }), origin);
    }

    // names
    if ((!first_name && !last_name) && full_name) {
      const spl = splitName(full_name);
      first_name = spl.first_name;
      last_name = spl.last_name;
    }

    // phone + consent
    const phoneE164 = toE164(phone);
    const smsAllowed = !!(sms_consent && phoneE164);

    // canonical product URL
    const product_url = productUrlFrom(product_handle);

    // redis upsert
    try { await redis.ping(); } catch {
      return cors(
        NextResponse.json({ success: false, error: 'Database connection failed. Please try again.' }, { status: 500 }),
        origin
      );
    }

    const key = `subscribers:${product_id}`;
    let subscribers = [];
    try {
      const existing = await redis.get(key);
      if (Array.isArray(existing)) subscribers = existing;
      else if (typeof existing === 'string') subscribers = JSON.parse(existing || '[]');
    } catch { subscribers = []; }

    const idx = findIdxByEmail(subscribers, email);
    const prior = idx !== -1 ? (subscribers[idx] || {}) : null;

    const upserted = {
      ...(prior || {}),
      email,
      phone: phoneE164 || prior?.phone || '',
      first_name: first_name || prior?.first_name || '',
      last_name: last_name || prior?.last_name || '',
      sms_consent: smsAllowed ? true : !!prior?.sms_consent,
      product_id: String(product_id),
      product_title: product_title || prior?.product_title || 'Unknown Product',
      product_handle: product_handle || prior?.product_handle || '',
      product_url: product_url || prior?.product_url || '',
      notified: !!prior?.notified,
      subscribed_at: prior?.subscribed_at || new Date().toISOString(),
      ip_address:
        request.headers.get('x-forwarded-for') ||
        request.headers.get('x-real-ip') ||
        prior?.ip_address ||
        'unknown',
    };

    if (idx !== -1) subscribers[idx] = upserted;
    else subscribers.push(upserted);

    await redis.set(key, subscribers, { ex: 30 * 24 * 60 * 60 });

    // 1) Subscribe to WAITLIST list (records consent properly)
    let klaviyo_success = false, klaviyo_status = 0, klaviyo_body = '';
    try {
      const out = await subscribeProfilesToList({
        listId: WAITLIST_LIST_ID,
        email,
        phoneE164,
        sms: smsAllowed,
      });
      klaviyo_success = out.ok; klaviyo_status = out.status; klaviyo_body = out.body;
    } catch (e) {
      klaviyo_success = false; klaviyo_status = 0; klaviyo_body = e?.message || String(e);
    }

    // 2) Stamp product props (for list-based flows if you use them)
    let profile_update_success = false, profile_update_status = 0, profile_update_body = '';
    try {
      const out = await updateProfileProperties({
        email,
        properties: {
          last_waitlist_product_name: upserted.product_title,
          last_waitlist_product_url: upserted.product_url,
          last_waitlist_product_handle: upserted.product_handle,
          last_waitlist_product_id: upserted.product_id,
          last_waitlist_subscribed_at: upserted.subscribed_at,
        },
      });
      profile_update_success = out.ok; profile_update_status = out.status; profile_update_body = out.body;
    } catch (e) {
      profile_update_success = false; profile_update_status = 0; profile_update_body = e?.message || String(e);
    }

    // 3) Fire the signup event (recommended trigger for welcome/waitlist flows)
    let event_success = false, event_status = 0, event_body = '';
    try {
      const out = await trackKlaviyoEvent({
        metricName: 'Back in Stock Subscriptions',
        email,
        phoneE164,
        properties: {
          product_id: String(upserted.product_id),
          product_title: upserted.product_title,
          product_handle: upserted.product_handle,
          product_url: upserted.product_url,
          sms_consent: !!smsAllowed,
          source,
        },
      });
      event_success = out.ok; event_status = out.status; event_body = out.body;
    } catch (e) {
      event_success = false; event_status = 0; event_body = e?.message || String(e);
    }

    return cors(
      NextResponse.json({
        success: true,
        message: 'Successfully subscribed to the back-in-stock waitlist',
        subscriber_count: subscribers.length,
        klaviyo_success,
        klaviyo_status,
        klaviyo_body,
        profile_update_success,
        profile_update_status,
        profile_update_body,
        event_success,
        event_status,
        event_body,
      }),
      origin
    );

  } catch (error) {
    return cors(
      NextResponse.json(
        {
          success: false,
          error: 'Server error. Please try again.',
          details: process.env.NODE_ENV === 'development' ? error?.message : undefined,
        },
        { status: 500 }
      ),
      origin
    );
  }
}

/* ----------------- GET — check if a given email is on the waitlist for a product ----------------- */
export async function GET(request) {
  const origin = request.headers.get('origin') || '*';
  try {
    const { searchParams } = new URL(request.url);
    const email = searchParams.get('email');
    const product_id = searchParams.get('product_id');

    if (!email || !product_id) {
      return cors(
        NextResponse.json({ success: false, error: 'Missing email or product_id parameters' }, { status: 400 }),
        origin
      );
    }

    await redis.ping();
    const key = `subscribers:${product_id}`;
    let subs = await redis.get(key) || [];
    if (typeof subs === 'string') { try { subs = JSON.parse(subs); } catch { subs = []; } }
    if (!Array.isArray(subs)) subs = [];

    const sub = subs.find(s => String(s?.email || '').toLowerCase() === String(email).toLowerCase());
    return cors(
      NextResponse.json({
        success: true,
        subscribed: !!sub,
        total_subscribers: subs.length,
        subscription_details: sub ? {
          subscribed_at: sub.subscribed_at,
          notified: sub.notified,
          sms_consent: !!sub.sms_consent,
          product_title: sub.product_title,
          product_handle: sub.product_handle,
          product_url: sub.product_url,
        } : null,
      }),
      origin
    );
  } catch (error) {
    return cors(NextResponse.json({ success: false, error: error?.message || 'Error' }, { status: 500 }), origin);
  }
}

/* ----------------- Klaviyo helpers ----------------- */
async function subscribeProfilesToList({ listId, email, phoneE164, sms }) {
  if (!KLAVIYO_API_KEY) throw new Error('KLAVIYO_API_KEY missing');
  if (!listId) throw new Error('List ID missing');
  if (!email) throw new Error('Email missing');

  const subscriptions = { email: { marketing: { consent: 'SUBSCRIBED' } } };
  if (sms && phoneE164) subscriptions.sms = { marketing: { consent: 'SUBSCRIBED' } };

  const payload = {
    data: {
      type: 'profile-subscription-bulk-create-job',
      attributes: {
        profiles: { data: [
          { type: 'profile', attributes: { email, ...(sms && phoneE164 ? { phone_number: phoneE164 } : {}), subscriptions } }
        ] }
      },
      relationships: { list: { data: { type: 'list', id: listId } } }
    }
  };

  const res = await fetch('https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/', {
    method: 'POST',
    headers: {
      Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      accept: 'application/json',
      'content-type': 'application/json',
      revision: '2023-10-15'
    },
    body: JSON.stringify(payload)
  });

  const body = await res.text();
  if (!res.ok) throw new Error(`Subscribe Profiles failed: ${res.status} ${res.statusText} :: ${body}`);
  return { ok: true, status: res.status, body };
}

/** Upsert custom properties on the profile so flows can reference {{ profile.* }} */
async function updateProfileProperties({ email, properties }) {
  if (!KLAVIYO_API_KEY) throw new Error('KLAVIYO_API_KEY missing');
  if (!email) throw new Error('Email missing');

  const payload = {
    data: {
      type: 'profile-properties-bulk-update-job',
      attributes: {
        profiles: {
          data: [
            { type: 'profile', attributes: { email, properties } }
          ]
        }
      }
    }
  };

  const res = await fetch('https://a.klaviyo.com/api/profile-properties-bulk-update-jobs/', {
    method: 'POST',
    headers: {
      Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      accept: 'application/json',
      'content-type': 'application/json',
      revision: '2023-10-15'
    },
    body: JSON.stringify(payload)
  });

  const body = await res.text();
  if (!res.ok) throw new Error(`Profile properties update failed: ${res.status} ${res.statusText} :: ${body}`);
  return { ok: true, status: res.status, body };
}

/** Send a Klaviyo metric event with product context */
async function trackKlaviyoEvent({ metricName, email, phoneE164, properties }) {
  if (!KLAVIYO_API_KEY) throw new Error('KLAVIYO_API_KEY missing');
  if (!metricName) throw new Error('metricName missing');

  const body = {
    data: {
      type: 'event',
      attributes: {
        time: new Date().toISOString(),
        properties: properties || {},
        metric: { data: { type: 'metric', attributes: { name: metricName } } },
        profile: {
          data: { type: 'profile', attributes: { email, ...(phoneE164 ? { phone_number: phoneE164 } : {}) } }
        }
      }
    }
  };

  const res = await fetch('https://a.klaviyo.com/api/events/', {
    method: 'POST',
    headers: {
      Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      accept: 'application/json',
      'content-type': 'application/json',
      revision: '2023-10-15'
    },
    body: JSON.stringify(body)
  });

  const txt = await res.text();
  if (!res.ok) throw new Error(`Klaviyo event failed: ${res.status} ${res.statusText} :: ${txt}`);
  return { ok: true, status: res.status, body: txt };
}

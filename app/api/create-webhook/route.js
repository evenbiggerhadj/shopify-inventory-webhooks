// app/api/back-in-stock/route.js — WAITLIST signup (Klaviyo always; Redis best-effort)
import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

/* ----------------- Redis (best-effort) ----------------- */
// Support multiple env naming schemes so deployments don’t randomly break
const REDIS_URL =
  process.env.KV_REST_API_URL ||
  process.env.KV_URL ||
  process.env.REDIS_URL ||
  '';

const REDIS_TOKEN =
  process.env.KV_REST_API_TOKEN ||
  process.env.KV_REST_API_READ_ONLY_TOKEN ||
  process.env.KV_TOKEN ||
  '';

const redis =
  REDIS_URL && REDIS_TOKEN
    ? new Redis({
        url: REDIS_URL,
        token: REDIS_TOKEN,
        retry: { retries: 3, retryDelayOnFailover: 100 },
      })
    : null;

/* ----------------- Env ----------------- */
const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;   // required
const WAITLIST_LIST_ID = process.env.KLAVIYO_LIST_ID;  // required (BIS form list)
const PUBLIC_STORE_DOMAIN = process.env.PUBLIC_STORE_DOMAIN || 'armadillotough.com';

/* ----------------- CORS allowlist ----------------- */
const ALLOW_ORIGINS = [
  'https://armadillotough.com',
  'https://www.armadillotough.com',
  'https://armadillotough.myshopify.com',
];
const pickOrigin = (req) => {
  const o = req.headers.get('origin');
  return ALLOW_ORIGINS.includes(o) ? o : ALLOW_ORIGINS[0];
};

/* ----------------- utils ----------------- */
function cors(resp, origin = '*') {
  resp.headers.set('Access-Control-Allow-Origin', origin);
  resp.headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  resp.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  resp.headers.set('Vary', 'Origin');
  resp.headers.set('Cache-Control', 'no-store');
  return resp;
}

function toE164(raw) {
  if (!raw) return null;
  let v = String(raw).trim().replace(/[^\d+]/g, '');
  if (v.startsWith('+')) return /^\+\d{8,15}$/.test(v) ? v : null;
  if (/^0\d{10}$/.test(v)) return '+234' + v.slice(1);
  if (/^(70|80|81|90|91)\d{8}$/.test(v)) return '+234' + v;
  if (/^\d{10}$/.test(v)) return '+1' + v;
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
  arr.findIndex(
    (s) => String(s?.email || '').toLowerCase() === String(email || '').toLowerCase()
  );

const normalizeProductId = (raw) => {
  if (!raw) return '';
  const n = String(raw);
  const m = n.match(/(\d{5,})$/);
  return m ? m[1] : n.replace(/[^\d]/g, '') || n;
};

const productUrlFrom = (handle) =>
  handle ? `https://${PUBLIC_STORE_DOMAIN}/products/${handle}` : '';

async function safeRedisPing() {
  // Option B: Redis is optional — never hard-fail the request because of it
  if (!redis) return { ok: false, reason: 'redis_not_configured' };
  try {
    await redis.ping();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  }
}

/* ----------------- CORS preflight ----------------- */
export async function OPTIONS(request) {
  return cors(new NextResponse(null, { status: 204 }), pickOrigin(request));
}

/* ----------------- POST — create/merge waitlist signup ----------------- */
export async function POST(request) {
  const origin = pickOrigin(request);

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
      first_name,
      last_name,
      full_name,
      sms_consent = false,
      source = 'BIS modal',
    } = body || {};

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

    if ((!first_name && !last_name) && full_name) {
      const spl = splitName(full_name);
      first_name = spl.first_name;
      last_name = spl.last_name;
    }

    const phoneE164 = toE164(phone);
    const smsAllowed = !!(sms_consent && phoneE164);

    const pid = normalizeProductId(product_id);
    const handle = String(product_handle || '').trim();
    const product_url = productUrlFrom(handle);
    const related_section_url = product_url ? `${product_url}#after-bis` : '';

    // Build the upsert object first (even if Redis is down)
    const now = new Date().toISOString();
    const upsertedBase = {
      email,
      phone: phoneE164 || '',
      first_name: first_name || '',
      last_name: last_name || '',
      sms_consent: !!smsAllowed,
      product_id: String(pid),
      product_title: product_title || 'Unknown Product',
      product_handle: handle || '',
      product_url: product_url || '',
      notified: false,
      last_rearmed_at: now,
      rearm_count: 1,
      subscribed_at: now,
      ip_address:
        request.headers.get('x-forwarded-for') ||
        request.headers.get('x-real-ip') ||
        'unknown',
      last_source: source,
    };

    // Option B: Redis is best-effort
    const ping = await safeRedisPing();
    let redis_ok = ping.ok;
    let subscriber_count = null;

    if (redis_ok) {
      const idKey = `subscribers:${pid}`;
      const handleKey = handle ? `subscribers_handle:${handle}` : null;

      const readList = async (key) => {
        if (!key) return [];
        const v = await redis.get(key);
        if (Array.isArray(v)) return v;
        if (typeof v === 'string') { try { return JSON.parse(v); } catch { return []; } }
        return [];
      };

      const [byId, byHandle] = await Promise.all([readList(idKey), readList(handleKey)]);
      const mergedMap = new Map();

      const stamp = (x) => {
        const k = String(x?.email || '').toLowerCase();
        const prev = mergedMap.get(k);
        if (!prev) mergedMap.set(k, x);
        else {
          const a = Date.parse(x?.last_rearmed_at || x?.subscribed_at || 0);
          const b = Date.parse(prev?.last_rearmed_at || prev?.subscribed_at || 0);
          mergedMap.set(k, a >= b ? x : prev);
        }
      };

      [...byId, ...byHandle].forEach(stamp);
      const subscribers = Array.from(mergedMap.values());

      const idx = findIdxByEmail(subscribers, email);
      const prior = idx !== -1 ? (subscribers[idx] || {}) : null;

      const upserted = {
        ...(prior || {}),
        ...upsertedBase,
        phone: phoneE164 || prior?.phone || '',
        sms_consent: smsAllowed ? true : !!prior?.sms_consent,
        product_title: product_title || prior?.product_title || 'Unknown Product',
        product_handle: handle || prior?.product_handle || '',
        product_url: product_url || prior?.product_url || '',
        last_rearmed_at: now,
        rearm_count: (prior?.rearm_count || 0) + 1,
        subscribed_at: prior?.subscribed_at || now,
        ip_address:
          request.headers.get('x-forwarded-for') ||
          request.headers.get('x-real-ip') ||
          prior?.ip_address ||
          'unknown',
        last_source: source,
      };

      if (idx !== -1) subscribers[idx] = upserted;
      else subscribers.push(upserted);

      const writes = [redis.set(idKey, subscribers, { ex: 90 * 24 * 60 * 60 })];
      if (handleKey) writes.push(redis.set(handleKey, subscribers, { ex: 90 * 24 * 60 * 60 }));
      await Promise.all(writes);

      subscriber_count = subscribers.length;
    }

    // 1) Klaviyo list subscribe (authoritative)
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

    // 2) Stamp profile props
    let profile_update_success = false, profile_update_status = 0, profile_update_body = '', profile_update_skipped = false;
    try {
      const out = await updateProfileProperties({
        email,
        properties: {
          last_waitlist_product_name: upsertedBase.product_title,
          last_waitlist_product_url: upsertedBase.product_url,
          last_waitlist_related_section_url: related_section_url,
          last_waitlist_product_handle: upsertedBase.product_handle,
          last_waitlist_product_id: upsertedBase.product_id,
          last_waitlist_subscribed_at: upsertedBase.subscribed_at,
        },
      });
      profile_update_success = !!out.ok; profile_update_status = out.status || 0; profile_update_body = out.body || '';
      profile_update_skipped = !!out.skipped;
    } catch (e) {
      profile_update_success = false; profile_update_status = 0; profile_update_body = e?.message || String(e);
    }

    // 3) Event for flows
    let event_success = false, event_status = 0, event_body = '';
    try {
      const out = await trackKlaviyoEvent({
        metricName: 'Back in Stock Subscriptions',
        email,
        phoneE164,
        properties: {
          product_id: String(pid),
          product_title: upsertedBase.product_title,
          product_handle: upsertedBase.product_handle,
          product_url: upsertedBase.product_url,
          related_section_url: related_section_url,
          sms_consent: !!smsAllowed,
          source,
          redis_ok,
          redis_reason: redis_ok ? null : (ping.reason || null),
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
        rearmed: true,
        redis_ok,
        redis_reason: redis_ok ? null : (ping.reason || null),
        subscriber_count, // null if Redis down (still ok)
        klaviyo_success,
        klaviyo_status,
        klaviyo_body,
        profile_update_success,
        profile_update_status,
        profile_update_body,
        profile_update_skipped,
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

/* ----------------- GET — check if a given email is on the waitlist (by id OR handle) ----------------- */
export async function GET(request) {
  const origin = pickOrigin(request);
  try {
    const { searchParams } = new URL(request.url);
    const email = searchParams.get('email');
    const product_id_raw = searchParams.get('product_id');
    const product_handle = searchParams.get('product_handle');

    if (!email || (!product_id_raw && !product_handle)) {
      return cors(
        NextResponse.json({ success: false, error: 'Missing email and product_id or product_handle' }, { status: 400 }),
        origin
      );
    }

    // If Redis is down/not configured, don’t hard-fail GET either
    const ping = await safeRedisPing();
    if (!ping.ok) {
      return cors(
        NextResponse.json({
          success: true,
          subscribed: null,
          redis_ok: false,
          redis_reason: ping.reason,
          message: 'Redis unavailable; cannot check subscription state right now.',
        }),
        origin
      );
    }

    const pid = product_id_raw ? normalizeProductId(product_id_raw) : null;
    const idKey = pid ? `subscribers:${pid}` : null;
    const handleKey = product_handle ? `subscribers_handle:${product_handle}` : null;

    const readList = async (key) => {
      if (!key) return [];
      const v = await redis.get(key);
      if (Array.isArray(v)) return v;
      if (typeof v === 'string') { try { return JSON.parse(v); } catch { return []; } }
      return [];
    };

    const [byId, byHandle] = await Promise.all([readList(idKey), readList(handleKey)]);
    const merged = [...byId, ...byHandle];

    const sub = merged.find(
      (s) => String(s?.email || '').toLowerCase() === String(email).toLowerCase()
    );

    return cors(
      NextResponse.json({
        success: true,
        subscribed: !!sub,
        total_subscribers: merged.length,
        subscription_details: sub ? {
          subscribed_at: sub.subscribed_at,
          notified: sub.notified,
          sms_consent: !!sub.sms_consent,
          product_title: sub.product_title,
          product_handle: sub.product_handle,
          product_url: sub.product_url,
        } : null,
        keys_checked: [idKey, handleKey].filter(Boolean),
        redis_ok: true,
      }),
      origin
    );
  } catch (error) {
    return cors(
      NextResponse.json({ success: false, error: error?.message || 'Error' }, { status: 500 }),
      origin
    );
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
          {
            type: 'profile',
            attributes: {
              email,
              ...(sms && phoneE164 ? { phone_number: phoneE164 } : {}),
              subscriptions,
            },
          },
        ]},
      },
      relationships: { list: { data: { type: 'list', id: listId } } },
    },
  };

  const res = await fetch('https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/', {
    method: 'POST',
    headers: {
      Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      accept: 'application/json',
      'content-type': 'application/json',
      revision: '2023-10-15',
    },
    body: JSON.stringify(payload),
  });

  const body = await res.text();
  if (!res.ok) throw new Error(`Subscribe Profiles failed: ${res.status} ${res.statusText} :: ${body}`);
  return { ok: true, status: res.status, body };
}

async function updateProfileProperties({ email, properties }) {
  if (!KLAVIYO_API_KEY) throw new Error('KLAVIYO_API_KEY missing');
  if (!email) throw new Error('Email missing');

  const filter = `equals(email,"${String(email).replace(/"/g, '\\"')}")`;
  const listRes = await fetch(
    `https://a.klaviyo.com/api/profiles/?filter=${encodeURIComponent(filter)}&page[size]=1`,
    {
      method: 'GET',
      headers: {
        Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        accept: 'application/json',
        revision: '2023-10-15',
      },
    }
  );

  if (!listRes.ok) {
    const txt = await listRes.text();
    throw new Error(`Profiles lookup failed: ${listRes.status} ${listRes.statusText} :: ${txt}`);
  }

  const listJson = await listRes.json();
  const id = listJson?.data?.[0]?.id;

  if (!id) {
    return { ok: false, status: 404, body: 'profile_not_found', skipped: true };
  }

  const patchRes = await fetch(`https://a.klaviyo.com/api/profiles/${id}/`, {
    method: 'PATCH',
    headers: {
      Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      accept: 'application/json',
      'content-type': 'application/json',
      revision: '2023-10-15',
    },
    body: JSON.stringify({
      data: {
        type: 'profile',
        id,
        attributes: { properties },
      },
    }),
  });

  const txt = await patchRes.text();
  if (!patchRes.ok) {
    throw new Error(`Profile PATCH failed: ${patchRes.status} ${patchRes.statusText} :: ${txt}`);
  }
  return { ok: true, status: patchRes.status, body: txt };
}

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

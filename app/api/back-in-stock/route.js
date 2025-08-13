// app/api/back-in-stock/route.js — Server-side Subscribe Profiles (with list) + Redis
import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
  retry: { retries: 3, retryDelayOnFailover: 100 }
});

const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
// Back-in-stock WAITLIST Klaviyo list (set to your real list)
const BACK_IN_STOCK_LIST_ID = process.env.KLAVIYO_BACK_IN_STOCK_LIST_ID || 'WG9GbK';

/* ----------------- utils ----------------- */
function cors(resp, origin='*'){
  resp.headers.set('Access-Control-Allow-Origin', origin);
  resp.headers.set('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  resp.headers.set('Access-Control-Allow-Headers','Content-Type, Authorization');
  return resp;
}
function toE164(raw){
  if (!raw) return null;
  let v = String(raw).trim().replace(/[^\d+]/g, '');
  if (v.startsWith('+')) return /^\+\d{8,15}$/.test(v) ? v : null;   // strict E.164
  if (/^0\d{10}$/.test(v)) return '+234' + v.slice(1);               // NG local 0XXXXXXXXXX
  if (/^(70|80|81|90|91)\d{8}$/.test(v)) return '+234' + v;          // NG 10-digit
  if (/^\d{10}$/.test(v)) return '+1' + v;                           // US 10-digit
  return null;
}
function splitName(full){
  const s = String(full||'').trim();
  if (!s) return { first_name:'', last_name:'' };
  const parts = s.split(/\s+/);
  if (parts.length === 1) return { first_name: parts[0], last_name: '' };
  const first_name = parts.shift();
  const last_name  = parts.join(' ');
  return { first_name, last_name };
}

/* ----------------- CORS ----------------- */
export async function OPTIONS(request){
  return cors(new NextResponse(null, { status: 204 }), request.headers.get('origin') || '*');
}

/* ----------------- POST ----------------- */
export async function POST(request) {
  const origin = request.headers.get('origin') || '*';

  try {
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
      sms_consent = false
    } = body || {};

    // Validate
    if (!email || !product_id) {
      return cors(NextResponse.json({
        success: false, error: 'Missing required fields: email and product_id'
      }, { status: 400 }), origin);
    }
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim());
    if (!emailOk) {
      return cors(NextResponse.json({ success:false, error:'Invalid email format' }, { status:400 }), origin);
    }

    // Names
    if ((!first_name && !last_name) && full_name) {
      const spl = splitName(full_name);
      first_name = spl.first_name;
      last_name = spl.last_name;
    }

    // Normalize phone & compute sms eligibility
    const phoneE164 = toE164(phone);
    const smsAllowed = !!(sms_consent && phoneE164);

    // Redis upsert
    try { await redis.ping(); } catch {
      return cors(NextResponse.json({ success:false, error:'Database connection failed. Please try again.' }, { status:500 }), origin);
    }

    const key = `subscribers:${product_id}`;
    let subscribers = [];
    try {
      const existing = await redis.get(key);
      if (Array.isArray(existing)) subscribers = existing;
      else if (typeof existing === 'string') subscribers = JSON.parse(existing || '[]');
    } catch { subscribers = []; }

    if (subscribers.find(s => s?.email === email)) {
      return cors(NextResponse.json({
        success: true,
        message: 'You are already subscribed to notifications for this product',
        alreadySubscribed: true,
        subscriber_count: subscribers.length
      }), origin);
    }

    const newSubscriber = {
      email,
      phone: phoneE164 || '',
      product_id: String(product_id),
      product_title: product_title || 'Unknown Product',
      product_handle: product_handle || '',
      first_name: first_name || '',
      last_name: last_name || '',
      sms_consent: smsAllowed,
      notified: false,
      subscribed_at: new Date().toISOString(),
      ip_address: request.headers.get('x-forwarded-for') ||
                  request.headers.get('x-real-ip') || 'unknown'
    };

    subscribers.push(newSubscriber);
    try { await redis.set(key, subscribers, { ex: 30 * 24 * 60 * 60 }); }
    catch { return cors(NextResponse.json({ success:false, error:'Failed to save subscription. Please try again.' }, { status:500 }), origin); }

    // Klaviyo Subscribe Profiles (bulk create job)
    let klaviyo_success = false, klaviyo_status = 0, klaviyo_body = '';
    try {
      const out = await subscribeProfilesToList({
        listId: BACK_IN_STOCK_LIST_ID, email, phoneE164, sms: smsAllowed
      });
      klaviyo_success = out.ok; klaviyo_status = out.status; klaviyo_body = out.body;
    } catch (e) {
      klaviyo_success = false; klaviyo_status = 0; klaviyo_body = e?.message || String(e);
    }

    return cors(NextResponse.json({
      success: true,
      message: 'Successfully subscribed to back-in-stock notifications',
      subscriber_count: subscribers.length,
      klaviyo_success,
      klaviyo_status,
      klaviyo_body
    }), origin);

  } catch (error) {
    return cors(NextResponse.json({
      success:false, error:'Server error. Please try again.',
      details: process.env.NODE_ENV === 'development' ? error?.message : undefined
    }, { status:500 }), origin);
  }
}

/* ----------------- GET ----------------- */
export async function GET(request) {
  const origin = request.headers.get('origin') || '*';
  try {
    const { searchParams } = new URL(request.url);
    const email = searchParams.get('email');
    const product_id = searchParams.get('product_id');

    if (!email || !product_id) {
      return cors(NextResponse.json({
        success:false, error:'Missing email or product_id parameters'
      }, { status:400 }), origin);
    }

    await redis.ping();
    const key = `subscribers:${product_id}`;
    let subs = await redis.get(key) || [];
    if (typeof subs === 'string') { try { subs = JSON.parse(subs); } catch { subs = []; } }
    if (!Array.isArray(subs)) subs = [];

    const sub = subs.find(s => s?.email === email);
    return cors(NextResponse.json({
      success: true,
      subscribed: !!sub,
      total_subscribers: subs.length,
      subscription_details: sub ? {
        subscribed_at: sub.subscribed_at,
        notified: sub.notified,
        sms_consent: !!sub.sms_consent
      } : null
    }), origin);
  } catch (error) {
    return cors(NextResponse.json({ success:false, error:error?.message || 'Error' }, { status:500 }), origin);
  }
}

/* ----------------- Klaviyo Subscribe Profiles helper ----------------- */
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
              subscriptions
            }
          }
        ] }
      },
      relationships: { list: { data: { type: 'list', id: listId } } }
    }
  };

  const res = await fetch('https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/', {
    method: 'POST',
    headers: {
      'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      'accept': 'application/json',
      'content-type': 'application/json',
      'revision': '2024-10-15'
    },
    body: JSON.stringify(payload)
  });

  const body = await res.text(); // async job — acceptance is enough here
  if (!res.ok) throw new Error(`Subscribe Profiles failed: ${res.status} ${res.statusText} :: ${body}`);
  return { ok:true, status:res.status, body };
}

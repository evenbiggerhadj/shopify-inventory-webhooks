// app/api/klaviyo-smoke/route.js
import { NextResponse } from 'next/server';

const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
const LIST_ID = process.env.KLAVIYO_LIST_ID || process.env.KLAVIYO_BACK_IN_STOCK_ALERT_LIST_ID;

function cors(resp, origin='*'){ resp.headers.set('Access-Control-Allow-Origin', origin);
  resp.headers.set('Access-Control-Allow-Methods','POST,OPTIONS');
  resp.headers.set('Access-Control-Allow-Headers','Content-Type, Authorization');
  return resp; }

export async function OPTIONS() { return cors(new NextResponse(null,{status:204})); }

export async function POST(req) {
  const origin = req.headers.get('origin') || '*';
  try {
    const { email, phone_number, sms_consent=true, list_id } = await req.json();

    if (!KLAVIYO_API_KEY) return cors(
      NextResponse.json({ ok:false, error:'KLAVIYO_API_KEY missing' }, { status:500 }), origin);

    const lid = list_id || LIST_ID;
    if (!lid) return cors(
      NextResponse.json({ ok:false, error:'List ID missing' }, { status:400 }), origin);

    const payload = { profiles:[{ email, ...(phone_number?{ phone_number, sms_consent:!!sms_consent }:{} ) }] };

    const res = await fetch(`https://a.klaviyo.com/api/v2/list/${lid}/subscribe`, {
      method:'POST',
      headers:{ 'Authorization':`Klaviyo-API-Key ${KLAVIYO_API_KEY}`, 'Content-Type':'application/json' },
      body: JSON.stringify(payload)
    });

    const text = await res.text();
    return cors(
      new NextResponse(JSON.stringify({ ok: res.ok, status: res.status, body: text }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      }), origin);

  } catch (e) {
    return cors(
      NextResponse.json({ ok:false, error: e?.message || String(e) }, { status:500 }), origin);
  }
}

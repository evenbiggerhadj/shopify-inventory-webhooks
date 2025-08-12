// app/api/klaviyo-profile/route.js
// Simple debug endpoint to inspect what Klaviyo has on a profile

import { NextResponse } from 'next/server';

const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
const ALLOW_ORIGIN = '*'; // set to your domain if you want to restrict

function jsonRes(body, status = 200) {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': ALLOW_ORIGIN
    }
  });
}

async function kfetch(url) {
  if (!KLAVIYO_API_KEY) throw new Error('KLAVIYO_API_KEY not configured');
  return fetch(url, {
    headers: {
      'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      'revision': '2024-10-15',
      'Content-Type': 'application/json'
    }
  });
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const email = searchParams.get('email');
    if (!email) return jsonRes({ error: 'email required' }, 400);

    // Find by email
    let r = await kfetch(
      `https://a.klaviyo.com/api/profiles/?filter=equals(email,"${encodeURIComponent(email)}")`
    );
    if (!r.ok) return jsonRes({ error: 'lookup failed', status: r.status, text: await r.text() }, 502);

    const list = await r.json();
    const profile = list?.data?.[0];
    if (!profile) return jsonRes({ found: false });

    const pId = profile.id;

    // Pull full profile
    r = await kfetch(`https://a.klaviyo.com/api/profiles/${pId}/`);
    if (!r.ok) return jsonRes({ error: 'profile fetch failed', status: r.status, text: await r.text() }, 502);

    const detail = await r.json();

    return jsonRes({
      found: true,
      id: pId,
      email: detail?.data?.attributes?.email || null,
      phone_number: detail?.data?.attributes?.phone_number || null,
      subscriptions: detail?.data?.attributes?.subscriptions || null,
      properties: detail?.data?.attributes?.properties || null
    });
  } catch (e) {
    return jsonRes({ error: e.message }, 500);
  }
}

// CORS preflight (optional but handy)
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': ALLOW_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
}

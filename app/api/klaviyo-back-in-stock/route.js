import { NextResponse } from 'next/server';

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

export async function POST(req) {
  const body = await req.json();
  const { email, phone, bundle_handle, bundle_url, components } = body;

  const klaviyoPayload = {
    data: {
      type: "event",
      attributes: {
        profile: {
          email: email,
          phone_number: phone,
        },
        metric: {
          name: "Back-in-Stock Request",
        },
        properties: {
          bundle_handle,
          bundle_url,
          components,
        },
        time: new Date().toISOString(),
      },
    },
  };

  try {
    const klaviyoRes = await fetch('https://a.klaviyo.com/api/events/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
      },
      body: JSON.stringify(klaviyoPayload),
    });

    return new NextResponse(null, {
      status: klaviyoRes.ok ? 200 : 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error) {
    return new NextResponse(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}

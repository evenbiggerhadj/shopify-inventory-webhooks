import { NextResponse } from 'next/server';

export async function POST(req) {
  try {
    const { email, phone, bundle_handle, bundle_url, components } = await req.json();

    const klaviyoRes = await fetch('https://a.klaviyo.com/api/events/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
      },
      body: JSON.stringify({
        data: {
          type: 'event',
          attributes: {
            profile: {
              email: email,
              phone_number: phone,
            },
            metric: {
              name: 'Back-in-Stock Request',
            },
            properties: {
              bundle_handle,
              bundle_url,
              components,
            },
            time: new Date().toISOString(),
          },
        },
      }),
    });

    const data = await klaviyoRes.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Klaviyo API Error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

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

import { NextResponse } from 'next/server';

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': 'https://armadillotough.com',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { email, phone, variant_id, variant_title, product_handle } = body;

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
              variant_id,
              variant_title,
              product_handle,
            },
            time: new Date().toISOString(),
          },
        },
      }),
    });

    const data = await klaviyoRes.json();
    return new NextResponse(JSON.stringify(data), {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': 'https://armadillotough.com',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  } catch (error) {
    console.error('Klaviyo API Error:', error);
    return new NextResponse(
      JSON.stringify({ success: false, error: error.message }),
      {
        status: 500,
        headers: {
          'Access-Control-Allow-Origin': 'https://armadillotough.com',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      }
    );
  }
}

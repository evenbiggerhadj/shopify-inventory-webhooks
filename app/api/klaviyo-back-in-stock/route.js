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
  try {
    const klaviyoRes = await fetch('https://a.klaviyo.com/api/events/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
    if (!klaviyoRes.ok) {
        const errorText = await klaviyoRes.text();
        return new NextResponse(JSON.stringify({ success: false, error: errorText }), {
          status: klaviyoRes.status,
          headers: {
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
      const data = await klaviyoRes.json();
      return new NextResponse(JSON.stringify(data), {
        status: 200,
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

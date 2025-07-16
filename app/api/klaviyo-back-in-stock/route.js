import { NextResponse } from 'next/server';

export async function POST(req) {
  const body = await req.json();
  try {
    const klaviyoRes = await fetch('https://a.klaviyo.com/api/events/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`
      },
      body: JSON.stringify(body)
    });
    const data = await klaviyoRes.json();
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message });
  }
}

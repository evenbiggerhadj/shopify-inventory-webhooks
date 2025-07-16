// app/api/klaviyo-back-in-stock/route.js
import { NextResponse } from 'next/server';

export async function POST(req) {
  try {
    const body = await req.json();

    const klaviyoRes = await fetch("https://a.klaviyo.com/api/events/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`
      },
      body: JSON.stringify(body)
    });

    const result = await klaviyoRes.json();

    return NextResponse.json({ success: true, result });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ success: false, error: error.message });
  }
}

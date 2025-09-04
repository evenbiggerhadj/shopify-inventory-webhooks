// app/api/track/estes/route.js
import { NextResponse } from 'next/server';

const ENDPOINT =
  'https://www.estes-express.com/shipmenttracking/services/ShipmentTrackingService';

// CORS helper (allow your storefront; keep '*' if you don't care)
function withCORS(res) {
  res.headers.set('Access-Control-Allow-Origin', process.env.CORS_ALLOW || '*');
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  res.headers.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
  return res;
}

export async function OPTIONS() {
  return withCORS(new NextResponse(null, { status: 204 }));
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const pro = (searchParams.get('pro') || '').replace(/\D/g, ''); // keep leading zeros
    if (!pro) {
      return withCORS(NextResponse.json({ error: 'Missing or invalid PRO' }, { status: 400 }));
    }

    const user = process.env.ESTES_USER;
    const pass = process.env.ESTES_PASS;
    if (!user || !pass) {
      return withCORS(NextResponse.json({ error: 'Server missing Estes credentials' }, { status: 500 }));
    }

    const soap = `
      <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                        xmlns:ship="http://ws.estesexpress.com/shipmenttracking"
                        xmlns:s1="http://ws.estesexpress.com/schema/2012/12/shipmenttracking">
        <soapenv:Header>
          <ship:auth>
            <ship:user>${user}</ship:user>
            <ship:password>${pass}</ship:password>
          </ship:auth>
        </soapenv:Header>
        <soapenv:Body>
          <s1:search>
            <s1:requestID>${Date.now()}</s1:requestID>
            <s1:pro>${pro}</s1:pro>
          </s1:search>
        </soapenv:Body>
      </soapenv:Envelope>
    `.trim();

    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': 'search'
      },
      body: soap
    });

    const xml = await resp.text();
    if (!resp.ok) {
      return withCORS(
        NextResponse.json({ error: 'Estes service error', status: resp.status }, { status: resp.status })
      );
    }

    // super-light parsing
    const pick = (re) => (xml.match(re) || [])[1] || null;
    const status =
      pick(/<ship:statusDescription>\s*([^<]+)\s*<\/ship:statusDescription>/i) ||
      pick(/<statusDescription>\s*([^<]+)\s*<\/statusDescription>/i) ||
      pick(/<ship:status>\s*([^<]+)\s*<\/ship:status>/i);
    const est1 = pick(/<ship:deliveryDate>\s*([^<]+)\s*<\/ship:deliveryDate>/i);
    const est2 = pick(/<ship:firstDeliveryDate>\s*([^<]+)\s*<\/ship:firstDeliveryDate>/i);
    const estimatedDelivery = est1 || est2;
    const pieces = pick(/<ship:pieces>\s*([^<]+)\s*<\/ship:pieces>/i);
    const weight = pick(/<ship:weight>\s*([^<]+)\s*<\/ship:weight>/i);

    const events = [];
    const reEvent = /<ship:shipmentEvent>[\s\S]*?<\/ship:shipmentEvent>/gi;
    let m;
    while ((m = reEvent.exec(xml))) {
      const block = m[0];
      const when = (block.match(/<ship:eventDateTime>\s*([^<]+)\s*<\/ship:eventDateTime>/i) || [])[1] || null;
      const desc = (block.match(/<ship:event>\s*([^<]+)\s*<\/ship:event>/i) || [])[1] || null;
      const city = (block.match(/<ship:city>\s*([^<]+)\s*<\/ship:city>/i) || [])[1] || null;
      const state = (block.match(/<ship:state>\s*([^<]+)\s*<\/ship:state>/i) || [])[1] || null;
      events.push({ when, desc, city, state });
    }

    const res = NextResponse.json({
      carrier: 'Estes',
      pro,
      status,
      estimatedDelivery,
      pieces,
      weight,
      events
    });
    res.headers.set('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return withCORS(res);
  } catch (err) {
    return withCORS(NextResponse.json({ error: 'Server exception', details: String(err) }, { status: 500 }));
  }
}

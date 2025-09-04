// app/api/track/estes/route.js
import { NextResponse } from 'next/server';
const ENDPOINT = 'https://www.estes-express.com/shipmenttracking/services/ShipmentTrackingService';

function withCORS(res) {
  res.headers.set('Access-Control-Allow-Origin', process.env.CORS_ALLOW || '*'); // permissive until you set it must
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  res.headers.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
  return res;
}
export function OPTIONS() { return withCORS(new NextResponse(null, { status: 204 })); }

function mockPayload(pro) {
  return {
    carrier: 'Estes',
    pro,
    status: 'In Transit',
    estimatedDelivery: '09/04/2025 – 09/10/2025',
    pieces: '12',
    weight: '748',
    events: [
      { when: '2025-09-03 08:12', desc: 'Departed Terminal', city: 'Richmond', state: 'VA' },
      { when: '2025-09-02 14:03', desc: 'Arrived at Terminal', city: 'Richmond', state: 'VA' },
      { when: '2025-09-01 09:55', desc: 'Picked Up', city: 'Raleigh', state: 'NC' }
    ]
  };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const raw = (searchParams.get('pro') || '').toString();
    const pro = raw.replace(/\D/g, ''); // keep leading zeros
    const mock = searchParams.get('mock') === '1';
    if (!pro) return withCORS(NextResponse.json({ error: 'Missing or invalid PRO' }, { status: 400 }));

    // If no creds yet or mock=1 → return fake but realistic data so you can wire the UI now
    const user = process.env.ESTES_USER, pass = process.env.ESTES_PASS;
    if (mock || !user || !pass) {
      const res = NextResponse.json(mockPayload(pro));
      res.headers.set('Cache-Control', 'no-store');
      return withCORS(res);
    }

    // Live SOAP call
    const soap = `
      <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                        xmlns:ship="http://ws.estesexpress.com/shipmenttracking"
                        xmlns:s1="http://ws.estesexpress.com/schema/2012/12/shipmenttracking">
        <soapenv:Header>
          <ship:auth><ship:user>${user}</ship:user><ship:password>${pass}</ship:password></ship:auth>
        </soapenv:Header>
        <soapenv:Body>
          <s1:search><s1:requestID>${Date.now()}</s1:requestID><s1:pro>${pro}</s1:pro></s1:search>
        </soapenv:Body>
      </soapenv:Envelope>`.trim();

    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': 'search' },
      body: soap
    });
    const xml = await resp.text();
    if (!resp.ok) {
      return withCORS(NextResponse.json({ error: 'Estes service error', status: resp.status }, { status: resp.status }));
    }

    const pick = (re) => (xml.match(re) || [])[1] || null;
    const status =
      pick(/<ship:statusDescription>\s*([^<]+)\s*<\/ship:statusDescription>/i) ||
      pick(/<statusDescription>\s*([^<]+)\s*<\/statusDescription>/i) ||
      pick(/<ship:status>\s*([^<]+)\s*<\/ship:status>/i);
    const est = pick(/<ship:deliveryDate>\s*([^<]+)\s*<\/ship:deliveryDate>/i) ||
                pick(/<ship:firstDeliveryDate>\s*([^<]+)\s*<\/ship:firstDeliveryDate>/i);
    const pieces = pick(/<ship:pieces>\s*([^<]+)\s*<\/ship:pieces>/i);
    const weight = pick(/<ship:weight>\s*([^<]+)\s*<\/ship:weight>/i);

    const events = [];
    const reEvent = /<ship:shipmentEvent>[\s\S]*?<\/ship:shipmentEvent>/gi; let m;
    while ((m = reEvent.exec(xml))) {
      const b = m[0];
      events.push({
        when:  (b.match(/<ship:eventDateTime>\s*([^<]+)\s*<\/ship:eventDateTime>/i) || [])[1] || null,
        desc:  (b.match(/<ship:event>\s*([^<]+)\s*<\/ship:event>/i) || [])[1] || null,
        city:  (b.match(/<ship:city>\s*([^<]+)\s*<\/ship:city>/i) || [])[1] || null,
        state: (b.match(/<ship:state>\s*([^<]+)\s*<\/ship:state>/i) || [])[1] || null
      });
    }

    const res = NextResponse.json({ carrier: 'Estes', pro, status, estimatedDelivery: est, pieces, weight, events });
    res.headers.set('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return withCORS(res);
  } catch (e) {
    return withCORS(NextResponse.json({ error: 'Server exception', details: String(e) }, { status: 500 }));
  }
}


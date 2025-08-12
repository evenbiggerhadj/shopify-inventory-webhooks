import { NextResponse } from "next/server";

const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
const ALLOW_ORIGIN = '*';
function json(body, status = 200) {
    return new NextResponse(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': ALLOW_ORIGIN }
    });
}
function parseFullName(full) {
    if (!full) return { first: '', last: '' };
    const parts = String(full).trim().split(/\s+/);
    if (parts.length === 1) return { first: parts[0], last: '' };
    return { first: parts.slice(0, -1).join(' '), last: parts.slice(-1).join(' ') };
}
function formatPhoneE164(raw) {
    if (!raw) return null;
    let v = String(raw).replace(/[^\d+]/g, '');
    if (v.startsWith('+') && v.length >= 8) return v;
    if (/^0\d{10}$/.test(v)) return '+234' + v.slice(1);
    if (/^(70|80|90|81|91)\d{8}$/.test(v)) return '+234' + v;
    if (/^\d{10}$/.test(v)) return '+1' + v;
    if (/^\d{11,15}$/.test(v)) return '+' + v;
    return null;
}

async function kfetch(url, opts = {}) {
    if (!KLAVIYO_API_KEY) throw new Error('KLAVIYO_API_KEY missing');
    const { method = 'GET', body, headers = {} } = opts;
    return fetch(url, {
        method,
        headers: { 'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`, 'Content-Type': 'application/json', 'revision': '2024-10-15', ...headers },
        body
    });
}

async function createOrGet(email, first_name = '', last_name = '') {
    const payload = { data: { type: 'profile', attributes: { email, first_name, last_name } } };
    let r = await kfetch('https://a.klaviyo.com/api/profiles/', { method: 'POST', body: JSON.stringify(payload) });
    if (r.ok) { const j = await r.json(); return j?.data?.id || null; }
    if (r.status === 409) {
        r = await kfetch(`https://a.klaviyo.com/api/profiles/?filter=equals(email,"${encodeURIComponent(email)}")`);
        if (r.ok) { const j = await r.json(); return j?.data?.[0]?.id || null; }
    }
    return null;
}

async function setSms(profileId, phoneE164) {
    const payload = {
        data: {
            type: 'profile', id: profileId, attributes: {
                phone_number: phoneE164,
                subscriptions: { sms: { marketing: { consent: true, consented_at: new Date().toISOString(), method: 'Manual Test Endpoint' } } }
            }
        }
    };
    return kfetch(`https://a.klaviyo.com/api/profiles/${profileId}/`, { method: 'PATCH', body: JSON.stringify(payload) });
}

export async function OPTIONS() {
    return new NextResponse(null, {
        status: 200,
        headers: {
            'Access-Control-Allow-Origin': ALLOW_ORIGIN,
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
    });
}

export async function GET(request) {
    try {
        const { searchParams } = new URL(request.url);
        const email = searchParams.get('email');
        if (!email) return json({ success: false, error: 'email is required' }, 400);
        const r = await kfetch(`https://a.klaviyo.com/api/profiles/?filter=equals(email,"${encodeURIComponent(email)}")`);
        const j = await r.json();
        return json({ success: true, raw: j });
    } catch (e) {
        return json({ success: false, error: e.message }, 500);
    }
}

export async function POST(request) {
    try {
        const { email, full_name = '', sms_consent = false, phone = '' } = await request.json();
        if (!email) return json({ success: false, error: 'email is required' }, 400);

        const { first, last } = parseFullName(full_name);
        const profileId = await createOrGet(email, first, last);
        if (!profileId) return json({ success: false, error: 'failed to ensure profile' }, 500);

        if (sms_consent && phone) {
            const e164 = formatPhoneE164(phone);
            if (!e164) return json({ success: true, message: 'profile ensured; invalid phone for SMS', sms: false, phone }, 200);
            const r = await setSms(profileId, e164);
            if (!r.ok) return json({ success: true, message: 'profile ensured; SMS failed', sms: false, sms_error: await r.text() }, 200);
            return json({ success: true, message: 'profile ensured; SMS consent set', sms: true, phone: e164 }, 200);
        }

        return json({ success: true, message: 'profile ensured; SMS not requested', sms: false }, 200);
    } catch (e) {
        return json({ success: false, error: e.message }, 500);
    }
}

// app/api/audit-bundles/route.js
// Bundle auditor that:
// - respects Shopify Admin API rate limits (2 rps-ish with adaptive backoff)
// - reads bundle_structure metafield, checks component inventory
// - tags bundle product with bundle-ok / -understocked / -out-of-stock
// - when recovering to OK, adds subscribers (email+sms consent) to Klaviyo LIST_ID
// - uses strict E.164, safe storefront URLs, structured logging

import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

// ====== ENV ======
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE; // e.g., your-store.myshopify.com
const ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_KEY;
const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
const KLAVIYO_LIST_ID = process.env.KLAVIYO_LIST_ID;
const STOREFRONT_BASE_URL = process.env.STOREFRONT_BASE_URL || (SHOPIFY_STORE?.startsWith('https://') ? SHOPIFY_STORE : `https://${SHOPIFY_STORE}`);

// Guards
if (!SHOPIFY_STORE || !ADMIN_API_TOKEN) console.warn('[audit] Missing Shopify envs');
if (!KV_URL || !KV_TOKEN) console.warn('[audit] Missing Upstash envs');
if (!KLAVIYO_API_KEY) console.warn('[audit] Missing KLAVIYO_API_KEY');
if (!KLAVIYO_LIST_ID) console.warn('[audit] Missing KLAVIYO_LIST_ID');

const redis = new Redis({ url: KV_URL, token: KV_TOKEN });

// ====== Shared Utils ======
function jsonOK(body, init = {}) {
  return new NextResponse(JSON.stringify(body), {
    status: init.status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

function jsonErr(message, status = 500, extra = {}) {
  return jsonOK({ success: false, error: message, ...extra }, { status });
}

function toE164(raw) {
  if (!raw) return null;
  let v = String(raw).trim().replace(/[^\d+]/g, '');
  if (v.startsWith('+')) return /^\+\d{8,15}$/.test(v) ? v : null;
  if (/^0\d{10}$/.test(v)) return '+234' + v.slice(1);
  if (/^(70|80|81|90|91)\d{8}$/.test(v)) return '+234' + v;
  if (/^\d{10}$/.test(v)) return '+1' + v;
  return null;
}

async function safeFetch(url, opts = {}, label = 'fetch', retry = 1) {
  try {
    const res = await fetch(url, opts);
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`[${label}] ${res.status} ${res.statusText} — ${t.slice(0, 800)}`);
    }
    return res;
  } catch (e) {
    if (retry > 0) {
      console.warn(`[${label}] retrying once: ${e.message}`);
      await new Promise((r) => setTimeout(r, 800));
      return safeFetch(url, opts, label, retry - 1);
    }
    throw e;
  }
}

// Klaviyo v2 Subscribe (consent-aware)
async function klaviyoSubscribe({ email, phoneE164, listId, smsConsent }) {
  const payload = {
    profiles: [
      {
        email,
        ...(smsConsent && phoneE164
          ? { sms_consent: true, phone_number: phoneE164 }
          : {})
      }
    ]
  };

  await safeFetch(
    `https://a.klaviyo.com/api/v2/list/${listId}/subscribe`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`
      },
      body: JSON.stringify(payload)
    },
    'klaviyo:subscribe',
    0
  );
  return true;
}

// ====== Shopify Client with rate limit ======
let lastCall = 0;
let dynamicDelay = 600; // ms; start under 2 rps

async function rateDelay() {
  const now = Date.now();
  const since = now - lastCall;
  if (since < dynamicDelay) {
    await new Promise((r) => setTimeout(r, dynamicDelay - since));
  }
  lastCall = Date.now();
}

async function shopify(endpoint, method = 'GET', body = null, label = 'shopify') {
  await rateDelay();

  const headers = {
    'X-Shopify-Access-Token': ADMIN_API_TOKEN,
    'Content-Type': 'application/json'
  };

  // Clean build
  const clean = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
  const url = endpoint.startsWith('http') ? endpoint : `https://${SHOPIFY_STORE}/admin/api/2024-04/${clean}`;

  const res = await fetch(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {})
  });

  if (res.status === 429) {
    console.warn('[shopify] 429 rate-limited; backing off 2s and retrying once');
    dynamicDelay = Math.min(1500, dynamicDelay + 150); // widen spacing
    await new Promise((r) => setTimeout(r, 2000));
    lastCall = Date.now();
    const retry = await fetch(url, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (!retry.ok) {
      const t = await retry.text().catch(() => '');
      throw new Error(`[shopify retry] ${retry.status} ${retry.statusText} — ${t.slice(0, 500)}`);
    }
    return retry.json();
  }

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`[${label}] ${res.status} ${res.statusText} — ${t.slice(0, 800)}`);
  }

  // success path: gently tighten delay if stable
  dynamicDelay = Math.max(400, dynamicDelay - 10);
  return res.json();
}

async function getBundleProducts() {
  const out = await shopify('products.json?fields=id,title,tags,handle&limit=250', 'GET', null, 'products:list');
  return (out.products || []).filter((p) => (p.tags || '').toLowerCase().includes('bundle'));
}

async function getMetafields(productId) {
  const out = await shopify(`products/${productId}/metafields.json`, 'GET', null, 'metafields');
  return out.metafields || [];
}

async function getVariantInventory(variantId) {
  const out = await shopify(`variants/${variantId}.json`, 'GET', null, 'variant');
  return out?.variant?.inventory_quantity ?? 0;
}

async function updateProductTags(productId, currentTags, status) {
  const normalized = String(currentTags || '')
    .split(',')
    .map((t) => String(t || '').trim())
  const cleaned = normalized.filter((t) => !['bundle-ok', 'bundle-understocked', 'bundle-out-of-stock'].includes(t.toLowerCase()));
  cleaned.push(`bundle-${status}`);
  await shopify(
    `products/${productId}.json`,
    'PUT',
    { product: { id: productId, tags: cleaned.join(', ') } },
    'product:update:tags'
  );
}

// ====== Redis storage ======
async function getBundleStatus(productId) {
  const o = await redis.get(`status:${productId}`);
  return o ? (typeof o === 'string' ? JSON.parse(o) : o) : null;
}

async function setBundleStatus(productId, prev, curr) {
  await redis.set(`status:${productId}`, { previous: prev || null, current: curr }, { ex: 90 * 24 * 60 * 60 });
}

async function getSubscribers(productId) {
  const raw = await redis.get(`subscribers:${productId}`);
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : []; } catch { return []; }
}

async function setSubscribers(productId, subs) {
  await redis.set(`subscribers:${productId}`, subs, { ex: 30 * 24 * 60 * 60 });
}

// ====== Core Audit ======
async function auditBundles() {
  const start = Date.now();
  const bundles = await getBundleProducts();

  console.log('[audit] found bundles', { count: bundles.length });

  let processed = 0;
  let notificationsSent = 0;
  let notificationErrors = 0;
  let apiCallsApprox = 1; // initial products call

  for (const bundle of bundles) {
    processed++;
    const pTitle = bundle.title;
    console.log(`\n[audit] ${processed}/${bundles.length} → ${pTitle}`);

    try {
      // Metafield: custom.bundle_structure
      const mfs = await getMetafields(bundle.id);
      apiCallsApprox++;
      const mf = mfs.find((m) => m.namespace === 'custom' && m.key === 'bundle_structure');

      if (!mf || !mf.value) {
        console.log('[audit] skip: no bundle_structure metafield');
        continue;
      }

      let components = [];
      try {
        components = JSON.parse(mf.value);
        if (!Array.isArray(components)) throw new Error('bundle_structure not array');
      } catch {
        console.warn('[audit] invalid bundle_structure JSON');
        continue;
      }

      // Inventory checks
      let under = [];
      let out = [];
      for (const comp of components) {
        if (!comp?.variant_id) {
          console.warn('[audit] component missing variant_id', comp);
          continue;
        }
        const inv = await getVariantInventory(comp.variant_id);
        apiCallsApprox++;
        const req = Number(comp.required_quantity || 1) || 1;

        if (inv <= 0) out.push(comp.variant_id);
        else if (inv < req) under.push(comp.variant_id);
      }

      let status = 'ok';
      if (out.length > 0) status = 'out-of-stock';
      else if (under.length > 0) status = 'understocked';

      const prev = (await getBundleStatus(bundle.id))?.current || null;
      await setBundleStatus(bundle.id, prev, status);

      console.log('[audit] status', { title: pTitle, prev: prev || 'unknown', curr: status });

      // If recovered to OK: notify subscribers via Klaviyo list subscribe
      if ((prev === 'understocked' || prev === 'out-of-stock') && status === 'ok') {
        console.log('[audit] recovered → notifying subscribers...');
        const subs = await getSubscribers(bundle.id);
        console.log('[audit] subscribers', { count: subs.length });

        for (const sub of subs) {
          if (!sub || sub.notified) continue;
          try {
            const phoneE164 = sub.phone ? toE164(sub.phone) : null;

            // Consent email always; SMS only if we have number + prior consent flag
            await klaviyoSubscribe({
              email: sub.email,
              phoneE164,
              listId: KLAVIYO_LIST_ID,
              smsConsent: !!sub.sms_consent && !!phoneE164
            });

            sub.notified = true;
            notificationsSent++;
          } catch (e) {
            notificationErrors++;
            console.error('[audit] notify fail', { email: sub.email, msg: e.message });
          }
        }

        await setSubscribers(bundle.id, subs);
      }

      // Update product tags
      await updateProductTags(bundle.id, bundle.tags || '', status);
      apiCallsApprox++;

      const elapsed = Math.round((Date.now() - start) / 1000);
      const left = Math.max(0, bundles.length - processed);
      const avg = processed ? (elapsed / processed) : 0;
      console.log('[audit] progress', {
        processed,
        total: bundles.length,
        elapsed_s: elapsed,
        eta_s: Math.round(left * avg),
        api_calls_approx: apiCallsApprox,
        dynamic_delay_ms: dynamicDelay
      });
    } catch (e) {
      console.error('[audit] bundle error', { title: pTitle, msg: e.message });
      // continue to next bundle
    }
  }

  const totalTime = Math.round((Date.now() - start) / 1000);
  console.log('\n[audit] done', {
    processed,
    notificationsSent,
    notificationErrors,
    totalTime_s: totalTime,
    approx_rate_calls_per_s: (apiCallsApprox / Math.max(1, totalTime)).toFixed(2)
  });

  return {
    bundlesProcessed: processed,
    notificationsSent,
    notificationErrors,
    totalTimeSeconds: totalTime,
    apiCallsApprox,
    avgApiCallRate: apiCallsApprox / Math.max(1, totalTime),
    timestamp: new Date().toISOString()
  };
}

// ====== Handler ======
export async function GET() {
  try {
    console.log('🚀 [audit] start');
    const result = await auditBundles();
    return jsonOK({ success: true, message: 'Audit complete and tags updated.', ...result });
  } catch (e) {
    console.error('❌ [audit] fatal', e.message);
    return jsonErr(e.message || 'Audit failed', 500);
  }
}

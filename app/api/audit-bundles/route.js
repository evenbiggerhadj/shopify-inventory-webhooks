// app/api/audit-bundles/route.js

/* ---- Vercel runtime & max duration (within your plan limits) ---- */
export const runtime = 'nodejs';
export const maxDuration = 300;

import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

/* ----------------- Env & Redis ----------------- */
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const SHOPIFY_STORE   = process.env.SHOPIFY_STORE;                // e.g. "armadillotough.myshopify.com"
const ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_KEY;
const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
const ALERT_LIST_ID   = process.env.KLAVIYO_BACK_IN_STOCK_ALERT_LIST_ID;
const PUBLIC_STORE_DOMAIN = process.env.PUBLIC_STORE_DOMAIN || 'armadillotough.com';
const CRON_SECRET = process.env.CRON_SECRET || '';                 // used to authorize Vercel Cron

function assertEnv() {
  const missing = [];
  if (!SHOPIFY_STORE)   missing.push('SHOPIFY_STORE');
  if (!ADMIN_API_TOKEN) missing.push('SHOPIFY_ADMIN_API_KEY');
  if (!KLAVIYO_API_KEY) missing.push('KLAVIYO_API_KEY');
  if (!ALERT_LIST_ID)   missing.push('KLAVIYO_BACK_IN_STOCK_ALERT_LIST_ID');
  if (missing.length) throw new Error(`Missing env: ${missing.join(', ')}`);
}

/* ----------------- Vercel Cron auth & overlap lock ----------------- */
function unauthorized() {
  return NextResponse.json({ success: false, error: 'unauthorized' }, { status: 401 });
}

async function ensureCronAuth(req) {
  // If CRON_SECRET is set, require `Authorization: Bearer <CRON_SECRET>`
  if (!CRON_SECRET) return true; // allow in dev if not configured
  const auth = req.headers.get('authorization') || '';
  return auth === `Bearer ${CRON_SECRET}`;
}

const LOCK_KEY = 'locks:audit-bundles';
const LOCK_TTL_SECONDS = 15 * 60; // safety window

async function acquireLock() {
  // NX = only if not exists; EX = expire after TTL
  try {
    const res = await redis.set(LOCK_KEY, Date.now(), { nx: true, ex: LOCK_TTL_SECONDS });
    return !!res; // 'OK' => true, null => false
  } catch {
    return false;
  }
}
async function releaseLock() {
  try { await redis.del(LOCK_KEY); } catch {}
}

/* ----------------- utils ----------------- */
function toE164(raw) {
  if (!raw) return null;
  let v = String(raw).trim().replace(/[^\d+]/g, '');
  if (v.startsWith('+')) return /^\+\d{8,15}$/.test(v) ? v : null; // strict E.164
  if (/^0\d{10}$/.test(v)) return '+234' + v.slice(1);            // NG local 0XXXXXXXXXX
  if (/^(70|80|81|90|91)\d{8}$/.test(v)) return '+234' + v;       // NG 10-digit
  if (/^\d{10}$/.test(v)) return '+1' + v;                         // US 10-digit
  return null;
}
const emailKey = (e) => `email:${String(e || '').toLowerCase()}`;
const productUrlFrom = (handle) => handle ? `https://${PUBLIC_STORE_DOMAIN}/products/${handle}` : '';
function extractStatusFromTags(tagsStr) {
  const tags = String(tagsStr || '').split(',').map(t => t.trim().toLowerCase());
  if (tags.includes('bundle-out-of-stock')) return 'out-of-stock';
  if (tags.includes('bundle-understocked')) return 'understocked';
  if (tags.includes('bundle-ok')) return 'ok';
  return null;
}

/* ----------------- Klaviyo ----------------- */
async function subscribeProfilesToList({ listId, email, phoneE164, sms }) {
  if (!KLAVIYO_API_KEY) throw new Error('KLAVIYO_API_KEY missing');
  if (!listId) throw new Error('listId missing');
  if (!email) throw new Error('email missing');

  const subscriptions = { email: { marketing: { consent: 'SUBSCRIBED' } } };
  if (sms && phoneE164) subscriptions.sms = { marketing: { consent: 'SUBSCRIBED' } };

  const payload = {
    data: {
      type: 'profile-subscription-bulk-create-job',
      attributes: {
        profiles: { data: [
          { type: 'profile', attributes: { email, ...(sms && phoneE164 ? { phone_number: phoneE164 } : {}), subscriptions } },
        ]},
      },
      relationships: { list: { data: { type: 'list', id: listId } } },
    },
  };

  const res = await fetch('https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/', {
    method: 'POST',
    headers: {
      Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      accept: 'application/json',
      'content-type': 'application/json',
      revision: '2023-10-15',
    },
    body: JSON.stringify(payload),
  });

  const body = await res.text();
  if (!res.ok) throw new Error(`Klaviyo subscribe failed: ${res.status} ${res.statusText} :: ${body}`);
  return { ok: true, status: res.status, body };
}

async function updateProfileProperties({ email, properties }) {
  if (!KLAVIYO_API_KEY) throw new Error('KLAVIYO_API_KEY missing');
  if (!email) throw new Error('email missing');

  // GET profile id by email → PATCH properties
  const filter = `equals(email,"${String(email).replace(/"/g, '\\"')}")`;
  const listRes = await fetch(
    `https://a.klaviyo.com/api/profiles/?filter=${encodeURIComponent(filter)}&page[size]=1`,
    {
      method: 'GET',
      headers: {
        Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        accept: 'application/json',
        revision: '2023-10-15',
      },
    }
  );
  if (!listRes.ok) {
    const txt = await listRes.text();
    throw new Error(`Profiles lookup failed: ${listRes.status} ${listRes.statusText} :: ${txt}`);
  }
  const listJson = await listRes.json();
  const id = listJson?.data?.[0]?.id;
  if (!id) return { ok: false, status: 404, body: 'profile_not_found', skipped: true };

  const patchRes = await fetch(`https://a.klaviyo.com/api/profiles/${id}/`, {
    method: 'PATCH',
    headers: {
      Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      accept: 'application/json',
      'content-type': 'application/json',
      revision: '2023-10-15',
    },
    body: JSON.stringify({
      data: { type: 'profile', id, attributes: { properties } },
    }),
  });

  const txt = await patchRes.text();
  if (!patchRes.ok) throw new Error(`Profile PATCH failed: ${patchRes.status} ${patchRes.statusText} :: ${txt}`);
  return { ok: true, status: patchRes.status, body: txt };
}

async function trackKlaviyoEvent({ metricName, email, phoneE164, properties }) {
  if (!KLAVIYO_API_KEY) throw new Error('KLAVIYO_API_KEY missing');
  if (!metricName) throw new Error('metricName missing');

  const body = {
    data: {
      type: 'event',
      attributes: {
        time: new Date().toISOString(),
        properties: properties || {},
        metric: { data: { type: 'metric', attributes: { name: metricName } } },
        profile: { data: { type: 'profile', attributes: { email, ...(phoneE164 ? { phone_number: phoneE164 } : {}) } } }
      }
    }
  };

  const res = await fetch('https://a.klaviyo.com/api/events/', {
    method: 'POST',
    headers: {
      Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      accept: 'application/json',
      'content-type': 'application/json',
      revision: '2023-10-15',
    },
    body: JSON.stringify(body),
  });

  const txt = await res.text();
  if (!res.ok) throw new Error(`Klaviyo event failed: ${res.status} ${res.statusText} :: ${txt}`);
  return { ok: true, status: res.status, body: txt };
}

/* ----------------- Shopify (rate-limited) ----------------- */
let lastApiCall = 0;
const MIN_DELAY_MS = 600; // ~1.67 rps (safe under 2/sec)
async function rateLimitedDelay() {
  const now = Date.now();
  const dt = now - lastApiCall;
  if (dt < MIN_DELAY_MS) await new Promise(r => setTimeout(r, MIN_DELAY_MS - dt));
  lastApiCall = Date.now();
}
async function fetchFromShopify(endpoint, method = 'GET', body = null) {
  if (!endpoint || typeof endpoint !== 'string') {
    throw new Error(`fetchFromShopify called with invalid endpoint: "${endpoint}"`);
  }
  await rateLimitedDelay();

  const headers = {
    'X-Shopify-Access-Token': ADMIN_API_TOKEN,
    'Content-Type': 'application/json',
  };
  const opts = { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) };

  const url = endpoint.startsWith('http')
    ? endpoint
    : `https://${SHOPIFY_STORE}/admin/api/2024-04/${endpoint.replace(/^\//, '')}`;

  const res = await fetch(url, opts);
  if (!res.ok) {
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, 2000));
      lastApiCall = Date.now();
      const retry = await fetch(url, opts);
      if (!retry.ok) {
        const t = await retry.text();
        throw new Error(`Shopify API error after retry: ${retry.status} ${retry.statusText} - ${t}`);
      }
      return retry.json();
    }
    const t = await res.text();
    throw new Error(`Shopify API error: ${res.status} ${res.statusText} - ${t}`);
  }
  return res.json();
}
function hasBundleTag(tagsStr) {
  return String(tagsStr || '')
    .split(',')
    .map(t => t.trim().toLowerCase())
    .includes('bundle');
}
async function getProductsTaggedBundle() {
  const res = await fetchFromShopify('products.json?fields=id,title,tags,handle&limit=250');
  return res.products.filter(p => hasBundleTag(p.tags));
}
async function getProductMetafields(productId) {
  const res = await fetchFromShopify(`products/${productId}/metafields.json`);
  if (!res || !Array.isArray(res.metafields)) return null;
  return res.metafields.find(m => m.namespace === 'custom' && m.key === 'bundle_structure');
}
async function getInventoryLevel(variantId) {
  if (!variantId) return 0;
  const res = await fetchFromShopify(`variants/${variantId}.json`);
  return res.variant.inventory_quantity;
}
async function updateProductTags(productId, currentTags, status) {
  const cleaned = currentTags
    .map(t => t.trim())
    .filter(tag => !['bundle-ok', 'bundle-understocked', 'bundle-out-of-stock'].includes(tag.toLowerCase()))
    .concat([`bundle-${status}`]);

  await fetchFromShopify(`products/${productId}.json`, 'PUT', {
    product: { id: productId, tags: cleaned.join(', ') },
  });
}

/* ----------------- Redis helpers (status + subscribers for id & handle) ----------------- */
async function getBundleStatus(productId) {
  return (await redis.get(`status:${productId}`)) || null;
}
async function setBundleStatus(productId, prevStatus, currStatus) {
  await redis.set(`status:${productId}`, { previous: prevStatus, current: currStatus });
}

/** Read & merge subscribers saved under BOTH keys */
async function getSubscribersForBundle(bundle) {
  const keys = [
    `subscribers:${bundle.id}`,
    `subscribers_handle:${bundle.handle}`
  ];
  const lists = await Promise.all(keys.map(async (k) => {
    const v = await redis.get(k);
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return []; } }
    return [];
  }));
  // merge by unique key (phone E.164 > email), prefer newest re-arm/subscribed
  const map = new Map();
  const keyFor = (s) => toE164(s?.phone || '') || emailKey(s?.email);
  const ts = (s) => Date.parse(s?.last_rearmed_at || s?.subscribed_at || 0);
  for (const list of lists) {
    for (const s of list) {
      const k = keyFor(s);
      const prev = map.get(k);
      if (!prev || ts(s) >= ts(prev)) map.set(k, s);
    }
  }
  const merged = Array.from(map.values());
  return { merged, keysTried: keys };
}

/** Persist updated subscribers back to BOTH keys */
async function setSubscribersForBundle(bundle, subs) {
  await Promise.all([
    redis.set(`subscribers:${bundle.id}`, subs, { ex: 90 * 24 * 60 * 60 }),
    redis.set(`subscribers_handle:${bundle.handle}`, subs, { ex: 90 * 24 * 60 * 60 }),
  ]);
}

/* ----------------- main audit ----------------- */
async function auditBundles() {
  assertEnv();

  console.log('🔍 Starting bundle audit (pending-first, id+handle lookup)…');
  const start = Date.now();

  const bundles = await getProductsTaggedBundle();
  console.log(`📦 Found ${bundles.length} bundles`);

  let bundlesProcessed = 0;
  let notificationsSent = 0;
  let smsNotificationsSent = 0;
  let notificationErrors = 0;
  let profileUpdates = 0;
  let apiCallsCount = 1;

  for (const bundle of bundles) {
    try {
      bundlesProcessed++;
      console.log(`\n📦 ${bundlesProcessed}/${bundles.length} — ${bundle.title}`);

      const metafield = await getProductMetafields(bundle.id);
      apiCallsCount++;
      if (!metafield?.value) { console.log('⚠️ Skipped — no bundle_structure metafield'); continue; }

      let components;
      try { components = JSON.parse(metafield.value); }
      catch { console.error('❌ Invalid bundle_structure JSON'); continue; }

      let under = [], out = [];
      for (const c of components) {
        if (!c?.variant_id) continue;
        const qty = await getInventoryLevel(c.variant_id);
        apiCallsCount++;
        if (qty === 0) out.push(c.variant_id);
        else if (qty < c.required_quantity) under.push(c.variant_id);
      }

      let status = 'ok';
      if (out.length) status = 'out-of-stock';
      else if (under.length) status = 'understocked';

      // determine previous status via Redis, fallback to tags on product
      const prevObj = await getBundleStatus(bundle.id);
      const prevStatus = prevObj?.current ?? extractStatusFromTags(bundle.tags);
      await setBundleStatus(bundle.id, prevStatus || null, status);
      console.log(`📊 ${bundle.title}: ${(prevStatus || 'unknown')} → ${status}`);

      // read subscribers from both ID & HANDLE keys
      const { merged: uniqueSubs, keysTried } = await getSubscribersForBundle(bundle);
      const pending = uniqueSubs.filter(s => !s?.notified);
      console.log(`🧾 Waitlist: keys=${JSON.stringify(keysTried)} total=${uniqueSubs.length} pending=${pending.length}`);

      // Notify whenever stock is OK and there are pending subscribers (pending-first)
      const shouldNotify = (status === 'ok') && pending.length > 0;

      if (shouldNotify) {
        const productUrl = productUrlFrom(bundle.handle);
        console.log(`🔔 Back in stock — notifying ${pending.length} pending subscribers`);

        let processed = 0;
        for (const sub of pending) {
          try {
            const phoneE164 = toE164(sub.phone || '');
            const smsConsent = !!sub.sms_consent && !!phoneE164;

            // 1) Ensure they're on the ALERT list (email/sms consent honored)
            await subscribeProfilesToList({
              listId: ALERT_LIST_ID,
              email: sub.email,
              phoneE164,
              sms: smsConsent,
            });

            // 2) Stamp product props (best-effort)
            const stampedTitle = sub.product_title || bundle.title || 'Unknown Product';
            const stampedHandle = sub.product_handle || bundle.handle || '';
            const stampedUrl = sub.product_url || productUrlFrom(stampedHandle) || productUrl;
            const related_section_url = stampedUrl ? `${stampedUrl}#after-bis` : '';

            try {
              const out = await updateProfileProperties({
                email: sub.email,
                properties: {
                  last_back_in_stock_product_name: stampedTitle,
                  last_back_in_stock_product_url: stampedUrl,
                  last_back_in_stock_related_section_url: related_section_url,

                  last_back_in_stock_product_handle: stampedHandle,
                  last_back_in_stock_product_id: String(bundle.id),
                  last_back_in_stock_notified_at: new Date().toISOString(),
                },
              });
              if (out.ok) profileUpdates++;
            } catch (e) {
              console.warn('⚠️ Profile props write failed, continuing:', e.message);
            }

            // 3) Fire the event used by your notification flow
            await trackKlaviyoEvent({
              metricName: 'Back in Stock',
              email: sub.email,
              phoneE164,
              properties: {
                product_id: String(bundle.id),
                product_title: stampedTitle,
                product_handle: stampedHandle,
                product_url: stampedUrl,
                related_section_url: related_section_url,

                sms_consent: !!smsConsent,
                source: 'bundle audit',
              }
            });

            // 4) Mark as notified + gentle pacing
            sub.notified = true;
            notificationsSent++;
            if (smsConsent) smsNotificationsSent++;
            if (++processed % 5 === 0) await new Promise(r => setTimeout(r, 250));
          } catch (e) {
            notificationErrors++;
            console.error(`❌ Failed for ${sub?.email || '(unknown)'}:`, e.message);
          }
        }

        // write back to BOTH keys so future audits see consistent state
        await setSubscribersForBundle(bundle, uniqueSubs);
      } else {
        console.log('ℹ️ No notifications: either status != ok or no pending subscribers.');
      }

      // update tags
      await updateProductTags(bundle.id, bundle.tags.split(','), status);
      apiCallsCount++;

      const elapsed = (Date.now() - start) / 1000;
      const avg = elapsed / bundlesProcessed;
      const left = (bundles.length - bundlesProcessed) * avg;
      console.log(`⏱️ ${bundlesProcessed}/${bundles.length} done — ~${Math.round(left)}s remaining`);
      console.log(`📈 API calls so far: ${apiCallsCount} (~${(apiCallsCount / elapsed).toFixed(2)}/s)`);

    } catch (err) {
      console.error(`❌ Error on bundle "${bundle.title}":`, err.message);
    }
  }

  const total = (Date.now() - start) / 1000;
  console.log('\n✅ Audit complete');
  console.log(`📦 Bundles processed: ${bundlesProcessed}`);
  console.log(`📧 Email subs: ${notificationsSent}`);
  console.log(`📱 SMS subs: ${smsNotificationsSent}`);
  console.log(`🧾 Profile updates: ${profileUpdates}`);
  console.log(`❌ Errors: ${notificationErrors}`);
  console.log(`⏱️ ${Math.round(total)}s total, ${apiCallsCount} API calls`);

  return {
    bundlesProcessed,
    notificationsSent,
    smsNotificationsSent,
    profileUpdates,
    notificationErrors,
    totalTimeSeconds: total,
    apiCallsCount,
    avgApiCallRate: apiCallsCount / total,
    timestamp: new Date().toISOString(),
  };
}

/* ----------------- GET handler ----------------- */
export async function GET(req) {
  // 1) Verify this came from your Vercel Cron (or allow if CRON_SECRET unset in dev)
  const authed = await ensureCronAuth(req);
  if (!authed) return unauthorized();

  // 2) Prevent overlapping runs (cron + manual trigger or long execution)
  const locked = await acquireLock();
  if (!locked) {
    return NextResponse.json({ success: false, error: 'audit already running' }, { status: 423 });
  }

  try {
    const results = await auditBundles();
    return NextResponse.json({
      success: true,
      message: 'Audit complete and tags updated (pending-first + id/handle waitlist).',
      ...results,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error.message, stack: process.env.NODE_ENV === 'development' ? error.stack : undefined },
      { status: 500 }
    );
  } finally {
    await releaseLock();
  }
}

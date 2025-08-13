// app/api/audit-bundles/route.js — Audit bundles + notify waitlist (Klaviyo Subscribe Profiles + profile props)
import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

/* ----------------- env ----------------- */
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;                // e.g. "armadillotough.myshopify.com"
const ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_KEY;
const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;

// ALERT list (used when stock returns to OK) — do NOT fall back to waitlist list
const ALERT_LIST_ID = process.env.KLAVIYO_BACK_IN_STOCK_ALERT_LIST_ID;

const PUBLIC_STORE_DOMAIN = process.env.PUBLIC_STORE_DOMAIN || 'armadillotough.com'; // used to build product URL

/* ----------------- guards ----------------- */
function assertEnv() {
  const missing = [];
  if (!SHOPIFY_STORE) missing.push('SHOPIFY_STORE');
  if (!ADMIN_API_TOKEN) missing.push('SHOPIFY_ADMIN_API_KEY');
  if (!KLAVIYO_API_KEY) missing.push('KLAVIYO_API_KEY');
  if (!ALERT_LIST_ID) missing.push('KLAVIYO_BACK_IN_STOCK_ALERT_LIST_ID');
  if (missing.length) throw new Error(`Missing env: ${missing.join(', ')}`);
}

/* ----------------- utils ----------------- */
function toE164(raw) {
  if (!raw) return null;
  let v = String(raw).trim().replace(/[^\d+]/g, '');
  if (v.startsWith('+')) return /^\+\d{8,15}$/.test(v) ? v : null; // strict E.164
  if (/^0\d{10}$/.test(v)) return '+234' + v.slice(1);            // NG local 0XXXXXXXXXX
  if (/^(70|80|81|90|91)\d{8}$/.test(v)) return '+234' + v;       // NG 10-digit mobile prefixes
  if (/^\d{10}$/.test(v)) return '+1' + v;                         // US 10-digit
  return null;
}
const emailKey = (e) => `email:${String(e || '').toLowerCase()}`;
const productUrlFrom = (handle) =>
  handle ? `https://${PUBLIC_STORE_DOMAIN}/products/${handle}` : '';

/** Klaviyo: Subscribe Profiles bulk job — with list relationship (records consent properly). */
async function subscribeProfilesToList({ listId, email, phoneRaw, smsConsent }) {
  if (!KLAVIYO_API_KEY) throw new Error('KLAVIYO_API_KEY missing');
  if (!listId) throw new Error('listId missing');
  if (!email) throw new Error('email missing');

  const phoneE164 = toE164(phoneRaw);
  const subscriptions = { email: { marketing: { consent: 'SUBSCRIBED' } } };
  if (smsConsent && phoneE164) subscriptions.sms = { marketing: { consent: 'SUBSCRIBED' } };

  const payload = {
    data: {
      type: 'profile-subscription-bulk-create-job',
      attributes: {
        profiles: {
          data: [
            {
              type: 'profile',
              attributes: {
                email,
                ...(smsConsent && phoneE164 ? { phone_number: phoneE164 } : {}),
                subscriptions,
              },
            },
          ],
        },
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
      revision: '2024-10-15',
    },
    body: JSON.stringify(payload),
  });

  const body = await res.text(); // async job; acceptance is success path
  if (!res.ok) throw new Error(`Klaviyo subscribe failed: ${res.status} ${res.statusText} :: ${body}`);
  return { ok: true, status: res.status, body };
}

/** Klaviyo: Profile bulk update — stamp product name/URL onto profile for flow templates */
async function updateProfileProperties({ email, properties }) {
  if (!KLAVIYO_API_KEY) throw new Error('KLAVIYO_API_KEY missing');
  if (!email) throw new Error('email missing');

  const payload = {
    data: {
      type: 'profile-bulk-update-job',
      attributes: {
        profiles: {
          data: [{
            type: 'profile',
            attributes: { email, properties },
          }],
        },
      },
    },
  };

  const res = await fetch('https://a.klaviyo.com/api/profile-bulk-update-jobs/', {
    method: 'POST',
    headers: {
      Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      accept: 'application/json',
      'content-type': 'application/json',
      revision: '2024-10-15',
    },
    body: JSON.stringify(payload),
  });

  const body = await res.text();
  if (!res.ok) throw new Error(`Profile properties update failed: ${res.status} ${res.statusText} :: ${body}`);
  return { ok: true, status: res.status, body };
}

/* ----------------- Shopify rate limiting ----------------- */
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

/* ----------------- Shopify helpers ----------------- */
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
    .filter(tag => !['bundle-ok', 'bundle-understocked', 'bundle-out-of-stock'].includes(tag.trim().toLowerCase()))
    .concat([`bundle-${status}`]);

  await fetchFromShopify(`products/${productId}.json`, 'PUT', {
    product: { id: productId, tags: cleaned.join(', ') },
  });
}

/* ----------------- Redis helpers ----------------- */
async function getBundleStatus(productId) {
  return (await redis.get(`status:${productId}`)) || null;
}
async function setBundleStatus(productId, prevStatus, currStatus) {
  await redis.set(`status:${productId}`, { previous: prevStatus, current: currStatus });
}
async function getSubscribers(productId) {
  const result = await redis.get(`subscribers:${productId}`);
  if (!result) return [];
  if (typeof result === 'string') {
    try { return JSON.parse(result); } catch { return []; }
  }
  return Array.isArray(result) ? result : [];
}
async function setSubscribers(productId, subs) {
  await redis.set(`subscribers:${productId}`, subs);
}

/* ----------------- main audit ----------------- */
async function auditBundles() {
  assertEnv();

  console.log('🔍 Starting bundle audit with proper Klaviyo subscribe flow...');
  const start = Date.now();

  const bundles = await getProductsTaggedBundle();
  console.log(`📦 Found ${bundles.length} bundles`);

  let bundlesProcessed = 0;
  let notificationsSent = 0;
  let smsNotificationsSent = 0;
  let notificationErrors = 0;
  let profileUpdates = 0;
  let apiCallsCount = 1; // already fetched products

  for (const bundle of bundles) {
    try {
      bundlesProcessed++;
      console.log(`\n📦 ${bundlesProcessed}/${bundles.length} — ${bundle.title}`);

      const metafield = await getProductMetafields(bundle.id);
      apiCallsCount++;
      if (!metafield?.value) {
        console.log(`⚠️ Skipped — no bundle_structure metafield`);
        continue;
      }

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

      const prev = await getBundleStatus(bundle.id);
      const prevStatus = prev ? prev.current : null;
      await setBundleStatus(bundle.id, prevStatus, status);
      console.log(`📊 ${bundle.title}: ${prevStatus || 'unknown'} → ${status}`);

      // If moving back to OK, notify all not-yet-notified subscribers
      if ((prevStatus === 'understocked' || prevStatus === 'out-of-stock') && status === 'ok') {
        const subs = (await getSubscribers(bundle.id)) || [];

        // de-dupe by normalized phone; fall back to email
        const seen = new Set();
        const uniqueSubs = [];
        for (const s of subs) {
          const phoneKey = toE164(s?.phone || '');
          const key = phoneKey || emailKey(s?.email);
          if (seen.has(key)) continue;
          seen.add(key);
          uniqueSubs.push(s); // keep reference to original object
        }

        const productUrl = productUrlFrom(bundle.handle);
        console.log(
          `🔔 Back in stock — notifying ${uniqueSubs.filter(s => !s?.notified).length} unique subscribers`
        );

        let processed = 0;
        for (const sub of uniqueSubs) {
          if (!sub || sub.notified) continue;
          try {
            const phoneE164 = toE164(sub.phone || '');
            const smsConsent = !!sub.sms_consent && !!phoneE164;

            // 1) Ensure they're on the ALERT list (email/sms consent honored)
            await subscribeProfilesToList({
              listId: ALERT_LIST_ID,
              email: sub.email,
              phoneRaw: phoneE164 || sub.phone || '',
              smsConsent,
            });

            // 2) Stamp product props so flow templates can show product name & URL
            const stampedTitle =
              sub.product_title || bundle.title || 'Unknown Product';
            const stampedHandle = sub.product_handle || bundle.handle || '';
            const stampedUrl =
              sub.product_url || productUrlFrom(stampedHandle) || productUrl;

            await updateProfileProperties({
              email: sub.email,
              properties: {
                last_back_in_stock_product_name: stampedTitle,
                last_back_in_stock_product_url: stampedUrl,
                last_back_in_stock_product_handle: stampedHandle,
                last_back_in_stock_product_id: String(bundle.id),
                last_back_in_stock_notified_at: new Date().toISOString(),
              },
            });
            profileUpdates++;

            // mark notified
            sub.notified = true;
            notificationsSent++;
            if (smsConsent) smsNotificationsSent++;

            if (++processed % 5 === 0) await new Promise(r => setTimeout(r, 250)); // gentle pacing
          } catch (e) {
            notificationErrors++;
            console.error(`❌ Failed for ${sub?.email || '(unknown)'}:`, e.message);
          }
        }

        // persist updated notified flags back to Redis
        await setSubscribers(bundle.id, subs);
      }

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
export async function GET() {
  try {
    const results = await auditBundles();
    return NextResponse.json({
      success: true,
      message: 'Audit complete and tags updated (Klaviyo Subscribe Profiles + profile props).',
      ...results,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      },
      { status: 500 },
    );
  }
}

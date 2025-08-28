/* ---- Vercel runtime & max duration ---- */
export const runtime = 'nodejs';
export const maxDuration = 300;

import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

/* ----------------- Env & Redis ----------------- */
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const SHOPIFY_STORE         = process.env.SHOPIFY_STORE; // e.g. "armadillotough.myshopify.com"
const ADMIN_API_TOKEN       = process.env.SHOPIFY_ADMIN_API_KEY;

const KLAVIYO_API_KEY       = process.env.KLAVIYO_API_KEY;
const ALERT_LIST_ID         = process.env.KLAVIYO_BACK_IN_STOCK_ALERT_LIST_ID;

const PUBLIC_STORE_DOMAIN   = process.env.PUBLIC_STORE_DOMAIN || 'armadillotough.com';
const CRON_SECRET           = process.env.CRON_SECRET || ''; // authorize Vercel Cron

// NEW: Storefront for accurate bundle availability (matches "Bundle with X in stock")
const STOREFRONT_API_TOKEN   = process.env.SHOPIFY_STOREFRONT_API_TOKEN || '';
const STOREFRONT_API_VERSION = process.env.SHOPIFY_STOREFRONT_API_VERSION || '2024-07';

// Optional "low stock" threshold for understocked via storefront quantityAvailable
const LOW_STOCK_THRESHOLD    = Number(process.env.BUNDLE_LOW_STOCK_THRESHOLD || 0);

function assertEnv() {
  const missing = [];
  if (!SHOPIFY_STORE)   missing.push('SHOPIFY_STORE');
  if (!ADMIN_API_TOKEN) missing.push('SHOPIFY_ADMIN_API_KEY');
  if (!KLAVIYO_API_KEY) missing.push('KLAVIYO_API_KEY');
  if (!ALERT_LIST_ID)   missing.push('KLAVIYO_BACK_IN_STOCK_ALERT_LIST_ID');
  if (!STOREFRONT_API_TOKEN) missing.push('SHOPIFY_STOREFRONT_API_TOKEN');
  if (missing.length) throw new Error(`Missing env: ${missing.join(', ')}`);
}

/* ----------------- Cron auth & overlap lock ----------------- */
function unauthorized() {
  return NextResponse.json({ success: false, error: 'unauthorized' }, { status: 401 });
}
async function ensureCronAuth(req) {
  if (!CRON_SECRET) return true;
  const auth = req.headers.get('authorization') || '';
  return auth === `Bearer ${CRON_SECRET}`;
}
const LOCK_KEY = 'locks:audit-bundles';
const LOCK_TTL_SECONDS = 15 * 60;
async function acquireLock() {
  try { return !!(await redis.set(LOCK_KEY, Date.now(), { nx: true, ex: LOCK_TTL_SECONDS })); }
  catch { return false; }
}
async function releaseLock() { try { await redis.del(LOCK_KEY); } catch {} }

/* ----------------- utils ----------------- */
function toE164(raw) {
  if (!raw) return null;
  let v = String(raw).trim().replace(/[^\d+]/g, '');
  if (v.startsWith('+')) return /^\+\d{8,15}$/.test(v) ? v : null;
  if (/^0\d{10}$/.test(v)) return '+234' + v.slice(1);
  if (/^(70|80|81|90|91)\d{8}$/.test(v)) return '+234' + v;
  if (/^\d{10}$/.test(v)) return '+1' + v;
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
const RANK = { 'ok': 0, 'understocked': 1, 'out-of-stock': 2 };
function worstStatus(...statuses) {
  return statuses.reduce((w, s) => (RANK[s] >= RANK[w] ? s : w), 'ok');
}

/* ----------------- Klaviyo helpers ----------------- */
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
        profiles: { data: [{ type: 'profile', attributes: { email, ...(sms && phoneE164 ? { phone_number: phoneE164 } : {}), subscriptions } }] },
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

  const filter = `equals(email,"${String(email).replace(/"/g, '\\"')}")`;
  const listRes = await fetch(
    `https://a.klaviyo.com/api/profiles/?filter=${encodeURIComponent(filter)}&page[size]=1`,
    { method: 'GET', headers: { Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`, accept: 'application/json', revision: '2023-10-15' } }
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
    body: JSON.stringify({ data: { type: 'profile', id, attributes: { properties } } }),
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

/* ----------------- Shopify Admin (REST) ----------------- */
let lastApiCall = 0;
const MIN_DELAY_MS = 600; // ~1.67 rps
async function rateLimitedDelay() {
  const now = Date.now();
  const dt = now - lastApiCall;
  if (dt < MIN_DELAY_MS) await new Promise(r => setTimeout(r, MIN_DELAY_MS - dt));
  lastApiCall = Date.now();
}
async function fetchFromShopify(endpoint, method = 'GET', body = null) {
  if (!endpoint || typeof endpoint !== 'string') throw new Error(`Invalid endpoint: "${endpoint}"`);
  await rateLimitedDelay();

  const headers = { 'X-Shopify-Access-Token': ADMIN_API_TOKEN, 'Content-Type': 'application/json' };
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

/* ----------------- Shopify Storefront (GraphQL) ----------------- */
async function fetchStorefrontGraphQL(query, variables = {}) {
  const url = `https://${SHOPIFY_STORE}/api/${STOREFRONT_API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Storefront-Access-Token': STOREFRONT_API_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    throw new Error(`Storefront GraphQL error: ${res.status} ${res.statusText} :: ${JSON.stringify(json.errors || json)}`);
  }
  return json;
}

/* ----------------- Bundle discovery & data ----------------- */
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
async function getVariant(id) {
  const res = await fetchFromShopify(`variants/${id}.json`);
  return res.variant;
}
async function getInventoryLevel(variantId) {
  if (!variantId) return 0;
  const v = await getVariant(variantId);
  return Number(v?.inventory_quantity ?? 0);
}

/** Admin REST: get bundle product variants including their GraphQL IDs (used by Storefront). */
async function getProductVariantsWithGids(productId) {
  const res = await fetchFromShopify(`products/${productId}.json?fields=id,variants`);
  const variants = res?.product?.variants || [];
  // Each variant has `admin_graphql_api_id`
  return variants.map(v => ({
    id: v.id,
    gid: v.admin_graphql_api_id,
    inventory_quantity: Number(v?.inventory_quantity ?? 0),
  }));
}

/** Storefront GraphQL: quantityAvailable for a list of variant GIDs. */
async function getQuantityAvailableForVariantGids(gids) {
  if (!gids.length) return [];
  const q = `
    query ($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          quantityAvailable
        }
      }
    }
  `;
  const out = await fetchStorefrontGraphQL(q, { ids: gids });
  const nodes = out?.data?.nodes || [];
  return nodes
    .filter(n => n && n.id)
    .map(n => ({ gid: n.id, quantityAvailable: Number(n.quantityAvailable ?? 0) }));
}

/** Shopify Bundles–aligned availability for the *bundle product itself* (min per variant). */
async function getBundleStorefrontAvailability(productId) {
  const variants = await getProductVariantsWithGids(productId);
  const gids = variants.map(v => v.gid).filter(Boolean);
  if (!gids.length) {
    return { minAvailable: 0, byVariant: [], variantsCount: 0 };
  }
  // Storefront returns the computed availability Shopify uses on PDP/admin (“Bundle with X in stock”)
  const qtys = await getQuantityAvailableForVariantGids(gids);
  const byGid = new Map(qtys.map(x => [x.gid, x.quantityAvailable]));
  const byVariant = variants.map(v => ({
    id: v.id,
    gid: v.gid,
    quantityAvailable: Number(byGid.get(v.gid) ?? 0),
  }));
  const minAvailable = byVariant.length ? Math.min(...byVariant.map(x => x.quantityAvailable)) : 0;
  return { minAvailable, byVariant, variantsCount: byVariant.length };
}

/** Bundle product’s own (REST) inventory snapshot (fallback only). */
async function getBundleOwnInventorySummary(productId) {
  const variants = await getProductVariantsWithGids(productId);
  const qtys = variants.map(v => Number(v.inventory_quantity || 0));
  const total = qtys.reduce((a, b) => a + b, 0);
  const anyNegative = qtys.some(q => q < 0);
  const allZero = variants.length > 0 && qtys.every(q => q === 0);
  return { total, anyNegative, variantsCount: variants.length, outOfStock: allZero, understocked: anyNegative || total < 0 };
}

/* ----------------- Redis helpers ----------------- */
async function getBundleStatus(productId) { return (await redis.get(`status:${productId}`)) || null; }
async function setBundleStatus(productId, prevStatus, currStatus) {
  await redis.set(`status:${productId}`, { previous: prevStatus, current: currStatus });
}

/** Read & merge subscribers saved under BOTH keys */
async function getSubscribersForBundle(bundle) {
  const keys = [`subscribers:${bundle.id}`, `subscribers_handle:${bundle.handle}`];
  const lists = await Promise.all(keys.map(async (k) => {
    const v = await redis.get(k);
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return []; } }
    return [];
  }));
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
async function setSubscribersForBundle(bundle, subs) {
  await Promise.all([
    redis.set(`subscribers:${bundle.id}`, subs, { ex: 90 * 24 * 60 * 60 }),
    redis.set(`subscribers_handle:${bundle.handle}`, subs, { ex: 90 * 24 * 60 * 60 }),
  ]);
}

/* ----------------- Tag updates ----------------- */
async function updateProductTags(productId, currentTags, status) {
  const cleaned = currentTags
    .map(t => t.trim())
    .filter(tag => !['bundle-ok', 'bundle-understocked', 'bundle-out-of-stock'].includes(tag.toLowerCase()))
    .concat([`bundle-${status}`]);
  await fetchFromShopify(`products/${productId}.json`, 'PUT', { product: { id: productId, tags: cleaned.join(', ') } });
}

/* ----------------- main audit ----------------- */
async function auditBundles() {
  assertEnv();

  console.log('🔍 Starting bundle audit (components + own + storefront availability)…');
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

      /* 1) COMPONENTS (your metafield) */
      let componentsStatus = 'ok';
      const metafield = await getProductMetafields(bundle.id);
      apiCallsCount++;

      if (metafield?.value) {
        let components;
        try { components = JSON.parse(metafield.value); }
        catch { console.error('❌ Invalid bundle_structure JSON'); components = []; }

        let under = [], out = [];
        for (const c of components) {
          if (!c?.variant_id) continue;
          const qty = await getInventoryLevel(c.variant_id);
          apiCallsCount++;
          if (qty <= 0) out.push(c.variant_id);
          else if (qty < (Number(c.required_quantity) || 1)) under.push(c.variant_id);
        }
        if (out.length) componentsStatus = 'out-of-stock';
        else if (under.length) componentsStatus = 'understocked';
      } else {
        console.log('ℹ️ No bundle_structure metafield — componentsStatus defaults to OK');
      }

      /* 2) BUNDLE OWN INVENTORY (REST fallback) */
      const ownInv = await getBundleOwnInventorySummary(bundle.id);
      apiCallsCount++;
      let ownStatus = 'ok';
      if (ownInv.outOfStock) ownStatus = 'out-of-stock';
      else if (ownInv.understocked) ownStatus = 'understocked';

      /* 3) STOREFRONT quantityAvailable (Shopify Bundles’ computed availability) */
      const sf = await getBundleStorefrontAvailability(bundle.id);
      apiCallsCount++; // storefront call (batched nodes)
      let sfStatus = 'ok';
      if (sf.minAvailable <= 0) sfStatus = 'out-of-stock';
      else if (LOW_STOCK_THRESHOLD > 0 && sf.minAvailable <= LOW_STOCK_THRESHOLD) sfStatus = 'understocked';

      /* FINAL: worst of the three */
      const status = worstStatus(componentsStatus, ownStatus, sfStatus);

      // previous vs current (redis fallback to tags)
      const prevObj = await getBundleStatus(bundle.id);
      const prevStatus = prevObj?.current ?? extractStatusFromTags(bundle.tags);
      await setBundleStatus(bundle.id, prevStatus || null, status);

      console.log(
        `📊 ${bundle.title} ⇒ components=${componentsStatus} | own(total=${ownInv.total}, anyNeg=${ownInv.anyNegative}, variants=${ownInv.variantsCount})=${ownStatus} | storefront(minAvail=${sf.minAvailable}, variants=${sf.variantsCount})=${sfStatus} ⇒ FINAL=${status}`
      );

      /* Waitlist read */
      const { merged: uniqueSubs, keysTried } = await getSubscribersForBundle(bundle);
      const pending = uniqueSubs.filter(s => !s?.notified);
      console.log(`🧾 Waitlist: keys=${JSON.stringify(keysTried)} total=${uniqueSubs.length} pending=${pending.length}`);

      /* Notify when OK + pending subscribers */
      const shouldNotify = (status === 'ok') && pending.length > 0;

      if (shouldNotify) {
        const productUrl = productUrlFrom(bundle.handle);
        console.log(`🔔 Back in stock — notifying ${pending.length} pending subscribers`);

        let processed = 0;
        for (const sub of pending) {
          try {
            const phoneE164 = toE164(sub.phone || '');
            const smsConsent = !!sub.sms_consent && !!phoneE164;

            await subscribeProfilesToList({
              listId: ALERT_LIST_ID,
              email: sub.email,
              phoneE164,
              sms: smsConsent,
            });

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
              console.warn('⚠️ Profile props write failed (continuing):', e.message);
            }

            await trackKlaviyoEvent({
              metricName: 'Back in Stock',
              email: sub.email,
              phoneE164,
              properties: {
                product_id: String(bundle.id),
                product_title: stampedTitle,
                product_handle: stampedHandle,
                product_url: stampedUrl,
                related_section_url,
                sms_consent: !!smsConsent,
                source: 'bundle audit',
              }
            });

            sub.notified = true;
            notificationsSent++;
            if (smsConsent) smsNotificationsSent++;
            if (++processed % 5 === 0) await new Promise(r => setTimeout(r, 250));
          } catch (e) {
            notificationErrors++;
            console.error(`❌ Notify failed for ${sub?.email || '(unknown)'}:`, e.message);
          }
        }
        await setSubscribersForBundle(bundle, uniqueSubs);
      } else {
        console.log('ℹ️ No notifications: either status != ok or no pending subscribers.');
      }

      /* Update product tags */
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
  const authed = await ensureCronAuth(req);
  if (!authed) return unauthorized();

  const locked = await acquireLock();
  if (!locked) {
    return NextResponse.json({ success: false, error: 'audit already running' }, { status: 423 });
  }

  try {
    const results = await auditBundles();
    return NextResponse.json({
      success: true,
      message: 'Audit complete and tags updated (components + own + storefront availability).',
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

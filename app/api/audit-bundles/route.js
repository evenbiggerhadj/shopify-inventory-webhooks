// app/api/audit-bundles/route.js
export const runtime = 'nodejs';
export const maxDuration = 300;

import { NextResponse, after } from 'next/server';
import { Redis } from '@upstash/redis';
import { randomUUID } from 'crypto';

/* ----------------- Env & Redis ----------------- */
const redis = new Redis({
  // Support either KV_REST_API_URL or KV_URL naming
  url: process.env.KV_REST_API_URL || process.env.KV_URL,
  token: process.env.KV_REST_API_TOKEN, // require write token
});

const SHOPIFY_STORE       = process.env.SHOPIFY_STORE; // "yourstore.myshopify.com"
const ADMIN_API_TOKEN     = process.env.SHOPIFY_ADMIN_API_KEY;
const KLAVIYO_API_KEY     = process.env.KLAVIYO_API_KEY;
const ALERT_LIST_ID       = process.env.KLAVIYO_BACK_IN_STOCK_ALERT_LIST_ID;
const PUBLIC_STORE_DOMAIN = process.env.PUBLIC_STORE_DOMAIN || 'example.com';
const CRON_SECRET         = process.env.CRON_SECRET || '';

function assertEnv() {
  const missing = [];
  if (!SHOPIFY_STORE)   missing.push('SHOPIFY_STORE');
  if (!ADMIN_API_TOKEN) missing.push('SHOPIFY_ADMIN_API_KEY');
  if (!KLAVIYO_API_KEY) missing.push('KLAVIYO_API_KEY');
  if (!ALERT_LIST_ID)   missing.push('KLAVIYO_BACK_IN_STOCK_ALERT_LIST_ID');
  if (!process.env.KV_REST_API_URL && !process.env.KV_URL) missing.push('KV_REST_API_URL');
  if (!process.env.KV_REST_API_TOKEN) missing.push('KV_REST_API_TOKEN');
  if (missing.length) throw new Error(`Missing env: ${missing.join(', ')}`);
}

/* ----------------- Cron auth & locking ----------------- */
function unauthorized() {
  return NextResponse.json({ success: false, error: 'unauthorized' }, { status: 401 });
}
async function ensureCronAuth(req) {
  if (req.headers.get('x-vercel-cron')) return true;
  if (!CRON_SECRET) return true;
  const auth = req.headers.get('authorization') || '';
  if (auth === `Bearer ${CRON_SECRET}`) return true;
  const url = new URL(req.url);
  if (url.searchParams.get('token') === CRON_SECRET) return true;
  return false;
}

const LOCK_KEY    = 'locks:audit-bundles';
const CURSOR_KEY  = 'audit:cursor';
const LOCK_TTL_SECONDS = 15 * 60;

async function acquireOrValidateLock(runId) {
  const holder = await redis.get(LOCK_KEY);
  if (!holder) {
    const res = await redis.set(LOCK_KEY, runId, { nx: true, ex: LOCK_TTL_SECONDS });
    return !!res;
  }
  if (holder === runId) {
    await redis.expire(LOCK_KEY, LOCK_TTL_SECONDS);
    return true;
  }
  return false;
}
async function releaseLock(runId) {
  try {
    const holder = await redis.get(LOCK_KEY);
    if (holder === runId) await redis.del(LOCK_KEY);
  } catch {}
}

/* ----------------- Tunables ----------------- */
const MIN_DELAY_MS   = Number(process.env.SHOPIFY_THROTTLE_MS || 500);
const TIME_BUDGET_MS = Number(process.env.TIME_BUDGET_MS || 240000);

/* ----------------- Small utils ----------------- */
const productUrlFrom = (handle) =>
  handle ? `https://${PUBLIC_STORE_DOMAIN}/products/${handle}` : '';

function hasBundleTag(tagsStr) {
  return String(tagsStr || '')
    .split(',')
    .map(t => t.trim().toLowerCase())
    .includes('bundle');
}

const RANK = { ok: 0, understocked: 1, 'out-of-stock': 2 };
const worstStatus = (a = 'ok', b = 'ok') => (RANK[a] >= RANK[b]) ? a : b;

function extractStatusFromTags(tagsStr) {
  const tags = String(tagsStr || '').split(',').map(t => t.trim().toLowerCase());
  if (tags.includes('bundle-out-of-stock')) return 'out-of-stock';
  if (tags.includes('bundle-understocked')) return 'understocked';
  if (tags.includes('bundle-ok'))           return 'ok';
  return null;
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
      attributes: { profiles: { data: [ { type: 'profile', attributes: { email, ...(sms && phoneE164 ? { phone_number: phoneE164 } : {}), subscriptions } } ] } },
      relationships: { list: { data: { type: 'list', id: listId } } },
    },
  };

  const res = await fetch('https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/', {
    method: 'POST',
    headers: {
      'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      'accept': 'application/json',
      'content-type': 'application/json',
      'revision': '2023-10-15',
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
  const listRes = await fetch(`https://a.klaviyo.com/api/profiles/?filter=${encodeURIComponent(filter)}&page[size]=1`, {
    method: 'GET',
    headers: {
      'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      'accept': 'application/json',
      'revision': '2023-10-15',
    },
  });
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
      'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      'accept': 'application/json',
      'content-type': 'application/json',
      'revision': '2023-10-15',
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
        profile: { data: { type: 'profile', attributes: { email, ...(phoneE164 ? { phone_number: phoneE164 } : {}) } } },
      },
    },
  };

  const res = await fetch('https://a.klaviyo.com/api/events/', {
    method: 'POST',
    headers: {
      'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      'accept': 'application/json',
      'content-type': 'application/json',
      'revision': '2023-10-15',
    },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Klaviyo event failed: ${res.status} ${res.statusText} :: ${txt}`);
  return { ok: true, status: res.status, body: txt };
}

/* ----------------- Shopify helpers ----------------- */
let lastApiCall = 0;
async function rateLimitedDelay() {
  const now = Date.now();
  const dt = now - lastApiCall;
  if (dt < MIN_DELAY_MS) await new Promise(r => setTimeout(r, MIN_DELAY_MS - dt));
  lastApiCall = Date.now();
}

// REST (list products, update tags, etc.)
const REST_VERSION = '2025-01';
async function fetchShopifyREST(endpointOrUrl, method = 'GET', body = null, raw = false) {
  if (!endpointOrUrl || typeof endpointOrUrl !== 'string') {
    throw new Error(`fetchShopifyREST called with invalid endpoint: "${endpointOrUrl}"`);
  }
  await rateLimitedDelay();

  const headers = {
    'X-Shopify-Access-Token': String(ADMIN_API_TOKEN),
    'Content-Type': 'application/json',
  };
  const opts = { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) };
  const url = endpointOrUrl.startsWith('http')
    ? endpointOrUrl
    : `https://${SHOPIFY_STORE}/admin/api/${REST_VERSION}/${endpointOrUrl.replace(/^\//, '')}`;

  const res = await fetch(url, opts);
  if (!res.ok) {
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, 2000));
      lastApiCall = Date.now();
      const retry = await fetch(url, opts);
      if (!retry.ok) {
        const t = await retry.text();
        throw new Error(`Shopify REST error after retry: ${retry.status} ${retry.statusText} - ${t}`);
      }
      return raw ? retry : retry.json();
    }
    const t = await res.text();
    throw new Error(`Shopify REST error: ${res.status} ${res.statusText} - ${t}`);
  }
  return raw ? res : res.json();
}

// GraphQL (native Bundles)
const GQL_VERSION = '2025-01';
async function fetchShopifyGQL(query, variables = {}) {
  await rateLimitedDelay();
  const url = `https://${SHOPIFY_STORE}/admin/api/${GQL_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': String(ADMIN_API_TOKEN),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    throw new Error(`Shopify GraphQL error: ${res.status} ${res.statusText} - ${JSON.stringify(json.errors || json)}`);
  }
  return json.data;
}

const toGid = (type, id) => `gid://shopify/${type}/${id}`;

// Parse REST Link header
function extractNextUrlFromLinkHeader(linkHeader) {
  if (!linkHeader) return '';
  const parts = linkHeader.split(',');
  for (const p of parts) {
    if (p.toLowerCase().includes('rel="next"')) {
      const m = p.match(/<([^>]+)>/);
      if (m && m[1]) return m[1];
    }
  }
  return '';
}

// Fetch one REST page of products
async function fetchProductsPage(pageUrl) {
  const fields = encodeURIComponent('id,title,handle,tags,variants');
  const first = `products.json?limit=250&fields=${fields}`;
  const res = await fetchShopifyREST(pageUrl || first, 'GET', null, true); // raw Response
  const json = await res.json();
  const products = Array.isArray(json?.products) ? json.products : [];
  const link = res.headers.get('link') || res.headers.get('Link');
  const nextUrl = extractNextUrlFromLinkHeader(link);
  return { products, nextUrl };
}

// Update product tags (replace any prior bundle-* tag)
async function updateProductTags(productId, currentTagsCSV, status) {
  const cleaned = String(currentTagsCSV || '')
    .split(',')
    .map(t => t.trim())
    .filter(tag => !['bundle-ok', 'bundle-understocked', 'bundle-out-of-stock'].includes(tag.toLowerCase()))
    .concat([`bundle-${status}`]);

  await fetchShopifyREST(`products/${productId}.json`, 'PUT', {
    product: { id: productId, tags: cleaned.join(', ') },
  });
}

/* ----------------- Redis helpers ----------------- */
async function getStatus(productId) {
  return (await redis.get(`status:${productId}`)) || null;
}
async function setStatus(productId, prevStatus, currStatus) {
  await redis.set(`status:${productId}`, { previous: prevStatus, current: currStatus });
}
async function getPrevTotal(productId) {
  const v = await redis.get(`inv_total:${productId}`);
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
async function setCurrTotal(productId, total) {
  await redis.set(`inv_total:${productId}`, total);
}

/* ----------------- Subscribers (same behavior) ----------------- */
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

async function getSubscribersForProduct(prod) {
  const keys = [
    `subscribers:${prod.id}`,
    `subscribers_handle:${prod.handle || ''}`,
  ];
  const lists = await Promise.all(keys.map(async (k) => {
    const v = await redis.get(k);
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
      try { return JSON.parse(v); } catch { return []; }
    }
    return [];
  }));

  const map = new Map();
  const keyFor = (s) => toE164(s?.phone || '') || emailKey(s?.email);
  const ts = (s) => Date.parse(s?.last_rearmed_at || s?.subscribed_at || 0);
  for (const list of lists) {
    for (const s of list) {
      const k = keyFor(s);
      if (!k) continue;
      const prev = map.get(k);
      if (!prev || ts(s) >= ts(prev)) map.set(k, s);
    }
  }
  const merged = Array.from(map.values());
  return { merged, keysTried: keys };
}
async function setSubscribersForProduct(prod, subs) {
  await Promise.all([
    redis.set(`subscribers:${prod.id}`, subs, { ex: 90 * 24 * 60 * 60 }),
    redis.set(`subscribers_handle:${prod.handle || ''}`, subs, { ex: 90 * 24 * 60 * 60 }),
  ]);
}

/* ----------------- Bundle status via GraphQL (native Bundles) ----------------- */
/**
 * Returns:
 * {
 *   ok: Boolean, // has at least one bundle variant
 *   variantResults: [ { variantId, buildable, status } ],
 *   totalBuildable: Number, // sum buildable across bundle variants
 * }
 *
 * Status per variant:
 * - OUT-OF-STOCK if any component have <= 0
 * - UNDERSTOCKED if none are 0 but some have < required
 * - OK otherwise
 */
async function getBundleStatusFromGraphQL(productId) {
  const gid = toGid('Product', productId);
  const query = `
    query ProductBundles($id: ID!, $vv: Int!, $cp: Int!) {
      product(id: $id) {
        id
        handle
        variants(first: $vv) {
          edges {
            node {
              id
              sku
              title
              productVariantComponents(first: $cp) {
                nodes {
                  quantity
                  productVariant {
                    id
                    sku
                    title
                    sellableOnlineQuantity
                    product { handle }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = await fetchShopifyGQL(query, { id: gid, vv: 100, cp: 50 });
  const edges = data?.product?.variants?.edges || [];
  const variantResults = [];

  for (const e of edges) {
    const v = e?.node;
    const comps = v?.productVariantComponents?.nodes || [];
    if (!comps.length) continue; // not a bundle variant

    let anyZero = false, anyInsufficient = false;
    let minBuildable = Infinity;

    for (const c of comps) {
      const have = Number(c?.productVariant?.sellableOnlineQuantity ?? 0);
      const need = Math.max(1, Number(c?.quantity ?? 1));

      if (have <= 0) anyZero = true;
      else if (have < need) anyInsufficient = true;

      const buildableForComp = Math.floor(have / need);
      minBuildable = Math.min(minBuildable, buildableForComp);
    }

    const buildable = Number.isFinite(minBuildable) ? minBuildable : 0;
    const status = anyZero ? 'out-of-stock' : (anyInsufficient ? 'understocked' : 'ok');

    variantResults.push({
      variantId: v.id,
      buildable,
      status,
    });
  }

  if (!variantResults.length) {
    return { ok: false, variantResults: [], totalBuildable: 0, finalStatus: null };
  }

  // Product final = worst across bundle variants
  let finalStatus = 'ok';
  let totalBuildable = 0;
  for (const r of variantResults) {
    finalStatus = worstStatus(finalStatus, r.status);
    totalBuildable += Number(r.buildable || 0);
  }
  return { ok: true, variantResults, totalBuildable, finalStatus };
}

/* ----------------- Notifications ----------------- */
async function notifyPending({ allSubs, pending, keysTried, pid, title, handle, isBundle }) {
  let notificationsSent = 0;
  let smsNotificationsSent = 0;
  let notificationErrors = 0;
  let profileUpdates = 0;

  const productUrl = productUrlFrom(handle);
  let processedSubs = 0;

  for (const sub of pending) {
    try {
      const phoneE164 = toE164(sub.phone || '');
      const smsConsent = !!sub.sms_consent && !!phoneE164;

      await subscribeProfilesToList({
        listId: String(ALERT_LIST_ID),
        email: sub.email,
        phoneE164,
        sms: smsConsent
      });

      const stampedTitle  = sub.product_title  || title || 'Unknown Product';
      const stampedHandle = sub.product_handle || handle || '';
      const stampedUrl    = sub.product_url    || productUrlFrom(stampedHandle) || productUrl;
      const related_section_url = stampedUrl ? `${stampedUrl}#after-bis` : '';

      try {
        const out = await updateProfileProperties({
          email: sub.email,
          properties: {
            last_back_in_stock_product_name: stampedTitle,
            last_back_in_stock_product_url: stampedUrl,
            last_back_in_stock_related_section_url: related_section_url,
            last_back_in_stock_product_handle: stampedHandle,
            last_back_in_stock_product_id: String(pid),
            last_back_in_stock_notified_at: new Date().toISOString(),
          },
        });
        if (out.ok) profileUpdates++;
      } catch (e) {
        console.warn('Profile props write failed, continuing:', e?.message || e);
      }

      await trackKlaviyoEvent({
        metricName: 'Back in Stock',
        email: sub.email,
        phoneE164,
        properties: {
          product_id: String(pid),
          product_title: stampedTitle,
          product_handle: stampedHandle,
          product_url: stampedUrl,
          related_section_url,
          sms_consent: !!smsConsent,
          source: isBundle ? 'bundle audit (native components)' : 'catalog slice',
        },
      });

      sub.notified = true;
      notificationsSent++;
      if (smsConsent) smsNotificationsSent++;
      if (++processedSubs % 5 === 0) await new Promise(r => setTimeout(r, 250));
    } catch (e) {
      notificationErrors++;
      console.error(`Notify failed for ${sub?.email || '(unknown)'}:`, e?.message || e);
    }
  }

  await setSubscribersForProduct({ id: pid, handle }, allSubs);
  return { notificationsSent, smsNotificationsSent, notificationErrors, profileUpdates };
}

/* ----------------- Cursor helpers ----------------- */
async function loadCursor(runId) {
  const cur = await redis.get(CURSOR_KEY);
  if (cur && cur.runId === runId) return cur;
  return { runId, pageUrl: '', nextIndex: 0, startedAt: new Date().toISOString() };
}
async function saveCursor(cursor) {
  await redis.set(CURSOR_KEY, cursor, { ex: 60 * 60 });
}
async function clearCursor() {
  try { await redis.del(CURSOR_KEY); } catch {}
}

/* ----------------- Time-bounded catalog slice ----------------- */
async function runCatalogSlice({ runId, verbose = false }) {
  assertEnv();
  const t0 = Date.now();
  let processed = 0;
  let tagsUpdated = 0;
  let notificationsSent = 0;
  let smsNotificationsSent = 0;
  let notificationErrors = 0;
  let profileUpdates = 0;

  let cursor = await loadCursor(runId);
  if (verbose) console.log(`Slice start runId=${runId} pageUrl=${cursor.pageUrl || '(first)'} idx=${cursor.nextIndex}`);

  let page = { products: [], nextUrl: '' };
  let products = [];
  let i = cursor.nextIndex || 0;

  ({ products, nextUrl: page.nextUrl } = await fetchProductsPage(cursor.pageUrl));

  while (true) {
    if (i >= products.length) {
      if (!page.nextUrl) break;
      cursor = { ...cursor, pageUrl: page.nextUrl, nextIndex: 0 };
      await saveCursor(cursor);
      ({ products, nextUrl: page.nextUrl } = await fetchProductsPage(cursor.pageUrl));
      i = 0;
      if (verbose) console.log(`Next page: ${products.length} products`);
      if (!products.length) break;
    }

    const product = products[i++];
    try {
      const pid = Number(product.id);
      const title = product.title;
      const handle = product.handle;
      const tagsCSV = String(product.tags || '');

      // We still paginate via REST, but only run the expensive GraphQL
      // component check when this looks like a bundle (by tag).
      // (You can remove this gate to check every product; GraphQL cost will rise.)
      const looksLikeBundle = hasBundleTag(tagsCSV);

      // Sum of variant inventory (REST) is still kept for "increased" fallback
      const restTotal = (product.variants || []).reduce((acc, v) => acc + Number(v?.inventory_quantity ?? 0), 0);
      const prevTotal = await getPrevTotal(pid);

      let finalStatus = null;
      let totalBuildable = 0;

      if (looksLikeBundle) {
        // 🔴 Native Bundles via GraphQL — same logic as your Sheet
        const summary = await getBundleStatusFromGraphQL(pid);

        if (summary.ok) {
          finalStatus = summary.finalStatus;           // 'ok' | 'understocked' | 'out-of-stock'
          totalBuildable = Number(summary.totalBuildable || 0);
        } else {
          // Tagged as bundle but no native components — fall back to REST totals:
          finalStatus =
            (product.variants || []).length > 0 &&
            (product.variants || []).every(v => Number(v?.inventory_quantity ?? 0) === 0)
              ? 'out-of-stock'
              : 'ok';
          totalBuildable = restTotal;
        }
      } else {
        // Non-bundle: we don't tag bundle-* statuses
        if (verbose) console.log(`Non-bundle: ${title}`);
      }

      // Persist & notify only for bundles (we manage bundle-* tags)
      if (finalStatus) {
        const increased = prevTotal == null ? false : totalBuildable > prevTotal;
        await setCurrTotal(pid, totalBuildable);

        const prevObj = await getStatus(pid);
        const prevStatus = (prevObj?.current ?? extractStatusFromTags(tagsCSV)) || null;
        await setStatus(pid, prevStatus, finalStatus);

        // Update bundle-* tag on product
        await updateProductTags(pid, tagsCSV, finalStatus);
        tagsUpdated++;

        if (verbose) {
          console.log(`📊 ${title} — final=${finalStatus}; buildable=${totalBuildable} (prev=${prevTotal ?? 'n/a'}, Δ+? ${increased})`);
        }

        // Notify when flips to OK (or buildable increased)
        const { merged: allSubs, keysTried } = await getSubscribersForProduct({ id: pid, handle });
        const pending = allSubs.filter(s => !s?.notified);
        const prevWasOk = (prevObj?.previous ?? extractStatusFromTags(tagsCSV)) === 'ok';
        const shouldNotify = (finalStatus === 'ok') && pending.length > 0 && (!prevWasOk || increased);

        if (shouldNotify) {
          const counts = await notifyPending({ allSubs, pending, keysTried, pid, title, handle, isBundle: true });
          notificationsSent    += counts.notificationsSent;
          smsNotificationsSent += counts.smsNotificationsSent;
          notificationErrors   += counts.notificationErrors;
          profileUpdates       += counts.profileUpdates;
        }
      } else {
        // Keep prevTotal tracking even for non-bundles (optional; harmless)
        await setCurrTotal(pid, restTotal);
      }

      processed++;
    } catch (e) {
      console.error(`Error on product "${product?.title || product?.id}":`, e?.message || e);
    }

    if (Date.now() - t0 > TIME_BUDGET_MS) break;
  }

  const pageConsumed = i >= products.length;
  const nextCursor = pageConsumed
    ? { ...cursor, pageUrl: page.nextUrl, nextIndex: 0 }
    : { ...cursor, nextIndex: i };

  await saveCursor(nextCursor);

  const done = pageConsumed && !page.nextUrl;
  return {
    done,
    processed,
    tagsUpdated,
    notificationsSent,
    smsNotificationsSent,
    notificationErrors,
    profileUpdates,
    nextCursor: { ...nextCursor, runId },
    sliceMs: Date.now() - t0,
  };
}

/* ----------------- GET handler ----------------- */
export async function GET(req) {
  const authed = await ensureCronAuth(req);
  if (!authed) return unauthorized();

  const url = new URL(req.url);
  const verbose = ['1','true','yes'].includes((url.searchParams.get('verbose') || '').toLowerCase());
  const loop    = ['1','true','yes'].includes((url.searchParams.get('loop') || '').toLowerCase());
  const action  = (url.searchParams.get('action') || '').toLowerCase();

  let runId = url.searchParams.get('runId');
  if (!runId) {
    const cur = await redis.get(CURSOR_KEY);
    runId = cur?.runId || randomUUID();
  }

  if (action === 'status') {
    const ttl = await redis.ttl(LOCK_KEY);
    const holder = await redis.get(LOCK_KEY);
    const cursor = await redis.get(CURSOR_KEY);
    return NextResponse.json({ locked: ttl > 0, ttl, holder, cursor });
  }

  const ok = await acquireOrValidateLock(runId);
  if (!ok) return NextResponse.json({ success: false, error: 'audit already running' }, { status: 423 });

  try {
    const slice = await runCatalogSlice({ runId, verbose });

    if (!slice.done && loop) {
      const resumeUrl =
        `${url.origin}/api/audit-bundles?loop=1&runId=${encodeURIComponent(runId)}` +
        (verbose ? '&verbose=1' : '');
      const headers = CRON_SECRET ? { authorization: `Bearer ${CRON_SECRET}` } : undefined;
      after(() => fetch(resumeUrl, { cache: 'no-store', headers }).catch(() => {}));
      await redis.expire(LOCK_KEY, LOCK_TTL_SECONDS);
    } else if (slice.done) {
      await clearCursor();
      await releaseLock(runId);
    } else {
      await redis.expire(LOCK_KEY, LOCK_TTL_SECONDS);
    }

    return NextResponse.json({
      success: true,
      runId,
      done: slice.done,
      processedInThisSlice: slice.processed,
      tagsUpdatedInThisSlice: slice.tagsUpdated,
      notificationsSentInThisSlice: slice.notificationsSent,
      smsNotificationsSentInThisSlice: slice.smsNotificationsSent,
      notificationErrorsInThisSlice: slice.notificationErrors,
      profileUpdatesInThisSlice: slice.profileUpdates,
      sliceMs: slice.sliceMs,
      nextCursor: slice.nextCursor,
      message: slice.done
        ? 'Catalog sweep complete (resumable)'
        : (loop ? 'Slice complete; another slice scheduled (resumable)' : 'Slice complete; call again to resume'),
    });
  } catch (error) {
    await releaseLock(runId);
    return NextResponse.json(
      {
        success: false,
        error: error?.message || String(error),
        stack: process.env.NODE_ENV === 'development' ? error?.stack : undefined,
      },
      { status: 500 },
    );
  }
}

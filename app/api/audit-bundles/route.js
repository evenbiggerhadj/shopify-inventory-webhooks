// app/api/audit-bundles/route.js
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

import { NextResponse, after } from 'next/server';
import { Redis } from '@upstash/redis';
import { randomUUID } from 'crypto';

/* ----------------- Lazy env + clients ----------------- */
const ENV = {
  SHOPIFY_STORE:       process.env.SHOPIFY_STORE,                  // mystore.myshopify.com
  ADMIN_API_TOKEN:     process.env.SHOPIFY_ADMIN_API_KEY,
  KLAVIYO_API_KEY:     process.env.KLAVIYO_API_KEY,
  ALERT_LIST_ID:       process.env.KLAVIYO_BACK_IN_STOCK_ALERT_LIST_ID,
  PUBLIC_STORE_DOMAIN: process.env.PUBLIC_STORE_DOMAIN || 'example.com',
  CRON_SECRET:         process.env.CRON_SECRET || '',
  KV_URL:              process.env.KV_REST_API_URL || process.env.KV_URL || process.env.REDIS_URL || '',
  KV_TOKEN:            process.env.KV_REST_API_TOKEN || process.env.KV_REST_API_READ_ONLY_TOKEN || '',
  SHOPIFY_REST_VER:    process.env.SHOPIFY_API_VERSION || '2025-01',
  SHOPIFY_GQL_VER:     process.env.SHOPIFY_API_VERSION || '2025-01',
  SHOPIFY_THROTTLE_MS: Number(process.env.SHOPIFY_THROTTLE_MS || 500),
  TIME_BUDGET_MS:      Number(process.env.TIME_BUDGET_MS || 240000),
};

let _redis = null;
function getRedis() {
  if (!_redis) {
    if (!ENV.KV_URL || !ENV.KV_TOKEN) {
      throw new Error('Redis misconfigured: KV_REST_API_URL/KV_URL and KV_REST_API_TOKEN are required');
    }
    _redis = new Redis({ url: ENV.KV_URL, token: ENV.KV_TOKEN });
  }
  return _redis;
}

function assertEnv() {
  const missing = [];
  if (!ENV.SHOPIFY_STORE)   missing.push('SHOPIFY_STORE');
  if (!ENV.ADMIN_API_TOKEN) missing.push('SHOPIFY_ADMIN_API_KEY');
  if (!ENV.KLAVIYO_API_KEY) missing.push('KLAVIYO_API_KEY');
  if (!ENV.ALERT_LIST_ID)   missing.push('KLAVIYO_BACK_IN_STOCK_ALERT_LIST_ID');
  if (!ENV.KV_URL)          missing.push('KV_REST_API_URL (or KV_URL/REDIS_URL)');
  if (!ENV.KV_TOKEN)        missing.push('KV_REST_API_TOKEN');
  if (missing.length) throw new Error(`Missing env: ${missing.join(', ')}`);
}

/* ----------------- Auth & locking ----------------- */
const LOCK_KEY = 'locks:audit-bundles';
const CURSOR_KEY = 'audit:cursor';
const LOCK_TTL_SECONDS = 15 * 60;

function unauthorized() {
  return NextResponse.json({ success: false, error: 'unauthorized' }, { status: 401 });
}
async function ensureCronAuth(req) {
  if (req.headers.get('x-vercel-cron')) return true; // Vercel cron
  if (!ENV.CRON_SECRET) return true;                 // open if no secret
  const auth = req.headers.get('authorization') || '';
  if (auth === `Bearer ${ENV.CRON_SECRET}`) return true;
  const url = new URL(req.url);
  if (url.searchParams.get('token') === ENV.CRON_SECRET) return true;
  return false;
}
async function acquireOrValidateLock(runId) {
  const redis = getRedis();
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
    const redis = getRedis();
    const holder = await redis.get(LOCK_KEY);
    if (holder === runId) await redis.del(LOCK_KEY);
  } catch {}
}

/* ----------------- Small utils ----------------- */
const productUrlFrom = (handle) => (handle ? `https://${ENV.PUBLIC_STORE_DOMAIN}/products/${handle}` : '');
const RANK = { ok: 0, understocked: 1, 'out-of-stock': 2 };
const worstStatus = (a = 'ok', b = 'ok') => (RANK[a] >= RANK[b]) ? a : b;

function hasBundleTag(tagsStr) {
  return String(tagsStr || '')
    .split(',')
    .map(t => t.trim().toLowerCase())
    .includes('bundle');
}
function extractStatusFromTags(tagsStr) {
  const tags = String(tagsStr || '').split(',').map(t => t.trim().toLowerCase());
  if (tags.includes('bundle-out-of-stock')) return 'out-of-stock';
  if (tags.includes('bundle-understocked')) return 'understocked';
  if (tags.includes('bundle-ok'))           return 'ok';
  return null;
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

/* ----------------- Klaviyo (unchanged helpers) ----------------- */
async function subscribeProfilesToList({ listId, email, phoneE164, sms }) {
  if (!ENV.KLAVIYO_API_KEY) throw new Error('KLAVIYO_API_KEY missing');
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
      'Authorization': `Klaviyo-API-Key ${ENV.KLAVIYO_API_KEY}`,
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
  if (!ENV.KLAVIYO_API_KEY) throw new Error('KLAVIYO_API_KEY missing');
  if (!email) throw new Error('email missing');
  const filter = `equals(email,"${String(email).replace(/"/g, '\\"')}")`;
  const listRes = await fetch(`https://a.klaviyo.com/api/profiles/?filter=${encodeURIComponent(filter)}&page[size]=1`, {
    method: 'GET',
    headers: {
      'Authorization': `Klaviyo-API-Key ${ENV.KLAVIYO_API_KEY}`,
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
      'Authorization': `Klaviyo-API-Key ${ENV.KLAVIYO_API_KEY}`,
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
  if (!ENV.KLAVIYO_API_KEY) throw new Error('KLAVIYO_API_KEY missing');
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
      'Authorization': `Klaviyo-API-Key ${ENV.KLAVIYO_API_KEY}`,
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
  const min = ENV.SHOPIFY_THROTTLE_MS;
  if (dt < min) await new Promise(r => setTimeout(r, min - dt));
  lastApiCall = Date.now();
}
async function fetchShopifyREST(endpointOrUrl, method = 'GET', body = null, raw = false) {
  if (!endpointOrUrl || typeof endpointOrUrl !== 'string') {
    throw new Error(`fetchShopifyREST invalid endpoint: "${endpointOrUrl}"`);
  }
  await rateLimitedDelay();
  const headers = {
    'X-Shopify-Access-Token': String(ENV.ADMIN_API_TOKEN),
    'Content-Type': 'application/json',
  };
  const opts = { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) };
  const url = endpointOrUrl.startsWith('http')
    ? endpointOrUrl
    : `https://${ENV.SHOPIFY_STORE}/admin/api/${ENV.SHOPIFY_REST_VER}/${endpointOrUrl.replace(/^\//, '')}`;
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
async function fetchShopifyGQL(query, variables = {}) {
  await rateLimitedDelay();
  const url = `https://${ENV.SHOPIFY_STORE}/admin/api/${ENV.SHOPIFY_GQL_VER}/graphql.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': String(ENV.ADMIN_API_TOKEN),
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

// REST pagination helpers
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
async function fetchProductsPage(pageUrl) {
  const fields = encodeURIComponent('id,title,handle,tags,variants');
  const first = `products.json?limit=250&fields=${fields}`;
  const res = await fetchShopifyREST(pageUrl || first, 'GET', null, true);
  const json = await res.json();
  const products = Array.isArray(json?.products) ? json.products : [];
  const link = res.headers.get('link') || res.headers.get('Link');
  const nextUrl = extractNextUrlFromLinkHeader(link);
  return { products, nextUrl };
}
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
  const redis = getRedis();
  return (await redis.get(`status:${productId}`)) || null;
}
async function setStatus(productId, prevStatus, currStatus) {
  const redis = getRedis();
  await redis.set(`status:${productId}`, { previous: prevStatus, current: currStatus });
}
async function getPrevTotal(productId) {
  const redis = getRedis();
  const v = await redis.get(`inv_total:${productId}`);
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
async function setCurrTotal(productId, total) {
  const redis = getRedis();
  await redis.set(`inv_total:${productId}`, total);
}

/* ----------------- Waitlist subscribers ----------------- */
const emailKey = (e) => `email:${String(e || '').toLowerCase()}`;
async function getSubscribersForProduct(prod) {
  const redis = getRedis();
  const keys = [`subscribers:${prod.id}`, `subscribers_handle:${prod.handle || ''}`];
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
      if (!k) continue;
      const prev = map.get(k);
      if (!prev || ts(s) >= ts(prev)) map.set(k, s);
    }
  }
  return { merged: Array.from(map.values()), keysTried: keys };
}
async function setSubscribersForProduct(prod, subs) {
  const redis = getRedis();
  await Promise.all([
    redis.set(`subscribers:${prod.id}`, subs, { ex: 90 * 24 * 60 * 60 }),
    redis.set(`subscribers_handle:${prod.handle || ''}`, subs, { ex: 90 * 24 * 60 * 60 }),
  ]);
}

/* ----------------- Native bundle status via GraphQL ----------------- */
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
              productVariantComponents(first: $cp) {
                nodes {
                  quantity
                  productVariant {
                    id
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
    if (!comps.length) continue;
    let anyZero = false, anyInsufficient = false, minBuildable = Infinity;
    for (const c of comps) {
      const have = Number(c?.productVariant?.sellableOnlineQuantity ?? 0);
      const need = Math.max(1, Number(c?.quantity ?? 1));
      if (have <= 0) anyZero = true;
      else if (have < need) anyInsufficient = true;
      minBuildable = Math.min(minBuildable, Math.floor(have / need));
    }
    const buildable = Number.isFinite(minBuildable) ? minBuildable : 0;
    const status = anyZero ? 'out-of-stock' : (anyInsufficient ? 'understocked' : 'ok');
    variantResults.push({ buildable, status });
  }
  if (!variantResults.length) return { ok: false, variantResults: [], totalBuildable: 0, finalStatus: null };
  let finalStatus = 'ok', totalBuildable = 0;
  for (const r of variantResults) {
    finalStatus = worstStatus(finalStatus, r.status);
    totalBuildable += Number(r.buildable || 0);
  }
  return { ok: true, variantResults, totalBuildable, finalStatus };
}

/* ----------------- Notify helpers ----------------- */
async function notifyPending({ allSubs, pending, keysTried, pid, title, handle, isBundle }) {
  let notificationsSent = 0, smsNotificationsSent = 0, notificationErrors = 0, profileUpdates = 0;
  const productUrl = productUrlFrom(handle);
  let processedSubs = 0;
  for (const sub of pending) {
    try {
      const phoneE164 = toE164(sub.phone || '');
      const smsConsent = !!sub.sms_consent && !!phoneE164;
      await subscribeProfilesToList({ listId: String(ENV.ALERT_LIST_ID), email: sub.email, phoneE164, sms: smsConsent });
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
      } catch {}
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
  const redis = getRedis();
  const cur = await redis.get(CURSOR_KEY);
  if (cur && cur.runId === runId) return cur;
  return { runId, pageUrl: '', nextIndex: 0, startedAt: new Date().toISOString() };
}
async function saveCursor(cursor) {
  const redis = getRedis();
  await redis.set(CURSOR_KEY, cursor, { ex: 60 * 60 });
}
async function clearCursor() {
  try { const redis = getRedis(); await redis.del(CURSOR_KEY); } catch {}
}

/* ----------------- Slice ----------------- */
async function runCatalogSlice({ runId, verbose = false }) {
  assertEnv();
  const t0 = Date.now();
  let processed = 0, tagsUpdated = 0, notificationsSent = 0, smsNotificationsSent = 0, notificationErrors = 0, profileUpdates = 0;

  let cursor = await loadCursor(runId);
  if (verbose) console.log(`Slice start runId=${runId} pageUrl=${cursor.pageUrl || '(first)'} idx=${cursor.nextIndex}`);

  let page = { products: [], nextUrl: '' };
  let products = [];
  let i = cursor.nextIndex || 0;

  // fetch current page
  {
    const pageRes = await fetchProductsPage(cursor.pageUrl);
    products = pageRes.products;
    page.nextUrl = pageRes.nextUrl;
  }

  while (true) {
    if (i >= products.length) {
      if (!page.nextUrl) break;
      cursor = { ...cursor, pageUrl: page.nextUrl, nextIndex: 0 };
      await saveCursor(cursor);
      const pageRes = await fetchProductsPage(cursor.pageUrl);
      products = pageRes.products;
      page.nextUrl = pageRes.nextUrl;
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
      const looksLikeBundle = hasBundleTag(tagsCSV);

      // track buildable / total for notify logic
      const restTotal = (product.variants || []).reduce((acc, v) => acc + Number(v?.inventory_quantity ?? 0), 0);
      const prevTotal = await getPrevTotal(pid);

      let finalStatus = null;
      let totalBuildable = 0;

      if (looksLikeBundle) {
        const summary = await getBundleStatusFromGraphQL(pid);
        if (summary.ok) {
          finalStatus = summary.finalStatus;            // 'ok' | 'understocked' | 'out-of-stock'
          totalBuildable = Number(summary.totalBuildable || 0);
        } else {
          // Fallback if no native components returned
          finalStatus =
            (product.variants || []).length > 0 &&
            (product.variants || []).every(v => Number(v?.inventory_quantity ?? 0) === 0)
              ? 'out-of-stock'
              : 'ok';
          totalBuildable = restTotal;
        }
      }

      if (finalStatus) {
        const increased = prevTotal == null ? false : totalBuildable > prevTotal;
        await setCurrTotal(pid, totalBuildable);

        const prevObj = await getStatus(pid);
        const prevStatus = (prevObj?.current ?? extractStatusFromTags(tagsCSV)) || null;
        await setStatus(pid, prevStatus, finalStatus);

        await updateProductTags(pid, tagsCSV, finalStatus);
        tagsUpdated++;

        if (verbose) {
          console.log(`📊 ${title} — final=${finalStatus}; buildable=${totalBuildable} (prev=${prevTotal ?? 'n/a'}, Δ+? ${increased})`);
        }

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
        await setCurrTotal(pid, restTotal);
      }

      processed++;
    } catch (e) {
      console.error(`Error on product "${product?.title || product?.id}":`, e?.message || e);
    }

    if (Date.now() - t0 > ENV.TIME_BUDGET_MS) break;
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
  try {
    // quick self-test path (helps avoid blank 500s)
    const url = new URL(req.url);
    if ((url.searchParams.get('action') || '').toLowerCase() === 'selftest') {
      const out = {
        env_ok: true,
        has_store: !!ENV.SHOPIFY_STORE,
        has_admin_token: !!ENV.ADMIN_API_TOKEN,
        has_klaviyo_key: !!ENV.KLAVIYO_API_KEY,
        has_alert_list: !!ENV.ALERT_LIST_ID,
        has_kv_url: !!ENV.KV_URL,
        has_kv_token: !!ENV.KV_TOKEN,
        runtime: 'nodejs',
      };
      try { await getRedis().ping(); out.redis_ping = 'ok'; } catch (e) { out.redis_ping = `fail: ${e?.message || e}`; }
      return NextResponse.json(out);
    }

    const authed = await ensureCronAuth(req);
    if (!authed) return unauthorized();

    const verbose = ['1','true','yes'].includes((new URL(req.url).searchParams.get('verbose') || '').toLowerCase());
    const loop    = ['1','true','yes'].includes((new URL(req.url).searchParams.get('loop') || '').toLowerCase());
    const action  = (new URL(req.url).searchParams.get('action') || '').toLowerCase();

    // Use caller's runId if provided; otherwise reuse cursor runId or mint one
    let runId = new URL(req.url).searchParams.get('runId');
    if (!runId) {
      try {
        const redis = getRedis();
        const cur = await redis.get(CURSOR_KEY);
        runId = cur?.runId || randomUUID();
      } catch {
        runId = randomUUID();
      }
    }

    if (action === 'status') {
      const redis = getRedis();
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
        const base = new URL(req.url);
        base.searchParams.set('loop', '1');
        base.searchParams.set('runId', runId);
        if (verbose) base.searchParams.set('verbose', '1');
        const headers = ENV.CRON_SECRET ? { authorization: `Bearer ${ENV.CRON_SECRET}` } : undefined;
        after(() => fetch(base.toString(), { cache: 'no-store', headers }).catch(() => {}));
        await getRedis().expire(LOCK_KEY, LOCK_TTL_SECONDS);
      } else if (slice.done) {
        await clearCursor();
        await releaseLock(runId);
      } else {
        await getRedis().expire(LOCK_KEY, LOCK_TTL_SECONDS);
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
    } catch (e) {
      await releaseLock(runId);
      return NextResponse.json(
        { success: false, error: e?.message || String(e) },
        { status: 500 }
      );
    }
  } catch (fatal) {
    // catches init-time issues (e.g., bad Redis env) so you see JSON instead of a blank 500
    return NextResponse.json(
      { success: false, error: fatal?.message || String(fatal) },
      { status: 500 }
    );
  }
}

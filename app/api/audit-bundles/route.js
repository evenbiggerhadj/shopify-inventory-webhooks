// app/api/audit-bundles/route.js

import { NextResponse, after } from 'next/server';
import { Redis } from '@upstash/redis';
import { randomUUID } from 'crypto';

export const runtime = 'nodejs';
export const maxDuration = 300; // chain slices; don't rely on long single runs

/* ----------------- Env & Redis ----------------- */
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const SHOPIFY_STORE       = process.env.SHOPIFY_STORE; // e.g. "yourstore.myshopify.com"
const ADMIN_API_TOKEN     = process.env.SHOPIFY_ADMIN_API_KEY;
const KLAVIYO_API_KEY     = process.env.KLAVIYO_API_KEY;
const ALERT_LIST_ID       = process.env.KLAVIYO_BACK_IN_STOCK_ALERT_LIST_ID;
const PUBLIC_STORE_DOMAIN = process.env.PUBLIC_STORE_DOMAIN || 'example.com';
const CRON_SECRET         = process.env.CRON_SECRET || ''; // optional; if unset, no auth required

function assertEnv() {
  const missing = [];
  if (!SHOPIFY_STORE)   missing.push('SHOPIFY_STORE');
  if (!ADMIN_API_TOKEN) missing.push('SHOPIFY_ADMIN_API_KEY');
  if (!KLAVIYO_API_KEY) missing.push('KLAVIYO_API_KEY');
  if (!ALERT_LIST_ID)   missing.push('KLAVIYO_BACK_IN_STOCK_ALERT_LIST_ID');
  if (missing.length) throw new Error(`Missing env: ${missing.join(', ')}`);
}

/* ----------------- Auth & locking ----------------- */
function unauthorized() {
  return NextResponse.json({ success: false, error: 'unauthorized' }, { status: 401 });
}
async function ensureCronAuth(req) {
  if (req.headers.get('x-vercel-cron')) return true; // Vercel Cron
  if (!CRON_SECRET) return true; // open if no secret configured
  const auth = req.headers.get('authorization') || '';
  if (auth === `Bearer ${CRON_SECRET}`) return true;
  const url = new URL(req.url);
  if (url.searchParams.get('token') === CRON_SECRET) return true;
  return false;
}

const LOCK_KEY    = 'locks:audit-bundles';
const CURSOR_KEY  = 'audit:cursor'; // { runId, pageUrl, nextIndex, startedAt }
const LOCK_TTL_SECONDS = 15 * 60;   // 15 minutes

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
// Shopify REST: ~2 rps. 500ms is safe.
const MIN_DELAY_MS   = Number(process.env.SHOPIFY_THROTTLE_MS || 500);
// Keep each slice under the function ceiling (we chain slices as needed).
const TIME_BUDGET_MS = Number(process.env.TIME_BUDGET_MS || 240000);

/* ----------------- Utils ----------------- */
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
const productUrlFrom = (handle) => (handle ? `https://${PUBLIC_STORE_DOMAIN}/products/${handle}` : '');

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
const RANK = { ok: 0, understocked: 1, 'out-of-stock': 2 };
function worstStatus(a = 'ok', b = 'ok') {
  return (RANK[a] >= RANK[b]) ? a : b;
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

/* ----------------- Shopify (rate-limited) ----------------- */
let lastApiCall = 0;
async function rateLimitedDelay() {
  const now = Date.now();
  const dt = now - lastApiCall;
  if (dt < MIN_DELAY_MS) await new Promise(r => setTimeout(r, MIN_DELAY_MS - dt));
  lastApiCall = Date.now();
}

async function fetchShopify(endpointOrUrl, method = 'GET', body = null, raw = false) {
  if (!endpointOrUrl || typeof endpointOrUrl !== 'string') {
    throw new Error(`fetchShopify called with invalid endpoint: "${endpointOrUrl}"`);
  }
  await rateLimitedDelay();

  const headers = {
    'X-Shopify-Access-Token': String(ADMIN_API_TOKEN),
    'Content-Type': 'application/json',
  };

  const opts = { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) };
  const url = endpointOrUrl.startsWith('http')
    ? endpointOrUrl
    : `https://${SHOPIFY_STORE}/admin/api/2024-04/${endpointOrUrl.replace(/^\//, '')}`;

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
      return raw ? retry : retry.json();
    }
    const t = await res.text();
    throw new Error(`Shopify API error: ${res.status} ${res.statusText} - ${t}`);
  }
  return raw ? res : res.json();
}

// Parse Shopify Link header; return absolute next URL or '' (none)
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

// Fetch a single page of products (id,title,handle,tags,variants)
async function fetchProductsPage(pageUrl) {
  const fields = encodeURIComponent('id,title,handle,tags,variants');
  const first = `products.json?limit=250&fields=${fields}`;

  const res = await fetchShopify(pageUrl || first, 'GET', null, true); // raw Response
  const json = await res.json();
  const products = Array.isArray(json?.products) ? json.products : [];

  const link = res.headers.get('link') || res.headers.get('Link');
  const nextUrl = extractNextUrlFromLinkHeader(link);
  return { products, nextUrl };
}

async function getProductMetafields(productId) {
  const res = await fetchShopify(`products/${productId}/metafields.json`);
  if (!res || !Array.isArray(res.metafields)) return null;
  return res.metafields.find((m) => m.namespace === 'custom' && m.key === 'bundle_structure');
}

async function updateProductTags(productId, currentTagsCSV, status) {
  const cleaned = String(currentTagsCSV || '')
    .split(',')
    .map(t => t.trim())
    .filter(tag => !['bundle-ok', 'bundle-understocked', 'bundle-out-of-stock'].includes(tag.toLowerCase()))
    .concat([`bundle-${status}`]);

  await fetchShopify(`products/${productId}.json`, 'PUT', { product: { id: productId, tags: cleaned.join(', ') } });
}

// Fallback — when a component variant wasn’t on the current page
async function fetchVariantQty(variantId) {
  const res = await fetchShopify(`variants/${variantId}.json`);
  return Number(res?.variant?.inventory_quantity ?? 0);
}

/* ----------------- Redis helpers (status + subscribers + inv totals) ----------------- */
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

/** Read & merge subscribers saved under BOTH keys */
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

/** Persist updated subscribers back to BOTH keys */
async function setSubscribersForProduct(prod, subs) {
  await Promise.all([
    redis.set(`subscribers:${prod.id}`, subs, { ex: 90 * 24 * 60 * 60 }),
    redis.set(`subscribers_handle:${prod.handle || ''}`, subs, { ex: 90 * 24 * 60 * 60 }),
  ]);
}

/* ----------------- Notification helper (writes back all subs) ----------------- */
async function notifyPending({ allSubs, pending, keysTried, pid, title, handle, isBundle }) {
  let notificationsSent = 0;
  let smsNotificationsSent = 0;
  let notificationErrors = 0;
  let profileUpdates = 0;

  const productUrl = productUrlFrom(handle);
  console.log(`🔔 Back in stock — ${title} — notifying ${pending.length} pending subscribers (keys: ${JSON.stringify(keysTried)})`);
  let processedSubs = 0;

  for (const sub of pending) {
    try {
      const phoneE164 = toE164(sub.phone || '');
      const smsConsent = !!sub.sms_consent && !!phoneE164;

      await subscribeProfilesToList({ listId: String(ALERT_LIST_ID), email: sub.email, phoneE164, sms: smsConsent });

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
        console.warn('⚠️ Profile props write failed, continuing:', e?.message || e);
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
          source: isBundle ? 'bundle audit (catalog slice)' : 'catalog slice',
        },
      });

      sub.notified = true;
      notificationsSent++;
      if (smsConsent) smsNotificationsSent++;
      if (++processedSubs % 5 === 0) await new Promise(r => setTimeout(r, 250));
    } catch (e) {
      notificationErrors++;
      console.error(`❌ Notify failed for ${sub?.email || '(unknown)'}:`, e?.message || e);
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
  await redis.set(CURSOR_KEY, cursor, { ex: 60 * 60 }); // keep for 1h
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
  if (verbose) console.log(`🔎 Slice start runId=${runId} pageUrl=${cursor.pageUrl || '(first)'} idx=${cursor.nextIndex}`);

  let page = { products: [], nextUrl: '' };
  let products = [];
  let i = cursor.nextIndex || 0;

  // fetch the current page (NO invalid destructuring here)
  {
    const first = await fetchProductsPage(cursor.pageUrl);
    products = first.products;
    page.nextUrl = first.nextUrl;
  }

  // process until time budget is spent
  while (true) {
    if (i >= products.length) {
      if (!page.nextUrl) break; // no more pages
      cursor = { ...cursor, pageUrl: page.nextUrl, nextIndex: 0 };
      await saveCursor(cursor);

      const next = await fetchProductsPage(cursor.pageUrl);
      products = next.products;
      page.nextUrl = next.nextUrl;

      i = 0;
      if (verbose) console.log(`📥 Next page: ${products.length} products`);
      if (!products.length) break;
    }

    const product = products[i++];
    try {
      const pid = Number(product.id);
      const title = product.title;
      const handle = product.handle;
      const tagsCSV = String(product.tags || '');

      const total = (product.variants || []).reduce((acc, v) => acc + Number(v?.inventory_quantity ?? 0), 0);
      const prevTotal = await getPrevTotal(pid);
      const increased = prevTotal == null ? false : total > prevTotal;
      await setCurrTotal(pid, total);

      const isBundle = hasBundleTag(tagsCSV);

      if (isBundle) {
        let componentsStatus = 'ok';
        const mf = await getProductMetafields(pid);
        if (mf?.value) {
          let comps = [];
          try { comps = JSON.parse(mf.value); } catch { comps = []; }
          const under = [], out = [];
          for (const c of comps) {
            if (!c?.variant_id) continue;
            const vLocal = (product.variants || []).find(v => String(v.id) === String(c.variant_id));
            let qty = vLocal ? Number(vLocal?.inventory_quantity ?? 0) : await fetchVariantQty(Number(c.variant_id));
            const req = Number(c?.required_quantity ?? 1);
            if (qty === 0) out.push(c.variant_id);
            else if (qty < req) under.push(c.variant_id);
          }
          if (out.length) componentsStatus = 'out-of-stock';
          else if (under.length) componentsStatus = 'understocked';
        }

        const qtys = (product.variants || []).map(v => Number(v?.inventory_quantity ?? 0));
        const ownTotal = qtys.reduce((a, b) => a + b, 0);
        const anyNeg  = qtys.some(q => q < 0);
        const allZero = (product.variants || []).length > 0 && qtys.every(q => q === 0);
        const ownStatus =
          allZero ? 'out-of-stock'
          : (anyNeg || ownTotal < 0) ? 'understocked'
          : 'ok';

        const finalStatus = worstStatus(componentsStatus, ownStatus);

        const prevObj = await getStatus(pid);
        const prevStatus = (prevObj?.current ?? extractStatusFromTags(tagsCSV)) || null;
        await setStatus(pid, prevStatus, finalStatus);

        await updateProductTags(pid, tagsCSV, finalStatus);
        tagsUpdated++;

        if (verbose) {
          console.log(`📊 ${title} — bundle comp=${componentsStatus} own=${ownStatus} ⇒ ${finalStatus}; total=${total} (prev=${prevTotal ?? 'n/a'}, Δ+? ${increased})`);
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
        if (verbose) console.log(`📊 ${title} — non-bundle; total=${total} (prev=${prevTotal ?? 'n/a'}, Δ+? ${increased})`);

        const { merged: allSubs, keysTried } = await getSubscribersForProduct({ id: pid, handle });
        const pending = allSubs.filter(s => !s?.notified);
        const shouldNotify = (pending.length > 0) && increased && total > 0;
        if (shouldNotify) {
          const counts = await notifyPending({ allSubs, pending, keysTried, pid, title, handle, isBundle: false });
          notificationsSent    += counts.notificationsSent;
          smsNotificationsSent += counts.smsNotificationsSent;
          notificationErrors   += counts.notificationErrors;
          profileUpdates       += counts.profileUpdates;
        }
      }

      processed++;
    } catch (e) {
      console.error(`❌ Error on product "${product?.title || product?.id}":`, e?.message || e);
    }

    if (Date.now() - t0 > TIME_BUDGET_MS) break; // time budget guard
  }

  // save resume point
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

/* ----------------- GET handler (resumable, self-reinvoking) ----------------- */
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

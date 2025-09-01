// app/api/audit-bundles/route.js

/* ---- Vercel runtime & max duration ---- */
export const runtime = 'nodejs';
export const maxDuration = 800; // if you're not on Pro, Vercel will cap you at your plan limit

import { NextResponse, unstable_after as after } from 'next/server';
import { Redis } from '@upstash/redis';
import { randomUUID } from 'crypto';

/* ----------------- Env & Redis ----------------- */
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const SHOPIFY_STORE       = process.env.SHOPIFY_STORE; // "yourstore.myshopify.com"
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
  if (missing.length) throw new Error('Missing env: ' + missing.join(', '));
}

/* ----------------- Auth & locking ----------------- */
function unauthorized() {
  return NextResponse.json({ success: false, error: 'unauthorized' }, { status: 401 });
}
async function ensureCronAuth(req) {
  if (!CRON_SECRET) return true;
  const auth = req.headers.get('authorization') || '';
  return auth === 'Bearer ' + CRON_SECRET;
}

const LOCK_KEY = 'locks:audit-bundles';
const CURSOR_KEY = 'audit:cursor'; // { runId, pageUrl, nextIndex, startedAt }
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

/* ----------------- tunables ----------------- */
const MIN_DELAY_MS   = Number(process.env.SHOPIFY_THROTTLE_MS || 500);
const TIME_BUDGET_MS = Number(process.env.TIME_BUDGET_MS || 270000);

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
function emailKey(e) { return 'email:' + String(e || '').toLowerCase(); }
function productUrlFrom(handle) { return handle ? 'https://' + PUBLIC_STORE_DOMAIN + '/products/' + handle : ''; }

function hasBundleTag(tagsStr) {
  return String(tagsStr || '').split(',').map(t => t.trim().toLowerCase()).includes('bundle');
}
function extractStatusFromTags(tagsStr) {
  const tags = String(tagsStr || '').split(',').map(t => t.trim().toLowerCase());
  if (tags.includes('bundle-out-of-stock')) return 'out-of-stock';
  if (tags.includes('bundle-understocked')) return 'understocked';
  if (tags.includes('bundle-ok')) return 'ok';
  return null;
}
const RANK = { ok: 0, understocked: 1, 'out-of-stock': 2 };
function worstStatus(a, b) {
  const aa = a || 'ok';
  const bb = b || 'ok';
  return (RANK[aa] >= RANK[bb]) ? aa : bb;
}

/* ----------------- Klaviyo ----------------- */
async function subscribeProfilesToList(args) {
  const listId = args.listId;
  const email = args.email;
  const phoneE164 = args.phoneE164;
  const sms = args.sms;

  if (!KLAVIYO_API_KEY) throw new Error('KLAVIYO_API_KEY missing');
  if (!listId) throw new Error('listId missing');
  if (!email) throw new Error('email missing');

  const subscriptions = { email: { marketing: { consent: 'SUBSCRIBED' } } };
  if (sms && phoneE164) subscriptions.sms = { marketing: { consent: 'SUBSCRIBED' } };

  const payload = {
    data: {
      type: 'profile-subscription-bulk-create-job',
      attributes: { profiles: { data: [ { type: 'profile', attributes: { email: email, phone_number: (sms && phoneE164) ? phoneE164 : undefined, subscriptions: subscriptions } } ] } },
      relationships: { list: { data: { type: 'list', id: listId } } },
    },
  };

  const res = await fetch('https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/', {
    method: 'POST',
    headers: {
      Authorization: 'Klaviyo-API-Key ' + KLAVIYO_API_KEY,
      accept: 'application/json',
      'content-type': 'application/json',
      revision: '2023-10-15',
    },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  if (!res.ok) throw new Error('Klaviyo subscribe failed: ' + res.status + ' ' + res.statusText + ' :: ' + body);
  return { ok: true, status: res.status, body };
}

async function updateProfileProperties(args) {
  const email = args.email;
  const properties = args.properties;

  if (!KLAVIYO_API_KEY) throw new Error('KLAVIYO_API_KEY missing');
  if (!email) throw new Error('email missing');

  const filter = 'equals(email,"' + String(email).replace(/"/g, '\\"') + '")';
  const listRes = await fetch('https://a.klaviyo.com/api/profiles/?filter=' + encodeURIComponent(filter) + '&page[size]=1', {
    method: 'GET',
    headers: {
      Authorization: 'Klaviyo-API-Key ' + KLAVIYO_API_KEY,
      accept: 'application/json',
      revision: '2023-10-15',
    },
  });
  if (!listRes.ok) {
    const txt = await listRes.text();
    throw new Error('Profiles lookup failed: ' + listRes.status + ' ' + listRes.statusText + ' :: ' + txt);
  }
  const listJson = await listRes.json();
  const id = listJson && listJson.data && listJson.data[0] && listJson.data[0].id;
  if (!id) return { ok: false, status: 404, body: 'profile_not_found', skipped: true };

  const patchRes = await fetch('https://a.klaviyo.com/api/profiles/' + id + '/', {
    method: 'PATCH',
    headers: {
      Authorization: 'Klaviyo-API-Key ' + KLAVIYO_API_KEY,
      accept: 'application/json',
      'content-type': 'application/json',
      revision: '2023-10-15',
    },
    body: JSON.stringify({ data: { type: 'profile', id: id, attributes: { properties: properties } } }),
  });
  const txt = await patchRes.text();
  if (!patchRes.ok) throw new Error('Profile PATCH failed: ' + patchRes.status + ' ' + patchRes.statusText + ' :: ' + txt);
  return { ok: true, status: patchRes.status, body: txt };
}

async function trackKlaviyoEvent(args) {
  const metricName = args.metricName;
  const email = args.email;
  const phoneE164 = args.phoneE164;
  const properties = args.properties || {};

  if (!KLAVIYO_API_KEY) throw new Error('KLAVIYO_API_KEY missing');
  if (!metricName) throw new Error('metricName missing');

  const body = {
    data: {
      type: 'event',
      attributes: {
        time: new Date().toISOString(),
        properties: properties,
        metric: { data: { type: 'metric', attributes: { name: metricName } } },
        profile: { data: { type: 'profile', attributes: { email: email, phone_number: phoneE164 ? phoneE164 : undefined } } },
      },
    },
  };

  const res = await fetch('https://a.klaviyo.com/api/events/', {
    method: 'POST',
    headers: {
      Authorization: 'Klaviyo-API-Key ' + KLAVIYO_API_KEY,
      accept: 'application/json',
      'content-type': 'application/json',
      revision: '2023-10-15',
    },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error('Klaviyo event failed: ' + res.status + ' ' + res.statusText + ' :: ' + txt);
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

async function fetchShopify(endpointOrUrl, method, body, raw) {
  const m = method || 'GET';
  const isRaw = !!raw;
  if (!endpointOrUrl || typeof endpointOrUrl !== 'string') {
    throw new Error('fetchShopify called with invalid endpoint: "' + endpointOrUrl + '"');
  }
  await rateLimitedDelay();

  const headers = {
    'X-Shopify-Access-Token': String(ADMIN_API_TOKEN),
    'Content-Type': 'application/json',
  };

  const opts = { method: m, headers: headers };
  if (body) opts.body = JSON.stringify(body);

  const url = endpointOrUrl.startsWith('http')
    ? endpointOrUrl
    : 'https://' + SHOPIFY_STORE + '/admin/api/2024-04/' + endpointOrUrl.replace(/^\//, '');

  const res = await fetch(url, opts);
  if (!res.ok) {
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, 2000));
      lastApiCall = Date.now();
      const retry = await fetch(url, opts);
      if (!retry.ok) {
        const t = await retry.text();
        throw new Error('Shopify API error after retry: ' + retry.status + ' ' + retry.statusText + ' - ' + t);
      }
      return isRaw ? retry : retry.json();
    }
    const t = await res.text();
    throw new Error('Shopify API error: ' + res.status + ' ' + res.statusText + ' - ' + t);
  }
  return isRaw ? res : res.json();
}

function extractNextUrlFromLinkHeader(linkHeader) {
  if (!linkHeader) return '';
  const parts = linkHeader.split(',');
  for (let idx = 0; idx < parts.length; idx++) {
    const p = parts[idx];
    if (p.toLowerCase().includes('rel="next"')) {
      const m = p.match(/<([^>]+)>/);
      if (m && m[1]) return m[1];
    }
  }
  return '';
}

async function fetchProductsPage(pageUrl) {
  const fields = encodeURIComponent('id,title,handle,tags,variants');
  const first = 'products.json?limit=250&fields=' + fields;

  const res = await fetchShopify(pageUrl || first, 'GET', null, true);
  const json = await res.json();
  const products = Array.isArray(json && json.products) ? json.products : [];

  const link = res.headers.get('link') || res.headers.get('Link');
  const nextUrl = extractNextUrlFromLinkHeader(link);
  return { products: products, nextUrl: nextUrl };
}

async function getProductMetafields(productId) {
  const res = await fetchShopify('products/' + productId + '/metafields.json');
  if (!res || !Array.isArray(res.metafields)) return null;
  let found = null;
  for (let i = 0; i < res.metafields.length; i++) {
    const m = res.metafields[i];
    if (m.namespace === 'custom' && m.key === 'bundle_structure') { found = m; break; }
  }
  return found;
}

async function updateProductTags(productId, currentTagsCSV, status) {
  const parts = String(currentTagsCSV || '').split(',');
  const cleaned = [];
  for (let i = 0; i < parts.length; i++) {
    const tag = parts[i].trim();
    const tl = tag.toLowerCase();
    if (tl === 'bundle-ok' || tl === 'bundle-understocked' || tl === 'bundle-out-of-stock') continue;
    if (tag) cleaned.push(tag);
  }
  cleaned.push('bundle-' + status);
  await fetchShopify('products/' + productId + '.json', 'PUT', { product: { id: productId, tags: cleaned.join(', ') } });
}

async function fetchVariantQty(variantId) {
  const res = await fetchShopify('variants/' + variantId + '.json');
  return Number(res && res.variant && res.variant.inventory_quantity != null ? res.variant.inventory_quantity : 0);
}

/* ----------------- Redis helpers ----------------- */
async function getStatus(productId) { return (await redis.get('status:' + productId)) || null; }
async function setStatus(productId, prevStatus, currStatus) { await redis.set('status:' + productId, { previous: prevStatus, current: currStatus }); }

async function getPrevTotal(productId) {
  const v = await redis.get('inv_total:' + productId);
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
async function setCurrTotal(productId, total) { await redis.set('inv_total:' + productId, total); }

async function getSubscribersForProduct(prod) {
  const keys = [ 'subscribers:' + prod.id, 'subscribers_handle:' + (prod.handle || '') ];
  const lists = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const v = await redis.get(k);
    if (Array.isArray(v)) { lists.push(v); continue; }
    if (typeof v === 'string') {
      try { lists.push(JSON.parse(v)); } catch { lists.push([]); }
      continue;
    }
    lists.push([]);
  }

  const map = new Map();
  function keyFor(s) { return toE164(s && s.phone || '') || emailKey(s && s.email); }
  function ts(s) { return Date.parse((s && (s.last_rearmed_at || s.subscribed_at)) || 0); }

  for (let li = 0; li < lists.length; li++) {
    const list = lists[li];
    for (let si = 0; si < list.length; si++) {
      const s = list[si];
      const k = keyFor(s);
      if (!k) continue;
      const prev = map.get(k);
      if (!prev || ts(s) >= ts(prev)) map.set(k, s);
    }
  }
  const merged = Array.from(map.values());
  return { merged: merged, keysTried: keys };
}

async function setSubscribersForProduct(prod, subs) {
  await Promise.all([
    redis.set('subscribers:' + prod.id, subs, { ex: 90 * 24 * 60 * 60 }),
    redis.set('subscribers_handle:' + (prod.handle || ''), subs, { ex: 90 * 24 * 60 * 60 }),
  ]);
}

/* ----------------- Notification helper ----------------- */
async function notifyPending(args) {
  const product = args.product;
  const subs = args.subs;
  const pending = args.pending;
  const keysTried = args.keysTried;
  const pid = args.pid;
  const title = args.title;
  const handle = args.handle;
  const isBundle = args.isBundle;

  let notificationsSent = 0;
  let smsNotificationsSent = 0;
  let notificationErrors = 0;
  let profileUpdates = 0;

  const productUrl = productUrlFrom(handle);
  console.log('🔔 Back in stock — ' + title + ' — notifying ' + pending.length + ' pending subscribers (keys: ' + JSON.stringify(keysTried) + ')');
  let processedSubs = 0;

  for (let i = 0; i < pending.length; i++) {
    const sub = pending[i];
    try {
      const phoneE164 = toE164(sub.phone || '');
      const smsConsent = !!sub.sms_consent && !!phoneE164;

      await subscribeProfilesToList({ listId: String(ALERT_LIST_ID), email: sub.email, phoneE164: phoneE164, sms: smsConsent });

      const stampedTitle  = sub.product_title  || title || 'Unknown Product';
      const stampedHandle = sub.product_handle || handle || '';
      const stampedUrl    = sub.product_url    || productUrlFrom(stampedHandle) || productUrl;
      const related_section_url = stampedUrl ? (stampedUrl + '#after-bis') : '';

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
        if (out && out.ok) profileUpdates++;
      } catch (e) {
        console.warn('⚠️ Profile props write failed, continuing:', (e && e.message) || e);
      }

      await trackKlaviyoEvent({
        metricName: 'Back in Stock',
        email: sub.email,
        phoneE164: phoneE164,
        properties: {
          product_id: String(pid),
          product_title: stampedTitle,
          product_handle: stampedHandle,
          product_url: stampedUrl,
          related_section_url: related_section_url,
          sms_consent: !!smsConsent,
          source: isBundle ? 'bundle audit (catalog slice)' : 'catalog slice',
        },
      });

      sub.notified = true;
      notificationsSent++;
      if (smsConsent) smsNotificationsSent++;
      processedSubs++;
      if (processedSubs % 5 === 0) await new Promise(r => setTimeout(r, 250));
    } catch (e) {
      notificationErrors++;
      console.error('❌ Notify failed for ' + (sub && sub.email || '(unknown)') + ':', (e && e.message) || e);
    }
  }

  await setSubscribersForProduct({ id: pid, handle: handle }, subs);
  return { notificationsSent: notificationsSent, smsNotificationsSent: smsNotificationsSent, notificationErrors: notificationErrors, profileUpdates: profileUpdates };
}

/* ----------------- Cursor helpers ----------------- */
async function loadCursor(runId) {
  const cur = await redis.get(CURSOR_KEY);
  if (cur && cur.runId === runId) return cur;
  return { runId: runId, pageUrl: '', nextIndex: 0, startedAt: new Date().toISOString() };
}
async function saveCursor(cursor) { await redis.set(CURSOR_KEY, cursor, { ex: 60 * 60 }); }
async function clearCursor() { try { await redis.del(CURSOR_KEY); } catch {} }

/* ----------------- Time-bounded catalog slice ----------------- */
async function runCatalogSlice(args) {
  const runId = args.runId;
  const verbose = !!args.verbose;

  assertEnv();
  const t0 = Date.now();

  let processed = 0;
  let tagsUpdated = 0;
  let notificationsSent = 0;
  let smsNotificationsSent = 0;
  let notificationErrors = 0;
  let profileUpdates = 0;

  let cursor = await loadCursor(runId);
  if (verbose) console.log('🔎 Slice start runId=' + runId + ' pageUrl=' + (cursor.pageUrl || '(first)') + ' idx=' + (cursor.nextIndex || 0));

  let page = { products: [], nextUrl: '' };
  {
    const pageRes = await fetchProductsPage(cursor.pageUrl);
    page.products = pageRes.products;
    page.nextUrl = pageRes.nextUrl;
  }

  let products = page.products;
  let i = cursor.nextIndex || 0;

  while (true) {
    if (i >= products.length) {
      if (!page.nextUrl) break;
      cursor = { runId: cursor.runId, pageUrl: page.nextUrl, nextIndex: 0, startedAt: cursor.startedAt };
      await saveCursor(cursor);

      const pageRes = await fetchProductsPage(cursor.pageUrl);
      page.products = pageRes.products;
      page.nextUrl = pageRes.nextUrl;

      products = page.products;
      i = 0;
      if (verbose) console.log('📥 Next page: ' + products.length + ' products');
      if (!products.length) break;
    }

    const product = products[i];
    i++;

    try {
      const pid = Number(product.id);
      const title = product.title;
      const handle = product.handle;
      const tagsCSV = String(product.tags || '');

      let total = 0;
      const variants = product.variants || [];
      for (let k = 0; k < variants.length; k++) {
        const v = variants[k];
        total += Number(v && v.inventory_quantity != null ? v.inventory_quantity : 0);
      }

      const prevTotal = await getPrevTotal(pid);
      const increased = prevTotal == null ? false : total > prevTotal;
      await setCurrTotal(pid, total);

      const isBundle = hasBundleTag(tagsCSV);

      if (isBundle) {
        let componentsStatus = 'ok';
        const mf = await getProductMetafields(pid);
        if (mf && mf.value) {
          let comps = [];
          try { comps = JSON.parse(mf.value); } catch { comps = []; }
          const under = [];
          const out = [];
          for (let cIdx = 0; cIdx < comps.length; cIdx++) {
            const c = comps[cIdx];
            if (!c || !c.variant_id) continue;
            let qty = null;
            let vLocal = null;
            for (let vv = 0; vv < variants.length; vv++) {
              const vvItem = variants[vv];
              if (String(vvItem.id) === String(c.variant_id)) { vLocal = vvItem; break; }
            }
            if (vLocal) qty = Number(vLocal.inventory_quantity != null ? vLocal.inventory_quantity : 0);
            if (qty == null) qty = await fetchVariantQty(Number(c.variant_id));
            const req = Number(c.required_quantity != null ? c.required_quantity : 1);
            if (qty === 0) out.push(c.variant_id);
            else if (qty < req) under.push(c.variant_id);
          }
          if (out.length) componentsStatus = 'out-of-stock';
          else if (under.length) componentsStatus = 'understocked';
        }

        const qtys = [];
        for (let q = 0; q < variants.length; q++) {
          const qv = variants[q];
          qtys.push(Number(qv && qv.inventory_quantity != null ? qv.inventory_quantity : 0));
        }
        const ownTotal = qtys.reduce((a, b) => a + b, 0);
        let anyNeg = false;
        for (let q = 0; q < qtys.length; q++) { if (qtys[q] < 0) { anyNeg = true; break; } }
        let allZero = (variants.length > 0);
        for (let q = 0; q < qtys.length; q++) { if (qtys[q] !== 0) { allZero = false; break; } }
        const ownStatus = allZero ? 'out-of-stock' : ((anyNeg || ownTotal < 0) ? 'understocked' : 'ok');

        const finalStatus = worstStatus(componentsStatus, ownStatus);

        const prevObj = await getStatus(pid);
        const prevStatus = (prevObj && prevObj.current) ? prevObj.current : (extractStatusFromTags(tagsCSV) || null);
        await setStatus(pid, prevStatus, finalStatus);

        await updateProductTags(pid, tagsCSV, finalStatus);
        tagsUpdated++;

        if (verbose) {
          console.log('📊 ' + title + ' — bundle comp=' + componentsStatus + ' own=' + ownStatus + ' ⇒ ' + finalStatus + '; total=' + total + ' (prev=' + (prevTotal == null ? 'n/a' : prevTotal) + ', Δ+? ' + increased + ')');
        }

        const mergedOut = await getSubscribersForProduct({ id: pid, handle: handle });
        const subs = mergedOut.merged;
        const keysTried = mergedOut.keysTried;
        const pending = subs.filter(s => !(s && s.notified));

        const prevWasOk = ((prevObj && prevObj.previous) ? prevObj.previous : extractStatusFromTags(tagsCSV)) === 'ok';
        const shouldNotify = (finalStatus === 'ok') && (pending.length > 0) && (!prevWasOk || increased);

        if (shouldNotify) {
          const counts = await notifyPending({ product: product, subs: subs, pending: pending, keysTried: keysTried, pid: pid, title: title, handle: handle, isBundle: true });
          notificationsSent += counts.notificationsSent;
          smsNotificationsSent += counts.smsNotificationsSent;
          notificationErrors += counts.notificationErrors;
          profileUpdates += counts.profileUpdates;
        }
      } else {
        if (verbose) console.log('📊 ' + title + ' — non-bundle; total=' + total + ' (prev=' + (prevTotal == null ? 'n/a' : prevTotal) + ', Δ+? ' + increased + ')');
        const mergedOut = await getSubscribersForProduct({ id: pid, handle: handle });
        const subs = mergedOut.merged;
        const keysTried = mergedOut.keysTried;
        const pending = subs.filter(s => !(s && s.notified));
        const shouldNotify = (pending.length > 0) && increased && total > 0;
        if (shouldNotify) {
          const counts = await notifyPending({ product: product, subs: subs, pending: pending, keysTried: keysTried, pid: pid, title: title, handle: handle, isBundle: false });
          notificationsSent += counts.notificationsSent;
          smsNotificationsSent += counts.smsNotificationsSent;
          notificationErrors += counts.notificationErrors;
          profileUpdates += counts.profileUpdates;
        }
      }

      processed++;
    } catch (e) {
      console.error('❌ Error on product "' + (product && (product.title || product.id)) + '":', (e && e.message) || e);
    }

    if (Date.now() - t0 > TIME_BUDGET_MS) break;
  }

  const pageConsumed = i >= products.length;
  const nextCursor = pageConsumed
    ? { runId: cursor.runId, pageUrl: page.nextUrl, nextIndex: 0, startedAt: cursor.startedAt }
    : { runId: cursor.runId, pageUrl: cursor.pageUrl, nextIndex: i, startedAt: cursor.startedAt };

  await saveCursor(nextCursor);

  const done = pageConsumed && !page.nextUrl;
  return {
    done: done,
    processed: processed,
    tagsUpdated: tagsUpdated,
    notificationsSent: notificationsSent,
    smsNotificationsSent: smsNotificationsSent,
    notificationErrors: notificationErrors,
    profileUpdates: profileUpdates,
    nextCursor: nextCursor,
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
    runId = (cur && cur.runId) ? cur.runId : randomUUID();
  }

  if (action === 'status') {
    const ttl = await redis.ttl(LOCK_KEY);
    const holder = await redis.get(LOCK_KEY);
    const cursor = await redis.get(CURSOR_KEY);
    return NextResponse.json({ locked: ttl > 0, ttl: ttl, holder: holder, cursor: cursor });
  }

  const ok = await acquireOrValidateLock(runId);
  if (!ok) return NextResponse.json({ success: false, error: 'audit already running' }, { status: 423 });

  try {
    const slice = await runCatalogSlice({ runId: runId, verbose: verbose });

    if (!slice.done && loop) {
      const resumeUrl = url.origin + '/api/audit-bundles?loop=1&runId=' + encodeURIComponent(runId) + (verbose ? '&verbose=1' : '');
      after(() => { fetch(resumeUrl, { cache: 'no-store' }).catch(() => {}); });
      await redis.expire(LOCK_KEY, LOCK_TTL_SECONDS);
    } else if (slice.done) {
      await clearCursor();
      await releaseLock(runId);
    } else {
      await redis.expire(LOCK_KEY, LOCK_TTL_SECONDS);
    }

    return NextResponse.json({
      success: true,
      runId: runId,
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
        error: (error && error.message) || String(error),
        stack: process.env.NODE_ENV === 'development' ? (error && error.stack) : undefined,
      },
      { status: 500 },
    );
  }
}

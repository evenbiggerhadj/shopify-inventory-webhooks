export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

import { NextResponse, after } from 'next/server';
import { Redis } from '@upstash/redis';
import { randomUUID } from 'crypto';

/* === CORS helper for public endpoints === */
function cors(json, status = 200) {
  return new NextResponse(JSON.stringify(json), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*', // or your storefront domain
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Cache-Control': 'no-store',
      'Vary': 'Origin',
    },
  });
}

/* ============================ Env ============================ */
const ENV = {
  SHOPIFY_STORE:       process.env.SHOPIFY_STORE,
  ADMIN_API_TOKEN:     process.env.SHOPIFY_ADMIN_API_KEY,
  KLAVIYO_API_KEY:     process.env.KLAVIYO_API_KEY,
  ALERT_LIST_ID:       process.env.KLAVIYO_BACK_IN_STOCK_ALERT_LIST_ID,
  PUBLIC_STORE_DOMAIN: process.env.PUBLIC_STORE_DOMAIN || 'example.com',
  CRON_SECRET:         process.env.CRON_SECRET || '',
  PUBLIC_PROBE_TOKEN:  process.env.PUBLIC_PROBE_TOKEN || '',
  KV_URL:              process.env.KV_REST_API_URL || process.env.KV_URL || process.env.REDIS_URL || '',
  KV_TOKEN:            process.env.KV_REST_API_TOKEN || process.env.KV_REST_API_READ_ONLY_TOKEN || '',
  SOFT_DISABLE_REDIS:  (process.env.SOFT_DISABLE_REDIS || '') === '1',
  SHOPIFY_API_VERSION: process.env.SHOPIFY_API_VERSION || '2025-01',
  SHOPIFY_THROTTLE_MS: Number(process.env.SHOPIFY_THROTTLE_MS || 800),
  TIME_BUDGET_MS:      Number(process.env.TIME_BUDGET_MS || 240000),
};

const LOCK_KEY   = 'locks:audit-bundles';
const CURSOR_KEY = 'audit:cursor';
const LOCK_TTL_SECONDS = 15 * 60;

const RANK = { ok: 0, understocked: 1, 'out-of-stock': 2 };
const worstStatus = (a = 'ok', b = 'ok') => (RANK[a] >= RANK[b]) ? a : b;

/* ====================== Soft-robust Redis ===================== */
let _redis = null;
let redisDisabled = ENV.SOFT_DISABLE_REDIS;

function isUpstashLimitError(e) {
  const msg = (e?.message || e || '').toString().toLowerCase();
  return msg.includes('max requests limit exceeded') || msg.includes('429');
}
function requireRedisEnv() {
  if (!ENV.KV_URL || !ENV.KV_TOKEN) throw new Error('Redis misconfigured');
}
function getRedis() {
  if (redisDisabled) throw new Error('redis_disabled');
  requireRedisEnv();
  if (!_redis) _redis = new Redis({ url: ENV.KV_URL, token: ENV.KV_TOKEN });
  return _redis;
}
async function RGET(k, d=null){ if (redisDisabled) return d; try{ return await getRedis().get(k);}catch(e){ if(isUpstashLimitError(e)) redisDisabled=true; return d; } }
async function RSET(k,v,o){ if (redisDisabled) return null; try{ return await getRedis().set(k,v,o);}catch(e){ if(isUpstashLimitError(e)) redisDisabled=true; return null; } }
async function RDEL(k){ if (redisDisabled) return null; try{ return await getRedis().del(k);}catch(e){ if(isUpstashLimitError(e)) redisDisabled=true; return null; } }
async function REXPIRE(k,s){ if (redisDisabled) return null; try{ return await getRedis().expire(k,s);}catch(e){ if(isUpstashLimitError(e)) redisDisabled=true; return null; } }
async function RTTL(k){ if (redisDisabled) return -2; try{ return await getRedis().ttl(k);}catch(e){ if(isUpstashLimitError(e)) redisDisabled=true; return -2; } }

/* =========================== Auth ============================ */
function unauthorized(){ return NextResponse.json({ success:false, error:'unauthorized' },{ status:401 }); }
async function ensureCronAuth(req){
  if (req.headers.get('x-vercel-cron')) return true;
  if (!ENV.CRON_SECRET) return true;
  const a = req.headers.get('authorization') || '';
  if (a === `Bearer ${ENV.CRON_SECRET}`) return true;
  const url = new URL(req.url);
  if (url.searchParams.get('token') === ENV.CRON_SECRET) return true;
  return false;
}

/* =========================== Lock ============================ */
async function acquireOrValidateLock(runId){
  if (redisDisabled) return true;
  const holder = await RGET(LOCK_KEY);
  if (!holder) {
    const res = await RSET(LOCK_KEY, runId, { nx:true, ex: LOCK_TTL_SECONDS });
    return !!res;
  }
  if (holder === runId) { await REXPIRE(LOCK_KEY, LOCK_TTL_SECONDS); return true; }
  return false;
}
async function releaseLock(runId){ if (redisDisabled) return; const holder = await RGET(LOCK_KEY); if (holder === runId) await RDEL(LOCK_KEY); }

/* =========================== Utils =========================== */
const productUrlFrom = (handle) => (handle ? `https://${ENV.PUBLIC_STORE_DOMAIN}/products/${handle}` : '');
function hasBundleTag(tagsStr){
  return String(tagsStr||'').split(',').map(t=>t.trim().toLowerCase()).includes('bundle');
}
function extractStatusFromTags(tagsStr){
  const tags = String(tagsStr||'').split(',').map(t=>t.trim().toLowerCase());
  if (tags.includes('bundle-out-of-stock')) return 'out-of-stock';
  if (tags.includes('bundle-understocked')) return 'understocked';
  if (tags.includes('bundle-ok')) return 'ok';
  return null;
}
function toE164(raw){
  if (!raw) return null;
  let v = String(raw).trim().replace(/[^\d+]/g,'');
  if (v.startsWith('+')) return /^\+\d{8,15}$/.test(v) ? v : null;
  if (/^0\d{10}$/.test(v)) return '+234' + v.slice(1);
  if (/^(70|80|81|90|91)\d{8}$/.test(v)) return '+234' + v;
  if (/^\d{10}$/.test(v)) return '+1' + v;
  return null;
}

/* ========================= Klaviyo =========================== */
async function subscribeProfilesToList({ listId, email, phoneE164, sms }) {
  if (!ENV.KLAVIYO_API_KEY) throw new Error('KLAVIYO_API_KEY missing');
  if (!listId) throw new Error('listId missing');
  if (!email) throw new Error('email missing');
  const subscriptions = { email: { marketing: { consent: 'SUBSCRIBED' } } };
  if (sms && phoneE164) subscriptions.sms = { marketing: { consent: 'SUBSCRIBED' } };
  const payload = { data: { type:'profile-subscription-bulk-create-job',
    attributes:{ profiles:{ data:[{ type:'profile', attributes:{ email, ...(sms&&phoneE164?{ phone_number: phoneE164 }:{}), subscriptions } }] } },
    relationships:{ list:{ data:{ type:'list', id:listId } } } } };
  const res = await fetch('https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/',{
    method:'POST',
    headers:{ 'Authorization':`Klaviyo-API-Key ${ENV.KLAVIYO_API_KEY}`,'accept':'application/json','content-type':'application/json','revision':'2023-10-15' },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Klaviyo subscribe failed: ${res.status} ${res.statusText} :: ${body}`);
  return { ok:true, status:res.status, body };
}
async function updateProfileProperties({ email, properties }) {
  if (!ENV.KLAVIYO_API_KEY) throw new Error('KLAVIYO_API_KEY missing');
  if (!email) throw new Error('email missing');
  const filter = `equals(email,"${String(email).replace(/"/g,'\\"')}")`;
  const listRes = await fetch(`https://a.klaviyo.com/api/profiles/?filter=${encodeURIComponent(filter)}&page[size]=1`,{
    method:'GET', headers:{ 'Authorization':`Klaviyo-API-Key ${ENV.KLAVIYO_API_KEY}`,'accept':'application/json','revision':'2023-10-15' } });
  if (!listRes.ok){ const txt = await listRes.text(); throw new Error(`Profiles lookup failed: ${listRes.status} ${listRes.statusText} :: ${txt}`); }
  const listJson = await listRes.json();
  const id = listJson?.data?.[0]?.id;
  if (!id) return { ok:false, status:404, body:'profile_not_found', skipped:true };
  const patchRes = await fetch(`https://a.klaviyo.com/api/profiles/${id}/`, {
    method:'PATCH',
    headers:{ 'Authorization':`Klaviyo-API-Key ${ENV.KLAVIYO_API_KEY}`,'accept':'application/json','content-type':'application/json','revision':'2023-10-15' },
    body: JSON.stringify({ data:{ type:'profile', id, attributes:{ properties } } }),
  });
  const txt = await patchRes.text();
  if (!patchRes.ok) throw new Error(`Profile PATCH failed: ${patchRes.status} ${patchRes.statusText} :: ${txt}`);
  return { ok:true, status:patchRes.status, body:txt };
}
async function trackKlaviyoEvent({ metricName, email, phoneE164, properties }) {
  if (!ENV.KLAVIYO_API_KEY) throw new Error('KLAVIYO_API_KEY missing');
  if (!metricName) throw new Error('metricName missing');
  const body = { data:{ type:'event', attributes:{ time:new Date().toISOString(), properties:properties||{}, metric:{ data:{ type:'metric', attributes:{ name:metricName } } }, profile:{ data:{ type:'profile', attributes:{ email, ...(phoneE164?{ phone_number: phoneE164 }:{}) } } } } } };
  const res = await fetch('https://a.klaviyo.com/api/events/',{
    method:'POST', headers:{ 'Authorization':`Klaviyo-API-Key ${ENV.KLAVIYO_API_KEY}`,'accept':'application/json','content-type':'application/json','revision':'2023-10-15' }, body: JSON.stringify(body) });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Klaviyo event failed: ${res.status} ${res.statusText} :: ${txt}`);
  return { ok:true, status:res.status, body:txt };
}

/* ===================== Shopify helpers ======================= */
let lastApiCall = 0;
function jitter(ms){ return ms + Math.floor(Math.random()*120); }
async function rateLimitedDelay(){
  const now = Date.now();
  const dt = now - lastApiCall;
  const min = ENV.SHOPIFY_THROTTLE_MS;
  if (dt < min) await new Promise(r => setTimeout(r, jitter(min - dt)));
  lastApiCall = Date.now();
}

async function fetchShopifyREST(endpointOrUrl, method='GET', body=null, raw=false){
  const headers = { 'X-Shopify-Access-Token': String(ENV.ADMIN_API_TOKEN), 'Content-Type':'application/json' };
  const url = endpointOrUrl.startsWith('http')
    ? endpointOrUrl
    : `https://${ENV.SHOPIFY_STORE}/admin/api/${ENV.SHOPIFY_API_VERSION}/${endpointOrUrl.replace(/^\//,'')}`;
  const optsBase = { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) };

  let attempt = 0;
  while (true) {
    await rateLimitedDelay();
    const res = await fetch(url, optsBase);
    if (res.ok) return raw ? res : res.json();

    if (res.status === 429 && attempt < 5) {
      const ra = Number(res.headers.get('retry-after') || 0);
      const wait = ra ? (ra*1000) : (1500 + attempt*600 + Math.floor(Math.random()*300));
      await new Promise(r => setTimeout(r, wait));
      lastApiCall = Date.now();
      attempt++;
      continue;
    }

    const t = await res.text();
    throw new Error(`Shopify REST error${attempt? ' after retry':''}: ${res.status} ${res.statusText} - ${t}`);
  }
}

async function fetchShopifyGQL(query, variables={}){
  const url = `https://${ENV.SHOPIFY_STORE}/admin/api/${ENV.SHOPIFY_API_VERSION}/graphql.json`;
  const opts = { method:'POST', headers:{ 'X-Shopify-Access-Token': String(ENV.ADMIN_API_TOKEN),'Content-Type':'application/json' }, body: JSON.stringify({ query, variables }) };

  let attempt = 0;
  while (true) {
    await rateLimitedDelay();
    const res = await fetch(url, opts);
    const json = await res.json().catch(() => ({}));
    if (res.ok && !json.errors) return json.data;

    if (res.status === 429 && attempt < 5) {
      const ra = Number(res.headers.get('retry-after') || 0);
      const wait = ra ? (ra*1000) : (1500 + attempt*600 + Math.floor(Math.random()*300));
      await new Promise(r => setTimeout(r, wait));
      lastApiCall = Date.now();
      attempt++;
      continue;
    }

    throw new Error(`Shopify GraphQL error${attempt? ' after retry':''}: ${res.status} ${res.statusText} - ${JSON.stringify(json.errors || json)}`);
  }
}

function extractNextUrlFromLinkHeader(linkHeader){
  if (!linkHeader) return '';
  const parts = linkHeader.split(',');
  for (const p of parts) if (p.toLowerCase().includes('rel="next"')){ const m = p.match(/<([^>]+)>/); if (m && m[1]) return m[1]; }
  return '';
}

async function fetchProductsPage(pageUrl){
  const fields = encodeURIComponent('id,title,handle,tags,variants');
  const first = `products.json?limit=250&fields=${fields}`;
  const res = await fetchShopifyREST(pageUrl || first, 'GET', null, true);
  const json = await res.json();
  const products = Array.isArray(json?.products) ? json.products : [];
  const link = res.headers.get('link') || res.headers.get('Link');
  const nextUrl = extractNextUrlFromLinkHeader(link);
  return { products, nextUrl };
}

async function updateProductTags(productId, currentTagsCSV, status){
  const cleaned = String(currentTagsCSV||'')
    .split(',').map(t => t.trim())
    .filter(tag => !['bundle-ok','bundle-understocked','bundle-out-of-stock'].includes(tag.toLowerCase()))
    .concat([`bundle-${status}`]);
  await fetchShopifyREST(`products/${productId}.json`, 'PUT', { product:{ id: productId, tags: cleaned.join(', ') } });
}

/* ===================== Redis helpers ========================= */
async function getStatus(productId){ return (await RGET(`status:${productId}`)) || null; }
async function setStatus(productId, prevStatus, currStatus){ await RSET(`status:${productId}`, { previous: prevStatus, current: currStatus }); }
async function getPrevTotal(productId){ const v = await RGET(`inv_total:${productId}`); if (v==null) return null; const n = Number(v); return Number.isFinite(n)?n:null; }
async function setCurrTotal(productId, total){ await RSET(`inv_total:${productId}`, total); }

/* ================== Subscribers (Redis) ====================== */
const emailKey = (e) => `email:${String(e||'').toLowerCase()}`;
async function getSubscribersForProduct(prod){
  const keys = [`subscribers:${prod.id}`, `subscribers_handle:${prod.handle||''}`];
  const lists = await Promise.all(keys.map(async k => {
    const v = await RGET(k);
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return []; } }
    return [];
  }));
  const map = new Map();
  const keyFor = (s) => toE164(s?.phone||'') || emailKey(s?.email);
  const ts = (s) => Date.parse(s?.last_rearmed_at || s?.subscribed_at || 0);
  for (const list of lists) for (const s of list){
    const k = keyFor(s); if (!k) continue;
    const prev = map.get(k);
    if (!prev || ts(s) >= ts(prev)) map.set(k, s);
  }
  return { merged: Array.from(map.values()), keysTried: keys };
}
async function setSubscribersForProduct(prod, subs){
  await Promise.all([
    RSET(`subscribers:${prod.id}`, subs, { ex: 90*24*60*60 }),
    RSET(`subscribers_handle:${prod.handle||''}`, subs, { ex: 90*24*60*60 }),
  ]);
}

/* ================== Bundle ETA summarizer ==================== */
async function getBundleStatusFromGraphQL(productId){
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
                    availableForSale
                    inventoryPolicy
                    sellableOnlineQuantity
                    metafield(namespace:"custom", key:"restock_date") { value }
                    product { handle metafield(namespace:"custom", key:"restock_date") { value } }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;
  const gid = `gid://shopify/Product/${productId}`;
  let data;
  try { data = await fetchShopifyGQL(query, { id: gid, vv: 100, cp: 100 }); }
  catch { return { ok:false, hasComponents:false, variantResults:[], totalBuildable:0, finalStatus:null, earliestISO:null, earliestSource:null }; }

  const edges = data?.product?.variants?.edges || [];
  let hasComponents = false;
  const variantResults = [];
  let earliestISO = null;
  let earliestSource = null;

  for (const e of edges) {
    const comps = e?.node?.productVariantComponents?.nodes || [];
    if (comps.length) hasComponents = true;
    if (!comps.length) continue;

    let anyZeroOrNeg = false;
    let anyInsufficient = false;
    let minBuildable = Infinity;

    for (const c of comps) {
      const pv = c?.productVariant; if (!pv) continue;
      const have = Math.max(0, Number(pv.sellableOnlineQuantity ?? 0));
      const need = Math.max(1, Number(c?.quantity ?? 1));
      const policy = String(pv.inventoryPolicy || '').toUpperCase();

      const isOOS = (pv.availableForSale === false) || (have <= 0 && (policy === 'DENY' || policy === 'CONTINUE'));

      if (have <= 0) anyZeroOrNeg = true; else if (have < need) anyInsufficient = true;
      minBuildable = Math.min(minBuildable, Math.floor(have / need));

      const raw = pv.metafield?.value || pv.product?.metafield?.value || null;
      if (isOOS && raw) {
        const iso = raw.length === 10 ? `${raw}T00:00:00Z` : raw;
        if (!earliestISO || new Date(iso) < new Date(earliestISO)) {
          earliestISO = iso;
          earliestSource = { handle: pv.product?.handle, variantGid: pv.id, date: iso };
        }
      }
    }

    const buildable = Number.isFinite(minBuildable) ? Math.max(0, minBuildable) : 0;
    const status = anyZeroOrNeg ? 'out-of-stock' : (anyInsufficient ? 'understocked' : 'ok');
    variantResults.push({ buildable, status });
  }

  if (!variantResults.length) {
    return { ok:true, hasComponents, variantResults:[], totalBuildable:0, finalStatus:'ok', earliestISO:null, earliestSource:null };
  }

  let finalStatus = 'ok';
  let totalBuildable = 0;
  for (const r of variantResults) { totalBuildable += r.buildable; finalStatus = worstStatus(finalStatus, r.status); }
  return { ok:true, hasComponents, variantResults, totalBuildable, finalStatus, earliestISO, earliestSource };
}

/* ================== Bundle components (per-component ETA) ==== */
// Reads each component on a bundle variant and pulls the ETA from the
// component VARIANT metafield custom.restock_date, falling back to PRODUCT.
async function getBundleComponents(pid){
  const query = `
    query($id: ID!, $vv:Int!, $cp:Int!) {
      product(id:$id){
        id handle title
        variants(first:$vv){
          edges{
            node{
              id title
              productVariantComponents(first:$cp){
                nodes{
                  quantity
                  productVariant{
                    id title sku
                    availableForSale
                    inventoryPolicy
                    sellableOnlineQuantity
                    metafield(namespace:"custom", key:"restock_date"){ value }
                    product{
                      handle title
                      metafield(namespace:"custom", key:"restock_date"){ value }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }`;
  const gid = `gid://shopify/Product/${pid}`;
  const data = await fetchShopifyGQL(query, { id: gid, vv: 100, cp: 100 });

  const out = [];
  for (const e of (data?.product?.variants?.edges || [])) {
    for (const c of (e?.node?.productVariantComponents?.nodes || [])) {
      const pv = c?.productVariant; if (!pv) continue;
      const need = Math.max(1, Number(c?.quantity ?? 1));
      const have = Math.max(0, Number(pv.sellableOnlineQuantity ?? 0));
      const policy = String(pv.inventoryPolicy || '').toUpperCase();
      const isOOS = (pv.availableForSale === false) || (have <= 0 && (policy === 'DENY' || policy === 'CONTINUE'));

      // VARIANT metafield first; then PRODUCT metafield fallback
      const raw = pv.metafield?.value || pv.product?.metafield?.value || null;
      const iso = raw ? (raw.length === 10 ? `${raw}T00:00:00Z` : raw) : null;

      out.push({
        component: {
          variant_gid: pv.id,
          variant_title: pv.title || '',
          sku: pv.sku || '',
          product_handle: pv.product?.handle || '',
          product_title: pv.product?.title || '',
        },
        required_qty: need,
        available_qty: have,
        inventory_policy: policy,
        status: isOOS ? (have<=0 ? 'out-of-stock' : 'understocked') : 'ok',
        restock_iso: iso,
        restock_pretty: iso ? new Date(iso).toISOString().slice(0,10) : null,
      });
    }
  }
  return out;
}


/* ================== Bundle ETA writer ======================== */
/** Writes or clears product metafields:
 *  - custom.bundle_next_ship_date   (type: date)
 *  - custom.bundle_next_ship_source (single_line_text_field)
 */
async function setBundleNextShipDate(productGid, isoDateOrNull, source) {
  if (!isoDateOrNull) {
    // Delete both metafields if present
    const q = `
      query($id: ID!) {
        product(id: $id) {
          id
          dateMf: metafield(namespace:"custom", key:"bundle_next_ship_date")   { id }
          srcMf:  metafield(namespace:"custom", key:"bundle_next_ship_source") { id }
        }
      }`;
    const d = await fetchShopifyGQL(q, { id: productGid });
    const ids = [d?.product?.dateMf?.id, d?.product?.srcMf?.id].filter(Boolean);
    if (ids.length) {
      const del = `
        mutation($ids:[ID!]!) {
          metafieldsDelete(ids:$ids) { deletedIds userErrors { field message } }
        }`;
      try { await fetchShopifyGQL(del, { ids }); } catch {}
    }
    return;
  }

  const dateOnly = isoDateOrNull.slice(0, 10); // metafield type "date" needs YYYY-MM-DD
  const srcText = source ? `${source.handle || ''} | ${source.variantGid || ''} | ${dateOnly}`.trim() : 'computed';

  const m = `
    mutation setBundleDate($owner: ID!, $date: String!, $source: String) {
      metafieldsSet(metafields: [
        { ownerId:$owner, namespace:"custom", key:"bundle_next_ship_date",  type:"date", value:$date },
        { ownerId:$owner, namespace:"custom", key:"bundle_next_ship_source", type:"single_line_text_field", value:$source }
      ]) {
        userErrors { field message }
      }
    }`;
  await fetchShopifyGQL(m, { owner: productGid, date: dateOnly, source: srcText });
}

/* ==================== Catalog slice ========================== */
async function runCatalogSlice({ runId, verbose=false }){
  if (!ENV.SHOPIFY_STORE) throw new Error('Missing env: SHOPIFY_STORE');
  if (!ENV.ADMIN_API_TOKEN) throw new Error('Missing env: SHOPIFY_ADMIN_API_KEY');

  const t0 = Date.now();
  let processed=0, tagsUpdated=0, notificationsSent=0, smsNotificationsSent=0, notificationErrors=0, profileUpdates=0;

  let cursor = await loadCursor(runId);
  if (verbose) console.log(`Slice start runId=${runId} pageUrl=${cursor.pageUrl||'(first)'} idx=${cursor.nextIndex} redisDisabled=${redisDisabled}`);

  let page = { products:[], nextUrl:'' };
  let products = [];
  let i = cursor.nextIndex || 0;

  { const pageRes = await fetchProductsPage(cursor.pageUrl); products = pageRes.products; page.nextUrl = pageRes.nextUrl; }

  while (true) {
    if (i >= products.length) {
      if (!page.nextUrl) break;
      cursor = { ...cursor, pageUrl: page.nextUrl, nextIndex: 0 };
      await saveCursor(cursor);
      const pageRes = await fetchProductsPage(cursor.pageUrl);
      products = pageRes.products; page.nextUrl = pageRes.nextUrl;
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
      const bundleTagged = hasBundleTag(tagsCSV);

      // Always try to summarize via GraphQL; tells us if it's a native bundle
      const summary = await getBundleStatusFromGraphQL(pid);
      const isNativeBundle = !!summary.ok && !!summary.hasComponents;
      const treatAsBundle = bundleTagged || isNativeBundle;

      if (treatAsBundle) {
        // REST fallback for totals (clamped)
        const restTotal = (product.variants || []).reduce((acc, v) => acc + Math.max(0, Number(v?.inventory_quantity ?? 0)), 0);
        const prevTotal = await getPrevTotal(pid);

        let finalStatus=null, totalBuildable=0;
        if (summary.ok){ finalStatus = summary.finalStatus; totalBuildable = Number(summary.totalBuildable||0); }
        else {
          finalStatus = ((product.variants||[]).length>0 && (product.variants||[]).every(v=>Math.max(0, Number(v?.inventory_quantity??0))===0)) ? 'out-of-stock' : 'ok';
          totalBuildable = restTotal;
        }

        // Persist earliest ETA metafield ONLY when truly out-of-stock
        try {
          const productGid = `gid://shopify/Product/${pid}`;
          const iso = (finalStatus === 'out-of-stock' && summary.ok && summary.earliestISO) ? summary.earliestISO : null;
          await setBundleNextShipDate(productGid, iso, summary.earliestSource || undefined);
        } catch (e) {
          console.error(`bundle_next_ship_date set failed for ${title} (${pid})`, e?.message || e);
        }

        const increased = prevTotal == null ? false : totalBuildable > prevTotal;
        await setCurrTotal(pid, totalBuildable);

        const prevObj = await getStatus(pid);
        const prevStatusFromTags = extractStatusFromTags(tagsCSV);
        const prevStatus = prevObj?.current || prevStatusFromTags || null;
        await setStatus(pid, prevStatus, finalStatus);

        // Only mutate tags if product is explicitly tagged as bundle
        if (bundleTagged && prevStatusFromTags !== finalStatus) {
          await updateProductTags(pid, tagsCSV, finalStatus);
          tagsUpdated++;
        }

        if (verbose) console.log(`📦 ${title} — status=${finalStatus}; buildable=${totalBuildable} (prev=${prevTotal ?? 'n/a'})`);

        if (!redisDisabled) {
          const { merged: allSubs } = await getSubscribersForProduct({ id: pid, handle });
          const pending = allSubs.filter(s => !s?.notified);
          const prevWasOk = (prevObj?.previous ?? prevStatusFromTags) === 'ok';
          const shouldNotify = (finalStatus === 'ok') && pending.length > 0 && (!prevWasOk || increased);
          if (shouldNotify) {
            const counts = await notifyPending({ allSubs, pending, pid, title, handle, isBundle:true });
            notificationsSent    += counts.notificationsSent;
            smsNotificationsSent += counts.smsNotificationsSent;
            notificationErrors   += counts.notificationErrors;
            profileUpdates       += counts.profileUpdates;
          }
        }
      }

      processed++;
    } catch (e) {
      console.error(`Error on product "${product?.title || product?.id}":`, e?.message || e);
    }

    if (Date.now() - t0 > ENV.TIME_BUDGET_MS) break;
  }

  const pageConsumed = i >= products.length;
  const nextCursor = pageConsumed ? { ...cursor, pageUrl: page.nextUrl, nextIndex: 0 } : { ...cursor, nextIndex: i };
  await saveCursor(nextCursor);

  const done = pageConsumed && !page.nextUrl;
  return { done, processed, tagsUpdated, notificationsSent, smsNotificationsSent, notificationErrors, profileUpdates, nextCursor:{ ...nextCursor, runId }, sliceMs: Date.now()-t0, redisDisabled };
}

/* =================== Notify (Klaviyo) ======================== */
async function notifyPending({ allSubs, pending, pid, title, handle, isBundle }){
  if (redisDisabled) return { notificationsSent:0, smsNotificationsSent:0, notificationErrors:0, profileUpdates:0 };
  let notificationsSent=0, smsNotificationsSent=0, notificationErrors=0, profileUpdates=0;
  const productUrl = productUrlFrom(handle);
  let processed=0;
  for (const sub of pending) {
    try {
      const phoneE164 = toE164(sub.phone||'');
      const smsConsent = !!sub.sms_consent && !!phoneE164;
      await subscribeProfilesToList({ listId:String(ENV.ALERT_LIST_ID), email:sub.email, phoneE164, sms:smsConsent });
      const stampedTitle = sub.product_title || title || 'Unknown Product';
      const stampedHandle = sub.product_handle || handle || '';
      const stampedUrl = sub.product_url || productUrlFrom(stampedHandle) || productUrl;
      const related_section_url = stampedUrl ? `${stampedUrl}#after-bis` : '';
      try{
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
      }catch{}
      await trackKlaviyoEvent({
        metricName:'Back in Stock',
        email: sub.email,
        phoneE164,
        properties:{ product_id:String(pid), product_title:stampedTitle, product_handle:stampedHandle, product_url:stampedUrl, related_section_url, sms_consent:!!smsConsent, source: isBundle ? 'bundle audit (native components)' : 'catalog slice' },
      });
      sub.notified = true;
      notificationsSent++;
      if (smsConsent) smsNotificationsSent++;
      if (++processed % 5 === 0) await new Promise(r => setTimeout(r, 250));
    }catch{ notificationErrors++; }
  }
  await setSubscribersForProduct({ id:pid, handle }, allSubs);
  return { notificationsSent, smsNotificationsSent, notificationErrors, profileUpdates };
}

/* ========================= Cursor ============================ */
async function loadCursor(runId){ if (redisDisabled) return { runId, pageUrl:'', nextIndex:0, startedAt:new Date().toISOString() }; const cur = await RGET(CURSOR_KEY); if (cur && cur.runId === runId) return cur; return { runId, pageUrl:'', nextIndex:0, startedAt:new Date().toISOString() }; }
async function saveCursor(cursor){ if (redisDisabled) return; await RSET(CURSOR_KEY, cursor, { ex: 60*60 }); }
async function clearCursor(){ if (redisDisabled) return; await RDEL(CURSOR_KEY); }

/* ========================= GET =============================== */
export async function GET(req){
  try {
    const url = new URL(req.url);
    const q = (k) => (url.searchParams.get(k) || '').toLowerCase();

    /* ---- Public probe (read-only, no admin writes) ---- */
    if (q('action') === 'probe_public') {
      const token = url.searchParams.get('token') || '';
      if (ENV.PUBLIC_PROBE_TOKEN && token !== ENV.PUBLIC_PROBE_TOKEN) {
        return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
      }
      const handle = url.searchParams.get('handle');
      if (!handle) return NextResponse.json({ error: 'missing handle' }, { status: 400 });

      const lookup = await fetchShopifyGQL(`query($h:String!){ productByHandle(handle:$h){ id handle } }`, { h: handle });
      const gid = lookup?.productByHandle?.id;
      if (!gid) return NextResponse.json({ error: 'not_found' }, { status: 404 });
      const pid = Number(String(gid).split('/').pop());

      const summary = await getBundleStatusFromGraphQL(pid);
      const payload = {
        handle,
        hasComponents: !!summary?.hasComponents,
        finalStatus: summary?.finalStatus || null,
        earliestISO: summary?.earliestISO || null,
        earliestPretty: summary?.earliestISO ? new Date(summary.earliestISO).toISOString().slice(0,10) : null,
        source: summary?.earliestSource || null
      };
return cors(payload);
    }
    /* ---- Per-component list (public, read-only) ---- */
    if (q('action') === 'components') {
      const token = url.searchParams.get('token') || '';
      if (ENV.PUBLIC_PROBE_TOKEN && token !== ENV.PUBLIC_PROBE_TOKEN) {
        return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
      }
      const handle = url.searchParams.get('handle');
      if (!handle) return NextResponse.json({ error:'missing handle' }, { status:400 });

      const lookup = await fetchShopifyGQL(
        `query($h:String!){ productByHandle(handle:$h){ id handle } }`,
        { h: handle }
      );
      const gid = lookup?.productByHandle?.id;
      if (!gid) return NextResponse.json({ error: 'not_found' }, { status: 404 });
      const pid = Number(String(gid).split('/').pop());

      const components = await getBundleComponents(pid);
      // Only surface pain points on the PDP
      const filtered = components.filter(c => c.status !== 'ok');
return cors({ handle, count: filtered.length, components: filtered });
    }

    /* ---- Self test ---- */
    if (q('action') === 'selftest') {
      const out = {
        env_ok: true,
        has_store: !!ENV.SHOPIFY_STORE,
        has_admin_token: !!ENV.ADMIN_API_TOKEN,
        has_klaviyo_key: !!ENV.KLAVIYO_API_KEY,
        has_alert_list: !!ENV.ALERT_LIST_ID,
        has_kv_url: !!ENV.KV_URL,
        has_kv_token: !!ENV.KV_TOKEN,
        redisDisabled,
      };
      if (!redisDisabled) {
        try { await getRedis().ping(); out.redis_ping = 'ok'; }
        catch (e) { out.redis_ping = `fail: ${e?.message || e}`; if (isUpstashLimitError(e)) { redisDisabled = true; out.redisDisabled = true; } }
      }
      return NextResponse.json(out);
    }

    /* ---- Status ---- */
    if (q('action') === 'status') {
      const ttl = await RTTL(LOCK_KEY);
      const holder = await RGET(LOCK_KEY);
      const cursor = await RGET(CURSOR_KEY);
      return NextResponse.json({ locked: ttl > 0, ttl, holder, cursor, redisDisabled });
    }

    /* ---- Auth for mutating runs ---- */
    const authed = await ensureCronAuth(req);
    if (!authed) return unauthorized();

    /* ---- Slice run ---- */
    const verbose = ['1','true','yes'].includes(q('verbose'));
    const loop = (!redisDisabled) && ['1','true','yes'].includes(q('loop'));

    let runId = url.searchParams.get('runId');
    if (!runId) {
      const cur = await RGET(CURSOR_KEY);
      runId = cur?.runId || randomUUID();
    }

    const ok = await acquireOrValidateLock(runId);
    if (!ok) return NextResponse.json({ success:false, error:'audit already running' }, { status:423 });

    try {
      const slice = await runCatalogSlice({ runId, verbose });

      if (!slice.done && loop) {
        const resumeUrl = new URL(req.url);
        resumeUrl.searchParams.set('loop','1');
        resumeUrl.searchParams.set('runId', runId);
        if (verbose) resumeUrl.searchParams.set('verbose','1');
        const headers = ENV.CRON_SECRET ? { authorization:`Bearer ${ENV.CRON_SECRET}` } : undefined;
        after(() => fetch(resumeUrl.toString(), { cache:'no-store', headers }).catch(() => {}));
        await REXPIRE(LOCK_KEY, LOCK_TTL_SECONDS);
      } else if (slice.done) {
        await clearCursor();
        await releaseLock(runId);
      } else {
        await REXPIRE(LOCK_KEY, LOCK_TTL_SECONDS);
      }

      return NextResponse.json({
        success:true,
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
        redisDisabled: slice.redisDisabled,
        message: slice.done ? 'Catalog sweep complete'
          : (loop ? 'Slice complete; another slice scheduled' : 'Slice complete; call again to resume'),
      });
    } catch (e) {
      await releaseLock(runId);
      return NextResponse.json({ success:false, error: e?.message || String(e) }, { status:500 });
    }
  } catch (fatal) {
    return NextResponse.json({ success:false, error: fatal?.message || String(fatal) }, { status:500 });
  }
}

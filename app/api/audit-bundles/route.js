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

const SHOPIFY_STORE   = process.env.SHOPIFY_STORE;           // "yourstore.myshopify.com"
const ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_KEY;

const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY || '';
const ALERT_LIST_ID   = process.env.KLAVIYO_BACK_IN_STOCK_ALERT_LIST_ID || '';

const PUBLIC_STORE_DOMAIN = process.env.PUBLIC_STORE_DOMAIN || 'example.com';
const CRON_SECRET         = process.env.CRON_SECRET || '';

/** Paging/time-budget */
const DEFAULT_PAGE_SIZE = Number(process.env.AUDIT_PAGE_SIZE || 30);
const TIME_BUDGET_MS    = Number(process.env.TIME_BUDGET_MS || 55_000);
const CURSOR_KEY        = 'cursor:audit-products:since_id';

/** Redis keys */
const invKey = (id: number | string) => `snap:${id}`;

/** Required env for Admin ops */
function assertEnv() {
  const missing = [];
  if (!SHOPIFY_STORE)   missing.push('SHOPIFY_STORE');
  if (!ADMIN_API_TOKEN) missing.push('SHOPIFY_ADMIN_API_KEY');
  if (missing.length) throw new Error(`Missing env: ${missing.join(', ')}`);
}

/* ----------------- Cron auth & overlap lock ----------------- */
function unauthorized() {
  return NextResponse.json({ success: false, error: 'unauthorized' }, { status: 401 });
}
async function ensureCronAuth(req: Request) {
  if (!CRON_SECRET) return true;
  const auth = req.headers.get('authorization') || '';
  return auth === `Bearer ${CRON_SECRET}`;
}
const LOCK_KEY = 'locks:audit-products';
const LOCK_TTL_SECONDS = 15 * 60;
async function acquireLock() {
  try { return !!(await redis.set(LOCK_KEY, Date.now(), { nx: true, ex: LOCK_TTL_SECONDS })); }
  catch { return false; }
}
async function releaseLock() { try { await redis.del(LOCK_KEY); } catch {} }

/* ----------------- small utils ----------------- */
const toE164 = (raw?: string | null) => {
  if (!raw) return null;
  let v = String(raw).trim().replace(/[^\d+]/g, '');
  if (v.startsWith('+')) return /^\+\d{8,15}$/.test(v) ? v : null;
  if (/^0\d{10}$/.test(v)) return '+234' + v.slice(1);
  if (/^(70|80|81|90|91)\d{8}$/.test(v)) return '+234' + v;
  if (/^\d{10}$/.test(v)) return '+1' + v;
  return null;
};
const emailKey = (e?: string) => `email:${String(e || '').toLowerCase()}`;
const productUrlFrom = (handle?: string) => handle ? `https://${PUBLIC_STORE_DOMAIN}/products/${handle}` : '';

const hasBundleTag = (tagsStr?: string) => {
  const tags = String(tagsStr || '').split(',').map(t => t.trim().toLowerCase());
  return tags.some(t => t === 'bundle' || t.startsWith('bundle-'));
};

/* ----------------- Shopify Admin (REST) with basic rate limit ----------------- */
let lastApiCall = 0;
const MIN_DELAY_MS = 600; // ~1.67 rps (Admin limit-friendly)
async function rateLimitedDelay() {
  const now = Date.now();
  const dt = now - lastApiCall;
  if (dt < MIN_DELAY_MS) await new Promise(r => setTimeout(r, MIN_DELAY_MS - dt));
  lastApiCall = Date.now();
}
async function fetchFromShopify(endpoint: string, method: string = 'GET', body: any = null) {
  await rateLimitedDelay();
  const headers: Record<string,string> = {
    'X-Shopify-Access-Token': ADMIN_API_TOKEN!,
    'Content-Type': 'application/json',
  };
  const opts: RequestInit = { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) };
  const url = endpoint.startsWith('http')
    ? endpoint
    : `https://${SHOPIFY_STORE}/admin/api/2024-04/${endpoint.replace(/^\//, '')}`;

  const res = await fetch(url, opts);
  if (!res.ok) {
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, 2000));
      lastApiCall = Date.now();
      const retry = await fetch(url, opts);
      if (!retry.ok) throw new Error(`Shopify API error after retry: ${retry.status} ${retry.statusText} - ${await retry.text()}`);
      return retry.json();
    }
    throw new Error(`Shopify API error: ${res.status} ${res.statusText} - ${await res.text()}`);
  }
  return res.json();
}

/* ----------------- Fetch products in pages (since_id) ----------------- */
async function getProductsPage({ sinceId = 0, limit = 50 } = {}) {
  const items: Array<{id:number,title:string,tags:string,handle:string}> = [];
  let cursor = sinceId;
  let lastBatchCount = 0;

  while (items.length < limit) {
    const res = await fetchFromShopify(`products.json?fields=id,title,tags,handle&limit=250&since_id=${cursor}`);
    const batch = res?.products || [];
    lastBatchCount = batch.length;
    if (!batch.length) break;

    for (const p of batch) {
      cursor = p.id;
      items.push(p);
      if (items.length >= limit) break;
    }
    if (batch.length < 250) break;
  }

  const hasMore = (items.length >= limit) || (lastBatchCount === 250);
  return { items, nextSinceId: cursor, hasMore };
}

/* ----------------- Metafields ----------------- */
async function getProductMetafields(productId: number) {
  const res = await fetchFromShopify(`products/${productId}/metafields.json`);
  return res?.metafields || [];
}
async function upsertProductMetafield(productId: number, { namespace, key, type, value }:
  { namespace: string, key: string, type: string, value: string }) {
  const list = await getProductMetafields(productId);
  const existing = list.find((m: any) => m.namespace === namespace && m.key === key);
  const body = existing
    ? { metafield: { id: existing.id, value, type: existing.type || type } }
    : { metafield: { namespace, key, type, value } };
  const path = existing ? `metafields/${existing.id}.json` : `products/${productId}/metafields.json`;
  return fetchFromShopify(path, existing ? 'PUT' : 'POST', body);
}

/* ----------------- Inventory helpers (multi-location safe) ----------------- */
const productCache = new Map<number, any>();
const variantCache = new Map<number, any>();
const itemLevelsCache = new Map<number, number>(); // inventory_item_id -> total available

async function getProductWithVariants(productId: number) {
  if (productCache.has(productId)) return productCache.get(productId);
  const res = await fetchFromShopify(`products/${productId}.json?fields=id,variants`);
  const p = res?.product || { id: productId, variants: [] };
  productCache.set(productId, p);
  return p;
}

async function getVariant(variantId: number) {
  if (variantCache.has(variantId)) return variantCache.get(variantId);
  const res = await fetchFromShopify(`variants/${variantId}.json`);
  const v = res?.variant;
  variantCache.set(variantId, v);
  return v;
}

async function sumInventoryForItem(inventory_item_id: number, fallbackQty: number) {
  if (itemLevelsCache.has(inventory_item_id)) return itemLevelsCache.get(inventory_item_id)!;
  const levelsRes = await fetchFromShopify(`inventory_levels.json?inventory_item_ids=${inventory_item_id}&limit=250`);
  const levels = Array.isArray(levelsRes?.inventory_levels) ? levelsRes.inventory_levels : [];
  const total = levels.reduce((acc: number, lvl: any) => acc + Number(lvl.available ?? 0), 0);
  const val = Number.isFinite(total) ? total : Number(fallbackQty ?? 0);
  itemLevelsCache.set(inventory_item_id, val);
  return val;
}

async function getVariantSellable(variantId: number) {
  const v = await getVariant(variantId);
  if (!v) return 0;
  if (!v.inventory_management || String(v.inventory_management).toLowerCase() !== 'shopify') {
    return 0; // treat untracked as 0 (change to Infinity if you consider untracked unlimited)
  }
  const invItem = v.inventory_item_id;
  if (!invItem) return Number(v.inventory_quantity ?? 0);
  return sumInventoryForItem(invItem, Number(v.inventory_quantity ?? 0));
}

async function getProductSellableTotal(productId: number) {
  const prod = await getProductWithVariants(productId);
  let sum = 0;
  for (const v of (prod.variants || [])) {
    sum += await getVariantSellable(v.id);
  }
  return sum;
}

/* ----------------- Component resolution for bundles ----------------- */
const variantBySkuCache = new Map<string, number>();
async function resolveVariantIdFromComponent(c: any): Promise<number | null> {
  if (!c || typeof c !== 'object') return null;
  if (c.variant_id) return Number(c.variant_id);

  if (c.product_id) {
    const prod = await getProductWithVariants(Number(c.product_id));
    const vars = Array.isArray(prod.variants) ? prod.variants : [];
    if (vars.length === 1) return vars[0].id; // single-variant product
    return null; // multi-variant without selector
  }

  const sku = (c.sku || c.variant_sku || '').trim();
  if (sku) {
    const key = sku.toLowerCase();
    if (variantBySkuCache.has(key)) return variantBySkuCache.get(key)!;
    // search any cached product variants
    for (const p of productCache.values()) {
      const match = (p.variants || []).find((v: any) => String(v.sku || '').toLowerCase() === key);
      if (match) {
        variantBySkuCache.set(key, match.id);
        return match.id;
      }
    }
  }
  return null;
}

async function getInventoryForComponent(c: any) {
  const vid = await resolveVariantIdFromComponent(c);
  if (vid) return { qty: await getVariantSellable(vid), resolved: 'variant', variantId: vid };
  if (c?.product_id) {
    const prod = await getProductWithVariants(Number(c.product_id));
    let sum = 0;
    for (const v of (prod.variants || [])) sum += await getVariantSellable(v.id);
    return { qty: sum, resolved: 'product', productId: Number(c.product_id) };
  }
  return { qty: null, resolved: 'unresolved' };
}

/* ----------------- Bundle status tag updates ----------------- */
async function updateProductTags(productId: number, currentTags: string | string[], status: 'ok'|'understocked'|'out-of-stock') {
  const base = (Array.isArray(currentTags) ? currentTags : String(currentTags || '').split(','))
    .map(t => t.trim()).filter(Boolean);
  const withoutStatuses = base.filter(tag => !/^bundle-(ok|understocked|out-of-stock)$/i.test(tag));
  const keepers = new Set(withoutStatuses);
  keepers.add(`bundle-${status}`);
  const next = [...keepers];
  await fetchFromShopify(`products/${productId}.json`, 'PUT', { product: { id: productId, tags: next.join(', ') } });
}

/* ----------------- Subscribers (product-level; works for bundles too) ----------------- */
async function getSubscribers(product: {id:number, handle:string}) {
  const keys = [`subscribers:${product.id}`, `subscribers_handle:${product.handle}`];
  const lists = await Promise.all(keys.map(async (k) => {
    const v = await redis.get(k);
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return []; } }
    return [];
  }));
  const map = new Map<string, any>();
  const keyFor = (s: any) => toE164(s?.phone || '') || emailKey(s?.email);
  const ts = (s: any) => Date.parse(s?.last_rearmed_at || s?.subscribed_at || 0);
  for (const list of lists) for (const s of list) {
    const k = keyFor(s); if (!k) continue;
    const prev = map.get(k);
    if (!prev || ts(s) >= ts(prev)) map.set(k, s);
  }
  return { merged: Array.from(map.values()), keysTried: keys };
}
async function setSubscribers(product: {id:number, handle:string}, subs: any[]) {
  await Promise.all([
    redis.set(`subscribers:${product.id}`, subs, { ex: 90 * 24 * 60 * 60 }),
    redis.set(`subscribers_handle:${product.handle}`, subs, { ex: 90 * 24 * 60 * 60 }),
  ]);
}

/* ----------------- Klaviyo (optional) ----------------- */
const haveKlaviyo = !!(KLAVIYO_API_KEY && ALERT_LIST_ID);
async function subscribeProfilesToList({ listId, email, phoneE164, sms }:{
  listId: string, email: string, phoneE164?: string|null, sms?: boolean
}) {
  if (!haveKlaviyo) return { ok: false, skipped: true };
  const subscriptions: any = { email: { marketing: { consent: 'SUBSCRIBED' } } };
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
    headers: { Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`, accept: 'application/json', 'content-type': 'application/json', revision: '2023-10-15' },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Klaviyo subscribe failed: ${res.status} ${res.statusText} :: ${body}`);
  return { ok: true };
}
async function updateProfileProperties({ email, properties }:{ email:string, properties:any }) {
  if (!haveKlaviyo) return { ok: false, skipped: true };
  const filter = `equals(email,"${String(email).replace(/"/g, '\\"')}")`;
  const listRes = await fetch(`https://a.klaviyo.com/api/profiles/?filter=${encodeURIComponent(filter)}&page[size]=1`,
    { method: 'GET', headers: { Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`, accept: 'application/json', revision: '2023-10-15' }});
  if (!listRes.ok) throw new Error(`Profiles lookup failed: ${listRes.status} ${listRes.statusText} :: ${await listRes.text()}`);
  const listJson = await listRes.json();
  const id = listJson?.data?.[0]?.id;
  if (!id) return { ok: false, skipped: true };
  const patchRes = await fetch(`https://a.klaviyo.com/api/profiles/${id}/`, {
    method: 'PATCH',
    headers: { Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`, accept: 'application/json', 'content-type': 'application/json', revision: '2023-10-15' },
    body: JSON.stringify({ data: { type: 'profile', id, attributes: { properties } } }),
  });
  const txt = await patchRes.text();
  if (!patchRes.ok) throw new Error(`Profile PATCH failed: ${patchRes.status} ${patchRes.statusText} :: ${txt}`);
  return { ok: true };
}
async function trackKlaviyoEvent({ metricName, email, phoneE164, properties }:{
  metricName: string, email: string, phoneE164?: string|null, properties?: any
}) {
  if (!haveKlaviyo) return { ok: false, skipped: true };
  const body = {
    data: { type: 'event',
      attributes: {
        time: new Date().toISOString(),
        properties: properties || {},
        metric:  { data: { type: 'metric', attributes: { name: metricName } } },
        profile: { data: { type: 'profile', attributes: { email, ...(phoneE164 ? { phone_number: phoneE164 } : {}) } } }
      }
    }
  };
  const res = await fetch('https://a.klaviyo.com/api/events/', {
    method: 'POST',
    headers: { Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`, accept: 'application/json', 'content-type': 'application/json', revision: '2023-10-15' },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Klaviyo event failed: ${res.status} ${res.statusText} :: ${txt}`);
  return { ok: true };
}

/* ----------------- Core audit (every product) ----------------- */
async function auditProducts({ pageSize = DEFAULT_PAGE_SIZE, sinceId = 0 } = {}) {
  assertEnv();

  console.log('🔍 Starting product audit…');
  const started = Date.now();

  const { items: products, nextSinceId, hasMore } = await getProductsPage({ sinceId, limit: pageSize });
  console.log(`🧾 Page: ${products.length} products (since_id=${sinceId}, pageSize=${pageSize})`);

  let processed = 0;
  let notifiedEmails = 0;
  let notifiedSms = 0;
  let notifErrors = 0;
  let apiCalls = 1;

  for (const p of products) {
    if (Date.now() - started > TIME_BUDGET_MS) { console.log('⏳ Time budget hit, pausing.'); break; }

    try {
      processed++;
      const isBundle = hasBundleTag(p.tags);

      // 1) Compute sellable inventory total (for notifications)
      const sellable = await getProductSellableTotal(p.id);
      apiCalls++;

      // Compare with previous snapshot for any product
      const prevSnap = Number(await redis.get(invKey(p.id))) || 0;
      await redis.set(invKey(p.id), sellable, { ex: 7 * 24 * 60 * 60 });
      const cameBackInStock = prevSnap <= 0 && sellable > 0;

      // 2) Bundle-only: compute components status and update tag
      if (isBundle) {
        let componentsStatus: 'ok'|'understocked'|'out-of-stock' = 'ok';
        const metas = await getProductMetafields(p.id);
        apiCalls++;
        const structure = metas.find((m: any) => m.namespace === 'custom' && m.key === 'bundle_structure');

        if (structure?.value) {
          let components: any[] = [];
          try { components = JSON.parse(structure.value); } catch { components = []; }

          const under: any[] = [], out: any[] = [], unresolved: any[] = [];
          for (const c of components) {
            const required = Math.max(1, Number(c.required_quantity || 1));
            const { qty } = await getInventoryForComponent(c);
            apiCalls++;
            if (qty == null) { unresolved.push(c); continue; }
            if (qty <= 0) out.push(c);
            else if (qty < required) under.push(c);
          }
          if (out.length) componentsStatus = 'out-of-stock';
          else if (under.length || unresolved.length) componentsStatus = 'understocked';
        }

        await upsertProductMetafield(p.id, { namespace: 'custom', key: 'bundle_status_final', type: 'single_line_text_field', value: componentsStatus });
        await upsertProductMetafield(p.id, { namespace: 'custom', key: 'bundle_status_source', type: 'single_line_text_field', value: 'components' });
        await updateProductTags(p.id, p.tags.split(','), componentsStatus);
        console.log(`📦 ${p.title} (bundle) → tag= bundle-${componentsStatus}`);
      } else {
        // Not a bundle – ensure no bundle status is accidentally added here (we leave existing non-bundle tags untouched).
        console.log(`🧮 ${p.title} (single) sellable=${sellable}`);
      }

      // 3) Back-in-stock notifications for ANY product
      const { merged: subs } = await getSubscribers(p);
      const pending = subs.filter((s: any) => !s?.notified);
      const shouldNotify = haveKlaviyo && cameBackInStock && pending.length > 0;

      if (shouldNotify) {
        const productUrl = productUrlFrom(p.handle);
        console.log(`🔔 ${p.title} back in stock — notifying ${pending.length} sub(s)`);

        let count = 0;
        for (const sub of pending) {
          try {
            const phoneE164 = toE164(sub.phone || '');
            const smsConsent = !!sub.sms_consent && !!phoneE164;

            await subscribeProfilesToList({ listId: ALERT_LIST_ID, email: sub.email, phoneE164, sms: smsConsent });

            const stampedTitle  = sub.product_title  || p.title || 'Unknown Product';
            const stampedHandle = sub.product_handle || p.handle || '';
            const stampedUrl    = sub.product_url    || productUrlFrom(stampedHandle) || productUrl;
            const related_section_url = stampedUrl ? `${stampedUrl}#after-bis` : '';

            try {
              await updateProfileProperties({
                email: sub.email,
                properties: {
                  last_back_in_stock_product_name: stampedTitle,
                  last_back_in_stock_product_url: stampedUrl,
                  last_back_in_stock_related_section_url: related_section_url,
                  last_back_in_stock_product_handle: stampedHandle,
                  last_back_in_stock_product_id: String(p.id),
                  last_back_in_stock_notified_at: new Date().toISOString(),
                },
              });
            } catch {}

            await trackKlaviyoEvent({
              metricName: 'Back in Stock',
              email: sub.email,
              phoneE164,
              properties: {
                product_id: String(p.id),
                product_title: stampedTitle,
                product_handle: stampedHandle,
                product_url: stampedUrl,
                related_section_url,
                sms_consent: !!smsConsent,
                source: 'product audit',
              }
            });

            sub.notified = true;
            notifiedEmails++;
            if (smsConsent) notifiedSms++;
            if (++count % 5 === 0) await new Promise(r => setTimeout(r, 250));
          } catch (e:any) {
            notifErrors++;
            console.warn(`❌ Notify failed for ${sub?.email || '(unknown)'}:`, e.message);
          }
        }
        await setSubscribers(p, subs);
      }

      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`⏱️ ${processed}/${products.length} · calls≈${apiCalls} · ${elapsed}s`);
    } catch (err:any) {
      console.error(`❌ Error on product "${p.title}":`, err.message);
      // For bundles, try to fail-safe tag to understocked; non-bundles ignored.
      try { if (hasBundleTag(p.tags)) await updateProductTags(p.id, p.tags.split(','), 'understocked'); } catch {}
    }
  }

  const total = (Date.now() - started) / 1000;
  const partial = (Date.now() - started > TIME_BUDGET_MS) || hasMore || (processed < products.length);

  console.log(`\n✅ Page done: processed=${processed} emails=${notifiedEmails} sms=${notifiedSms} errors=${notifErrors} time=${Math.round(total)}s`);

  return {
    processed,
    notifiedEmails,
    notifiedSms,
    notifErrors,
    totalTimeSeconds: total,
    timestamp: new Date().toISOString(),
    partial,
    nextSinceId: partial ? nextSinceId : 0,
  };
}

/* ----------------- GET handler (paged; advances cursor) ----------------- */
export async function GET(req: Request) {
  const authed = await ensureCronAuth(req);
  if (!authed) return unauthorized();

  const locked = await acquireLock();
  if (!locked) {
    return NextResponse.json({ success: false, error: 'audit already running' }, { status: 423 });
  }

  try {
    const url = new URL(req.url);
    const reset    = url.searchParams.get('reset') === '1';
    const pageSize = Number(url.searchParams.get('limit') || DEFAULT_PAGE_SIZE);

    const sinceId = reset ? 0 : Number((await redis.get(CURSOR_KEY)) || 0);
    const results = await auditProducts({ pageSize, sinceId });

    if (results.partial && results.nextSinceId) {
      await redis.set(CURSOR_KEY, results.nextSinceId, { ex: 24 * 60 * 60 });
    } else {
      await redis.del(CURSOR_KEY);
    }

    return NextResponse.json({
      success: true,
      message: results.partial
        ? `Auditing in batches (limit=${pageSize}). Next since_id=${results.nextSinceId}.`
        : 'Audit complete for all products.',
      ...results,
    });
  } catch (error:any) {
    return NextResponse.json(
      { success: false, error: error.message, stack: process.env.NODE_ENV === 'development' ? error.stack : undefined },
      { status: 500 }
    );
  } finally {
    await releaseLock();
  }
}

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

const SHOPIFY_STORE         = process.env.SHOPIFY_STORE; // e.g. "yourstore.myshopify.com"
const ADMIN_API_TOKEN       = process.env.SHOPIFY_ADMIN_API_KEY;

const KLAVIYO_API_KEY       = process.env.KLAVIYO_API_KEY || '';
const ALERT_LIST_ID         = process.env.KLAVIYO_BACK_IN_STOCK_ALERT_LIST_ID || '';

const PUBLIC_STORE_DOMAIN   = process.env.PUBLIC_STORE_DOMAIN || 'example.com';
const CRON_SECRET           = process.env.CRON_SECRET || ''; // authorize Vercel Cron

// Storefront for snapshot diagnostics (doesn't drive tags)
const STOREFRONT_API_TOKEN   = process.env.SHOPIFY_STOREFRONT_API_TOKEN || '';
const STOREFRONT_API_VERSION = process.env.SHOPIFY_STOREFRONT_API_VERSION || '2024-07';

// Optional “low stock” threshold (diagnostics only)
const LOW_STOCK_THRESHOLD    = Number(process.env.BUNDLE_LOW_STOCK_THRESHOLD || 0);

/** Paging/time-budget to avoid 504s */
const DEFAULT_PAGE_SIZE = Number(process.env.AUDIT_PAGE_SIZE || 20);
const TIME_BUDGET_MS    = Number(process.env.TIME_BUDGET_MS || 55_000);
const CURSOR_KEY        = 'cursor:audit-bundles:since_id';

/** Only require what we need for tagging; Klaviyo optional */
function assertEnvForTagging() {
  const missing = [];
  if (!SHOPIFY_STORE)   missing.push('SHOPIFY_STORE');
  if (!ADMIN_API_TOKEN) missing.push('SHOPIFY_ADMIN_API_KEY');
  if (!STOREFRONT_API_TOKEN) missing.push('SHOPIFY_STOREFRONT_API_TOKEN');
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
const LOCK_KEY = 'locks:audit-bundles';
const LOCK_TTL_SECONDS = 15 * 60;
async function acquireLock() {
  try { return !!(await redis.set(LOCK_KEY, Date.now(), { nx: true, ex: LOCK_TTL_SECONDS })); }
  catch { return false; }
}
async function releaseLock() { try { await redis.del(LOCK_KEY); } catch {} }

/* ----------------- utils ----------------- */
function toE164(raw: any) {
  if (!raw) return null;
  let v = String(raw).trim().replace(/[^\d+]/g, '');
  if (v.startsWith('+')) return /^\+\d{8,15}$/.test(v) ? v : null;
  if (/^0\d{10}$/.test(v)) return '+234' + v.slice(1);
  if (/^(70|80|81|90|91)\d{8}$/.test(v)) return '+234' + v;
  if (/^\d{10}$/.test(v)) return '+1' + v;
  return null;
}
const emailKey = (e: any) => `email:${String(e || '').toLowerCase()}`;
const productUrlFrom = (handle?: string) => handle ? `https://${PUBLIC_STORE_DOMAIN}/products/${handle}` : '';
function extractStatusFromTags(tagsStr: string) {
  const tags = String(tagsStr || '').split(',').map(t => t.trim().toLowerCase());
  if (tags.includes('bundle-out-of-stock')) return 'out-of-stock';
  if (tags.includes('bundle-understocked')) return 'understocked';
  if (tags.includes('bundle-ok')) return 'ok';
  return null;
}
const RANK: Record<string, number> = { 'ok': 0, 'understocked': 1, 'out-of-stock': 2 };
const worstStatus = (...s: string[]) => s.reduce((w, x) => (RANK[x] >= RANK[w] ? x : w), 'ok');

/* ----------------- Klaviyo helpers (optional) ----------------- */
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

async function updateProfileProperties({ email, properties }:{ email: string, properties: any }) {
  if (!haveKlaviyo) return { ok: false, skipped: true };
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

async function trackKlaviyoEvent({ metricName, email, phoneE164, properties }:{
  metricName: string, email?: string, phoneE164?: string|null, properties?: any
}) {
  if (!haveKlaviyo) return { ok: false, skipped: true };
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
async function fetchFromShopify(endpoint: string, method: string = 'GET', body: any = null) {
  if (!endpoint || typeof endpoint !== 'string') throw new Error(`Invalid endpoint: "${endpoint}"`);
  await rateLimitedDelay();

  const headers: any = { 'X-Shopify-Access-Token': ADMIN_API_TOKEN, 'Content-Type': 'application/json' };
  const opts: any = { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) };
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
async function fetchStorefrontGraphQL(query: string, variables: any = {}) {
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
const hasBundleTag = (tagsStr: string) => {
  const tags = String(tagsStr || '').split(',').map(t => t.trim().toLowerCase());
  return tags.some(t => t === 'bundle' || t.startsWith('bundle-'));
};

/** Page through products and return one page of bundle products */
async function getProductsTaggedBundlePage({ sinceId = 0, limit = 50 }:{ sinceId?: number, limit?: number }) {
  const items: any[] = [];
  let cursor = sinceId;
  let lastBatchCount = 0;

  while (items.length < limit) {
    const res = await fetchFromShopify(
      `products.json?fields=id,title,tags,handle&limit=250&since_id=${cursor}`
    );
    const batch = res?.products || [];
    lastBatchCount = batch.length;
    if (!batch.length) break;

    for (const p of batch) {
      cursor = p.id;
      if (hasBundleTag(p.tags)) items.push(p);
      if (items.length >= limit) break;
    }

    if (batch.length < 250) break; // reached end
  }

  const hasMore = (items.length >= limit) || (lastBatchCount === 250);
  return { items, nextSinceId: cursor, hasMore };
}

async function getProductMetafields(productId: number) {
  const res = await fetchFromShopify(`products/${productId}/metafields.json`);
  return res?.metafields || [];
}

/** Find a “bundle structure” metafield (flexible namespaces/keys) and parse it safely */
async function getBundleComponents(productId: number) {
  const metas = await getProductMetafields(productId);
  const candidates = metas.filter((m: any) => {
    const k = String(m?.key || '').toLowerCase();
    return ['bundle_structure','components','bundle_components','bom','bundleitems','bundle_items'].includes(k);
  });

  for (const m of candidates) {
    const raw = m?.value;
    if (!raw) continue;
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed)) {
        return parsed.map((c: any) => ({
          variant_id: c?.variant_id ?? c?.variantId ?? null,
          product_id: c?.product_id ?? c?.productId ?? null,
          sku:        c?.sku ?? c?.variant_sku ?? null,
          required_quantity: Math.max(1, Number(c?.required_quantity ?? c?.qty ?? 1) || 1),
        }));
      }
    } catch {
      // try next candidate
    }
  }
  return null; // not found or unparseable
}

async function getSpecificProductMetafield(productId: number, namespace: string, key: string) {
  const list = await getProductMetafields(productId);
  return list.find((m: any) => m.namespace === namespace && m.key === key) || null;
}
async function upsertProductMetafield(productId: number, { namespace, key, type, value }:{ namespace: string, key: string, type: string, value: string }) {
  const existing = await getSpecificProductMetafield(productId, namespace, key);
  const body = existing
    ? { metafield: { id: existing.id, value, type: existing.type || type } }
    : { metafield: { namespace, key, type, value } };
  const path = existing
    ? `metafields/${existing.id}.json`
    : `products/${productId}/metafields.json`;
  return fetchFromShopify(path, existing ? 'PUT' : 'POST', body);
}

/* --- Components & inventory helpers --- */
async function getVariant(id: number) {
  const res = await fetchFromShopify(`variants/${id}.json`);
  return res.variant;
}

/** Multi-location safe: sum InventoryLevels.available for the variant’s inventory_item_id.
 *  If inventory isn’t tracked (inventory_management != 'shopify'), we conservatively treat as 0. */
async function getInventoryLevel(variantId: number) {
  if (!variantId) return 0;

  const v = await getVariant(variantId);
  if (!v) return 0;

  if (!v.inventory_management || String(v.inventory_management).toLowerCase() !== 'shopify') {
    return 0; // treat untracked as 0; change to Infinity if you want “untracked = unlimited”
  }

  const inventoryItemId = v.inventory_item_id;
  if (!inventoryItemId) {
    return Number(v.inventory_quantity ?? 0);
  }

  const levelsRes = await fetchFromShopify(`inventory_levels.json?inventory_item_ids=${inventoryItemId}&limit=250`);
  const levels = Array.isArray(levelsRes?.inventory_levels) ? levelsRes.inventory_levels : [];
  const total = levels.reduce((acc: number, lvl: any) => acc + Number(lvl.available ?? 0), 0);

  if (!Number.isFinite(total)) return Number(v.inventory_quantity ?? 0);
  return total;
}

/* Cache to avoid redundant product pulls */
const productCache = new Map<number, any>();
const variantBySkuCache = new Map<string, number>();

async function getProductWithVariants(productId: number) {
  if (productCache.has(productId)) return productCache.get(productId);
  const res = await fetchFromShopify(`products/${productId}.json?fields=id,variants`);
  const p = res?.product || { id: productId, variants: [] };
  productCache.set(productId, p);
  return p;
}

/** Resolve a variant id from component descriptor:
 *  - { variant_id }
 *  - { product_id }       // if single-variant product
 *  - { sku } or { variant_sku } */
async function resolveVariantIdFromComponent(c: any) {
  if (!c || typeof c !== 'object') return null;

  if (c.variant_id) return Number(c.variant_id);

  if (c.product_id) {
    const prod = await getProductWithVariants(Number(c.product_id));
    const vars = Array.isArray(prod.variants) ? prod.variants : [];
    if (vars.length === 1) return vars[0].id;
    console.warn(`Component product ${c.product_id} is multi-variant with no variant_id/sku`);
    return null;
  }

  const sku = (c.sku || c.variant_sku || '').trim();
  if (sku) {
    const key = sku.toLowerCase();
    if (variantBySkuCache.has(key)) return variantBySkuCache.get(key)!;
    for (const p of productCache.values()) {
      const match = (p.variants || []).find((v: any) => String(v.sku || '').toLowerCase() === key);
      if (match) {
        variantBySkuCache.set(key, match.id);
        return match.id;
      }
    }
    console.warn(`SKU "${sku}" not found in cached products this run`);
    return null;
  }

  return null;
}

async function getInventoryForComponent(c: any) {
  const vid = await resolveVariantIdFromComponent(c);
  if (vid) {
    const qty = await getInventoryLevel(vid);
    return { qty, resolved: 'variant', variantId: vid };
  }

  // Fallback: product-level aggregate if product_id provided but no single variant chosen
  if (c?.product_id) {
    const prod = await getProductWithVariants(Number(c.product_id));
    let sum = 0;
    for (const v of (prod.variants || [])) {
      sum += await getInventoryLevel(v.id);
    }
    return { qty: sum, resolved: 'product', productId: Number(c.product_id) };
  }

  return { qty: null, resolved: 'unresolved' };
}

/* --- Bundle own availability (diagnostics only; tags ignore this) --- */
async function getProductVariantsWithGids(productId: number) {
  const res = await fetchFromShopify(`products/${productId}.json?fields=id,variants`);
  const variants = res?.product?.variants || [];
  return variants.map((v: any) => ({
    id: v.id,
    gid: v.admin_graphql_api_id,
    inventory_quantity: Number(v?.inventory_quantity ?? 0),
  }));
}
async function getQuantityAvailableForVariantGids(gids: string[]) {
  if (!gids.length) return [];
  const q = `query ($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id quantityAvailable } } }`;
  const out = await fetchStorefrontGraphQL(q, { ids: gids });
  const nodes = out?.data?.nodes || [];
  return nodes.filter(Boolean).map((n: any) => ({ gid: n.id, quantityAvailable: Number(n.quantityAvailable ?? 0) }));
}
async function getBundleStorefrontAvailability(productId: number) {
  const variants = await getProductVariantsWithGids(productId);
  const gids = variants.map(v => v.gid).filter(Boolean);
  if (!gids.length) return { minAvailable: 0, byVariant: [], variantsCount: 0 };
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
async function getBundleOwnInventorySummary(productId: number) {
  const variants = await getProductVariantsWithGids(productId);
  const qtys = variants.map(v => Number(v.inventory_quantity || 0));
  const total = qtys.reduce((a, b) => a + b, 0);
  const anyNegative = qtys.some(q => q < 0);
  const allZero = variants.length > 0 && qtys.every(q => q === 0);
  return { total, anyNegative, variantsCount: variants.length, outOfStock: allZero, understocked: anyNegative || total < 0 };
}

/* --- Status from the snapshot integer (diagnostics only) --- */
function statusFromInventoryInteger(n: number) {
  if (!Number.isFinite(n)) return 'ok';
  if (n < 0) return 'understocked';
  if (n === 0) return 'out-of-stock';
  if (LOW_STOCK_THRESHOLD > 0 && n <= LOW_STOCK_THRESHOLD) return 'understocked';
  return 'ok';
}

/* ----------------- Redis helpers ----------------- */
async function getBundleStatus(productId: number) { return (await redis.get(`status:${productId}`)) || null; }
async function setBundleStatus(productId: number, prevStatus: string|null, currStatus: string) {
  await redis.set(`status:${productId}`, { previous: prevStatus, current: currStatus });
}

/** Read & merge subscribers saved under BOTH keys */
async function getSubscribersForBundle(bundle: any) {
  const keys = [`subscribers:${bundle.id}`, `subscribers_handle:${bundle.handle}`];
  const lists = await Promise.all(keys.map(async (k) => {
    const v = await redis.get(k);
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return []; } }
    return [];
  }));
  const map = new Map();
  const keyFor = (s: any) => toE164(s?.phone || '') || emailKey(s?.email);
  const ts = (s: any) => Date.parse(s?.last_rearmed_at || s?.subscribed_at || 0);
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
async function setSubscribersForBundle(bundle: any, subs: any[]) {
  await Promise.all([
    redis.set(`subscribers:${bundle.id}`, subs, { ex: 90 * 24 * 60 * 60 }),
    redis.set(`subscribers_handle:${bundle.handle}`, subs, { ex: 90 * 24 * 60 * 60 }),
  ]);
}

/* ----------------- Tag updates (fresh read) ----------------- */
async function updateProductTags(productId: number, desiredStatus: 'ok'|'understocked'|'out-of-stock') {
  // Always read current tags fresh to avoid staleness
  const res = await fetchFromShopify(`products/${productId}.json?fields=id,tags`);
  const currentTags = res?.product?.tags || '';

  const base = String(currentTags || '')
    .split(',')
    .map((t: string) => t.trim())
    .filter(Boolean);

  const withoutStatuses = base.filter(tag => !/^bundle-(ok|understocked|out-of-stock)$/i.test(tag));
  const keepers = new Set(withoutStatuses);

  const safeStatus = ['ok','understocked','out-of-stock'].includes(desiredStatus) ? desiredStatus : 'ok';
  keepers.add(`bundle-${safeStatus}`);

  const next = [...keepers];
  await fetchFromShopify(`products/${productId}.json`, 'PUT', { product: { id: productId, tags: next.join(', ') } });
}

/* ----------------- main audit (paged + time budget) ----------------- */
async function auditBundles({ pageSize = DEFAULT_PAGE_SIZE, sinceId = 0 }:{ pageSize?: number, sinceId?: number } = {}) {
  assertEnvForTagging();

  console.log('🔍 Starting bundle audit (components-only tagging, multi-location inventory)…');
  const started = Date.now();

  const { items: bundles, nextSinceId, hasMore } =
    await getProductsTaggedBundlePage({ sinceId, limit: pageSize });

  console.log(`📦 Page: found ${bundles.length} bundles (since_id=${sinceId}, pageSize=${pageSize})`);

  let bundlesProcessed = 0;
  let notificationsSent = 0;
  let smsNotificationsSent = 0;
  let notificationErrors = 0;
  let profileUpdates = 0;
  let apiCallsCount = 1;

  for (const bundle of bundles) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      console.log('⏳ Time budget reached, stopping early');
      break;
    }

    try {
      bundlesProcessed++;
      console.log(`\n📦 ${bundlesProcessed}/${bundles.length} — ${bundle.title}`);

      /* 1) COMPONENTS status (bundle_structure) → drives tags */
      let componentsStatus: 'ok'|'understocked'|'out-of-stock' = 'understocked'; // safe default
      const components = await getBundleComponents(bundle.id);

      if (Array.isArray(components) && components.length) {
        const under: any[] = [];
        const out: any[] = [];
        const unresolved: any[] = [];

        for (const c of components) {
          const required = Math.max(1, Number(c.required_quantity || 1));
          const { qty, resolved, variantId, productId } = await getInventoryForComponent(c);
          apiCallsCount++;

          const idLabel =
            c.variant_id ? `variant:${c.variant_id}` :
            c.sku        ? `sku:${c.sku}` :
            c.product_id ? `product:${c.product_id}` :
                           'unknown';
          console.log(`component ${idLabel} → required=${required} qty=${qty === null ? 'unresolved' : qty} resolved=${resolved}${variantId ? ` v=${variantId}` : ''}${productId ? ` p=${productId}` : ''}`);

          if (qty == null) { unresolved.push(c); continue; }
          if (qty <= 0) out.push(c);                // ≤ 0 → out-of-stock
          else if (qty < required) under.push(c);   // 0 < qty < required → understocked
        }

        if (out.length) componentsStatus = 'out-of-stock';
        else if (under.length || unresolved.length) componentsStatus = 'understocked';
        else componentsStatus = 'ok';
      } else {
        console.warn(`No usable bundle structure for product ${bundle.id}; defaulting to understocked.`);
      }

      /* 2) SNAPSHOT diagnostics (does not affect tags) */
      const sf = await getBundleStorefrontAvailability(bundle.id);
      apiCallsCount++;
      const own = await getBundleOwnInventorySummary(bundle.id);
      apiCallsCount++;

      let snapshot = Number.isFinite(sf.minAvailable) ? sf.minAvailable : own.total;
      if (own.total < snapshot) snapshot = own.total;

      await upsertProductMetafield(bundle.id, {
        namespace: 'custom',
        key: 'bundle_inventory_snapshot',
        type: 'number_integer',
        value: String(snapshot || 0),
      });
      const invStatus = statusFromInventoryInteger(snapshot);

      await upsertProductMetafield(bundle.id, {
        namespace: 'custom',
        key: 'bundle_status_components',
        type: 'single_line_text_field',
        value: componentsStatus,
      });
      await upsertProductMetafield(bundle.id, {
        namespace: 'custom',
        key: 'bundle_status_snapshot',
        type: 'single_line_text_field',
        value: invStatus,
      });

      // Final status FOR TAGS = components only
      const finalStatusForTags = componentsStatus;
      await upsertProductMetafield(bundle.id, {
        namespace: 'custom',
        key: 'bundle_status_final',
        type: 'single_line_text_field',
        value: finalStatusForTags,
      });
      await upsertProductMetafield(bundle.id, {
        namespace: 'custom',
        key: 'bundle_status_source',
        type: 'single_line_text_field',
        value: 'components-only',
      });

      // previous vs current (redis; fallback to tags)
      const prevObj = await getBundleStatus(bundle.id);
      const prevStatus = prevObj?.current ?? extractStatusFromTags((bundle.tags || ''));
      await setBundleStatus(bundle.id, prevStatus || null, finalStatusForTags);

      console.log(
        `📊 ${bundle.title} ⇒ components=${componentsStatus} | snapshot=${snapshot} (${invStatus}) ⇒ FINAL_TAG=${finalStatusForTags}`
      );

      /* Waitlist (optional Klaviyo) */
      const { merged: uniqueSubs, keysTried } = await getSubscribersForBundle(bundle);
      const pending = uniqueSubs.filter((s: any) => !s?.notified);
      console.log(`🧾 Waitlist: keys=${JSON.stringify(keysTried)} total=${uniqueSubs.length} pending=${pending.length}`);

      const shouldNotify = haveKlaviyo && (finalStatusForTags === 'ok') && pending.length > 0;

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
            } catch (e: any) {
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
          } catch (e: any) {
            notificationErrors++;
            console.error(`❌ Notify failed for ${sub?.email || '(unknown)'}:`, e.message);
          }
        }

        await setSubscribersForBundle(bundle, uniqueSubs);
      } else {
        console.log('ℹ️ No notifications: either FINAL != ok, no pending subs, or Klaviyo not configured.');
      }

      /* Update tags — ALWAYS writes exactly one status tag (fresh read) */
      await updateProductTags(bundle.id, finalStatusForTags);
      apiCallsCount++;

      const elapsed = (Date.now() - started) / 1000;
      console.log(`⏱️ ${bundlesProcessed}/${bundles.length} processed so far · API calls ≈ ${apiCallsCount} · ${elapsed.toFixed(1)}s`);
    } catch (err: any) {
      console.error(`❌ Error on bundle "${bundle.title}":`, err.message);
      try { await updateProductTags(bundle.id, 'understocked'); } catch {}
    }
  }

  const total = (Date.now() - started) / 1000;
  const partial = (Date.now() - started > TIME_BUDGET_MS) || hasMore || (bundlesProcessed < bundles.length);

  console.log('\n✅ Page complete');
  console.log(`📦 Bundles processed this page: ${bundlesProcessed}`);
  console.log(`📧 Email subs: ${notificationsSent}`);
  console.log(`📱 SMS subs: ${smsNotificationsSent}`);
  console.log(`❌ Notify errors: ${notificationErrors}`);
  console.log(`⏱️ ${Math.round(total)}s this page, API calls ${apiCallsCount}`);

  return {
    bundlesProcessed,
    notificationsSent,
    smsNotificationsSent,
    profileUpdates,
    notificationErrors,
    totalTimeSeconds: total,
    apiCallsCount,
    avgApiCallRate: apiCallsCount / Math.max(total, 0.001),
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
    const reset = url.searchParams.get('reset') === '1';
    const pageSize = Number(url.searchParams.get('limit') || DEFAULT_PAGE_SIZE);

    const sinceId = reset ? 0 : Number((await redis.get(CURSOR_KEY)) || 0);

    const results = await auditBundles({ pageSize, sinceId });

    if (results.partial && results.nextSinceId) {
      await redis.set(CURSOR_KEY, results.nextSinceId, { ex: 24 * 60 * 60 });
    } else {
      await redis.del(CURSOR_KEY);
    }

    return NextResponse.json({
      success: true,
      message: results.partial
        ? `Audit running in batches (limit=${pageSize}). Next since_id=${results.nextSinceId}.`
        : 'Audit complete for all bundles.',
      ...results,
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message, stack: process.env.NODE_ENV === 'development' ? error.stack : undefined },
      { status: 500 }
    );
  } finally {
    await releaseLock();
  }
}

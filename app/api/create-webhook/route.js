// app/api/create-webhook/route.js
// Read-only endpoint: earliest component date for native Shopify bundles
// Uses variant/product metafield custom.restock_date
// CORS enabled so Shopify theme can call from storefront domain.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

import { NextResponse } from 'next/server';

/* ============================ Env ============================ */
const ENV = {
  SHOPIFY_STORE:        process.env.SHOPIFY_STORE,            // yourstore.myshopify.com
  ADMIN_API_TOKEN:      process.env.SHOPIFY_ADMIN_API_KEY,    // Admin API token
  SHOPIFY_API_VERSION:  process.env.SHOPIFY_API_VERSION || '2025-01',
  PUBLIC_PROBE_TOKEN:   process.env.PUBLIC_PROBE_TOKEN || '',  // optional gate
  PUBLIC_STORE_DOMAIN:  process.env.PUBLIC_STORE_DOMAIN || '', // e.g. yourstore.com or yourstore.myshopify.com
};

/* ========================== CORS ============================= */
function corsHeaders(originHeader) {
  // Allow only your storefront origin if provided; else fallback to '*'
  const allowOrigin =
    ENV.PUBLIC_STORE_DOMAIN
      ? `https://${ENV.PUBLIC_STORE_DOMAIN.replace(/^https?:\/\//,'')}`
      : (originHeader || '*');

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}
export async function OPTIONS(req) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get('origin')) });
}

/* ===================== Shopify Admin GQL ===================== */
async function fetchShopifyGQL(query, variables = {}) {
  if (!ENV.SHOPIFY_STORE || !ENV.ADMIN_API_TOKEN) {
    throw new Error('Missing SHOPIFY_STORE or SHOPIFY_ADMIN_API_KEY');
  }
  const url = `https://${ENV.SHOPIFY_STORE}/admin/api/${ENV.SHOPIFY_API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': String(ENV.ADMIN_API_TOKEN),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) {
    throw new Error(`Shopify GraphQL: ${res.status} ${res.statusText} :: ${JSON.stringify(json.errors || json)}`);
  }
  return json.data;
}

/* ========================= Helpers =========================== */
function worstStatus(a, b) { const RANK = { ok:0, understocked:1, 'out-of-stock':2 }; return (RANK[a] >= RANK[b]) ? a : b; }
function pickDateFromVariantNode(pv) {
  const candidates = [ pv?.mf_restock?.value, pv?.product?.pmf_restock?.value ].filter(Boolean);
  if (!candidates.length) return null;
  const toISO = (s) => (s.length === 10 ? `${s}T00:00:00Z` : s);
  const now = Date.now();
  const parsed = candidates.map(toISO).map(iso => ({ iso, ts: Date.parse(iso) })).filter(x => Number.isFinite(x.ts));
  if (!parsed.length) return null;
  const future = parsed.filter(x => x.ts >= now);
  const pool = future.length ? future : parsed;
  pool.sort((a,b) => a.ts - b.ts);
  return pool[0].iso;
}

/* ============ Bundle summarizer (native components) =========== */
async function getBundleSummaryByProductId(productId) {
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
                    mf_restock: metafield(namespace:"custom", key:"restock_date") { value }
                    product {
                      handle
                      pmf_restock: metafield(namespace:"custom", key:"restock_date") { value }
                    }
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
  const data = await fetchShopifyGQL(query, { id: gid, vv: 100, cp: 100 });

  const edges = data?.product?.variants?.edges || [];
  let hasComponents = false;
  let finalStatus = 'ok';
  let totalBuildable = 0;

  let earliestISO_constraining = null, earliestSource_constraining = null;
  let earliestISO_any = null,          earliestSource_any = null;

  for (const e of edges) {
    const comps = e?.node?.productVariantComponents?.nodes || [];
    if (comps.length) hasComponents = true;
    if (!comps.length) continue;

    let anyZeroOrNeg = false;
    let anyInsufficient = false;
    let minBuildable = Number.POSITIVE_INFINITY;

    for (const c of comps) {
      const pv = c?.productVariant; if (!pv) continue;
      const have = Math.max(0, Number(pv.sellableOnlineQuantity ?? 0));
      const need = Math.max(1, Number(c?.quantity ?? 1));
      const policy = String(pv.inventoryPolicy || '').toUpperCase();
      const isOOS = (pv.availableForSale === false) || (have <= 0 && (policy === 'DENY' || policy === 'CONTINUE'));
      const isConstraining = isOOS || (have < need);

      if (have <= 0) anyZeroOrNeg = true; else if (have < need) anyInsufficient = true;
      minBuildable = Math.min(minBuildable, Math.floor(have / need));

      const iso = pickDateFromVariantNode(pv);
      if (iso) {
        if (isConstraining) {
          if (!earliestISO_constraining || new Date(iso) < new Date(earliestISO_constraining)) {
            earliestISO_constraining = iso;
            earliestSource_constraining = { handle: pv.product?.handle, variantGid: pv.id, date: iso };
          }
        }
        if (!earliestISO_any || new Date(iso) < new Date(earliestISO_any)) {
          earliestISO_any = iso;
          earliestSource_any = { handle: pv.product?.handle, variantGid: pv.id, date: iso };
        }
      }
    }

    const buildable = Number.isFinite(minBuildable) ? Math.max(0, minBuildable) : 0;
    totalBuildable += buildable;
    const status = anyZeroOrNeg ? 'out-of-stock' : (anyInsufficient ? 'understocked' : 'ok');
    finalStatus = worstStatus(finalStatus, status);
  }

  const chosenISO = earliestISO_constraining || earliestISO_any;
  const chosenSource = earliestSource_constraining || earliestSource_any;

  return { ok:true, hasComponents, finalStatus, totalBuildable, earliestISO: chosenISO, earliestSource: chosenSource };
}

/* ============================ GET ============================ */
export async function GET(req) {
  const headers = corsHeaders(req.headers.get('origin'));
  try {
    const url = new URL(req.url);
    const handle = (url.searchParams.get('handle') || '').trim();
    const idParam = (url.searchParams.get('id') || '').trim();
    const token  = (url.searchParams.get('token') || '').trim();

    if (ENV.PUBLIC_PROBE_TOKEN && token !== ENV.PUBLIC_PROBE_TOKEN) {
      return NextResponse.json({ error:'unauthorized' }, { status:401, headers });
    }
    let productId = null;
    if (idParam) {
      const n = Number(idParam);
      if (!Number.isFinite(n) || n <= 0) {
        return NextResponse.json({ error:'bad id', usage:'/api/create-webhook?id=12345' }, { status:400, headers });
      }
      productId = n;
    } else if (handle) {
      const lookup = await fetchShopifyGQL(
        `query($h:String!){ productByHandle(handle:$h){ id handle } }`,
        { h: handle }
      );
      const gid = lookup?.productByHandle?.id;
      if (!gid) return NextResponse.json({ error:'not_found' }, { status:404, headers });
      productId = Number(String(gid).split('/').pop());
    } else {
      return NextResponse.json({
        error:'missing handle or id',
        usage:[
          '/api/create-webhook?handle=<PRODUCT_HANDLE>[&token=...]',
          '/api/create-webhook?id=<PRODUCT_ID>[&token=...]'
        ]
      }, { status:400, headers });
    }

    const summary = await getBundleSummaryByProductId(productId);
    const earliestPretty = summary.earliestISO ? new Date(summary.earliestISO).toISOString().slice(0,10) : null;

    return NextResponse.json({
      handle: handle || null,
      productId,
      hasComponents: !!summary.hasComponents,
      finalStatus: summary.finalStatus,
      earliestISO: summary.earliestISO,
      earliestPretty,
      source: summary.earliestSource || null
    }, { headers });
  } catch (e) {
    return NextResponse.json({ error: e?.message || String(e) }, { status:500, headers });
  }
}

// If this file previously handled POST for webhook creation, keep your existing:
// export async function POST(req) { ... }

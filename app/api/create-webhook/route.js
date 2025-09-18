// app/api/create-webhook/route.js
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

import { NextResponse } from 'next/server';

const ENV = {
  SHOPIFY_STORE:        process.env.SHOPIFY_STORE || '',
  ADMIN_API_TOKEN:      process.env.SHOPIFY_ADMIN_API_KEY || '',
  SHOPIFY_API_VERSION:  process.env.SHOPIFY_API_VERSION || '2025-07', // pick a known-good
  PUBLIC_PROBE_TOKEN:   process.env.PUBLIC_PROBE_TOKEN || '',
  PUBLIC_STORE_DOMAIN:  process.env.PUBLIC_STORE_DOMAIN || '', // your storefront host for CORS
};

/* ------------------------------- CORS ------------------------------- */
function corsHeaders(originHeader) {
  const allowOrigin = ENV.PUBLIC_STORE_DOMAIN
    ? `https://${ENV.PUBLIC_STORE_DOMAIN.replace(/^https?:\/\//,'')}`
    : (originHeader || '*');
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
  };
}
export async function OPTIONS(req) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get('origin')) });
}

/* --------------------- Store domain normalization -------------------- */
function normalizeMyShopifyDomain(v) {
  if (!v) return '';
  let s = String(v).trim();
  s = s.replace(/^https?:\/\//, ''); // drop protocol
  s = s.replace(/\/.*$/, '');        // drop any path
  return s;
}
function adminGraphqlUrl() {
  const host = normalizeMyShopifyDomain(ENV.SHOPIFY_STORE);
  return `https://${host}/admin/api/${ENV.SHOPIFY_API_VERSION}/graphql.json`;
}

/* ------------------------- Shopify Admin GQL ------------------------ */
async function fetchShopifyGQLRetry(query, variables = {}, maxAttempts = 3) {
  const url = adminGraphqlUrl();
  if (!ENV.ADMIN_API_TOKEN) throw new Error('Missing SHOPIFY_ADMIN_API_KEY');
  let attempt = 0;
  while (true) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': String(ENV.ADMIN_API_TOKEN),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
    let json = {};
    try { json = await res.json(); } catch {}
    const ok = res.ok && !json.errors;
    if (ok) return json.data;

    if (res.status === 429 && attempt < maxAttempts - 1) {
      const ra = Number(res.headers.get('retry-after') || 0);
      const wait = ra ? ra * 1000 : Math.floor(1200 * Math.pow(1.8, attempt) + Math.random() * 200);
      await new Promise(r => setTimeout(r, wait));
      attempt++;
      continue;
    }
    throw new Error(`Shopify GraphQL: ${res.status} ${res.statusText} :: ${JSON.stringify(json.errors || json)}`);
  }
}

/* ----------------------------- Helpers ------------------------------ */
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

/* --------- GraphQL queries: by HANDLE (1 call) or by ID (1 call) ---- */
const Q_BY_HANDLE = `
  query ProductBundlesByHandle($handle:String!, $vv:Int!, $cp:Int!) {
    productByHandle(handle:$handle) {
      id
      handle
      variants(first:$vv) {
        edges {
          node {
            id
            productVariantComponents(first:$cp) {
              nodes {
                quantity
                productVariant {
                  id
                  availableForSale
                  inventoryPolicy
                  sellableOnlineQuantity
                  mf_restock: metafield(namespace:"custom", key:"restock_date") { value }
                  product { handle pmf_restock: metafield(namespace:"custom", key:"restock_date") { value } }
                }
              }
            }
          }
        }
      }
    }
  }
`;
const Q_BY_ID = `
  query ProductBundlesById($id:ID!, $vv:Int!, $cp:Int!) {
    product(id:$id) {
      id
      handle
      variants(first:$vv) {
        edges {
          node {
            id
            productVariantComponents(first:$cp) {
              nodes {
                quantity
                productVariant {
                  id
                  availableForSale
                  inventoryPolicy
                  sellableOnlineQuantity
                  mf_restock: metafield(namespace:"custom", key:"restock_date") { value }
                  product { handle pmf_restock: metafield(namespace:"custom", key:"restock_date") { value } }
                }
              }
            }
          }
        }
      }
    }
  }
`;

/* -------------------- Summarizer (native bundles) ------------------- */
function summarize(prod) {
  const edges = prod?.variants?.edges || [];
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
      const isOOS = (pv.availableForSale === false) || (have <= 0 && (policy === 'DENY' || 'CONTINUE'));
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

async function getBundleSummaryByHandle(handle) {
  const data = await fetchShopifyGQLRetry(Q_BY_HANDLE, { handle, vv:100, cp:100 });
  return summarize(data?.productByHandle);
}
async function getBundleSummaryById(productId) {
  const gid = `gid://shopify/Product/${productId}`;
  const data = await fetchShopifyGQLRetry(Q_BY_ID, { id: gid, vv:100, cp:100 });
  return summarize(data?.product);
}

/* -------------------------------- GET ------------------------------- */
export async function GET(req) {
  const headers = corsHeaders(req.headers.get('origin'));
  try {
    const url = new URL(req.url);
    const action = (url.searchParams.get('action') || '').trim();
    const handle = (url.searchParams.get('handle') || '').trim();
    const idParam = (url.searchParams.get('id') || '').trim();
    const token  = (url.searchParams.get('token') || '').trim();

    if (ENV.PUBLIC_PROBE_TOKEN && token !== ENV.PUBLIC_PROBE_TOKEN) {
      return NextResponse.json({ error:'unauthorized' }, { status:401, headers });
    }

    // DIAGNOSTIC MODE: /api/create-webhook?action=diag
    if (action === 'diag') {
      const host = normalizeMyShopifyDomain(ENV.SHOPIFY_STORE);
      const urlUsed = `https://${host}/admin/api/${ENV.SHOPIFY_API_VERSION}/graphql.json`;
      // Try a minimal query to confirm auth + URL
      let ping = null, err = null;
      try {
        const data = await fetchShopifyGQLRetry(`query{ shop { id name } }`, {});
        ping = data?.shop || null;
      } catch (e) {
        err = String(e?.message || e);
      }
      return NextResponse.json({
        env: {
          SHOPIFY_STORE_raw: ENV.SHOPIFY_STORE,
          SHOPIFY_STORE_normalized: host,
          SHOPIFY_API_VERSION: ENV.SHOPIFY_API_VERSION,
          ADMIN_TOKEN_present: !!ENV.ADMIN_API_TOKEN,
        },
        urlUsed,
        ping,
        error: err,
      }, { headers });
    }

    if (!handle && !idParam) {
      return NextResponse.json({
        error:'missing handle or id',
        usage:[
          '/api/create-webhook?handle=<PRODUCT_HANDLE>[&token=...]',
          '/api/create-webhook?id=<PRODUCT_ID>[&token=...]',
          '/api/create-webhook?action=diag[&token=...]'
        ]
      }, { status:400, headers });
    }

    let summary;
    if (handle) summary = await getBundleSummaryByHandle(handle);
    else {
      const n = Number(idParam);
      if (!Number.isFinite(n) || n <= 0) {
        return NextResponse.json({ error:'bad id', usage:'/api/create-webhook?id=12345' }, { status:400, headers });
      }
      summary = await getBundleSummaryById(n);
    }

    const earliestPretty = summary.earliestISO ? new Date(summary.earliestISO).toISOString().slice(0,10) : null;

    return NextResponse.json({
      handle: handle || null,
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

// Keep your webhook POST if needed:
// export async function POST(req) { ... }

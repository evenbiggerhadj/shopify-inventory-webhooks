// /app/api/bundle-eta/route.js
// Read-only endpoint: computes the earliest component date for native Shopify bundles
// using the variant/product metafield custom.restock_date.
// No metafield writes. Safe to expose behind a PUBLIC_PROBE_TOKEN.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

import { NextResponse } from 'next/server';

/* ============================ Env ============================ */
const ENV = {
  SHOPIFY_STORE:       process.env.SHOPIFY_STORE,          // e.g. "yourstore.myshopify.com" (no protocol)
  ADMIN_API_TOKEN:     process.env.SHOPIFY_ADMIN_API_KEY,  // Admin API token
  SHOPIFY_API_VERSION: process.env.SHOPIFY_API_VERSION || '2025-01',
  PUBLIC_PROBE_TOKEN:  process.env.PUBLIC_PROBE_TOKEN || '', // optional gate
};

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
function worstStatus(a, b) {
  const RANK = { ok: 0, understocked: 1, 'out-of-stock': 2 };
  return (RANK[a] >= RANK[b]) ? a : b;
}

// Prefer future dates; if no future dates exist, take the closest past.
function pickDateFromVariantNode(pv) {
  const candidates = [
    pv?.mf_restock?.value,           // variant-level custom.restock_date
    pv?.product?.pmf_restock?.value, // product-level fallback
  ].filter(Boolean);
  if (!candidates.length) return null;

  const toISO = (s) => (s.length === 10 ? `${s}T00:00:00Z` : s);
  const now = Date.now();
  const parsed = candidates
    .map(toISO)
    .map(iso => ({ iso, ts: Date.parse(iso) }))
    .filter(x => Number.isFinite(x.ts));
  if (!parsed.length) return null;

  const future = parsed.filter(x => x.ts >= now);
  const pool = future.length ? future : parsed;
  pool.sort((a, b) => a.ts - b.ts);
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

  let earliestISO_constraining = null;
  let earliestSource_constraining = null;
  let earliestISO_any = null;
  let earliestSource_any = null;

  for (const e of edges) {
    const comps = e?.node?.productVariantComponents?.nodes || [];
    if (comps.length) hasComponents = true;
    if (!comps.length) continue;

    let anyZeroOrNeg = false;
    let anyInsufficient = false;
    let minBuildable = Number.POSITIVE_INFINITY;

    for (const c of comps) {
      const pv = c?.productVariant;
      if (!pv) continue;

      const have = Math.max(0, Number(pv.sellableOnlineQuantity ?? 0));
      const need = Math.max(1, Number(c?.quantity ?? 1));
      const policy = String(pv.inventoryPolicy || '').toUpperCase();
      const isOOS = (pv.availableForSale === false) || (have <= 0 && (policy === 'DENY' || policy === 'CONTINUE'));
      const isConstraining = isOOS || (have < need);

      if (have <= 0) anyZeroOrNeg = true;
      else if (have < need) anyInsufficient = true;

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

  return {
    ok: true,
    hasComponents,
    finalStatus,
    totalBuildable,
    earliestISO: chosenISO,        // may be null if no restock_date anywhere
    earliestSource: chosenSource,  // { handle, variantGid, date } | null
  };
}

/* ============================ GET ============================ */
export async function GET(req) {
  try {
    const url = new URL(req.url);
    const handle = url.searchParams.get('handle') || '';
    const token  = url.searchParams.get('token') || '';

    if (ENV.PUBLIC_PROBE_TOKEN && token !== ENV.PUBLIC_PROBE_TOKEN) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
    if (!handle) {
      return NextResponse.json({ error: 'missing handle' }, { status: 400 });
    }

    // Resolve handle -> product id
    const lookup = await fetchShopifyGQL(
      `query($h:String!){ productByHandle(handle:$h){ id handle } }`,
      { h: handle }
    );
    const gid = lookup?.productByHandle?.id;
    if (!gid) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    const productId = Number(String(gid).split('/').pop());
    const summary = await getBundleSummaryByProductId(productId);

    const earliestPretty = summary.earliestISO
      ? new Date(summary.earliestISO).toISOString().slice(0, 10)
      : null;

    return NextResponse.json({
      handle,
      hasComponents: !!summary.hasComponents,
      finalStatus: summary.finalStatus,
      earliestISO: summary.earliestISO, // ISO or null
      earliestPretty,                   // YYYY-MM-DD or null
      source: summary.earliestSource || null
    });
  } catch (e) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;

async function fetchFromShopify(endpoint, method = 'GET', body = null) {
  const headers = {
    'X-Shopify-Access-Token': ADMIN_API_TOKEN,
    'Content-Type': 'application/json',
  };
  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-04/${endpoint}`, options);
  return res.json();
}

async function getProductsTaggedBundle() {
  const res = await fetchFromShopify('products.json?fields=id,title,tags&limit=250');
  return res.products.filter((p) => p.tags.includes('bundle'));
}

async function getProductMetafields(productId) {
  const res = await fetchFromShopify(`products/${productId}/metafields.json`);
  return res.metafields.find(
    (m) => m.namespace === 'custom' && m.key === 'bundle_structure'
  );
}

async function getInventoryLevel(variantId) {
  const res = await fetchFromShopify(`variants/${variantId}.json`);
  return res.variant.inventory_quantity;
}

async function updateProductTags(productId, currentTags, status) {
  const cleanedTags = currentTags
    .filter(
      (tag) =>
        !['bundle-ok', 'bundle-understocked', 'bundle-out-of-stock'].includes(
          tag.trim().toLowerCase()
        )
    )
    .concat([`bundle-${status}`]);

  await fetchFromShopify(`products/${productId}.json`, 'PUT', {
    product: {
      id: productId,
      tags: cleanedTags.join(', '),
    },
  });
}

async function auditBundles() {
  const bundles = await getProductsTaggedBundle();
  for (const bundle of bundles) {
    const metafield = await getProductMetafields(bundle.id);
    if (!metafield || !metafield.value) continue;

    let components;
    try {
      components = JSON.parse(metafield.value);
    } catch {
      continue;
    }

    let understocked = [];
    let outOfStock = [];

    for (const component of components) {
      const currentQty = await getInventoryLevel(component.variant_id);
      if (currentQty === 0) outOfStock.push(component.variant_id);
      else if (currentQty < component.required_quantity) understocked.push(component.variant_id);
    }

    let status = 'ok';
    if (outOfStock.length > 0) status = 'out-of-stock';
    else if (understocked.length > 0) status = 'understocked';

    await updateProductTags(bundle.id, bundle.tags.split(','), status);
  }
}

export async function GET() {
  try {
    await auditBundles();
    return NextResponse.json({ success: true, message: 'Audit complete and tags updated.' });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ success: false, error: error.message });
  }
}

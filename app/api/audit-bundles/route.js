import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_KEY;
const KLAVIYO_API_KEY = process.env.KLAVIYO_PRIVATE_API_KEY;

// === Helpers for Shopify ===
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
  // Add "handle" to the fields!
  const res = await fetchFromShopify('products.json?fields=id,title,tags,handle&limit=250');
  return res.products.filter((p) => p.tags.includes('bundle'));
}

async function getProductMetafields(productId) {
  const res = await fetchFromShopify(`products/${productId}/metafields.json`);
  if (!res || !Array.isArray(res.metafields)) return null;
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

// === Redis Helpers ===
async function getBundleStatus(productId) {
  return (await redis.get(`status:${productId}`)) || null;
}

async function setBundleStatus(productId, prevStatus, currStatus) {
  await redis.set(`status:${productId}`, { previous: prevStatus, current: currStatus });
}

async function getSubscribers(productId) {
  return (await redis.get(`subscribers:${productId}`)) || [];
}

async function setSubscribers(productId, subs) {
  await redis.set(`subscribers:${productId}`, subs);
}

// === Klaviyo Event Sender ===
async function sendKlaviyoBackInStockEvent(email, productName, productUrl) {
  const resp = await fetch('https://a.klaviyo.com/api/events/', {
    method: 'POST',
    headers: {
      'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      'Content-Type': 'application/json',
      'revision': '2024-10-15'
    },
    body: JSON.stringify({
      data: {
        type: 'event',
        attributes: {
          properties: {
            ProductName: productName,
            ProductURL: productUrl,
          },
          metric: { data: { type: 'metric', attributes: { name: 'Back in Stock' } } },
          profile: { data: { type: 'profile', attributes: { email } } }
        }
      }
    })
  });
  if (!resp.ok) {
    const err = await resp.text();
    console.error('Klaviyo error:', err);
  }
}

// === Main Audit Script ===
async function auditBundles() {
  const bundles = await getProductsTaggedBundle();
  for (const bundle of bundles) {
    const metafield = await getProductMetafields(bundle.id);
    if (!metafield || !metafield.value) {
      console.log(`${bundle.title} → skipped (no bundle_structure metafield)`);
      continue;
    }

    let components;
    try {
      components = JSON.parse(metafield.value);
    } catch {
      console.error(`Invalid JSON in bundle_structure for ${bundle.title}`);
      continue;
    }

    let understocked = [];
    let outOfStock = [];

    for (const component of components) {
      const currentQty = await getInventoryLevel(component.variant_id);
      if (currentQty === 0) {
        outOfStock.push(component.variant_id);
      } else if (currentQty < component.required_quantity) {
        understocked.push(component.variant_id);
      }
    }

    let status = 'ok';
    if (outOfStock.length > 0) status = 'out-of-stock';
    else if (understocked.length > 0) status = 'understocked';

    // === STATUS HISTORY ===
    const prevStatusObj = await getBundleStatus(bundle.id);
    const prevStatus = prevStatusObj ? prevStatusObj.current : null;
    await setBundleStatus(bundle.id, prevStatus, status);

    // === NOTIFY SUBSCRIBERS IF BUNDLE NOW "ok" ===
    if (
      (prevStatus === 'understocked' || prevStatus === 'out-of-stock') &&
      status === 'ok'
    ) {
      const subs = await getSubscribers(bundle.id);
      const productUrl = `https://${SHOPIFY_STORE.replace('.myshopify.com', '')}.com/products/${bundle.handle}`;
      for (let sub of subs) {
        if (!sub.notified) {
          await sendKlaviyoBackInStockEvent(sub.email, bundle.title, productUrl);
          sub.notified = true;
        }
      }
      await setSubscribers(bundle.id, subs);
    }

    console.log(`${bundle.title} → ${status}`);
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

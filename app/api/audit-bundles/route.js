// app/api/audit-bundles/route.js - Bundle audit + notification system, triggers event for every subscriber every restock

import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_KEY;
const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;

// Shopify Helpers
async function fetchFromShopify(endpoint, method = 'GET', body = null) {
  if (!endpoint || typeof endpoint !== 'string') throw new Error(`fetchFromShopify called with invalid endpoint: "${endpoint}"`);
  const headers = {
    'X-Shopify-Access-Token': ADMIN_API_TOKEN,
    'Content-Type': 'application/json',
  };
  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);
  let url;
  if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
    url = endpoint;
  } else {
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
    url = `https://${SHOPIFY_STORE}/admin/api/2024-04/${cleanEndpoint}`;
  }
  const res = await fetch(url, options);
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Shopify API error: ${res.status} ${res.statusText} - ${errorText}`);
  }
  return res.json();
}
async function getProductsTaggedBundle() {
  const res = await fetchFromShopify('products.json?fields=id,title,tags,handle&limit=250');
  return res.products.filter((p) => p.tags.includes('bundle'));
}
async function getProductMetafields(productId) {
  const res = await fetchFromShopify(`products/${productId}/metafields.json`);
  if (!res || !Array.isArray(res.metafields)) return null;
  return res.metafields.find((m) => m.namespace === 'custom' && m.key === 'bundle_structure');
}
async function getInventoryLevel(variantId) {
  if (!variantId) {
    console.error('❌ Missing variant_id for getInventoryLevel');
    return 0;
  }
  const res = await fetchFromShopify(`variants/${variantId}.json`);
  return res.variant.inventory_quantity;
}
async function updateProductTags(productId, currentTags, status) {
  const cleanedTags = currentTags
    .filter(tag =>
      !['bundle-ok', 'bundle-understocked', 'bundle-out-of-stock'].includes(tag.trim().toLowerCase())
    )
    .concat([`bundle-${status}`]);
  await fetchFromShopify(`products/${productId}.json`, 'PUT', {
    product: {
      id: productId,
      tags: cleanedTags.join(', '),
    },
  });
}

// Redis
async function getBundleStatus(productId) {
  return (await redis.get(`status:${productId}`)) || null;
}
async function setBundleStatus(productId, prevStatus, currStatus) {
  await redis.set(`status:${productId}`, { previous: prevStatus, current: currStatus });
}
async function getSubscribers(productId) {
  const result = await redis.get(`subscribers:${productId}`);
  if (!result) return [];
  if (typeof result === 'string') {
    try { return JSON.parse(result); } catch { return []; }
  }
  return Array.isArray(result) ? result : [];
}

// Klaviyo: Send event to EVERYONE on waitlist, EVERY time
async function sendKlaviyoBackInStockEvent(email, productName, productUrl) {
  if (!KLAVIYO_API_KEY) return false;
  try {
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
              NotificationType: 'Back in Stock',
              Timestamp: new Date().toISOString()
            },
            metric: { 
              data: { type: 'metric', attributes: { name: 'Back in Stock' } } 
            },
            profile: { data: { type: 'profile', attributes: { email } } }
          }
        }
      })
    });
    if (!resp.ok) {
      const err = await resp.text();
      console.error('❌ Klaviyo error:', resp.status, err);
      return false;
    }
    return true;
  } catch (error) {
    console.error('❌ Failed to send Klaviyo notification:', error);
    return false;
  }
}

// Main Audit
async function auditBundles() {
  console.log('🔍 Starting bundle audit process...');
  const bundles = await getProductsTaggedBundle();
  console.log(`📦 Found ${bundles.length} bundles to audit`);
  let notificationsSent = 0;
  let notificationErrors = 0;
  let bundlesProcessed = 0;

  for (const bundle of bundles) {
    try {
      bundlesProcessed++;
      const metafield = await getProductMetafields(bundle.id);
      if (!metafield || !metafield.value) continue;
      let components;
      try { components = JSON.parse(metafield.value); }
      catch { continue; }
      let understocked = [], outOfStock = [];
      for (const component of components) {
        if (!component.variant_id) continue;
        const currentQty = await getInventoryLevel(component.variant_id);
        if (currentQty === 0) outOfStock.push(component.variant_id);
        else if (currentQty < component.required_quantity) understocked.push(component.variant_id);
      }
      let status = 'ok';
      if (outOfStock.length > 0) status = 'out-of-stock';
      else if (understocked.length > 0) status = 'understocked';

      // Track last known status
      const prevStatusObj = await getBundleStatus(bundle.id);
      const prevStatus = prevStatusObj ? prevStatusObj.current : null;
      await setBundleStatus(bundle.id, prevStatus, status);

      // If bundle just became "ok", notify ALL subscribers every time
      if (
        (prevStatus === 'understocked' || prevStatus === 'out-of-stock') &&
        status === 'ok'
      ) {
        const subs = await getSubscribers(bundle.id);
        const productUrl = `https://${SHOPIFY_STORE.replace('.myshopify.com', '')}.com/products/${bundle.handle}`;
        for (let sub of subs) {
          // Fire event regardless of previous notification state
          if (sub && sub.email) {
            const success = await sendKlaviyoBackInStockEvent(sub.email, bundle.title, productUrl);
            if (success) notificationsSent++;
            else notificationErrors++;
          }
        }
      }

      await updateProductTags(bundle.id, bundle.tags.split(','), status);

    } catch (error) {
      // Continue processing other bundles even if one fails
      console.error('❌ Error processing bundle:', error);
    }
  }
  console.log(`\n✅ Audit complete!`);
  console.log(`📦 Bundles processed: ${bundlesProcessed}`);
  console.log(`📧 Notifications sent: ${notificationsSent}`);
  console.log(`❌ Notification errors: ${notificationErrors}`);
  return { 
    bundlesProcessed, 
    notificationsSent, 
    notificationErrors,
    timestamp: new Date().toISOString()
  };
}

export async function GET() {
  try {
    const results = await auditBundles();
    return NextResponse.json({ 
      success: true, 
      message: 'Audit complete and tags updated.',
      ...results
    });
  } catch (error) {
    return NextResponse.json({ 
      success: false, 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    }, { status: 500 });
  }
}

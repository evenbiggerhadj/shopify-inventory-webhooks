// app/api/audit-bundles/route.js - Bundle audit + Klaviyo form integration (robust tag update)
import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

// ENV
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_KEY;
const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;

// Helper: Shopify fetch
async function fetchFromShopify(endpoint, method = 'GET', body = null) {
  const headers = {
    'X-Shopify-Access-Token': ADMIN_API_TOKEN,
    'Content-Type': 'application/json',
  };
  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);
  let url;
  if (endpoint.startsWith('http')) url = endpoint;
  else {
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
    url = `https://${SHOPIFY_STORE}/admin/api/2024-04/${cleanEndpoint}`;
  }
  const res = await fetch(url, options);
  if (!res.ok) {
    const msg = await res.text();
    console.error(`Shopify API error (${url}): ${res.status} ${msg}`);
    throw new Error(`Shopify API error: ${res.status} ${msg}`);
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
  return res.metafields.find(
    (m) => m.namespace === 'custom' && m.key === 'bundle_structure'
  );
}

async function getInventoryLevel(variantId) {
  if (!variantId) return 0;
  const res = await fetchFromShopify(`variants/${variantId}.json`);
  return res.variant.inventory_quantity;
}

// ---- ROBUST TAG UPDATE LOGIC ----
async function updateProductTags(productId, currentTags, status) {
  // Defensive: convert to array if string
  if (typeof currentTags === 'string') currentTags = currentTags.split(',');

  const cleanedTags = currentTags
    .map(tag => tag.trim())
    .filter((tag, idx, arr) => tag && arr.indexOf(tag) === idx)
    .filter(tag => !['bundle-ok', 'bundle-understocked', 'bundle-out-of-stock'].includes(tag.toLowerCase()))
    .concat([`bundle-${status}`]);
  const tagsString = cleanedTags.join(', ');
  console.log(`⏩ [TAG UPDATE] Product ${productId} tags:`, tagsString);

  // Update Shopify product
  const result = await fetchFromShopify(`products/${productId}.json`, 'PUT', {
    product: { id: productId, tags: tagsString }
  });
  if (result && result.product && result.product.tags) {
    console.log(`✅ [TAG SUCCESS] Product ${productId} tags now: ${result.product.tags}`);
  } else {
    console.warn(`[TAG WARNING] Tag update response:`, result);
  }
}

// --- KLAVIYO: get profiles by product id property ---
async function getKlaviyoWaitlistProfiles(productId) {
  if (!KLAVIYO_API_KEY) throw new Error('KLAVIYO_API_KEY not set');
  // Use property set via Shopify frontend: waitlist_for_product_id
  const url = `https://a.klaviyo.com/api/profiles/?filter=equals(waitlist_for_product_id,"${productId}")&fields=profile,email,phone_number,first_name,last_name&limit=1000`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      'accept': 'application/json',
      'revision': '2024-10-15'
    }
  });
  if (!resp.ok) throw new Error(`Klaviyo Profile API error: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return (data.data || []).map(p => ({
    email: p.attributes.email,
    phone: p.attributes.phone_number,
    first_name: p.attributes.first_name,
    last_name: p.attributes.last_name,
  }));
}

// --- KLAVIYO: send event for notification ---
async function sendKlaviyoBackInStockEvent(email, productName, productUrl) {
  if (!KLAVIYO_API_KEY) return false;
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
          profile: {
            data: { type: 'profile', attributes: { email } }
          }
        }
      }
    })
  });
  return resp.ok;
}

// ---- MAIN AUDIT LOGIC ----
async function auditBundles() {
  const bundles = await getProductsTaggedBundle();
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

      // Redis: save current & previous status
      const prevStatusObj = await redis.get(`status:${bundle.id}`);
      const prevStatus = prevStatusObj ? prevStatusObj.current : null;
      await redis.set(`status:${bundle.id}`, { previous: prevStatus, current: status });

      // Notification logic: on transition to OK, send emails to all relevant Klaviyo waitlist
      if (
        (prevStatus === 'understocked' || prevStatus === 'out-of-stock') &&
        status === 'ok'
      ) {
        const waitlistProfiles = await getKlaviyoWaitlistProfiles(bundle.id);
        const productUrl = `https://${SHOPIFY_STORE.replace('.myshopify.com', '')}.com/products/${bundle.handle}`;
        console.log(`🔔 ${bundle.title}: ${waitlistProfiles.length} profiles to notify`);
        for (const p of waitlistProfiles) {
          if (p.email) {
            const success = await sendKlaviyoBackInStockEvent(p.email, bundle.title, productUrl);
            if (success) notificationsSent++;
            else notificationErrors++;
          }
        }
      }

      // --- TAG UPDATE (always run for each bundle) ---
      await updateProductTags(bundle.id, bundle.tags.split(',').map(t => t.trim()), status);

    } catch (error) {
      // Continue processing other bundles even if one fails
      console.error('❌ Error processing bundle:', error);
    }
  }
  return {
    bundlesProcessed,
    notificationsSent,
    notificationErrors,
    timestamp: new Date().toISOString()
  };
}

// ---- HTTP Handler ----
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

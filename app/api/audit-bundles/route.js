// app/api/audit-bundles/route.js - FIXED Next.js App Router format
import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_KEY;
const KLAVIYO_API_KEY = process.env.KLAVIYO_PRIVATE_API_KEY;

// === FIXED Shopify Helper - NO MORE "/pipeline" ERRORS ===
async function fetchFromShopify(endpoint, method = 'GET', body = null) {
  // REMOVED the problematic validation that caused "/pipeline" errors
  if (!endpoint || typeof endpoint !== 'string') {
    throw new Error(`fetchFromShopify called with invalid endpoint: "${endpoint}"`);
  }
  
  console.log('🔍 Shopify API fetch:', endpoint);
  
  const headers = {
    'X-Shopify-Access-Token': ADMIN_API_TOKEN,
    'Content-Type': 'application/json',
  };
  
  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);
  
  // FIXED: Handle both relative and absolute endpoints properly
  let url;
  if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
    url = endpoint;
  } else {
    // Remove leading slash if present, then construct URL properly
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
    url = `https://${SHOPIFY_STORE}/admin/api/2024-04/${cleanEndpoint}`;
  }
  
  console.log('🌐 Final URL:', url);
  
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
  return res.metafields.find(
    (m) => m.namespace === 'custom' && m.key === 'bundle_structure'
  );
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

// === Enhanced Klaviyo Event Sender ===
async function sendKlaviyoBackInStockEvent(email, productName, productUrl) {
  if (!KLAVIYO_API_KEY) {
    console.error('❌ KLAVIYO_PRIVATE_API_KEY not set - skipping notification');
    return false;
  }

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
              data: { 
                type: 'metric', 
                attributes: { name: 'Back in Stock' } 
              } 
            },
            profile: { 
              data: { 
                type: 'profile', 
                attributes: { email } 
              } 
            }
          }
        }
      })
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error('❌ Klaviyo error:', resp.status, err);
      return false;
    }

    console.log(`✅ Sent back-in-stock notification to ${email} for ${productName}`);
    return true;

  } catch (error) {
    console.error('❌ Failed to send Klaviyo notification:', error);
    return false;
  }
}

// === Main Audit Script ===
async function auditBundles() {
  console.log('🔍 Starting bundle audit process...');
  
  const bundles = await getProductsTaggedBundle();
  console.log(`📦 Found ${bundles.length} bundles to audit`);
  
  let notificationsSent = 0;
  let notificationErrors = 0;
  let bundlesProcessed = 0;

  for (const bundle of bundles) {
    try {
      console.log(`\n📦 Processing bundle: ${bundle.title}`);
      bundlesProcessed++;
      
      const metafield = await getProductMetafields(bundle.id);
      if (!metafield || !metafield.value) {
        console.log(`⚠️ ${bundle.title} → skipped (no bundle_structure metafield)`);
        continue;
      }

      let components;
      try {
        components = JSON.parse(metafield.value);
      } catch {
        console.error(`❌ Invalid JSON in bundle_structure for ${bundle.title}`);
        continue;
      }

      let understocked = [];
      let outOfStock = [];

      for (const component of components) {
        if (!component.variant_id) {
          console.error('⚠️ Skipping component with missing variant_id:', component);
          continue;
        }
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

      console.log(`📊 ${bundle.title} → ${prevStatus || 'unknown'} → ${status}`);

      // === NOTIFY SUBSCRIBERS IF BUNDLE NOW "ok" ===
      if (
        (prevStatus === 'understocked' || prevStatus === 'out-of-stock') &&
        status === 'ok'
      ) {
        console.log(`🔔 Bundle ${bundle.title} is back in stock! Sending notifications...`);
        
        const subs = await getSubscribers(bundle.id);
        const productUrl = `https://${SHOPIFY_STORE.replace('.myshopify.com', '')}.com/products/${bundle.handle}`;
        
        console.log(`📧 Found ${subs.length} subscribers for ${bundle.title}`);
        
        for (let sub of subs) {
          if (!sub.notified) {
            const success = await sendKlaviyoBackInStockEvent(sub.email, bundle.title, productUrl);
            if (success) {
              sub.notified = true;
              notificationsSent++;
            } else {
              notificationErrors++;
            }
          }
        }
        await setSubscribers(bundle.id, subs);
      }

      await updateProductTags(bundle.id, bundle.tags.split(','), status);

    } catch (error) {
      console.error(`❌ Error processing bundle ${bundle.title}:`, error);
      // Continue processing other bundles even if one fails
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
    console.log('🚀 Starting bundle audit...');
    const results = await auditBundles();
    
    return NextResponse.json({ 
      success: true, 
      message: 'Audit complete and tags updated.',
      ...results
    });
  } catch (error) {
    console.error('❌ Audit failed:', error);
    return NextResponse.json({ 
      success: false, 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    }, { status: 500 });
  }
}
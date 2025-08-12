// app/api/audit-bundles/route.js - FIXED with Shopify rate limiting
import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

// Use YOUR actual environment variable names
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_KEY;
const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;

// === RATE LIMITING ===
let lastApiCall = 0;
const MIN_DELAY_MS = 600; // 600ms = 1.67 calls per second (safely under 2/sec limit)

async function rateLimitedDelay() {
  const now = Date.now();
  const timeSinceLastCall = now - lastApiCall;
  
  if (timeSinceLastCall < MIN_DELAY_MS) {
    const delayNeeded = MIN_DELAY_MS - timeSinceLastCall;
    console.log(`⏱️ Rate limiting: waiting ${delayNeeded}ms...`);
    await new Promise(resolve => setTimeout(resolve, delayNeeded));
  }
  
  lastApiCall = Date.now();
}

// === FIXED Shopify Helper with Rate Limiting ===
async function fetchFromShopify(endpoint, method = 'GET', body = null) {
  if (!endpoint || typeof endpoint !== 'string') {
    throw new Error(`fetchFromShopify called with invalid endpoint: "${endpoint}"`);
  }
  
  // CRITICAL: Rate limit before every API call
  await rateLimitedDelay();
  
  console.log('🔍 Shopify API fetch:', endpoint);
  
  const headers = {
    'X-Shopify-Access-Token': ADMIN_API_TOKEN,
    'Content-Type': 'application/json',
  };
  
  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);
  
  // Handle both relative and absolute endpoints properly
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
    if (res.status === 429) {
      // Rate limited - wait longer and retry once
      console.log('⚠️ Rate limited! Waiting 2 seconds and retrying...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      lastApiCall = Date.now(); // Reset timer
      
      // Retry once
      const retryRes = await fetch(url, options);
      if (!retryRes.ok) {
        const errorText = await retryRes.text();
        throw new Error(`Shopify API error after retry: ${retryRes.status} ${retryRes.statusText} - ${errorText}`);
      }
      return retryRes.json();
    } else {
      const errorText = await res.text();
      throw new Error(`Shopify API error: ${res.status} ${res.statusText} - ${errorText}`);
    }
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
  const result = await redis.get(`subscribers:${productId}`);
  if (!result) return [];
  
  // Handle different return types
  if (typeof result === 'string') {
    try {
      return JSON.parse(result);
    } catch {
      return [];
    }
  }
  
  return Array.isArray(result) ? result : [];
}

async function setSubscribers(productId, subs) {
  await redis.set(`subscribers:${productId}`, subs);
}

// === Klaviyo Functions (no rate limiting needed - different API) ===
async function createOrGetProfileForNotification(email, firstName, lastName, phone) {
  try {
    const profileData = {
      data: {
        type: 'profile',
        attributes: {
          email,
          first_name: firstName || '',
          last_name: lastName || '',
          properties: {
            'Back in Stock Subscriber': true,
            'Phone Number': phone || '',
            'Profile Ensured for Notification': new Date().toISOString()
          }
        }
      }
    };

    const profileResponse = await fetch('https://a.klaviyo.com/api/profiles/', {
      method: 'POST',
      headers: {
        'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        'Content-Type': 'application/json',
        'revision': '2024-10-15'
      },
      body: JSON.stringify(profileData)
    });

    if (profileResponse.ok) {
      const result = await profileResponse.json();
      return result.data.id;
    } else if (profileResponse.status === 409) {
      // Profile exists, get the ID
      const getProfileResponse = await fetch(`https://a.klaviyo.com/api/profiles/?filter=equals(email,"${email}")`, {
        headers: {
          'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
          'revision': '2024-10-15'
        }
      });

      if (getProfileResponse.ok) {
        const result = await getProfileResponse.json();
        if (result.data && result.data.length > 0) {
          return result.data[0].id;
        }
      }
    }
    
    return null;
  } catch (error) {
    console.error('❌ Profile creation error for notification:', error);
    return null;
  }
}

async function addToBackInStockAlertList(email, firstName, lastName, phone, productName, productUrl, alertListId) {
  if (!KLAVIYO_API_KEY) {
    console.error('❌ KLAVIYO_API_KEY not set');
    return false;
  }

  try {
    console.log(`📋 Adding ${email} to back-in-stock alert list for ${productName}...`);

    // Format phone number
    let formattedPhone = null;
    if (phone && phone.length > 0) {
      let cleanPhone = phone.replace(/\D/g, '');
      
      if (cleanPhone.startsWith('234')) {
        formattedPhone = '+' + cleanPhone;
      } else if (cleanPhone.startsWith('0') && cleanPhone.length === 11) {
        formattedPhone = '+234' + cleanPhone.substring(1);
      } else if (cleanPhone.length === 10 && (cleanPhone.startsWith('90') || cleanPhone.startsWith('80') || cleanPhone.startsWith('70'))) {
        formattedPhone = '+234' + cleanPhone;
      } else if (cleanPhone.length === 10) {
        formattedPhone = '+1' + cleanPhone;
      } else {
        formattedPhone = '+' + cleanPhone;
      }
    }

    const profileId = await createOrGetProfileForNotification(email, firstName, lastName, formattedPhone);
    
    if (profileId) {
      const addToListData = {
        data: [{
          type: 'profile',
          id: profileId
        }]
      };

      const response = await fetch(`https://a.klaviyo.com/api/lists/${alertListId}/relationships/profiles/`, {
        method: 'POST',
        headers: {
          'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
          'Content-Type': 'application/json',
          'revision': '2024-10-15'
        },
        body: JSON.stringify(addToListData)
      });
      
      if (response.ok || response.status === 204) {
        console.log(`✅ Added ${email} to back-in-stock alert list for ${productName}`);
        return true;
      } else {
        const errorText = await response.text();
        console.error(`❌ Failed to add ${email} to alert list:`, errorText);
        return false;
      }
    } else {
      console.error(`❌ Could not create/get profile for ${email}`);
      return false;
    }
    
  } catch (error) {
    console.error(`❌ Alert list error for ${email}:`, error);
    return false;
  }
}

// === OPTIMIZED Main Audit Script with Batching ===
async function auditBundles() {
  console.log('🔍 Starting bundle audit process with rate limiting...');
  
  const startTime = Date.now();
  const bundles = await getProductsTaggedBundle();
  console.log(`📦 Found ${bundles.length} bundles to audit`);
  
  let notificationsSent = 0;
  let notificationErrors = 0;
  let bundlesProcessed = 0;
  let apiCallsCount = 1; // Already made 1 call to get products

  for (const bundle of bundles) {
    try {
      console.log(`\n📦 Processing bundle ${bundlesProcessed + 1}/${bundles.length}: ${bundle.title}`);
      bundlesProcessed++;
      
      // Get metafields (API call #2 per bundle)
      const metafield = await getProductMetafields(bundle.id);
      apiCallsCount++;
      
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

      console.log(`📊 Checking inventory for ${components.length} components...`);
      let understocked = [];
      let outOfStock = [];

      // Check inventory for each component (multiple API calls)
      for (const component of components) {
        if (!component.variant_id) {
          console.error('⚠️ Skipping component with missing variant_id:', component);
          continue;
        }
        
        const currentQty = await getInventoryLevel(component.variant_id);
        apiCallsCount++;
        
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
        console.log(`🔔 Bundle ${bundle.title} is back in stock! Processing subscribers...`);
        
        const subs = await getSubscribers(bundle.id);
        console.log(`📧 Found ${subs.length} subscribers for ${bundle.title}`);
        
        const BACK_IN_STOCK_ALERT_LIST_ID = process.env.KLAVIYO_BACK_IN_STOCK_ALERT_LIST_ID || 'Tnz7TZ';
        
        for (let sub of subs) {
          if (sub && !sub.notified) {
            console.log(`📋 Processing subscriber: ${sub.email}`);
            
            const success = await addToBackInStockAlertList(
              sub.email,
              sub.first_name || '',
              sub.last_name || '',
              sub.phone || '',
              bundle.title,
              `https://${SHOPIFY_STORE.replace('.myshopify.com', '')}.com/products/${bundle.handle}`,
              BACK_IN_STOCK_ALERT_LIST_ID
            );
            
            if (success) {
              sub.notified = true;
              notificationsSent++;
              console.log(`✅ Successfully added ${sub.email} to alert list`);
            } else {
              notificationErrors++;
              console.log(`❌ Failed to add ${sub.email} to alert list`);
            }
          }
        }
        
        await setSubscribers(bundle.id, subs);
      }

      // Update product tags (final API call per bundle)
      await updateProductTags(bundle.id, bundle.tags.split(','), status);
      apiCallsCount++;

      // Progress update
      const elapsed = (Date.now() - startTime) / 1000;
      const avgTimePerBundle = elapsed / bundlesProcessed;
      const estimatedTimeLeft = (bundles.length - bundlesProcessed) * avgTimePerBundle;
      
      console.log(`⏱️ Progress: ${bundlesProcessed}/${bundles.length} bundles (${Math.round(elapsed)}s elapsed, ~${Math.round(estimatedTimeLeft)}s remaining)`);
      console.log(`📊 API calls made: ${apiCallsCount} (rate: ${(apiCallsCount / elapsed).toFixed(2)}/sec)`);

    } catch (error) {
      console.error(`❌ Error processing bundle ${bundle.title}:`, error);
      // Continue processing other bundles even if one fails
    }
  }

  const totalTime = (Date.now() - startTime) / 1000;
  
  console.log(`\n✅ Audit complete!`);
  console.log(`📦 Bundles processed: ${bundlesProcessed}`);
  console.log(`📧 Notifications sent: ${notificationsSent}`);
  console.log(`❌ Notification errors: ${notificationErrors}`);
  console.log(`⏱️ Total time: ${Math.round(totalTime)}s`);
  console.log(`📊 Total API calls: ${apiCallsCount} (avg rate: ${(apiCallsCount / totalTime).toFixed(2)}/sec)`);
  
  return { 
    bundlesProcessed, 
    notificationsSent, 
    notificationErrors,
    totalTimeSeconds: totalTime,
    apiCallsCount,
    avgApiCallRate: apiCallsCount / totalTime,
    timestamp: new Date().toISOString()
  };
}

export async function GET() {
  try {
    console.log('🚀 Starting rate-limited bundle audit...');
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
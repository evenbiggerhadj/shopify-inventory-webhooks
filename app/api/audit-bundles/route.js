// app/api/audit-bundles/route.js - Enhanced Bundle audit + Klaviyo form integration
import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

// ENV
const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.KV_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.KV_REST_API_READ_ONLY_TOKEN,
});
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_KEY;
const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;

// Rate limiting helper
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Shopify fetch with retry logic
async function fetchFromShopify(endpoint, method = 'GET', body = null, retries = 3) {
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
    url = `https://${SHOPIFY_STORE}/admin/api/2024-10/${cleanEndpoint}`;
  }
  
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) {
        const msg = await res.text();
        console.error(`Shopify API error (${url}): ${res.status} ${msg}`);
        
        // If rate limited, wait and retry
        if (res.status === 429 && i < retries - 1) {
          await delay(2000 * (i + 1)); // Exponential backoff
          continue;
        }
        
        throw new Error(`Shopify API error: ${res.status} ${msg}`);
      }
      return res.json();
    } catch (error) {
      if (i === retries - 1) throw error;
      await delay(1000 * (i + 1));
    }
  }
}

async function getProductsTaggedBundle() {
  const res = await fetchFromShopify('products.json?fields=id,title,tags,handle&limit=250');
  if (!res || !res.products) {
    console.error('No products returned from Shopify');
    return [];
  }
  return res.products.filter((p) => p.tags && p.tags.toLowerCase().includes('bundle'));
}

async function getProductMetafields(productId) {
  try {
    const res = await fetchFromShopify(`products/${productId}/metafields.json`);
    if (!res || !Array.isArray(res.metafields)) return null;
    return res.metafields.find(
      (m) => m.namespace === 'custom' && m.key === 'bundle_structure'
    );
  } catch (error) {
    console.error(`Error fetching metafields for product ${productId}:`, error);
    return null;
  }
}

async function getInventoryLevel(variantId) {
  if (!variantId) return 0;
  try {
    const res = await fetchFromShopify(`variants/${variantId}.json`);
    return res.variant?.inventory_quantity || 0;
  } catch (error) {
    console.error(`Error fetching inventory for variant ${variantId}:`, error);
    return 0;
  }
}

// Enhanced tag update logic with validation
async function updateProductTags(productId, currentTags, status) {
  try {
    // Defensive: handle various tag formats
    let tagsArray = [];
    if (typeof currentTags === 'string') {
      tagsArray = currentTags.split(',').map(t => t.trim()).filter(t => t);
    } else if (Array.isArray(currentTags)) {
      tagsArray = currentTags.map(t => String(t).trim()).filter(t => t);
    }

    // Remove existing bundle status tags and add new one
    const cleanedTags = tagsArray
      .filter(tag => !['bundle-ok', 'bundle-understocked', 'bundle-out-of-stock'].includes(tag.toLowerCase()))
      .concat([`bundle-${status}`]);
    
    // Remove duplicates
    const uniqueTags = [...new Set(cleanedTags)];
    const tagsString = uniqueTags.join(', ');
    
    console.log(`⏩ [TAG UPDATE] Product ${productId} tags: ${tagsString}`);

    const result = await fetchFromShopify(`products/${productId}.json`, 'PUT', {
      product: { id: productId, tags: tagsString }
    });
    
    if (result?.product?.tags) {
      console.log(`✅ [TAG SUCCESS] Product ${productId} tags now: ${result.product.tags}`);
      return true;
    } else {
      console.warn(`[TAG WARNING] Unexpected tag update response for product ${productId}`);
      return false;
    }
  } catch (error) {
    console.error(`[TAG ERROR] Failed to update tags for product ${productId}:`, error);
    return false;
  }
}

// Enhanced Klaviyo profile fetching with better error handling
async function getKlaviyoWaitlistProfiles(productId) {
  if (!KLAVIYO_API_KEY) {
    console.error('KLAVIYO_API_KEY not set');
    return [];
  }
  
  try {
    // Try multiple property name variations that might be used
    const propertyNames = [
      'waitlist_for_product_id',
      'waitlist_product_id', 
      'product_id',
      'waitlisted_product_id'
    ];
    
    let allProfiles = [];
    
    for (const propertyName of propertyNames) {
      const url = `https://a.klaviyo.com/api/profiles/?filter=equals(${propertyName},"${productId}")&fields=email,phone_number,first_name,last_name,properties&page[size]=100`;
      
      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
          'accept': 'application/json',
          'revision': '2024-10-15'
        }
      });
      
      if (resp.ok) {
        const data = await resp.json();
        if (data.data && data.data.length > 0) {
          console.log(`Found ${data.data.length} profiles with property ${propertyName} for product ${productId}`);
          
          const profiles = data.data.map(p => ({
            email: p.attributes.email,
            phone: p.attributes.phone_number,
            first_name: p.attributes.first_name,
            last_name: p.attributes.last_name,
            properties: p.attributes.properties || {}
          }));
          
          allProfiles.push(...profiles);
        }
      } else {
        console.log(`No profiles found with property ${propertyName} for product ${productId}`);
      }
      
      await delay(100); // Rate limit between requests
    }
    
    // Remove duplicates based on email
    const uniqueProfiles = allProfiles.reduce((acc, current) => {
      const existing = acc.find(item => item.email === current.email);
      if (!existing) {
        acc.push(current);
      }
      return acc;
    }, []);
    
    return uniqueProfiles;
    
  } catch (error) {
    console.error(`Error fetching Klaviyo profiles for product ${productId}:`, error);
    return [];
  }
}

// Enhanced Klaviyo event sending with retry logic
async function sendKlaviyoBackInStockEvent(email, productName, productUrl, productId) {
  if (!KLAVIYO_API_KEY) {
    console.error('KLAVIYO_API_KEY not set');
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
              ProductID: productId,
              NotificationType: 'Back in Stock',
              Timestamp: new Date().toISOString()
            },
            metric: {
              data: { 
                type: 'metric', 
                attributes: { name: 'Back in Stock Notification' } 
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
    
    if (resp.ok) {
      console.log(`✅ Sent notification to ${email} for product ${productName}`);
      return true;
    } else {
      const errorText = await resp.text();
      console.error(`❌ Failed to send notification to ${email}: ${resp.status} ${errorText}`);
      return false;
    }
  } catch (error) {
    console.error(`❌ Error sending notification to ${email}:`, error);
    return false;
  }
}

// Construct proper store URL
function getStoreUrl() {
  if (!SHOPIFY_STORE) return 'https://your-store.com';
  
  // Handle different store URL formats
  let baseUrl = SHOPIFY_STORE;
  if (baseUrl.includes('.myshopify.com')) {
    baseUrl = baseUrl.replace('.myshopify.com', '');
  }
  if (baseUrl.startsWith('http')) {
    return baseUrl;
  }
  
  // Try common domain patterns
  const commonDomains = ['.com', '.co', '.shop', '.store'];
  for (const domain of commonDomains) {
    // You might want to set a custom domain in env vars
    if (process.env.STORE_DOMAIN) {
      return `https://${process.env.STORE_DOMAIN}`;
    }
  }
  
  return `https://${baseUrl}.com`;
}

// Main audit logic with enhanced error handling and logging
async function auditBundles() {
  console.log('🚀 Starting bundle audit...');
  
  const bundles = await getProductsTaggedBundle();
  console.log(`📦 Found ${bundles.length} bundles to audit`);
  
  let notificationsSent = 0;
  let notificationErrors = 0;
  let bundlesProcessed = 0;
  let bundlesWithErrors = 0;
  const processedBundles = [];

  for (const bundle of bundles) {
    try {
      bundlesProcessed++;
      console.log(`\n📋 Processing bundle: ${bundle.title} (ID: ${bundle.id})`);
      
      const metafield = await getProductMetafields(bundle.id);
      if (!metafield || !metafield.value) {
        console.warn(`⚠️ Bundle ${bundle.title} has no bundle_structure metafield`);
        continue;
      }
      
      let components;
      try { 
        components = JSON.parse(metafield.value); 
      } catch (parseError) {
        console.error(`❌ Invalid JSON in bundle_structure for ${bundle.title}:`, parseError);
        continue;
      }
      
      // Validate components structure
      if (!Array.isArray(components) || components.length === 0) {
        console.warn(`⚠️ Bundle ${bundle.title} has invalid components structure`);
        continue;
      }
      
      let understocked = [], outOfStock = [];
      
      for (const component of components) {
        if (!component.variant_id) {
          console.warn(`⚠️ Component missing variant_id in bundle ${bundle.title}`);
          continue;
        }
        
        const currentQty = await getInventoryLevel(component.variant_id);
        const requiredQty = component.required_quantity || 1;
        
        console.log(`  📊 Variant ${component.variant_id}: ${currentQty} available, ${requiredQty} required`);
        
        if (currentQty === 0) {
          outOfStock.push(component.variant_id);
        } else if (currentQty < requiredQty) {
          understocked.push(component.variant_id);
        }
        
        await delay(50); // Small delay between inventory checks
      }
      
      // Determine status
      let status = 'ok';
      if (outOfStock.length > 0) {
        status = 'out-of-stock';
      } else if (understocked.length > 0) {
        status = 'understocked';
      }
      
      console.log(`📈 Bundle status: ${status.toUpperCase()}`);
      
      // Redis: save current & previous status
      const prevStatusObj = await redis.get(`status:${bundle.id}`);
      const prevStatus = prevStatusObj?.current || null;
      
      await redis.set(`status:${bundle.id}`, { 
        previous: prevStatus, 
        current: status,
        updated: new Date().toISOString()
      });
      
      // Notification logic: on transition to OK
      if (
        (prevStatus === 'understocked' || prevStatus === 'out-of-stock') &&
        status === 'ok'
      ) {
        console.log(`🔔 Bundle ${bundle.title} is back in stock! Looking for waitlist subscribers...`);
        
        const waitlistProfiles = await getKlaviyoWaitlistProfiles(bundle.id);
        console.log(`📧 Found ${waitlistProfiles.length} profiles on waitlist`);
        
        if (waitlistProfiles.length > 0) {
          const productUrl = `${getStoreUrl()}/products/${bundle.handle}`;
          
          for (const profile of waitlistProfiles) {
            if (profile.email) {
              const success = await sendKlaviyoBackInStockEvent(
                profile.email, 
                bundle.title, 
                productUrl,
                bundle.id
              );
              
              if (success) {
                notificationsSent++;
              } else {
                notificationErrors++;
              }
              
              await delay(100); // Rate limit notifications
            }
          }
        }
      } else {
        console.log(`📊 No notification needed (${prevStatus} → ${status})`);
      }
      
      // Update product tags
      const tagUpdateSuccess = await updateProductTags(bundle.id, bundle.tags, status);
      
      processedBundles.push({
        id: bundle.id,
        title: bundle.title,
        status,
        previousStatus: prevStatus,
        tagUpdateSuccess,
        notificationsSent: status === 'ok' && prevStatus !== 'ok' ? waitlistProfiles?.length || 0 : 0
      });
      
      await delay(200); // Delay between bundles
      
    } catch (error) {
      bundlesWithErrors++;
      console.error(`❌ Error processing bundle ${bundle.title}:`, error);
      
      processedBundles.push({
        id: bundle.id,
        title: bundle.title,
        error: error.message
      });
    }
  }
  
  const summary = {
    bundlesProcessed,
    bundlesWithErrors,
    notificationsSent,
    notificationErrors,
    timestamp: new Date().toISOString(),
    processedBundles
  };
  
  console.log('\n📊 Audit Summary:', summary);
  return summary;
}

// HTTP Handler
export async function GET() {
  try {
    console.log('🎯 Bundle audit endpoint called');
    
    // Validate required environment variables
    if (!SHOPIFY_STORE || !ADMIN_API_TOKEN) {
      throw new Error('Missing required Shopify environment variables');
    }
    
    if (!KLAVIYO_API_KEY) {
      console.warn('⚠️ KLAVIYO_API_KEY not set - notifications will be skipped');
    }
    
    const results = await auditBundles();
    
    return NextResponse.json({
      success: true,
      message: 'Bundle audit completed successfully',
      ...results
    });
    
  } catch (error) {
    console.error('❌ Audit failed:', error);
    
    return NextResponse.json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      timestamp: new Date().toISOString()
    }, { status: 500 });
  }
}
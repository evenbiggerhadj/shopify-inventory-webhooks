// app/api/audit-bundles/route.js - Bundle audit and notification system
import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

// Use YOUR actual environment variable names
const redis = new Redis({
  url: process.env.KV_REST_API_URL,      // Changed from UPSTASH_REDIS_REST_URL
  token: process.env.KV_REST_API_TOKEN,  // Changed from UPSTASH_REDIS_REST_TOKEN
});

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_KEY;
const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;

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

// === Enhanced function to ensure user is in back-in-stock list ===
async function ensureInBackInStockList(email, firstName = '', lastName = '', phone = '') {
  if (!KLAVIYO_API_KEY) return false;

  const BACK_IN_STOCK_LIST_ID = process.env.KLAVIYO_BACK_IN_STOCK_LIST_ID || 'WG9GbK';

  try {
    console.log(`🔍 Ensuring ${email} is in back-in-stock list...`);

    // STEP 1: Get profile ID first
    const getProfileResponse = await fetch(`https://a.klaviyo.com/api/profiles/?filter=equals(email,"${email}")`, {
      headers: {
        'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        'revision': '2024-10-15'
      }
    });

    let profileId = null;
    if (getProfileResponse.ok) {
      const getProfileResult = await getProfileResponse.json();
      if (getProfileResult.data && getProfileResult.data.length > 0) {
        profileId = getProfileResult.data[0].id;
        console.log(`✅ Found profile ID: ${profileId} for ${email}`);
      }
    }

    // STEP 2: If no profile exists, create one
    if (!profileId) {
      console.log(`📝 Creating new profile for ${email}...`);
      
      const profileData = {
        data: {
          type: 'profile',
          attributes: {
            email,
            first_name: firstName,
            last_name: lastName,
            phone_number: phone,
            properties: {
              'Back in Stock Subscriber': true,
              'Profile Created for Notification': new Date().toISOString()
            }
          }
        }
      };

      const createProfileResponse = await fetch('https://a.klaviyo.com/api/profiles/', {
        method: 'POST',
        headers: {
          'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
          'Content-Type': 'application/json',
          'revision': '2024-10-15'
        },
        body: JSON.stringify(profileData)
      });

      if (createProfileResponse.ok) {
        const createProfileResult = await createProfileResponse.json();
        profileId = createProfileResult.data.id;
        console.log(`✅ Created new profile: ${profileId} for ${email}`);
      } else {
        const errorText = await createProfileResponse.text();
        console.error(`❌ Failed to create profile for ${email}:`, errorText);
        return false;
      }
    }

    // STEP 3: Add profile to list using profile ID
    if (profileId) {
      const addToListData = {
        data: [{
          type: 'profile',
          id: profileId
        }]
      };

      const listResponse = await fetch(`https://a.klaviyo.com/api/lists/${BACK_IN_STOCK_LIST_ID}/relationships/profiles/`, {
        method: 'POST',
        headers: {
          'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
          'Content-Type': 'application/json',
          'revision': '2024-10-15'
        },
        body: JSON.stringify(addToListData)
      });

      if (listResponse.ok || listResponse.status === 204) {
        console.log(`✅ Ensured ${email} is in back-in-stock list`);
        return true;
      } else {
        const errorText = await listResponse.text();
        console.log(`⚠️ List add response for ${email}: ${listResponse.status} - ${errorText}`);
        return true; // Might already be in list
      }
    }

    return false;
  } catch (error) {
    console.error(`❌ Failed to ensure ${email} in list:`, error);
    return false;
  }
}

// === Simplified Klaviyo Event Sender with Direct List Addition ===
async function sendKlaviyoBackInStockEvent(email, productName, productUrl, firstName = '', lastName = '', phone = '') {
  if (!KLAVIYO_API_KEY) {
    console.error('❌ KLAVIYO_API_KEY not set - skipping notification');
    return false;
  }

  const BACK_IN_STOCK_LIST_ID = process.env.KLAVIYO_BACK_IN_STOCK_LIST_ID || 'WG9GbK';

  try {
    console.log(`🔔 Sending back-in-stock notification to ${email}...`);

    // STEP 1: Ensure profile is in list using simple method
    await ensureProfileInList(email, firstName, lastName, phone, BACK_IN_STOCK_LIST_ID);

    // STEP 2: Send the back-in-stock event
    const eventData = {
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
              attributes: { 
                email,
                first_name: firstName,
                last_name: lastName
              } 
            } 
          }
        }
      }
    };

    const response = await fetch('https://a.klaviyo.com/api/events/', {
      method: 'POST',
      headers: {
        'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        'Content-Type': 'application/json',
        'revision': '2024-10-15'
      },
      body: JSON.stringify(eventData)
    });

    if (response.ok) {
      console.log(`✅ Back-in-stock notification sent to ${email}`);
      return true;
    } else {
      const errorText = await response.text();
      console.error(`❌ Back-in-stock event failed (${response.status}):`, errorText);
      return false;
    }

  } catch (error) {
    console.error(`❌ Failed to send notification to ${email}:`, error);
    return false;
  }
}

// Simplified: Ensure profile is in list using direct method
async function ensureProfileInList(email, firstName, lastName, phone, listId) {
  try {
    console.log(`📋 Ensuring ${email} is in list using working method...`);

    // Use the same working method as the subscription API
    let profileId = await createOrGetProfileForNotification(email, firstName, lastName, phone);
    
    if (profileId) {
      console.log(`📋 Adding profile ${profileId} to list ${listId}...`);
      
      const addToListData = {
        data: [{
          type: 'profile',
          id: profileId
        }]
      };

      const listResponse = await fetch(`https://a.klaviyo.com/api/lists/${listId}/relationships/profiles/`, {
        method: 'POST',
        headers: {
          'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
          'Content-Type': 'application/json',
          'revision': '2024-10-15'
        },
        body: JSON.stringify(addToListData)
      });

      if (listResponse.ok || listResponse.status === 204) {
        console.log(`✅ Ensured ${email} is in list successfully`);
      } else {
        console.log(`⚠️ List ensure response for ${email}: ${listResponse.status}`);
      }
    }

  } catch (error) {
    console.log(`⚠️ Error ensuring ${email} in list:`, error.message);
    // Don't fail the notification - continue anyway
  }
}

// Create profile for back-in-stock notifications
async function createOrGetProfileForNotification(email, firstName, lastName, phone) {
  try {
    // Format phone number with same logic as subscription API
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

    // Try to create profile (without phone to avoid validation issues)
    const profileData = {
      data: {
        type: 'profile',
        attributes: {
          email,
          first_name: firstName || '',
          last_name: lastName || '',
          properties: {
            'Back in Stock Subscriber': true,
            'Phone Number': formattedPhone || '',
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
          if (sub && !sub.notified) {
            // Enhanced notification with Subscribe Profiles method
            const success = await sendKlaviyoBackInStockEvent(
              sub.email, 
              bundle.title, 
              productUrl,
              sub.first_name || '',
              sub.last_name || '',
              sub.phone || ''
            );
            
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
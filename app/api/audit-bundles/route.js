// app/api/audit-bundles/route.js - COMPLETE with US phone number support
import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_KEY;
const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;

// === RATE LIMITING ===
let lastApiCall = 0;
const MIN_DELAY_MS = 600;

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

// === Shopify Helper with Rate Limiting ===
async function fetchFromShopify(endpoint, method = 'GET', body = null) {
  if (!endpoint || typeof endpoint !== 'string') {
    throw new Error(`fetchFromShopify called with invalid endpoint: "${endpoint}"`);
  }
  
  await rateLimitedDelay();
  console.log('🔍 Shopify API fetch:', endpoint);
  
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
    if (res.status === 429) {
      console.log('⚠️ Rate limited! Waiting 2 seconds and retrying...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      lastApiCall = Date.now();
      
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

// === FIXED: Phone formatting for US/Canadian numbers ===
function formatPhoneNumberUS(phone) {
  if (!phone) return null;
  
  // Remove all non-digit characters
  let cleanPhone = phone.replace(/\D/g, '');
  
  // Handle US/Canadian numbers (prioritize these)
  if (cleanPhone.length === 10) {
    // 10-digit number - assume US/Canadian
    return '+1' + cleanPhone;
  } else if (cleanPhone.length === 11 && cleanPhone.startsWith('1')) {
    // 11-digit number starting with 1 - US/Canadian with country code
    return '+' + cleanPhone;
  } else if (cleanPhone.startsWith('1') && cleanPhone.length === 11) {
    // Explicitly US/Canadian
    return '+' + cleanPhone;
  }
  
  // For any other case, default to US format
  else if (cleanPhone.length >= 10) {
    // Take last 10 digits and add +1
    const last10 = cleanPhone.slice(-10);
    return '+1' + last10;
  }
  
  // Fallback - add +1 prefix
  return '+1' + cleanPhone;
}

// === Add to ALERT LIST (when item is back in stock) ===
async function addToAlertListProperly(subscriber, productName, productUrl, alertListId) {
  try {
    console.log(`📋 Adding ${subscriber.email} to ALERT LIST ${alertListId} properly...`);
    console.log(`📱 SMS Consent: ${subscriber.sms_consent}, Phone: ${subscriber.phone || 'none'}`);

    // Step 1: Create or get profile for alert
    const profileId = await createOrGetAlertProfile(subscriber, productName, productUrl);
    
    if (!profileId) {
      console.error('❌ Could not create/get alert profile');
      return false;
    }
    
    console.log(`✅ Got alert profile ID: ${profileId}`);

    // Step 2: Add profile to alert list
    const addToListData = {
      data: [{
        type: 'profile',
        id: profileId
      }]
    };

    const listResponse = await fetch(`https://a.klaviyo.com/api/lists/${alertListId}/relationships/profiles/`, {
      method: 'POST',
      headers: {
        'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        'Content-Type': 'application/json',
        'revision': '2024-10-15'
      },
      body: JSON.stringify(addToListData)
    });

    console.log(`📥 Alert list addition response status: ${listResponse.status}`);

    if (listResponse.ok || listResponse.status === 204) {
      console.log(`✅ Successfully added ${subscriber.email} to ALERT LIST - flow should trigger!`);
      
      // Update phone if needed
      if (subscriber.phone && subscriber.sms_consent) {
        await updateAlertProfileWithPhone(profileId, subscriber.phone);
      }
      
      return true;
    } else {
      const errorText = await listResponse.text();
      console.error(`❌ Failed to add to alert list (${listResponse.status}):`, errorText);
      return false;
    }
    
  } catch (error) {
    console.error('❌ Alert list error:', error);
    return false;
  }
}

// Create or get profile for alert notifications
async function createOrGetAlertProfile(subscriber, productName, productUrl) {
  try {
    const profileData = {
      data: {
        type: 'profile',
        attributes: {
          email: subscriber.email,
          first_name: subscriber.first_name || '',
          last_name: subscriber.last_name || '',
          properties: {
            'Back in Stock Item': productName,
            'Back in Stock URL': productUrl,
            'Alert Date': new Date().toISOString(),
            'Original Waitlist Date': subscriber.subscribed_at,
            'SMS Consent': subscriber.sms_consent || false,
            'Product ID': subscriber.product_id,
            'Alert Trigger': 'Inventory Back in Stock'
          }
        }
      }
    };

    console.log(`📝 Creating alert profile for ${subscriber.email}...`);

    const profileResponse = await fetch('https://a.klaviyo.com/api/profiles/', {
      method: 'POST',
      headers: {
        'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        'Content-Type': 'application/json',
        'revision': '2024-10-15'
      },
      body: JSON.stringify(profileData)
    });

    console.log(`📥 Alert profile response status: ${profileResponse.status}`);

    if (profileResponse.ok) {
      const result = await profileResponse.json();
      console.log(`✅ Alert profile created with ID ${result.data.id}`);
      return result.data.id;
    } else if (profileResponse.status === 409) {
      // Profile exists, get it
      console.log(`ℹ️ Profile exists, getting ID for alert...`);
      
      const getProfileResponse = await fetch(`https://a.klaviyo.com/api/profiles/?filter=equals(email,"${subscriber.email}")`, {
        headers: {
          'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
          'revision': '2024-10-15'
        }
      });

      if (getProfileResponse.ok) {
        const result = await getProfileResponse.json();
        if (result.data && result.data.length > 0) {
          const profileId = result.data[0].id;
          console.log(`✅ Found existing profile ID ${profileId} for alert`);
          return profileId;
        }
      }
    } else {
      const errorText = await profileResponse.text();
      console.error(`❌ Alert profile creation failed (${profileResponse.status}):`, errorText);
    }
    
    return null;
  } catch (error) {
    console.error('❌ Alert profile creation error:', error);
    return null;
  }
}

// Update alert profile with phone number
async function updateAlertProfileWithPhone(profileId, phone) {
  try {
    console.log(`📱 Updating alert profile ${profileId} with phone ${phone}...`);
    
    const updateData = {
      data: {
        type: 'profile',
        id: profileId,
        attributes: {
          phone_number: phone,
          properties: {
            'SMS Phone Number': phone,
            'Alert SMS Updated': new Date().toISOString()
          }
        }
      }
    };

    const response = await fetch(`https://a.klaviyo.com/api/profiles/${profileId}/`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        'Content-Type': 'application/json',
        'revision': '2024-10-15'
      },
      body: JSON.stringify(updateData)
    });

    if (response.ok) {
      console.log(`✅ Updated alert profile ${profileId} with phone number`);
    } else {
      const errorText = await response.text();
      console.log(`⚠️ Alert phone update warning (${response.status}):`, errorText);
    }
  } catch (error) {
    console.error('❌ Alert phone update error:', error);
  }
}

// === MAIN Audit Script with US Phone Support ===
async function auditBundles() {
  console.log('🔍 Starting bundle audit process with US phone support and two-list SMS...');
  
  const startTime = Date.now();
  const bundles = await getProductsTaggedBundle();
  console.log(`📦 Found ${bundles.length} bundles to audit`);
  
  let notificationsSent = 0;
  let notificationErrors = 0;
  let smsNotificationsSent = 0;
  let bundlesProcessed = 0;
  let apiCallsCount = 1;

  for (const bundle of bundles) {
    try {
      console.log(`\n📦 Processing bundle ${bundlesProcessed + 1}/${bundles.length}: ${bundle.title}`);
      bundlesProcessed++;
      
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

      const prevStatusObj = await getBundleStatus(bundle.id);
      const prevStatus = prevStatusObj ? prevStatusObj.current : null;
      await setBundleStatus(bundle.id, prevStatus, status);

      console.log(`📊 ${bundle.title} → ${prevStatus || 'unknown'} → ${status}`);

      // === NOTIFY SUBSCRIBERS IF BUNDLE NOW "ok" - USES ALERT LIST ===
      if (
        (prevStatus === 'understocked' || prevStatus === 'out-of-stock') &&
        status === 'ok'
      ) {
        console.log(`🔔 Bundle ${bundle.title} is back in stock! Processing subscribers with US phone support...`);
        
        const subs = await getSubscribers(bundle.id);
        console.log(`📧 Found ${subs.length} subscribers for ${bundle.title}`);
        
        const BACK_IN_STOCK_ALERT_LIST_ID = process.env.KLAVIYO_BACK_IN_STOCK_ALERT_LIST_ID || 'Tnz7TZ';
        
        let subscribersBatchCount = 0;
        
        for (let sub of subs) {
          if (sub && !sub.notified) {
            subscribersBatchCount++;
            console.log(`📋 Processing subscriber ${subscribersBatchCount}/${subs.filter(s => s && !s.notified).length}: ${sub.email}`);
            
            // Format phone number for US if needed
            if (sub.phone && !sub.phone.startsWith('+')) {
              sub.phone = formatPhoneNumberUS(sub.phone);
              console.log(`📱 Reformatted phone to: ${sub.phone}`);
            }
            
            // Use proper method to add to ALERT LIST
            const success = await addToAlertListProperly(
              sub,
              bundle.title,
              `https://${SHOPIFY_STORE.replace('.myshopify.com', '')}.com/products/${bundle.handle}`,
              BACK_IN_STOCK_ALERT_LIST_ID
            );
            
            if (success) {
              sub.notified = true;
              notificationsSent++;
              
              if (sub.sms_consent && sub.phone) {
                smsNotificationsSent++;
                console.log(`✅ Added ${sub.email} to ALERT LIST - back-in-stock flow should trigger (SMS enabled to ${sub.phone})!`);
              } else {
                console.log(`✅ Added ${sub.email} to ALERT LIST - back-in-stock flow should trigger (email only)!`);
              }
            } else {
              notificationErrors++;
              console.log(`❌ Failed to add ${sub.email} to alert list`);
            }
            
            if (subscribersBatchCount % 5 === 0) {
              console.log(`⏱️ Processed ${subscribersBatchCount} notifications, brief pause...`);
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
        }
        
        await setSubscribers(bundle.id, subs);
        console.log(`📊 Notification summary for ${bundle.title}: ${notificationsSent} sent, ${smsNotificationsSent} SMS-enabled`);
      }

      await updateProductTags(bundle.id, bundle.tags.split(','), status);
      apiCallsCount++;

      const elapsed = (Date.now() - startTime) / 1000;
      const avgTimePerBundle = elapsed / bundlesProcessed;
      const estimatedTimeLeft = (bundles.length - bundlesProcessed) * avgTimePerBundle;
      
      console.log(`⏱️ Progress: ${bundlesProcessed}/${bundles.length} bundles (${Math.round(elapsed)}s elapsed, ~${Math.round(estimatedTimeLeft)}s remaining)`);
      console.log(`📊 API calls made: ${apiCallsCount} (rate: ${(apiCallsCount / elapsed).toFixed(2)}/sec)`);

    } catch (error) {
      console.error(`❌ Error processing bundle ${bundle.title}:`, error);
    }
  }

  const totalTime = (Date.now() - startTime) / 1000;
  
  console.log(`\n✅ US Phone Audit complete with proper two-list system!`);
  console.log(`📦 Bundles processed: ${bundlesProcessed}`);
  console.log(`📧 Email notifications sent: ${notificationsSent}`);
  console.log(`📱 SMS notifications sent: ${smsNotificationsSent}`);
  console.log(`❌ Notification errors: ${notificationErrors}`);
  console.log(`⏱️ Total time: ${Math.round(totalTime)}s`);
  console.log(`📊 Total API calls: ${apiCallsCount} (avg rate: ${(apiCallsCount / totalTime).toFixed(2)}/sec)`);
  
  return { 
    bundlesProcessed, 
    emailNotificationsSent: notificationsSent,
    smsNotificationsSent,
    notificationErrors,
    totalTimeSeconds: totalTime,
    apiCallsCount,
    avgApiCallRate: apiCallsCount / totalTime,
    timestamp: new Date().toISOString(),
    system: 'US Phone Two-List (Waitlist + Alert List)'
  };
}

export async function GET() {
  try {
    console.log('🚀 Starting US phone bundle audit with proper two-list SMS support...');
    const results = await auditBundles();
    
    return NextResponse.json({ 
      success: true, 
      message: 'US Phone Audit complete - proper Klaviyo integration with waitlist and alert lists.',
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
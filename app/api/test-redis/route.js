// app/api/test-notifications/route.js - Test back-in-stock notifications without touching inventory
import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;

// === Copy the EXACT same functions from your working back-in-stock API ===
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
            'Profile Ensured for Notification': new Date().toISOString(),
            'Test Notification': true // Mark as test
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
    console.log(`📋 [TEST] Adding ${email} to back-in-stock alert list for ${productName}...`);

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
        console.log(`✅ [TEST] Added ${email} to back-in-stock alert list for ${productName}`);
        return true;
      } else {
        const errorText = await response.text();
        console.error(`❌ [TEST] Failed to add ${email} to alert list:`, errorText);
        return false;
      }
    } else {
      console.error(`❌ [TEST] Could not create/get profile for ${email}`);
      return false;
    }
    
  } catch (error) {
    console.error(`❌ [TEST] Alert list error for ${email}:`, error);
    return false;
  }
}

// === TEST FUNCTION ===
async function testNotifications(productId, testEmail) {
  console.log(`🧪 Starting notification test for product ${productId}...`);
  
  let results = {
    success: false,
    steps: [],
    notificationsSent: 0,
    notificationErrors: 0,
    subscribers: []
  };

  try {
    // Step 1: Check if we have subscribers for this product
    results.steps.push("1. Checking Redis for subscribers...");
    const subs = await redis.get(`subscribers:${productId}`);
    
    let subscribers = [];
    if (subs) {
      if (typeof subs === 'string') {
        subscribers = JSON.parse(subs);
      } else if (Array.isArray(subs)) {
        subscribers = subs;
      }
    }

    console.log(`📊 Found ${subscribers.length} subscribers for product ${productId}`);
    results.steps.push(`   Found ${subscribers.length} subscribers`);
    results.subscribers = subscribers.map(sub => ({
      email: sub.email,
      first_name: sub.first_name || '',
      notified: sub.notified || false
    }));

    // Step 2: If no subscribers and testEmail provided, create a test subscriber
    if (subscribers.length === 0 && testEmail) {
      console.log(`📝 Creating test subscriber: ${testEmail}`);
      results.steps.push("2. Creating test subscriber...");
      
      const testSubscriber = {
        email: testEmail,
        phone: '',
        product_id: productId.toString(),
        product_title: 'Test Product Bundle',
        product_handle: 'test-product-bundle',
        first_name: 'Test',
        last_name: 'User',
        notified: false,
        subscribed_at: new Date().toISOString(),
        ip_address: 'test'
      };
      
      subscribers = [testSubscriber];
      await redis.set(`subscribers:${productId}`, subscribers, { ex: 24 * 60 * 60 }); // 24 hours
      results.steps.push("   Test subscriber created");
    }

    if (subscribers.length === 0) {
      results.steps.push("❌ No subscribers found and no test email provided");
      return results;
    }

    // Step 3: Test the notification process
    results.steps.push("3. Testing notification process...");
    const BACK_IN_STOCK_ALERT_LIST_ID = process.env.KLAVIYO_BACK_IN_STOCK_ALERT_LIST_ID || 'Tnz7TZ';
    
    for (let sub of subscribers) {
      if (sub && !sub.notified) {
        console.log(`🧪 Testing notification for: ${sub.email}`);
        results.steps.push(`   Testing notification for ${sub.email}...`);
        
        const success = await addToBackInStockAlertList(
          sub.email,
          sub.first_name || '',
          sub.last_name || '',
          sub.phone || '',
          sub.product_title || 'Test Bundle',
          `https://${SHOPIFY_STORE.replace('.myshopify.com', '')}.com/products/${sub.product_handle || 'test-bundle'}`,
          BACK_IN_STOCK_ALERT_LIST_ID
        );
        
        if (success) {
          sub.notified = true;
          results.notificationsSent++;
          results.steps.push(`   ✅ Success for ${sub.email}`);
        } else {
          results.notificationErrors++;
          results.steps.push(`   ❌ Failed for ${sub.email}`);
        }
      } else if (sub && sub.notified) {
        results.steps.push(`   ⏭️ ${sub.email} already notified, skipping`);
      }
    }

    // Step 4: Update Redis (mark as notified)
    results.steps.push("4. Updating subscriber status...");
    await redis.set(`subscribers:${productId}`, subscribers, { ex: 24 * 60 * 60 });
    results.steps.push("   ✅ Subscriber status updated");

    results.success = true;
    results.steps.push("🎉 Test completed successfully!");

  } catch (error) {
    console.error('❌ Test error:', error);
    results.steps.push(`❌ Error: ${error.message}`);
  }

  return results;
}

// === API ENDPOINTS ===
export async function POST(request) {
  try {
    const body = await request.json();
    const { product_id, test_email } = body;

    if (!product_id) {
      return NextResponse.json({
        success: false,
        error: 'product_id is required'
      }, { status: 400 });
    }

    console.log(`🧪 Running notification test for product ${product_id}${test_email ? ` with test email ${test_email}` : ''}`);

    const results = await testNotifications(product_id, test_email);

    return NextResponse.json({
      success: results.success,
      message: 'Notification test completed',
      ...results,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Test API error:', error);
    return NextResponse.json({
      success: false,
      error: error.message
    }, { status: 500 });
  }
}

// Get current subscribers for a product (for debugging)
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const product_id = searchParams.get('product_id');

    if (!product_id) {
      return NextResponse.json({
        success: false,
        error: 'product_id parameter is required'
      }, { status: 400 });
    }

    const subs = await redis.get(`subscribers:${product_id}`);
    let subscribers = [];
    
    if (subs) {
      if (typeof subs === 'string') {
        subscribers = JSON.parse(subs);
      } else if (Array.isArray(subs)) {
        subscribers = subs;
      }
    }

    return NextResponse.json({
      success: true,
      product_id,
      subscriber_count: subscribers.length,
      subscribers: subscribers.map(sub => ({
        email: sub.email,
        first_name: sub.first_name || '',
        last_name: sub.last_name || '',
        notified: sub.notified || false,
        subscribed_at: sub.subscribed_at
      }))
    });

  } catch (error) {
    console.error('❌ GET error:', error);
    return NextResponse.json({
      success: false,
      error: error.message
    }, { status: 500 });
  }
}
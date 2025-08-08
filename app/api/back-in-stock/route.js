// app/api/back-in-stock/route.js - Production-ready subscription handler with DIRECT LIST ADDITION
import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
  retry: {
    retries: 3,
    retryDelayOnFailover: 100,
  }
});

const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
const BACK_IN_STOCK_LIST_ID = process.env.KLAVIYO_BACK_IN_STOCK_LIST_ID || 'WG9GbK';

// Handle CORS preflight requests
export async function OPTIONS(request) {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

// Handle subscription requests (form submissions)
export async function POST(request) {
  try {
    const body = await request.json();
    const { email, phone, product_id, product_title, product_handle, first_name, last_name } = body;
    
    console.log('🚀 Processing back-in-stock subscription:', { 
      email, 
      product_id, 
      product_title,
      has_phone: !!phone,
      timestamp: new Date().toISOString()
    });
    
    // Validation
    if (!email || !product_id) {
      console.error('❌ Missing required fields:', { email: !!email, product_id: !!product_id });
      return NextResponse.json({ 
        success: false, 
        error: 'Missing required fields: email and product_id' 
      }, { 
        status: 400,
        headers: { 'Access-Control-Allow-Origin': '*' }
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      console.error('❌ Invalid email format:', email);
      return NextResponse.json({ 
        success: false, 
        error: 'Invalid email format' 
      }, { 
        status: 400,
        headers: { 'Access-Control-Allow-Origin': '*' }
      });
    }

    // Test Redis connection
    try {
      await redis.ping();
      console.log('✅ Redis connection successful');
    } catch (redisTestError) {
      console.error('❌ Redis connection failed:', redisTestError);
      return NextResponse.json({
        success: false,
        error: 'Database connection failed. Please try again.',
      }, { 
        status: 500,
        headers: { 'Access-Control-Allow-Origin': '*' }
      });
    }

    // Get existing subscribers
    const key = `subscribers:${product_id}`;
    let subscribers = [];
    
    try {
      const existingSubscribers = await redis.get(key);
      if (existingSubscribers) {
        if (typeof existingSubscribers === 'string') {
          subscribers = JSON.parse(existingSubscribers);
        } else if (Array.isArray(existingSubscribers)) {
          subscribers = existingSubscribers;
        }
      }
    } catch (getError) {
      console.log('⚠️ Error getting subscribers, starting fresh:', getError);
      subscribers = [];
    }
    
    console.log(`📊 Current subscribers for product ${product_id}: ${subscribers.length}`);
    
    // Check if user is already subscribed
    const existingSubscriber = subscribers.find(sub => sub && sub.email === email);
    
    if (existingSubscriber) {
      console.log(`ℹ️ User ${email} already subscribed to product ${product_id}`);
      return NextResponse.json({ 
        success: true, 
        message: 'You are already subscribed to notifications for this product',
        alreadySubscribed: true,
        subscriber_count: subscribers.length
      }, {
        headers: { 'Access-Control-Allow-Origin': '*' }
      });
    }

    // Create new subscriber object
    const newSubscriber = {
      email: email,
      phone: phone || '',
      product_id: product_id.toString(),
      product_title: product_title || 'Unknown Product',
      product_handle: product_handle || '',
      first_name: first_name || '',
      last_name: last_name || '',
      notified: false,
      subscribed_at: new Date().toISOString(),
      ip_address: request.headers.get('x-forwarded-for') || 
                  request.headers.get('x-real-ip') || 'unknown'
    };

    // Add to subscribers list
    subscribers.push(newSubscriber);
    
    // Save to Redis
    try {
      await redis.set(key, subscribers, { ex: 30 * 24 * 60 * 60 }); // 30 days expiry
      console.log(`✅ Saved ${subscribers.length} subscribers to Redis for product ${product_id}`);
    } catch (setError) {
      console.error('❌ Error saving to Redis:', setError);
      return NextResponse.json({
        success: false,
        error: 'Failed to save subscription. Please try again.',
      }, { 
        status: 500,
        headers: { 'Access-Control-Allow-Origin': '*' }
      });
    }

    // Add to Klaviyo (non-blocking - don't fail if this fails)
    let klaviyoSuccess = false;
    try {
      klaviyoSuccess = await subscribeToKlaviyoList(newSubscriber);
      if (klaviyoSuccess) {
        console.log(`✅ Successfully added ${email} to Klaviyo list`);
      } else {
        console.log(`⚠️ Klaviyo subscription failed for ${email}, but Redis subscription successful`);
      }
    } catch (klaviyoError) {
      console.error('⚠️ Klaviyo error (non-fatal):', klaviyoError.message);
    }

    return NextResponse.json({ 
      success: true,
      message: 'Successfully subscribed to back-in-stock notifications',
      subscriber_count: subscribers.length,
      klaviyo_success: klaviyoSuccess
    }, {
      headers: { 'Access-Control-Allow-Origin': '*' }
    });

  } catch (error) {
    console.error('❌ Back-in-stock subscription error:', error);
    return NextResponse.json({ 
      success: false, 
      error: 'Server error. Please try again.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    }, { 
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*' }
    });
  }
}

// Handle subscription status checks
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const email = searchParams.get('email');
    const product_id = searchParams.get('product_id');

    if (!email || !product_id) {
      return NextResponse.json({ 
        success: false, 
        error: 'Missing email or product_id parameters' 
      }, { 
        status: 400,
        headers: { 'Access-Control-Allow-Origin': '*' }
      });
    }

    await redis.ping();
    
    const key = `subscribers:${product_id}`;
    let subscribers = await redis.get(key) || [];
    
    if (typeof subscribers === 'string') {
      try {
        subscribers = JSON.parse(subscribers);
      } catch {
        subscribers = [];
      }
    }
    if (!Array.isArray(subscribers)) {
      subscribers = [];
    }
    
    const subscription = subscribers.find(sub => sub && sub.email === email);
    const isSubscribed = !!subscription;

    return NextResponse.json({ 
      success: true,
      subscribed: isSubscribed,
      total_subscribers: subscribers.length,
      subscription_details: subscription ? {
        subscribed_at: subscription.subscribed_at,
        notified: subscription.notified
      } : null
    }, {
      headers: { 'Access-Control-Allow-Origin': '*' }
    });

  } catch (error) {
    console.error('❌ GET request error:', error);
    return NextResponse.json({ 
      success: false, 
      error: error.message 
    }, { 
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*' }
    });
  }
}

// DIRECT LIST ADDITION - This should work with your full access API key
async function subscribeToKlaviyoList(subscriber) {
  if (!KLAVIYO_API_KEY) {
    console.log('❌ No KLAVIYO_API_KEY found in environment variables');
    return false;
  }

  console.log('🔍 Debug Info:');
  console.log('- Klaviyo API Key exists:', !!KLAVIYO_API_KEY);
  console.log('- List ID:', BACK_IN_STOCK_LIST_ID);
  console.log('- Subscriber email:', subscriber.email);
  
  try {
    console.log(`📋 Adding ${subscriber.email} DIRECTLY to list ${BACK_IN_STOCK_LIST_ID}...`);

    // Format phone number properly for international numbers
    let formattedPhone = null;
    if (subscriber.phone && subscriber.phone.length > 0) {
      formattedPhone = subscriber.phone.trim();
      
      // Handle Nigerian numbers specifically
      if (formattedPhone.startsWith('090') || formattedPhone.startsWith('080') || 
          formattedPhone.startsWith('070') || formattedPhone.startsWith('081') || 
          formattedPhone.startsWith('091')) {
        // Nigerian number - add +234 and remove leading 0
        formattedPhone = '+234' + formattedPhone.substring(1);
      } else if (!formattedPhone.startsWith('+')) {
        // Default to US format for other numbers
        formattedPhone = '+1' + formattedPhone.replace(/\D/g, '');
      }
      
      console.log(`📱 Phone formatted as: ${formattedPhone}`);
    }

    // SKIP METHOD 1 - The 405 error shows this endpoint doesn't work
    // Go directly to Method 2: Create profile first, then add to list
    console.log('📋 Using Method 2: Create profile first, then add to list...');
    return await alternativeListAddition(subscriber, BACK_IN_STOCK_LIST_ID);

  } catch (error) {
    console.error('❌ Method 1 Network Error:', error.message);
    console.log('🔄 Trying Method 2: Create profile first, then add to list...');
    return await alternativeListAddition(subscriber, BACK_IN_STOCK_LIST_ID);
  }
}

// Alternative method: Add using relationships endpoint
async function alternativeListAddition(subscriber, listId) {
  try {
    console.log(`🔄 Method 2: Creating profile first for ${subscriber.email}...`);
    
    // First create/get the profile
    let profileId = await createOrGetProfile(subscriber);
    
    if (profileId) {
      console.log(`📋 Method 2: Adding profile ${profileId} to list...`);
      
      // Then add to list using relationships
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

      console.log('📥 Method 2 list response status:', listResponse.status);

      if (listResponse.ok || listResponse.status === 204) {
        console.log(`✅ Method 2 SUCCESS: Added ${subscriber.email} to list!`);
        return true;
      } else {
        const errorText = await listResponse.text();
        console.error(`❌ Method 2 list addition failed:`, errorText);
        return false;
      }
    } else {
      console.error(`❌ Method 2: Could not create/find profile for ${subscriber.email}`);
      return false;
    }
    
  } catch (error) {
    console.error('❌ Method 2 error:', error);
    return false;
  }
}

// Create or get profile ID - FIXED for phone number issues
async function createOrGetProfile(subscriber) {
  try {
    // Format phone number with better international support
    let formattedPhone = null;
    if (subscriber.phone && subscriber.phone.length > 0) {
      formattedPhone = subscriber.phone.trim();
      
      // Handle Nigerian numbers specifically  
      if (formattedPhone.startsWith('090') || formattedPhone.startsWith('080') || 
          formattedPhone.startsWith('070') || formattedPhone.startsWith('081') || 
          formattedPhone.startsWith('091')) {
        // Nigerian number - add +234 and remove leading 0
        formattedPhone = '+234' + formattedPhone.substring(1);
      } else if (!formattedPhone.startsWith('+')) {
        // Default to US format for other numbers
        formattedPhone = '+1' + formattedPhone.replace(/\D/g, '');
      }
    }

    // Try creating profile WITHOUT phone first (to avoid SMS validation issues)
    const profileData = {
      data: {
        type: 'profile',
        attributes: {
          email: subscriber.email,
          first_name: subscriber.first_name || '',
          last_name: subscriber.last_name || '',
          // Skip phone_number initially to avoid validation issues
          properties: {
            'Back in Stock Subscriber': true,
            'Subscription Source': 'Bundle Notifications',
            'Product Subscribed': subscriber.product_title,
            'Phone Number': formattedPhone || '' // Store as property instead
          }
        }
      }
    };

    console.log(`📝 Creating profile for ${subscriber.email} (without phone in main field)...`);

    const profileResponse = await fetch('https://a.klaviyo.com/api/profiles/', {
      method: 'POST',
      headers: {
        'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        'Content-Type': 'application/json',
        'revision': '2024-10-15'
      },
      body: JSON.stringify(profileData)
    });

    console.log(`📥 Profile creation response status: ${profileResponse.status}`);

    if (profileResponse.ok) {
      const result = await profileResponse.json();
      console.log(`✅ Profile created with ID ${result.data.id}`);
      return result.data.id;
    } else if (profileResponse.status === 409) {
      // Profile exists, get the ID
      console.log(`ℹ️ Profile exists, getting ID for ${subscriber.email}...`);
      
      const getProfileResponse = await fetch(`https://a.klaviyo.com/api/profiles/?filter=equals(email,"${subscriber.email}")`, {
        headers: {
          'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
          'revision': '2024-10-15'
        }
      });

      if (getProfileResponse.ok) {
        const result = await getProfileResponse.json();
        if (result.data && result.data.length > 0) {
          console.log(`✅ Found existing profile ID ${result.data[0].id}`);
          return result.data[0].id;
        }
      }
    } else {
      const errorText = await profileResponse.text();
      console.error(`❌ Profile creation failed (${profileResponse.status}):`, errorText);
    }
    
    return null;
  } catch (error) {
    console.error('❌ Profile creation error:', error);
    return null;
  }
}

// Send subscription confirmation event
async function sendSubscriptionEvent(subscriber) {
  try {
    const eventData = {
      data: {
        type: 'event',
        attributes: {
          properties: {
            ProductName: subscriber.product_title,
            ProductID: subscriber.product_id,
            ProductHandle: subscriber.product_handle,
            SubscriptionDate: subscriber.subscribed_at,
            NotificationType: 'Subscription Confirmation',
            Method: 'Direct List Addition'
          },
          metric: { 
            data: { 
              type: 'metric', 
              attributes: { name: 'Back in Stock Subscription' } 
            } 
          },
          profile: { 
            data: { 
              type: 'profile', 
              attributes: { 
                email: subscriber.email,
                first_name: subscriber.first_name,
                last_name: subscriber.last_name
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
      console.log(`📧 Subscription event sent for ${subscriber.email}`);
    } else {
      const errorText = await response.text();
      console.log(`⚠️ Event send warning (${response.status}):`, errorText);
    }
  } catch (error) {
    console.error('❌ Event send error:', error);
  }
}
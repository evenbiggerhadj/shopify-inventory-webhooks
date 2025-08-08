// app/api/back-in-stock/route.js - Main subscription handler
import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

// Use YOUR actual environment variable names
const redis = new Redis({
  url: process.env.KV_REST_API_URL,           // Using KV_REST_API_URL
  token: process.env.KV_REST_API_TOKEN,       // Using KV_REST_API_TOKEN
  retry: {
    retries: 3,
    retryDelayOnFailover: 100,
  }
});

const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;

// Handle CORS preflight requests
export async function OPTIONS(request) {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

// Handle subscription requests (form submissions)
export async function POST(request) {
  try {
    const body = await request.json();
    const { email, phone, product_id, product_title, product_handle, first_name, last_name } = body;
    
    console.log('📧 Processing back-in-stock subscription:', { 
      email, 
      product_id, 
      product_title,
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

    // Test Redis connection first
    try {
      console.log('🔍 Testing Redis connection...');
      await redis.ping();
      console.log('✅ Redis connection successful');
    } catch (redisTestError) {
      console.error('❌ Redis connection test failed:', redisTestError);
      return NextResponse.json({
        success: false,
        error: 'Database connection failed. Please try again.',
        details: redisTestError.message
      }, { 
        status: 500,
        headers: { 'Access-Control-Allow-Origin': '*' }
      });
    }

    try {
      const key = `subscribers:${product_id}`;
      console.log(`📊 Getting subscribers for key: ${key}`);
      
      // Get existing subscribers with error handling
      let subscribers;
      try {
        subscribers = await redis.get(key);
        // Handle different possible return types
        if (!subscribers) {
          subscribers = [];
        } else if (typeof subscribers === 'string') {
          // If Redis returns string, try to parse it
          try {
            subscribers = JSON.parse(subscribers);
          } catch (parseError) {
            console.log('⚠️ Could not parse subscribers, starting fresh:', parseError);
            subscribers = [];
          }
        } else if (!Array.isArray(subscribers)) {
          // If it's not an array, start fresh
          console.log('⚠️ Subscribers not in array format, starting fresh');
          subscribers = [];
        }
      } catch (getError) {
        console.log('⚠️ Error getting subscribers, starting fresh:', getError);
        subscribers = [];
      }
      
      console.log(`📊 Current subscribers for product ${product_id}:`, subscribers.length);
      
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

      // Add new subscriber
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

      subscribers.push(newSubscriber);
      
      // Save to Redis with error handling
      try {
        await redis.set(key, subscribers, { ex: 30 * 24 * 60 * 60 }); // 30 days expiry
        console.log(`✅ Saved ${subscribers.length} subscribers to Redis for product ${product_id}`);
      } catch (setError) {
        console.error('❌ Error saving to Redis:', setError);
        return NextResponse.json({
          success: false,
          error: 'Failed to save subscription. Please try again.',
          details: setError.message
        }, { 
          status: 500,
          headers: { 'Access-Control-Allow-Origin': '*' }
        });
      }

      console.log(`✅ Added subscriber ${email} for product ${product_id}. Total subscribers: ${subscribers.length}`);

      // Send confirmation email/event to Klaviyo (optional, don't fail if this fails)
      try {
        await sendSubscriptionConfirmation(newSubscriber);
        console.log(`📧 Klaviyo confirmation sent to ${email}`);
      } catch (klaviyoError) {
        console.error('⚠️ Klaviyo confirmation error (non-fatal):', klaviyoError.message);
        // Don't fail the whole request if Klaviyo fails
      }

      return NextResponse.json({ 
        success: true,
        message: 'Successfully subscribed to back-in-stock notifications',
        subscriber_count: subscribers.length
      }, {
        headers: { 'Access-Control-Allow-Origin': '*' }
      });

    } catch (redisError) {
      console.error('❌ Redis operation error:', redisError);
      return NextResponse.json({
        success: false,
        error: 'Database error. Please try again.',
        details: redisError.message
      }, { 
        status: 500,
        headers: { 'Access-Control-Allow-Origin': '*' }
      });
    }

  } catch (error) {
    console.error('❌ Back-in-stock subscription error:', error);
    return NextResponse.json({ 
      success: false, 
      error: 'Server error. Please try again.',
      details: error.message
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

    try {
      // Test Redis connection
      await redis.ping();
      
      const key = `subscribers:${product_id}`;
      let subscribers = await redis.get(key) || [];
      
      // Handle different return types
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
      console.error('❌ Check subscription error:', error);
      return NextResponse.json({
        success: false,
        error: 'Database error',
        details: error.message
      }, { 
        status: 500,
        headers: { 'Access-Control-Allow-Origin': '*' }
      });
    }

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

// Enhanced sendSubscriptionConfirmation function with list addition
async function sendSubscriptionConfirmation(subscriber) {
  if (!KLAVIYO_API_KEY) {
    console.log('ℹ️ No Klaviyo API key - skipping confirmation email');
    return;
  }

  const BACK_IN_STOCK_LIST_ID = process.env.KLAVIYO_BACK_IN_STOCK_LIST_ID || 'WG9GbK';
  
  try {
    // STEP 1: Add subscriber directly to Klaviyo list (this creates profile automatically)
    console.log(`📋 Adding ${subscriber.email} to back-in-stock list ${BACK_IN_STOCK_LIST_ID}...`);
    
    const listData = {
      data: [{
        type: 'profile',
        attributes: {
          email: subscriber.email,
          first_name: subscriber.first_name || '',
          last_name: subscriber.last_name || '',
          phone_number: subscriber.phone || '',
          properties: {
            'Back in Stock Subscriber': true,
            'Subscription Source': 'Bundle Notifications',
            'Last Subscription Date': subscriber.subscribed_at,
            'Product Subscribed': subscriber.product_title,
            'Product ID': subscriber.product_id
          }
        }
      }]
    };

    const listResponse = await fetch(`https://a.klaviyo.com/api/lists/${BACK_IN_STOCK_LIST_ID}/profiles/`, {
      method: 'POST',
      headers: {
        'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        'Content-Type': 'application/json',
        'revision': '2024-10-15'
      },
      body: JSON.stringify(listData)
    });

    if (listResponse.ok) {
      console.log(`✅ Added ${subscriber.email} to back-in-stock list`);
    } else {
      const errorText = await listResponse.text();
      console.log(`⚠️ List add response (${listResponse.status}):`, errorText);
      // Don't fail - user might already be in list
    }

    // STEP 2: Send Subscription Confirmation Event (optional)
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
            ListID: BACK_IN_STOCK_LIST_ID
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

    const eventResponse = await fetch('https://a.klaviyo.com/api/events/', {
      method: 'POST',
      headers: {
        'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        'Content-Type': 'application/json',
        'revision': '2024-10-15'
      },
      body: JSON.stringify(eventData)
    });

    if (!eventResponse.ok) {
      const errorText = await eventResponse.text();
      console.log(`⚠️ Klaviyo event warning (${eventResponse.status}):`, errorText);
      // Don't throw - list addition is more important
    } else {
      console.log(`📧 Klaviyo subscription event sent to ${subscriber.email}`);
    }

  } catch (error) {
    console.error('❌ Klaviyo confirmation error:', error);
    // Don't throw - let the subscription succeed even if Klaviyo fails
  }
}
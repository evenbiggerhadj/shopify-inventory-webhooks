// app/api/back-in-stock/route.js - Production-ready subscription handler with Subscribe Profiles
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

// PRODUCTION-READY: Subscribe to Klaviyo using Subscribe Profiles endpoint
async function subscribeToKlaviyoList(subscriber) {
  if (!KLAVIYO_API_KEY) {
    console.log('ℹ️ No Klaviyo API key configured');
    return false;
  }

  try {
    console.log(`📋 Subscribing ${subscriber.email} to Klaviyo list ${BACK_IN_STOCK_LIST_ID}...`);

    // Use Subscribe Profiles endpoint - handles consent and list membership
    const subscribeData = {
      data: {
        type: 'profile-subscription-bulk-create-job',
        attributes: {
          profiles: {
            data: [{
              type: 'profile',
              attributes: {
                email: subscriber.email,
                phone_number: subscriber.phone || null,
                first_name: subscriber.first_name || '',
                last_name: subscriber.last_name || '',
                properties: {
                  'Back in Stock Subscriber': true,
                  'Subscription Source': 'Bundle Notifications',
                  'Last Subscription Date': subscriber.subscribed_at,
                  'Product Subscribed': subscriber.product_title,
                  'Product ID': subscriber.product_id,
                  'Product Handle': subscriber.product_handle
                }
              }
            }]
          },
          subscriptions: [{
            type: 'list',
            id: BACK_IN_STOCK_LIST_ID,
            attributes: {
              email: { 
                marketing: { 
                  consent: 'subscribed',
                  consented_at: new Date().toISOString()
                } 
              }
            }
          }]
        }
      }
    };

    // Add SMS consent if phone number provided
    if (subscriber.phone) {
      subscribeData.data.attributes.subscriptions[0].attributes.sms = {
        marketing: { 
          consent: 'subscribed',
          consented_at: new Date().toISOString()
        }
      };
    }

    const response = await fetch('https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/', {
      method: 'POST',
      headers: {
        'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        'Content-Type': 'application/json',
        'revision': '2024-10-15'
      },
      body: JSON.stringify(subscribeData)
    });

    if (response.ok) {
      const result = await response.json();
      console.log(`✅ Klaviyo subscription job created: ${result.data.id}`);
      
      // Send confirmation event
      setTimeout(() => {
        sendSubscriptionEvent(subscriber).catch(err => {
          console.log('⚠️ Event send failed (non-critical):', err.message);
        });
      }, 1000); // Delay to let profile creation complete
      
      return true;
    } else {
      const errorText = await response.text();
      console.error(`❌ Klaviyo subscription failed (${response.status}):`, errorText);
      
      // Try fallback method
      return await fallbackListAddition(subscriber);
    }

  } catch (error) {
    console.error('❌ Klaviyo subscription error:', error);
    return await fallbackListAddition(subscriber);
  }
}

// Fallback: Direct list addition if subscribe fails
async function fallbackListAddition(subscriber) {
  try {
    console.log(`🔄 Using fallback list addition for ${subscriber.email}...`);
    
    const response = await fetch(`https://a.klaviyo.com/api/lists/${BACK_IN_STOCK_LIST_ID}/profiles/`, {
      method: 'POST',
      headers: {
        'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        'Content-Type': 'application/json',
        'revision': '2024-10-15'
      },
      body: JSON.stringify({
        data: [{
          type: 'profile',
          attributes: {
            email: subscriber.email,
            first_name: subscriber.first_name || '',
            last_name: subscriber.last_name || '',
            phone_number: subscriber.phone || null,
            properties: {
              'Back in Stock Subscriber': true,
              'Subscription Source': 'Bundle Notifications (Fallback)',
              'Last Subscription Date': subscriber.subscribed_at,
              'Product Subscribed': subscriber.product_title,
              'Product ID': subscriber.product_id
            }
          }
        }]
      })
    });
    
    if (response.ok) {
      console.log(`✅ Fallback: Added ${subscriber.email} to list successfully`);
      return true;
    } else {
      const errorText = await response.text();
      console.error(`❌ Fallback also failed (${response.status}):`, errorText);
      return false;
    }
  } catch (error) {
    console.error('❌ Fallback method error:', error);
    return false;
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
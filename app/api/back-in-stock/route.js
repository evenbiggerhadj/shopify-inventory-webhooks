// app/api/back-in-stock/route.js
import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const KLAVIYO_API_KEY = process.env.KLAVIYO_PRIVATE_API_KEY;

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

// Handle subscription requests
export async function POST(request) {
  try {
    const body = await request.json();
    const { email, product_id, product_title, product_handle, first_name, last_name } = body;
    
    console.log('📧 Processing back-in-stock subscription:', { email, product_id, product_title });
    
    // Validation
    if (!email || !product_id) {
      return NextResponse.json({ 
        success: false, 
        error: 'Missing required fields: email and product_id' 
      }, { 
        status: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
        }
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return NextResponse.json({ 
        success: false, 
        error: 'Invalid email format' 
      }, { 
        status: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
        }
      });
    }

    const key = `subscribers:${product_id}`;
    let subscribers = (await redis.get(key)) || [];
    
    // Check if user is already subscribed
    const existingSubscriber = subscribers.find(sub => sub.email === email);
    
    if (existingSubscriber) {
      console.log(`User ${email} already subscribed to product ${product_id}`);
      return NextResponse.json({ 
        success: true, 
        message: 'You are already subscribed to notifications for this product',
        alreadySubscribed: true
      }, {
        headers: {
          'Access-Control-Allow-Origin': '*',
        }
      });
    }

    // Add new subscriber
    const newSubscriber = {
      email,
      product_id,
      product_title: product_title || 'Unknown Product',
      product_handle: product_handle || '',
      first_name: first_name || '',
      last_name: last_name || '',
      notified: false,
      subscribed_at: new Date().toISOString(),
      ip_address: request.headers.get('x-forwarded-for') || 
                  request.headers.get('x-real-ip') || 
                  'unknown'
    };

    subscribers.push(newSubscriber);
    await redis.set(key, subscribers);

    console.log(`✅ Added subscriber ${email} for product ${product_id}. Total subscribers: ${subscribers.length}`);

    // Send confirmation email/event to Klaviyo (optional)
    try {
      await sendSubscriptionConfirmation(newSubscriber);
    } catch (klaviyoError) {
      console.error('Klaviyo confirmation error (non-fatal):', klaviyoError);
      // Don't fail the whole request if Klaviyo fails
    }

    return NextResponse.json({ 
      success: true,
      message: 'Successfully subscribed to back-in-stock notifications',
      subscriber_count: subscribers.length
    }, {
      headers: {
        'Access-Control-Allow-Origin': '*',
      }
    });

  } catch (error) {
    console.error('❌ Back-in-stock subscription error:', error);
    return NextResponse.json({ 
      success: false, 
      error: error.message 
    }, { 
      status: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
      }
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
        headers: {
          'Access-Control-Allow-Origin': '*',
        }
      });
    }

    const key = `subscribers:${product_id}`;
    const subscribers = (await redis.get(key)) || [];
    
    const subscription = subscribers.find(sub => sub.email === email);
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
      headers: {
        'Access-Control-Allow-Origin': '*',
      }
    });

  } catch (error) {
    console.error('❌ Check subscription error:', error);
    return NextResponse.json({ 
      success: false, 
      error: error.message 
    }, { 
      status: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
      }
    });
  }
}

// Handle unsubscribe requests
export async function DELETE(request) {
  try {
    const body = await request.json();
    const { email, product_id } = body;

    if (!email || !product_id) {
      return NextResponse.json({ 
        success: false, 
        error: 'Missing email or product_id' 
      }, { 
        status: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
        }
      });
    }

    const key = `subscribers:${product_id}`;
    let subscribers = (await redis.get(key)) || [];
    
    const initialCount = subscribers.length;
    subscribers = subscribers.filter(sub => sub.email !== email);
    
    if (subscribers.length === initialCount) {
      return NextResponse.json({ 
        success: false, 
        error: 'Subscription not found' 
      }, { 
        status: 404,
        headers: {
          'Access-Control-Allow-Origin': '*',
        }
      });
    }

    await redis.set(key, subscribers);

    console.log(`🗑️ Removed subscriber ${email} from product ${product_id}`);

    return NextResponse.json({ 
      success: true,
      message: 'Successfully unsubscribed',
      remaining_subscribers: subscribers.length
    }, {
      headers: {
        'Access-Control-Allow-Origin': '*',
      }
    });

  } catch (error) {
    console.error('❌ Unsubscribe error:', error);
    return NextResponse.json({ 
      success: false, 
      error: error.message 
    }, { 
      status: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
      }
    });
  }
}

// Send subscription confirmation to Klaviyo
async function sendSubscriptionConfirmation(subscriber) {
  if (!KLAVIYO_API_KEY) {
    console.log('No Klaviyo API key - skipping confirmation email');
    return;
  }

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
            NotificationType: 'Subscription Confirmation'
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
      console.log(`✅ Sent subscription confirmation to ${subscriber.email}`);
    } else {
      const errorText = await response.text();
      console.error('Klaviyo confirmation error:', response.status, errorText);
    }

  } catch (error) {
    console.error('Failed to send subscription confirmation:', error);
    throw error; // Re-throw to be caught by caller
  }
}
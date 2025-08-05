import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const KLAVIYO_API_KEY = process.env.KLAVIYO_PRIVATE_API_KEY;

export async function POST(req) {
  try {
    const { email, product_id, product_title, product_handle, first_name, last_name } = await req.json();
    
    // Validation
    if (!email || !product_id) {
      return NextResponse.json({ 
        success: false, 
        error: 'Missing required fields: email and product_id' 
      }, { status: 400 });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return NextResponse.json({ 
        success: false, 
        error: 'Invalid email format' 
      }, { status: 400 });
    }

    console.log(`📧 Processing subscription request for ${email}, product: ${product_id}`);

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
      });
    }

    // Add new subscriber
    const newSubscriber = {
      email,
      product_id,
      product_title,
      product_handle,
      first_name,
      last_name,
      notified: false,
      subscribed_at: new Date().toISOString(),
      ip_address: req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown'
    };

    subscribers.push(newSubscriber);
    await redis.set(key, subscribers);

    console.log(`✅ Added subscriber ${email} for product ${product_id}`);

    // Send confirmation email/event to Klaviyo (optional)
    await sendSubscriptionConfirmation(newSubscriber);

    return NextResponse.json({ 
      success: true,
      message: 'Successfully subscribed to back-in-stock notifications',
      subscriber_count: subscribers.length
    });

  } catch (error) {
    console.error('❌ Subscription error:', error);
    return NextResponse.json({ 
      success: false, 
      error: error.message 
    }, { status: 500 });
  }
}

// Optional: GET endpoint to check subscription status
export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const email = searchParams.get('email');
    const product_id = searchParams.get('product_id');

    if (!email || !product_id) {
      return NextResponse.json({ 
        success: false, 
        error: 'Missing email or product_id parameters' 
      }, { status: 400 });
    }

    const key = `subscribers:${product_id}`;
    const subscribers = (await redis.get(key)) || [];
    
    const isSubscribed = subscribers.some(sub => sub.email === email);

    return NextResponse.json({ 
      success: true,
      subscribed: isSubscribed,
      total_subscribers: subscribers.length
    });

  } catch (error) {
    console.error('❌ Check subscription error:', error);
    return NextResponse.json({ 
      success: false, 
      error: error.message 
    }, { status: 500 });
  }
}

// Optional: DELETE endpoint to unsubscribe
export async function DELETE(req) {
  try {
    const { email, product_id } = await req.json();

    if (!email || !product_id) {
      return NextResponse.json({ 
        success: false, 
        error: 'Missing email or product_id' 
      }, { status: 400 });
    }

    const key = `subscribers:${product_id}`;
    let subscribers = (await redis.get(key)) || [];
    
    const initialCount = subscribers.length;
    subscribers = subscribers.filter(sub => sub.email !== email);
    
    if (subscribers.length === initialCount) {
      return NextResponse.json({ 
        success: false, 
        error: 'Subscription not found' 
      }, { status: 404 });
    }

    await redis.set(key, subscribers);

    console.log(`🗑️ Removed subscriber ${email} from product ${product_id}`);

    return NextResponse.json({ 
      success: true,
      message: 'Successfully unsubscribed',
      remaining_subscribers: subscribers.length
    });

  } catch (error) {
    console.error('❌ Unsubscribe error:', error);
    return NextResponse.json({ 
      success: false, 
      error: error.message 
    }, { status: 500 });
  }
}

// Send subscription confirmation to Klaviyo
async function sendSubscriptionConfirmation(subscriber) {
  if (!KLAVIYO_API_KEY) {
    console.log('No Klaviyo API key - skipping confirmation email');
    return;
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
              ProductName: subscriber.product_title || 'Unknown Product',
              ProductID: subscriber.product_id,
              ProductHandle: subscriber.product_handle || '',
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
                  first_name: subscriber.first_name || '',
                  last_name: subscriber.last_name || ''
                } 
              } 
            }
          }
        }
      })
    });

    if (resp.ok) {
      console.log(`✅ Sent subscription confirmation to ${subscriber.email}`);
    } else {
      const error = await resp.text();
      console.error('Klaviyo confirmation error:', resp.status, error);
    }

  } catch (error) {
    console.error('Failed to send subscription confirmation:', error);
  }
}
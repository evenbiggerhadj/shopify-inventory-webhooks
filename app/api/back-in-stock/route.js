// api/back-in-stock.js - Updated to handle both GET and POST requests
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const KLAVIYO_API_KEY = process.env.KLAVIYO_PRIVATE_API_KEY;

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    if (req.method === 'POST') {
      // Handle subscription requests (from your form)
      return await handleSubscription(req, res);
    } else if (req.method === 'GET') {
      // Handle subscription checks
      return await handleSubscriptionCheck(req, res);
    } else if (req.method === 'DELETE') {
      // Handle unsubscribe requests
      return await handleUnsubscribe(req, res);
    } else {
      return res.status(405).json({
        success: false,
        error: 'Method not allowed'
      });
    }
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

async function handleSubscription(req, res) {
  const { email, product_id, product_title, product_handle, first_name, last_name } = req.body;
  
  console.log('📧 Processing back-in-stock subscription:', { email, product_id, product_title });
  
  // Validation
  if (!email || !product_id) {
    return res.status(400).json({ 
      success: false, 
      error: 'Missing required fields: email and product_id' 
    });
  }

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ 
      success: false, 
      error: 'Invalid email format' 
    });
  }

  const key = `subscribers:${product_id}`;
  let subscribers = (await redis.get(key)) || [];
  
  // Check if user is already subscribed
  const existingSubscriber = subscribers.find(sub => sub.email === email);
  
  if (existingSubscriber) {
    console.log(`User ${email} already subscribed to product ${product_id}`);
    return res.status(200).json({ 
      success: true, 
      message: 'You are already subscribed to notifications for this product',
      alreadySubscribed: true
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
    ip_address: req.headers['x-forwarded-for'] || 
                req.headers['x-real-ip'] || 
                req.connection?.remoteAddress || 'unknown'
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

  return res.status(200).json({ 
    success: true,
    message: 'Successfully subscribed to back-in-stock notifications',
    subscriber_count: subscribers.length
  });
}

async function handleSubscriptionCheck(req, res) {
  const { email, product_id } = req.query;

  if (!email || !product_id) {
    return res.status(400).json({ 
      success: false, 
      error: 'Missing email or product_id parameters' 
    });
  }

  const key = `subscribers:${product_id}`;
  const subscribers = (await redis.get(key)) || [];
  
  const subscription = subscribers.find(sub => sub.email === email);
  const isSubscribed = !!subscription;

  return res.status(200).json({ 
    success: true,
    subscribed: isSubscribed,
    total_subscribers: subscribers.length,
    subscription_details: subscription ? {
      subscribed_at: subscription.subscribed_at,
      notified: subscription.notified
    } : null
  });
}

async function handleUnsubscribe(req, res) {
  const { email, product_id } = req.body;

  if (!email || !product_id) {
    return res.status(400).json({ 
      success: false, 
      error: 'Missing email or product_id' 
    });
  }

  const key = `subscribers:${product_id}`;
  let subscribers = (await redis.get(key)) || [];
  
  const initialCount = subscribers.length;
  subscribers = subscribers.filter(sub => sub.email !== email);
  
  if (subscribers.length === initialCount) {
    return res.status(404).json({ 
      success: false, 
      error: 'Subscription not found' 
    });
  }

  await redis.set(key, subscribers);

  console.log(`🗑️ Removed subscriber ${email} from product ${product_id}`);

  return res.status(200).json({ 
    success: true,
    message: 'Successfully unsubscribed',
    remaining_subscribers: subscribers.length
  });
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
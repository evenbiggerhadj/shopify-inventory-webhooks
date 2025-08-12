// app/api/back-in-stock/route.js - COMPLETELY FIXED for Klaviyo integration
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
const BACK_IN_STOCK_WAITLIST_ID = process.env.KLAVIYO_BACK_IN_STOCK_WAITLIST_ID || 'WG9GbK';

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

// Handle subscription requests (form submissions) - ADDS TO WAITLIST
export async function POST(request) {
  try {
    const body = await request.json();
    const { 
      email, 
      phone, 
      product_id, 
      product_title, 
      product_handle, 
      first_name, 
      last_name,
      sms_consent = false
    } = body;
    
    console.log('🚀 Processing back-in-stock subscription:', { 
      email, 
      product_id, 
      product_title,
      has_phone: !!phone,
      sms_consent,
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

    // Validate phone if SMS consent given
    if (sms_consent && (!phone || phone.trim().length === 0)) {
      return NextResponse.json({ 
        success: false, 
        error: 'Phone number is required when SMS consent is provided' 
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

    // Format phone number properly
    let formattedPhone = null;
    if (phone && phone.trim().length > 0) {
      formattedPhone = formatPhoneNumber(phone.trim());
      console.log(`📱 Phone formatted as: ${formattedPhone}`);
    }

    // Create new subscriber object
    const newSubscriber = {
      email: email,
      phone: formattedPhone || '',
      product_id: product_id.toString(),
      product_title: product_title || 'Unknown Product',
      product_handle: product_handle || '',
      first_name: first_name || '',
      last_name: last_name || '',
      sms_consent: sms_consent && !!formattedPhone,
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

    // Add to WAITLIST (triggers waitlist confirmation flow)
    let waitlistSuccess = false;
    try {
      waitlistSuccess = await addToWaitlistProperly(newSubscriber, BACK_IN_STOCK_WAITLIST_ID);
      if (waitlistSuccess) {
        console.log(`✅ Successfully added ${email} to WAITLIST - confirmation flow should trigger`);
      } else {
        console.log(`⚠️ Waitlist addition failed for ${email}, but Redis subscription successful`);
      }
    } catch (waitlistError) {
      console.error('⚠️ Waitlist error (non-fatal):', waitlistError.message);
    }

    return NextResponse.json({ 
      success: true,
      message: 'Successfully subscribed to back-in-stock notifications',
      subscriber_count: subscribers.length,
      waitlist_success: waitlistSuccess,
      sms_enabled: newSubscriber.sms_consent
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

// Handle subscription status checks and debug actions
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const email = searchParams.get('email');
    const product_id = searchParams.get('product_id');
    const action = searchParams.get('action');

    // Debug action to clear a subscription for testing
    if (action === 'clear' && email && product_id) {
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
      
      const originalCount = subscribers.length;
      subscribers = subscribers.filter(sub => sub && sub.email !== email);
      const newCount = subscribers.length;
      
      await redis.set(key, subscribers);
      
      return NextResponse.json({ 
        success: true,
        message: `Removed ${originalCount - newCount} subscription(s) for ${email}`,
        original_count: originalCount,
        new_count: newCount
      }, {
        headers: { 'Access-Control-Allow-Origin': '*' }
      });
    }

    // Debug action to list all subscribers for a product
    if (action === 'list' && product_id) {
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
      
      return NextResponse.json({ 
        success: true,
        product_id,
        subscriber_count: subscribers.length,
        subscribers: subscribers.map(sub => ({
          email: sub.email,
          phone: sub.phone ? '***-***-' + sub.phone.slice(-4) : null,
          sms_consent: sub.sms_consent,
          subscribed_at: sub.subscribed_at,
          notified: sub.notified
        }))
      }, {
        headers: { 'Access-Control-Allow-Origin': '*' }
      });
    }

    // Original GET logic for checking subscription status
    if (!email || !product_id) {
      return NextResponse.json({ 
        success: false, 
        error: 'Missing email or product_id parameters. Use ?action=clear&email=xxx&product_id=xxx to clear a subscription for testing.' 
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
        notified: subscription.notified,
        sms_consent: subscription.sms_consent || false
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

// Phone number formatting function
function formatPhoneNumber(phone) {
  if (!phone) return null;
  
  // Remove all non-digit characters
  let cleanPhone = phone.replace(/\D/g, '');
  
  // Handle Nigerian numbers
  if (cleanPhone.startsWith('234')) {
    return '+' + cleanPhone;
  } else if (cleanPhone.startsWith('0') && cleanPhone.length === 11) {
    // Nigerian number starting with 0
    return '+234' + cleanPhone.substring(1);
  } else if (cleanPhone.length === 10 && /^[789]/.test(cleanPhone)) {
    // 10-digit Nigerian number starting with 7, 8, or 9
    return '+234' + cleanPhone;
  } else if (cleanPhone.length === 10) {
    // US number
    return '+1' + cleanPhone;
  } else if (cleanPhone.length === 11 && cleanPhone.startsWith('1')) {
    // US number with country code
    return '+' + cleanPhone;
  } else {
    // Default: add + if not present
    return cleanPhone.startsWith('+') ? cleanPhone : '+' + cleanPhone;
  }
}

// COMPLETELY FIXED: Add to WAITLIST properly using correct Klaviyo method
async function addToWaitlistProperly(subscriber, waitlistId) {
  if (!KLAVIYO_API_KEY) {
    console.log('❌ No KLAVIYO_API_KEY found');
    return false;
  }

  try {
    console.log(`📋 Adding ${subscriber.email} to WAITLIST ${waitlistId} using proper method...`);
    console.log(`📱 SMS Consent: ${subscriber.sms_consent}, Phone: ${subscriber.phone || 'none'}`);

    // Step 1: Create or get profile ID
    const profileId = await createOrGetProfile(subscriber);
    
    if (!profileId) {
      console.error('❌ Could not create/get profile');
      return false;
    }
    
    console.log(`✅ Got profile ID: ${profileId}`);

    // Step 2: Add profile to waitlist using relationships endpoint
    const addToListData = {
      data: [{
        type: 'profile',
        id: profileId
      }]
    };

    const listResponse = await fetch(`https://a.klaviyo.com/api/lists/${waitlistId}/relationships/profiles/`, {
      method: 'POST',
      headers: {
        'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        'Content-Type': 'application/json',
        'revision': '2024-10-15'
      },
      body: JSON.stringify(addToListData)
    });

    console.log(`📥 List addition response status: ${listResponse.status}`);

    if (listResponse.ok || listResponse.status === 204) {
      console.log(`✅ Successfully added ${subscriber.email} to WAITLIST - flow should trigger!`);
      
      // Step 3: Update phone and SMS consent after adding to list
      if (subscriber.phone && subscriber.sms_consent) {
        await updateProfileWithPhone(profileId, subscriber.phone);
      }
      
      return true;
    } else {
      const errorText = await listResponse.text();
      console.error(`❌ Failed to add to waitlist (${listResponse.status}):`, errorText);
      return false;
    }
    
  } catch (error) {
    console.error('❌ Waitlist error:', error);
    return false;
  }
}

// FIXED: Create or get profile without subscriptions field
async function createOrGetProfile(subscriber) {
  try {
    // Simple profile creation without problematic fields
    const profileData = {
      data: {
        type: 'profile',
        attributes: {
          email: subscriber.email,
          first_name: subscriber.first_name || '',
          last_name: subscriber.last_name || '',
          properties: {
            'Waitlist Item': subscriber.product_title,
            'Waitlist Date': subscriber.subscribed_at,
            'SMS Consent Given': subscriber.sms_consent,
            'Waitlist Source': 'Product Page Form',
            'Product ID': subscriber.product_id
          }
        }
      }
    };

    console.log(`📝 Creating simple profile for ${subscriber.email}...`);

    const profileResponse = await fetch('https://a.klaviyo.com/api/profiles/', {
      method: 'POST',
      headers: {
        'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        'Content-Type': 'application/json',
        'revision': '2024-10-15'
      },
      body: JSON.stringify(profileData)
    });

    console.log(`📥 Profile response status: ${profileResponse.status}`);

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
          const profileId = result.data[0].id;
          console.log(`✅ Found existing profile ID ${profileId}`);
          return profileId;
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

// Update profile with phone number after creation
async function updateProfileWithPhone(profileId, phone) {
  try {
    console.log(`📱 Updating profile ${profileId} with phone ${phone}...`);
    
    const updateData = {
      data: {
        type: 'profile',
        id: profileId,
        attributes: {
          phone_number: phone,
          properties: {
            'SMS Phone Number': phone,
            'SMS Consent Updated': new Date().toISOString()
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
      console.log(`✅ Updated profile ${profileId} with phone number`);
    } else {
      const errorText = await response.text();
      console.log(`⚠️ Phone update warning (${response.status}):`, errorText);
    }
  } catch (error) {
    console.error('❌ Phone update error:', error);
  }
}
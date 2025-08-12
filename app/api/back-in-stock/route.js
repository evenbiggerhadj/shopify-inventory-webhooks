// app/api/back-in-stock/route.js - FIXED with SMS consent and proper phone handling
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
    const { 
      email, 
      phone, 
      product_id, 
      product_title, 
      product_handle, 
      first_name, 
      last_name,
      sms_consent = false // NEW: SMS consent flag
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

    // Validate phone if provided and SMS consent is given
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
      sms_consent: sms_consent && !!formattedPhone, // Only true if consent given AND valid phone
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

    // Add to Klaviyo with proper consent settings
    let klaviyoSuccess = false;
    try {
      klaviyoSuccess = await subscribeToKlaviyoList(newSubscriber);
      if (klaviyoSuccess) {
        console.log(`✅ Successfully added ${email} to Klaviyo list with SMS consent: ${newSubscriber.sms_consent}`);
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
      klaviyo_success: klaviyoSuccess,
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

// FIXED: Phone number formatting function
function formatPhoneNumber(phone) {
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

// FIXED: Klaviyo subscription with proper SMS consent
async function subscribeToKlaviyoList(subscriber) {
  if (!KLAVIYO_API_KEY) {
    console.log('❌ No KLAVIYO_API_KEY found in environment variables');
    return false;
  }

  console.log('🔍 Klaviyo Debug Info:');
  console.log('- API Key exists:', !!KLAVIYO_API_KEY);
  console.log('- List ID:', BACK_IN_STOCK_LIST_ID);
  console.log('- Subscriber email:', subscriber.email);
  console.log('- SMS consent:', subscriber.sms_consent);
  console.log('- Phone:', subscriber.phone);
  
  try {
    // Create profile with proper consent settings
    const profileId = await createOrGetProfileWithConsent(subscriber);
    
    if (profileId) {
      console.log(`📋 Adding profile ${profileId} to list...`);
      
      // Add to list using relationships
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

      console.log('📥 List response status:', listResponse.status);

      if (listResponse.ok || listResponse.status === 204) {
        console.log(`✅ Successfully added ${subscriber.email} to list with SMS consent: ${subscriber.sms_consent}!`);
        return true;
      } else {
        const errorText = await listResponse.text();
        console.error(`❌ List addition failed:`, errorText);
        return false;
      }
    } else {
      console.error(`❌ Could not create/find profile for ${subscriber.email}`);
      return false;
    }
    
  } catch (error) {
    console.error('❌ Klaviyo subscription error:', error);
    return false;
  }
}

// FIXED: Create profile with proper SMS consent
async function createOrGetProfileWithConsent(subscriber) {
  try {
    const profileData = {
      data: {
        type: 'profile',
        attributes: {
          email: subscriber.email,
          first_name: subscriber.first_name || '',
          last_name: subscriber.last_name || '',
          properties: {
            'Back in Stock Subscriber': true,
            'Subscription Source': 'Bundle Notifications',
            'Product Subscribed': subscriber.product_title,
            'SMS Consent Given': subscriber.sms_consent,
            'Subscription Date': subscriber.subscribed_at
          }
        }
      }
    };

    // Add phone number and SMS consent if provided
    if (subscriber.phone && subscriber.sms_consent) {
      profileData.data.attributes.phone_number = subscriber.phone;
      profileData.data.attributes.subscriptions = {
        email: {
          marketing: {
            consent: 'SUBSCRIBED'
          }
        },
        sms: {
          marketing: {
            consent: 'SUBSCRIBED'
          }
        }
      };
      console.log(`📱 Setting SMS consent for ${subscriber.email} with phone ${subscriber.phone}`);
    } else {
      // Email only subscription
      profileData.data.attributes.subscriptions = {
        email: {
          marketing: {
            consent: 'SUBSCRIBED'
          }
        }
      };
      console.log(`📧 Email-only subscription for ${subscriber.email}`);
    }

    console.log(`📝 Creating profile for ${subscriber.email}...`);

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
      // Profile exists, update it with consent
      console.log(`ℹ️ Profile exists, updating consent for ${subscriber.email}...`);
      return await updateExistingProfileConsent(subscriber);
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

// NEW: Update existing profile with consent
async function updateExistingProfileConsent(subscriber) {
  try {
    // Get existing profile
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
        
        // Update profile with consent if SMS is enabled
        if (subscriber.phone && subscriber.sms_consent) {
          const updateData = {
            data: {
              type: 'profile',
              id: profileId,
              attributes: {
                phone_number: subscriber.phone,
                subscriptions: {
                  email: {
                    marketing: {
                      consent: 'SUBSCRIBED'
                    }
                  },
                  sms: {
                    marketing: {
                      consent: 'SUBSCRIBED'
                    }
                  }
                },
                properties: {
                  'SMS Consent Given': true,
                  'SMS Consent Date': subscriber.subscribed_at
                }
              }
            }
          };

          const updateResponse = await fetch(`https://a.klaviyo.com/api/profiles/${profileId}/`, {
            method: 'PATCH',
            headers: {
              'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
              'Content-Type': 'application/json',
              'revision': '2024-10-15'
            },
            body: JSON.stringify(updateData)
          });

          if (updateResponse.ok) {
            console.log(`✅ Updated profile ${profileId} with SMS consent`);
          } else {
            const errorText = await updateResponse.text();
            console.log(`⚠️ Profile update warning:`, errorText);
          }
        }
        
        return profileId;
      }
    }
    
    return null;
  } catch (error) {
    console.error('❌ Profile update error:', error);
    return null;
  }
}
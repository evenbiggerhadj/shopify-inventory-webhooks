// app/api/test-redis/route.js - Redis connection test
import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

// Use YOUR actual environment variable names
const redis = new Redis({
  url: process.env.KV_REST_API_URL,      // Using your KV_REST_API_URL
  token: process.env.KV_REST_API_TOKEN,  // Using your KV_REST_API_TOKEN
});

export async function GET() {
  try {
    console.log('🔍 Testing Redis connection...');
    
    // Check environment variables with your actual names
    const hasUrl = !!process.env.KV_REST_API_URL;
    const hasToken = !!process.env.KV_REST_API_TOKEN;
    
    console.log('Environment check:');
    console.log('- KV_REST_API_URL:', hasUrl ? 'SET ✅' : 'MISSING ❌');
    console.log('- KV_REST_API_TOKEN:', hasToken ? 'SET ✅' : 'MISSING ❌');
    
    if (!hasUrl || !hasToken) {
      return NextResponse.json({
        success: false,
        error: 'Missing Redis environment variables',
        details: {
          KV_REST_API_URL: hasUrl,
          KV_REST_API_TOKEN: hasToken
        }
      }, { status: 500 });
    }
    
    // Test 1: Ping
    console.log('📡 Testing ping...');
    const pingResult = await redis.ping();
    console.log('Ping result:', pingResult);
    
    // Test 2: Set and Get
    console.log('💾 Testing set/get...');
    const testKey = `test-${Date.now()}`;
    const testValue = { message: 'Redis test working!', timestamp: new Date().toISOString() };
    await redis.set(testKey, testValue);
    const result = await redis.get(testKey);
    console.log('Get result:', result);
    
    // Test 3: Test subscriber-like data
    console.log('📋 Testing subscriber format...');
    const subscriberKey = `test-subscribers-${Date.now()}`;
    const subscriberData = [
      { 
        email: 'test@example.com', 
        product_id: '123', 
        subscribed_at: new Date().toISOString(),
        notified: false
      }
    ];
    await redis.set(subscriberKey, subscriberData);
    const subscriberResult = await redis.get(subscriberKey);
    console.log('Subscriber test result:', subscriberResult);
    
    // Test 4: Cleanup
    await redis.del(testKey);
    await redis.del(subscriberKey);
    
    console.log('✅ All Redis tests passed!');
    
    return NextResponse.json({
      success: true,
      message: 'Redis connection working perfectly!',
      tests: {
        ping: pingResult,
        setGet: result,
        subscriberFormat: subscriberResult
      },
      environment: {
        KV_REST_API_URL: hasUrl ? 'SET' : 'MISSING',
        KV_REST_API_TOKEN: hasToken ? 'SET' : 'MISSING',
        actualUrl: process.env.KV_REST_API_URL // Safe to show URL
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Redis test failed:', error);
    
    return NextResponse.json({
      success: false,
      error: 'Redis connection failed',
      details: {
        message: error.message,
        name: error.name
      },
      environment: {
        KV_REST_API_URL: process.env.KV_REST_API_URL ? 'SET' : 'MISSING',
        KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN ? 'SET' : 'MISSING',
        url: process.env.KV_REST_API_URL
      },
      timestamp: new Date().toISOString()
    }, { status: 500 });
  }
}
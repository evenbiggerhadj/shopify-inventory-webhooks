// app/api/test-redis/route.js - Simple test to verify Redis works
import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export async function GET() {
  try {
    console.log('🔍 Testing Redis connection...');
    
    // Test 1: Ping
    console.log('📡 Testing ping...');
    const pingResult = await redis.ping();
    console.log('Ping result:', pingResult);
    
    // Test 2: Set and Get
    console.log('💾 Testing set/get...');
    const testKey = `test-${Date.now()}`;
    await redis.set(testKey, { message: 'Redis test working!', timestamp: new Date().toISOString() });
    const result = await redis.get(testKey);
    console.log('Get result:', result);
    
    // Test 3: Cleanup
    await redis.del(testKey);
    
    console.log('✅ All Redis tests passed!');
    
    return NextResponse.json({
      success: true,
      message: 'Redis connection working perfectly!',
      tests: {
        ping: pingResult,
        setGet: result
      },
      environment: {
        url: process.env.UPSTASH_REDIS_REST_URL ? 'SET' : 'MISSING',
        token: process.env.UPSTASH_REDIS_REST_TOKEN ? 'SET' : 'MISSING'
      }
    });
    
  } catch (error) {
    console.error('❌ Redis test failed:', error);
    
    return NextResponse.json({
      success: false,
      error: 'Redis connection failed',
      details: {
        message: error.message,
        name: error.name,
        stack: error.stack
      },
      environment: {
        url: process.env.UPSTASH_REDIS_REST_URL ? 'SET' : 'MISSING',
        token: process.env.UPSTASH_REDIS_REST_TOKEN ? 'SET' : 'MISSING'
      }
    }, { status: 500 });
  }
}
import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/* ----------------- Env ----------------- */
const ENV = {
  KLAVIYO_API_KEY: process.env.KLAVIYO_API_KEY,
  // Your Klaviyo “Back in stock” list id (make sure this is the one you actually use)
  LIST_ID:
    process.env.KLAVIYO_BACK_IN_STOCK_ALERT_LIST_ID ||
    process.env.KLAVIYO_LIST_ID,

  PUBLIC_STORE_DOMAIN: process.env.PUBLIC_STORE_DOMAIN || "armadillotough.com",

  // ✅ Prefer Upstash REST vars
  KV_URL: process.env.KV_REST_API_URL || process.env.KV_URL || process.env.REDIS_URL || "",
  // ✅ IMPORTANT: Use WRITE token for SET. Read-only token will fail.
  KV_TOKEN: process.env.KV_REST_API_TOKEN || "",

  // Optional: force-disable redis without redeploying code
  SOFT_DISABLE_REDIS: (process.env.SOFT_DISABLE_REDIS || "") === "1",
};

const ALLOW_ORIGINS = [
  "https://armadillotough.com",
  "https://www.armadillotough.com",
  "https://armadillotough.myshopify.com",
];

/* ----------------- CORS helpers ----------------- */
function pickOrigin(req) {
  const o = req.headers.get("origin");
  return ALLOW_ORIGINS.includes(o) ? o : ALLOW_ORIGINS[0];
}

function withCors(resp, origin) {
  resp.headers.set("Access-Control-Allow-Origin", origin);
  resp.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  resp.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  resp.headers.set("Vary", "Origin");
  resp.headers.set("Cache-Control", "no-store");
  return resp;
}

/* ----------------- Utils ----------------- */
function normalizeProductId(raw) {
  if (!raw) return "";
  const s = String(raw);
  // accept gid://shopify/Product/123 or 123
  const m = s.match(/(\d{5,})$/);
  return m ? m[1] : s.replace(/[^\d]/g, "");
}

function productUrlFrom(handle) {
  return handle ? `https://${ENV.PUBLIC_STORE_DOMAIN}/products/${handle}` : "";
}

function toE164(raw) {
  if (!raw) return null;
  let v = String(raw).trim().replace(/[^\d+]/g, "");
  if (v.startsWith("+")) return /^\+\d{8,15}$/.test(v) ? v : null;
  if (/^\d{10}$/.test(v)) return "+1" + v; // US 10 digits
  if (/^0\d{10}$/.test(v)) return "+234" + v.slice(1); // NG common
  if (/^(70|80|81|90|91)\d{8}$/.test(v)) return "+234" + v; // NG
  return null;
}

/* ----------------- Redis best-effort ----------------- */
let redis = null;
let redisDisabled = ENV.SOFT_DISABLE_REDIS;

function canUseRedis() {
  return !redisDisabled && !!ENV.KV_URL && !!ENV.KV_TOKEN;
}

function getRedis() {
  if (!canUseRedis()) return null;
  if (!redis) redis = new Redis({ url: ENV.KV_URL, token: ENV.KV_TOKEN });
  return redis;
}

async function safeRedisPing() {
  const r = getRedis();
  if (!r) return { ok: false, reason: "redis_disabled_or_missing_env" };
  try {
    await r.ping();
    return { ok: true };
  } catch (e) {
    redisDisabled = true; // fail-open for this invocation
    return { ok: false, reason: e?.message || String(e) };
  }
}

async function safeRedisAppendSubscriber(key, entry) {
  const r = getRedis();
  if (!r) return { ok: false, reason: "redis_unavailable" };
  try {
    const existing = (await r.get(key)) || [];
    const list = Array.isArray(existing)
      ? existing
      : typeof existing === "string"
      ? JSON.parse(existing || "[]")
      : [];

    // de-dupe by email
    const emailLower = String(entry.email).toLowerCase();
    const idx = list.findIndex((x) => String(x?.email || "").toLowerCase() === emailLower);
    if (idx >= 0) list[idx] = { ...list[idx], ...entry };
    else list.push(entry);

    await r.set(key, list, { ex: 90 * 24 * 60 * 60 });
    return { ok: true, count: list.length };
  } catch (e) {
    redisDisabled = true;
    return { ok: false, reason: e?.message || String(e) };
  }
}

/* ----------------- Klaviyo ----------------- */
async function klaviyoSubscribeToList({ listId, email, phoneE164, sms }) {
  const subscriptions = { email: { marketing: { consent: "SUBSCRIBED" } } };
  if (sms && phoneE164) subscriptions.sms = { marketing: { consent: "SUBSCRIBED" } };

  const payload = {
    data: {
      type: "profile-subscription-bulk-create-job",
      attributes: {
        profiles: {
          data: [
            {
              type: "profile",
              attributes: {
                email,
                ...(sms && phoneE164 ? { phone_number: phoneE164 } : {}),
                subscriptions,
              },
            },
          ],
        },
      },
      relationships: { list: { data: { type: "list", id: listId } } },
    },
  };

  const res = await fetch("https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/", {
    method: "POST",
    headers: {
      Authorization: `Klaviyo-API-Key ${ENV.KLAVIYO_API_KEY}`,
      accept: "application/json",
      "content-type": "application/json",
      revision: "2023-10-15",
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text };
}

async function klaviyoTrackEvent({ email, phoneE164, properties }) {
  const payload = {
    data: {
      type: "event",
      attributes: {
        time: new Date().toISOString(),
        properties: properties || {},
        metric: { data: { type: "metric", attributes: { name: "Back in Stock Subscriptions" } } },
        profile: {
          data: {
            type: "profile",
            attributes: { email, ...(phoneE164 ? { phone_number: phoneE164 } : {}) },
          },
        },
      },
    },
  };

  const res = await fetch("https://a.klaviyo.com/api/events/", {
    method: "POST",
    headers: {
      Authorization: `Klaviyo-API-Key ${ENV.KLAVIYO_API_KEY}`,
      accept: "application/json",
      "content-type": "application/json",
      revision: "2023-10-15",
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text };
}

/* ----------------- OPTIONS ----------------- */
export async function OPTIONS(request) {
  return withCors(new NextResponse(null, { status: 204 }), pickOrigin(request));
}

/* ----------------- POST (Storefront form submit) ----------------- */
export async function POST(request) {
  const origin = pickOrigin(request);

  try {
    if (!ENV.KLAVIYO_API_KEY || !ENV.LIST_ID) {
      return withCors(
        NextResponse.json(
          { success: false, error: "Server misconfigured: missing KLAVIYO_API_KEY or LIST_ID" },
          { status: 500 }
        ),
        origin
      );
    }

    const body = await request.json().catch(() => ({}));

    const email = String(body?.email || "").trim();
    const product_id = normalizeProductId(body?.product_id);
    const product_handle = String(body?.product_handle || "").trim();
    const product_title = String(body?.product_title || body?.title || "Unknown Product").trim();

    const phone = body?.phone || body?.phone_number || "";
    const phoneE164 = toE164(phone);
    const sms_consent = !!body?.sms_consent;
    const smsAllowed = !!(sms_consent && phoneE164);

    if (!email || !product_id) {
      return withCors(
        NextResponse.json({ success: false, error: "Missing required fields: email and product_id" }, { status: 400 }),
        origin
      );
    }

    const product_url = productUrlFrom(product_handle);

    // 1) Redis best-effort (never block)
    const ping = await safeRedisPing();
    const redis_ok = ping.ok;

    let subscriber_count = null;
    if (redis_ok) {
      const key = `subscribers:${product_id}`;
      const entry = {
        email,
        phone: phoneE164 || "",
        sms_consent: smsAllowed,
        product_id,
        product_handle,
        product_title,
        product_url,
        subscribed_at: new Date().toISOString(),
      };

      const write = await safeRedisAppendSubscriber(key, entry);
      if (write.ok) subscriber_count = write.count;
    }

    // 2) Klaviyo subscribe (authoritative)
    const sub = await klaviyoSubscribeToList({
      listId: ENV.LIST_ID,
      email,
      phoneE164,
      sms: smsAllowed,
    });

    // Even if Klaviyo failed, still return clear error
    if (!sub.ok) {
      return withCors(
        NextResponse.json({
          success: false,
          error: "Klaviyo subscribe failed",
          klaviyo_status: sub.status,
          klaviyo_body: sub.body,
          redis_ok,
          redis_reason: redis_ok ? null : ping.reason,
        }),
        origin
      );
    }

    // 3) Track event (optional; do not block success)
    const evt = await klaviyoTrackEvent({
      email,
      phoneE164,
      properties: {
        product_id,
        product_title,
        product_handle,
        product_url,
        sms_consent: smsAllowed,
        redis_ok,
      },
    }).catch((e) => ({ ok: false, status: 0, body: e?.message || String(e) }));

    return withCors(
      NextResponse.json({
        success: true,
        message: "Subscribed",
        redis_ok,
        redis_reason: redis_ok ? null : ping.reason,
        subscriber_count,
        klaviyo_status: sub.status,
        event_success: !!evt.ok,
      }),
      origin
    );
  } catch (e) {
    return withCors(
      NextResponse.json(
        { success: false, error: "Server error. Please try again.", details: e?.message || String(e) },
        { status: 500 }
      ),
      origin
    );
  }
}

/* ----------------- GET (debug / check) ----------------- */
export async function GET(request) {
  const origin = pickOrigin(request);

  const { searchParams } = new URL(request.url);
  const email = searchParams.get("email");
  const product_id = normalizeProductId(searchParams.get("product_id"));

  if (!email || !product_id) {
    return withCors(
      NextResponse.json({ success: false, error: "Missing email and product_id" }, { status: 400 }),
      origin
    );
  }

  const ping = await safeRedisPing();
  if (!ping.ok) {
    return withCors(
      NextResponse.json({
        success: true,
        subscribed: null,
        redis_ok: false,
        redis_reason: ping.reason,
      }),
      origin
    );
  }

  const r = getRedis();
  const key = `subscribers:${product_id}`;
  const list = (await r.get(key)) || [];
  const arr = Array.isArray(list) ? list : typeof list === "string" ? JSON.parse(list || "[]") : [];

  const subscribed = arr.some((x) => String(x?.email || "").toLowerCase() === String(email).toLowerCase());

  return withCors(
    NextResponse.json({ success: true, subscribed, total: arr.length, redis_ok: true }),
    origin
  );
}

// app/api/back-in-stock/route.js
// WAITLIST signup (Klaviyo + Redis best-effort + product props + event)

import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/* ----------------- ENV ----------------- */
const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY || "";
const WAITLIST_LIST_ID =
  process.env.KLAVIYO_LIST_ID || process.env.WAITLIST_LIST_ID || "";

const PUBLIC_STORE_DOMAIN =
  process.env.PUBLIC_STORE_DOMAIN || "armadillotough.com";

/* ----------------- Redis (best-effort) ----------------- */
/**
 * Vercel Storage (Upstash KV) provides:
 * - KV_REST_API_URL
 * - KV_REST_API_TOKEN
 * - KV_REST_API_READ_ONLY_TOKEN (optional)
 */
const REDIS_URL =
  process.env.KV_REST_API_URL ||
  process.env.KV_URL ||
  process.env.REDIS_URL ||
  "";

const REDIS_TOKEN =
  process.env.KV_REST_API_TOKEN ||
  process.env.KV_REST_API_READ_ONLY_TOKEN ||
  process.env.KV_TOKEN ||
  "";

const redis =
  REDIS_URL && REDIS_TOKEN
    ? new Redis({
        url: REDIS_URL,
        token: REDIS_TOKEN,
        retry: { retries: 2 },
      })
    : null;

/* ----------------- CORS ----------------- */
const ALLOWED_ORIGINS = new Set([
  "https://armadillotough.com",
  "https://www.armadillotough.com",
]);

function pickOrigin(request) {
  const o = request.headers.get("origin") || "";
  if (ALLOWED_ORIGINS.has(o)) return o;
  // fallback for non-browser tests
  return "https://armadillotough.com";
}

function cors(res, origin) {
  res.headers.set("Access-Control-Allow-Origin", origin);
  res.headers.set("Vary", "Origin");
  res.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
  return res;
}

export async function OPTIONS(request) {
  const origin = pickOrigin(request);
  return cors(new NextResponse(null, { status: 204 }), origin);
}

/* ----------------- helpers ----------------- */
function toE164(phone) {
  if (!phone) return "";
  const p = String(phone).trim();
  // If already looks like +234..., keep it
  if (p.startsWith("+")) return p;
  // remove non-digits
  const digits = p.replace(/[^\d]/g, "");
  // If US length 10 -> +1
  if (digits.length === 10) return `+1${digits}`;
  // If looks international already
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return "";
}

async function safeRedisPing() {
  if (!redis) return { ok: false, reason: "redis_not_configured" };
  try {
    await redis.ping();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  }
}

async function parseBody(request) {
  const ct = (request.headers.get("content-type") || "").toLowerCase();

  if (ct.includes("application/json")) {
    const raw = await request.text();
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new Error(`Invalid JSON body: ${e?.message || String(e)}`);
    }
  }

  if (ct.includes("application/x-www-form-urlencoded")) {
    const raw = await request.text();
    return Object.fromEntries(new URLSearchParams(raw));
  }

  if (ct.includes("multipart/form-data")) {
    const fd = await request.formData();
    const obj = {};
    for (const [k, v] of fd.entries()) obj[k] = v;
    return obj;
  }

  // fallback
  try {
    const raw = await request.text();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function json(resBody, status = 200) {
  return NextResponse.json(resBody, { status });
}

/* ----------------- MAIN: POST ----------------- */
export async function POST(request) {
  const origin = pickOrigin(request);
  const reqId =
    request.headers.get("x-vercel-id") ||
    request.headers.get("x-request-id") ||
    crypto.randomUUID();

  try {
    const body = await parseBody(request);

    const email = (body.email || body.Email || "").toString().trim();
    const phone = (body.phone || body.mobile || body.Mobile || "").toString();
    const phoneE164 = toE164(phone);

    const productId = (body.product_id || body.productId || "").toString();
    const productHandle = (body.product_handle || body.productHandle || "")
      .toString()
      .trim();
    const productTitle = (body.product_title || body.productTitle || "")
      .toString()
      .trim();

    const first_name = (body.first_name || body.firstName || "").toString();
    const last_name = (body.last_name || body.lastName || "").toString();

    const smsFlag =
      body.sms_consent === true ||
      body.sms_consent === "true" ||
      body.smsConsent === true ||
      body.smsConsent === "true";

    const related_section_url =
      (body.related_section_url || body.relatedSectionUrl || "").toString();

    const source = (body.source || "shopify_form").toString();

    if (!email) {
      return cors(
        json({ success: false, error: "Missing email" }, 200),
        origin
      );
    }

    if (!productId && !productHandle) {
      return cors(
        json(
          {
            success: false,
            error: "Missing email and product_id or product_handle",
          },
          200
        ),
        origin
      );
    }

    const productUrl = productHandle
      ? `https://${PUBLIC_STORE_DOMAIN}/products/${productHandle}`
      : "";

    // Debug log (shows in Vercel logs)
    console.log("[/api/back-in-stock] POST", {
      reqId,
      email,
      hasPhone: !!phoneE164,
      productId,
      productHandle,
      productTitle,
      origin,
      source,
    });

    /* ----------------- Redis store (best-effort) ----------------- */
    const ping = await safeRedisPing();
    let redis_ok = ping.ok;
    let redis_reason = ping.ok ? "" : ping.reason;

    let subscriber_count = null;

    if (redis_ok) {
      try {
        const idKey = `subscribers:${productId || "unknown"}`;
        const list = (await redis.get(idKey)) || [];
        const next = Array.isArray(list) ? list : [];

        // de-dupe by email
        const exists = next.some(
          (x) => (x?.email || "").toLowerCase() === email.toLowerCase()
        );
        if (!exists) {
          next.push({
            email,
            phone: phoneE164 || "",
            first_name,
            last_name,
            product_id: productId,
            product_handle: productHandle,
            product_title: productTitle,
            product_url: productUrl,
            related_section_url,
            source,
            created_at: new Date().toISOString(),
          });
          await redis.set(idKey, next);
        }

        subscriber_count = next.length;
      } catch (e) {
        // Don’t fail the request if Redis fails
        redis_ok = false;
        redis_reason = e?.message || String(e);
      }
    }

    /* ----------------- Klaviyo (optional but recommended) ----------------- */
    let klaviyo_ok = false;
    let klaviyo_reason = "";

    // If you want the system to still work without Klaviyo, keep it best-effort.
    // If you want to hard-require Klaviyo, change this to return 500 when missing.
    if (!KLAVIYO_API_KEY || !WAITLIST_LIST_ID) {
      klaviyo_ok = false;
      klaviyo_reason =
        "Klaviyo not configured (missing KLAVIYO_API_KEY or KLAVIYO_LIST_ID)";
    } else {
      try {
        // 1) Subscribe profile to list
        await subscribeProfilesToList({
          listId: WAITLIST_LIST_ID,
          email,
          phoneE164,
          sms: smsFlag,
        });

        // 2) Update profile properties (product context)
        await updateKlaviyoProfile({
          email,
          phoneE164,
          properties: {
            last_waitlist_product_id: productId,
            last_waitlist_product_handle: productHandle,
            last_waitlist_product_title: productTitle,
            last_waitlist_product_url: productUrl,
            last_waitlist_source: source,
            last_waitlist_at: new Date().toISOString(),
          },
        });

        // 3) Track event
        await trackKlaviyoEvent({
          metricName: "Back In Stock Request",
          email,
          phoneE164,
          properties: {
            product_id: productId,
            product_handle: productHandle,
            product_title: productTitle,
            product_url: productUrl,
            related_section_url: related_section_url || "",
            source,
          },
        });

        klaviyo_ok = true;
      } catch (e) {
        klaviyo_ok = false;
        klaviyo_reason = e?.message || String(e);
        console.error("[/api/back-in-stock] Klaviyo error", { reqId, e });
      }
    }

    return cors(
      json({
        success: true,
        reqId,
        redis: { ok: redis_ok, reason: redis_reason, subscriber_count },
        klaviyo: { ok: klaviyo_ok, reason: klaviyo_reason },
      }),
      origin
    );
  } catch (error) {
    console.error("[/api/back-in-stock] POST fatal:", error);
    return cors(
      json(
        {
          success: false,
          error: error?.message || "Server error",
        },
        500
      ),
      origin
    );
  }
}

/* ----------------- MAIN: GET (health) ----------------- */
export async function GET(request) {
  const origin = pickOrigin(request);

  try {
    const ping = await safeRedisPing();
    return cors(
      json({
        success: true,
        redis: ping,
        klaviyo_configured: !!(KLAVIYO_API_KEY && WAITLIST_LIST_ID),
      }),
      origin
    );
  } catch (error) {
    console.error("[/api/back-in-stock] GET fatal:", error);
    return cors(
      json({ success: false, error: error?.message || "Error" }, 500),
      origin
    );
  }
}

/* ----------------- Klaviyo helpers ----------------- */
async function subscribeProfilesToList({ listId, email, phoneE164, sms }) {
  const url = `https://a.klaviyo.com/api/lists/${listId}/relationships/profiles/`;

  const payload = {
    data: [
      {
        type: "profile",
        attributes: {
          email,
          ...(phoneE164 ? { phone_number: phoneE164 } : {}),
          ...(sms ? { subscriptions: { sms: ["MARKETING"] } } : {}),
        },
      },
    ],
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      Revision: "2024-10-15",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Klaviyo subscribe failed (${res.status}): ${body}`);
  }
}

async function updateKlaviyoProfile({ email, phoneE164, properties }) {
  const url = "https://a.klaviyo.com/api/profiles/";

  const payload = {
    data: {
      type: "profile",
      attributes: {
        email,
        ...(phoneE164 ? { phone_number: phoneE164 } : {}),
        properties: properties || {},
      },
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      Revision: "2024-10-15",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Klaviyo profile upsert failed (${res.status}): ${body}`);
  }
}

async function trackKlaviyoEvent({ metricName, email, phoneE164, properties }) {
  const url = "https://a.klaviyo.com/api/events/";

  const payload = {
    data: {
      type: "event",
      attributes: {
        metric: { data: { type: "metric", attributes: { name: metricName } } },
        profile: {
          data: {
            type: "profile",
            attributes: {
              email,
              ...(phoneE164 ? { phone_number: phoneE164 } : {}),
            },
          },
        },
        properties: properties || {},
        time: new Date().toISOString(),
      },
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      Revision: "2024-10-15",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Klaviyo event failed (${res.status}): ${body}`);
  }
}

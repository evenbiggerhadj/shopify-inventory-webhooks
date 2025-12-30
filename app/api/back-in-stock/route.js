// app/api/back-in-stock/route.js
import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/* ----------------- Redis (best-effort) ----------------- */
const REDIS_URL =
  process.env.KV_REST_API_URL ||
  process.env.KV_URL ||
  process.env.REDIS_URL ||
  "";

const REDIS_TOKEN =
  process.env.KV_REST_API_TOKEN ||
  process.env.KV_TOKEN ||
  process.env.KV_REST_API_READ_ONLY_TOKEN || // last resort (writes may fail)
  "";

const redis =
  REDIS_URL && REDIS_TOKEN
    ? new Redis({
        url: REDIS_URL,
        token: REDIS_TOKEN,
        retry: { retries: 3, retryDelayOnFailover: 100 },
      })
    : null;

/* ----------------- Env ----------------- */
const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY; // required
const WAITLIST_LIST_ID = process.env.KLAVIYO_LIST_ID; // required
const PUBLIC_STORE_DOMAIN =
  process.env.PUBLIC_STORE_DOMAIN || "armadillotough.com";

/* ----------------- CORS allowlist ----------------- */
const ALLOW_ORIGINS = [
  "https://armadillotough.com",
  "https://www.armadillotough.com",
  "https://armadillotough.myshopify.com",
];

const pickOrigin = (req) => {
  const o = req.headers.get("origin");
  return ALLOW_ORIGINS.includes(o) ? o : ALLOW_ORIGINS[0];
};

function cors(resp, origin = "*") {
  resp.headers.set("Access-Control-Allow-Origin", origin);
  resp.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  resp.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  resp.headers.set("Vary", "Origin");
  resp.headers.set("Cache-Control", "no-store");
  return resp;
}

async function readBody(request) {
  const ct = (request.headers.get("content-type") || "").toLowerCase();

  if (ct.includes("application/json")) return await request.json();

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

  const raw = await request.text();
  try {
    return JSON.parse(raw);
  } catch {
    return Object.fromEntries(new URLSearchParams(raw));
  }
}

function toE164(raw) {
  if (!raw) return null;
  let v = String(raw).trim().replace(/[^\d+]/g, "");
  if (v.startsWith("+")) return /^\+\d{8,15}$/.test(v) ? v : null;
  if (/^0\d{10}$/.test(v)) return "+234" + v.slice(1); // NG helper (optional)
  if (/^(70|80|81|90|91)\d{8}$/.test(v)) return "+234" + v; // NG helper (optional)
  if (/^\d{10}$/.test(v)) return "+1" + v; // US fallback
  return null;
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

export async function OPTIONS(request) {
  return cors(new NextResponse(null, { status: 204 }), pickOrigin(request));
}

export async function POST(request) {
  const origin = pickOrigin(request);

  try {
    if (!KLAVIYO_API_KEY || !WAITLIST_LIST_ID) {
      return cors(
        NextResponse.json(
          {
            success: false,
            error: "Server misconfigured: missing KLAVIYO_API_KEY or KLAVIYO_LIST_ID",
          },
          { status: 500 }
        ),
        origin
      );
    }

    const body = await readBody(request);

    let {
      email,
      phone,
      phone_number,
      full_name,
      first_name,
      last_name,
      sms_consent,
      smsAllowed,
      product_id,
      product_id_raw,
      product_handle,
      handle,
      product_title,
      title,
      related_section_url,
      source,
    } = body || {};

    email = (email || "").toString().trim().toLowerCase();
    const phoneRaw = phone || phone_number || "";
    const phoneE164 = toE164(phoneRaw);

    const smsFlag =
      smsAllowed === true ||
      sms_consent === true ||
      smsAllowed === "true" ||
      sms_consent === "true" ||
      smsAllowed === "on" ||
      sms_consent === "on" ||
      smsAllowed === "1" ||
      sms_consent === "1";

    const pid = product_id || product_id_raw;
    const h = product_handle || handle;

    if (!email || (!pid && !h)) {
      return cors(
        NextResponse.json(
          { success: false, error: "Missing email and product_id or product_handle" },
          { status: 400 }
        ),
        origin
      );
    }

    if (!first_name && !last_name && full_name) {
      const parts = String(full_name).trim().split(/\s+/);
      first_name = parts[0] || "";
      last_name = parts.slice(1).join(" ") || "";
    }

    const productId = pid ? String(pid) : "";
    const productHandle = h ? String(h) : "";
    const productTitle = product_title || title || "Unknown Product";
    const productUrl = productHandle
      ? `https://${PUBLIC_STORE_DOMAIN}/products/${productHandle}`
      : "";

    const upsertedBase = {
      email,
      phone: phoneE164 || "",
      first_name: first_name || "",
      last_name: last_name || "",
      sms_consent: !!smsFlag,
      product_id: productId,
      product_title: productTitle,
      product_handle: productHandle,
      product_url: productUrl,
      related_section_url: related_section_url || "",
      created_at: new Date().toISOString(),
      source: source || "shopify_form",
    };

    // Best-effort Redis
    let redis_ok = false;
    let subscriber_count = null;

    const ping = await safeRedisPing();
    redis_ok = ping.ok;

    if (redis_ok) {
      try {
        const idKey = `subscribers:${productId}`;
        const handleKey = productHandle ? `subscribers_handle:${productHandle}` : null;

        const readList = async (key) => {
          if (!key) return [];
          try {
            const v = await redis.get(key);
            if (Array.isArray(v)) return v;
            if (typeof v === "string") {
              try {
                return JSON.parse(v);
              } catch {
                return [];
              }
            }
            return [];
          } catch {
            return [];
          }
        };

        const existing = await readList(idKey);
        const existsAlready = existing.some(
          (x) => (x?.email || "").toLowerCase() === email
        );

        const merged = existsAlready ? existing : [...existing, upsertedBase];

        const writes = [redis.set(idKey, merged, { ex: 90 * 24 * 60 * 60 })];
        if (handleKey) writes.push(redis.set(handleKey, merged, { ex: 90 * 24 * 60 * 60 }));

        await Promise.all(writes);
        subscriber_count = merged.length;
      } catch (e) {
        redis_ok = false;
        console.error("[/api/back-in-stock] redis write failed:", e?.message || e);
      }
    }

    // 1) Klaviyo list subscribe (authoritative)
    const out = await subscribeProfilesToList({
      listId: WAITLIST_LIST_ID,
      email,
      phoneE164,
      sms: !!smsFlag,
    });

    // 2) Stamp profile props (best-effort)
    updateProfileProperties({
      email,
      properties: {
        last_waitlist_product_name: productTitle,
        last_waitlist_product_url: productUrl,
        last_waitlist_related_section_url: related_section_url || "",
        last_waitlist_product_handle: productHandle,
        last_waitlist_product_id: productId,
        last_waitlist_source: source || "shopify_form",
        last_waitlist_at: new Date().toISOString(),
      },
    }).catch(() => {});

    // 3) Track event (best-effort)
    trackKlaviyoEvent({
      metricName: "Back In Stock Request",
      email,
      phoneE164,
      properties: {
        product_id: productId,
        product_handle: productHandle,
        product_title: productTitle,
        product_url: productUrl,
        related_section_url: related_section_url || "",
        sms_consent: !!smsFlag,
      },
    }).catch(() => {});

    return cors(
      NextResponse.json({
        success: true,
        email,
        product_id: productId,
        product_handle: productHandle,
        subscriber_count,
        redis_ok,
        klaviyo_success: out.ok,
        klaviyo_status: out.status,
      }),
      origin
    );
  } catch (error) {
    console.error("[/api/back-in-stock] fatal:", error);
    return cors(
      NextResponse.json(
        { success: false, error: "Server error. Please try again." },
        { status: 500 }
      ),
      origin
    );
  }
}

/* ----------------- Klaviyo helpers ----------------- */
async function subscribeProfilesToList({ listId, email, phoneE164, sms }) {
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
                ...(phoneE164 ? { phone_number: phoneE164 } : {}),
                subscriptions,
              },
            },
          ],
        },
      },
      relationships: {
        list: { data: { type: "list", id: listId } },
      },
    },
  };

  const res = await fetch(
    "https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/",
    {
      method: "POST",
      headers: {
        Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
        accept: "application/json",
        "content-type": "application/json",
        revision: "2023-10-15",
      },
      body: JSON.stringify(payload),
    }
  );

  const txt = await res.text();
  if (!res.ok) throw new Error(`Klaviyo subscribe failed: ${res.status} ${res.statusText} :: ${txt}`);
  return { ok: true, status: res.status, body: txt };
}

async function updateProfileProperties({ email, properties }) {
  const filter = `equals(email,"${String(email).replace(/"/g, '\\"')}")`;
  const listRes = await fetch(
    `https://a.klaviyo.com/api/profiles/?filter=${encodeURIComponent(filter)}&page[size]=1`,
    {
      method: "GET",
      headers: {
        Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
        accept: "application/json",
        revision: "2023-10-15",
      },
    }
  );

  const listTxt = await listRes.text();
  if (!listRes.ok) throw new Error(`Profile lookup failed: ${listRes.status} ${listRes.statusText} :: ${listTxt}`);

  const parsed = JSON.parse(listTxt);
  const profileId = parsed?.data?.[0]?.id;
  if (!profileId) throw new Error("Profile not found in Klaviyo (yet)");

  const patchBody = {
    data: {
      type: "profile",
      id: profileId,
      attributes: { properties: properties || {} },
    },
  };

  const patchRes = await fetch(`https://a.klaviyo.com/api/profiles/${profileId}/`, {
    method: "PATCH",
    headers: {
      Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
      accept: "application/json",
      "content-type": "application/json",
      revision: "2023-10-15",
    },
    body: JSON.stringify(patchBody),
  });

  const txt = await patchRes.text();
  if (!patchRes.ok) throw new Error(`Profile PATCH failed: ${patchRes.status} ${patchRes.statusText} :: ${txt}`);
  return { ok: true, status: patchRes.status, body: txt };
}

async function trackKlaviyoEvent({ metricName, email, phoneE164, properties }) {
  const body = {
    data: {
      type: "event",
      attributes: {
        metric: { data: { type: "metric", attributes: { name: metricName } } },
        profile: {
          data: {
            type: "profile",
            attributes: {
              ...(email ? { email } : {}),
              ...(phoneE164 ? { phone_number: phoneE164 } : {}),
            },
          },
        },
        properties: properties || {},
        time: new Date().toISOString(),
      },
    },
  };

  const res = await fetch("https://a.klaviyo.com/api/events/", {
    method: "POST",
    headers: {
      Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
      accept: "application/json",
      "content-type": "application/json",
      revision: "2023-10-15",
    },
    body: JSON.stringify(body),
  });

  const txt = await res.text();
  if (!res.ok) throw new Error(`Klaviyo event failed: ${res.status} ${res.statusText} :: ${txt}`);
  return { ok: true, status: res.status, body: txt };
}

export const runtime = "nodejs";

// Change this to your store domain
const ALLOWED_ORIGINS = new Set([
  "https://armadillotough.com",
  "https://www.armadillotough.com",
  "http://localhost:3000",
]);

function corsHeaders(origin) {
  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "https://armadillotough.com";
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
    "vary": "Origin",
  };
}

function json(body, status = 200, origin = "") {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...corsHeaders(origin),
    },
  });
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function safeString(v, max = 200) {
  if (v === undefined || v === null) return "";
  return String(v).trim().slice(0, max);
}

async function klaviyoRequest(path, { method = "GET", body } = {}) {
  const base = process.env.KV_REST_API_URL || "https://a.klaviyo.com";
  const url = `${base}${path}`;

  const apiKey = process.env.KLAVIYO_API_KEY || process.env.KV_REST_API_TOKEN;
  if (!apiKey) throw new Error("Missing KLAVIYO_API_KEY (or KV_REST_API_TOKEN)");

  const res = await fetch(url, {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      // Klaviyo uses this header for private API keys
      authorization: `Klaviyo-API-Key ${apiKey}`,
      // Use the latest stable revision you’re already using in your project if different
      revision: "2024-10-15",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const msg =
      data?.errors?.[0]?.detail ||
      data?.message ||
      data?.raw ||
      `Klaviyo error (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.klaviyo = data;
    throw err;
  }

  return data;
}

async function upsertProfile({ email, properties }) {
  // Create/Update a profile (Klaviyo will dedupe by email)
  const payload = {
    data: {
      type: "profile",
      attributes: {
        email,
        ...properties,
      },
    },
  };

  const created = await klaviyoRequest("/api/profiles/", {
    method: "POST",
    body: payload,
  });

  const profileId = created?.data?.id;
  if (!profileId) throw new Error("Klaviyo did not return a profile id");
  return profileId;
}

async function addProfileToList({ listId, profileId }) {
  const payload = {
    data: [{ type: "profile", id: profileId }],
  };

  // Add profile relationship to list
  await klaviyoRequest(`/api/lists/${listId}/relationships/profiles/`, {
    method: "POST",
    body: payload,
  });
}

async function trackBackInStockEvent({ email, properties }) {
  // Optional: useful for debugging and segmentation in Klaviyo
  const payload = {
    data: {
      type: "event",
      attributes: {
        metric: {
          data: {
            type: "metric",
            attributes: {
              name: "Back In Stock Signup",
            },
          },
        },
        profile: {
          data: {
            type: "profile",
            attributes: { email },
          },
        },
        properties,
        time: new Date().toISOString(),
      },
    },
  };

  await klaviyoRequest("/api/events/", {
    method: "POST",
    body: payload,
  });
}

export async function OPTIONS(req) {
  const origin = req.headers.get("origin") || "";
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export async function POST(req) {
  const origin = req.headers.get("origin") || "";

  try {
    const body = await req.json().catch(() => ({}));

    const email = normalizeEmail(body.email);
    const product_id = safeString(body.product_id, 64);
    const product_handle = safeString(body.product_handle, 255);
    const product_title = safeString(body.product_title, 255);
    const source = safeString(body.source || "pdp_back_in_stock", 80);

    // Validation (matches the error you were seeing)
    if (!email) {
      return json({ success: false, error: "Missing email" }, 400, origin);
    }
    if (!product_id && !product_handle) {
      return json(
        { success: false, error: "Missing email and product_id or product_handle" },
        400,
        origin
      );
    }

    const listId =
      process.env.KLAVIYO_BACK_IN_STOCK_ALERT_LIST_ID ||
      process.env.KLAVIYO_LIST_ID;

    if (!listId) {
      return json(
        { success: false, error: "Missing KLAVIYO_BACK_IN_STOCK_ALERT_LIST_ID (or KLAVIYO_LIST_ID)" },
        500,
        origin
      );
    }

    // 1) Upsert Profile with extra properties
    const profileId = await upsertProfile({
      email,
      properties: {
        // these show in Klaviyo profile properties
        source,
        last_back_in_stock_handle: product_handle || null,
        last_back_in_stock_product_id: product_id || null,
        last_back_in_stock_title: product_title || null,
        last_back_in_stock_at: new Date().toISOString(),
      },
    });

    // 2) Add to list (this is the “remind me” list)
    await addProfileToList({ listId, profileId });

    // 3) Optional: track event for segmentation + debugging
    await trackBackInStockEvent({
      email,
      properties: {
        product_id: product_id || null,
        product_handle: product_handle || null,
        product_title: product_title || null,
        source,
        origin,
      },
    });

    return json(
      {
        success: true,
        profile_id: profileId,
        list_id: listId,
        message: "Subscribed to back-in-stock list and tracked event",
      },
      200,
      origin
    );
  } catch (err) {
    const origin = req.headers.get("origin") || "";

    // Log full error server-side
    console.error("Back-in-stock error:", err);

    const status = err?.status && Number.isInteger(err.status) ? err.status : 500;
    return json(
      {
        success: false,
        error: err?.message || "Internal Server Error",
      },
      status,
      origin
    );
  }
}

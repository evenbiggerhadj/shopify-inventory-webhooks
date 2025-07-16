await fetch("https://shopify-inventory-webhooks.vercel.app/api/klaviyo-back-in-stock", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      data: {
        type: "event",
        attributes: {
          profile: {
            email: email,
            phone_number: phone
          },
          metric: {
            name: "Back-in-Stock Request"
          },
          properties: {
            variant_id: variantId,
            variant_title: variantTitle,
            product_handle: productHandle
          },
          time: new Date().toISOString()
        }
      }
    })
  });
  
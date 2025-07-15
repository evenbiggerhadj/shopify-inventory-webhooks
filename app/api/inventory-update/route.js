export async function POST(req) {
  try {
    const body = await req.json();
    const inventoryItemId = body.inventory_item_id;
    const availableQty = body.available;

    const inventoryResponse = await fetch(`https://${process.env.SHOPIFY_STORE}/admin/api/2023-01/inventory_items/${inventoryItemId}.json`, {
      headers: {
        "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_API_KEY,
        "Content-Type": "application/json",
      },
    });
    const inventoryItem = await inventoryResponse.json();
    const variantId = inventoryItem.inventory_item.admin_graphql_api_id.split("/").pop();

    const variantResponse = await fetch(`https://${process.env.SHOPIFY_STORE}/admin/api/2023-01/variants/${variantId}.json`, {
      headers: {
        "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_API_KEY,
        "Content-Type": "application/json",
      },
    });
    const variantData = await variantResponse.json();
    const productId = variantData.variant.product_id;

    const productResponse = await fetch(`https://${process.env.SHOPIFY_STORE}/admin/api/2023-01/products/${productId}.json`, {
      headers: {
        "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_API_KEY,
        "Content-Type": "application/json",
      },
    });
    const productData = await productResponse.json();
    const product = productData.product;
    const isBundle = product.tags.includes('bundle');

    let shouldNotify = false;
    let bundleComponents = [];

    if (isBundle) {
      const metafieldsResponse = await fetch(`https://${process.env.SHOPIFY_STORE}/admin/api/2023-01/products/${productId}/metafields.json`, {
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_API_KEY,
          "Content-Type": "application/json",
        },
      });
      const metafieldsData = await metafieldsResponse.json();
      const componentsField = metafieldsData.metafields.find((m) => m.namespace === "custom" && m.key === "bundle_structure");
      bundleComponents = componentsField ? JSON.parse(componentsField.value) : [];
    }

    if (isBundle && bundleComponents.length > 0) {
      for (const component of bundleComponents) {
        const variantResponse = await fetch(`https://${process.env.SHOPIFY_STORE}/admin/api/2023-01/variants/${component.variant_id}.json`, {
          headers: {
            "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_API_KEY,
            "Content-Type": "application/json",
          },
        });

        const variantData = await variantResponse.json();
        const inventoryQty = variantData.variant.inventory_quantity;

        if (inventoryQty < component.required_quantity) {
          shouldNotify = false;
          break;
        } else {
          shouldNotify = true;
        }
      }
    } else {
      shouldNotify = availableQty > 0;
    }

    if (shouldNotify) {
      if (isBundle) {
        const klaviyoResponse = await fetch(`https://a.klaviyo.com/api/profiles/?filter=properties[productHandle]=${product.handle}`, {
          headers: {
            "Authorization": "Klaviyo-API-Key " + process.env.KLAVIYO_API_KEY,
            "Content-Type": "application/json",
          },
        });
        const profilesData = await klaviyoResponse.json();
        const emailsToNotify = profilesData.data.map(profile => profile.attributes.email);

        for (const email of emailsToNotify) {
          await fetch("https://a.klaviyo.com/api/events/", {
            method: "POST",
            headers: {
              "Authorization": "Klaviyo-API-Key " + process.env.KLAVIYO_API_KEY,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              data: {
                type: "event",
                attributes: {
                  profile: { email },
                  metric: { name: "Restock Notification" },
                  properties: { product: product.handle },
                  time: new Date().toISOString()
                },
              },
            }),
          });
        }
      } else {
        const klaviyoResponse = await fetch(`https://a.klaviyo.com/api/profiles/?filter=properties[variantId]=${variantId}`, {
          headers: {
            "Authorization": "Klaviyo-API-Key " + process.env.KLAVIYO_API_KEY,
            "Content-Type": "application/json",
          },
        });
        const profilesData = await klaviyoResponse.json();
        const emailsToNotify = profilesData.data.map(profile => profile.attributes.email);

        for (const email of emailsToNotify) {
          await fetch("https://a.klaviyo.com/api/events/", {
            method: "POST",
            headers: {
              "Authorization": "Klaviyo-API-Key " + process.env.KLAVIYO_API_KEY,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              data: {
                type: "event",
                attributes: {
                  profile: { email },
                  metric: { name: "Restock Notification" },
                  properties: { variantId },
                  time: new Date().toISOString()
                },
              },
            }),
          });
        }
      }
    }

    return new Response(JSON.stringify({ success: true }), { status: 200 });
  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500 });
  }
}

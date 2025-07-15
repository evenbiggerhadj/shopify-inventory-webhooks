export async function GET() {
    try {
      // 1️⃣ Fetch ALL bundles with 'bundle' tag
      const bundlesResponse = await fetch(`https://${process.env.SHOPIFY_STORE}/admin/api/2023-01/products.json?limit=250&fields=id,title,handle,tags`, {
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_API_KEY,
          "Content-Type": "application/json",
        },
      });
      const bundlesData = await bundlesResponse.json();
  
      const bundleProducts = bundlesData.products.filter((p) =>
        p.tags.toLowerCase().includes('bundle')
      );
  
      for (const product of bundleProducts) {
        // 2️⃣ Fetch bundle metafield for components
        const metafieldsResponse = await fetch(
          `https://${process.env.SHOPIFY_STORE}/admin/api/2023-01/products/${product.id}/metafields.json`,
          {
            headers: {
              "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_API_KEY,
              "Content-Type": "application/json",
            },
          }
        );
        const metafieldsData = await metafieldsResponse.json();
        const componentsField = metafieldsData.metafields?.find(
          (m) => m.namespace === "custom" && m.key === "bundle_structure"
        );
  
        if (!componentsField) continue;
  
        const bundleComponents = JSON.parse(componentsField.value);
        let shouldNotify = true;
  
        // 3️⃣ Loop through components, check inventory safely
        for (const component of bundleComponents) {
          const variantResponse = await fetch(
            `https://${process.env.SHOPIFY_STORE}/admin/api/2023-01/variants/${component.variant_id}.json`,
            {
              headers: {
                "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_API_KEY,
                "Content-Type": "application/json",
              },
            }
          );
  
          const variantData = await variantResponse.json();
          if (!variantData || !variantData.variant) {
            console.warn(`Variant ID ${component.variant_id} not found in Shopify. Skipping.`);
            shouldNotify = false;
            break;
          }
  
          const inventoryQty = variantData.variant.inventory_quantity;
          if (inventoryQty < component.required_quantity) {
            shouldNotify = false;
            break;
          }
        }
  
        // 4️⃣ If bundle is buildable, notify via Klaviyo
        if (shouldNotify) {
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
                  profile: { email: "test@example.com" }, // Replace with real captured email per bundle
                  metric: { name: "Restock Notification" },
                  properties: { product: product.handle },
                  time: new Date().toISOString(),
                },
              },
            }),
          });
        }
      }
  
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    } catch (error) {
      console.error(error);
      return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500 });
    }
  }
  
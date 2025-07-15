export async function GET() {
    try {
      const productId = 'YOUR_BUNDLE_PRODUCT_ID'; // Your bundle product ID here
      const response = await fetch(`https://${process.env.SHOPIFY_STORE}/admin/api/2023-01/products/${productId}/metafields.json`, {
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_API_KEY,
          "Content-Type": "application/json",
        },
      });
  
      const data = await response.json();
      const componentsField = data.metafields.find((m) => m.namespace === "custom" && m.key === "bundle_structure");
      const bundleComponents = componentsField ? JSON.parse(componentsField.value) : [];
  
      let shouldNotify = true;
  
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
        }
      }
  
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
                profile: { email: 'test@example.com' }, // For real: Pull from Klaviyo profiles API tied to this product
                metric: { name: "Restock Notification" },
                properties: { product: 'your-bundle-product-handle' },
                time: new Date().toISOString()
              },
            },
          }),
        });
      }
  
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    } catch (error) {
      console.error(error);
      return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500 });
    }
  }
  
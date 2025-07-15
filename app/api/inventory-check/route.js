export async function GET() {
    try {
      const bundleComponents = [
        { variant_id: "41703520862392", required_quantity: 4 },
        { variant_id: "41703520895160", required_quantity: 4 },
        { variant_id: "41703520927928", required_quantity: 4 },
        { variant_id: "41728396296376", required_quantity: 2 },
        { variant_id: "41728396329144", required_quantity: 2 },
        { variant_id: "41728396361912", required_quantity: 2 },
        { variant_id: "41728423297208", required_quantity: 4 },
        { variant_id: "41728423329976", required_quantity: 4 },
        { variant_id: "41728423362744", required_quantity: 4 },
        { variant_id: "7173378244792", required_quantity: 2 },
      ];
  
      let shouldNotify = true;
  
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
                profile: { email: "test@example.com" }, // Replace when you connect real Klaviyo form
                metric: { name: "Restock Notification" },
                properties: { product: "manual-product-handle" },
                time: new Date().toISOString(),
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
  
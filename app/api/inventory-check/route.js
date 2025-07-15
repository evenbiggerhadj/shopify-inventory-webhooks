export async function GET() {
    try {
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
            shouldNotify = false;
            break;
          }
  
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
                  "Authorization": "Klaviyo-API-Key YOUR_PRIVATE_API_KEY",
                  "Content-Type": "application/json",
                  "revision": "2023-02-22"
                },
                body: JSON.stringify({
                  data: {
                    type: "event",
                    attributes: {
                      properties: {
                        action: "Restock Notification",
                        product: "Test Product"
                      },
                      metric: {
                        data: {
                          type: "metric",
                          attributes: {
                            name: "Restock Notification"
                          }
                        }
                      },
                      profile: {
                        data: {
                          type: "profile",
                          attributes: {
                            email: "jndubisi79@gmail.com"
                          }
                        }
                      },
                      time: new Date().toISOString(),
                      unique_id: crypto.randomUUID()
                    }
                  }
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
  
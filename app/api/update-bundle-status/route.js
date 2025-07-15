export async function GET() {
    try {
      const bundlesResponse = await fetch(
        `https://${process.env.SHOPIFY_STORE}/admin/api/2023-01/products.json?limit=250&fields=id,title,handle,tags`,
        {
          headers: {
            "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_API_KEY,
            "Content-Type": "application/json",
          },
        }
      );
  
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
        let status = "in_stock"; // default assumption
        let hasZero = false;
  
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
          const inventoryQty = variantData.variant?.inventory_quantity ?? 0;
  
          if (inventoryQty < component.required_quantity) {
            status = "understocked";
          }
  
          if (inventoryQty === 0) {
            status = "out_of_stock";
            hasZero = true;
            break;
          }
        }
  
        const existingStatusField = metafieldsData.metafields.find(
          (m) => m.namespace === "custom" && m.key === "bundle_stock_status"
        );
  
        const method = existingStatusField ? "PUT" : "POST";
        const metafieldId = existingStatusField?.id;
  
        const endpoint = existingStatusField
          ? `https://${process.env.SHOPIFY_STORE}/admin/api/2023-01/metafields/${metafieldId}.json`
          : `https://${process.env.SHOPIFY_STORE}/admin/api/2023-01/metafields.json`;
  
        const body = existingStatusField
          ? {
              metafield: {
                id: metafieldId,
                namespace: "custom",
                key: "bundle_stock_status",
                type: "single_line_text_field",
                value: status,
              },
            }
          : {
              metafield: {
                namespace: "custom",
                key: "bundle_stock_status",
                type: "single_line_text_field",
                value: status,
                owner_resource: "product",
                owner_id: product.id,
              },
            };
  
        await fetch(endpoint, {
          method,
          headers: {
            "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
      }
  
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    } catch (error) {
      console.error(error);
      return new Response(
        JSON.stringify({ success: false, error: error.message }),
        { status: 500 }
      );
    }
  }
  
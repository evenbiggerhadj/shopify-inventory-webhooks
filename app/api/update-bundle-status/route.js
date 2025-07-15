export async function GET() {
    const store = process.env.SHOPIFY_STORE;
    const token = process.env.SHOPIFY_ADMIN_API_KEY;
  
    try {
      const productsResponse = await fetch(`https://${store}/admin/api/2023-01/products.json?limit=250&fields=id,title,handle,tags,variants`, {
        headers: {
          "X-Shopify-Access-Token": token,
          "Content-Type": "application/json",
        },
      });
      const productsData = await productsResponse.json();
      const products = productsData.products;
  
      for (const product of products) {
        let status = 'in_stock';
  
        const anyVariantOutOfStock = product.variants.some(v => v.inventory_quantity <= 0);
        if (anyVariantOutOfStock) {
          status = 'variant_out_of_stock';
        }
  
        if (product.tags.toLowerCase().includes('bundle')) {
          const metafieldsResponse = await fetch(`https://${store}/admin/api/2023-01/products/${product.id}/metafields.json`, {
            headers: {
              "X-Shopify-Access-Token": token,
              "Content-Type": "application/json",
            },
          });
          const metafieldsData = await metafieldsResponse.json();
          const componentsField = metafieldsData.metafields?.find(m => m.namespace === "custom" && m.key === "bundle_structure");
  
          if (componentsField) {
            const bundleComponents = JSON.parse(componentsField.value);
            let allZero = true;
            let understocked = false;
  
            for (const component of bundleComponents) {
              const variantRes = await fetch(`https://${store}/admin/api/2023-01/variants/${component.variant_id}.json`, {
                headers: {
                  "X-Shopify-Access-Token": token,
                  "Content-Type": "application/json",
                },
              });
              const variantData = await variantRes.json();
              const qty = variantData?.variant?.inventory_quantity || 0;
  
              if (qty > 0) allZero = false;
              if (qty < component.required_quantity) understocked = true;
            }
  
            if (allZero) {
              status = 'bundle_out_of_stock';
            } else if (understocked) {
              status = 'bundle_understocked';
            }
          }
        }
  
        await fetch(`https://${store}/admin/api/2023-01/products/${product.id}/metafields.json`, {
          method: 'POST',
          headers: {
            "X-Shopify-Access-Token": token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            metafield: {
              namespace: "custom",
              key: "bundle_stock_status",
              type: "single_line_text_field",
              value: status
            }
          }),
        });
      }
  
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    } catch (error) {
      console.error(error);
      return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500 });
    }
  }
  
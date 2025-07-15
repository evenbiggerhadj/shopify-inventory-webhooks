import { NextResponse } from 'next/server';

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE;
const ADMIN_API_KEY = process.env.SHOPIFY_ADMIN_API_KEY;

const shopifyHeaders = {
  'X-Shopify-Access-Token': ADMIN_API_KEY,
  'Content-Type': 'application/json',
};

export async function GET() {
  try {
    // 1️⃣ Get all bundle products
    const productsResponse = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/2024-04/products.json?fields=id,tags&limit=250`,
      { headers: shopifyHeaders }
    );
    const productsData = await productsResponse.json();
    const bundleProducts = productsData.products.filter((p) => p.tags.includes('bundle'));

    // 2️⃣ Loop through bundles and process components
    for (const bundle of bundleProducts) {
      const metafieldsResponse = await fetch(
        `https://${SHOPIFY_DOMAIN}/admin/api/2024-04/products/${bundle.id}/metafields.json`,
        { headers: shopifyHeaders }
      );
      const metafieldsData = await metafieldsResponse.json();
      const componentsField = metafieldsData.metafields.find(
        (m) => m.namespace === 'custom' && m.key === 'bundle_components'
      );

      if (!componentsField) continue;

      const components = JSON.parse(componentsField.value);
      let stockStatus = 'in_stock';

      for (const component of components) {
        const inventoryResponse = await fetch(
          `https://${SHOPIFY_DOMAIN}/admin/api/2024-04/inventory_levels.json?inventory_item_ids=${component.inventory_item_id}`,
          { headers: shopifyHeaders }
        );
        const inventoryData = await inventoryResponse.json();
        const available = inventoryData.inventory_levels[0]?.available ?? 0;

        if (available === 0) {
          stockStatus = 'out_of_stock';
          break;
        } else if (available < component.quantity) {
          stockStatus = 'understocked';
        }
      }

      // 3️⃣ Update metafield with bundle stock status
      await fetch(
        `https://${SHOPIFY_DOMAIN}/admin/api/2024-04/metafields.json`,
        {
          method: 'POST',
          headers: shopifyHeaders,
          body: JSON.stringify({
            metafield: {
              namespace: 'custom',
              key: 'bundle_stock_status',
              type: 'single_line_text_field',
              value: stockStatus,
              owner_resource: 'product',
              owner_id: bundle.id,
            },
          }),
        }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ success: false, error: error.message });
  }
}

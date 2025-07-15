export default async function handler(req, res) {
    const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
    const API_TOKEN = process.env.SHOPIFY_API_TOKEN;
    const BASE_URL = `https://${SHOPIFY_STORE}/admin/api/2024-04`;
  
    async function shopifyFetch(path) {
      const response = await fetch(`${BASE_URL}${path}`, {
        headers: {
          'X-Shopify-Access-Token': API_TOKEN,
          'Content-Type': 'application/json',
        },
      });
      return response.json();
    }
  
    async function updateMetafield(productId, status) {
      await fetch(`${BASE_URL}/products/${productId}/metafields.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': API_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          metafield: {
            namespace: 'custom',
            key: 'bundle_stock_status',
            type: 'single_line_text_field',
            value: status,
          },
        }),
      });
    }
  
    const taggedProducts = await shopifyFetch('/products.json?limit=250&fields=id,tags');
    const bundles = taggedProducts.products.filter(p => p.tags.includes('bundles'));
  
    for (const bundle of bundles) {
      const metafieldsRes = await shopifyFetch(`/products/${bundle.id}/metafields.json`);
      const metafield = metafieldsRes.metafields.find(mf => mf.namespace === 'custom' && mf.key === 'bundle_components');
      if (!metafield) continue;
  
      const components = JSON.parse(metafield.value);
      let understocked = false;
  
      for (const component of components) {
        const productId = component.product_id.split('/').pop();
        const productData = await shopifyFetch(`/products/${productId}.json`);
        const inventoryId = productData.product.variants[0].inventory_item_id;
        const inventoryRes = await shopifyFetch(`/inventory_levels.json?inventory_item_ids=${inventoryId}`);
        const available = inventoryRes.inventory_levels[0]?.available || 0;
  
        if (available < component.quantity) {
          understocked = true;
          break;
        }
      }
  
      await updateMetafield(bundle.id, understocked ? 'understocked' : 'in_stock');
    }
  
    res.status(200).json({ success: true, message: 'All bundles checked and updated.' });
  }
  
export async function POST(req) {
  const response = await fetch('https://armadillotough.com/admin/api/2023-07/webhooks.json', {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      webhook: {
        topic: 'inventory_levels/update',
        address: 'https://shopify-inventory-webhooks.vercel.app/api/inventory-update',
        format: 'json',
      },
    }),
  });

  const data = await response.json();
  return new Response(JSON.stringify(data), { status: 200 });
}

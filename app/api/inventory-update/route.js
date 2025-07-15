export async function POST(req) {
    try {
      const body = await req.json();
  
      const inventoryItemId = body.inventory_item_id;
      const availableQty = body.available;
      const locationId = body.location_id;
  
      console.log({
        inventoryItemId,
        availableQty,
        locationId,
      });
  
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    } catch (error) {
      console.error(error);
      return new Response(JSON.stringify({ success: false }), { status: 500 });
    }
  }
  
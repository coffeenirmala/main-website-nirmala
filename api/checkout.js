export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
  const PUNCHES_FOR_FREE = 8;

  async function supabase(method, path, body) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`Supabase ${method} ${path} failed: ${errText}`);
    }
    return r.json();
  }

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const { items, customer_email, redeem_free } = body;
    // items: [{ menu_name, qty }]

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Keranjang kosong' });
    }

    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10); // YYYY-MM-DD
    const ts = Date.now();

    // 1. Ambil harga menu terbaru dari DB (jangan percaya harga dari client)
    const menuNames = items.map((i) => i.menu_name);
    const encodedNames = menuNames.map(encodeURIComponent).join(',');
    const [menuRows, recipeRows] = await Promise.all([
      supabase('GET', `nc_menu?name=in.(${encodedNames})`),
      supabase('GET', `nc_recipe?menu_name=in.(${encodedNames})`),
    ]);
    const menuMap = Object.fromEntries(menuRows.map((m) => [m.name, m]));
    
    for (const it of items) {
      if (!menuMap[it.menu_name]) {
        return res.status(400).json({ error: `Menu "${it.menu_name}" tidak ditemukan` });
      }
    }

    // 3. Hitung total bahan baku yang harus dikurangi (agregat lintas item)
    const deduction = {}; // { ingredient_name: totalQty }
    for (const it of items) {
      const recipesForMenu = recipeRows.filter((r) => r.menu_name === it.menu_name);
      for (const r of recipesForMenu) {
        deduction[r.ingredient_name] = (deduction[r.ingredient_name] || 0) + r.qty_used * it.qty;
      }
    }

    // 4. Cek stok saat ini, siapkan warning kalau kurang (tidak menghalangi transaksi)
    const ingredientNames = Object.keys(deduction);
    const warnings = [];
    if (ingredientNames.length > 0) {
      const stockRows = await supabase(
        'GET',
        `nc_inventory?name=in.(${ingredientNames.map(encodeURIComponent).join(',')})`
      );
      const stockMap = Object.fromEntries(stockRows.map((s) => [s.name, s.stock]));

      for (const ing of ingredientNames) {
        if (!(ing in stockMap)) {
          // Nama bahan di resep tidak match persis dengan nc_inventory (typo, atau
          // belum ditambahkan). Jangan diam-diam gagal — beri tahu kasir/owner.
          warnings.push(`Bahan "${ing}" tidak ditemukan di nc_inventory — stok TIDAK dikurangi untuk bahan ini. Cek nama di resep vs nc_inventory.`);
          continue;
        }
        const currentStock = stockMap[ing];
        const newStock = currentStock - deduction[ing];
        if (newStock < 0) {
          warnings.push(`Stok "${ing}" minus (${newStock}) setelah transaksi ini`);
        }
        await supabase('PATCH', `nc_inventory?name=eq.${encodeURIComponent(ing)}`, {
          stock: newStock,
          updated_at: new Date().toISOString(),
        });
      }
    }

    // 5. Catat penjualan ke nc_sales (satu baris per menu item)
    const salesPayload = items.map((it) => ({
      date: dateStr,
      ts,
      type: 'pos_sale',
      item: it.menu_name,
      qty: it.qty,
      unit: 'pcs',
    }));
    await supabase('POST', 'nc_sales', salesPayload);

    // 6. Loyalty punch (kalau ada customer)
    let punchResult = null;
    if (customer_email) {
      const existing = await supabase(
        'GET',
        `punches?email=eq.${encodeURIComponent(customer_email)}&limit=1`
      );
      const record = existing && existing.length > 0 ? existing[0] : null;

      if (redeem_free) {
        if (!record || record.punches < PUNCHES_FOR_FREE) {
          return res.status(400).json({ error: 'Punch belum cukup untuk redeem gratis' });
        }
        const updated = await supabase('PATCH', `punches?email=eq.${encodeURIComponent(customer_email)}`, {
          punches: record.punches - PUNCHES_FOR_FREE,
          free_redeemed: record.free_redeemed + 1,
          updated_at: new Date().toISOString(),
        });
        punchResult = updated[0];
      } else if (record) {
        const updated = await supabase('PATCH', `punches?email=eq.${encodeURIComponent(customer_email)}`, {
          punches: record.punches + 1,
          total_punches: record.total_punches + 1,
          updated_at: new Date().toISOString(),
        });
        punchResult = updated[0];
      } else {
        const created = await supabase('POST', 'punches', {
          email: customer_email,
          punches: 1,
          total_punches: 1,
          free_redeemed: 0,
        });
        punchResult = created[0];
      }
    }

    const total = items.reduce((sum, it) => sum + menuMap[it.menu_name].price * it.qty, 0);

    return res.status(200).json({
      ok: true,
      total,
      warnings,
      punch: punchResult,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

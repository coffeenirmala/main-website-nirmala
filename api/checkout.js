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
    const { items, customer_email, redeem_free, redeem_item } = body;
    // items: [{ menu_name, qty }]
    // redeem_free: true kalau barista memilih 1 item untuk digratiskan
    // redeem_item: menu_name item yang digratiskan (wajib kalau redeem_free true)

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Keranjang kosong' });
    }

    if (redeem_free && !redeem_item) {
      return res.status(400).json({ error: 'Pilih item yang mau digratiskan (redeem_item wajib diisi)' });
    }
    if (redeem_free && !customer_email) {
      return res.status(400).json({ error: 'Redeem gratis butuh customer_email' });
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

    if (redeem_free) {
      const target = items.find((it) => it.menu_name === redeem_item);
      if (!target || target.qty < 1) {
        return res.status(400).json({ error: `Item redeem "${redeem_item}" tidak ada di keranjang` });
      }
    }

    // PENTING: validasi punch cukup SEBELUM ada mutasi apapun (stok / sales / punch),
    // supaya kalau redeem ditolak, transaksi belum menyentuh data apapun sama sekali.
    let punchRecord = null;
    if (customer_email) {
      const existing = await supabase(
        'GET',
        `punches?email=eq.${encodeURIComponent(customer_email)}&limit=1`
      );
      punchRecord = existing && existing.length > 0 ? existing[0] : null;
    }
    if (redeem_free) {
      if (!punchRecord || punchRecord.punches < PUNCHES_FOR_FREE) {
        return res.status(400).json({ error: 'Punch belum cukup untuk redeem gratis (butuh 8/8)' });
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
      
      await Promise.all(ingredientNames.map((ing) => {
        if (!(ing in stockMap)) {
          warnings.push(`Bahan "${ing}" tidak ditemukan di nc_inventory — stok TIDAK dikurangi untuk bahan ini. Cek nama di resep vs nc_inventory.`);
          return null;
        }
        const currentStock = stockMap[ing];
        const newStock = currentStock - deduction[ing];
        if (newStock < 0) {
          warnings.push(`Stok "${ing}" minus (${newStock}) setelah transaksi ini`);
        }
        return supabase('PATCH', `nc_inventory?name=eq.${encodeURIComponent(ing)}`, {
          stock: newStock,
          updated_at: new Date().toISOString(),
        });
      }));
    }

// 5a. Catat penjualan ke nc_sales (satu baris per menu item) — dipakai sales-report.js untuk omzet
    // Kalau ada item yang di-redeem gratis, pisahkan 1 pcs-nya jadi baris 'pos_sale_free'
    // (qty gratis = 1, tetap tercatat untuk potong stok bahan baku, tapi TIDAK dihitung sebagai omzet)
    const salesPayload = [];
    for (const it of items) {
      if (redeem_free && it.menu_name === redeem_item) {
        const paidQty = it.qty - 1;
        if (paidQty > 0) {
          salesPayload.push({ date: dateStr, ts, type: 'pos_sale', item: it.menu_name, qty: paidQty, unit: 'pcs' });
        }
        salesPayload.push({ date: dateStr, ts, type: 'pos_sale_free', item: it.menu_name, qty: 1, unit: 'pcs' });
      } else {
        salesPayload.push({ date: dateStr, ts, type: 'pos_sale', item: it.menu_name, qty: it.qty, unit: 'pcs' });
      }
    }

    // 5b. Catat pemakaian bahan baku per gramasi (dari `deduction` di langkah 3) —
    // type:'manual' supaya kebaca sama seperti input manual barista di Forecast,
    // Dashboard, dan Export Laporan (Log Harian & Ringkasan Pemakaian).
    const unitMap = {};
    for (const r of recipeRows) unitMap[r.ingredient_name] = r.unit;
    const ingredientSalesPayload = ingredientNames.map((ing) => ({
      date: dateStr,
      ts,
      type: 'manual',
      item: ing,
      qty: Number(deduction[ing].toFixed(3)),
      unit: unitMap[ing] || '',
    }));

    await supabase('POST', 'nc_sales', [...salesPayload, ...ingredientSalesPayload]);

    // 6. Loyalty punch (kalau ada customer)
    // Catatan: kalau redeem_free, transaksi ini TIDAK menambah punch baru (customer memakai
    // hadiah gratisnya, bukan menabung punch baru dari transaksi yang sama).
    let punchResult = null;
    if (customer_email) {
      if (redeem_free) {
        const updated = await supabase('PATCH', `punches?email=eq.${encodeURIComponent(customer_email)}`, {
          punches: punchRecord.punches - PUNCHES_FOR_FREE,
          free_redeemed: punchRecord.free_redeemed + 1,
          updated_at: new Date().toISOString(),
        });
        punchResult = updated[0];
      } else if (punchRecord) {
        const updated = await supabase('PATCH', `punches?email=eq.${encodeURIComponent(customer_email)}`, {
          punches: punchRecord.punches + 1,
          total_punches: punchRecord.total_punches + 1,
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

    // 7. Total yang harus dibayar — kurangi harga 1 pcs dari item yang di-redeem gratis
    let total = items.reduce((sum, it) => sum + menuMap[it.menu_name].price * it.qty, 0);
    if (redeem_free) {
      total -= menuMap[redeem_item].price;
    }

    return res.status(200).json({
      ok: true,
      total,
      warnings,
      punch: punchResult,
      redeemed_item: redeem_free ? redeem_item : null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

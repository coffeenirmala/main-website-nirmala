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
    const { items, customer_email, redeem_free, redeem_item, promo_id } = body;
    // items: [{ menu_name, qty }] — menu_name bisa nama menu biasa ATAU nama promo bundle/bundle_qty
    // redeem_free: true kalau barista memilih 1 item untuk digratiskan
    // redeem_item: menu_name item yang digratiskan (wajib kalau redeem_free true, HARUS menu biasa)
    // promo_id: id promo diskon (nc_promos) yang dipakai — tidak boleh bareng redeem_free

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Keranjang kosong' });
    }

    if (redeem_free && !redeem_item) {
      return res.status(400).json({ error: 'Pilih item yang mau digratiskan (redeem_item wajib diisi)' });
    }
    if (redeem_free && !customer_email) {
      return res.status(400).json({ error: 'Redeem gratis butuh customer_email' });
    }
    if (redeem_free && promo_id) {
      return res.status(400).json({ error: 'Redeem gratis dan promo diskon tidak boleh dipakai bersamaan' });
    }
    // Server Vercel jalan di UTC, tapi toko beroperasi di WIB (UTC+7).
    // Kalau pakai waktu server langsung, jam 16:05 WIB kebaca sebagai 09:05,
    // jadi salah tolak promo happy hour yang lagi aktif.
    function nowWIB() {
      const utcNow = new Date();
      return new Date(utcNow.getTime() + 7 * 60 * 60 * 1000); // UTC+7
    }
    const wib = nowWIB();
    const dateStr = wib.toISOString().slice(0, 10); // YYYY-MM-DD, sudah WIB
    const nowTime = wib.toISOString().slice(11, 16); // HH:MM, sudah WIB
    const ts = Date.now();

    // 1. Ambil harga menu terbaru DAN promo bundle terkait dari DB (jangan percaya harga dari client)
    const itemNames = items.map((i) => i.menu_name);
    const encodedNames = itemNames.map(encodeURIComponent).join(',');
    const [menuRows, bundlePromoRows] = await Promise.all([
      supabase('GET', `nc_menu?name=in.(${encodedNames})`),
      supabase('GET', `nc_promos?name=in.(${encodedNames})&type=in.(bundle,bundle_qty)`),
    ]);
    const menuMap = Object.fromEntries(menuRows.map((m) => [m.name, m]));
    const bundleMap = Object.fromEntries(bundlePromoRows.map((p) => [p.name, p])); // key = nama promo bundle

    // Validasi tiap baris keranjang: harus menu biasa ATAU promo bundle yang masih berlaku
    for (const it of items) {
      const isMenu = !!menuMap[it.menu_name];
      const bundle = bundleMap[it.menu_name];
      if (!isMenu && !bundle) {
        return res.status(400).json({ error: `Menu "${it.menu_name}" tidak ditemukan` });
      }
      if (bundle) {
        if (!bundle.active || dateStr < bundle.valid_from || dateStr > bundle.valid_until) {
          return res.status(400).json({ error: `Promo bundle "${it.menu_name}" sudah tidak aktif atau di luar periode berlaku` });
        }
        if (bundle.time_from && bundle.time_until) {
          const from = bundle.time_from.slice(0, 5);
          const until = bundle.time_until.slice(0, 5);
          if (!(nowTime >= from && nowTime <= until)) {
            return res.status(400).json({ error: `Promo bundle "${it.menu_name}" hanya berlaku jam ${from}-${until}` });
          }
        }
      }
    }

    if (redeem_free) {
      const target = items.find((it) => it.menu_name === redeem_item);
      if (!target || target.qty < 1) {
        return res.status(400).json({ error: `Item redeem "${redeem_item}" tidak ada di keranjang` });
      }
      if (bundleMap[redeem_item]) {
        return res.status(400).json({ error: 'Item bundle tidak bisa dijadikan redeem gratis' });
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

    // 2b. Validasi & ambil promo diskon dari DB (jangan percaya nominal dari client)
    let appliedPromo = null;
    if (promo_id) {
      const promoRows = await supabase('GET', `nc_promos?id=eq.${promo_id}&limit=1`);
      const promo = promoRows && promoRows[0];
      if (!promo) {
        return res.status(400).json({ error: 'Promo tidak ditemukan' });
      }
      if (!promo.active || dateStr < promo.valid_from || dateStr > promo.valid_until) {
        return res.status(400).json({ error: 'Promo sudah tidak aktif atau di luar periode berlaku' });
      }
      if (promo.time_from && promo.time_until) {
        const from = promo.time_from.slice(0, 5);
        const until = promo.time_until.slice(0, 5);
        if (!(nowTime >= from && nowTime <= until)) {
          return res.status(400).json({ error: `Promo hanya berlaku jam ${from}-${until}` });
        }
      }
      if (promo.type !== 'discount_percent' && promo.type !== 'discount_fixed') {
        return res.status(400).json({ error: 'Jenis promo ini tidak bisa diterapkan saat checkout' });
      }
      appliedPromo = promo;
    }

    // Kumpulkan semua nama menu ASLI yang perlu dicek resepnya:
    // - item menu biasa di keranjang
    // - menu yang ada di dalam bundle (bundle_items promo)
    const recipeLookupNames = new Set();
    for (const it of items) {
      const bundle = bundleMap[it.menu_name];
      if (bundle) {
        if (bundle.type === 'bundle') {
          bundle.bundle_items.split(',').map((s) => s.trim()).forEach((n) => recipeLookupNames.add(n));
        } else if (bundle.type === 'bundle_qty') {
          recipeLookupNames.add(bundle.bundle_items.trim());
        }
      } else {
        recipeLookupNames.add(it.menu_name);
      }
    }
    const recipeRows = recipeLookupNames.size
      ? await supabase('GET', `nc_recipe?menu_name=in.(${[...recipeLookupNames].map(encodeURIComponent).join(',')})`)
      : [];

    // 3. Hitung total bahan baku yang harus dikurangi (agregat lintas item, termasuk isi bundle)
    const deduction = {}; // { ingredient_name: totalQty }
    for (const it of items) {
      const bundle = bundleMap[it.menu_name];
      if (bundle && bundle.type === 'bundle') {
        // 1 paket = 1x tiap menu yang ada di bundle_items
        const names = bundle.bundle_items.split(',').map((s) => s.trim());
        for (const menuName of names) {
          const recipesForMenu = recipeRows.filter((r) => r.menu_name === menuName);
          for (const r of recipesForMenu) {
            deduction[r.ingredient_name] = (deduction[r.ingredient_name] || 0) + r.qty_used * it.qty;
          }
        }
      } else if (bundle && bundle.type === 'bundle_qty') {
        // 1 paket = N pcs menu yang sama
        const menuName = bundle.bundle_items.trim();
        const totalPcs = bundle.bundle_qty * it.qty;
        const recipesForMenu = recipeRows.filter((r) => r.menu_name === menuName);
        for (const r of recipesForMenu) {
          deduction[r.ingredient_name] = (deduction[r.ingredient_name] || 0) + r.qty_used * totalPcs;
        }
      } else {
        const recipesForMenu = recipeRows.filter((r) => r.menu_name === it.menu_name);
        for (const r of recipesForMenu) {
          deduction[r.ingredient_name] = (deduction[r.ingredient_name] || 0) + r.qty_used * it.qty;
        }
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

    // Helper: harga 1 baris keranjang (menu biasa pakai nc_menu.price, bundle pakai bundle_price promo)
    function lineTotal(it) {
      const bundle = bundleMap[it.menu_name];
      if (bundle) return bundle.bundle_price * it.qty;
      return menuMap[it.menu_name].price * it.qty;
    }

    // 5a. Catat penjualan ke nc_sales (satu baris per menu item) — dipakai sales-report.js untuk omzet
    // Kalau ada item yang di-redeem gratis, pisahkan 1 pcs-nya jadi baris 'pos_sale_free'
    // (qty gratis = 1, tetap tercatat untuk potong stok bahan baku, tapi TIDAK dihitung sebagai omzet)
    // CATATAN: item bundle dicatat sebagai type 'pos_sale_bundle' dengan qty = jumlah paket terjual.
    const salesPayload = [];
    for (const it of items) {
      const bundle = bundleMap[it.menu_name];
      if (bundle) {
        salesPayload.push({ date: dateStr, ts, type: 'pos_sale_bundle', item: it.menu_name, qty: it.qty, unit: 'paket' });
      } else if (redeem_free && it.menu_name === redeem_item) {
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

    // 5c. Catat pemakaian promo diskon (kalau ada) — biar kelihatan "transaksi mana pakai promo apa" di Laporan
    // Diskon cuma berlaku untuk item MENU BIASA (bukan bundle, karena bundle sudah harga paket sendiri).
    const promoSalesPayload = [];
    let discountAmount = 0;
    if (appliedPromo) {
      const discountableSubtotal = () => {
        if (!appliedPromo.applicable_menus) {
          return items.reduce((sum, it) => (bundleMap[it.menu_name] ? sum : sum + menuMap[it.menu_name].price * it.qty), 0);
        }
        const allowed = appliedPromo.applicable_menus.split(',').map((x) => x.trim());
        return items.reduce((sum, it) => {
          if (bundleMap[it.menu_name]) return sum;
          return allowed.includes(it.menu_name) ? sum + menuMap[it.menu_name].price * it.qty : sum;
        }, 0);
      };
      const base = discountableSubtotal();
      discountAmount = appliedPromo.type === 'discount_percent'
        ? Math.round(base * appliedPromo.discount_percent / 100)
        : Math.min(appliedPromo.discount_fixed, base);
      promoSalesPayload.push({
        date: dateStr, ts, type: 'promo_used', item: appliedPromo.name, qty: discountAmount, unit: 'Rp',
      });
    }

    await supabase('POST', 'nc_sales', [...salesPayload, ...ingredientSalesPayload, ...promoSalesPayload]);

    // Hitung berapa "cup" yang terjual di transaksi ini untuk keperluan punch loyalty.
    // Aturan: 1 menu = 1 punch. Bundle beda-menu (type 'bundle') menghitung tiap menu
    // di dalamnya; bundle qty-sama (type 'bundle_qty') menghitung N pcs-nya. Item yang
    // sedang di-redeem gratis TIDAK menambah punch sama sekali (baik itu sendiri
    // maupun qty lain di keranjang) — sesuai desain awal: redeem tidak numpuk dengan nabung punch baru.
    function computePunchCount() {
      if (redeem_free) return 0;
      let count = 0;
      for (const it of items) {
        const bundle = bundleMap[it.menu_name];
        if (bundle && bundle.type === 'bundle') {
          const menuCount = bundle.bundle_items.split(',').map((s) => s.trim()).filter(Boolean).length;
          count += menuCount * it.qty;
        } else if (bundle && bundle.type === 'bundle_qty') {
          count += bundle.bundle_qty * it.qty;
        } else {
          count += it.qty;
        }
      }
      return count;
    }
    
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
        const addPunches = computePunchCount();
        const updated = await supabase('PATCH', `punches?email=eq.${encodeURIComponent(customer_email)}`, {
          punches: punchRecord.punches + addPunches,
          total_punches: punchRecord.total_punches + addPunches,
          updated_at: new Date().toISOString(),
        });
        punchResult = updated[0];
      } else {
        const addPunches = computePunchCount();
        const created = await supabase('POST', 'punches', {
          email: customer_email,
          punches: addPunches,
          total_punches: addPunches,
          free_redeemed: 0,
        });
        punchResult = created[0];
      }
    }

    // 7. Total yang harus dibayar — kurangi harga 1 pcs dari item yang di-redeem gratis, atau potongan promo
    let total = items.reduce((sum, it) => sum + lineTotal(it), 0);
    if (redeem_free) {
      total -= menuMap[redeem_item].price;
    } else if (appliedPromo) {
      total -= discountAmount;
    }
    total = Math.max(0, total);

    return res.status(200).json({
      ok: true,
      total,
      warnings,
      punch: punchResult,
      redeemed_item: redeem_free ? redeem_item : null,
      applied_promo: appliedPromo ? appliedPromo.name : null,
      discount_amount: discountAmount,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

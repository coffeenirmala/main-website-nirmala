export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
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
    // ---------- GET: list semua promo ----------
    if (req.method === 'GET') {
      const promos = await supabase('GET', 'nc_promos?order=valid_from.desc');
      return res.status(200).json({ promos });
    }
    // ---------- POST: tambah / toggle / hapus promo ----------
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') body = JSON.parse(body);
      const { action } = body;

      if (action === 'upsert_promo') {
        const { name, type, valid_from, valid_until, active, applicable_menus, time_from, time_until } = body;

        if (!name || !type || !valid_from || !valid_until) {
          return res.status(400).json({ error: 'name, type, valid_from, valid_until wajib diisi' });
        }
        if (valid_until < valid_from) {
          return res.status(400).json({ error: 'valid_until tidak boleh sebelum valid_from' });
        }
        // jam happy hour: harus diisi berdua atau kosong berdua (mirror validasi di frontend)
        if ((time_from && !time_until) || (!time_from && time_until)) {
          return res.status(400).json({ error: 'Isi jam mulai & jam selesai berdua, atau kosongkan berdua' });
        }

        const payload = {
          name,
          type,
          valid_from,
          valid_until,
          active: active !== false,
          time_from: time_from || null,
          time_until: time_until || null,
        };

        if (type === 'discount_percent') {
          if (!body.discount_percent) return res.status(400).json({ error: 'discount_percent wajib diisi' });
          payload.discount_percent = body.discount_percent;
          payload.applicable_menus = applicable_menus || null; // null = berlaku semua menu
        } else if (type === 'discount_fixed') {
          if (!body.discount_fixed) return res.status(400).json({ error: 'discount_fixed wajib diisi' });
          payload.discount_fixed = body.discount_fixed;
          payload.applicable_menus = applicable_menus || null;
        } else if (type === 'bundle') {
          if (!body.bundle_items || !body.bundle_price) {
            return res.status(400).json({ error: 'bundle_items dan bundle_price wajib diisi' });
          }
          const menuCount = body.bundle_items.split(',').map((s) => s.trim()).filter(Boolean).length;
          if (menuCount < 2) return res.status(400).json({ error: 'Bundle butuh minimal 2 menu berbeda' });
          payload.bundle_items = body.bundle_items;
          payload.bundle_price = body.bundle_price;
        } else if (type === 'bundle_qty') {
          // bundle menu SAMA, N pcs — mis. "3x Dirty Latte = Rp 45.000"
          if (!body.bundle_items || !body.bundle_qty || !body.bundle_price) {
            return res.status(400).json({ error: 'Pilih menu, isi jumlah pcs, & harga paket wajib diisi' });
          }
          if (body.bundle_qty < 2) return res.status(400).json({ error: 'Jumlah pcs minimal 2' });
          payload.bundle_items = body.bundle_items; // 1 nama menu
          payload.bundle_qty = body.bundle_qty;
          payload.bundle_price = body.bundle_price;
        } else {
          return res.status(400).json({ error: 'type promo tidak dikenal' });
        }

        const created = await supabase('POST', 'nc_promos', payload);
        return res.status(200).json(created);
      }

      if (action === 'toggle_promo') {
        const { id, active } = body;
        if (id === undefined) return res.status(400).json({ error: 'id wajib diisi' });
        const updated = await supabase('PATCH', `nc_promos?id=eq.${id}`, { active: !!active });
        return res.status(200).json(updated);
      }

      if (action === 'delete_promo') {
        const { id } = body;
        if (id === undefined) return res.status(400).json({ error: 'id wajib diisi' });
        await supabase('DELETE', `nc_promos?id=eq.${id}`);
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'action tidak dikenal' });
    }
    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

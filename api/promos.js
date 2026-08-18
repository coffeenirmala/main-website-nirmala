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
        const { name, type, valid_from, valid_until, active } = body;
        if (!name || !type || !valid_from || !valid_until) {
          return res.status(400).json({ error: 'name, type, valid_from, valid_until wajib diisi' });
        }
        if (valid_until < valid_from) {
          return res.status(400).json({ error: 'valid_until tidak boleh sebelum valid_from' });
        }
        const payload = { name, type, valid_from, valid_until, active: active !== false };
        if (type === 'discount_percent') {
          if (!body.discount_percent) return res.status(400).json({ error: 'discount_percent wajib diisi' });
          payload.discount_percent = body.discount_percent;
        } else if (type === 'discount_fixed') {
          if (!body.discount_fixed) return res.status(400).json({ error: 'discount_fixed wajib diisi' });
          payload.discount_fixed = body.discount_fixed;
        } else if (type === 'bundle') {
          if (!body.bundle_items || !body.bundle_price) {
            return res.status(400).json({ error: 'bundle_items dan bundle_price wajib diisi' });
          }
          payload.bundle_items = body.bundle_items;
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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
    // ---------- GET: list semua menu + resep ----------
    if (req.method === 'GET') {
      const [menu, recipes] = await Promise.all([
        supabase('GET', 'nc_menu?order=category,name'),
        supabase('GET', 'nc_recipe?order=menu_name'),
      ]);
      return res.status(200).json({ menu, recipes });
    }

    // ---------- POST: tambah/update menu atau resep ----------
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') body = JSON.parse(body);
      const { action } = body;

      if (action === 'upsert_menu') {
        const { name, category, price, active } = body;
        if (!name || price === undefined) {
          return res.status(400).json({ error: 'name dan price wajib diisi' });
        }
        const payload = {
          category: category || 'lainnya',
          price,
          active: active !== false,
          updated_at: new Date().toISOString(),
        };
        // coba update dulu (kalau nama menu sudah ada)
        const updated = await supabase('PATCH', `nc_menu?name=eq.${encodeURIComponent(name)}`, payload);
        if (updated && updated.length > 0) {
          return res.status(200).json(updated);
        }
        // belum ada -> insert baru
        const created = await supabase('POST', 'nc_menu', { name, ...payload });
        return res.status(200).json(created);
      }

      if (action === 'upsert_recipe') {
        const { menu_name, ingredient_name, qty_used, unit } = body;
        if (!menu_name || !ingredient_name || !qty_used) {
          return res.status(400).json({ error: 'menu_name, ingredient_name, qty_used wajib diisi' });
        }
        const created = await supabase('POST', 'nc_recipe', {
          menu_name,
          ingredient_name,
          qty_used,
          unit: unit || '',
        });
        return res.status(200).json(created);
      }

      if (action === 'delete_menu') {
        const { name } = body;
        await supabase('DELETE', `nc_menu?name=eq.${encodeURIComponent(name)}`);
        return res.status(200).json({ ok: true });
      }

      if (action === 'delete_recipe') {
        const { id } = body;
        await supabase('DELETE', `nc_recipe?id=eq.${id}`);
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'action tidak dikenal' });
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

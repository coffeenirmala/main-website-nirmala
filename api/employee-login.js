export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

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
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const { employee_id, pin } = body;
    if (!employee_id || !pin) {
      return res.status(400).json({ error: 'employee_id dan pin wajib diisi' });
    }

    const rows = await supabase('GET', `nc_employees?id=eq.${encodeURIComponent(employee_id)}&active=eq.true`);
    if (!rows.length) {
      return res.status(404).json({ error: 'Karyawan tidak ditemukan atau nonaktif' });
    }
    if (rows[0].pin !== pin) {
      return res.status(401).json({ error: 'PIN salah' });
    }

    return res.status(200).json({ ok: true, employee: { id: rows[0].id, name: rows[0].name } });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

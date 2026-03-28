export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
  const PUNCHES_FOR_FREE = 8;

  async function supabase(method, path, body) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method,
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': method === 'POST' ? 'return=representation' : 'return=representation',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  }

  if (req.method === 'GET') {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const data = await supabase('GET', `punches?email=eq.${encodeURIComponent(email)}&limit=1`);
    if (!data || data.length === 0) {
      return res.status(200).json({ email, punches: 0, total_punches: 0, free_redeemed: 0 });
    }
    return res.status(200).json(data[0]);
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const { email, action } = body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const existing = await supabase('GET', `punches?email=eq.${encodeURIComponent(email)}&limit=1`);
    const record = existing && existing.length > 0 ? existing[0] : null;

    if (action === 'redeem') {
      if (!record || record.punches < PUNCHES_FOR_FREE) {
        return res.status(400).json({ error: 'Belum cukup punch' });
      }
      const updated = await supabase('PATCH', `punches?email=eq.${encodeURIComponent(email)}`, {
        punches: record.punches - PUNCHES_FOR_FREE,
        free_redeemed: record.free_redeemed + 1,
        updated_at: new Date().toISOString()
      });
      return res.status(200).json(updated[0]);
    }

    if (record) {
      const updated = await supabase('PATCH', `punches?email=eq.${encodeURIComponent(email)}`, {
        punches: record.punches + 1,
        total_punches: record.total_punches + 1,
        updated_at: new Date().toISOString()
      });
      return res.status(200).json(updated[0]);
    } else {
      const created = await supabase('POST', 'punches', {
        email, punches: 1, total_punches: 1, free_redeemed: 0
      });
      return res.status(200).json(created[0]);
    }
  }
}

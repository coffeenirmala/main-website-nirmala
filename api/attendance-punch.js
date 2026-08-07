export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
  const SHIFT_START_HOUR = 16; // 16:00

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

  function deductionPct(lateMinutes) {
    if (lateMinutes <= 0) return 0;
    return Math.ceil(lateMinutes / 15) * 7; // 5-15 min = 7%, 16-30 = 14%, dst
  }

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const { employee_id, action, lat, lng, selfie_url } = body;
    // action: 'in' | 'out'

    if (!employee_id || !action) {
      return res.status(400).json({ error: 'employee_id dan action wajib diisi' });
    }

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);

    if (action === 'in') {
      const shiftStart = new Date(now);
      shiftStart.setHours(SHIFT_START_HOUR, 0, 0, 0);
      const lateMinutes = Math.max(0, Math.round((now - shiftStart) / 60000));

      const created = await supabase('POST', 'nc_attendance', {
        employee_id,
        date: dateStr,
        clock_in: now.toISOString(),
        clock_in_lat: lat,
        clock_in_lng: lng,
        selfie_url,
        late_minutes: lateMinutes,
        deduction_pct: deductionPct(lateMinutes),
      });
      return res.status(200).json({ ok: true, record: created[0] });
    }

    if (action === 'out') {
      const existing = await supabase('GET', `nc_attendance?employee_id=eq.${employee_id}&date=eq.${dateStr}&order=created_at.desc&limit=1`);
      if (!existing.length) {
        return res.status(400).json({ error: 'Belum ada catatan clock-in hari ini' });
      }
      const updated = await supabase('PATCH', `nc_attendance?id=eq.${existing[0].id}`, {
        clock_out: now.toISOString(),
      });
      return res.status(200).json({ ok: true, record: updated[0] });
    }

    return res.status(400).json({ error: 'action harus "in" atau "out"' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

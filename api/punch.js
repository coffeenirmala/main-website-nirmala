import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );

  const PUNCHES_FOR_FREE = 8;

  if (req.method === 'GET') {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const { data, error } = await supabase
      .from('punches')
      .select('*')
      .eq('email', email)
      .single();

    if (error && error.code === 'PGRST116') {
      return res.status(200).json({ email, punches: 0, total_punches: 0, free_redeemed: 0 });
    }
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);

    const { email, action } = body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const { data: existing } = await supabase
      .from('punches')
      .select('*')
      .eq('email', email)
      .single();

    if (action === 'redeem') {
      if (!existing || existing.punches < PUNCHES_FOR_FREE) {
        return res.status(400).json({ error: 'Belum cukup punch untuk redeem' });
      }
      const { data, error } = await supabase
        .from('punches')
        .update({
          punches: existing.punches - PUNCHES_FOR_FREE,
          free_redeemed: existing.free_redeemed + 1,
          updated_at: new Date().toISOString()
        })
        .eq('email', email)
        .select()
        .single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json(data);
    }

    if (existing) {
      const newPunches = existing.punches + 1;
      const { data, error } = await supabase
        .from('punches')
        .update({
          punches: newPunches,
          total_punches: existing.total_punches + 1,
          updated_at: new Date().toISOString()
        })
        .eq('email', email)
        .select()
        .single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json(data);
    } else {
      const { data, error } = await supabase
        .from('punches')
        .insert({ email, punches: 1, total_punches: 1, free_redeemed: 0 })
        .select()
        .single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json(data);
    }
  }
}

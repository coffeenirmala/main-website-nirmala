export default async function handler(req, res) {
  try {
    const response = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/punches?limit=1`,
      {
        headers: {
          'apikey': process.env.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        }
      }
    );
    return res.status(200).json({ ok: true, status: response.status });
  } catch(err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

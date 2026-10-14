// api/loyalty-members.js
// Mengambil seluruh member dari list Brevo #8 (dengan pagination).
// Kalau Brevo menolak permintaan (mis. API key salah / belum terpasang),
// API ini mengembalikan pesan error yang jelas, bukan daftar kosong.

const LIST_ID = 8;
const PAGE_SIZE = 500; // batas maksimum Brevo per permintaan
const MAX_PAGES = 20;  // pengaman: maksimum 10.000 member

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'BREVO_API_KEY belum terpasang di Vercel (Settings > Environment Variables). Pasang lalu Redeploy.',
    });
  }

  try {
    let contacts = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = `https://api.brevo.com/v3/contacts/lists/${LIST_ID}/contacts?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`;
      const brevoRes = await fetch(url, {
        headers: { accept: 'application/json', 'api-key': apiKey },
      });
      const data = await brevoRes.json().catch(() => ({}));

      if (!brevoRes.ok) {
        return res.status(502).json({
          error: `Brevo menolak permintaan (${brevoRes.status}): ${data.message || 'tanpa pesan'}`,
        });
      }

      const batch = data.contacts || [];
      contacts = contacts.concat(batch);
      if (batch.length < PAGE_SIZE) break; // halaman terakhir
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ contacts });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

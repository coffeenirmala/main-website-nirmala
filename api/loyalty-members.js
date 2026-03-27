export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const brevoRes = await fetch(`https://api.brevo.com/v3/contacts/lists/8/contacts?limit=100`, {
      headers: {
        'accept': 'application/json',
        'api-key': process.env.BREVO_API_KEY,
      },
    });

    const data = await brevoRes.json();
    const contacts = data.contacts || [];
    return res.status(200).json({ contacts });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

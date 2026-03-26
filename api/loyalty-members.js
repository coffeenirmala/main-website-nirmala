export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const { search } = req.query;

  try {
    let url = `https://api.brevo.com/v3/contacts?limit=100&listId=8`;
    const brevoRes = await fetch(url, {
      headers: {
        'accept': 'application/json',
        'api-key': process.env.BREVO_API_KEY,
      },
    });

    const data = await brevoRes.json();
    let contacts = data.contacts || [];

    if (search) {
      const q = search.toLowerCase();
      contacts = contacts.filter(c => {
        const name = `${c.attributes?.FIRSTNAME || ''} ${c.attributes?.LASTNAME || ''}`.toLowerCase();
        const email = (c.email || '').toLowerCase();
        const phone = (c.attributes?.SMS || '').toLowerCase();
        return name.includes(q) || email.includes(q) || phone.includes(q);
      });
    }

    return res.status(200).json({ contacts });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

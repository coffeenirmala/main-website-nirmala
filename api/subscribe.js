export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    let email;

    // Handle body parsing — Vercel kadang kirim body sebagai string
    if (typeof req.body === 'string') {
      const parsed = JSON.parse(req.body);
      email = parsed.email;
    } else if (typeof req.body === 'object' && req.body !== null) {
      email = req.body.email;
    } else {
      // Fallback: baca raw body manual
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString();
      const parsed = JSON.parse(raw);
      email = parsed.email;
    }

    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    const response = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'api-key': process.env.BREVO_API_KEY,
      },
      body: JSON.stringify({
        email: email,
        listIds: [7],
        updateEnabled: true,
      }),
});

    if (response.ok || response.status === 204 || response.status === 201) {
      return res.status(200).json({ success: true });
    }

    const data = await response.json();
    if (data.code === 'duplicate_parameter') {
      return res.status(200).json({ success: true });
    }
    return res.status(500).json({ error: 'Brevo error', detail: data });
  }
}

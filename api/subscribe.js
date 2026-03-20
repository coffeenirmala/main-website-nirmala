export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // Memastikan body terbaca meski dalam format string
    let body = req.body;
    if (typeof body === 'string') {
      body = JSON.parse(body);
    }
    
    const { email } = body;

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
        listIds: [2],
        updateEnabled: true,
      }),
    });

    const data = await response.json();

    if (response.ok) {
      return res.status(200).json({ success: true });
    } else {
      // Jika error, kirim detailnya agar kita bisa debug di console browser
      return res.status(response.status).json({ 
        error: data.message || 'Brevo Error' 
      });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Server Error: ' + err.message });
  }
}

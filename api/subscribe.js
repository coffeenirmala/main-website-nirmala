export default async function handler(req, res) {
  // Allow CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
 
  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
 
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
 
  try {
    // Safely parse body (Vercel sudah auto-parse JSON, tapi jaga-jaga)
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
        listIds: [7],          // ✅ List #7 = "subscriber web" sesuai Brevo automation
        updateEnabled: true,   // Update kalau email sudah ada
      }),
    });
 
    const data = await response.json();
 
    if (response.ok || response.status === 204) {
      return res.status(200).json({ success: true });
    } else {
      console.error('Brevo API error:', data);
      return res.status(500).json({ error: 'Brevo error', detail: data });
    }
 
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}    } else {
      // Jika error, kirim detailnya agar kita bisa debug di console browser
      return res.status(response.status).json({ 
        error: data.message || 'Brevo Error' 
      });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Server Error: ' + err.message });
  }
}

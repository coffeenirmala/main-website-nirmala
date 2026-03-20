export default async function handler(req, res) {
  // 1. Validasi Method
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { email } = req.body;

  // 2. Validasi Email Input
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Email tidak valid.' });
  }

  try {
    const response = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'api-key': process.env.BREVO_API_KEY,
      },
      body: JSON.stringify({
        email: email,
        listIds: [2], // Pastikan List ID sesuai dengan dashboard Brevo kamu
        updateEnabled: true,
      }),
    });

    const data = await response.json();

    if (response.ok) {
      return res.status(200).json({ success: true, message: 'Berhasil berlangganan!' });
    } else {
      // Menangani error spesifik dari Brevo (misal: email sudah terdaftar)
      return res.status(response.status).json({ 
        error: data.message || 'Terjadi kesalahan pada server Brevo.' 
      });
    }
  } catch (err) {
    console.error('API Error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

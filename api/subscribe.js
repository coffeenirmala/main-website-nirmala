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
    // ── Parse body ──────────────────────────────────────────────────────────
    let body;
    if (typeof req.body === 'string') {
      body = JSON.parse(req.body);
    } else if (typeof req.body === 'object' && req.body !== null) {
      body = req.body;
    } else {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
    }

    const { email, firstName, lastName, phone, birthday, gender, listId } = body;

    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    // ── Build attributes ─────────────────────────────────────────────────────
    const attributes = {};
    if (firstName)  attributes.FIRSTNAME       = firstName;
    if (lastName)   attributes.LASTNAME        = lastName;
    if (phone)      attributes.SMS             = phone;
    if (birthday)   attributes.DATE_OF_BIRTH   = birthday;
    if (gender)     attributes.GENDER          = gender;

    // ── Determine target list ────────────────────────────────────────────────
    // listId 2 = loyalty program | listId 7 = newsletter popup
    const targetListId = listId === 2 ? 2 : 7;

    // ── Check API key presence ───────────────────────────────────────────────
    if (!process.env.BREVO_API_KEY) {
      console.error('[Nirmala] BREVO_API_KEY is not set');
      return res.status(500).json({ error: 'Server misconfiguration: API key missing' });
    }

    // ── Call Brevo ───────────────────────────────────────────────────────────
    const brevoRes = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'accept':       'application/json',
        'content-type': 'application/json',
        'api-key':      process.env.BREVO_API_KEY,
      },
      body: JSON.stringify({
        email,
        attributes,
        listIds: [targetListId],
        updateEnabled: true,   // if contact exists, update & add to list
      }),
    });

    // ── Parse Brevo response safely ──────────────────────────────────────────
    let data = {};
    const contentType = brevoRes.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      data = await brevoRes.json();
    }

    console.log(`[Nirmala] Brevo status=${brevoRes.status} code=${data.code} email=${email} list=${targetListId}`);

    // ── Success cases ────────────────────────────────────────────────────────
    // 201 = created, 204 = no content (updated), 200 = ok
    if (brevoRes.status === 201 || brevoRes.status === 204 || brevoRes.status === 200) {
      return res.status(200).json({ success: true });
    }

    // Brevo returns 400 with these codes when contact already exists
    const successCodes = ['duplicate_parameter', 'contact_already_exists'];
    if (successCodes.includes(data.code)) {
      // Contact exists — still add to list via PATCH
      const patchRes = await fetch(`https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`, {
        method: 'PUT',
        headers: {
          'accept':       'application/json',
          'content-type': 'application/json',
          'api-key':      process.env.BREVO_API_KEY,
        },
        body: JSON.stringify({
          attributes,
          listIds: [targetListId],
        }),
      });
      console.log(`[Nirmala] Brevo PUT status=${patchRes.status} for existing contact`);
      return res.status(200).json({ success: true });
    }

    // ── All other errors ─────────────────────────────────────────────────────
    console.error('[Nirmala] Brevo unexpected error:', brevoRes.status, JSON.stringify(data));
    return res.status(500).json({
      error: 'Brevo error',
      status: brevoRes.status,
      detail: data,
    });

  } catch (err) {
    console.error('[Nirmala] Internal error:', err.message);
    return res.status(500).json({
      error: 'Internal server error',
      detail: err.message,
    });
  }
}

fix: handle duplicate email & improve error handling

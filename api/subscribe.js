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
    let normalizedPhone = null;
    if (phone) {
      const digits = phone.replace(/\D/g, '');
      if (digits.startsWith('62')) {
        normalizedPhone = '+' + digits;
      } else if (digits.startsWith('0')) {
        normalizedPhone = '+62' + digits.slice(1);
      } else {
        normalizedPhone = '+62' + digits;
      }
    }

    const attributes = {};
    if (firstName)       attributes.FIRSTNAME     = firstName;
    if (lastName)        attributes.LASTNAME      = lastName;
    if (normalizedPhone) attributes.SMS           = normalizedPhone;
    if (birthday)        attributes.DATE_OF_BIRTH = birthday;
    if (gender)          attributes.GENDER        = gender;

    // ── Determine target list ────────────────────────────────────────────────
    const targetListId = listId === 2 ? 8 : 7;

    // ── Check API key ────────────────────────────────────────────────────────
    if (!process.env.BREVO_API_KEY) {
      console.error('[Nirmala] BREVO_API_KEY is not set');
      return res.status(500).json({ error: 'Server misconfiguration: API key missing' });
    }

    // ── Step 1: Create or update contact ────────────────────────────────────
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
        updateEnabled: true,
      }),
    });

    let data = {};
    const contentType = brevoRes.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      data = await brevoRes.json();
    }

    console.log(`[Nirmala] Brevo status=${brevoRes.status} code=${data.code} email=${email} list=${targetListId}`);

    // ── Step 2: Success on first try ─────────────────────────────────────────
    if (brevoRes.status === 201 || brevoRes.status === 204 || brevoRes.status === 200) {
      return res.status(200).json({ success: true });
    }

    // ── Step 3: Contact exists — force add to list via dedicated endpoint ────
    const successCodes = ['duplicate_parameter', 'contact_already_exists'];
    if (successCodes.includes(data.code)) {

      // 3a. Update attributes dulu via PATCH
      await fetch(`https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`, {
        method: 'PATCH',
        headers: {
          'accept':       'application/json',
          'content-type': 'application/json',
          'api-key':      process.env.BREVO_API_KEY,
        },
        body: JSON.stringify({ attributes }),
      });

      // 3b. Add contact ke list via endpoint khusus
      const addToListRes = await fetch(`https://api.brevo.com/v3/contacts/lists/${targetListId}/contacts/add`, {
        method: 'POST',
        headers: {
          'accept':       'application/json',
          'content-type': 'application/json',
          'api-key':      process.env.BREVO_API_KEY,
        },
        body: JSON.stringify({
          emails: [email],
        }),
      });

      console.log(`[Nirmala] Brevo add-to-list status=${addToListRes.status} email=${email} list=${targetListId}`);
      return res.status(200).json({ success: true });
    }

    // ── Step 4: Unexpected error ─────────────────────────────────────────────
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

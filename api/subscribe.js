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
    let body;

    if (typeof req.body === 'string') {
      body = JSON.parse(req.body);
    } else if (typeof req.body === 'object' && req.body !== null) {
      body = req.body;
    } else {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString();
      body = JSON.parse(raw);
    }

    const { email, firstName, lastName, phone, birthday, gender, listId } = body;

    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    // Build contact attributes
    const attributes = {};
    if (firstName) attributes.FIRSTNAME = firstName;
    if (lastName) attributes.LASTNAME = lastName;
    if (phone) attributes.SMS = phone;
    if (birthday) attributes.DATE_OF_BIRTH = birthday;
    if (gender) attributes.GENDER = gender;

    // Use listId from body if provided (2 = loyalty, 7 = newsletter popup)
    const targetListId = listId === 2 ? 2 : 7;

    const response = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'api-key': process.env.BREVO_API_KEY,
      },
      body: JSON.stringify({
        email,
        attributes,
        listIds: [targetListId],
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

  } catch (err) {
    return res.status(500).json({
      error: 'Internal server error',
      detail: err.message
    });
  }
}      error: 'Internal server error',
      detail: err.message
    });
  }
}

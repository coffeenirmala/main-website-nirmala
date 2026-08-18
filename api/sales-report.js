export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

  async function supabase(path) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  function toDateStr(d) {
    return d.toISOString().slice(0, 10);
  }

  try {
    const { range, date } = req.query; // range: daily | weekly | monthly
    const anchor = date ? new Date(date) : new Date();
    let start, end;

    if (range === 'weekly') {
      const day = anchor.getDay(); // 0 = Minggu
      const diffToMonday = (day + 6) % 7;
      start = new Date(anchor);
      start.setDate(anchor.getDate() - diffToMonday);
      end = new Date(start);
      end.setDate(start.getDate() + 6);
    } else if (range === 'monthly') {
      start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    } else {
      // daily
      start = new Date(anchor);
      end = new Date(anchor);
    }

    const startStr = toDateStr(start);
    const endStr = toDateStr(end);

    const [sales, menuRows] = await Promise.all([
      supabase(`nc_sales?date=gte.${startStr}&date=lte.${endStr}&order=ts.asc`),
      supabase(`nc_menu?select=name,price,category`),
    ]);

    const priceMap = Object.fromEntries(menuRows.map((m) => [m.name, m.price]));

    let grandTotal = 0;
    const rows = sales.map((s) => {
      // pos_sale_free = 1 pcs yang digratiskan lewat redeem loyalty — tampil Rp 0, tidak masuk omzet
      const isFree = s.type === 'pos_sale_free';
      const price = isFree ? 0 : (priceMap[s.item] ?? 0);
      const subtotal = s.type === 'pos_sale' ? price * s.qty : 0;
      if (s.type === 'pos_sale') grandTotal += subtotal;
      return {
        date: s.date,
        item: s.item,
        qty: s.qty,
        unit: s.unit,
        type: isFree ? 'redeem_gratis' : s.type,
        price,
        subtotal,
      };
    });

    return res.status(200).json({
      range: range || 'daily',
      start: startStr,
      end: endStr,
      rows,
      grand_total: grandTotal,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

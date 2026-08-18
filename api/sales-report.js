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
    const [sales, menuRows, promoRows] = await Promise.all([
      supabase(`nc_sales?date=gte.${startStr}&date=lte.${endStr}&order=ts.asc`),
      supabase(`nc_menu?select=name,price,category`),
      supabase(`nc_promos?select=name,bundle_price&type=in.(bundle,bundle_qty)`),
    ]);
    const priceMap = Object.fromEntries(menuRows.map((m) => [m.name, m.price]));
    // harga bundle diambil dari nc_promos.bundle_price (bukan nc_menu), key = nama promo
    const bundlePriceMap = Object.fromEntries(promoRows.map((p) => [p.name, p.bundle_price]));

    const posSales = sales.filter((s) => s.type === 'pos_sale' || s.type === 'pos_sale_bundle' || s.type === 'pos_sale_free');

    let grandTotal = 0;
    const rows = posSales.map((s) => {
      const isFree = s.type === 'pos_sale_free';
      const isBundle = s.type === 'pos_sale_bundle';

      let price;
      if (isFree) price = 0;
      else if (isBundle) price = bundlePriceMap[s.item] ?? 0;
      else price = priceMap[s.item] ?? 0;

      const subtotal = isFree ? 0 : price * s.qty;
      grandTotal += subtotal;

      return {
        date: s.date,
        time: s.time_wib || '',
        item: s.item,
        qty: s.qty,
        unit: s.unit,
        price,
        subtotal,
        payment_type: s.payment_type || '',
        tipe: isFree ? 'redeem_gratis' : 'bayar',
      };
    });

    const summaryMap = {};
    for (const r of rows) {
      if (!summaryMap[r.item]) summaryMap[r.item] = { item: r.item, qty: 0, total: 0 };
      summaryMap[r.item].qty += r.qty;
      summaryMap[r.item].total += r.subtotal;
    }
    const summary = Object.values(summaryMap).sort((a, b) => b.qty - a.qty);

    return res.status(200).json({
      range: range || 'daily',
      start: startStr,
      end: endStr,
      rows,
      summary,
      grand_total: grandTotal,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

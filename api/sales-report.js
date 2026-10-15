// api/sales-report.js
// Laporan penjualan kasir. Semua tanggal & jam memakai zona Asia/Jakarta (WIB).
const TZ = 'Asia/Jakarta';
const POS_TYPES = 'pos_sale,pos_sale_bundle,pos_sale_free';

function wibParts(d = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(d).map((x) => [x.type, x.value])
  );
  return { date: `${p.year}-${p.month}-${p.day}`, hms: `${p.hour}:${p.minute}:${p.second}` };
}
// Tanggal "YYYY-MM-DD" diolah sebagai tanggal kalender murni (UTC) supaya tidak bergeser oleh zona waktu server.
function parseYMD(s) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function fmtYMD(d) { return d.toISOString().slice(0, 10); }
function eachDay(startStr, endStr) {
  const out = [];
  for (let d = parseYMD(startStr); fmtYMD(d) <= endStr; d = new Date(d.getTime() + 86400000)) out.push(fmtYMD(d));
  return out;
}

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
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  try {
    const { range, date } = req.query; // range: daily | weekly | monthly
    const anchorStr = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : wibParts().date;
    const anchor = parseYMD(anchorStr);

    let start, end;
    if (range === 'weekly') {
      const diffToMonday = (anchor.getUTCDay() + 6) % 7; // 0 = Minggu
      start = new Date(anchor.getTime() - diffToMonday * 86400000);
      end = new Date(start.getTime() + 6 * 86400000);
    } else if (range === 'monthly') {
      start = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
      end = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0));
    } else {
      start = anchor;
      end = anchor;
    }
    const startStr = fmtYMD(start);
    const endStr = fmtYMD(end);

    // Ambil per hari supaya tidak terpotong batas 1000 baris PostgREST (bulanan bisa lebih dari 1000 baris).
    const days = eachDay(startStr, endStr);
    const salesParts = [];
    for (let i = 0; i < days.length; i += 8) {
      const batch = days.slice(i, i + 8);
      const parts = await Promise.all(
        batch.map((d) => supabase(`nc_sales?date=eq.${d}&type=in.(${POS_TYPES})&order=ts.asc`))
      );
      salesParts.push(...parts);
    }
    const posSales = salesParts.flat();

    const [menuRows, promoRows] = await Promise.all([
      supabase(`nc_menu?select=name,price,category`),
      supabase(`nc_promos?select=name,bundle_price&type=in.(bundle,bundle_qty)`),
    ]);
    const priceMap = Object.fromEntries(menuRows.map((m) => [m.name, m.price]));
    const bundlePriceMap = Object.fromEntries(promoRows.map((p) => [p.name, p.bundle_price]));

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

      // Jam transaksi (WIB, dengan detik). Data lama yang belum punya time_wib diambil dari ts.
      const time = s.time_wib ? String(s.time_wib).slice(0, 8) : (s.ts ? wibParts(new Date(Number(s.ts))).hms : '');

      return {
        date: s.date,
        time,
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

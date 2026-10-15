// api/owner-report.js
// Data laporan untuk halaman owner. PIN diperiksa di SERVER (env OWNER_PIN), bukan di browser.
// Env yang dipakai: SUPABASE_URL, SUPABASE_ANON_KEY, OWNER_PIN, ABSEN_PIN (opsional, untuk nama barista per shift).
import crypto from 'node:crypto';

const TZ = 'Asia/Jakarta';
const SALE_TYPES = 'pos_sale,pos_sale_bundle,pos_sale_free,promo_used';
const SHIFT_SPLIT_MIN = 15 * 60; // Shift 1: sebelum 15:00, Shift 2: 15:00 dst. Tidak ada hitungan lembur.
const MAX_DAYS = 93;

function wibParts(d = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(d).map((x) => [x.type, x.value])
  );
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, minute: +p.minute };
}
function shiftOfTs(ts) {
  const p = wibParts(new Date(Number(ts)));
  return p.hour * 60 + p.minute < SHIFT_SPLIT_MIN ? 1 : 2;
}
function parseYMD(s) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function fmtYMD(d) { return d.toISOString().slice(0, 10); }
function eachDay(a, b) {
  const out = [];
  for (let d = parseYMD(a); fmtYMD(d) <= b; d = new Date(d.getTime() + 86400000)) out.push(fmtYMD(d));
  return out;
}
function safeEq(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const URL_ = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_ANON_KEY;
  const OWNER_PIN = process.env.OWNER_PIN;
  const ABSEN_PIN = process.env.ABSEN_PIN;
  if (!OWNER_PIN) return res.status(500).json({ error: 'OWNER_PIN belum terpasang di Vercel' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { pin, from, to } = body || {};

  if (!pin || !safeEq(pin, OWNER_PIN)) return res.status(401).json({ error: 'PIN salah' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '') || from > to) {
    return res.status(400).json({ error: 'Rentang tanggal tidak valid' });
  }
  const days = eachDay(from, to);
  if (days.length > MAX_DAYS) return res.status(400).json({ error: `Maksimal ${MAX_DAYS} hari per laporan` });

  const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` };
  async function sb(path) {
    const r = await fetch(`${URL_}/rest/v1/${path}`, { headers });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  try {
    const warnings = [];

    // Penjualan: ambil per hari supaya tidak terpotong batas 1000 baris.
    const sales = [];
    for (let i = 0; i < days.length; i += 8) {
      const parts = await Promise.all(
        days.slice(i, i + 8).map((d) => sb(`nc_sales?date=eq.${d}&type=in.(${SALE_TYPES})&order=ts.asc`))
      );
      parts.forEach((rows, k) => {
        if (rows.length >= 1000) warnings.push(`Data ${days[i + k]} mencapai batas 1000 baris, kemungkinan tidak lengkap`);
        sales.push(...rows);
      });
    }

    const [menuRows, promoRows] = await Promise.all([
      sb('nc_menu?select=name,price,category,active'),
      sb('nc_promos?select=name,bundle_price&type=in.(bundle,bundle_qty)'),
    ]);
    const priceMap = Object.fromEntries(menuRows.map((m) => [m.name, m.price]));
    const bundlePrice = Object.fromEntries(promoRows.map((p) => [p.name, p.bundle_price]));

    // Peta ts -> metode bayar, supaya diskon ikut dikurangkan dari metode bayar yang benar.
    const payByTs = {};
    for (const s of sales) if (s.type !== 'promo_used' && s.payment_type) payByTs[s.ts] = s.payment_type;

    const blank = () => ({ gross: 0, diskon: 0, pcs: 0 });
    const byDay = {};
    for (const d of days) byDay[d] = { date: d, 1: blank(), 2: blank() };
    const items = {};
    const payments = { cash: 0, qris: 0 };
    const txSet = new Set();
    let gratis = 0;

    for (const s of sales) {
      const day = byDay[s.date];
      if (!day) continue;
      const sh = shiftOfTs(s.ts);

      if (s.type === 'promo_used') {
        day[sh].diskon += s.qty;
        const pt = payByTs[s.ts];
        if (pt in payments) payments[pt] -= s.qty;
        continue;
      }

      const isFree = s.type === 'pos_sale_free';
      const isBundle = s.type === 'pos_sale_bundle';
      const price = isFree ? 0 : isBundle ? (bundlePrice[s.item] ?? 0) : (priceMap[s.item] ?? 0);
      const sub = price * s.qty;

      day[sh].gross += sub;
      day[sh].pcs += s.qty;
      txSet.add(s.ts);
      if (isFree) gratis += s.qty;
      if (s.payment_type in payments) payments[s.payment_type] += sub;

      if (!items[s.item]) items[s.item] = { item: s.item, qty: 0, omzet: 0, bundle: isBundle };
      items[s.item].qty += s.qty;
      items[s.item].omzet += sub;
    }

    // Nama barista per tanggal+shift dari sistem absen (pakai fungsi rpc_report yang sudah ada).
    const baristaByKey = {};
    if (ABSEN_PIN) {
      const months = [...new Set(days.map((d) => d.slice(0, 7)))];
      for (const ym of months) {
        const [y, m] = ym.split('-').map(Number);
        try {
          const r = await fetch(`${URL_}/rest/v1/rpc/rpc_report`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ p_pin: ABSEN_PIN, p_year: y, p_month: m }),
          });
          if (!r.ok) throw new Error(await r.text());
          const rep = await r.json();
          for (const a of rep.attendance || []) {
            if (a.work_date < from || a.work_date > to) continue;
            const key = `${a.work_date}|${a.shift}`;
            (baristaByKey[key] ||= new Set()).add(a.employee_name);
          }
        } catch (e) {
          warnings.push(`Data absen ${ym} gagal dimuat: ${String(e.message).slice(0, 120)}`);
        }
      }
    } else {
      warnings.push('ABSEN_PIN belum dipasang di Vercel, nama barista per shift belum tampil');
    }

    // Rangkuman harian, per shift, dan per barista.
    const daysOut = [];
    const shiftRows = [];
    const shiftTotals = { 1: blank(), 2: blank() };
    const baristaAgg = {};
    for (const d of days) {
      const row = { date: d, gross: 0, diskon: 0, pcs: 0, s1: null, s2: null };
      for (const sh of [1, 2]) {
        const b = byDay[d][sh];
        const omzet = b.gross - b.diskon;
        row[`s${sh}`] = { omzet, pcs: b.pcs };
        row.gross += b.gross; row.diskon += b.diskon; row.pcs += b.pcs;
        shiftTotals[sh].gross += b.gross; shiftTotals[sh].diskon += b.diskon; shiftTotals[sh].pcs += b.pcs;

        const names = [...(baristaByKey[`${d}|${sh}`] || [])].sort();
        if (b.pcs > 0 || names.length) {
          shiftRows.push({ date: d, shift: sh, baristas: names, pcs: b.pcs, omzet });
          names.forEach((n) => {
            const a = (baristaAgg[n] ||= { name: n, shifts: 0, pcs: 0, omzet: 0, shared: false });
            a.shifts += 1;
            a.pcs += b.pcs / names.length;
            a.omzet += omzet / names.length;
            if (names.length > 1) a.shared = true;
          });
        }
      }
      row.omzet = row.gross - row.diskon;
      daysOut.push(row);
    }

    const totalGross = daysOut.reduce((s, d) => s + d.gross, 0);
    const totalDiskon = daysOut.reduce((s, d) => s + d.diskon, 0);
    const totalPcs = daysOut.reduce((s, d) => s + d.pcs, 0);

    const itemList = Object.values(items).sort((a, b) => b.qty - a.qty || b.omzet - a.omzet);
    const regular = menuRows
      .filter((m) => m.active !== false)
      .map((m) => ({ item: m.name, qty: items[m.name]?.qty || 0, omzet: items[m.name]?.omzet || 0 }))
      .sort((a, b) => a.qty - b.qty || a.item.localeCompare(b.item));

    return res.status(200).json({
      range: { from, to, days: days.length },
      totals: {
        omzet: totalGross - totalDiskon, gross: totalGross, diskon: totalDiskon,
        pcs: totalPcs, transaksi: txSet.size, gratis,
      },
      shifts: {
        1: { omzet: shiftTotals[1].gross - shiftTotals[1].diskon, pcs: shiftTotals[1].pcs },
        2: { omzet: shiftTotals[2].gross - shiftTotals[2].diskon, pcs: shiftTotals[2].pcs },
      },
      payments,
      days: daysOut,
      shiftRows,
      baristas: Object.values(baristaAgg).sort((a, b) => b.omzet - a.omzet),
      items: itemList,
      top5: itemList.slice(0, 5),
      bottom5: regular.slice(0, 5),
      warnings,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// api/sales-report.js
// Satu function untuk dua kebutuhan (hemat kuota function Vercel Hobby, maks 12):
//   GET  /api/sales-report?range=&date=  -> laporan tab Laporan di kasir
//   POST /api/sales-report {pin,from,to} -> terminal owner (PIN dicek di server: env OWNER_PIN)
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, OWNER_PIN, ABSEN_PIN (PIN rekap sistem absen, untuk nama barista).
// Barista per shift TIDAK disimpan di nc_sales: dibaca dari absensi (clock in) saat laporan dibuat,
// jadi tidak ada data ganda dan data lama ikut terbaca.
import crypto from 'node:crypto';

const TZ = 'Asia/Jakarta';
const POS_TYPES = 'pos_sale,pos_sale_bundle,pos_sale_free,promo_used';
const SALE_TYPES = POS_TYPES;
const SHIFT_SPLIT_MIN = 15 * 60; // Shift 1: sebelum 15:00, Shift 2: 15:00 dst.
const MAX_DAYS = 93;

function wibParts(d = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(d).map((x) => [x.type, x.value])
  );
  return { date: `${p.year}-${p.month}-${p.day}`, hms: `${p.hour}:${p.minute}:${p.second}`, hour: +p.hour, minute: +p.minute };
}
// Shift dari jam transaksi (time_wib kalau ada, kalau tidak dari ts).
function shiftOfRow(s) {
  let mins;
  if (s.time_wib) { const [h, m] = String(s.time_wib).split(':').map(Number); mins = h * 60 + m; }
  else { const p = wibParts(new Date(Number(s.ts))); mins = p.hour * 60 + p.minute; }
  return mins < SHIFT_SPLIT_MIN ? 1 : 2;
}
function parseYMD(s) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function fmtYMD(d) { return d.toISOString().slice(0, 10); }
function eachDay(a, b) {
  const out = [];
  for (let d = parseYMD(a); fmtYMD(d) <= b; d = new Date(d.getTime() + 86400000)) out.push(fmtYMD(d));
  return out;
}
function safeEq(a, b) {
  const A = Buffer.from(String(a)); const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
// Jumlah cup satu baris penjualan. Bundle dihitung isi paketnya x jumlah paket.
function cupsOf(s, bundleInfo) {
  if (s.type !== 'pos_sale_bundle') return s.qty;
  const p = bundleInfo[s.item];
  if (!p) return s.qty;
  const n = p.type === 'bundle_qty' ? (p.bundle_qty || 1)
    : (String(p.bundle_items || '').split(',').filter((x) => x.trim()).length || 1);
  return n * s.qty;
}
// { 'YYYY-MM-DD|shift': Set(nama) } dari absensi (clock in). Gagal -> kosong + warning, laporan tetap jalan.
async function loadBaristas(days, from, to, warnings) {
  const map = {};
  const URL_ = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_ANON_KEY, PIN = process.env.ABSEN_PIN;
  if (!PIN) { warnings.push('ABSEN_PIN belum dipasang di Vercel, nama barista per shift belum tampil'); return map; }
  const months = [...new Set(days.map((d) => d.slice(0, 7)))];
  await Promise.all(months.map(async (ym) => {
    const [y, m] = ym.split('-').map(Number);
    try {
      const r = await fetch(`${URL_}/rest/v1/rpc/rpc_report`, {
        method: 'POST',
        headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_pin: PIN, p_year: y, p_month: m }),
      });
      if (!r.ok) throw new Error(await r.text());
      const rep = await r.json();
      for (const a of rep.attendance || []) {
        if (a.work_date < from || a.work_date > to) continue;
        (map[`${a.work_date}|${a.shift}`] ||= new Set()).add(a.employee_name);
      }
    } catch (e) {
      warnings.push(`Data absen ${ym} gagal dimuat: ${String(e.message).slice(0, 120)}`);
    }
  }));
  return map;
}

async function kasirHandler(req, res) {
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
      supabase(`nc_promos?select=name,bundle_price,type,bundle_items,bundle_qty&type=in.(bundle,bundle_qty)`),
    ]);
    const priceMap = Object.fromEntries(menuRows.map((m) => [m.name, m.price]));
    const bundlePriceMap = Object.fromEntries(promoRows.map((p) => [p.name, p.bundle_price]));
    const bundleInfo = Object.fromEntries(promoRows.map((p) => [p.name, p]));
    const warnings = [];
    const baristaByKey = await loadBaristas(days, startStr, endStr, warnings);

    let grandTotal = 0;
    const rows = posSales.map((s) => {
      const isFree = s.type === 'pos_sale_free';
      const isBundle = s.type === 'pos_sale_bundle';
      const isPromo = s.type === 'promo_used'; // qty = nominal potongan (Rp), disimpan checkout.js

      let price;
      if (isPromo) price = -s.qty;
      else if (isFree) price = 0;
      else if (isBundle) price = bundlePriceMap[s.item] ?? 0;
      else price = priceMap[s.item] ?? 0;

      const subtotal = isPromo ? -s.qty : (isFree ? 0 : price * s.qty);
      grandTotal += subtotal;

      // Jam transaksi (WIB, dengan detik). Data lama yang belum punya time_wib diambil dari ts.
      const time = s.time_wib ? String(s.time_wib).slice(0, 8) : (s.ts ? wibParts(new Date(Number(s.ts))).hms : '');

      const shift = shiftOfRow(s);
      const barista = [...(baristaByKey[`${s.date}|${shift}`] || [])].sort().join(' & ');
      return {
        date: s.date,
        time,
        shift,
        barista,
        cups: isPromo ? 0 : cupsOf(s, bundleInfo),
        item: isPromo ? `Diskon: ${s.item}` : s.item,
        qty: isPromo ? 1 : s.qty,
        unit: isPromo ? 'promo' : s.unit,
        price,
        subtotal,
        payment_type: s.payment_type || '',
        tipe: isPromo ? 'diskon' : (isFree ? 'redeem_gratis' : 'bayar'),
      };
    });

    // Rekap per tanggal + shift: siapa yang jaga & berapa cup terjual (omzet sudah net diskon).
    const shiftMap = {};
    for (const r of rows) {
      const k2 = `${r.date}|${r.shift}`;
      const a = (shiftMap[k2] ||= { date: r.date, shift: r.shift, barista: r.barista, cups: 0, omzet: 0 });
      a.cups += r.cups; a.omzet += r.subtotal;
    }
    const shifts = Object.values(shiftMap).sort((a, b) => a.date.localeCompare(b.date) || a.shift - b.shift);

    const summaryMap = {};
    for (const r of rows) {
      if (r.tipe === 'diskon') continue; // diskon masuk grand_total, bukan ranking item
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
      shifts,
      warnings,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function ownerHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const URL_ = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_ANON_KEY;
  const OWNER_PIN = process.env.OWNER_PIN;
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
      sb('nc_promos?select=name,bundle_price,type,bundle_items,bundle_qty&type=in.(bundle,bundle_qty)'),
    ]);
    const priceMap = Object.fromEntries(menuRows.map((m) => [m.name, m.price]));
    const bundlePrice = Object.fromEntries(promoRows.map((p) => [p.name, p.bundle_price]));
    const bundleInfo = Object.fromEntries(promoRows.map((p) => [p.name, p]));

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
      const sh = shiftOfRow(s);

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
      day[sh].pcs += cupsOf(s, bundleInfo); // cup, bundle dihitung isi paketnya
      txSet.add(s.ts);
      if (isFree) gratis += s.qty;
      if (s.payment_type in payments) payments[s.payment_type] += sub;

      if (!items[s.item]) items[s.item] = { item: s.item, qty: 0, omzet: 0, bundle: isBundle };
      items[s.item].qty += s.qty;
      items[s.item].omzet += sub;
    }

    // Barista per tanggal+shift = yang clock in di absensi (satu sumber, tanpa data ganda).
    const baristaByKey = await loadBaristas(days, from, to, warnings);

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

export default function handler(req, res) {
  return req.method === 'POST' ? ownerHandler(req, res) : kasirHandler(req, res);
}

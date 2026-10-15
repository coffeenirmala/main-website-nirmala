// api/sales-report.js
// Satu function untuk dua kebutuhan (hemat kuota function Vercel Hobby, maks 12):
//   GET  /api/sales-report?range=&date=  -> laporan tab Laporan di kasir
//   POST /api/sales-report {pin,from,to} -> terminal owner (PIN dicek di server: env OWNER_PIN)
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, OWNER_PIN, ABSEN_PIN (PIN rekap sistem absen, dipakai untuk data lama),
//      DAILY_TARGET_CUPS (opsional, default 33)
//
// ATURAN BISNIS
// - "Cup" = MINUMAN saja (kategori di DRINK_CATEGORIES). Makanan/Snack tidak dihitung.
//   Bundle dihitung per menu minuman di dalamnya. Redeem gratis tetap dihitung (cup tetap dibuat).
// - Target harian = DAILY_TARGET_CUPS cup, gabungan Shift 1 + Shift 2.
// - Barista per transaksi dibaca dari nc_sales.barista (dicatat checkout.js = yang clock in terakhir).
//   Transaksi lama (kolom kosong) memakai cara lama: siapa yang clock in di tanggal+shift itu.
import crypto from 'node:crypto';

const TZ = 'Asia/Jakarta';
const POS_TYPES = 'pos_sale,pos_sale_bundle,pos_sale_free,promo_used';
const SALE_TYPES = POS_TYPES;
const SHIFT_SPLIT_MIN = 15 * 60; // Shift 1: sebelum 15:00, Shift 2: 15:00 dst.
const MAX_DAYS = 93;
const DAILY_TARGET_CUPS = Number(process.env.DAILY_TARGET_CUPS) || 33;
// Kategori nc_menu yang dihitung sebagai MINUMAN. Ubah di sini kalau ada kategori minuman baru.
const DRINK_CATEGORIES = ['Coffee', 'Non Coffee', 'Mocktail'];
const NO_BARISTA = '(tanpa barista)';

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
const round1 = (n) => Math.round(n * 10) / 10;

const isDrink = (category) => {
  const c = String(category || '').trim().toLowerCase();
  return DRINK_CATEGORIES.some((x) => x.toLowerCase() === c);
};
// Jumlah CUP MINUMAN satu baris penjualan.
// - menu biasa / redeem gratis: qty kalau kategorinya minuman, selain itu 0
// - bundle: hanya menu minuman di dalam paket x jumlah paket
// - diskon (promo_used): 0
function drinkCupsOf(s, catMap, bundleInfo) {
  if (s.type === 'promo_used') return 0;
  if (s.type === 'pos_sale_bundle') {
    const p = bundleInfo[s.item];
    if (!p) return s.qty; // promo bundle sudah dihapus: tidak bisa dipilah, hitung seperti dulu
    if (p.type === 'bundle_qty') return isDrink(catMap[String(p.bundle_items || '').trim()]) ? (p.bundle_qty || 1) * s.qty : 0;
    const names = String(p.bundle_items || '').split(',').map((x) => x.trim()).filter(Boolean);
    return names.filter((n) => isDrink(catMap[n])).length * s.qty;
  }
  return isDrink(catMap[s.item]) ? s.qty : 0;
}
// Nama barista satu baris penjualan: dari kolom barista (akurat), kalau kosong dari absensi (perkiraan lama).
function baristaOfRow(s, shift, baristaByKey) {
  if (s.barista) return { name: s.barista, src: 'kasir' };
  const names = [...(baristaByKey[`${s.date}|${shift}`] || [])].sort();
  return { name: names.join(' & '), src: names.length ? 'absen' : '' };
}
// { 'YYYY-MM-DD|shift': Set(nama) } dari absensi (clock in). Gagal -> kosong + warning, laporan tetap jalan.
async function loadBaristas(days, from, to, warnings) {
  const map = {};
  const URL_ = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_ANON_KEY, PIN = process.env.ABSEN_PIN;
  if (!PIN) { warnings.push('ABSEN_PIN belum dipasang di Vercel, nama barista transaksi lama belum tampil'); return map; }
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
    const today = wibParts().date;
    const anchorStr = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : today;
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
    const catMap = Object.fromEntries(menuRows.map((m) => [m.name, m.category]));
    const bundlePriceMap = Object.fromEntries(promoRows.map((p) => [p.name, p.bundle_price]));
    const bundleInfo = Object.fromEntries(promoRows.map((p) => [p.name, p]));
    const warnings = [];
    const baristaByKey = await loadBaristas(days, startStr, endStr, warnings);
    const missingMenu = new Set();

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

      if (!isPromo && !isBundle && !(s.item in catMap)) missingMenu.add(s.item);

      const subtotal = isPromo ? -s.qty : (isFree ? 0 : price * s.qty);
      grandTotal += subtotal;

      // Jam transaksi (WIB, dengan detik). Data lama yang belum punya time_wib diambil dari ts.
      const time = s.time_wib ? String(s.time_wib).slice(0, 8) : (s.ts ? wibParts(new Date(Number(s.ts))).hms : '');

      const shift = shiftOfRow(s);
      const b = baristaOfRow(s, shift, baristaByKey);
      return {
        date: s.date,
        time,
        shift,
        barista: b.name,
        barista_src: b.src, // 'kasir' = tercatat saat transaksi, 'absen' = perkiraan dari absensi
        cups: drinkCupsOf(s, catMap, bundleInfo),
        item: isPromo ? `Diskon: ${s.item}` : s.item,
        qty: isPromo ? 1 : s.qty,
        unit: isPromo ? 'promo' : s.unit,
        price,
        subtotal,
        payment_type: s.payment_type || '',
        tipe: isPromo ? 'diskon' : (isFree ? 'redeem_gratis' : 'bayar'),
      };
    });
    if (missingMenu.size) warnings.push(`Menu tidak ada di nc_menu (tidak dihitung sebagai cup): ${[...missingMenu].join(', ')}`);

    // Rekap per tanggal + shift + barista: cup minuman terjual & omzet (net diskon).
    const shiftMap = {};
    for (const r of rows) {
      const k2 = `${r.date}|${r.shift}|${r.barista}`;
      const a = (shiftMap[k2] ||= { date: r.date, shift: r.shift, barista: r.barista, cups: 0, omzet: 0 });
      a.cups += r.cups; a.omzet += r.subtotal;
    }
    // Barista yang clock in tapi belum ada penjualan atas namanya tetap muncul (0 cup), supaya produktivitas adil.
    const present = {}; // 'date|shift' -> Set(nama)
    for (const r of rows) for (const n of String(r.barista).split(' & ').filter(Boolean)) (present[`${r.date}|${r.shift}`] ||= new Set()).add(n);
    for (const [key, names] of Object.entries(baristaByKey)) {
      const [d, sh] = key.split('|');
      for (const n of names) {
        if (present[key]?.has(n)) continue;
        shiftMap[`${d}|${sh}|${n}`] = { date: d, shift: Number(sh), barista: n, cups: 0, omzet: 0 };
      }
    }
    const shifts = Object.values(shiftMap)
      .sort((a, b) => a.date.localeCompare(b.date) || a.shift - b.shift || a.barista.localeCompare(b.barista));

    // Rekap harian + status target (Shift 1 + Shift 2 digabung).
    const dailyMap = Object.fromEntries(days.map((d) => [d, { date: d, cups: 0, cups_s1: 0, cups_s2: 0, omzet: 0 }]));
    for (const r of rows) {
      const d = dailyMap[r.date];
      if (!d) continue;
      d.cups += r.cups; d[`cups_s${r.shift}`] += r.cups; d.omzet += r.subtotal;
    }
    const daily = days.map((d) => ({
      ...dailyMap[d],
      target: DAILY_TARGET_CUPS,
      achieved: dailyMap[d].cups >= DAILY_TARGET_CUPS,
      in_progress: d === today, // hari ini belum selesai: jangan dianggap gagal dulu
    }));
    const totalCups = daily.reduce((s, d) => s + d.cups, 0);
    const counted = daily.filter((d) => d.date <= today && !d.in_progress);
    const team = {
      target_per_day: DAILY_TARGET_CUPS,
      total_cups: totalCups,
      days_in_range: days.length,
      days_completed: counted.length,
      days_achieved: daily.filter((d) => d.achieved).length, // hari ini yang sudah >= target ikut dihitung
      avg_cups_per_day: round1(totalCups / Math.max(1, days.filter((d) => d <= today).length)),
    };
    const shiftTotals = { 1: { cups: 0, omzet: 0 }, 2: { cups: 0, omzet: 0 } };
    for (const s of shifts) { shiftTotals[s.shift].cups += s.cups; shiftTotals[s.shift].omzet += s.omzet; }

    // Per barista selama rentang laporan (produktivitas per cup per shift).
    const bMap = {};
    for (const s of shifts) {
      const name = s.barista || NO_BARISTA;
      const a = (bMap[name] ||= { name, shifts: 0, cups: 0, omzet: 0 });
      a.shifts += 1; a.cups += s.cups; a.omzet += s.omzet;
    }
    const baristas = Object.values(bMap)
      .map((a) => ({ ...a, cups_per_shift: round1(a.cups / Math.max(1, a.shifts)) }))
      .sort((a, b) => b.cups - a.cups);

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
      total_cups: totalCups,
      daily_target: DAILY_TARGET_CUPS,
      team,
      daily,
      shift_totals: shiftTotals,
      baristas,
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
    const catMap = Object.fromEntries(menuRows.map((m) => [m.name, m.category]));
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

    // Atribusi barista per 'tanggal|shift': credited = punya nama dari kolom barista (akurat),
    // uncredited = transaksi lama tanpa nama (dibagi ke yang clock in di shift itu, seperti dulu).
    const credited = {};
    const uncredited = {};
    const addTo = (key, name, field, val) => {
      const bucket = name ? ((credited[key] ||= {})[name] ||= blank()) : (uncredited[key] ||= blank());
      bucket[field] += val;
    };

    for (const s of sales) {
      const day = byDay[s.date];
      if (!day) continue;
      const sh = shiftOfRow(s);
      const key = `${s.date}|${sh}`;

      if (s.type === 'promo_used') {
        day[sh].diskon += s.qty;
        addTo(key, s.barista, 'diskon', s.qty);
        const pt = payByTs[s.ts];
        if (pt in payments) payments[pt] -= s.qty;
        continue;
      }

      const isFree = s.type === 'pos_sale_free';
      const isBundle = s.type === 'pos_sale_bundle';
      const price = isFree ? 0 : isBundle ? (bundlePrice[s.item] ?? 0) : (priceMap[s.item] ?? 0);
      const sub = price * s.qty;
      const cups = drinkCupsOf(s, catMap, bundleInfo); // cup minuman saja

      day[sh].gross += sub;
      day[sh].pcs += cups;
      addTo(key, s.barista, 'gross', sub);
      addTo(key, s.barista, 'pcs', cups);
      txSet.add(s.ts);
      if (isFree) gratis += s.qty;
      if (s.payment_type in payments) payments[s.payment_type] += sub;

      if (!items[s.item]) items[s.item] = { item: s.item, qty: 0, omzet: 0, bundle: isBundle };
      items[s.item].qty += s.qty;
      items[s.item].omzet += sub;
    }

    // Barista dari absensi (dipakai untuk transaksi lama & untuk mencatat yang hadir tanpa penjualan).
    const baristaByKey = await loadBaristas(days, from, to, warnings);

    // Rangkuman harian, per shift, dan per barista.
    const daysOut = [];
    const shiftRows = [];
    const shiftTotals = { 1: blank(), 2: blank() };
    const baristaAgg = {};
    for (const d of days) {
      const row = { date: d, gross: 0, diskon: 0, pcs: 0, s1: null, s2: null };
      for (const sh of [1, 2]) {
        const key = `${d}|${sh}`;
        const b = byDay[d][sh];
        const omzet = b.gross - b.diskon;
        row[`s${sh}`] = { omzet, pcs: b.pcs };
        row.gross += b.gross; row.diskon += b.diskon; row.pcs += b.pcs;
        shiftTotals[sh].gross += b.gross; shiftTotals[sh].diskon += b.diskon; shiftTotals[sh].pcs += b.pcs;

        const absenNames = [...(baristaByKey[key] || [])].sort();
        const cr = credited[key] || {};
        const un = uncredited[key] || blank();
        const credit = (name, pcs, om, shared) => {
          const a = (baristaAgg[name] ||= { name, keys: new Set(), pcs: 0, omzet: 0, shared: false });
          a.keys.add(key); a.pcs += pcs; a.omzet += om; if (shared) a.shared = true;
        };
        for (const [name, v] of Object.entries(cr)) credit(name, v.pcs, v.gross - v.diskon, false);
        const unOmzet = un.gross - un.diskon;
        if (un.pcs || unOmzet) {
          if (absenNames.length) absenNames.forEach((n) => credit(n, un.pcs / absenNames.length, unOmzet / absenNames.length, absenNames.length > 1));
          else credit(NO_BARISTA, un.pcs, unOmzet, false);
        }
        absenNames.forEach((n) => credit(n, 0, 0, false)); // hadir tanpa penjualan tetap dihitung 1 shift

        const names = [...new Set([...Object.keys(cr), ...absenNames])].sort();
        if (b.pcs > 0 || names.length) shiftRows.push({ date: d, shift: sh, baristas: names, pcs: b.pcs, omzet });
      }
      row.omzet = row.gross - row.diskon;
      row.target_met = row.pcs >= DAILY_TARGET_CUPS;
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
      target_per_day: DAILY_TARGET_CUPS,
      totals: {
        omzet: totalGross - totalDiskon, gross: totalGross, diskon: totalDiskon,
        pcs: totalPcs, transaksi: txSet.size, gratis,
        days_target_met: daysOut.filter((d) => d.target_met).length,
      },
      shifts: {
        1: { omzet: shiftTotals[1].gross - shiftTotals[1].diskon, pcs: shiftTotals[1].pcs },
        2: { omzet: shiftTotals[2].gross - shiftTotals[2].diskon, pcs: shiftTotals[2].pcs },
      },
      payments,
      days: daysOut,
      shiftRows,
      baristas: Object.values(baristaAgg)
        .map((a) => ({ name: a.name, shifts: a.keys.size, pcs: round1(a.pcs), omzet: Math.round(a.omzet), shared: a.shared }))
        .sort((a, b) => b.omzet - a.omzet),
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

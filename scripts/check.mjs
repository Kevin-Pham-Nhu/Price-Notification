// Checks every wish-listed product on every store link, records price
// changes in docs/data/history.json and sends a Telegram alert when a
// target is reached. Run by .github/workflows/check-prices.yml.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract, storeKey, storeLabel } from './extract.mjs';
import { effectiveRrp, threshold, bestOffer, decide } from '../docs/logic.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR || path.join(root, 'docs', 'data');
const productsFile = path.join(dataDir, 'products.json');
const historyFile = path.join(dataDir, 'history.json');

const USER_AGENT = 'price-watch/1.0 (personal wishlist price tracker)';
const PAUSE_MS = 10_000; // between two requests to the same store

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const euro = (n) => n.toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });

const lastHit = {};
async function fetchPage(url) {
  const key = storeKey(url);
  const wait = (lastHit[key] || 0) + PAUSE_MS - Date.now();
  if (wait > 0) await sleep(wait);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html', 'Accept-Language': 'it-IT,it;q=0.9' },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });
    return extract(await res.text(), url, res.status);
  } catch (err) {
    return { status: 'error', message: `Could not reach the store (${err.cause?.code || err.name})` };
  } finally {
    lastHit[key] = Date.now();
  }
}

async function telegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) {
    console.log('  Telegram not configured — alert not sent.');
    return false;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!res.ok) console.log(`  Telegram refused the message (HTTP ${res.status}).`);
  return res.ok;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function alertText(product, best, limit, rrp) {
  const lines = [
    `🎯 <b>${esc(product.name)}</b> reached your target`,
    `${euro(best.price)} at ${esc(storeLabel(best.store))}`,
    product.target.type === 'discount'
      ? `Target: ${product.target.value}% off RRP (${euro(limit)} or less)`
      : `Target: ${euro(limit)} or less`,
  ];
  if (rrp && rrp > best.price) lines.push(`${Math.round((1 - best.price / rrp) * 100)}% below RRP (${euro(rrp)})`);
  lines.push(`<a href="${esc(best.url)}">Open the product page</a>`);
  return lines.join('\n');
}

if (process.argv.includes('--test-telegram')) {
  const ok = await telegram('✅ Price Watch is connected. Alerts will arrive in this chat.');
  process.exit(ok ? 0 : 1);
}

const { products = [] } = readJson(productsFile, { products: [] });
const history = readJson(historyFile, { products: {} });
history.products ||= {};
const now = new Date().toISOString();

for (const product of products) {
  console.log(product.name);
  const entry = (history.products[product.id] ||= { stores: {}, notified: null });
  const wanted = new Set();

  for (const link of product.stores || []) {
    const key = storeKey(link.url);
    wanted.add(key);
    const state = (entry.stores[key] ||= { points: [] });
    const result = await fetchPage(link.url);
    state.url = link.url;
    state.checked = now;
    state.status = result.status;
    state.message = result.message || null;
    if (result.status === 'ok') {
      state.price = result.price;
      state.rrp = result.rrp ?? state.rrp ?? null;
      state.inStock = result.inStock ?? null;
      state.title = result.title || state.title || null;
      const last = state.points.at(-1);
      if (!last || last[1] !== result.price) state.points.push([now, result.price]);
      console.log(`  ${storeLabel(key)}: ${euro(result.price)}${result.inStock === false ? ' (out of stock)' : ''}`);
    } else {
      console.log(`  ${storeLabel(key)}: ${result.status} — ${result.message}`);
    }
  }
  // A store link the user removed stops counting, but its history is kept.
  for (const key of Object.keys(entry.stores)) entry.stores[key].active = wanted.has(key);

  const active = Object.fromEntries(Object.entries(entry.stores).filter(([, s]) => s.active));
  const rrp = effectiveRrp(product, active);
  const limit = threshold(product, rrp);
  const best = bestOffer(active);
  const { notify, notified } = decide(best, limit, entry.notified);
  if (notify) {
    console.log(`  Target reached: ${euro(best.price)} ≤ ${euro(limit)}`);
    const sent = await telegram(alertText(product, best, limit, rrp));
    // If sending failed, leave the state unchanged so the next run retries.
    entry.notified = sent ? { ...notified, at: now } : entry.notified;
  } else {
    entry.notified = notified;
  }
}

// Forget products that were removed from the wishlist.
const ids = new Set(products.map((p) => p.id));
for (const id of Object.keys(history.products)) if (!ids.has(id)) delete history.products[id];

history.updated = now;
fs.writeFileSync(historyFile, JSON.stringify(history, null, 1) + '\n');
console.log(`Saved ${path.relative(root, historyFile)}`);

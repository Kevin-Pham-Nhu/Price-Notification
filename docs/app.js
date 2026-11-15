import { effectiveRrp, threshold, bestOffer } from './logic.mjs';

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);
const DAY = 86_400_000;
const euro = (n) => n.toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });
const euroShort = (n) => n.toLocaleString('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: n % 1 ? 2 : 0 });
const fmtDate = (t, withTime) =>
  new Date(t).toLocaleString('en-GB', withTime
    ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }
    : { day: 'numeric', month: 'short', year: 'numeric' });

function ago(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} minutes ago`;
  if (mins < 60 * 36) return `${Math.round(mins / 60)} hours ago`;
  return `${Math.round(mins / 1440)} days ago`;
}

/** Tiny DOM builder. Text always goes in as text nodes, never as HTML. */
function h(tag, attrs, ...kids) {
  const svg = ['svg', 'path', 'line', 'circle', 'rect', 'text', 'g'].includes(tag);
  const el = svg ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class' && !svg) el.className = v;
    else if (k in el && !svg && k !== 'list' && k !== 'form') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 6000);
}

// ---------- stores ----------
const STORE_NAMES = { 'amazon.it': 'Amazon', 'unieuro.it': 'Unieuro', 'mediaworld.it': 'MediaWorld' };
const FIXED_SLOTS = { 'amazon.it': 1, 'unieuro.it': 2, 'mediaworld.it': 3 };

function storeKey(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}
const storeLabel = (key) => STORE_NAMES[key] || key;

/** A store keeps the same colour everywhere, whatever else is on screen. */
function storeColor(key) {
  let slot = FIXED_SLOTS[key];
  if (!slot) {
    const others = [...new Set(state.products.flatMap((p) => p.stores.map((s) => storeKey(s.url))))]
      .filter((k) => k && !FIXED_SLOTS[k]).sort();
    slot = 4 + others.indexOf(key);
  }
  return slot >= 1 && slot <= 8 ? `var(--series-${slot})` : 'var(--muted)';
}

// ---------- state ----------
const state = { products: [], history: { products: {} }, sha: null, filter: 'all', sort: 'gap' };

const settings = (() => {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem('pw.settings') || '{}');
  } catch { /* storage unavailable */ }
  const host = location.hostname;
  const guess = host.endsWith('.github.io')
    ? { owner: host.split('.')[0], repo: location.pathname.split('/')[1] || '' }
    : {};
  return { owner: '', repo: '', branch: '', token: '', ...guess, ...saved };
})();

function saveSettings() {
  try {
    localStorage.setItem('pw.settings', JSON.stringify(settings));
  } catch { /* storage unavailable */ }
}

// ---------- GitHub (saving the wishlist) ----------
const FILE = 'docs/data/products.json';
const canSave = () => settings.token && settings.owner && settings.repo;

async function gh(path, options = {}) {
  const res = await fetch(`https://api.github.com/repos/${settings.owner}/${settings.repo}${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${settings.token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    const hint = { 401: 'the token is not valid', 403: 'the token lacks permission', 404: 'repository or file not found — check Settings', 409: 'the file changed meanwhile — reload and retry' }[res.status];
    throw new Error(`GitHub said no (${res.status}${hint ? `: ${hint}` : ''})`);
  }
  return res.json();
}

async function branch() {
  if (!settings.branch) {
    settings.branch = (await gh('')).default_branch;
    saveSettings();
  }
  return settings.branch;
}

const b64decode = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
const b64encode = (s) => btoa(Array.from(new TextEncoder().encode(s), (b) => String.fromCharCode(b)).join(''));

async function load() {
  const bust = `?t=${Date.now()}`;
  const getJson = async (url, fallback) => {
    try {
      const res = await fetch(url + bust, { cache: 'no-store' });
      return res.ok ? await res.json() : fallback;
    } catch {
      return fallback;
    }
  };
  state.history = await getJson('data/history.json', { products: {} });
  state.history.products ||= {};
  let products = null;
  if (canSave()) {
    // Read the wishlist straight from the repository so a just-saved change shows at once.
    try {
      const file = await gh(`/contents/${FILE}?ref=${encodeURIComponent(await branch())}`);
      state.sha = file.sha;
      products = JSON.parse(b64decode(file.content)).products;
    } catch (err) {
      toast(`Could not read the wishlist from GitHub: ${err.message}`);
    }
  }
  state.products = products || (await getJson('data/products.json', { products: [] })).products || [];
  render();
}

async function persist(products, message) {
  const text = JSON.stringify({ products }, null, 2) + '\n';
  if (!canSave()) return manualSave(text);
  const br = await branch();
  if (!state.sha) {
    try {
      state.sha = (await gh(`/contents/${FILE}?ref=${encodeURIComponent(br)}`)).sha;
    } catch { /* file does not exist yet */ }
  }
  const out = await gh(`/contents/${FILE}`, {
    method: 'PUT',
    body: JSON.stringify({ message, content: b64encode(text), sha: state.sha || undefined, branch: br }),
  });
  state.sha = out.content.sha;
  state.products = products;
  render();
  toast('Saved. A price check starts now; new prices show up here in a few minutes.');
  return true;
}

// ---------- product model ----------
function valueAt(points, t) {
  let v = null;
  for (const [iso, price] of points) {
    if (new Date(iso).getTime() <= t) v = price;
    else break;
  }
  return v;
}

function model(product) {
  const hist = state.history.products[product.id] || { stores: {} };
  const stores = product.stores.map((link) => {
    const key = storeKey(link.url);
    const s = hist.stores?.[key] || {};
    return { key, label: storeLabel(key), color: storeColor(key), url: link.url, points: [], ...s };
  });
  const byKey = Object.fromEntries(stores.map((s) => [s.key, s]));
  const rrp = effectiveRrp(product, byKey);
  const limit = threshold(product, rrp);
  const best = bestOffer(byKey);
  const issues = stores.filter((s) => s.status === 'blocked' || s.status === 'error');
  const checked = stores.some((s) => s.checked);

  let status;
  if (!best) status = checked ? { kind: 'problem', label: 'No price' } : { kind: 'pending', label: 'First check pending' };
  else if (limit == null) status = { kind: 'pending', label: 'RRP needed' };
  else if (best.price <= limit) status = { kind: 'buy', label: 'Buy now' };
  else if (best.price <= limit * 1.05) status = { kind: 'close', label: 'Close' };
  else status = { kind: 'wait', label: 'Wait' };

  // Best price over time: the cheapest store at every moment a price changed.
  const times = [...new Set(stores.flatMap((s) => s.points.map((p) => new Date(p[0]).getTime())))].sort((a, b) => a - b);
  const bestLine = [];
  for (const t of times) {
    const vals = stores.map((s) => valueAt(s.points, t)).filter((v) => v != null);
    const v = Math.min(...vals);
    if (!bestLine.length || bestLine.at(-1)[1] !== v) bestLine.push([t, v]);
  }

  return {
    product, stores, rrp, limit, best, status, issues, bestLine,
    gap: best && limit != null ? (best.price - limit) / limit : null,
    discount: best && rrp ? 1 - best.price / rrp : null,
    lastChecked: stores.map((s) => s.checked).filter(Boolean).sort().at(-1) || null,
  };
}

function targetText(m) {
  const t = m.product.target;
  if (t.type === 'discount') return m.limit != null ? `${t.value}% off RRP (${euroShort(m.limit)})` : `${t.value}% off RRP`;
  return euroShort(t.value);
}

// ---------- dashboard ----------
function render() {
  const models = state.products.map(model);
  const updated = state.history.updated;
  $('#updated').textContent = updated
    ? `Prices last checked ${ago(updated)} · ${fmtDate(updated, true)}`
    : 'No price check has run yet';

  const reached = models.filter((m) => m.status.kind === 'buy');
  const problems = models.filter((m) => m.issues.length);
  const tile = (label, value, sub) =>
    h('div', { class: 'tile' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), h('div', { class: 'sub' }, sub));
  $('#tiles').replaceChildren(
    tile('Products tracked', String(models.length), `${new Set(models.flatMap((m) => m.stores.map((s) => s.key))).size} stores`),
    tile('Targets reached', String(reached.length), reached.length ? reached.map((m) => m.product.name).join(', ') : 'Nothing to buy yet'),
    tile('Close to target', String(models.filter((m) => m.status.kind === 'close').length), 'Within 5% of your target'),
    tile('Store problems', String(problems.length), problems.length ? 'Some stores could not be read' : 'All stores readable'),
  );

  $('#filters').hidden = !models.length;
  const grid = $('#grid');
  if (!models.length) {
    grid.replaceChildren(
      h('div', { class: 'empty' },
        h('p', {}, h('strong', {}, 'Your wishlist is empty')),
        h('p', {}, 'Add a product with its page link on each store you want to compare.'),
        h('button', { class: 'btn primary', onclick: () => openForm() }, 'Add product')),
    );
    return;
  }

  let shown = models;
  if (state.filter === 'reached') shown = models.filter((m) => m.status.kind === 'buy');
  if (state.filter === 'issues') shown = models.filter((m) => m.issues.length);
  const last = (v) => (v == null ? Infinity : v);
  const sorters = {
    gap: (a, b) => last(a.gap) - last(b.gap),
    discount: (a, b) => last(b.discount == null ? null : -b.discount) - last(a.discount == null ? null : -a.discount),
    price: (a, b) => last(a.best?.price) - last(b.best?.price),
    name: (a, b) => a.product.name.localeCompare(b.product.name),
  };
  shown = [...shown].sort(sorters[state.sort]);
  grid.replaceChildren(...(shown.length ? shown.map(card) : [h('div', { class: 'empty' }, h('p', {}, 'No products match this filter.'))]));
}

function badge(status) {
  return h('span', { class: `badge ${status.kind}` }, h('span', { class: 'dot' }), status.label);
}

function sparkline(m) {
  const W = 96, H = 34, pad = 4;
  const now = Date.now();
  const from = Math.max(m.bestLine[0][0], now - 90 * DAY);
  const start = valueAt(m.bestLine.map(([t, v]) => [new Date(t).toISOString(), v]), from) ?? m.bestLine[0][1];
  const pts = [[from, start], ...m.bestLine.filter(([t]) => t > from)];
  const vals = pts.map((p) => p[1]);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const x = (t) => pad + ((t - from) / Math.max(now - from, 1)) * (W - 2 * pad);
  const y = (v) => (hi === lo ? H / 2 : pad + (1 - (v - lo) / (hi - lo)) * (H - 2 * pad));
  let d = `M${x(pts[0][0]).toFixed(1)},${y(pts[0][1]).toFixed(1)}`;
  for (const [t, v] of pts.slice(1)) d += `H${x(t).toFixed(1)}V${y(v).toFixed(1)}`;
  d += `H${x(now).toFixed(1)}`;
  return h('svg', { class: 'spark', width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' },
    h('path', { d, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2, 'stroke-linejoin': 'round' }),
    h('circle', { cx: x(now), cy: y(vals.at(-1)), r: 3, fill: 'var(--accent)' }));
}

function storeAmount(s, best) {
  if (s.status === 'blocked') return h('span', { class: 'amount muted' }, 'Blocked by store');
  if (s.status === 'error') return h('span', { class: 'amount muted' }, s.price ? `${euro(s.price)} · check failed` : 'Check failed');
  if (!s.price) return h('span', { class: 'amount muted' }, 'Pending');
  if (s.inStock === false) return h('span', { class: 'amount muted' }, `${euro(s.price)} · out of stock`);
  return h('span', { class: `amount${best && best.store === s.key ? ' best' : ''}` }, euro(s.price));
}

function targetMeter(m) {
  if (!m.best || m.limit == null) return null;
  const reached = m.best.price <= m.limit;
  const top = Math.max(m.rrp || 0, ...m.stores.flatMap((s) => s.points.map((p) => p[1])), m.best.price);
  const frac = reached ? 1 : top > m.limit ? Math.min(1, Math.max(0.03, (top - m.best.price) / (top - m.limit))) : 0.03;
  const diff = m.best.price - m.limit;
  return h('div', {},
    h('div', { class: 'target-line' },
      h('span', {}, `Target ${targetText(m)}`),
      h('span', {}, reached ? (diff ? `${euroShort(-diff)} below target` : 'Target reached') : `${euroShort(diff)} to go`)),
    h('div', { class: `meter${reached ? ' done' : ''}` }, h('i', { style: `width:${(frac * 100).toFixed(0)}%` })));
}

function card(m) {
  const sub = m.best
    ? [`at ${storeLabel(m.best.store)}`, m.discount > 0.005 ? `${Math.round(m.discount * 100)}% below RRP` : null].filter(Boolean).join(' · ')
    : 'No store has a price yet';
  return h('button', { class: 'card', onclick: () => openDetail(m.product.id), 'aria-label': `${m.product.name}: details` },
    h('div', { class: 'card-head' }, h('span', { class: 'name' }, m.product.name), badge(m.status)),
    h('div', { class: 'price-row' },
      h('div', {}, h('div', { class: 'price' }, m.best ? euro(m.best.price) : '—'), h('div', { class: 'price-sub' }, sub)),
      m.bestLine.length ? sparkline(m) : null),
    targetMeter(m) || h('div', { class: 'target-line' }, h('span', {}, `Target ${targetText(m)}`),
      h('span', {}, m.product.target.type === 'discount' && !m.rrp ? 'RRP not known yet' : '')),
    h('div', { class: 'stores' }, m.stores.map((s) =>
      h('div', { class: 'store-row' },
        h('span', { class: 'who' }, h('span', { class: 'key', style: `background:${s.color}` }), s.label),
        storeAmount(s, m.best)))));
}

// ---------- detail view ----------
let detailRange = 90;
let chartObserver = null;

function openDetail(id) {
  const product = state.products.find((p) => p.id === id);
  if (!product) return;
  const m = model(product);
  const dlg = $('#dlg-detail');

  const all = m.stores.flatMap((s) => s.points.map(([iso, price]) => ({ t: new Date(iso).getTime(), price, store: s })));
  const lowest = all.length ? all.reduce((a, b) => (b.price < a.price ? b : a)) : null;
  const avg30 = timeAverage(m.bestLine, 30);
  const stat = (label, value, sub) =>
    h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), h('div', { class: 'sub' }, sub || ' '));

  const chartBox = h('div', { class: 'chart' });
  const rangeChips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Time range' },
    [[30, '30 days'], [90, '90 days'], [0, 'All']].map(([days, label]) =>
      h('button', { class: 'chip', 'aria-pressed': String(detailRange === days), onclick: (e) => {
        detailRange = days;
        for (const c of rangeChips.children) c.setAttribute('aria-pressed', String(c === e.currentTarget));
        drawChart(chartBox, m);
      } }, label)));

  const changes = all.sort((a, b) => b.t - a.t);
  const prevOf = (c) => c.store.points[c.store.points.findIndex((p) => new Date(p[0]).getTime() === c.t) - 1]?.[1];

  dlg.replaceChildren(...[
    h('div', { class: 'dlg-head' },
      h('div', {}, h('h2', {}, product.name), h('p', { class: 'muted small' }, m.lastChecked ? `Checked ${ago(m.lastChecked)}` : 'Not checked yet')),
      h('div', { class: 'inline' }, badge(m.status), h('button', { class: 'x', 'aria-label': 'Close', onclick: () => dlg.close() }, '×'))),
    h('div', { class: 'stats' },
      stat('Best price now', m.best ? euro(m.best.price) : '—', m.best ? `at ${storeLabel(m.best.store)}` : 'No store has a price'),
      stat('Your target', m.limit != null ? euro(m.limit) : '—', product.target.type === 'discount' ? `${product.target.value}% off RRP` : 'Fixed price'),
      stat('RRP', m.rrp ? euro(m.rrp) : '—', m.rrp ? (product.rrp ? 'Entered by you' : 'As shown by the store') : 'No store shows one'),
      stat('Lowest seen', lowest ? euro(lowest.price) : '—', lowest ? `${lowest.store.label}, ${fmtDate(lowest.t)}` : ''),
      stat('30-day average', avg30 ? euro(avg30) : '—', avg30 && m.best ? vsAverage(m.best.price, avg30) : '')),
    all.length
      ? [h('div', { class: 'chart-head' },
          h('div', { class: 'legend' }, m.stores.filter((s) => s.points.length).map((s) =>
            h('span', {}, h('span', { class: 'key', style: `background:${s.color}` }), s.label))),
          rangeChips),
        chartBox]
      : h('p', { class: 'muted', style: 'margin-top:20px' }, 'The price history chart appears after the first successful check.'),
    h('h3', {}, 'Stores'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('tr', {}, h('th', {}, 'Store'), h('th', { class: 'num' }, 'Price'), h('th', { class: 'num' }, 'vs RRP'), h('th', {}, 'Status'), h('th', {}, '')),
      m.stores.map((s) => h('tr', {},
        h('td', {}, h('span', { class: 'inline' }, h('span', { class: 'key', style: `background:${s.color}` }), s.label)),
        h('td', { class: 'num' }, s.price ? euro(s.price) : '—'),
        h('td', { class: 'num' }, s.price && m.rrp && s.price < m.rrp ? `−${Math.round((1 - s.price / m.rrp) * 100)}%` : '—'),
        h('td', {}, storeStatus(s)),
        h('td', {}, h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open')))))),
    changes.length ? h('details', {},
      h('summary', {}, `Price changes (${changes.length})`),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Store'), h('th', { class: 'num' }, 'Price'), h('th', { class: 'num' }, 'Change')),
        changes.slice(0, 200).map((c) => {
          const prev = prevOf(c);
          const delta = prev == null ? null : c.price - prev;
          return h('tr', {}, h('td', {}, fmtDate(c.t, true)), h('td', {}, c.store.label), h('td', { class: 'num' }, euro(c.price)),
            h('td', { class: 'num' }, delta == null ? 'First seen' : `${delta < 0 ? '↓ −' : '↑ +'}${euro(Math.abs(delta))}`));
        })))) : null,
    h('div', { class: 'dlg-foot' },
      h('button', { class: 'btn danger', onclick: () => confirmRemove(product) }, 'Remove'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => { dlg.close(); openForm(product); } }, 'Edit'),
      h('button', { class: 'btn primary', onclick: () => dlg.close() }, 'Done')),
  ].flat().filter(Boolean));
  dlg.showModal();
  if (all.length) {
    drawChart(chartBox, m);
    chartObserver?.disconnect();
    chartObserver = new ResizeObserver(() => drawChart(chartBox, m));
    chartObserver.observe(chartBox);
  }
}

function storeStatus(s) {
  if (s.status === 'blocked') return h('span', { class: 'status-bad' }, '✕ Blocked — this store refuses automated checks');
  if (s.status === 'error') return h('span', { class: 'status-bad' }, `✕ ${s.message || 'Check failed'}`);
  if (s.status === 'ok') return s.inStock === false ? h('span', {}, 'Out of stock') : h('span', { class: 'status-ok' }, '✓ Price read');
  return h('span', { class: 'muted' }, 'Waiting for first check');
}

function timeAverage(line, days) {
  if (!line.length) return null;
  const now = Date.now();
  const from = Math.max(now - days * DAY, line[0][0]);
  if (now - from < 60_000) return line.at(-1)[1];
  let sum = 0;
  for (let i = 0; i < line.length; i++) {
    const a = Math.max(line[i][0], from);
    const b = i + 1 < line.length ? line[i + 1][0] : now;
    if (b > a) sum += line[i][1] * (b - a);
  }
  return Math.round((sum / (now - from)) * 100) / 100;
}

function vsAverage(price, avg) {
  const pct = Math.round((price / avg - 1) * 100);
  return pct === 0 ? 'Now at the average' : `Now ${Math.abs(pct)}% ${pct < 0 ? 'below' : 'above'} it`;
}

function niceTicks(lo, hi, count = 4) {
  const span = hi - lo || Math.max(1, hi * 0.1);
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw);
  const ticks = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 0.999; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

function drawChart(box, m) {
  const W = Math.max(300, Math.round(box.clientWidth || 800));
  const H = W < 520 ? 240 : 300;
  const mg = { l: 58, r: W < 520 ? 14 : 96, t: 16, b: 28 };
  const endLabels = W >= 520;
  const now = Date.now();
  const series = m.stores.filter((s) => s.points.length).map((s) => ({ ...s, pts: s.points.map(([iso, v]) => [new Date(iso).getTime(), v]) }));
  const first = Math.min(...series.map((s) => s.pts[0][0]));
  let t0 = detailRange ? Math.max(first, now - detailRange * DAY) : first;
  t0 = Math.min(t0, now - DAY);

  for (const s of series) {
    const startVal = valueAt(s.points, t0);
    s.vis = [...(startVal != null ? [[t0, startVal]] : []), ...s.pts.filter(([t]) => t > t0)];
    s.end = s.checked ? Math.max(new Date(s.checked).getTime(), s.vis.at(-1)?.[0] || 0) : now;
  }
  const values = series.flatMap((s) => s.vis.map((p) => p[1]));
  if (m.limit != null) values.push(m.limit);
  let lo = Math.min(...values), hi = Math.max(...values);
  const padY = (hi - lo || hi * 0.05) * 0.12;
  const ticks = niceTicks(lo - padY, hi + padY);
  lo = ticks[0];
  hi = ticks.at(-1);

  const x = (t) => mg.l + ((t - t0) / (now - t0)) * (W - mg.l - mg.r);
  const y = (v) => mg.t + (1 - (v - lo) / (hi - lo)) * (H - mg.t - mg.b);
  const svg = h('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img',
    'aria-label': `Price history of ${m.product.name} per store. The same data is in the tables below.` });

  for (const v of ticks) {
    svg.append(h('line', { x1: mg.l, x2: W - mg.r, y1: y(v), y2: y(v), stroke: 'var(--grid)', 'stroke-width': 1 }),
      h('text', { x: mg.l - 8, y: y(v) + 4, 'text-anchor': 'end' }, euroShort(v)));
  }
  const short = now - t0 < 3 * DAY;
  const nx = W < 520 ? 3 : 5;
  for (let i = 0; i < nx; i++) {
    const t = t0 + ((now - t0) * i) / (nx - 1);
    const label = new Date(t).toLocaleString('en-GB', short ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short' });
    svg.append(h('text', { x: x(t), y: H - 8, 'text-anchor': i === 0 ? 'start' : i === nx - 1 ? 'end' : 'middle' }, label));
  }
  svg.append(h('line', { x1: mg.l, x2: W - mg.r, y1: y(lo), y2: y(lo), stroke: 'var(--axis)', 'stroke-width': 1 }));

  if (m.limit != null) {
    svg.append(h('line', { x1: mg.l, x2: W - mg.r, y1: y(m.limit), y2: y(m.limit), stroke: 'var(--ink-2)', 'stroke-width': 1.5, 'stroke-dasharray': '5 4' }),
      h('text', { class: 'target', x: mg.l + 6, y: y(m.limit) - 6 }, `Target ${euroShort(m.limit)}`));
  }

  for (const s of series) {
    if (!s.vis.length) continue;
    let d = `M${x(s.vis[0][0]).toFixed(1)},${y(s.vis[0][1]).toFixed(1)}`;
    for (const [t, v] of s.vis.slice(1)) d += `H${x(t).toFixed(1)}V${y(v).toFixed(1)}`;
    d += `H${x(s.end).toFixed(1)}`;
    svg.append(h('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round' }),
      h('circle', { cx: x(s.end), cy: y(s.vis.at(-1)[1]), r: 5, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2 }));
  }
  if (endLabels) {
    const labels = series.filter((s) => s.vis.length).map((s) => ({ s, y: y(s.vis.at(-1)[1]) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 15);
    for (const l of labels) svg.append(h('text', { class: 'end', x: W - mg.r + 10, y: l.y + 4 }, l.s.label));
  }

  // Hover layer: a crosshair that reads every store's price at that moment.
  const hair = h('line', { y1: mg.t, y2: H - mg.b, stroke: 'var(--muted)', 'stroke-width': 1, visibility: 'hidden' });
  const tip = h('div', { class: 'tooltip', hidden: true });
  const hit = h('rect', { x: mg.l, y: mg.t, width: W - mg.l - mg.r, height: H - mg.t - mg.b, fill: 'transparent' });
  const hide = () => { hair.setAttribute('visibility', 'hidden'); tip.hidden = true; };
  hit.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    const px = Math.min(W - mg.r, Math.max(mg.l, ((e.clientX - rect.left) / rect.width) * W));
    const t = t0 + ((px - mg.l) / (W - mg.l - mg.r)) * (now - t0);
    const rows = series.map((s) => ({ s, v: t <= s.end + 1 ? valueAt(s.points, t) : null })).filter((r) => r.v != null).sort((a, b) => a.v - b.v);
    if (!rows.length) return hide();
    hair.setAttribute('x1', px);
    hair.setAttribute('x2', px);
    hair.setAttribute('visibility', 'visible');
    tip.replaceChildren(h('div', { class: 'when' }, fmtDate(t, true)),
      ...rows.map((r) => h('div', { class: 'row' }, h('span', { class: 'key', style: `background:${r.s.color}` }), h('span', {}, r.s.label), h('b', {}, euro(r.v)))));
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const left = e.clientX + 14 + tw > innerWidth ? e.clientX - 14 - tw : e.clientX + 14;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${Math.max(4, Math.min(innerHeight - th - 4, e.clientY - th - 10))}px`;
  });
  hit.addEventListener('pointerleave', hide);
  svg.append(hair, hit);
  box.replaceChildren(svg, tip);
}

// ---------- add / edit ----------
function slug(name) {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'product';
  let id = base, n = 2;
  while (state.products.some((p) => p.id === id)) id = `${base}-${n++}`;
  return id;
}

function openForm(product) {
  const dlg = $('#dlg-form');
  const t = product?.target || { type: 'price', value: '' };
  const name = h('input', { type: 'text', required: true, value: product?.name || '', placeholder: 'iPad mini 128 GB' });
  const urls = h('textarea', { required: true, placeholder: 'https://www.unieuro.it/online/…\nhttps://www.amazon.it/dp/…', value: (product?.stores || []).map((s) => s.url).join('\n') });
  const typePrice = h('input', { type: 'radio', name: 'ttype', value: 'price', checked: t.type === 'price' });
  const typeDisc = h('input', { type: 'radio', name: 'ttype', value: 'discount', checked: t.type === 'discount' });
  const value = h('input', { type: 'number', min: '0.01', step: '0.01', required: true, value: t.value });
  const unit = h('span', {}, '');
  const rrp = h('input', { type: 'number', min: '0.01', step: '0.01', value: product?.rrp || '', placeholder: 'Automatic' });
  const error = h('p', { class: 'error', hidden: true });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, product ? 'Save changes' : 'Add product');
  const syncUnit = () => (unit.textContent = typeDisc.checked ? '% below RRP' : '€ or less');
  typePrice.onchange = typeDisc.onchange = syncUnit;
  syncUnit();

  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    const fail = (msg) => { error.textContent = msg; error.hidden = false; };
    const links = urls.value.split(/\s+/).filter(Boolean);
    const keys = links.map(storeKey);
    if (!links.length || keys.some((k) => !k) || links.some((l) => !/^https:\/\//.test(l))) return fail('Each store link must be a full address starting with https://');
    if (new Set(keys).size !== keys.length) return fail('Use one link per store.');
    const val = Number(value.value);
    if (!(val > 0) || (typeDisc.checked && val >= 100)) return fail(typeDisc.checked ? 'The discount must be between 0 and 100%.' : 'Enter a target price above 0.');
    const next = {
      id: product?.id || slug(name.value.trim()),
      name: name.value.trim(),
      rrp: Number(rrp.value) > 0 ? Number(rrp.value) : null,
      target: { type: typeDisc.checked ? 'discount' : 'price', value: val },
      stores: links.map((url) => ({ url })),
      added: product?.added || new Date().toISOString(),
    };
    const list = product ? state.products.map((p) => (p.id === product.id ? next : p)) : [...state.products, next];
    submit.disabled = true;
    try {
      if (await persist(list, `${product ? 'Update' : 'Add'} ${next.name}`)) dlg.close();
    } catch (err) {
      fail(err.message);
    } finally {
      submit.disabled = false;
    }
  } },
    h('label', { class: 'field' }, h('span', {}, 'Product name'), name),
    h('label', { class: 'field' }, h('span', {}, 'Store links'), urls,
      h('small', {}, 'Paste the product page from each store, one per line. Pick the exact model, size and colour you want.')),
    h('fieldset', {}, h('legend', {}, 'Alert me when the best price is'),
      h('div', { class: 'radio-row' }, h('label', { class: 'inline' }, typePrice, 'At a price'), h('label', { class: 'inline' }, typeDisc, 'At a % discount off RRP')),
      h('div', { class: 'inline' }, value, unit)),
    h('label', { class: 'field' }, h('span', {}, 'RRP in € (optional)'), rrp,
      h('small', {}, 'Leave empty to use the recommended price the stores display. Fill it in if no store shows one.')),
    error,
    h('div', { class: 'dlg-foot' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel'), submit));

  dlg.replaceChildren(h('div', { class: 'dlg-head' }, h('h2', {}, product ? 'Edit product' : 'Add product'),
    h('button', { class: 'x', 'aria-label': 'Close', onclick: () => dlg.close() }, '×')), form);
  dlg.showModal();
}

function confirmRemove(product) {
  const dlg = $('#dlg-confirm');
  const error = h('p', { class: 'error', hidden: true });
  const go = h('button', { class: 'btn danger', onclick: async () => {
    go.disabled = true;
    try {
      if (await persist(state.products.filter((p) => p.id !== product.id), `Remove ${product.name}`)) {
        dlg.close();
        $('#dlg-detail').close();
      }
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      go.disabled = false;
    }
  } }, 'Remove');
  dlg.replaceChildren(h('h2', {}, `Remove ${product.name}?`),
    h('p', { class: 'muted', style: 'margin-top:8px' }, 'Its price history is deleted at the next price check.'), error,
    h('div', { class: 'dlg-foot' }, h('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'), go));
  dlg.showModal();
}

/** Without a token the page cannot write to the repository: hand over the file instead. */
function manualSave(text) {
  const dlg = $('#dlg-confirm');
  const editUrl = settings.owner && settings.repo
    ? `https://github.com/${settings.owner}/${settings.repo}/edit/${settings.branch || 'HEAD'}/${FILE}` : null;
  dlg.replaceChildren(h('h2', {}, 'One more step to save'),
    h('p', { class: 'muted', style: 'margin-top:8px' }, 'This page has no access token yet, so it cannot save for you. Add one in Settings, or replace the contents of docs/data/products.json with this:'),
    h('pre', { class: 'code' }, text),
    h('div', { class: 'dlg-foot' },
      editUrl ? h('a', { class: 'btn', href: editUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Open file on GitHub') : null,
      h('button', { class: 'btn', onclick: () => navigator.clipboard?.writeText(text).then(() => toast('Copied')) }, 'Copy'),
      h('button', { class: 'btn primary', onclick: () => { dlg.close(); openSettings(); } }, 'Open Settings')));
  $('#dlg-form').close();
  dlg.showModal();
  return false;
}

function openSettings() {
  const dlg = $('#dlg-settings');
  const owner = h('input', { type: 'text', value: settings.owner, placeholder: 'your GitHub user name' });
  const repo = h('input', { type: 'text', value: settings.repo, placeholder: 'Price-Notification' });
  const token = h('input', { type: 'password', value: settings.token, placeholder: 'github_pat_…', autocomplete: 'off' });
  const error = h('p', { class: 'error', hidden: true });
  dlg.replaceChildren(
    h('div', { class: 'dlg-head' }, h('h2', {}, 'Settings'), h('button', { class: 'x', 'aria-label': 'Close', onclick: () => dlg.close() }, '×')),
    h('form', { onsubmit: async (e) => {
      e.preventDefault();
      Object.assign(settings, { owner: owner.value.trim(), repo: repo.value.trim(), token: token.value.trim(), branch: '' });
      state.sha = null;
      try {
        if (canSave()) await branch();
        saveSettings();
        dlg.close();
        toast(canSave() ? 'Connected to GitHub.' : 'Settings saved.');
        load();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      }
    } },
      h('p', { class: 'hint' }, 'To add or edit products from this page, it needs permission to save the wishlist file in your GitHub repository. Create a fine-grained access token limited to this one repository with "Contents: Read and write", and paste it here. It is stored only in this browser.'),
      h('label', { class: 'field' }, h('span', {}, 'GitHub owner'), owner),
      h('label', { class: 'field' }, h('span', {}, 'Repository'), repo),
      h('label', { class: 'field' }, h('span', {}, 'Access token'), token),
      error,
      h('div', { class: 'dlg-foot' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel'), h('button', { class: 'btn primary', type: 'submit' }, 'Save'))));
  dlg.showModal();
}

// ---------- wiring ----------
$('#btn-add').onclick = () => openForm();
$('#btn-settings').onclick = openSettings;
$('#sort').onchange = (e) => { state.sort = e.target.value; render(); };
for (const chip of document.querySelectorAll('#filters .chip')) {
  chip.onclick = () => {
    state.filter = chip.dataset.filter;
    for (const c of document.querySelectorAll('#filters .chip')) c.setAttribute('aria-pressed', String(c === chip));
    render();
  };
}
$('#dlg-detail').addEventListener('close', () => chartObserver?.disconnect());

load();

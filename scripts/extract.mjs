// Turns a store's product page HTML into { price, rrp, inStock, title }.
// No store protections are bypassed: if a store refuses the request, the
// result is reported as "blocked" and shown that way on the dashboard.

export const STORES = {
  'amazon.it': 'Amazon',
  'unieuro.it': 'Unieuro',
  'mediaworld.it': 'MediaWorld',
};

/** "www.amazon.it" -> "amazon.it" */
export function storeKey(url) {
  return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
}

export function storeLabel(key) {
  return STORES[key] || key;
}

/** Parses "1.299,00 €", "€ 24,88", "1299.00", "1,299.00" into a number. */
export function parsePrice(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null;
  if (raw == null) return null;
  let s = String(raw).replace(/&nbsp;|\s/g, '').replace(/[^0-9.,]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // The later separator is the decimal one.
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma > -1) {
    // "24,88" is decimal; "1,299" is a thousands separator.
    s = /,\d{3}$/.test(s) && s.length > 4 ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, ''); // "1.299" in Italian notation
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

const BLOCK_PATTERNS = [
  /Just a moment\.\.\./i,
  /Ci siamo quasi/i,
  /<title>\s*Ci dispiace/i,
  /api-services-support@amazon\.com/i,
  /captcha/i,
  /Access Denied/i,
  /cf-challenge|challenge-platform/i,
];

export function looksBlocked(html, status) {
  if (status === 403 || status === 429 || status === 503) return true;
  if (html.length < 20000 && BLOCK_PATTERNS.some((re) => re.test(html))) return true;
  return false;
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const k in node) walk(node[k], visit);
}

function title(html) {
  const m = html.match(/<title[^>]*>([^<]*)/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

/** Unieuro embeds the product as JSON in <script id="ng-state">. */
function unieuro(html, url) {
  const m = html.match(/<script id="ng-state" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  let state;
  try {
    state = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const pid = (url.match(/-pid([A-Za-z0-9_]+)/) || [])[1];
  let hit = null;
  walk(state, (o) => {
    if (hit || !o.price || typeof o.price.value !== 'number') return;
    if (pid && o.code !== pid) return;
    hit = o;
  });
  if (!hit) return null;
  const rrp = parsePrice(hit.originalPrice?.value) || parsePrice(hit.crossedOutPrice?.value);
  const stock = hit.stock?.stockLevelStatus;
  return {
    price: parsePrice(hit.price.value),
    rrp: rrp && rrp >= hit.price.value ? rrp : null,
    inStock: stock ? stock !== 'outOfStock' : null,
    title: hit.name || null,
  };
}

/** Amazon's standard buy-box markup, when the page is served. */
function amazon(html) {
  const pay = html.match(/priceToPay[\s\S]{0,400}?a-offscreen">([^<]+)</) ||
    html.match(/id="corePrice[\s\S]{0,1500}?a-offscreen">([^<]+)</);
  if (!pay) return null;
  const basis = html.match(/basisPrice[\s\S]{0,600}?a-offscreen">([^<]+)</);
  const price = parsePrice(pay[1]);
  const rrp = basis ? parsePrice(basis[1]) : null;
  const avail = (html.match(/id="availability"[\s\S]{0,400}?<span[^>]*>([^<]+)</) || [])[1] || '';
  return {
    price,
    rrp: rrp && price && rrp >= price ? rrp : null,
    inStock: avail ? !/non disponibile|unavailable/i.test(avail) : null,
    title: (html.match(/id="productTitle"[^>]*>([^<]+)</) || [])[1]?.trim() || null,
  };
}

/** schema.org Product data (JSON-LD), then price meta tags. Works on many shops. */
function generic(html) {
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    let data;
    try {
      data = JSON.parse(b[1].trim());
    } catch {
      continue;
    }
    let found = null;
    walk(data, (o) => {
      if (found) return;
      const type = [].concat(o['@type'] || []);
      if (!type.includes('Product') || !o.offers) return;
      const offer = [].concat(o.offers)[0];
      const price = parsePrice(offer.price ?? offer.lowPrice ?? offer.priceSpecification?.price);
      if (!price) return;
      const avail = String(offer.availability || '');
      found = {
        price,
        rrp: null,
        inStock: avail ? /InStock|PreOrder|LimitedAvailability/i.test(avail) : null,
        title: typeof o.name === 'string' ? o.name : null,
      };
    });
    if (found) return found;
  }
  const meta = html.match(/<meta[^>]+(?:property|itemprop|name)=["'](?:product:price:amount|og:price:amount|price)["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|itemprop|name)=["'](?:product:price:amount|og:price:amount|price)["']/i);
  if (meta) {
    const price = parsePrice(meta[1]);
    if (price) return { price, rrp: null, inStock: null, title: null };
  }
  return null;
}

/**
 * @returns {{status:'ok'|'blocked'|'error', price?:number, rrp?:number|null,
 *            inStock?:boolean|null, title?:string|null, message?:string}}
 */
export function extract(html, url, httpStatus = 200) {
  const key = storeKey(url);
  let res = null;
  if (key === 'unieuro.it') res = unieuro(html, url);
  else if (key.startsWith('amazon.')) res = amazon(html);
  if (!res || !res.price) res = generic(html) || res;
  if (res && res.price) {
    return { status: 'ok', ...res, title: res.title || title(html) };
  }
  if (looksBlocked(html, httpStatus)) {
    return { status: 'blocked', message: 'The store refused the automated request' };
  }
  if (httpStatus === 404 || httpStatus === 410) {
    return { status: 'error', message: 'Product page not found — check the link' };
  }
  return { status: 'error', message: `No price found on the page (HTTP ${httpStatus})` };
}

// Shared rules: what the best price is, and when a target counts as reached.
// Used by both the checker (scripts/check.mjs) and the dashboard (app.js).

/** The recommended retail price used for % discount targets. */
export function effectiveRrp(product, storeStates) {
  if (product.rrp) return product.rrp;
  const seen = Object.values(storeStates || {}).map((s) => s.rrp).filter(Boolean);
  return seen.length ? Math.max(...seen) : null;
}

/** Price at or below which the target is reached, or null if it can't be computed. */
export function threshold(product, rrp) {
  const t = product.target;
  if (!t || !t.value) return null;
  if (t.type === 'price') return t.value;
  if (t.type === 'discount') return rrp ? Math.round(rrp * (100 - t.value)) / 100 : null;
  return null;
}

/** Cheapest store with a current price; stores known to be out of stock are skipped. */
export function bestOffer(storeStates) {
  let best = null;
  for (const [key, s] of Object.entries(storeStates || {})) {
    if (s.status !== 'ok' || !s.price || s.inStock === false) continue;
    if (!best || s.price < best.price) best = { store: key, price: s.price, url: s.url };
  }
  return best;
}

/**
 * Decides whether to send an alert, so a reached target is announced once
 * and again only if the price drops further.
 * @returns {{notify:boolean, notified:object|null}}
 */
export function decide(best, limit, previous) {
  if (!best || limit == null || best.price > limit) return { notify: false, notified: null };
  if (previous && best.price >= previous.price) return { notify: false, notified: previous };
  return { notify: true, notified: { price: best.price, store: best.store } };
}

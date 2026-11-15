// Run with: node --test scripts/test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePrice, extract, storeKey } from './extract.mjs';
import { effectiveRrp, threshold, bestOffer, decide } from '../docs/logic.mjs';

test('parsePrice handles Italian and plain formats', () => {
  assert.equal(parsePrice('1.299,00 €'), 1299);
  assert.equal(parsePrice('€ 24,88'), 24.88);
  assert.equal(parsePrice('1299.00'), 1299);
  assert.equal(parsePrice('1,299.50'), 1299.5);
  assert.equal(parsePrice('1.299'), 1299);
  assert.equal(parsePrice('4.679'), 4679);
  assert.equal(parsePrice('24.5'), 24.5);
  assert.equal(parsePrice(599), 599);
  assert.equal(parsePrice(''), null);
});

test('storeKey strips www', () => {
  assert.equal(storeKey('https://www.unieuro.it/online/x-pidABC'), 'unieuro.it');
});

test('Unieuro: reads price, RRP and stock for the product in the URL', () => {
  const state = {
    a: { b: { code: 'OTHER', name: 'Accessory', price: { value: 9.99 } } },
    c: {
      b: {
        code: 'APL123',
        name: 'iPad mini',
        price: { value: 549 },
        originalPrice: { value: 609 },
        stock: { stockLevelStatus: 'inStock' },
      },
    },
  };
  const html = `<title>x</title><script id="ng-state" type="application/json">${JSON.stringify(state)}</script>`;
  const r = extract(html, 'https://www.unieuro.it/online/Tablet/iPad-mini-pidAPL123');
  assert.deepEqual(r, { status: 'ok', price: 549, rrp: 609, inStock: true, title: 'iPad mini' });
});

test('Generic: reads schema.org Product data', () => {
  const ld = { '@type': 'Product', name: 'Thing', offers: { price: '1.299,00', availability: 'https://schema.org/OutOfStock' } };
  const html = `<script type="application/ld+json">${JSON.stringify(ld)}</script>`;
  const r = extract(html, 'https://shop.example/thing');
  assert.equal(r.status, 'ok');
  assert.equal(r.price, 1299);
  assert.equal(r.inStock, false);
});

test('Amazon: reads buy-box price and list price', () => {
  const html = `<span id="productTitle"> MacBook </span><div id="corePriceDisplay_desktop_feature_div">
    <span class="priceToPay"><span class="a-offscreen">1.899,00 €</span></span>
    <span class="basisPrice">Prezzo consigliato: <span class="a-price"><span class="a-offscreen">2.099,00 €</span></span></span></div>`;
  const r = extract(html, 'https://www.amazon.it/dp/B000000000');
  assert.equal(r.price, 1899);
  assert.equal(r.rrp, 2099);
});

test('A refused request is reported as blocked', () => {
  assert.equal(extract('<title>Just a moment...</title>', 'https://www.mediaworld.it/x', 403).status, 'blocked');
  assert.equal(extract('<title>Ci dispiace</title>', 'https://www.amazon.it/dp/B0', 200).status, 'blocked');
  assert.equal(extract('<html></html>', 'https://shop.example/x', 200).status, 'error');
});

test('target rules', () => {
  const stores = {
    'a.it': { status: 'ok', price: 520, rrp: 600, url: 'a' },
    'b.it': { status: 'ok', price: 500, rrp: 609, inStock: false, url: 'b' },
    'c.it': { status: 'blocked', price: 100 },
  };
  assert.equal(effectiveRrp({}, stores), 609);
  assert.equal(effectiveRrp({ rrp: 650 }, stores), 650);
  assert.equal(threshold({ target: { type: 'discount', value: 10 } }, 600), 540);
  assert.equal(threshold({ target: { type: 'discount', value: 10 } }, null), null);
  assert.equal(threshold({ target: { type: 'price', value: 499 } }, 600), 499);
  assert.deepEqual(bestOffer(stores), { store: 'a.it', price: 520, url: 'a' });

  const best = bestOffer(stores);
  assert.equal(decide(best, 540, null).notify, true);
  assert.equal(decide(best, 540, { price: 520 }).notify, false); // already announced
  assert.equal(decide(best, 540, { price: 530 }).notify, true); // dropped further
  assert.deepEqual(decide(best, 510, { price: 505 }), { notify: false, notified: null }); // back above target
});

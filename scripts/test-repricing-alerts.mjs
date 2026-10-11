import assert from 'node:assert/strict';
import { evaluateAlert, parsePublicPageDetails } from '../api/repricing-monitor.js';

function row(overrides = {}) {
  return {
    sku: 'BESTBY-TEST',
    title: 'Bestby Test Product',
    selling_price: 299,
    quantity_available: 10,
    ...overrides,
  };
}

function details(overrides = {}) {
  return {
    source: 'public_page_html',
    buyBoxPrice: 299,
    buyBoxSeller: 'Bestby',
    offers: [],
    ...overrides,
  };
}

assert.equal(evaluateAlert({ row: row(), storeName: 'Bestby', productDetails: details() }).isActive, false);

const lostBuyBox = evaluateAlert({
  row: row(),
  storeName: 'Bestby',
  productDetails: details({ buyBoxPrice: 272, buyBoxSeller: 'Silver Star online' }),
});
assert.equal(lostBuyBox.isActive, true);
assert.equal(lostBuyBox.alertType, 'lost_buy_box');
assert.equal(lostBuyBox.lowestCompetitorSeller, 'Silver Star online');
assert.equal(lostBuyBox.priceGap, 27);

assert.equal(evaluateAlert({
  row: row(),
  storeName: 'Bestby',
  productDetails: details({ buyBoxPrice: 299, buyBoxSeller: '' }),
}).isActive, false);

assert.equal(evaluateAlert({
  row: row(),
  storeName: 'Bestby',
  productDetails: details({ buyBoxPrice: 250, buyBoxSeller: '' }),
}).isActive, true);

assert.equal(evaluateAlert({
  row: row({ quantity_available: 0 }),
  storeName: 'Bestby',
  productDetails: details({ buyBoxPrice: 250, buyBoxSeller: 'Competitor' }),
}).isActive, false);

const publicPage = parsePublicPageDetails(`
  <main><strong>R 272</strong><div>Sold by Silver Star online VAT Registered</div>
  <section>Other Offers <strong>R 299</strong> Bestby Seller Score</section></main>
`, 'Bestby');
assert.equal(publicPage.buyBoxPrice, 272);
assert.equal(publicPage.buyBoxSeller, 'Silver Star online');
assert.equal(publicPage.offers.some((offer) => offer.seller === 'Bestby' && offer.price === 299), true);

console.log('repricing alert tests passed');

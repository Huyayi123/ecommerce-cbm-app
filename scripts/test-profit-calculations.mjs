import assert from 'node:assert/strict';

function warehouseFee(seaFreightCost) {
  return seaFreightCost > 0 ? Math.round(Math.ceil(seaFreightCost / 15) * 10 * 100) / 100 : 0;
}

function excluded(status) {
  return /cancel(?:led)?|return(?:ed)?|refund(?:ed)?/i.test(status);
}

function profit({ sellingPrice, purchaseCostRmb, unitCbm, totalFees }) {
  const seaFreight = Math.round(unitCbm * 3600 * 100) / 100;
  return Math.round((sellingPrice - purchaseCostRmb * 3 - seaFreight - totalFees - warehouseFee(seaFreight)) * 100) / 100;
}

function unitSellingPrice(sellingPrice, quantity) {
  return Math.round((sellingPrice / quantity) * 100) / 100;
}

assert.equal(warehouseFee(0), 0);
assert.equal(warehouseFee(15), 10);
assert.equal(warehouseFee(15.01), 20);
assert.equal(warehouseFee(30), 20);
assert.equal(warehouseFee(30.01), 30);
assert.equal(warehouseFee(45), 30);
assert.equal(profit({ sellingPrice: 200, purchaseCostRmb: 20, unitCbm: 0.01, totalFees: 40 }), 34);
assert.equal(profit({ sellingPrice: 100, purchaseCostRmb: 20, unitCbm: 0.01, totalFees: 40 }), -66);
assert.equal(profit({ sellingPrice: 166, purchaseCostRmb: 20, unitCbm: 0.01, totalFees: 40 }), 0);
assert.equal(excluded('Cancelled by customer'), true);
assert.equal(excluded('Returned'), true);
assert.equal(excluded('Preparing for Customer'), false);
assert.equal(unitSellingPrice(1158, 2), 579);
assert.equal(unitSellingPrice(1000, 3), 333.33);
console.log('profit calculation boundary tests passed');

import assert from 'node:assert/strict';

function warehouseFee(seaFreightCost) {
  return seaFreightCost > 0 ? Math.round(Math.ceil(seaFreightCost / 15) * 10 * 100) / 100 : 0;
}

function domesticFreight(seaFreightCost) {
  return seaFreightCost > 0 ? Math.round((3 + (Math.ceil(seaFreightCost / 10) - 1) * 1.5) * 100) / 100 : 0;
}

function excluded(status) {
  return /cancel(?:led)?|return(?:ed)?|refund(?:ed)?/i.test(status);
}

function profit({ sellingPrice, purchaseCostRmb, unitCbm, totalFees }) {
  const seaFreight = Math.round(unitCbm * 3600 * 100) / 100;
  return Math.round((sellingPrice - purchaseCostRmb * 3 - seaFreight - domesticFreight(seaFreight) - totalFees - warehouseFee(seaFreight)) * 100) / 100;
}

function unitSellingPrice(sellingPrice, quantity) {
  return Math.round((sellingPrice / quantity) * 100) / 100;
}

function chooseSale(sales) {
  return sales.filter((sale) => sale.totalFees > 0 && sale.quantity > 0 && !excluded(sale.status))
    .sort((left, right) => {
      if ((left.quantity === 1) !== (right.quantity === 1)) return left.quantity === 1 ? -1 : 1;
      return Date.parse(right.date) - Date.parse(left.date);
    })[0];
}

assert.equal(warehouseFee(0), 0);
assert.equal(warehouseFee(15), 10);
assert.equal(warehouseFee(15.01), 20);
assert.equal(warehouseFee(30), 20);
assert.equal(warehouseFee(30.01), 30);
assert.equal(warehouseFee(45), 30);
assert.equal(domesticFreight(0), 0);
assert.equal(domesticFreight(0.01), 3);
assert.equal(domesticFreight(10), 3);
assert.equal(domesticFreight(10.01), 4.5);
assert.equal(domesticFreight(20), 4.5);
assert.equal(domesticFreight(20.01), 6);
assert.equal(profit({ sellingPrice: 200, purchaseCostRmb: 20, unitCbm: 0.01, totalFees: 40 }), 26.5);
assert.equal(profit({ sellingPrice: 100, purchaseCostRmb: 20, unitCbm: 0.01, totalFees: 40 }), -73.5);
assert.equal(profit({ sellingPrice: 173.5, purchaseCostRmb: 20, unitCbm: 0.01, totalFees: 40 }), 0);
assert.equal(excluded('Cancelled by customer'), true);
assert.equal(excluded('Returned'), true);
assert.equal(excluded('Preparing for Customer'), false);
assert.equal(unitSellingPrice(1158, 2), 579);
assert.equal(unitSellingPrice(1000, 3), 333.33);
assert.equal(chooseSale([
  { date: '2026-08-04', quantity: 1, totalFees: 0, status: 'Preparing' },
  { date: '2026-08-03', quantity: 1, totalFees: 25, status: 'Preparing' },
]).date, '2026-08-03');
assert.equal(chooseSale([
  { date: '2026-08-04', quantity: 2, totalFees: 30, status: 'Preparing' },
  { date: '2026-08-01', quantity: 1, totalFees: 20, status: 'Preparing' },
]).date, '2026-08-01');
assert.equal(chooseSale([
  { date: '2026-08-04', quantity: 2, totalFees: 0, status: 'Preparing' },
  { date: '2026-08-02', quantity: 3, totalFees: 40, status: 'Preparing' },
]).date, '2026-08-02');
console.log('profit calculation boundary tests passed');

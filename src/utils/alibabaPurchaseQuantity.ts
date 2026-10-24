import { effectivePurchaseQuantity, normalizeMixedGroups } from './purchaseRecords';

type Numeric = number | string | null;
export type CandidateQuantityFields = {
  purchase_quantity?: Numeric;
  confirmed_purchase_quantity?: Numeric;
  manual_purchase_total_quantity?: Numeric;
  carton_count?: Numeric;
  units_per_carton?: Numeric;
  tail_quantity?: Numeric;
  mixed_groups?: unknown;
};

// Read-only adapter: use exactly the established business calculation.
export function candidatePurchaseQuantities(row: CandidateQuantityFields) {
  const nullable = (value: Numeric | undefined) => value === null || value === undefined ? null : Number(value);
  const planned = Number(row.purchase_quantity ?? 0);
  const main = effectivePurchaseQuantity({
    purchaseQuantity: planned,
    confirmedPurchaseQuantity: nullable(row.confirmed_purchase_quantity),
    manualPurchaseTotalQuantity: nullable(row.manual_purchase_total_quantity),
    cartonCount: nullable(row.carton_count),
    unitsPerCarton: nullable(row.units_per_carton),
    tailQuantity: Number(row.tail_quantity ?? 0),
  });
  const mixed = normalizeMixedGroups(row.mixed_groups).reduce((sum, group) =>
    sum + group.lines.reduce((lineSum, line) => lineSum + line.quantity, 0), 0);
  return { planned, main, mixed, total: main + mixed };
}

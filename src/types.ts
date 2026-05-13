export type SkuItem = {
  id: string;
  sku: string;
  productName: string;
  englishName: string;
  manufacturerName: string;
  shopName: string;
  buyerName: string;
  purchasePrice: number;
  cartonLengthCm: number;
  cartonWidthCm: number;
  cartonHeightCm: number;
  unitsPerCarton: number;
  totalQuantity: number;
  totalCbm: number;
  manualUnitCbm: number;
  notes: string;
  cbmSource: 'imported' | 'total' | 'carton' | 'missing';
  cartonCbm: number;
  unitCbm: number;
  updatedAt: string;
};

export type PurchaseRow = {
  rowId: string;
  rowNumber: number;
  sku: string;
  productName: string;
  englishName: string;
  manufacturerName: string;
  purchaseQuantity: number | null;
  raw: Record<string, unknown>;
};

export type PurchaseStatus = 'pending' | 'ordered' | 'in_transit' | 'arrived' | 'cancelled';
export type UserRole = 'admin' | 'buyer' | 'viewer';
export type AuditAction =
  | 'sku_created'
  | 'sku_updated'
  | 'sku_deleted'
  | 'purchase_created'
  | 'purchase_updated'
  | 'purchase_deleted'
  | 'purchase_price_changed'
  | 'purchase_marked_arrived'
  | 'purchase_bulk_marked_arrived';

export type AppProfile = {
  id: string;
  email: string;
  role: UserRole;
  displayName: string;
  buyerName: string;
};

export type PurchaseRecord = {
  id: string;
  manufacturerName: string;
  sku: string;
  productName: string;
  englishName: string;
  shopName: string;
  buyerName: string;
  assignedBuyerName: string;
  assignedBuyerEmail: string;
  purchaseQuantity: number;
  purchasePrice: number;
  totalAmount: number;
  purchaseDate: string;
  estimatedArrivalDate: string;
  status: PurchaseStatus;
  unitCbm: number;
  totalCbm: number;
  note: string;
};

export type CalculationRow = {
  rowId: string;
  rowNumber: number;
  sku: string;
  manufacturerName: string;
  productName: string;
  englishName: string;
  shopName: string;
  buyerName: string;
  purchaseQuantity: number | null;
  purchasePrice: number | null;
  totalAmount: number | null;
  unitCbm: number | null;
  totalCbm: number | null;
  status: 'ok' | 'warning' | 'error';
  messages: string[];
};

export type ContainerSummary = {
  containerCbm: number;
  targetCbm: number;
  totalCbm: number;
  remainingCbm: number;
  usageRate: number;
  statusText: string;
  statusLevel: 'under' | 'good' | 'over';
};

export type SalesSuggestionRow = {
  rowId: string;
  sku: string;
  productName: string;
  shopName: string;
  manufacturerName: string;
  buyerName: string;
  monthlySales: number;
  stockMonths: number;
  targetQuantity: number;
  inTransitQuantity: number;
  suggestedQuantity: number;
  unitsPerCarton: number | null;
  estimatedCartons: number | null;
  estimatedCbm: number | null;
  messages: string[];
};

export type AuditLog = {
  id: string;
  actorId: string;
  actorEmail: string;
  actorRole: UserRole;
  action: AuditAction;
  entityType: 'sku' | 'purchase_record' | 'container' | 'sales_suggestion';
  entityId: string;
  summary: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type SkuImportPreviewRow = {
  rowNumber: number;
  item: SkuItem | null;
  action: 'create' | 'update' | 'fail';
  errors: string[];
};

export type SkuImportPreview = {
  fileName: string;
  headers: string[];
  recognizedFields: Array<{ field: string; header: string }>;
  unrecognizedHeaders: string[];
  missingRequiredFields: string[];
  rows: SkuImportPreviewRow[];
};

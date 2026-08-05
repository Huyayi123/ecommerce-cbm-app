export type SkuItem = {
  id: string;
  internalCode: string;
  sku: string;
  tsin: string;
  productName: string;
  englishName: string;
  imageUrl: string;
  manufacturerName: string;
  storageLocation: string;
  purchaseUrl: string;
  shopName: string;
  buyerName: string;
  isSeasonal: boolean;
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
  internalCode?: string;
  sku: string;
  productName: string;
  englishName: string;
  imageUrl?: string;
  manufacturerName: string;
  shopName?: string;
  purchaseQuantity: number | null;
  manualTotalCbm?: number | null;
  raw: Record<string, unknown>;
};

export type PurchaseStatus = 'pending' | 'in_transit' | 'arrived' | 'cancelled';
export type PurchasePoolStatus = 'open' | 'sent' | 'closed';
export type PurchaseRecordPoolStatus = 'pending_purchase' | 'submitted_to_pool' | 'sent_to_inventory';
export type UserRole = 'owner' | 'admin' | 'buyer' | 'viewer' | 'logistics';
export type LogisticsBatchStatus = 'draft' | 'submitted' | 'approved' | 'rejected';
export type LogisticsConfirmationStatus = 'unassigned' | 'draft' | 'submitted' | 'approved' | 'rejected';
export type AuditAction =
  | 'sku_created'
  | 'sku_updated'
  | 'sku_deleted'
  | 'sku_bulk_changed'
  | 'purchase_created'
  | 'purchase_bulk_created'
  | 'purchase_updated'
  | 'purchase_deleted'
  | 'purchase_price_changed'
  | 'purchase_marked_arrived'
  | 'purchase_bulk_marked_arrived'
  | 'profile_binding_updated';

export type AppProfile = {
  id: string;
  email: string;
  role: UserRole;
  displayName: string;
  buyerName: string;
};

export type MixedCartonLine = {
  id: string;
  sku: string;
  productName: string;
  quantity: number;
  purchasePrice: number;
  unitCbm: number;
  totalAmount: number;
  totalCbm: number;
};

export type MixedCartonGroup = {
  id: string;
  groupName: string;
  cartonCount: number;
  lines: MixedCartonLine[];
};

export type PurchaseRecord = {
  id: string;
  internalCode: string;
  manufacturerName: string;
  sku: string;
  productName: string;
  englishName: string;
  imageUrl: string;
  shopName: string;
  buyerName: string;
  assignedBuyerName: string;
  assignedBuyerEmail: string;
  isConfirmed: boolean;
  purchaseQuantity: number;
  confirmedPurchaseQuantity: number | null;
  purchasePrice: number;
  freightCost: number;
  totalAmount: number;
  purchaseDate: string;
  purchasePoolId: string;
  purchasePoolName: string;
  purchasePoolDate: string;
  poolStatus: PurchaseRecordPoolStatus;
  purchaseBatchId: string;
  purchaseBatchName: string;
  purchaseBatchDate: string;
  estimatedArrivalDate: string;
  status: PurchaseStatus;
  unitCbm: number;
  totalCbm: number;
  loadingType: '' | '整柜' | '冠通';
  containerDate: string;
  totalWeightKg: number | null;
  cartonCount: number | null;
  unitsPerCarton: number | null;
  tailQuantity: number;
  isMixed: boolean;
  mixedGroups: MixedCartonGroup[];
  logisticsTotalCbm: number | null;
  logisticsBatchId: string;
  logisticsConfirmationStatus: LogisticsConfirmationStatus;
  logisticsLoadedCartonCount: number | null;
  logisticsLoadedTailQuantity: number;
  logisticsLeftCartonCount: number | null;
  logisticsLeftTailQuantity: number;
  logisticsSourceRecordId: string;
  note: string;
  createdAt?: string;
  updatedAt?: string;
};

export type LogisticsBatchItem = {
  id: string;
  batchId: string;
  purchaseRecordId: string;
  internalCode: string;
  manufacturerName: string;
  sku: string;
  productName: string;
  englishName: string;
  imageUrl: string;
  shopName: string;
  containerDate: string;
  cartonCount: number | null;
  unitsPerCarton: number | null;
  tailQuantity: number;
  loadingType: PurchaseRecord['loadingType'];
  isMixed: boolean;
  mixedGroupsSummary: string;
  loadedCartonCount: number | null;
  loadedTailQuantity: number;
  leftCartonCount: number | null;
  leftTailQuantity: number;
  note: string;
  createdAt: string;
  updatedAt: string;
};

export type LogisticsBatch = {
  id: string;
  containerDate: string;
  logisticsUserId: string;
  logisticsEmail: string;
  status: LogisticsBatchStatus;
  createdBy: string;
  createdAt: string;
  submittedAt: string;
  reviewedBy: string;
  reviewedAt: string;
  note: string;
  items: LogisticsBatchItem[];
};

export type PurchasePool = {
  id: string;
  name: string;
  containerDate: string;
  status: PurchasePoolStatus;
  createdBy: string;
  createdAt: string;
  sentBy: string;
  sentAt: string;
  note: string;
  records: PurchaseRecord[];
};

export type CalculationRow = {
  rowId: string;
  rowNumber: number;
  internalCode: string;
  sku: string;
  manufacturerName: string;
  productName: string;
  englishName: string;
  imageUrl: string;
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
  imageUrl?: string;
  shopName: string;
  manufacturerName: string;
  buyerName: string;
  monthlySales: number;
  stockMonths: number;
  targetQuantity: number;
  localStockQuantity: number;
  takealotStockQuantity: number;
  stockOnWayQuantity: number;
  inTransitQuantity: number;
  suggestedQuantity: number;
  unitsPerCarton: number | null;
  estimatedCartons: number | null;
  estimatedCbm: number | null;
  messages: string[];
};

export type RepricingAlertLevel = 'high' | 'medium' | 'review' | 'none';

export type RepricingAlert = {
  id: string;
  shopName: string;
  storeId: string;
  sku: string;
  title: string;
  imageUrl: string;
  productName: string;
  myPrice: number | null;
  buyBoxPrice: number | null;
  lowestCompetitorPrice: number | null;
  lowestCompetitorSeller: string;
  priceGap: number | null;
  alertLevel: RepricingAlertLevel;
  alertType: string;
  alertMessage: string;
  isActive: boolean;
  checkedAt: string;
  updatedAt: string;
};

export type AdStrategyLabel = 'no_profit' | 'green_star' | 'yellow_cow' | 'orange_question' | 'loss_product' | 'new_test' | 'new_optimize' | 'missing_data';

export type AdAnalysisRow = {
  id: string;
  runId: string;
  sku: string;
  productId: string;
  productName: string;
  shopName: string;
  imageUrl: string;
  adSpend: number;
  adSalesQuantity: number;
  roas: number | null;
  salePrice: number;
  platformFee: number;
  platformFeeSource: 'api' | 'fallback' | 'missing';
  purchaseCostRmb: number;
  purchaseCostZar: number;
  unitCbm: number;
  seaFreightCost: number;
  warehouseFee: number;
  adCostPerSale: number;
  profitRate: number | null;
  skuRank: number | null;
  productAgeStatus: 'protection' | 'new' | 'old' | 'unknown';
  strategyLabel: AdStrategyLabel;
  strategyName: string;
  actionSuggestion: string;
  messages: string[];
};

export type AdAnalysisRun = {
  id: string;
  createdAt: string;
  createdBy: string;
  sourceFileName: string;
  rowCount: number;
  summary: Record<string, number>;
  rows: AdAnalysisRow[];
};

export type TakealotSale = {
  orderId: string;
  orderItemId: string;
  sku: string;
  orderDate: string;
  saleStatus: string;
  sellingPrice: number | null;
  quantity: number;
  totalFees: number | null;
};

export type TakealotReturnTransaction = {
  transactionType: string;
  amountInclVat: number;
};

export type TakealotReturn = {
  returnId: string;
  orderId: string;
  sku: string;
  returnDate: string;
  quantity: number;
  transactions: TakealotReturnTransaction[];
};

export type MonthlyProfitDetail = {
  sku: string;
  productName: string;
  salesQuantity: number;
  salesRevenue: number;
  salesProfit: number;
  returnQuantity: number;
  returnProfitReversal: number;
  returnNetFees: number;
  netProfit: number;
  messages: string[];
};

export type MonthlyProfitSummary = {
  id: string;
  shopName: string;
  month: string;
  dataCutoffDate: string;
  isCurrentMonth: boolean;
  salesRevenue: number;
  salesQuantity: number;
  salesProfit: number;
  returnQuantity: number;
  returnProfitReversal: number;
  returnNetFees: number;
  advertisingCost: number;
  finalProfit: number;
  missingSalesQuantity: number;
  missingSalesRevenue: number;
  missingReturnQuantity: number;
  status: 'complete' | 'incomplete';
  note: string;
  createdBy: string;
  updatedAt: string;
};

export type ProfitAnalysisStatus = 'profit' | 'loss' | 'break_even' | 'missing_data';

export type ProfitAnalysisRow = {
  id: string;
  runId: string;
  shopName: string;
  sku: string;
  productName: string;
  imageUrl: string;
  latestOrderDate: string;
  sellingPrice: number | null;
  purchaseCostRmb: number | null;
  purchaseCostZar: number | null;
  unitCbm: number | null;
  seaFreightCost: number | null;
  domesticFreightCost: number | null;
  warehouseFee: number | null;
  totalFees: number | null;
  profit: number | null;
  status: ProfitAnalysisStatus;
  messages: string[];
  syncedAt: string;
};

export type ProfitAnalysisRun = {
  id: string;
  shopName: string;
  createdAt: string;
  createdBy: string;
  rowCount: number;
  rows: ProfitAnalysisRow[];
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

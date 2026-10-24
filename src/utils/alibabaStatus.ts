// Source: getLogisticsInfos.buyerView-1 / result.status, supplied from the
// official API documentation by the user. Never infer a status from remark.
export const alibabaStatusLabels: Record<string, string> = {
  WAITACCEPT: '未受理', CANCEL: '物流单已撤销', ACCEPT: '已受理',
  TRANSPORT: '运输中', NOGET: '揽件失败', SIGN: '已签收', UNSIGN: '签收异常',
};
export const alibabaMappingVersion = 'buyer-logistics-status-v1';

export type ShipmentSnapshot = {
  accountCode: 'A' | 'B';
  orderId: string;
  logisticsId: string;
  rawStatus: string;
};

export type LogisticsAggregate = {
  status: string;
  detail: string;
  shipment_count: number;
  signed_count: number;
  unknown_count: number;
  exception_count: number;
  coverage_confirmed: boolean;
  mapping_version: string;
};

export function summarizeAlibabaShipments(
  shipments: ShipmentSnapshot[],
  scope: { accountCode: 'A' | 'B'; orderIds: string[]; associationComplete: boolean; allGoodsShipped: boolean; allOrdersQueried: boolean },
): LogisticsAggregate {
  const expectedOrders = new Set(scope.orderIds);
  if (!expectedOrders.size || scope.orderIds.some((id) => !/^[1-9]\d*$/.test(id))) throw new Error('Invalid order scope');
  const distinct = new Map<string, ShipmentSnapshot>();
  for (const item of shipments) {
    if (item.accountCode !== scope.accountCode || typeof item.orderId !== 'string' || !expectedOrders.has(item.orderId)) {
      throw new Error('Account/order mismatch');
    }
    if (!item.logisticsId.trim()) throw new Error('Missing logistics ID');
    const key = `${item.orderId}:${item.logisticsId}`;
    const previous = distinct.get(key);
    if (previous && previous.rawStatus !== item.rawStatus) throw new Error('Conflicting shipment statuses');
    distinct.set(key, item);
  }
  const rows = [...distinct.values()];
  const count = rows.length;
  const signed = rows.filter((row) => row.rawStatus === 'SIGN').length;
  const unknown = rows.filter((row) => !Object.hasOwn(alibabaStatusLabels, row.rawStatus)).length;
  const exceptions = rows.filter((row) => ['NOGET', 'UNSIGN', 'CANCEL'].includes(row.rawStatus)).length;
  const represented = new Set(rows.map((row) => row.orderId));
  const coverage = scope.associationComplete && scope.allGoodsShipped && scope.allOrdersQueried
    && [...expectedOrders].every((id) => represented.has(id));
  let status = 'unknown';
  let detail = '暂无可判断的物流单；不能据此认定未发货';
  if (count) {
    if (signed === count) {
      status = coverage ? 'signed' : 'returned_signed';
      detail = coverage ? `全部签收（${signed}/${count}物流单）` : `已返回物流单全部签收（${signed}/${count}）；整笔采购完整性待确认`;
    } else if (signed > 0) {
      status = 'partial_signed';
      detail = `部分签收（${signed}/${count}已返回物流单）`;
    } else {
      const codes = new Set(rows.map((row) => row.rawStatus));
      if (codes.size === 1 && !unknown) {
        const code = rows[0].rawStatus;
        status = ({ WAITACCEPT: 'unaccepted', CANCEL: 'logistics_cancelled', ACCEPT: 'accepted',
          TRANSPORT: 'in_transit', NOGET: 'pickup_failed', UNSIGN: 'sign_exception' } as Record<string, string>)[code] ?? 'unknown';
        detail = `${alibabaStatusLabels[code]}（${count}物流单）`;
      } else {
        status = unknown ? 'unknown' : 'mixed';
        detail = '物流单状态不一致，暂不推断整笔采购状态';
      }
    }
    if (unknown) detail += `；${unknown}条状态未识别`;
    if (exceptions) detail += `；${exceptions}条异常或撤销`;
    if (!scope.allOrdersQueried) detail += '；关联订单尚未全部查询';
  }
  return { status, detail, shipment_count: count, signed_count: signed, unknown_count: unknown,
    exception_count: exceptions, coverage_confirmed: coverage, mapping_version: alibabaMappingVersion };
}

// All linked orders must succeed as one snapshot. Failed attempts retain the
// previous result and success timestamp instead of publishing partial evidence.
export function preserveAlibabaSnapshot<T extends { link_version: number; last_success_at: string | null }>(
  previous: T | null, linkVersion: number, attemptedAt: string,
) {
  return previous?.link_version === linkVersion
    ? { ...previous, last_attempt_at: attemptedAt, sync_error: 'query_failed' }
    : { link_version: linkVersion, status: 'unknown', last_success_at: null, last_attempt_at: attemptedAt, sync_error: 'query_failed' };
}

export function stockMonthsForMonthlySales(monthlySales: number, orderDate = new Date()): number {
  const month = orderDate.getMonth() + 1;

  if (month === 7 || month === 9) {
    if (monthlySales > 100) return 7;
    if (monthlySales >= 80) return 6;
    if (monthlySales >= 50) return 5;
    if (monthlySales >= 20) return 4;
    if (monthlySales >= 10) return 3;
    return 2;
  }

  if (month === 8) {
    if (monthlySales > 100) return 8;
    if (monthlySales >= 80) return 7;
    if (monthlySales >= 20) return 6;
    if (monthlySales >= 10) return 4;
    return 3;
  }

  if (month === 10) {
    if (monthlySales > 100) return 6;
    if (monthlySales >= 80) return 5;
    if (monthlySales >= 50) return 4;
    if (monthlySales >= 20) return 3;
    return 2;
  }

  if (month === 11) {
    if (monthlySales > 100) return 5;
    if (monthlySales >= 50) return 4;
    if (monthlySales >= 20) return 3;
    return 2;
  }

  if (monthlySales > 50) return 4;
  if (monthlySales >= 20) return 3;
  return 2;
}

export function stockMonthsRuleDescription(orderDate = new Date()): string {
  const month = orderDate.getMonth() + 1;
  if (month === 7) return '7月订货规则：>100 用7个月，80-100 用6个月，50-80 用5个月，20-50 用4个月，10-20 用3个月，10以下用2个月';
  if (month === 8) return '8月订货规则：>100 用8个月，80-100 用7个月，20-80 用6个月，10-20 用4个月，10以下用3个月';
  if (month === 9) return '9月订货规则：>100 用7个月，80-100 用6个月，50-80 用5个月，20-50 用4个月，10-20 用3个月，10以下用2个月';
  if (month === 10) return '10月订货规则：>100 用6个月，80-100 用5个月，50-80 用4个月，20-50 用3个月，20以下用2个月';
  if (month === 11) return '11月订货规则：>100 用5个月，50-100 用4个月，20-50 用3个月，20以下用2个月';
  return '正常订货规则：月销量 > 50 用4个月，20-50 用3个月，20以下用2个月';
}

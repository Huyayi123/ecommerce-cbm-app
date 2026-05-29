function jsonResponse(body, status = 200) {
  return Response.json(body, { status });
}

function htmlEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function verifyUser(request) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  const authorization = request.headers.get('authorization') || '';
  if (!supabaseUrl || !anonKey || !authorization) return null;

  const response = await fetch(`${supabaseUrl.replace(/\/$/, '')}/auth/v1/user`, {
    headers: {
      apikey: anonKey,
      Authorization: authorization,
    },
  });
  if (!response.ok) return null;
  return response.json().catch(() => null);
}

function groupByBuyer(records) {
  const groups = new Map();
  for (const record of records) {
    const email = String(record.assignedBuyerEmail || '').trim();
    if (!email) continue;
    const name = String(record.assignedBuyerName || record.buyerName || email).trim();
    const key = email.toLowerCase();
    const current = groups.get(key) || { email, name, records: [] };
    current.records.push(record);
    groups.set(key, current);
  }
  return Array.from(groups.values());
}

function buildEmailHtml(group) {
  const rows = group.records.slice(0, 80).map((record) => `
    <tr>
      <td>${htmlEscape(record.manufacturerName || '-')}</td>
      <td>${htmlEscape(record.sku || '-')}</td>
      <td>${htmlEscape(record.productName || record.englishName || '-')}</td>
      <td>${htmlEscape(record.shopName || '-')}</td>
      <td style="text-align:right">${htmlEscape(record.purchaseQuantity ?? 0)}</td>
      <td style="text-align:right">${htmlEscape(record.purchasePrice ?? 0)}</td>
      <td style="text-align:right">${htmlEscape(record.totalAmount ?? 0)}</td>
    </tr>
  `).join('');

  return `
    <div style="font-family:Arial,'Microsoft YaHei',sans-serif;color:#16202a;line-height:1.6">
      <h2 style="margin:0 0 12px">新的采购任务</h2>
      <p>${htmlEscape(group.name)}，你有 ${group.records.length} 条新的采购任务，请登录采购装柜工作台在“我的采购订单”中确认。</p>
      <table style="border-collapse:collapse;width:100%;font-size:14px">
        <thead>
          <tr style="background:#eef5f8">
            <th style="text-align:left;padding:8px;border:1px solid #d7e2ea">厂家名</th>
            <th style="text-align:left;padding:8px;border:1px solid #d7e2ea">SKU</th>
            <th style="text-align:left;padding:8px;border:1px solid #d7e2ea">产品名称</th>
            <th style="text-align:left;padding:8px;border:1px solid #d7e2ea">店铺</th>
            <th style="text-align:right;padding:8px;border:1px solid #d7e2ea">采购数量</th>
            <th style="text-align:right;padding:8px;border:1px solid #d7e2ea">单价</th>
            <th style="text-align:right;padding:8px;border:1px solid #d7e2ea">总金额</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      ${group.records.length > 80 ? `<p>邮件只展示前 80 条，完整任务请进入系统查看。</p>` : ''}
      <p style="margin-top:16px">系统地址：<a href="https://ecommerce-cbm-app.vercel.app/">采购装柜工作台</a></p>
    </div>
  `;
}

async function sendEmail(group) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM || process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) return { ok: false, skipped: true, error: '缺少 RESEND_API_KEY 或 MAIL_FROM' };

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [group.email],
      subject: `新的采购任务：${group.records.length} 条`,
      html: buildEmailHtml(group),
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) return { ok: false, error: payload.message || payload.error || `邮件发送失败：${response.status}` };
  return { ok: true, id: payload.id };
}

async function handleNotify(request) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const user = await verifyUser(request);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  const body = await request.json().catch(() => ({}));
  const records = Array.isArray(body.records) ? body.records : [];
  const groups = groupByBuyer(records);
  const missingEmailCount = records.length - groups.reduce((sum, group) => sum + group.records.length, 0);
  const results = [];

  for (const group of groups) {
    const result = await sendEmail(group);
    results.push({ email: group.email, count: group.records.length, ...result });
  }

  return jsonResponse({
    ok: results.every((item) => item.ok || item.skipped),
    sent: results.filter((item) => item.ok).length,
    skipped: results.filter((item) => item.skipped).length,
    missingEmailCount,
    results,
  });
}

export default {
  fetch: handleNotify,
};

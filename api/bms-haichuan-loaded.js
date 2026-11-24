import { createHash, timingSafeEqual } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest();
const number = value => Number(value ?? 0);
const text = value => typeof value === 'string' ? value : '';
const fail = (status, code) => Object.assign(new Error(code), { status, code });

export function createBmsHaichuanLoadedHandler({ env = process.env, fetcher = fetch } = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
    }
    if (!env.BMS_HAICHUAN_API_KEY) return res.status(503).json({ error: 'API_NOT_CONFIGURED' });
    const authorization = req.headers?.authorization;
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')
      || !timingSafeEqual(digest(authorization.slice(7)), digest(env.BMS_HAICHUAN_API_KEY))) {
      return res.status(401).json({ error: 'UNAUTHORIZED' });
    }
    try {
      const query = req.query ?? {};
      const allowed = ['date_from', 'date_to', 'batch_id', 'page', 'page_size'];
      if (Object.keys(query).some(key => !allowed.includes(key))
        || Object.values(query).some(value => typeof value !== 'string')) throw fail(400, 'INVALID_QUERY');
      for (const key of ['date_from', 'date_to']) {
        const value = query[key];
        if (value !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(value)
          || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw fail(400, 'INVALID_DATE');
      }
      if (query.date_from && query.date_to && query.date_from > query.date_to) throw fail(400, 'INVALID_DATE_RANGE');
      const page = Number(query.page ?? 1), pageSize = Number(query.page_size ?? 20);
      if (!Number.isSafeInteger(page) || page < 1 || page > 1000000
        || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw fail(400, 'INVALID_PAGINATION');
      if (query.batch_id !== undefined && !/^[a-zA-Z0-9_-]{1,200}$/.test(query.batch_id)) throw fail(400, 'INVALID_BATCH_ID');
      const origin = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
      if (!origin || !env.SUPABASE_SERVICE_ROLE_KEY) throw fail(503, 'API_NOT_CONFIGURED');
      const read = async (table, params) => {
        const url = new URL(`/rest/v1/${table}`, origin);
        for (const [key, value] of params) url.searchParams.append(key, String(value));
        const upstream = await fetcher(url.toString(), {
          method: 'GET', redirect: 'error', signal: AbortSignal.timeout(12000),
          headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, Accept: 'application/json' },
        });
        if (!upstream.ok) throw fail(502, 'DATA_SOURCE_UNAVAILABLE');
        const rows = await upstream.json();
        if (!Array.isArray(rows)) throw fail(502, 'INVALID_DATA_SOURCE_RESPONSE');
        return rows;
      };
      const filters = [['select', 'id,container_date,reviewed_at,updated_at'], ['status', 'eq.approved'],
        ['order', 'container_date.desc,id.asc']];
      if (query.date_from) filters.push(['container_date', 'gte.' + query.date_from]);
      if (query.date_to) filters.push(['container_date', 'lte.' + query.date_to]);
      const batches = [];
      for (let offset = 0; ;) {
        const rows = await read('haichuan_loading_batches', [...filters, ['offset', offset], ['limit', 500]]);
        if (!rows.length) break;
        batches.push(...rows);
        offset += rows.length;
      }
      const groups = new Map();
      for (const batch of batches) {
        if (!groups.has(batch.container_date)) groups.set(batch.container_date, []);
        groups.get(batch.container_date).push(batch);
      }
      // A source batch filter identifies its date group, never a partial day's cargo.
      const dates = [...groups.keys()].filter(date => !query.batch_id
        || groups.get(date).some(batch => batch.id === query.batch_id) || date === query.batch_id);
      const selectedDates = dates.slice((page - 1) * pageSize, page * pageSize);
      const data = [];
      for (const date of selectedDates) {
        const sourceBatches = groups.get(date);
        const items = [];
        for (const batch of sourceBatches) {
        // Page each batch separately so large batches are never silently truncated.
        for (let offset = 0; ;) {
          const rows = await read('haichuan_loading_items', [
            ['select', 'id,internal_code,sku,product_name,requested_carton_count,suggested_product_quantity,suggested_cbm,approved_carton_count,approved_product_quantity,approved_cbm,product_details,updated_at,haichuan_loading_batches!inner(status)'],
            ['batch_id', `eq.${batch.id}`], ['haichuan_loading_batches.status', 'eq.approved'],
            ['order', 'id.asc'], ['offset', offset], ['limit', 500],
          ]);
          for (const item of rows) items.push({
            id: item.id, source_batch_id: batch.id, internal_code: text(item.internal_code), sku: text(item.sku), product_name: text(item.product_name),
            carton_count: number(item.approved_carton_count ?? item.requested_carton_count),
            product_quantity: number(item.approved_product_quantity ?? item.suggested_product_quantity),
            cbm: number(item.approved_cbm ?? item.suggested_cbm), updated_at: item.updated_at,
            product_details: (Array.isArray(item.product_details) ? item.product_details : []).map(detail => ({
              id: text(detail.id), internal_code: text(detail.internalCode ?? detail.internal_code), sku: text(detail.sku),
              product_name: text(detail.productName ?? detail.product_name), english_name: text(detail.englishName ?? detail.english_name),
              quantity: number(detail.quantity), unit_cbm: number(detail.unitCbm ?? detail.unit_cbm), total_cbm: number(detail.totalCbm ?? detail.total_cbm),
              is_mixed: Boolean(detail.isMixed ?? detail.is_mixed), mixed_group_id: text(detail.mixedGroupId ?? detail.mixed_group_id),
              mixed_group_name: text(detail.mixedGroupName ?? detail.mixed_group_name), mixed_group_carton_count: number(detail.mixedGroupCartonCount ?? detail.mixed_group_carton_count),
            })),
          });
          if (rows.length === 0) break;
          // Continue to an empty page, even if the database imposes a smaller row cap.
          offset += rows.length;
        }
        }
        const latest = field => sourceBatches.map(batch => batch[field]).filter(Boolean)
          .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
        data.push({ batch_id: date, batch_display_name: date, container_date: date, status: 'approved',
          source_batch_ids: sourceBatches.map(batch => batch.id),
          reviewed_at: latest('reviewed_at'), updated_at: latest('updated_at'), items });
      }
      return res.status(200).json({ api_version: '2', grouping: 'container_date', generated_at: new Date().toISOString(), data,
        pagination: { page, page_size: pageSize, has_more: dates.length > page * pageSize } });
    } catch (error) {
      return res.status(error.status || 502).json({ error: error.code || 'DATA_SOURCE_UNAVAILABLE' });
    }
  };
}

export default createBmsHaichuanLoadedHandler();

const TABLES = [
  'sku_items',
  'purchase_records',
  'container_rows',
  'sales_suggestions',
  'repricing_alerts',
  'repricing_snapshots',
];

function supabaseHeaders(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

function supabaseUrl(path) {
  const base = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  if (!base) throw new Error('Missing SUPABASE_URL or VITE_SUPABASE_URL');
  return `${base.replace(/\/$/, '')}/rest/v1/${path}`;
}

async function countRows(table) {
  const response = await fetch(supabaseUrl(`${table}?select=id&limit=1`), {
    headers: supabaseHeaders({ Prefer: 'count=exact' }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message || payload.error || `Count ${table} failed: ${response.status}`);
  }
  const range = response.headers.get('content-range') || '';
  const total = Number(range.split('/')[1]);
  return Number.isFinite(total) ? total : 0;
}

async function clearSnapshots() {
  const response = await fetch(supabaseUrl('repricing_snapshots?created_at=not.is.null'), {
    method: 'DELETE',
    headers: supabaseHeaders({ Prefer: 'return=minimal' }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message || payload.error || `Clear repricing_snapshots failed: ${response.status}`);
  }
}

export default async function handler(request, response) {
  if (request.method !== 'GET' && request.method !== 'POST') {
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    if (request.method === 'POST') {
      const action = String(request.query.action || '');
      if (action !== 'clear-repricing-snapshots') {
        response.status(400).json({ error: 'Unknown action' });
        return;
      }
      await clearSnapshots();
    }

    const counts = {};
    for (const table of TABLES) {
      counts[table] = await countRows(table);
    }

    response.status(200).json({
      ok: true,
      counts,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: error instanceof Error ? error.message : 'Database usage check failed' });
  }
}

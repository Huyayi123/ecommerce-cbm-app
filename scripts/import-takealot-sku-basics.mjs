import fs from 'node:fs';
import path from 'node:path';

const STORES = ['Bestby', 'Arfast', 'Aicom', 'MegaValue', 'KeepFit', 'Lifon', 'PatPaw'];
const TAKEALOT_ENDPOINT = 'https://ecommerce-cbm-app.vercel.app/api/takealot-inventory';

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvFile(path.resolve('.env'));
loadEnvFile(path.resolve('.env.local'));
loadEnvFile(path.resolve('.env.import'));

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const loginEmail = process.env.SUPABASE_LOGIN_EMAIL;
const loginPassword = process.env.SUPABASE_LOGIN_PASSWORD;

if (!supabaseUrl) {
  throw new Error('缺少 SUPABASE_URL 或 VITE_SUPABASE_URL');
}

if (!serviceRoleKey && (!supabaseAnonKey || !loginEmail || !loginPassword)) {
  throw new Error('缺少 SUPABASE_SERVICE_ROLE_KEY，或缺少 SUPABASE_LOGIN_EMAIL / SUPABASE_LOGIN_PASSWORD / VITE_SUPABASE_ANON_KEY。');
}

function supabaseRestUrl(pathname) {
  return `${supabaseUrl.replace(/\/$/, '')}/rest/v1/${pathname}`;
}

async function loginAccessToken() {
  if (serviceRoleKey) return serviceRoleKey;
  console.log('Logging in to Supabase...');
  const payload = await fetchJson(`${supabaseUrl.replace(/\/$/, '')}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: supabaseAnonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email: loginEmail, password: loginPassword }),
  });
  if (!payload.access_token) throw new Error('Supabase 登录失败：没有返回 access_token');
  console.log('Supabase login ok.');
  return payload.access_token;
}

const authToken = await loginAccessToken();

function supabaseHeaders(extra = {}) {
  const apiKey = serviceRoleKey || supabaseAnonKey;
  return {
    apikey: apiKey,
    Authorization: `Bearer ${authToken}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

function normalizeSku(value) {
  return String(value ?? '').trim().toUpperCase();
}

function normalizeImageUrl(value) {
  const text = String(value ?? '').trim();
  if (!/^https?:\/\//i.test(text)) return '';
  return text.replace(/^http:\/\/takealot\.s3\.amazonaws\.com\//i, 'https://takealot.s3.amazonaws.com/');
}

function findImageUrl(value, seen = new Set()) {
  if (!value || typeof value !== 'object') return '';
  if (seen.has(value)) return '';
  seen.add(value);

  const record = value;
  for (const key of ['image_url', 'imageUrl', 'image', 'thumbnail', 'thumbnail_url', 'product_image', 'lead_image', 'main_image']) {
    const found = normalizeImageUrl(record[key]);
    if (found) return found;
  }

  for (const nested of Object.values(record)) {
    if (typeof nested === 'string') {
      const found = normalizeImageUrl(nested);
      if (found) return found;
    }
    if (Array.isArray(nested)) {
      for (const item of nested) {
        const found = findImageUrl(item, seen);
        if (found) return found;
      }
    } else if (nested && typeof nested === 'object') {
      const found = findImageUrl(nested, seen);
      if (found) return found;
    }
  }
  return '';
}

function rowTitle(row) {
  return String(row?.title ?? row?.product_title ?? row?.name ?? '').trim();
}

function isDisabled(row) {
  return String(row?.status ?? '').trim().toLowerCase().startsWith('disabled');
}

async function fetchJson(url, options = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, options);
      const text = await response.text();
      const payload = text ? JSON.parse(text) : null;
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}: ${JSON.stringify(payload)}`);
      }
      return payload;
    } catch (error) {
      lastError = error;
      console.warn(`fetch failed (${attempt}/4): ${url}`);
      console.warn(error instanceof Error ? error.message : String(error));
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 2500));
    }
  }
  throw lastError;
}

async function fetchAllSkuItems() {
  console.log('Loading existing SKU items from Supabase...');
  const items = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const url = supabaseRestUrl(`sku_items?select=*&order=sku.asc`);
    const page = await fetchJson(url, {
      headers: supabaseHeaders({ Range: `${from}-${to}` }),
    });
    items.push(...page);
    if (page.length < pageSize) break;
  }
  console.log(`Existing SKU items: ${items.length}`);
  return items;
}

async function fetchTakealotRows(store) {
  const cacheDir = process.env.TAKEALOT_CACHE_DIR;
  if (cacheDir) {
    const cachePath = path.join(cacheDir, `${store}.json`);
    if (fs.existsSync(cachePath)) {
      const payload = JSON.parse(fs.readFileSync(cachePath, 'utf8').replace(/^\uFEFF/, ''));
      return Array.isArray(payload?.rows) ? payload.rows : [];
    }
  }

  const url = new URL(TAKEALOT_ENDPOINT);
  url.searchParams.set('store', store);
  const payload = await fetchJson(url);
  return Array.isArray(payload?.rows) ? payload.rows : [];
}

function createSkuRow({ sku, englishName, shopName, imageUrl }) {
  const now = new Date().toISOString();
  return {
    id: `takealot-${sku}`,
    sku,
    product_name: '',
    english_name: englishName,
    image_url: imageUrl,
    manufacturer_name: '',
    shop_name: shopName,
    buyer_name: '',
    is_seasonal: false,
    purchase_price: 0,
    unit_cbm: 0,
    box_length_cm: 0,
    box_width_cm: 0,
    box_height_cm: 0,
    units_per_carton: 0,
    total_quantity: 0,
    total_cbm: 0,
    notes: '',
    created_at: now,
    updated_at: now,
  };
}

async function upsertSkuRows(rows) {
  const batchSize = 500;
  for (let index = 0; index < rows.length; index += batchSize) {
    const batch = rows.slice(index, index + batchSize);
    await fetchJson(supabaseRestUrl('sku_items?on_conflict=id'), {
      method: 'POST',
      headers: supabaseHeaders({ Prefer: 'resolution=merge-duplicates' }),
      body: JSON.stringify(batch),
    });
  }
}

const existingRows = await fetchAllSkuItems();
const rowsBySku = new Map();
for (const row of existingRows) {
  const sku = normalizeSku(row.sku);
  if (!sku) continue;
  if (!rowsBySku.has(sku)) rowsBySku.set(sku, []);
  rowsBySku.get(sku).push(row);
}

const pendingById = new Map();
const stats = {
  fetched: 0,
  skippedDisabled: 0,
  skippedNoSku: 0,
  updated: 0,
  inserted: 0,
  noImage: 0,
};

for (const store of STORES) {
  const rows = await fetchTakealotRows(store);
  console.log(`${store}: fetched ${rows.length}`);
  stats.fetched += rows.length;

  for (const row of rows) {
    if (isDisabled(row)) {
      stats.skippedDisabled += 1;
      continue;
    }

    const sku = normalizeSku(row.sku ?? row.seller_sku ?? row.merchant_sku ?? row.offer_sku);
    if (!sku) {
      stats.skippedNoSku += 1;
      continue;
    }

    const englishName = rowTitle(row);
    const imageUrl = findImageUrl(row);
    if (!imageUrl) stats.noImage += 1;

    const existingForSku = rowsBySku.get(sku);
    if (existingForSku?.length) {
      for (const existing of existingForSku) {
        pendingById.set(existing.id, {
          ...existing,
          sku,
          english_name: englishName || existing.english_name || '',
          shop_name: store,
          image_url: imageUrl || existing.image_url || '',
          updated_at: new Date().toISOString(),
        });
      }
      stats.updated += existingForSku.length;
    } else {
      const created = createSkuRow({ sku, englishName, shopName: store, imageUrl });
      pendingById.set(created.id, created);
      rowsBySku.set(sku, [created]);
      stats.inserted += 1;
    }
  }
}

const rowsToUpsert = Array.from(pendingById.values());
if (rowsToUpsert.length > 0) {
  await upsertSkuRows(rowsToUpsert);
}

console.log(JSON.stringify({
  ...stats,
  upsertedRows: rowsToUpsert.length,
}, null, 2));

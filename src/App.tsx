import { useEffect, useState } from 'react';
import { AuthPanel } from './components/AuthPanel';
import { LocalStorageMigration } from './components/LocalStorageMigration';
import { ProfileBinding } from './components/ProfileBinding';
import { SkuManager } from './components/SkuManager';
import { sampleSkus } from './data/sampleSkus';
import { isSupabaseConfigured, supabase } from './lib/supabase';
import { ContainerCalculatorPage } from './pages/ContainerCalculatorPage';
import { MyPurchaseOrdersPage } from './pages/MyPurchaseOrdersPage';
import { PurchaseInventoryPage } from './pages/PurchaseInventoryPage';
import { SalesSuggestionPage } from './pages/SalesSuggestionPage';
import type { AppProfile, AuditAction, AuditLog, PurchaseRecord, PurchaseRow, SkuItem } from './types';
import {
  createAuditLog,
  fetchAuditLogs,
  fetchContainerRows,
  fetchProfile,
  fetchProfiles,
  fetchPurchaseRecords,
  fetchSkuItems,
  replaceContainerRows,
  replacePurchaseRecords,
  replaceSalesSuggestions,
  replaceSkuItems,
  subscribeToSharedTables,
  updateProfileBinding,
} from './utils/cloudStorage';
import { formatErrorMessage } from './utils/errors';
import { canDelete, canEdit } from './utils/permissions';

type PageKey = 'sku' | 'calculator' | 'inventory' | 'my-orders' | 'suggestions';

const navItems: Array<{ key: PageKey; label: string }> = [
  { key: 'sku', label: 'SKU 资料库' },
  { key: 'calculator', label: '装柜计算' },
  { key: 'inventory', label: '采购 / 在途库存' },
  { key: 'my-orders', label: '我的采购订单' },
  { key: 'suggestions', label: '月销量采购建议' },
];

function App() {
  const [activePage, setActivePage] = useState<PageKey>('calculator');
  const [profile, setProfile] = useState<AppProfile | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [skuItems, setSkuItems] = useState<SkuItem[]>([]);
  const [purchaseRows, setPurchaseRows] = useState<PurchaseRow[]>([]);
  const [purchaseRecords, setPurchaseRecords] = useState<PurchaseRecord[]>([]);
  const [profiles, setProfiles] = useState<AppProfile[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [fileName, setFileName] = useState('');
  const [statusMessage, setStatusMessage] = useState('');

  async function loadCloudData() {
    if (!supabase) return;
    const [nextSkuItems, nextPurchaseRows, nextPurchaseRecords, nextAuditLogs, nextProfiles] = await Promise.all([
      fetchSkuItems(),
      fetchContainerRows(),
      fetchPurchaseRecords(),
      fetchAuditLogs(),
      fetchProfiles(),
    ]);
    setSkuItems(nextSkuItems);
    setPurchaseRows(nextPurchaseRows);
    setPurchaseRecords(nextPurchaseRecords);
    setAuditLogs(nextAuditLogs);
    setProfiles(nextProfiles);
  }

  async function loadSession() {
    if (!supabase) {
      setAuthReady(true);
      return;
    }

    const { data } = await supabase.auth.getSession();
    const user = data.session?.user;
    if (user) {
      setProfile(await fetchProfile(user.id, user.email ?? ''));
      await loadCloudData();
    } else {
      setProfile(null);
    }
    setAuthReady(true);
  }

  useEffect(() => {
    void loadSession();
    if (!supabase) return undefined;

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      const user = session?.user;
      if (!user) {
        setProfile(null);
        setSkuItems([]);
        setPurchaseRows([]);
        setPurchaseRecords([]);
        setAuditLogs([]);
        setProfiles([]);
        return;
      }
      void fetchProfile(user.id, user.email ?? '').then(setProfile);
      void loadCloudData();
    });

    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!profile) return undefined;
    return subscribeToSharedTables(() => {
      void loadCloudData();
    });
  }, [profile]);

  async function persistSkuItems(nextItems: SkuItem[]) {
    await replaceSkuItems(nextItems);
    setSkuItems(nextItems);
    void logSkuChanges(skuItems, nextItems).catch((error) => {
      console.error(error);
      setStatusMessage(`SKU 已保存，但操作记录写入失败：${formatErrorMessage(error)}`);
    });
  }

  async function persistPurchaseRows(nextRows: PurchaseRow[]) {
    setPurchaseRows(nextRows);
    await replaceContainerRows(nextRows);
  }

  async function persistPurchaseRecords(nextRecords: PurchaseRecord[]) {
    const normalized = normalizePurchaseRecords(nextRecords);
    if (normalized.conflicts.length > 0) {
      setStatusMessage(`发现 ${normalized.conflicts.length} 个重复 SKU 价格不同，请人工确认：${normalized.conflicts.join('、')}`);
    }
    await logPurchaseChanges(purchaseRecords, normalized.records);
    setPurchaseRecords(normalized.records);
    await replacePurchaseRecords(normalized.records);
  }

  async function loadSamples() {
    const existing = new Set(skuItems.map((item) => item.sku.toUpperCase()));
    await persistSkuItems([...sampleSkus.filter((item) => !existing.has(item.sku.toUpperCase())), ...skuItems]);
  }

  async function appendPurchaseRecords(records: PurchaseRecord[]) {
    await persistPurchaseRecords([...assignBuyerEmails(records), ...purchaseRecords]);
    setActivePage('inventory');
  }

  function buyerEmailForName(name: string): string {
    const normalized = name.trim().toLowerCase();
    if (!normalized) return '';
    return profiles.find((item) => item.buyerName.trim().toLowerCase() === normalized)?.email ?? '';
  }

  function assignBuyerEmails(records: PurchaseRecord[]): PurchaseRecord[] {
    return records.map((record) => ({
      ...record,
      assignedBuyerName: record.assignedBuyerName || record.buyerName,
      assignedBuyerEmail: record.assignedBuyerEmail || buyerEmailForName(record.assignedBuyerName || record.buyerName),
    }));
  }

  async function writeAudit(action: AuditAction, entityType: AuditLog['entityType'], entityId: string, summary: string, metadata: Record<string, unknown> = {}) {
    if (!profile || !editable) return;
    await createAuditLog({
      actorId: profile.id,
      actorEmail: profile.email,
      actorRole: profile.role,
      action,
      entityType,
      entityId,
      summary,
      metadata,
    });
  }

  async function logSkuChanges(before: SkuItem[], after: SkuItem[]) {
    const beforeMap = new Map(before.map((item) => [item.id, item]));
    const afterMap = new Map(after.map((item) => [item.id, item]));

    for (const item of after) {
      const previous = beforeMap.get(item.id);
      if (!previous) {
        await writeAudit('sku_created', 'sku', item.id, `新增 SKU ${item.sku}`, { sku: item.sku });
      } else if (JSON.stringify(previous) !== JSON.stringify(item)) {
        await writeAudit('sku_updated', 'sku', item.id, `修改 SKU ${item.sku}`, { before: previous, after: item });
      }
    }

    for (const item of before) {
      if (!afterMap.has(item.id)) {
        await writeAudit('sku_deleted', 'sku', item.id, `删除 SKU ${item.sku}`, { sku: item.sku });
      }
    }
  }

  async function logPurchaseChanges(before: PurchaseRecord[], after: PurchaseRecord[]) {
    const beforeMap = new Map(before.map((record) => [record.id, record]));
    const afterMap = new Map(after.map((record) => [record.id, record]));
    let arrivedCount = 0;

    for (const record of after) {
      const previous = beforeMap.get(record.id);
      if (!previous) {
        await writeAudit('purchase_created', 'purchase_record', record.id, `新增采购记录 ${record.sku}`, { sku: record.sku, quantity: record.purchaseQuantity });
        continue;
      }

      if (previous.purchasePrice !== record.purchasePrice) {
        await writeAudit('purchase_price_changed', 'purchase_record', record.id, `修改 ${record.sku} 采购单价：${previous.purchasePrice} -> ${record.purchasePrice}`, {
          sku: record.sku,
          beforePrice: previous.purchasePrice,
          afterPrice: record.purchasePrice,
        });
      }

      if (previous.status !== 'arrived' && record.status === 'arrived') {
        arrivedCount += 1;
        await writeAudit('purchase_marked_arrived', 'purchase_record', record.id, `标记到货 ${record.sku}`, { sku: record.sku });
      } else if (JSON.stringify(previous) !== JSON.stringify(record)) {
        await writeAudit('purchase_updated', 'purchase_record', record.id, `修改采购记录 ${record.sku}`, { before: previous, after: record });
      }
    }

    if (arrivedCount > 1) {
      await writeAudit('purchase_bulk_marked_arrived', 'purchase_record', 'bulk', `批量标记 ${arrivedCount} 条采购记录为已到货`, { count: arrivedCount });
    }

    for (const record of before) {
      if (!afterMap.has(record.id)) {
        await writeAudit('purchase_deleted', 'purchase_record', record.id, `删除采购记录 ${record.sku}`, { sku: record.sku });
      }
    }
  }

  function normalizePurchaseRecords(records: PurchaseRecord[]): { records: PurchaseRecord[]; conflicts: string[] } {
    const result: PurchaseRecord[] = [];
    const mergeMap = new Map<string, PurchaseRecord>();
    const pricesBySku = new Map<string, Set<number>>();

    for (const record of records) {
      if (record.status !== 'in_transit') {
        result.push(record);
        continue;
      }

      const skuKey = record.sku.trim().toUpperCase();
      if (!skuKey) {
        result.push(record);
        continue;
      }

      if (!pricesBySku.has(skuKey)) pricesBySku.set(skuKey, new Set());
      pricesBySku.get(skuKey)!.add(record.purchasePrice);

      const mergeKey = `${skuKey}|${record.purchasePrice}`;
      const existing = mergeMap.get(mergeKey);
      if (!existing) {
        mergeMap.set(mergeKey, { ...record });
        continue;
      }

      existing.purchaseQuantity += record.purchaseQuantity;
      existing.totalAmount += record.totalAmount;
      existing.totalCbm += record.totalCbm;
      existing.note = [existing.note, record.note].filter(Boolean).join('；');
    }

    const conflicts = Array.from(pricesBySku.entries())
      .filter(([, prices]) => prices.size > 1)
      .map(([sku]) => sku);

    return { records: [...Array.from(mergeMap.values()), ...result], conflicts };
  }

  async function sendSuggestionsToCalculator(rows: PurchaseRow[], nextFileName: string) {
    await persistPurchaseRows(rows);
    setFileName(nextFileName);
    setActivePage('calculator');
  }

  async function importLocalStorageData(payload: {
    skuItems: SkuItem[];
    purchaseRecords: PurchaseRecord[];
    purchaseRows: PurchaseRow[];
  }) {
    await Promise.all([
      replaceSkuItems([...payload.skuItems, ...skuItems]),
      replacePurchaseRecords([...payload.purchaseRecords, ...purchaseRecords]),
      replaceContainerRows(payload.purchaseRows.length > 0 ? payload.purchaseRows : purchaseRows),
    ]);
    await loadCloudData();
  }

  async function signOut() {
    await supabase?.auth.signOut();
  }

  async function saveProfileBinding(nextProfile: AppProfile) {
    await updateProfileBinding(nextProfile);
    setProfile(nextProfile);
    setProfiles((current) => current.map((item) => (item.id === nextProfile.id ? nextProfile : item)));
    await loadCloudData();
  }

  if (!authReady) {
    return <main className="app-shell"><section className="panel">正在连接云端...</section></main>;
  }

  if (!isSupabaseConfigured || !profile) {
    return <AuthPanel onAuthed={loadSession} />;
  }

  const editable = canEdit(profile.role);
  const deletable = canDelete(profile.role);

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <h1>电商采购装柜工作台</h1>
          <p>维护 SKU 体积资料、计算装柜 CBM、管理海运在途采购，并按月销量生成采购建议。</p>
        </div>
        <div className="user-panel">
          <span>{profile.displayName}</span>
          <strong>{profile.role}</strong>
          <button type="button" onClick={signOut}>退出</button>
        </div>
      </header>

      <nav className="top-nav" aria-label="主导航">
        {navItems.map((item) => (
          <button
            key={item.key}
            type="button"
            className={activePage === item.key ? 'active' : ''}
            onClick={() => setActivePage(item.key)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <LocalStorageMigration role={profile.role} onImport={importLocalStorageData} />

      <ProfileBinding profile={profile} onSave={saveProfileBinding} />

      {statusMessage && <div className="inline-notice">{statusMessage}</div>}

      {activePage === 'sku' && (
        <>
          {editable && <button type="button" onClick={() => void loadSamples()}>载入示例 SKU</button>}
          <SkuManager items={skuItems} onChange={persistSkuItems} canEditData={editable} canDeleteData={deletable} />
        </>
      )}

      {activePage === 'calculator' && (
        <ContainerCalculatorPage
          skuItems={skuItems}
          purchaseRows={purchaseRows}
          fileName={fileName}
          onRowsChange={(rows) => void persistPurchaseRows(rows)}
          onFileNameChange={setFileName}
          onRecordsCreate={(records) => {
            void appendPurchaseRecords(records).then(() => setStatusMessage(`已保存 ${records.length} 条采购记录`));
          }}
          canEditData={true}
        />
      )}

      {activePage === 'inventory' && (
        <PurchaseInventoryPage
          records={purchaseRecords}
          skuItems={skuItems}
          auditLogs={auditLogs}
          onChange={(records) => void persistPurchaseRecords(records)}
          canEditData={editable}
          canDeleteData={deletable}
        />
      )}

      {activePage === 'my-orders' && (
        <MyPurchaseOrdersPage
          records={purchaseRecords}
          profile={profile}
          onChange={persistPurchaseRecords}
        />
      )}

      {activePage === 'suggestions' && (
        <SalesSuggestionPage
          skuItems={skuItems}
          purchaseRecords={purchaseRecords}
          onSendToCalculator={(rows, name) => void sendSuggestionsToCalculator(rows, name)}
          canEditData={editable}
          onSuggestionsSave={(rows) => void replaceSalesSuggestions(rows)}
        />
      )}
    </main>
  );
}

export default App;

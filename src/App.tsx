import { useEffect, useState } from 'react';
import { AuthPanel } from './components/AuthPanel';
import { PasswordResetPanel } from './components/PasswordResetPanel';
import { ProfileBinding } from './components/ProfileBinding';
import { SkuManager } from './components/SkuManager';
import { isSupabaseConfigured, supabase } from './lib/supabase';
import { ContainerCalculatorPage } from './pages/ContainerCalculatorPage';
import { MyPurchaseOrdersPage } from './pages/MyPurchaseOrdersPage';
import { PurchaseInventoryPage } from './pages/PurchaseInventoryPage';
import { RepricingAlertsPage } from './pages/RepricingAlertsPage';
import { SalesSuggestionPage } from './pages/SalesSuggestionPage';
import type { AppProfile, AuditAction, AuditLog, PurchaseRecord, PurchaseRow, RepricingAlert, SalesSuggestionRow, SkuItem } from './types';
import {
  createAuditLog,
  fetchAuditLogs,
  fetchContainerRows,
  fetchProfile,
  fetchProfiles,
  fetchPurchaseRecords,
  fetchRepricingAlerts,
  fetchSalesSuggestions,
  fetchSkuItems,
  replaceContainerRows,
  replacePurchaseRecords,
  replaceSkuItems,
  subscribeToSharedTables,
  updateProfileBinding,
} from './utils/cloudStorage';
import { formatErrorMessage } from './utils/errors';
import { canDelete, canEdit } from './utils/permissions';
import { withPurchaseTotals } from './utils/purchaseRecords';

type PageKey = 'sku' | 'calculator' | 'inventory' | 'my-orders' | 'suggestions' | 'repricing';

const navItems: Array<{ key: PageKey; label: string }> = [
  { key: 'suggestions', label: '月销量采购建议' },
  { key: 'calculator', label: '装柜计算' },
  { key: 'my-orders', label: '我的采购订单' },
  { key: 'inventory', label: '采购 / 在途库存' },
  { key: 'sku', label: 'SKU 资料库' },
];

navItems.unshift({ key: 'repricing', label: '价格预警' });

function isOptionalProfileLoadError(index: number, error: unknown): boolean {
  return (index === 4 || index === 5 || index === 6) && /failed to fetch|fetch/i.test(formatErrorMessage(error));
}

function App() {
  const [activePage, setActivePage] = useState<PageKey>('suggestions');
  const [profile, setProfile] = useState<AppProfile | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  const [skuItems, setSkuItems] = useState<SkuItem[]>([]);
  const [purchaseRows, setPurchaseRows] = useState<PurchaseRow[]>([]);
  const [purchaseRecords, setPurchaseRecords] = useState<PurchaseRecord[]>([]);
  const [savedSalesSuggestions, setSavedSalesSuggestions] = useState<SalesSuggestionRow[]>([]);
  const [repricingAlerts, setRepricingAlerts] = useState<RepricingAlert[]>([]);
  const [profiles, setProfiles] = useState<AppProfile[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [fileName, setFileName] = useState('');
  const [statusMessage, setStatusMessage] = useState('');

  function hasPasswordRecoveryToken(): boolean {
    const urlText = `${window.location.search}${window.location.hash}`.toLowerCase();
    return urlText.includes('type=recovery') || sessionStorage.getItem('passwordRecovery') === 'true';
  }

  async function loadCloudData() {
    if (!supabase) return;
    const results = await Promise.allSettled([
      fetchSkuItems(),
      fetchContainerRows(),
      fetchPurchaseRecords(),
      fetchAuditLogs(),
      fetchProfiles(),
      fetchSalesSuggestions(),
      fetchRepricingAlerts(),
    ]);
    const errors = results.flatMap((result, index) => {
      if (result.status !== 'rejected') return [];
      console.error('云端数据加载失败', { index, error: result.reason });
      if (isOptionalProfileLoadError(index, result.reason)) return [];
      return [formatErrorMessage(result.reason)];
    });

    if (results[0].status === 'fulfilled') setSkuItems(results[0].value);
    if (results[1].status === 'fulfilled') setPurchaseRows(results[1].value);
    if (results[2].status === 'fulfilled') setPurchaseRecords(results[2].value);
    if (results[3].status === 'fulfilled') setAuditLogs(results[3].value);
    if (results[4].status === 'fulfilled') {
      setProfiles(results[4].value);
    } else if (profile) {
      setProfiles((current) => (current.some((item) => item.id === profile.id) ? current : [...current, profile]));
    }
    if (results[5].status === 'fulfilled') setSavedSalesSuggestions(results[5].value);
    if (results[6].status === 'fulfilled') setRepricingAlerts(results[6].value);

    if (errors.length > 0) {
      setStatusMessage(`部分云端数据加载失败：${errors.join('；')}`);
    }
  }

  async function loadSession() {
    try {
      if (!supabase) {
        setAuthReady(true);
        return;
      }

      const { data } = await supabase.auth.getSession();
      const user = data.session?.user;
      if (user) {
        try {
          setProfile(await fetchProfile(user.id, user.email ?? ''));
        } catch (error) {
          console.error(error);
          setProfile({ id: user.id, email: user.email ?? '', role: 'viewer', displayName: user.email ?? '', buyerName: '' });
          setStatusMessage(`账号资料加载失败：${formatErrorMessage(error)}`);
        }
        await loadCloudData();
      } else {
        setProfile(null);
      }
    } catch (error) {
      console.error(error);
      setStatusMessage(`登录会话加载失败：${formatErrorMessage(error)}`);
    } finally {
      setAuthReady(true);
    }
  }

  useEffect(() => {
    if (hasPasswordRecoveryToken()) {
      sessionStorage.setItem('passwordRecovery', 'true');
      setPasswordRecovery(true);
    }
    void loadSession();
    if (!supabase) return undefined;

    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') {
        sessionStorage.setItem('passwordRecovery', 'true');
        setPasswordRecovery(true);
      }
      const user = session?.user;
      if (!user) {
        setProfile(null);
        setSkuItems([]);
        setPurchaseRows([]);
        setPurchaseRecords([]);
        setAuditLogs([]);
        setProfiles([]);
        setRepricingAlerts([]);
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
    const normalized = normalizePurchaseRecords(assignBuyerEmails(nextRecords));
    if (normalized.conflicts.length > 0) {
      setStatusMessage(`发现 ${normalized.conflicts.length} 个重复 SKU 价格不同，请人工确认：${normalized.conflicts.join('、')}`);
    }
    await replacePurchaseRecords(normalized.records);
    setPurchaseRecords(normalized.records);
    void logPurchaseChanges(purchaseRecords, normalized.records).catch((error) => {
      console.error(error);
      setStatusMessage(`采购记录已保存，但操作记录写入失败：${formatErrorMessage(error)}`);
    });
  }

  async function appendPurchaseRecords(records: PurchaseRecord[]) {
    try {
      const assignedRecords = assignBuyerEmails(records);
      const nextRecords = [...assignedRecords, ...purchaseRecords];
      await persistPurchaseRecords(nextRecords);
      await loadCloudData();
      setStatusMessage(`已生成 ${assignedRecords.length} 条采购任务，请采购人在“我的采购订单”确认后进入在途库存口径。`);
      setActivePage('my-orders');
    } catch (error) {
      console.error(error);
      setStatusMessage(`采购记录保存失败：${formatErrorMessage(error)}`);
    }
  }

  function normalizeBuyerName(name: string): string {
    return name.trim().replace(/\s+/g, '').toLowerCase();
  }

  function buyerEmailForName(name: string, sourceProfiles = profiles): string {
    const normalized = name.trim().toLowerCase();
    if (!normalized) return '';
    const compact = normalizeBuyerName(name);
    const matchedProfile = sourceProfiles.find((item) => normalizeBuyerName(item.buyerName) === compact);
    if (matchedProfile) return matchedProfile.email;
    if (profile && normalizeBuyerName(profile.buyerName) === compact) return profile.email;
    return '';
  }

  function assignBuyerEmails(records: PurchaseRecord[], sourceProfiles = profiles): PurchaseRecord[] {
    return records.map((record) => ({
      ...record,
      assignedBuyerName: record.assignedBuyerName || record.buyerName,
      assignedBuyerEmail: record.assignedBuyerEmail || buyerEmailForName(record.assignedBuyerName || record.buyerName, sourceProfiles),
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
    const created: SkuItem[] = [];
    const deleted: SkuItem[] = [];
    const updated: Array<{ before: SkuItem; after: SkuItem; changes: string[] }> = [];

    for (const item of after) {
      const previous = beforeMap.get(item.id);
      if (!previous) {
        created.push(item);
        continue;
      }

      const changes: string[] = [];
      if (previous.purchasePrice !== item.purchasePrice) changes.push('采购单价');
      if (previous.unitCbm !== item.unitCbm || previous.manualUnitCbm !== item.manualUnitCbm) changes.push('单品CBM');
      if (previous.manufacturerName !== item.manufacturerName) changes.push('厂家名');
      if (previous.buyerName !== item.buyerName) changes.push('采购人');
      if (changes.length > 0) {
        updated.push({ before: previous, after: item, changes });
      }
    }

    for (const item of before) {
      if (!afterMap.has(item.id)) {
        deleted.push(item);
      }
    }

    if (created.length === 0 && updated.length === 0 && deleted.length === 0) return;

    const parts = [
      created.length > 0 ? `新增 ${created.length} 条` : '',
      updated.length > 0 ? `关键更新 ${updated.length} 条` : '',
      deleted.length > 0 ? `删除 ${deleted.length} 条` : '',
    ].filter(Boolean);

    await writeAudit(
      'sku_bulk_changed',
      'sku',
      'bulk',
      `SKU 资料库变更：${parts.join('，')}`,
      {
        created: created.map((item) => ({ id: item.id, sku: item.sku, productName: item.productName, manufacturerName: item.manufacturerName })),
        updated: updated.map((item) => ({
          id: item.after.id,
          sku: item.after.sku,
          changes: item.changes,
          before: item.before,
          after: item.after,
        })),
        deleted: deleted.map((item) => ({ id: item.id, sku: item.sku, productName: item.productName, manufacturerName: item.manufacturerName })),
      },
    );
  }

  async function logPurchaseChanges(before: PurchaseRecord[], after: PurchaseRecord[]) {
    const beforeMap = new Map(before.map((record) => [record.id, record]));
    const afterMap = new Map(after.map((record) => [record.id, record]));
    const created: PurchaseRecord[] = [];
    const deleted: PurchaseRecord[] = [];
    const priceChanged: Array<{ before: PurchaseRecord; after: PurchaseRecord }> = [];
    const quantityChanged: Array<{ before: PurchaseRecord; after: PurchaseRecord }> = [];
    const statusChanged: Array<{ before: PurchaseRecord; after: PurchaseRecord }> = [];

    for (const record of after) {
      const previous = beforeMap.get(record.id);
      if (!previous) {
        created.push(record);
        continue;
      }

      if (previous.purchasePrice !== record.purchasePrice) {
        priceChanged.push({ before: previous, after: record });
      }
      if (previous.purchaseQuantity !== record.purchaseQuantity) {
        quantityChanged.push({ before: previous, after: record });
      }
      if (previous.status !== record.status) {
        statusChanged.push({ before: previous, after: record });
      }
    }

    for (const record of before) {
      if (!afterMap.has(record.id)) {
        deleted.push(record);
      }
    }

    const arrivedCount = statusChanged.filter((item) => item.after.status === 'arrived').length;
    const cancelledCount = statusChanged.filter((item) => item.after.status === 'cancelled').length;
    const inTransitCount = statusChanged.filter((item) => item.after.status === 'in_transit').length;

    if (created.length > 0) {
      await writeAudit(
        created.length === 1 ? 'purchase_created' : 'purchase_bulk_created',
        'purchase_record',
        created.length === 1 ? created[0].id : 'bulk',
        created.length === 1 ? `新增采购记录 ${created[0].sku || created[0].productName}` : `批量新增采购记录 ${created.length} 条`,
        { records: created.map((record) => ({ id: record.id, sku: record.sku, productName: record.productName, quantity: record.purchaseQuantity, amount: record.totalAmount })) },
      );
    }

    if (priceChanged.length > 0) {
      await writeAudit(
        priceChanged.length === 1 ? 'purchase_price_changed' : 'purchase_updated',
        'purchase_record',
        priceChanged.length === 1 ? priceChanged[0].after.id : 'bulk',
        priceChanged.length === 1
          ? `修改 ${priceChanged[0].after.sku || priceChanged[0].after.productName} 采购单价：${priceChanged[0].before.purchasePrice} -> ${priceChanged[0].after.purchasePrice}`
          : `批量修改采购单价 ${priceChanged.length} 条`,
        { changes: priceChanged.map((item) => ({ id: item.after.id, sku: item.after.sku, beforePrice: item.before.purchasePrice, afterPrice: item.after.purchasePrice })) },
      );
    }

    if (quantityChanged.length > 0) {
      await writeAudit(
        'purchase_updated',
        'purchase_record',
        quantityChanged.length === 1 ? quantityChanged[0].after.id : 'bulk',
        quantityChanged.length === 1
          ? `修改 ${quantityChanged[0].after.sku || quantityChanged[0].after.productName} 采购数量：${quantityChanged[0].before.purchaseQuantity} -> ${quantityChanged[0].after.purchaseQuantity}`
          : `批量修改采购数量 ${quantityChanged.length} 条`,
        { changes: quantityChanged.map((item) => ({ id: item.after.id, sku: item.after.sku, beforeQuantity: item.before.purchaseQuantity, afterQuantity: item.after.purchaseQuantity })) },
      );
    }

    if (statusChanged.length > 0) {
      const statusParts = [
        arrivedCount > 0 ? `到货 ${arrivedCount} 条` : '',
        inTransitCount > 0 ? `海运在途 ${inTransitCount} 条` : '',
        cancelledCount > 0 ? `取消 ${cancelledCount} 条` : '',
      ].filter(Boolean);
      await writeAudit(
        arrivedCount > 0 && statusChanged.length === arrivedCount ? 'purchase_bulk_marked_arrived' : 'purchase_updated',
        'purchase_record',
        statusChanged.length === 1 ? statusChanged[0].after.id : 'bulk',
        `采购记录状态变更：${statusParts.join('，') || `${statusChanged.length} 条`}`,
        { changes: statusChanged.map((item) => ({ id: item.after.id, sku: item.after.sku, beforeStatus: item.before.status, afterStatus: item.after.status })) },
      );
    }

    if (deleted.length > 0) {
      await writeAudit(
        'purchase_deleted',
        'purchase_record',
        deleted.length === 1 ? deleted[0].id : 'bulk',
        deleted.length === 1 ? `删除采购记录 ${deleted[0].sku || deleted[0].productName}` : `批量删除采购记录 ${deleted.length} 条`,
        { records: deleted.map((record) => ({ id: record.id, sku: record.sku, productName: record.productName })) },
      );
    }
  }

  function normalizePurchaseRecords(records: PurchaseRecord[]): { records: PurchaseRecord[]; conflicts: string[] } {
    const pricesBySku = new Map<string, Set<number>>();

    for (const record of records) {
      const skuKey = record.sku.trim().toUpperCase();
      if (!skuKey) continue;

      if (!pricesBySku.has(skuKey)) pricesBySku.set(skuKey, new Set());
      pricesBySku.get(skuKey)!.add(record.purchasePrice);
    }

    const conflicts = Array.from(pricesBySku.entries())
      .filter(([, prices]) => prices.size > 1)
      .map(([sku]) => sku);

    return { records: records.map((record) => withPurchaseTotals(record)), conflicts };
  }

  async function sendSuggestionsToCalculator(rows: PurchaseRow[], nextFileName: string) {
    await persistPurchaseRows(rows);
    setFileName(nextFileName);
    setActivePage('calculator');
  }

  async function signOut() {
    await supabase?.auth.signOut();
  }

  async function saveProfileBinding(nextProfile: AppProfile) {
    const previousProfile = profile;
    const savedProfile = await updateProfileBinding(nextProfile);
    setProfile(savedProfile);
    const nextProfiles = profiles.some((item) => item.id === savedProfile.id)
      ? profiles.map((item) => (item.id === savedProfile.id ? savedProfile : item))
      : [...profiles, savedProfile];
    setProfiles(nextProfiles);
    const reassignedRecords = assignBuyerEmails(purchaseRecords, nextProfiles);
    if (JSON.stringify(reassignedRecords) !== JSON.stringify(purchaseRecords)) {
      const normalized = normalizePurchaseRecords(reassignedRecords).records;
      setPurchaseRecords(normalized);
      await replacePurchaseRecords(normalized);
    }
    if (
      previousProfile &&
      (previousProfile.displayName !== savedProfile.displayName || previousProfile.buyerName !== savedProfile.buyerName)
    ) {
      await writeAudit('profile_binding_updated', 'purchase_record', savedProfile.id, `更新账号采购人绑定：${savedProfile.buyerName || '未填写'}`, {
        before: previousProfile,
        after: savedProfile,
      });
    }
    await loadCloudData();
  }

  if (!authReady) {
    return <main className="app-shell"><section className="panel">正在连接云端...</section></main>;
  }

  if (passwordRecovery) {
    return <PasswordResetPanel onDone={async () => {
      setPasswordRecovery(false);
      sessionStorage.removeItem('passwordRecovery');
      window.history.replaceState(null, '', window.location.pathname);
      await loadSession();
    }} />;
  }

  if (!isSupabaseConfigured || !profile) {
    return <AuthPanel onAuthed={loadSession} />;
  }

  const editable = canEdit(profile.role);
  const deletable = canDelete(profile.role);
  const pendingAssignedTasks = purchaseRecords.filter((record) => (
    record.status === 'pending'
    && record.assignedBuyerEmail.trim().toLowerCase() === profile.email.trim().toLowerCase()
  ));
  const activeRepricingAlerts = repricingAlerts.filter((alert) => alert.isActive && (alert.alertLevel === 'high' || alert.alertLevel === 'medium'));

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

      {pendingAssignedTasks.length > 0 && (
        <button type="button" className="task-notice" onClick={() => setActivePage('my-orders')}>
          你有 {pendingAssignedTasks.length} 条新的待采购任务，点击查看
        </button>
      )}

      {activeRepricingAlerts.length > 0 && (
        <button type="button" className="task-notice repricing-notice" onClick={() => setActivePage('repricing')}>
          发现 {activeRepricingAlerts.length} 个确定被跟价商品，点击查看
        </button>
      )}

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

      {statusMessage && <div className="inline-notice">{statusMessage}</div>}

      {activePage === 'sku' && (
        <SkuManager items={skuItems} onChange={persistSkuItems} canEditData={editable} canDeleteData={deletable} />
      )}

      {activePage === 'calculator' && (
        <ContainerCalculatorPage
          skuItems={skuItems}
          purchaseRows={purchaseRows}
          fileName={fileName}
          onRowsChange={(rows) => void persistPurchaseRows(rows)}
          onFileNameChange={setFileName}
          onRecordsCreate={(records) => {
            void appendPurchaseRecords(records);
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
        <>
          <ProfileBinding profile={profile} onSave={saveProfileBinding} />
          <MyPurchaseOrdersPage
            records={purchaseRecords}
            skuItems={skuItems}
            profile={profile}
            onChange={persistPurchaseRecords}
            onSkuChange={persistSkuItems}
          />
        </>
      )}

      {activePage === 'suggestions' && (
        <SalesSuggestionPage
          skuItems={skuItems}
          purchaseRecords={purchaseRecords}
          onSendToCalculator={(rows, name) => void sendSuggestionsToCalculator(rows, name)}
          canEditData={editable}
          savedSuggestions={savedSalesSuggestions}
        />
      )}

      {activePage === 'repricing' && (
        <RepricingAlertsPage alerts={repricingAlerts} skuItems={skuItems} onRefresh={loadCloudData} />
      )}
    </main>
  );
}

export default App;

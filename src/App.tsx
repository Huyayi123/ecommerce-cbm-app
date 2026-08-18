import { useEffect, useState } from 'react';
import { AuthPanel } from './components/AuthPanel';
import { PasswordResetPanel } from './components/PasswordResetPanel';
import { ProfileBinding } from './components/ProfileBinding';
import { SkuManager } from './components/SkuManager';
import { isSupabaseConfigured, supabase } from './lib/supabase';
import { AdAnalysisPage } from './pages/AdAnalysisPage';
import { ContainerCalculatorPage } from './pages/ContainerCalculatorPage';
import { LogisticsLoadingPage } from './pages/LogisticsLoadingPage';
import { MyPurchaseOrdersPage } from './pages/MyPurchaseOrdersPage';
import { MonthlyProfitPage } from './pages/MonthlyProfitPage';
import { ProfitAnalysisPage } from './pages/ProfitAnalysisPage';
import { PurchasePoolPage } from './pages/PurchasePoolPage';
import { PurchaseInventoryPage } from './pages/PurchaseInventoryPage';
import { RepricingAlertsPage } from './pages/RepricingAlertsPage';
import { SalesSuggestionPage } from './pages/SalesSuggestionPage';
import type { AdAnalysisRun, AppProfile, LogisticsBatch, MonthlyProfitSummary, ProfitAnalysisRun, PurchasePool, PurchaseRecord, PurchaseRow, RepricingAlert, SalesSuggestionRow, SkuItem } from './types';
import {
  appendPurchaseRecordsToPool,
  deletePurchaseRecords,
  fetchContainerRows,
  fetchProfile,
  fetchProfiles,
  fetchPurchasePools,
  fetchPurchaseRecords,
  fetchAdAnalysisRuns,
  fetchProfitAnalysisRuns,
  fetchMonthlyProfitSummaries,
  fetchRepricingAlerts,
  fetchSalesSuggestions,
  fetchSkuItems,
  fetchSkuItemsForImport,
  fetchLogisticsBatches,
  replaceContainerRows,
  replacePurchaseRecords,
  replaceSkuItems,
  subscribeToSharedTables,
  updateProfileBinding,
  saveAdAnalysisRun,
  saveProfitAnalysisRun,
  upsertMonthlyProfitSummary,
  submitLogisticsBatch,
  updateLogisticsBatchStatus,
  upsertLogisticsBatch,
  upsertPurchasePools,
  upsertPurchaseRecords,
} from './utils/cloudStorage';
import { formatErrorMessage } from './utils/errors';
import { applyApprovedLogisticsBatch } from './utils/logistics';
import { canDelete, canEdit } from './utils/permissions';
import { withPurchaseTotals } from './utils/purchaseRecords';

type PageKey = 'sku' | 'calculator' | 'inventory' | 'purchase-pool' | 'my-orders' | 'suggestions' | 'repricing' | 'profit-analysis' | 'monthly-profit' | 'ad-analysis' | 'logistics';

const ACTIVE_PAGE_STORAGE_KEY = 'ecommerce-cbm-active-page';

const navItems: Array<{ key: PageKey; label: string }> = [
  { key: 'repricing', label: '价格预警' },
  { key: 'profit-analysis', label: '利润分析' },
  { key: 'monthly-profit', label: '月度利润' },
  { key: 'ad-analysis', label: '广告分析' },
  { key: 'logistics', label: '物流装柜确认' },
  { key: 'suggestions', label: '月销量采购建议' },
  { key: 'calculator', label: '装柜计算' },
  { key: 'my-orders', label: '我的采购订单' },
  { key: 'purchase-pool', label: '采购订单池' },
  { key: 'inventory', label: '采购 / 在途库存' },
  { key: 'sku', label: 'SKU 资料库' },
];

const pageKeys = new Set<PageKey>(navItems.map((item) => item.key));

function getInitialActivePage(): PageKey {
  const stored = localStorage.getItem(ACTIVE_PAGE_STORAGE_KEY) as PageKey | null;
  return stored && pageKeys.has(stored) ? stored : 'suggestions';
}

function isOptionalProfileLoadError(index: number, error: unknown): boolean {
  return (index === 3 || index === 4 || index === 5 || index === 7) && /failed to fetch|fetch|广告分析表/i.test(formatErrorMessage(error));
}

function App() {
  const [activePage, setActivePage] = useState<PageKey>(getInitialActivePage);
  const [profile, setProfile] = useState<AppProfile | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  const [skuItems, setSkuItems] = useState<SkuItem[]>([]);
  const [purchaseRows, setPurchaseRows] = useState<PurchaseRow[]>([]);
  const [purchaseRecords, setPurchaseRecords] = useState<PurchaseRecord[]>([]);
  const [purchasePools, setPurchasePools] = useState<PurchasePool[]>([]);
  const [logisticsBatches, setLogisticsBatches] = useState<LogisticsBatch[]>([]);
  const [savedSalesSuggestions, setSavedSalesSuggestions] = useState<SalesSuggestionRow[]>([]);
  const [repricingAlerts, setRepricingAlerts] = useState<RepricingAlert[]>([]);
  const [adAnalysisRuns, setAdAnalysisRuns] = useState<AdAnalysisRun[]>([]);
  const [profitAnalysisRuns, setProfitAnalysisRuns] = useState<ProfitAnalysisRun[]>([]);
  const [monthlyProfitSummaries, setMonthlyProfitSummaries] = useState<MonthlyProfitSummary[]>([]);
  const [profiles, setProfiles] = useState<AppProfile[]>([]);
  const [fileName, setFileName] = useState('');
  const [statusMessage, setStatusMessage] = useState('');

  function hasPasswordRecoveryToken(): boolean {
    const urlText = `${window.location.search}${window.location.hash}`.toLowerCase();
    return urlText.includes('type=recovery') || sessionStorage.getItem('passwordRecovery') === 'true';
  }

  function openPage(page: PageKey) {
    setActivePage(page);
    localStorage.setItem(ACTIVE_PAGE_STORAGE_KEY, page);
  }

  async function loadCloudData(activeProfile = profile) {
    if (!supabase) return;
    if (activeProfile?.role === 'logistics') {
      try {
        const batches = await fetchLogisticsBatches();
        setLogisticsBatches(batches);
        setProfiles((current) => (current.some((item) => item.id === activeProfile.id) ? current : [activeProfile, ...current]));
      } catch (error) {
        console.error('物流批次加载失败', error);
        setStatusMessage(`物流批次加载失败：${formatErrorMessage(error)}`);
      }
      return;
    }

    const results = await Promise.allSettled([
      fetchSkuItems(),
      fetchContainerRows(),
      fetchPurchaseRecords(),
      fetchProfiles(),
      fetchSalesSuggestions(),
      fetchRepricingAlerts(),
      fetchPurchasePools(),
      fetchAdAnalysisRuns(),
      fetchLogisticsBatches(),
      activeProfile?.role === 'admin' || activeProfile?.role === 'owner' ? fetchProfitAnalysisRuns() : Promise.resolve([]),
      activeProfile?.role === 'owner' ? fetchMonthlyProfitSummaries() : Promise.resolve([]),
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
    if (results[3].status === 'fulfilled') {
      setProfiles(results[3].value);
    } else if (profile) {
      setProfiles((current) => (current.some((item) => item.id === profile.id) ? current : [...current, profile]));
    }
    if (results[4].status === 'fulfilled') setSavedSalesSuggestions(results[4].value);
    if (results[5].status === 'fulfilled') setRepricingAlerts(results[5].value);
    if (results[6].status === 'fulfilled') setPurchasePools(results[6].value);
    if (results[7].status === 'fulfilled') setAdAnalysisRuns(results[7].value);
    if (results[8].status === 'fulfilled') setLogisticsBatches(results[8].value);
    if (results[9].status === 'fulfilled') setProfitAnalysisRuns(results[9].value);
    if (results[10].status === 'fulfilled') setMonthlyProfitSummaries(results[10].value);

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
        let activeProfile: AppProfile;
        try {
          activeProfile = await fetchProfile(user.id, user.email ?? '');
          setProfile(activeProfile);
        } catch (error) {
          console.error(error);
          activeProfile = { id: user.id, email: user.email ?? '', role: 'viewer', displayName: user.email ?? '', buyerName: '' };
          setProfile(activeProfile);
          setStatusMessage(`账号资料加载失败：${formatErrorMessage(error)}`);
        }
        await loadCloudData(activeProfile);
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
        setPurchasePools([]);
        setLogisticsBatches([]);
        setProfiles([]);
        setRepricingAlerts([]);
        setAdAnalysisRuns([]);
        setProfitAnalysisRuns([]);
        setMonthlyProfitSummaries([]);
        return;
      }
      void fetchProfile(user.id, user.email ?? '').then((nextProfile) => {
        setProfile(nextProfile);
        void loadCloudData(nextProfile);
      });
    });

    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!profile) return undefined;
    return subscribeToSharedTables(() => {
      void loadCloudData(profile);
    });
  }, [profile]);

  useEffect(() => {
    if (!profile || activePage !== 'inventory') return undefined;
    const refreshInventory = () => {
      if (document.visibilityState === 'visible') void loadCloudData(profile);
    };
    const timer = window.setInterval(refreshInventory, 10000);
    window.addEventListener('focus', refreshInventory);
    document.addEventListener('visibilitychange', refreshInventory);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshInventory);
      document.removeEventListener('visibilitychange', refreshInventory);
    };
  }, [activePage, profile]);

  async function persistSkuItems(nextItems: SkuItem[]) {
    await replaceSkuItems(nextItems);
    setSkuItems(nextItems);
  }

  async function persistPurchaseRows(nextRows: PurchaseRow[]) {
    setPurchaseRows(nextRows);
    await replaceContainerRows(nextRows);
  }

  async function persistPurchaseRecords(nextRecords: PurchaseRecord[]) {
    const normalized = normalizePurchaseRecords(assignBuyerEmails(nextRecords));
    await replacePurchaseRecords(normalized.records);
    setPurchaseRecords(normalized.records);
  }

  async function persistPurchaseRecordUpdates(changedRecords: PurchaseRecord[]) {
    const normalized = normalizePurchaseRecords(assignBuyerEmails(changedRecords)).records;
    try {
      await upsertPurchaseRecords(normalized);
      setPurchaseRecords((current) => {
        const existingIds = new Set(current.map((record) => record.id));
        const changedById = new Map(normalized.map((record) => [record.id, record]));
        const updated = current.map((record) => changedById.get(record.id) ?? record);
        const created = normalized.filter((record) => !existingIds.has(record.id));
        return [...created, ...updated];
      });
    } catch (error) {
      await loadCloudData();
      throw error;
    }
  }

  async function persistPurchasePools(changedPools: PurchasePool[]) {
    const normalized = changedPools.map((pool) => ({ ...pool, createdAt: pool.createdAt || new Date().toISOString() }));
    setPurchasePools((current) => {
      const existingIds = new Set(current.map((pool) => pool.id));
      const changedById = new Map(normalized.map((pool) => [pool.id, pool]));
      const updated = current.map((pool) => changedById.get(pool.id) ?? pool);
      const created = normalized.filter((pool) => !existingIds.has(pool.id));
      return [...created, ...updated];
    });
    try {
      await upsertPurchasePools(normalized);
    } catch (error) {
      await loadCloudData();
      throw error;
    }
  }

  async function submitPurchaseRecordsToPool(pool: PurchasePool, records: PurchaseRecord[]) {
    const submittedRecords = normalizePurchaseRecords(assignBuyerEmails(records)).records.map((record) => withPurchaseTotals({
      ...record,
      isConfirmed: true,
      status: 'pending',
      poolStatus: 'submitted_to_pool' as const,
      purchasePoolId: record.purchasePoolId || pool.id,
      purchasePoolName: record.purchasePoolName || pool.name,
      purchasePoolDate: record.purchasePoolDate || pool.containerDate,
      purchaseBatchId: record.purchaseBatchId || pool.id,
      purchaseBatchName: record.purchaseBatchName || pool.name,
      purchaseBatchDate: record.purchaseBatchDate || pool.containerDate,
    }));
    try {
      const savedPool = await appendPurchaseRecordsToPool({ ...pool, records: [] }, submittedRecords);
      await upsertPurchaseRecords(submittedRecords);
      setPurchasePools((current) => {
        const existingIds = new Set(current.map((item) => item.id));
        if (!existingIds.has(savedPool.id)) return [savedPool, ...current];
        return current.map((item) => (item.id === savedPool.id ? savedPool : item));
      });
      setPurchaseRecords((current) => {
        const changedById = new Map(submittedRecords.map((record) => [record.id, record]));
        return current.map((record) => changedById.get(record.id) ?? record);
      });
      await loadCloudData();
    } catch (error) {
      await loadCloudData();
      throw error;
    }
  }

  async function persistPurchaseRecordDeletes(ids: string[]) {
    const deleteIds = new Set(ids);
    setPurchaseRecords((current) => current.filter((record) => !deleteIds.has(record.id)));
    try {
      await deletePurchaseRecords(ids);
    } catch (error) {
      await loadCloudData();
      throw error;
    }
  }

  async function persistLogisticsBatch(batch: LogisticsBatch) {
    await upsertLogisticsBatch(batch);
    setLogisticsBatches((current) => {
      const exists = current.some((item) => item.id === batch.id);
      return exists ? current.map((item) => (item.id === batch.id ? batch : item)) : [batch, ...current];
    });
    await loadCloudData(profile);
  }

  async function persistLogisticsSubmit(batch: LogisticsBatch) {
    await submitLogisticsBatch(batch);
    setLogisticsBatches((current) => current.map((item) => (item.id === batch.id ? { ...batch, status: 'submitted' } : item)));
    await loadCloudData(profile);
  }

  async function approveLogisticsBatch(batch: LogisticsBatch) {
    if (!profile) return;
    const approvedBatch: LogisticsBatch = {
      ...batch,
      status: 'approved',
      reviewedBy: profile.id,
      reviewedAt: new Date().toISOString(),
    };
    const normalizedRecords = normalizePurchaseRecords(assignBuyerEmails(applyApprovedLogisticsBatch(purchaseRecords, approvedBatch))).records;
    const pendingRecordsByPool = new Map<string, PurchaseRecord[]>();
    for (const record of normalizedRecords) {
      if (record.status === 'cancelled' || record.poolStatus !== 'submitted_to_pool') continue;
      const poolId = record.purchasePoolId || record.purchaseBatchId;
      if (!poolId) continue;
      pendingRecordsByPool.set(poolId, [...(pendingRecordsByPool.get(poolId) ?? []), record]);
    }
    const nextPools = purchasePools.map((pool) => {
      const pendingRecords = pendingRecordsByPool.get(pool.id) ?? [];
      return {
        ...pool,
        status: pendingRecords.length > 0 ? 'open' as const : 'sent' as const,
        sentBy: pendingRecords.length > 0 ? pool.sentBy : profile.id,
        sentAt: pendingRecords.length > 0 ? pool.sentAt : new Date().toISOString(),
        records: pendingRecords,
      };
    });
    await replacePurchaseRecords(normalizedRecords);
    await persistPurchasePools(nextPools);
    await updateLogisticsBatchStatus(approvedBatch);
    setPurchaseRecords(normalizedRecords);
    setPurchasePools(nextPools);
    setLogisticsBatches((current) => current.map((item) => (item.id === batch.id ? approvedBatch : item)));
    await loadCloudData(profile);
  }

  async function rejectLogisticsBatch(batch: LogisticsBatch) {
    await updateLogisticsBatchStatus(batch);
    setLogisticsBatches((current) => current.map((item) => (item.id === batch.id ? batch : item)));
    await loadCloudData(profile);
  }

  async function appendPurchaseRecords(records: PurchaseRecord[]) {
    try {
      const assignedRecords = assignBuyerEmails(records).map((record) => ({
        ...record,
        purchasePoolId: record.purchasePoolId || record.purchaseBatchId,
        purchasePoolName: record.purchasePoolName || record.purchaseBatchName,
        purchasePoolDate: record.purchasePoolDate || record.purchaseBatchDate,
        poolStatus: 'pending_purchase' as const,
      }));
      const poolsToCreate = Array.from(new Map(assignedRecords
        .filter((record) => record.purchasePoolId || record.purchasePoolName || record.purchasePoolDate)
        .map((record) => [record.purchasePoolId || `${record.purchasePoolDate}|${record.purchasePoolName}`, {
          id: record.purchasePoolId || `${record.purchasePoolDate}|${record.purchasePoolName}`,
          name: record.purchasePoolName || record.purchaseBatchName || `${record.purchasePoolDate || record.purchaseBatchDate} 批次`,
          containerDate: record.purchasePoolDate || record.purchaseBatchDate,
          status: 'open' as const,
          createdBy: profile?.id || '',
          createdAt: new Date().toISOString(),
          sentBy: '',
          sentAt: '',
          note: '',
          records: [],
        }])).values());
      const nextRecords = [...assignedRecords, ...purchaseRecords];
      if (poolsToCreate.length > 0) await persistPurchasePools(poolsToCreate);
      await persistPurchaseRecords(nextRecords);
      await loadCloudData();
      setStatusMessage(`已生成 ${assignedRecords.length} 条采购任务，请采购人在“我的采购订单”确认后进入在途库存口径。`);
      openPage('my-orders');
    } catch (error) {
      console.error(error);
      setStatusMessage(`采购记录保存失败：${formatErrorMessage(error)}`);
      throw error;
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

  function normalizePurchaseRecords(records: PurchaseRecord[]): { records: PurchaseRecord[] } {
    return { records: records.map((record) => withPurchaseTotals(record)) };
  }

  async function sendSuggestionsToCalculator(rows: PurchaseRow[], nextFileName: string) {
    await persistPurchaseRows(rows);
    setFileName(nextFileName);
    openPage('calculator');
  }

  async function signOut() {
    await supabase?.auth.signOut();
  }

  async function saveProfileBinding(nextProfile: AppProfile) {
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
    && record.poolStatus === 'pending_purchase'
    && record.assignedBuyerEmail.trim().toLowerCase() === profile.email.trim().toLowerCase()
  ));
  const pendingTaskCount = purchaseRecords.filter((record) => record.status === 'pending' && record.poolStatus === 'pending_purchase').length;
  const poolSubmittedCount = purchasePools.reduce((sum, pool) => sum + pool.records.length, 0);
  const activeRepricingAlerts = repricingAlerts.filter((alert) => alert.isActive && (alert.alertLevel === 'high' || alert.alertLevel === 'medium'));
  const visibleNavItems = profile.role === 'logistics'
    ? navItems.filter((item) => item.key === 'logistics')
    : navItems.filter((item) => (item.key !== 'logistics' || profile.role === 'admin' || profile.role === 'owner')
      && (item.key !== 'profit-analysis' || profile.role === 'admin' || profile.role === 'owner')
      && (item.key !== 'monthly-profit' || profile.role === 'owner'));
  const currentPage = visibleNavItems.some((item) => item.key === activePage) ? activePage : visibleNavItems[0]?.key ?? 'logistics';

  return (
    <main className="app-shell">
      <aside className="side-nav" aria-label="主导航">
        <div className="side-nav-title">
          <strong>电商工作台</strong>
          <span>采购 · 库存 · 广告</span>
        </div>
        <nav>
          {visibleNavItems.map((item) => (
            <button
              key={item.key}
              type="button"
              className={currentPage === item.key ? 'active' : ''}
              onClick={() => openPage(item.key)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>
      <div className="app-content">
      <header className="app-header">
        <div>
          <h1>电商采购装柜工作台</h1>
          <p>维护 SKU 体积资料，计算装柜 CBM，管理海运在途采购，并生成采购和广告建议。</p>
        </div>
        <div className="user-panel">
          <span>{profile.displayName}</span>
          <strong>{profile.role}</strong>
          <button type="button" onClick={signOut}>退出</button>
        </div>
      </header>

      {pendingAssignedTasks.length > 0 && (
        <button type="button" className="task-notice" onClick={() => openPage('my-orders')}>
          你有 {pendingAssignedTasks.length} 条新的待采购任务，点击查看
        </button>
      )}

      {pendingTaskCount > 0 && (
        <button type="button" className="task-notice" onClick={() => openPage('my-orders')}>
          当前共有 {pendingTaskCount} 条待采购任务（所有采购人），点击查看
        </button>
      )}

      {poolSubmittedCount > 0 && (
        <button type="button" className="task-notice" onClick={() => openPage('purchase-pool')}>
          采购订单池有 {poolSubmittedCount} 条待发送记录，点击查看
        </button>
      )}

      {activeRepricingAlerts.length > 0 && (
        <button type="button" className="task-notice repricing-notice" onClick={() => openPage('repricing')}>
          发现 {activeRepricingAlerts.length} 个确定被跟价商品，点击查看
        </button>
      )}

      {statusMessage && <div className="inline-notice">{statusMessage}</div>}

      {currentPage === 'sku' && (
        <SkuManager
          items={skuItems}
          onChange={persistSkuItems}
          loadImportMatches={fetchSkuItemsForImport}
          onCloudRefresh={loadCloudData}
          canEditData={editable}
          canDeleteData={deletable}
        />
      )}

      {currentPage === 'calculator' && (
        <ContainerCalculatorPage
          skuItems={skuItems}
          purchaseRows={purchaseRows}
          fileName={fileName}
          onRowsChange={(rows) => void persistPurchaseRows(rows)}
          onFileNameChange={setFileName}
          onRecordsCreate={appendPurchaseRecords}
          canEditData={true}
        />
      )}

      {currentPage === 'inventory' && (
        <PurchaseInventoryPage
          records={purchaseRecords}
          skuItems={skuItems}
          onChange={(records) => void persistPurchaseRecords(records)}
          onDeleteRecords={persistPurchaseRecordDeletes}
          canEditData={editable}
          canDeleteData={deletable}
          canSaveMissingSkuHistory={profile.role === 'admin' || profile.role === 'owner'}
        />
      )}

      {currentPage === 'purchase-pool' && (
        <PurchasePoolPage
          records={purchaseRecords}
          pools={purchasePools}
          profile={profile}
          skuItems={skuItems}
          onSaveRecords={persistPurchaseRecordUpdates}
          onSavePools={persistPurchasePools}
        />
      )}

      {currentPage === 'my-orders' && (
        <>
          <ProfileBinding profile={profile} onSave={saveProfileBinding} />
          <MyPurchaseOrdersPage
            records={purchaseRecords}
            skuItems={skuItems}
            profile={profile}
            onChange={persistPurchaseRecords}
            onSaveRecords={persistPurchaseRecordUpdates}
            onDeleteRecords={persistPurchaseRecordDeletes}
            onSubmitToPool={submitPurchaseRecordsToPool}
          />
        </>
      )}

      {currentPage === 'suggestions' && (
        <SalesSuggestionPage
          skuItems={skuItems}
          purchaseRecords={purchaseRecords}
          onSendToCalculator={(rows, name) => void sendSuggestionsToCalculator(rows, name)}
          canEditData={editable}
          savedSuggestions={savedSalesSuggestions}
        />
      )}

      {currentPage === 'repricing' && (
        <RepricingAlertsPage alerts={repricingAlerts} skuItems={skuItems} onRefresh={loadCloudData} />
      )}
      {currentPage === 'profit-analysis' && (profile.role === 'admin' || profile.role === 'owner') && (
        <ProfitAnalysisPage
          skuItems={skuItems}
          profile={profile}
          runs={profitAnalysisRuns}
          onSaveRun={saveProfitAnalysisRun}
          onRefresh={loadCloudData}
        />
      )}
      {currentPage === 'monthly-profit' && profile.role === 'owner' && (
        <MonthlyProfitPage skuItems={skuItems} profile={profile} summaries={monthlyProfitSummaries} onSave={upsertMonthlyProfitSummary} onRefresh={loadCloudData} />
      )}
      {currentPage === 'ad-analysis' && (
        <AdAnalysisPage
          skuItems={skuItems}
          profile={profile}
          savedRuns={adAnalysisRuns}
          onSaveRun={saveAdAnalysisRun}
          onRefresh={loadCloudData}
        />
      )}
      {currentPage === 'logistics' && (
        <LogisticsLoadingPage
          profile={profile}
          profiles={profiles}
          records={purchaseRecords}
          skuItems={skuItems}
          batches={logisticsBatches}
          onSaveBatch={persistLogisticsBatch}
          onSubmitBatch={persistLogisticsSubmit}
          onApproveBatch={approveLogisticsBatch}
          onRejectBatch={rejectLogisticsBatch}
        />
      )}
      </div>
    </main>
  );
}

export default App;

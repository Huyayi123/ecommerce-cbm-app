import { createSessionLoad, publishCloudTask } from './utils/cloudLoadTasks';
import { AlibabaSignedTimeCheck } from './components/AlibabaSignedTimeCheck';
import { createCoalescedLoad } from './utils/coalescedLoad';
import { useEffect, useRef, useState } from 'react';
import { AuthPanel } from './components/AuthPanel';

import { PasswordResetPanel } from './components/PasswordResetPanel';
import { ProfileBinding } from './components/ProfileBinding';
import { SkuManager } from './components/SkuManager';
import { isSupabaseConfigured, supabase } from './lib/supabase';
import { AdAnalysisPage } from './pages/AdAnalysisPage';
import { CommissionPage } from './pages/CommissionPage';
import { ContainerCalculatorPage } from './pages/ContainerCalculatorPage';
import { HaichuanWorkflowPage } from './pages/HaichuanWorkflowPage';
import { LogisticsLoadingPage } from './pages/LogisticsLoadingPage';
import { MyPurchaseOrdersPage } from './pages/MyPurchaseOrdersPage';
import { MonthlyProfitPage } from './pages/MonthlyProfitPage';
import { ProfitAnalysisPage } from './pages/ProfitAnalysisPage';
import { PurchasePoolPage } from './pages/PurchasePoolPage';
import { PurchaseInventoryPage } from './pages/PurchaseInventoryPage';
import { RepricingAlertsPage } from './pages/RepricingAlertsPage';
import { SalesSuggestionPage } from './pages/SalesSuggestionPage';
import type { AdAnalysisRun, AppProfile, CommissionRun, HaichuanData, LogisticsBatch, MonthlyProfitSummary, ProfitAnalysisRun, PurchasePool, PurchaseRecord, PurchaseRow, RepricingAlert, SalesSuggestionRow, SkuItem } from './types';
import {
  appendPurchaseRecordsToPool,
  deletePurchaseRecords,
  fetchContainerRows,
  fetchProfile,
  fetchProfiles,
  fetchPurchasePools,
  fetchPurchaseRecords,
  fetchAdAnalysisRuns,
  fetchCommissionRun,
  fetchCommissionRuns,
  fetchProfitAnalysisRuns,
  fetchMonthlyProfitSummaries,
  fetchRepricingAlerts,
  fetchSalesSuggestions,
  fetchSkuItems,
  fetchSkuItemsForImport,
  fetchLogisticsBatches,
  clearLogisticsConfirmations,
  replaceContainerRows,
  replacePurchaseRecords,
  replaceSkuItems,
  subscribeToSharedTables,
  updateProfileBinding,
  upsertSkuItem,
  saveAdAnalysisRun,
  saveCommissionRun,
  saveProfitAnalysisRun,
  upsertMonthlyProfitSummary,
  submitLogisticsBatch,
  updateLogisticsBatchStatus,
  upsertLogisticsBatch,
  upsertPurchasePools,
  upsertPurchaseRecords,
} from './utils/cloudStorage';
import { confirmHaichuanReceipt, createHaichuanInboundItems, deleteHaichuanWarehouseLot, deletePendingHaichuanInboundItems, fetchHaichuanData, reviewHaichuanLoadingBatch, submitHaichuanLoadingBatch, syncApprovedHaichuanLoadingItems, syncPendingHaichuanInboundItems, updateHaichuanWarehouseQuantity } from './utils/haichuanStorage';
import { formatErrorMessage } from './utils/errors';
import { applyApprovedLogisticsBatch } from './utils/logistics';
import { canDelete, canEdit } from './utils/permissions';
import { shouldDeletePendingHaichuanInbound } from './utils/purchasePoolFlows';
import { withPurchaseTotals } from './utils/purchaseRecords';

type PageKey = 'sku' | 'calculator' | 'inventory' | 'purchase-pool' | 'my-orders' | 'suggestions' | 'repricing' | 'profit-analysis' | 'monthly-profit' | 'ad-analysis' | 'commission' | 'logistics' | 'haichuan-warehouse';

const signedTimeCheckRequested = new URLSearchParams(window.location.search).get('check1688SignedTime') === '1'
  || new URLSearchParams(window.location.search).get('check1688Logistics') === '1';

const navItems: Array<{ key: PageKey; label: string }> = [
  { key: 'repricing', label: '价格预警' },
  { key: 'profit-analysis', label: '利润分析' },
  { key: 'monthly-profit', label: '月度利润' },
  { key: 'ad-analysis', label: '广告分析' },
  { key: 'commission', label: '采购人提成' },
  { key: 'logistics', label: '物流装柜确认' },
  { key: 'haichuan-warehouse', label: '海川仓库库存' },
  { key: 'suggestions', label: '月销量采购建议' },
  { key: 'calculator', label: '装柜计算' },
  { key: 'my-orders', label: '我的采购订单' },
  { key: 'purchase-pool', label: '采购订单池' },
  { key: 'inventory', label: '采购 / 在途库存' },
  { key: 'sku', label: 'SKU 资料库' },
];

function isOptionalProfileLoadError(index: number, error: unknown): boolean {
  return (index === 3 || index === 4 || index === 5 || index === 7 || index === 11) && /failed to fetch|fetch|广告分析表|commission_runs/i.test(formatErrorMessage(error));
}

function App() {
  const [activePage, setActivePage] = useState<PageKey>('my-orders');
  const [profile, setProfile] = useState<AppProfile | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  const [skuItems, setSkuItems] = useState<SkuItem[]>([]);
  const [purchaseRows, setPurchaseRows] = useState<PurchaseRow[]>([]);
  const [purchaseRecords, setPurchaseRecords] = useState<PurchaseRecord[]>([]);
  const [purchasePools, setPurchasePools] = useState<PurchasePool[]>([]);
  const [logisticsBatches, setLogisticsBatches] = useState<LogisticsBatch[]>([]);
  const [haichuanData, setHaichuanData] = useState<HaichuanData>({ inboundItems: [], warehouseLots: [], loadingBatches: [] });
  const [savedSalesSuggestions, setSavedSalesSuggestions] = useState<SalesSuggestionRow[]>([]);
  const [repricingAlerts, setRepricingAlerts] = useState<RepricingAlert[]>([]);
  const [adAnalysisRuns, setAdAnalysisRuns] = useState<AdAnalysisRun[]>([]);
  const [profitAnalysisRuns, setProfitAnalysisRuns] = useState<ProfitAnalysisRun[]>([]);
  const [monthlyProfitSummaries, setMonthlyProfitSummaries] = useState<MonthlyProfitSummary[]>([]);
  const [commissionRuns, setCommissionRuns] = useState<CommissionRun[]>([]);
  const [profiles, setProfiles] = useState<AppProfile[]>([]);
  const [fileName, setFileName] = useState('');
  const [statusMessage, setStatusMessage] = useState('');

  function hasPasswordRecoveryToken(): boolean {
    const urlText = `${window.location.search}${window.location.hash}`.toLowerCase();
    return urlText.includes('type=recovery') || sessionStorage.getItem('passwordRecovery') === 'true';
  }

  function openPage(page: PageKey) {
    setActivePage(page);
  }

  const [readyModules, setReadyModules] = useState<Set<number>>(() => new Set());
  const sessionLoader = useRef(createSessionLoad());
  const sessionGeneration = useRef(0);
  const sessionIdentity = useRef('');
  function clearCloudData() {
    setReadyModules(new Set());
    setSkuItems([]);
    setPurchaseRows([]);
    setPurchaseRecords([]);
    setPurchasePools([]);
    setLogisticsBatches([]);
    setHaichuanData({ inboundItems: [], warehouseLots: [], loadingBatches: [] });
    setProfiles([]);
    setRepricingAlerts([]);
    setAdAnalysisRuns([]);
    setProfitAnalysisRuns([]);
    setMonthlyProfitSummaries([]);
    setCommissionRuns([]);
    setSavedSalesSuggestions([]);
    setStatusMessage('');
  }
  const cloudLoader=useRef(createCoalescedLoad());
  function loadCloudData(activeProfile = profile,queue=true, inventoryOnly = false) {
    const generation = sessionGeneration.current;
    const key = generation + ':' + (activeProfile ? activeProfile.id + ':' + activeProfile.role + ':' + activeProfile.email : 'none');
    return cloudLoader.current(key, () => generation === sessionGeneration.current ? performCloudDataLoad(activeProfile, inventoryOnly) : Promise.resolve(), queue);
  }
  async function performCloudDataLoad(activeProfile: AppProfile | null, inventoryOnly: boolean) {
    if (!supabase || !activeProfile) return;
    const generation = sessionGeneration.current;
    const current = () => generation === sessionGeneration.current && sessionIdentity.current.startsWith(activeProfile.id + ':');
    if (!current()) return;
    const publish = <T,>(index: number, read: Promise<T>, setter: (value: T) => void) =>
      publishCloudTask(read, value => {
        setter(value);
        setReadyModules(previous => new Set([...previous, index]));
      }, current).catch(error => {
        if (current() && isOptionalProfileLoadError(index, error)) {
          // Preserve the existing optional-module fallback during first load.
          setReadyModules(previous => new Set([...previous, index]));
        }
        throw error;
      });
    if (activeProfile?.role === 'logistics') {
      try {
        if (activeProfile.logisticsProviderType === 'haichuan') {
          await publish(12, fetchHaichuanData(), setHaichuanData);
        } else {
          const batches = await fetchLogisticsBatches();
          if (!current()) return;
          setLogisticsBatches(batches);
          setReadyModules(previous => new Set([...previous, 8]));
        }
        if (!current()) return;
        setProfiles((current) => (current.some((item) => item.id === activeProfile.id) ? current : [activeProfile, ...current]));
      } catch (error) {
        if (!current()) return;
        console.error('物流批次加载失败', error);
        setStatusMessage(`物流批次加载失败：${formatErrorMessage(error)}`);
      }
      return;
    }

    const loadNames = [
      'SKU资料库',
      '装柜计算',
      '采购记录',
      '账号资料',
      '月销量采购建议',
      '价格预警',
      '采购订单池',
      '广告分析历史',
      '物流装柜确认',
      '利润分析历史',
      '月利润汇总',
      '采购人提成历史',
      '海川仓库',
    ];
    if (inventoryOnly) {
      const results = await Promise.allSettled([
        publish(0, fetchSkuItems(), setSkuItems),
        publish(2, fetchPurchaseRecords(), setPurchaseRecords),
      ]);
      for (const result of results) {
        if (result.status === 'rejected') console.error('采购库存刷新失败', result.reason);
      }
      return;
    }
    const purchaseRead = fetchPurchaseRecords();
    const poolRead = fetchPurchasePools();
    const results = await Promise.allSettled([
      publish(0, fetchSkuItems(), setSkuItems),
      publish(1, fetchContainerRows(), setPurchaseRows),
      publish(2, purchaseRead, setPurchaseRecords),
      publish(3, fetchProfiles(), setProfiles),
      publish(4, fetchSalesSuggestions(), setSavedSalesSuggestions),
      publish(5, fetchRepricingAlerts(), setRepricingAlerts),
      publish(6, poolRead, setPurchasePools),
      publish(7, fetchAdAnalysisRuns(), setAdAnalysisRuns),
      publish(8, fetchLogisticsBatches(), setLogisticsBatches),
      publish(9, activeProfile?.role === 'admin' || activeProfile?.role === 'owner' ? fetchProfitAnalysisRuns() : Promise.resolve([]), setProfitAnalysisRuns),
      publish(10, activeProfile?.role === 'owner' ? fetchMonthlyProfitSummaries() : Promise.resolve([]), setMonthlyProfitSummaries),
      publish(11, activeProfile?.role === 'admin' ? fetchCommissionRuns() : Promise.resolve([]), setCommissionRuns),
      publish(12, fetchHaichuanData(), setHaichuanData),
    ]);
    if (!current()) return;
    const errors = results.flatMap((result, index) => {
      if (result.status !== 'rejected') return [];
      console.error('云端数据加载失败', { index, error: result.reason });
      if (isOptionalProfileLoadError(index, result.reason)) return [];
      return [`${loadNames[index] ?? `模块${index + 1}`}：${formatErrorMessage(result.reason)}`];
    });

    if (results[2].status === 'fulfilled' && results[3].status === 'fulfilled' && results[8].status === 'fulfilled' && results[12].status === 'fulfilled') {
      const haichuanProfile = results[3].value.find((item) => item.role === 'logistics' && item.logisticsProviderType === 'haichuan');
      if (haichuanProfile) {
        const existingInboundRecordIds = new Set(results[12].value.inboundItems.map((item) => item.purchaseRecordId));
        const legacyActiveRecordIds = new Set(results[8].value
          .filter((batch) => batch.status === 'draft' || batch.status === 'submitted')
          .flatMap((batch) => batch.items.filter((item) => item.loadingType === '海川').map((item) => item.purchaseRecordId)));
        const missingInbound = results[2].value.filter((record) => record.loadingType === '海川'
          && record.poolStatus === 'submitted_to_pool'
          && record.status !== 'cancelled'
          && !existingInboundRecordIds.has(record.id)
          && !legacyActiveRecordIds.has(record.id));
        if (missingInbound.length > 0) {
          try {
            await createHaichuanInboundItems(missingInbound, haichuanProfile, results[0].status === 'fulfilled' ? results[0].value : skuItems);
            await publish(12, fetchHaichuanData(), setHaichuanData);
          } catch (error) {
            if (!current()) return;
            console.error('海川待入仓任务补建失败', error);
            setStatusMessage(`海川待入仓任务补建失败：${formatErrorMessage(error)}`);
          }
        }
      }
    }

    if (!current()) return;
    if (errors.length > 0) {
      setStatusMessage(`部分云端数据加载失败：${errors.join('；')}`);
    } else {
      setStatusMessage(current => current.startsWith('部分云端数据加载失败：') ? '' : current);
    }
  }

  async function loadSession() {
    try {
      if (!supabase) {
        setAuthReady(true);
        return;
      }

      const generation = sessionGeneration.current;
      const { data } = await supabase.auth.getSession();
      if (generation !== sessionGeneration.current) return;
      const user = data.session?.user;
      if (user) {
        const identity = user.id + ':' + (user.email ?? '');
        if (sessionIdentity.current && sessionIdentity.current !== identity) {
          sessionGeneration.current++;
          setProfile(null);
          setAuthReady(false);
          clearCloudData();
          sessionLoader.current.reset();
        }
        sessionIdentity.current = identity;
        const activeGeneration = sessionGeneration.current;
        await sessionLoader.current.run(identity, async () => {
        let activeProfile: AppProfile;
        try {
          activeProfile = await fetchProfile(user.id, user.email ?? '');
          if (activeGeneration !== sessionGeneration.current) return;
          setProfile(activeProfile);
          setProfiles([activeProfile]);
        } catch (error) {
          if (activeGeneration !== sessionGeneration.current) return;
          console.error(error);
          activeProfile = { id: user.id, email: user.email ?? '', role: 'viewer', displayName: user.email ?? '', buyerName: '', logisticsProviderType: '' };
          setProfile(activeProfile);
          setStatusMessage(`账号资料加载失败：${formatErrorMessage(error)}`);
        }
        if (activeGeneration !== sessionGeneration.current) return;
        setAuthReady(true);
        if (signedTimeCheckRequested) return;
        void loadCloudData(activeProfile, false).catch(error => {
          if (activeGeneration === sessionGeneration.current) setStatusMessage('云端数据加载失败：' + formatErrorMessage(error));
        });
        });
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
      if (event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED') return;
      const user = session?.user;
      if (!user) {
        sessionGeneration.current++;
        sessionIdentity.current = '';
        sessionLoader.current.reset();
        setProfile(null);
        clearCloudData();
        return;
      }
      if (event === 'USER_UPDATED') {
        sessionGeneration.current++;
        sessionLoader.current.reset();
        setReadyModules(new Set());
      }
      // Leave the synchronous auth callback before calling Supabase again.
      setTimeout(() => { void loadSession(); }, 0);
    });

    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!profile || signedTimeCheckRequested) return undefined;
    return subscribeToSharedTables(() => {
      void loadCloudData(profile);
    });
  }, [profile]);

  useEffect(() => {
    if (!profile || signedTimeCheckRequested || activePage !== 'inventory') return undefined;
    const refreshInventory = () => {
      if (document.visibilityState === 'visible') void loadCloudData(profile, false, true);
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

  async function persistSkuItem(item: SkuItem) {
    const savedItem = await upsertSkuItem(item, skuItems);
    setSkuItems((current) => {
      const exists = current.some((existing) => existing.id === savedItem.id);
      return exists ? current.map((existing) => (existing.id === savedItem.id ? savedItem : existing)) : [savedItem, ...current];
    });
    return savedItem;
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

  async function persistPurchaseRecordUpdates(changedRecords: PurchaseRecord[], haichuanSync: 'none' | 'pending-inbound' | 'approved-loading' = 'none') {
    const normalized = normalizePurchaseRecords(assignBuyerEmails(changedRecords)).records;
    const existingById = new Map(purchaseRecords.map((record) => [record.id, record]));
    const newlyHaichuan = normalized.filter((record) => record.loadingType === '海川'
      && record.poolStatus === 'submitted_to_pool'
      && existingById.get(record.id)?.loadingType !== '海川');
    const removedFromHaichuan = (profile?.role === 'admin' || profile?.role === 'owner')
      ? normalized.filter((record) => shouldDeletePendingHaichuanInbound(existingById.get(record.id), record))
      : [];
    const haichuanProfile = profiles.find((item) => item.role === 'logistics' && item.logisticsProviderType === 'haichuan');
    if (newlyHaichuan.length > 0 && !haichuanProfile) {
      throw new Error('尚未绑定海川物流商账号，不能将采购池记录改为海川。');
    }
    try {
      await upsertPurchaseRecords(normalized);
      if (haichuanProfile && newlyHaichuan.length > 0) await createHaichuanInboundItems(newlyHaichuan, haichuanProfile, skuItems);
      if (removedFromHaichuan.length > 0) await deletePendingHaichuanInboundItems(removedFromHaichuan.map((record) => record.id));
      if (haichuanSync === 'pending-inbound') await syncPendingHaichuanInboundItems(normalized);
      if (haichuanSync === 'approved-loading') await syncApprovedHaichuanLoadingItems(normalized);
      setPurchaseRecords((current) => {
        const existingIds = new Set(current.map((record) => record.id));
        const changedById = new Map(normalized.map((record) => [record.id, record]));
        const updated = current.map((record) => changedById.get(record.id) ?? record);
        const created = normalized.filter((record) => !existingIds.has(record.id));
        return [...created, ...updated];
      });
      if (haichuanSync !== 'none' && normalized.some((record) => record.loadingType === '海川')) {
        setHaichuanData(await fetchHaichuanData());
      }
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
      containerDate: record.loadingType === '整柜' || record.loadingType === '' ? record.containerDate : '',
    }));
    const haichuanRecords = submittedRecords.filter((record) => record.loadingType === '海川');
    const haichuanProfile = profiles.find((item) => item.role === 'logistics' && item.logisticsProviderType === 'haichuan');
    if (haichuanRecords.length > 0 && !haichuanProfile) {
      throw new Error('尚未绑定海川物流商账号，请先在“海川仓库库存 → 物流商绑定”中完成绑定。');
    }
    try {
      const savedPool = await appendPurchaseRecordsToPool({ ...pool, records: [] }, submittedRecords);
      await upsertPurchaseRecords(submittedRecords);
      if (haichuanProfile && haichuanRecords.length > 0) await createHaichuanInboundItems(haichuanRecords, haichuanProfile, skuItems);
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
      if (profile?.role === 'admin' || profile?.role === 'owner') {
        const haichuanIds = purchaseRecords
          .filter((record) => deleteIds.has(record.id) && record.loadingType === '海川')
          .map((record) => record.id);
        if (haichuanIds.length > 0) await deletePendingHaichuanInboundItems(haichuanIds);
      }
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

  async function clearLogisticsData() {
    await clearLogisticsConfirmations();
    setLogisticsBatches([]);
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
    if (savedProfile.id === profile?.id) setProfile(savedProfile);
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

  if (signedTimeCheckRequested) return <AlibabaSignedTimeCheck />;

  const editable = canEdit(profile.role);
  const deletable = canDelete(profile.role);
  const pendingAssignedTasks = purchaseRecords.filter((record) => (
    record.status === 'pending'
    && record.poolStatus === 'pending_purchase'
    && record.assignedBuyerEmail.trim().toLowerCase() === profile.email.trim().toLowerCase()
  ));
  const pendingTaskCount = purchaseRecords.filter((record) => record.status === 'pending' && record.poolStatus === 'pending_purchase').length;
  const poolSubmittedCount = purchaseRecords.filter((record) => record.status !== 'cancelled' && record.poolStatus === 'submitted_to_pool').length;
  const activeRepricingAlerts = repricingAlerts.filter((alert) => alert.isActive && (alert.alertLevel === 'high' || alert.alertLevel === 'medium'));
  const visibleNavItems = profile.role === 'logistics'
    ? navItems.filter((item) => item.key === 'logistics')
    : navItems.filter((item) => (item.key !== 'logistics' || profile.role === 'admin' || profile.role === 'owner')
      && (item.key !== 'haichuan-warehouse' || profile.role === 'admin' || profile.role === 'owner')
      && (item.key !== 'profit-analysis' || profile.role === 'admin' || profile.role === 'owner')
      && (item.key !== 'commission' || profile.role === 'admin')
      && (item.key !== 'monthly-profit' || profile.role === 'owner'));
  const currentPage = visibleNavItems.some((item) => item.key === activePage) ? activePage : visibleNavItems[0]?.key ?? 'logistics';

  const dependencies: Record<PageKey, number[]> = {
    sku: [0], calculator: [0, 1], inventory: [0, 2],
    'purchase-pool': [0, 2, 3, 6, 8], 'my-orders': [0, 2, 6],
    suggestions: [0, 1, 2, 4, 12], repricing: [0, 5],
    'profit-analysis': [0, 9], 'monthly-profit': [0, 10],
    'ad-analysis': [0, 7], commission: [0, 2, 3, 11],
    logistics: profile.role === 'logistics' ? (profile.logisticsProviderType === 'haichuan' ? [12] : [8]) : [0, 2, 3, 8, 12],
    'haichuan-warehouse': [3, 12],
  };
  const pageReady = dependencies[currentPage].every(index => readyModules.has(index));


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

      {!pageReady ? <section className="panel" role="status">
        <p>正在加载当前页面数据，请稍候…</p>
        <button type="button" onClick={() => void loadCloudData(profile, false)}>重试加载</button>
      </section> : <>
      {currentPage === 'sku' && (
        <SkuManager
          items={skuItems}
          onChange={persistSkuItems}
          onSaveItem={persistSkuItem}
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
          onChange={persistPurchaseRecords}
          onSaveRecords={(records) => persistPurchaseRecordUpdates(records)}
          onSaveRecord={(record) => persistPurchaseRecordUpdates([record], 'approved-loading')}
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
          profiles={profiles}
          skuItems={skuItems}
          logisticsBatches={logisticsBatches}
          onSaveRecords={(records) => persistPurchaseRecordUpdates(records, 'pending-inbound')}
          onSavePools={persistPurchasePools}
          onSaveLogisticsBatch={persistLogisticsBatch}
          onOpenLogistics={() => openPage('logistics')}
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
          haichuanWarehouseLots={haichuanData.warehouseLots}
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
      {currentPage === 'commission' && profile.role === 'admin' && (
        <CommissionPage
          profile={profile}
          skuItems={skuItems}
          runs={commissionRuns}
          onLoadRun={fetchCommissionRun}
          onSaveRun={saveCommissionRun}
          onRefresh={loadCloudData}
        />
      )}
      {currentPage === 'logistics' && (
        profile.role === 'logistics' && profile.logisticsProviderType === 'haichuan' ? (
          <HaichuanWorkflowPage
            profile={profile}
            profiles={profiles}
            data={haichuanData}
            onRefresh={async () => setHaichuanData(await fetchHaichuanData())}
            onConfirmReceipt={confirmHaichuanReceipt}
            onSubmitBatch={submitHaichuanLoadingBatch}
            onReviewBatch={reviewHaichuanLoadingBatch}
            onUpdateWarehouseQuantity={updateHaichuanWarehouseQuantity}
            onDeleteWarehouseLot={deleteHaichuanWarehouseLot}
            onSaveProfile={saveProfileBinding}
          />
        ) : <LogisticsLoadingPage
          profile={profile}
          profiles={profiles}
          records={purchaseRecords}
          skuItems={skuItems}
          batches={logisticsBatches}
          onSaveBatch={persistLogisticsBatch}
          onSubmitBatch={persistLogisticsSubmit}
          onApproveBatch={approveLogisticsBatch}
          onRejectBatch={rejectLogisticsBatch}
          onClearLogistics={clearLogisticsData}
        />
      )}
      {currentPage === 'haichuan-warehouse' && (profile.role === 'admin' || profile.role === 'owner') && (
        <HaichuanWorkflowPage
          profile={profile}
          profiles={profiles}
          data={haichuanData}
          onRefresh={async () => {
            setHaichuanData(await fetchHaichuanData());
            const refreshedProfiles = await fetchProfiles();
            setProfiles(refreshedProfiles);
          }}
          onConfirmReceipt={confirmHaichuanReceipt}
          onSubmitBatch={submitHaichuanLoadingBatch}
          onReviewBatch={async (input) => {
            await reviewHaichuanLoadingBatch(input);
            await loadCloudData(profile);
          }}
          onUpdateWarehouseQuantity={async (lotId, newTotal) => {
            await updateHaichuanWarehouseQuantity(lotId, newTotal);
            await loadCloudData(profile);
          }}
          onDeleteWarehouseLot={async (lotId) => {
            await deleteHaichuanWarehouseLot(lotId);
            await loadCloudData(profile);
          }}
          onSaveProfile={saveProfileBinding}
        />
      )}
      </>}
      </div>
    </main>
  );
}

export default App;

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
import type { AppProfile, PurchaseRecord, PurchaseRow, RepricingAlert, SalesSuggestionRow, SkuItem } from './types';
import {
  fetchContainerRows,
  fetchProfile,
  fetchProfiles,
  fetchPurchaseRecords,
  fetchRepricingAlerts,
  fetchSalesSuggestions,
  fetchSkuItems,
  fetchSkuItemsForImport,
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
  return (index === 3 || index === 4 || index === 5) && /failed to fetch|fetch/i.test(formatErrorMessage(error));
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
    if (results[3].status === 'fulfilled') {
      setProfiles(results[3].value);
    } else if (profile) {
      setProfiles((current) => (current.some((item) => item.id === profile.id) ? current : [...current, profile]));
    }
    if (results[4].status === 'fulfilled') setSavedSalesSuggestions(results[4].value);
    if (results[5].status === 'fulfilled') setRepricingAlerts(results[5].value);

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

  function normalizePurchaseRecords(records: PurchaseRecord[]): { records: PurchaseRecord[] } {
    return { records: records.map((record) => withPurchaseTotals(record)) };
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
        <SkuManager
          items={skuItems}
          onChange={persistSkuItems}
          loadImportMatches={fetchSkuItemsForImport}
          onCloudRefresh={loadCloudData}
          canEditData={editable}
          canDeleteData={deletable}
        />
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

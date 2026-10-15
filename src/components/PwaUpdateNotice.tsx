import { useRegisterSW } from 'virtual:pwa-register/react';

export function PwaUpdateNotice() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh) return null;

  return (
    <aside className="pwa-update-notice" role="status" aria-live="polite">
      <p>系统已有新版本。请完成当前操作后刷新，以使用最新界面。</p>
      <div className="pwa-update-actions">
        <button type="button" onClick={() => setNeedRefresh(false)}>稍后</button>
        <button className="primary" type="button" onClick={() => void updateServiceWorker(true)}>立即刷新</button>
      </div>
    </aside>
  );
}

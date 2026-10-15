import { useEffect, useMemo, useState } from 'react';
import type { UserRole } from '../types';

type MobileNavItem<PageKey extends string> = {
  key: PageKey;
  label: string;
};

type MobileBottomNavProps<PageKey extends string> = {
  role: UserRole;
  currentPage: PageKey;
  items: Array<MobileNavItem<PageKey>>;
  onSelect: (page: PageKey) => void;
};

const preferredKeysByRole: Record<UserRole, string[]> = {
  owner: ['my-orders', 'repricing', 'purchase-pool'],
  admin: ['my-orders', 'repricing', 'purchase-pool'],
  buyer: ['my-orders', 'suggestions', 'calculator'],
  viewer: ['suggestions', 'repricing', 'inventory'],
  logistics: ['logistics'],
};

function compactLabel(label: string): string {
  const aliases: Record<string, string> = {
    我的采购订单: '我的任务',
    月销量采购建议: '采购建议',
    物流装柜确认: '物流任务',
  };
  return aliases[label] ?? label;
}

export function MobileBottomNav<PageKey extends string>({ role, currentPage, items, onSelect }: MobileBottomNavProps<PageKey>) {
  const [moreOpen, setMoreOpen] = useState(false);
  const primaryItems = useMemo(() => {
    const itemByKey = new Map(items.map((item) => [item.key, item]));
    return preferredKeysByRole[role].flatMap((key) => {
      const item = itemByKey.get(key as PageKey);
      return item ? [item] : [];
    });
  }, [items, role]);
  const hasMore = items.some((item) => !primaryItems.some((primary) => primary.key === item.key));
  const moreActive = !primaryItems.some((item) => item.key === currentPage);

  useEffect(() => {
    setMoreOpen(false);
  }, [currentPage]);

  function selectPage(page: PageKey) {
    setMoreOpen(false);
    onSelect(page);
  }

  return (
    <>
      {moreOpen && (
        <div className="mobile-more-menu" role="dialog" aria-modal="true" aria-label="全部功能">
          <button className="mobile-more-backdrop" type="button" aria-label="关闭全部功能" onClick={() => setMoreOpen(false)} />
          <section className="mobile-more-sheet">
            <div className="mobile-more-heading">
              <strong>全部功能</strong>
              <button type="button" onClick={() => setMoreOpen(false)}>关闭</button>
            </div>
            <div className="mobile-more-grid">
              {items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={item.key === currentPage ? 'active' : ''}
                  onClick={() => selectPage(item.key)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
      <nav className="mobile-bottom-nav" aria-label="手机主导航">
        {primaryItems.map((item) => (
          <button
            key={item.key}
            type="button"
            className={item.key === currentPage ? 'active' : ''}
            onClick={() => selectPage(item.key)}
          >
            {compactLabel(item.label)}
          </button>
        ))}
        {hasMore && (
          <button type="button" className={moreOpen || moreActive ? 'active' : ''} onClick={() => setMoreOpen((open) => !open)}>
            全部功能
          </button>
        )}
      </nav>
    </>
  );
}

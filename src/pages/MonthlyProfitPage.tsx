import { MonthlyProfitSection } from '../components/MonthlyProfitSection';
import type { AppProfile, MonthlyProfitSummary, SkuItem } from '../types';

type Props = {
  skuItems: SkuItem[];
  profile: AppProfile;
  summaries: MonthlyProfitSummary[];
  onSave: (summary: MonthlyProfitSummary) => Promise<void>;
  onRefresh: () => Promise<void>;
};

const STORES = ['Bestby', 'Arfast', 'Aicom', 'MegaValue', 'KeepFit', 'Lifon', 'PatPaw'];

export function MonthlyProfitPage({ skuItems, profile, summaries, onSave, onRefresh }: Props) {
  return <section className="panel profit-analysis-page"><MonthlyProfitSection profile={profile} skuItems={skuItems} stores={STORES} summaries={summaries} onSave={onSave} onRefresh={onRefresh} /></section>;
}

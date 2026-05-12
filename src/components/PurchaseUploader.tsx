import type { ChangeEvent } from 'react';
import { parsePurchaseFile } from '../utils/fileParsers';
import type { PurchaseRow } from '../types';

type Props = {
  onLoaded: (rows: PurchaseRow[], fileName: string) => void;
};

export function PurchaseUploader({ onLoaded }: Props) {
  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const rows = await parsePurchaseFile(file);
    onLoaded(rows, file.name);
    event.target.value = '';
  }

  return (
    <section className="panel upload-panel">
      <div>
        <h2>采购报表上传</h2>
        <p>支持 Excel 或 CSV，上传后自动按 SKU 分配厂家、店铺和采购人。</p>
      </div>
      <label className="file-button">
        上传采购报表
        <input type="file" accept=".xlsx,.xls,.csv" onChange={handleFileChange} />
      </label>
    </section>
  );
}

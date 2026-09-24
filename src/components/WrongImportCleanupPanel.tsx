import { useMemo, useState } from 'react';
import type { AppProfile, PurchaseRecord, PurchaseRecordImport } from '../types';
import { parsePurchaseRecordsFile } from '../utils/fileParsers';
import { downloadWrongImportBackup, previewWrongImportCleanup, WRONG_IMPORT_WINDOW } from '../utils/wrongImportCleanup';

type Props = {
  profile: AppProfile;
  records: PurchaseRecord[];
  onDeleteRecords: (ids: string[]) => void | Promise<void>;
};

export function WrongImportCleanupPanel({ profile, records, onDeleteRecords }: Props) {
  const [imports, setImports] = useState<PurchaseRecordImport[]>([]);
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [backupReady, setBackupReady] = useState(false);
  const preview = useMemo(() => previewWrongImportCleanup(records, imports), [records, imports]);
  const localTime = (value: string) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '无';

  async function loadFiles(files: FileList | null) {
    if (!files?.length) return;
    setLoading(true);
    setMessage('');
    setBackupReady(false);
    try {
      const selected = Array.from(files);
      const parsed = (await Promise.all(selected.map((file) => parsePurchaseRecordsFile(file, profile)))).flat();
      setImports(parsed);
      setFileNames(selected.map((file) => file.name));
      setMessage(`已读取 ${parsed.length} 条 Excel 原始数据，请核对候选数量。`);
    } catch (error) {
      setImports([]);
      setFileNames([]);
      setMessage(error instanceof Error ? error.message : '读取错误导入文件失败。');
    } finally {
      setLoading(false);
    }
  }

  function createBackup() {
    downloadWrongImportBackup(preview);
    setBackupReady(true);
    setMessage('备份已下载。请核对数量，确认后再执行删除。');
  }

  async function deleteCandidates() {
    if (!backupReady || preview.createdCandidates.length === 0) return;
    const confirmed = window.confirm(
      `将永久删除 ${preview.createdCandidates.length} 条与两份错误 Excel 完整字段匹配，且创建于 ${WRONG_IMPORT_WINDOW.label} 的云端采购记录。\n\n确认继续吗？`,
    );
    if (!confirmed) return;
    setLoading(true);
    setMessage('正在删除，请勿关闭页面……');
    try {
      await onDeleteRecords(preview.createdCandidates.map((record) => record.id));
      setImports([]);
      setFileNames([]);
      setBackupReady(false);
      setMessage(`清理完成：已删除 ${preview.createdCandidates.length} 条新建记录。旧记录受影响候选未删除。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '删除失败，请根据备份检查云端记录。');
    } finally {
      setLoading(false);
    }
  }

  return (
    <details className="cleanup-panel" open>
      <summary>管理员：清理 9 月 23 日错误导入</summary>
      <div className="cleanup-panel-body">
        <p>读取两份错误 Excel，并删除完整业务字段匹配且创建于 {WRONG_IMPORT_WINDOW.label} 的数据库记录。</p>
        <label className="cleanup-file-picker">
          选择 `111.xlsx` 和 `111 - 副本.xlsx`
          <input type="file" accept=".xlsx,.xls,.csv" multiple onChange={(event) => void loadFiles(event.target.files)} disabled={loading} />
        </label>
        {fileNames.length > 0 && <p>已选文件：{fileNames.join('、')}</p>}
        {imports.length > 0 && <div className="cleanup-metrics">
          <span>Excel 原始行：<strong>{preview.importedRowCount}</strong></span>
          <span>业务字段匹配记录：<strong>{preview.matchingRecordCount}</strong></span>
          <span>待删除匹配记录：<strong>{preview.createdCandidates.length}</strong></span>
          <span>未匹配原始行：<strong>{preview.unmatchedImportedRows}</strong></span>
        </div>}
        {imports.length > 0 && <p>
          匹配记录原创建时间范围（仅供核对）：{localTime(preview.earliestMatchingCreatedAt)} ～ {localTime(preview.latestMatchingCreatedAt)}；
          缺少创建时间：{preview.matchingRecordsWithoutCreatedAt} 条。
        </p>}
        {imports.length > 0 && <p>
          最近创建小时分布：{preview.matchingCreatedHourCounts.slice(0, 12).map((item) => `${item.hour}：${item.count} 条`).join('；') || '无'}
        </p>}
        {message && <p className="cleanup-message">{message}</p>}
        <div className="cleanup-actions">
          <button type="button" onClick={createBackup} disabled={loading || preview.createdCandidates.length === 0}>下载备份并准备删除</button>
          <button type="button" className="danger" onClick={() => void deleteCandidates()} disabled={loading || !backupReady || preview.createdCandidates.length === 0}>
            删除 {preview.createdCandidates.length} 条错误导入记录
          </button>
        </div>
      </div>
    </details>
  );
}

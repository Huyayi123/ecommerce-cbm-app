import { useEffect, useRef, useState } from 'react';
import { normalizeBarcodeSku } from '../utils/barcodeMatching';
import { startBarcodeScanner, type BarcodeScannerSession, type BarcodeScannerStatus } from '../utils/barcodeScanner';

type Props = {
  value: string;
  matchCount: number;
  targetLabel: string;
  onScan: (sku: string) => void;
  onClear: () => void;
  embeddedCamera?: boolean;
  onCameraOpenChange?: (open: boolean) => void;
};

export function BarcodeScanControl({ value, matchCount, targetLabel, onScan, onClear, embeddedCamera = false, onCameraOpenChange }: Props) {
  const [input, setInput] = useState(value);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [scanHint, setScanHint] = useState('');
  const [scannerStatus, setScannerStatus] = useState<BarcodeScannerStatus | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<BarcodeScannerSession | null>(null);

  useEffect(() => setInput(value), [value]);

  useEffect(() => {
    onCameraOpenChange?.(cameraOpen);
  }, [cameraOpen, onCameraOpenChange]);

  useEffect(() => () => onCameraOpenChange?.(false), [onCameraOpenChange]);

  useEffect(() => {
    if (!cameraOpen || !videoRef.current) return;
    let cancelled = false;
    setCameraError('');
    setScannerStatus(null);
    setScanHint('正在识别，请将完整条形码放入取景框。');
    const hintTimer = window.setTimeout(() => {
      if (!cancelled) setScanHint('尚未识别：请将黑色条纹竖直放置，稍微拉远，并保留条码两侧空白。');
    }, 6000);
    void startBarcodeScanner(videoRef.current, (result) => {
      if (cancelled) return;
      const scanned = normalizeBarcodeSku(result);
      if (!scanned) return;
      window.clearTimeout(hintTimer);
      scannerRef.current?.stop();
      scannerRef.current = null;
      setScanHint('识别成功，正在定位记录。');
      setInput(scanned);
      setCameraOpen(false);
      onScan(scanned);
    }, setScannerStatus).then((session) => {
      if (cancelled) session.stop();
      else scannerRef.current = session;
    }).catch(() => {
      if (!cancelled) {
        setCameraError('无法打开摄像头，请检查浏览器权限或改用扫码枪/手工输入。');
        setCameraOpen(false);
      }
    });

    return () => {
      cancelled = true;
      window.clearTimeout(hintTimer);
      scannerRef.current?.stop();
      scannerRef.current = null;
    };
  }, [cameraOpen, onScan]);

  function submit() {
    const normalized = normalizeBarcodeSku(input);
    if (!normalized) {
      setCameraError('请输入或扫描 SKU。');
      return;
    }
    setCameraError('');
    setInput(normalized);
    onScan(normalized);
  }

  function clear() {
    setInput('');
    setCameraError('');
    setScanHint('');
    onClear();
    if (embeddedCamera) setCameraOpen(true);
  }

  const cameraContent = <div className={embeddedCamera ? 'barcode-camera-embedded' : 'barcode-camera-modal'}>
    <div className="barcode-camera-heading"><h3 id="barcode-camera-title">扫描商品条形码</h3><button type="button" onClick={() => setCameraOpen(false)}>关闭</button></div>
    <video ref={videoRef} className="barcode-camera-video" muted playsInline />
    <p aria-live="polite">{scanHint || '将条形码完整放入取景框。识别成功后会自动定位记录。'}</p>
    {scannerStatus && <p className="barcode-scanner-status">识别方式：{scannerStatus.engine === 'native+wasm' ? '手机原生 + 增强识别' : '增强识别'} · 相机 {scannerStatus.width}×{scannerStatus.height}</p>}
  </div>;

  return <>
    <div className={`barcode-scan-panel${embeddedCamera ? ' barcode-scan-workbench-control' : ''}${cameraOpen ? ' camera-open' : ''}`}>
      <div className="barcode-scan-heading">
        <div><strong>扫描条形码定位{targetLabel}</strong><span>条形码内容为 SKU；扫描仅定位记录，不会自动提交。</span></div>
      </div>
      {embeddedCamera && cameraOpen && cameraContent}
      <div className="barcode-scan-controls">
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit(); } }}
          placeholder="扫码枪扫描或手工输入 SKU"
          autoComplete="off"
          inputMode="text"
          aria-label="条形码 SKU"
        />
        <button type="button" className="primary" onClick={submit}>定位记录</button>
        <button type="button" onClick={() => { setCameraError(''); setCameraOpen(true); }}>打开摄像头</button>
        {value && <button type="button" onClick={clear}>{embeddedCamera ? '继续扫描' : '清除'}</button>}
      </div>
      {value && <div className={`barcode-scan-result ${matchCount > 0 ? 'success' : 'error'}`}>
        {matchCount > 0
          ? `SKU ${value}：找到 ${matchCount} 条${targetLabel}记录${matchCount > 1 ? '，请确认批次。' : '。'}`
          : `SKU ${value}：${targetLabel === '待入仓' ? '未找到待入仓记录。' : '仓库无可装柜库存。'}`}
      </div>}
      {cameraError && <div className="inline-error">{cameraError}</div>}
    </div>

    {cameraOpen && !embeddedCamera && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCameraOpen(false); }}>{cameraContent}</div>}
  </>;
}

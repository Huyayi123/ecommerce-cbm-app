import { useEffect, useRef, useState } from 'react';
import type { IScannerControls } from '@zxing/browser';
import { normalizeBarcodeSku } from '../utils/barcodeMatching';

type Props = {
  value: string;
  matchCount: number;
  targetLabel: string;
  onScan: (sku: string) => void;
  onClear: () => void;
};

export function BarcodeScanControl({ value, matchCount, targetLabel, onScan, onClear }: Props) {
  const [input, setInput] = useState(value);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);

  useEffect(() => setInput(value), [value]);

  useEffect(() => {
    if (!cameraOpen || !videoRef.current) return;
    let cancelled = false;
    void import('@zxing/browser').then(({ BrowserMultiFormatReader }) => {
      if (cancelled || !videoRef.current) return;
      const reader = new BrowserMultiFormatReader();
      return reader.decodeFromConstraints({ video: { facingMode: { ideal: 'environment' } }, audio: false }, videoRef.current, (result) => {
        if (!result || cancelled) return;
        const scanned = normalizeBarcodeSku(result.getText());
        if (!scanned) return;
        controlsRef.current?.stop();
        controlsRef.current = null;
        setInput(scanned);
        setCameraOpen(false);
        onScan(scanned);
      });
    }).then((controls) => {
      if (!controls) return;
      if (cancelled) controls.stop();
      else controlsRef.current = controls;
    }).catch(() => {
      if (!cancelled) {
        setCameraError('无法打开摄像头，请检查浏览器权限或改用扫码枪/手工输入。');
        setCameraOpen(false);
      }
    });

    return () => {
      cancelled = true;
      controlsRef.current?.stop();
      controlsRef.current = null;
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
    onClear();
  }

  return <>
    <div className="barcode-scan-panel">
      <div className="barcode-scan-heading">
        <div><strong>扫描条形码定位{targetLabel}</strong><span>条形码内容为 SKU；扫描仅定位记录，不会自动提交。</span></div>
      </div>
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
        {value && <button type="button" onClick={clear}>清除</button>}
      </div>
      {value && <div className={`barcode-scan-result ${matchCount > 0 ? 'success' : 'error'}`}>
        {matchCount > 0
          ? `SKU ${value}：找到 ${matchCount} 条${targetLabel}记录${matchCount > 1 ? '，请确认批次。' : '。'}`
          : `SKU ${value}：${targetLabel === '待入仓' ? '未找到待入仓记录。' : '仓库无可装柜库存。'}`}
      </div>}
      {cameraError && <div className="inline-error">{cameraError}</div>}
    </div>

    {cameraOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCameraOpen(false); }}>
      <div className="barcode-camera-modal" role="dialog" aria-modal="true" aria-labelledby="barcode-camera-title">
        <div className="barcode-camera-heading"><h3 id="barcode-camera-title">扫描商品条形码</h3><button type="button" onClick={() => setCameraOpen(false)}>关闭</button></div>
        <video ref={videoRef} className="barcode-camera-video" muted playsInline />
        <p>将条形码完整放入取景框。识别成功后会自动返回并定位记录。</p>
      </div>
    </div>}
  </>;
}

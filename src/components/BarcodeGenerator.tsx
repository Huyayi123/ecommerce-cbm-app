import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import writerWasmUrl from 'zxing-wasm/writer/zxing_writer.wasm?url';

const writerOptions = { overrides: { locateFile: () => writerWasmUrl } };

export function BarcodeGenerator() {
  const [input, setInput] = useState('');
  const [result, setResult] = useState<{ value: string; url: string }>();
  const [failedValue, setFailedValue] = useState<string>();
  const valid = /^[ -~]{1,64}$/.test(input) && input.trim().length > 0;
  const preview = valid && result?.value === input ? result.url : undefined;

  useEffect(() => {
    if (!valid) return;
    let active = true;
    let url: string | undefined;
    async function generate() {
      try {
        const writer = await import('zxing-wasm/writer');
        writer.prepareZXingModule(writerOptions);
        const { image } = await writer.writeBarcode(input, { format: 'Code128', scale: 5, addHRT: true, addQuietZones: true });
        if (!image) throw new Error('Barcode image unavailable');
        if (!active) return;
        url = URL.createObjectURL(image);
        setResult({ value: input, url });
        setFailedValue(undefined);
      } catch {
        if (active) setFailedValue(input);
      }
    }
    const timer = window.setTimeout(() => void generate(), 120);
    return () => {
      active = false;
      window.clearTimeout(timer);
      if (url) URL.revokeObjectURL(url);
    };
  }, [input, valid]);

  return <div className="launch-card launch-barcode-generator">
    <label>
      条形码内容
      <input value={input} onChange={(event) => { setResult(undefined); setFailedValue(undefined); setInput(event.target.value); }} placeholder="例如 new00001" maxLength={64} aria-describedby="launch-barcode-hint" />
    </label>
    <p id="launch-barcode-hint">Code 128 支持英文字母、数字和半角符号，最多 64 个字符。</p>
    {input && !valid && <p role="alert">请输入有效的半角字符。</p>}
    {valid && failedValue === input && <p role="alert">条形码生成失败，请重新输入后再试。</p>}
    {valid && !preview && failedValue !== input && <p role="status">正在生成条形码…</p>}
    {preview && <>
      <figure className="launch-barcode-preview"><img src={preview} alt={`Code 128 条形码 ${input}`} /></figure>
      <div className="launch-barcode-actions">
        <a href={preview} download={`barcode-${input.replace(/[^a-z0-9_-]/gi, '_')}.png`}>下载 PNG</a>
        <button type="button" onClick={() => window.print()}>打印</button>
      </div>
      {createPortal(<div className="launch-barcode-print"><img src={preview} alt={input} /></div>, document.body)}
    </>}
  </div>;
}

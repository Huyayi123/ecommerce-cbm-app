import type { ReaderOptions } from 'zxing-wasm/reader';
import zxingReaderWasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

export type BarcodeScannerStatus = {
  engine: 'native+wasm' | 'wasm';
  width: number;
  height: number;
};

export type BarcodeScannerSession = {
  stop: () => void;
};

type NativeBarcode = { rawValue: string };
type NativeBarcodeDetectorInstance = { detect: (source: CanvasImageSource) => Promise<NativeBarcode[]> };
type NativeBarcodeDetectorConstructor = {
  new (options?: { formats?: string[] }): NativeBarcodeDetectorInstance;
  getSupportedFormats?: () => Promise<string[]>;
};

const nativeFormats = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar'];
const wasmFormats = ['EAN13', 'EAN8', 'UPCA', 'UPCE', 'Code128', 'Code39', 'ITF', 'Codabar'] as const;
const locateWasmFile = () => zxingReaderWasmUrl;
let wasmPrepared = false;

function barcodeDetectorConstructor(): NativeBarcodeDetectorConstructor | undefined {
  return (globalThis as typeof globalThis & { BarcodeDetector?: NativeBarcodeDetectorConstructor }).BarcodeDetector;
}

export function centralScanRegion(width: number, height: number) {
  const cropWidth = Math.max(1, Math.round(width * 0.92));
  const cropHeight = Math.max(1, Math.round(height * 0.58));
  return {
    x: Math.round((width - cropWidth) / 2),
    y: Math.round((height - cropHeight) / 2),
    width: cropWidth,
    height: cropHeight,
  };
}

async function createNativeDetector(): Promise<NativeBarcodeDetectorInstance | null> {
  const BarcodeDetector = barcodeDetectorConstructor();
  if (!BarcodeDetector) return null;
  try {
    const supported = BarcodeDetector.getSupportedFormats
      ? await BarcodeDetector.getSupportedFormats()
      : nativeFormats;
    const formats = nativeFormats.filter((format) => supported.includes(format));
    return formats.length > 0 ? new BarcodeDetector({ formats }) : null;
  } catch {
    return null;
  }
}

async function applyContinuousFocus(track: MediaStreamTrack) {
  try {
    const capabilities = track.getCapabilities() as MediaTrackCapabilities & { focusMode?: string[] };
    if (!capabilities.focusMode?.includes('continuous')) return;
    await track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] });
  } catch {
    // Focus controls are optional and vary by browser/device.
  }
}

function drawVideoFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement) {
  const width = video.videoWidth;
  const height = video.videoHeight;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(video, 0, 0, width, height);
  return context;
}

function cropFrame(source: HTMLCanvasElement, region: ReturnType<typeof centralScanRegion>) {
  const canvas = document.createElement('canvas');
  canvas.width = region.width;
  canvas.height = region.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(source, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
  return context.getImageData(0, 0, region.width, region.height);
}

async function decodeWithWasm(fullFrame: ImageData, centralFrame: ImageData | null) {
  const { prepareZXingModule, readBarcodes } = await import('zxing-wasm/reader');
  if (!wasmPrepared) {
    prepareZXingModule({ overrides: { locateFile: locateWasmFile } });
    wasmPrepared = true;
  }
  const options: ReaderOptions = {
    formats: [...wasmFormats],
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
    tryDownscale: true,
    maxNumberOfSymbols: 1,
    minLineCount: 1,
  };
  for (const frame of centralFrame ? [centralFrame, fullFrame] : [fullFrame]) {
    const results = await readBarcodes(frame, options);
    const result = results.find((item) => item.isValid && item.text.trim());
    if (result) return result.text;
  }
  return '';
}

export async function startBarcodeScanner(
  video: HTMLVideoElement,
  onResult: (value: string) => void,
  onStatus: (status: BarcodeScannerStatus) => void,
): Promise<BarcodeScannerSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  });
  let stopped = false;
  let timer = 0;
  const track = stream.getVideoTracks()[0];
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  await applyContinuousFocus(track);

  const nativeDetector = await createNativeDetector();
  const settings = track.getSettings();
  onStatus({
    engine: nativeDetector ? 'native+wasm' : 'wasm',
    width: settings.width ?? video.videoWidth,
    height: settings.height ?? video.videoHeight,
  });

  const canvas = document.createElement('canvas');
  const scan = async () => {
    if (stopped) return;
    if (nativeDetector) {
      try {
        const results = await nativeDetector.detect(video);
        const value = results.find((item) => item.rawValue.trim())?.rawValue ?? '';
        if (value) {
          onResult(value);
          return;
        }
      } catch {
        // Native detection is an optimization; WASM remains available below.
      }
    }
    try {
      const context = drawVideoFrame(video, canvas);
      if (context && canvas.width > 0 && canvas.height > 0) {
        const fullFrame = context.getImageData(0, 0, canvas.width, canvas.height);
        const centralFrame = cropFrame(canvas, centralScanRegion(canvas.width, canvas.height));
        const value = await decodeWithWasm(fullFrame, centralFrame);
        if (value) {
          onResult(value);
          return;
        }
      }
    } catch {
      // A decoder miss/failure is non-fatal; keep the camera active for the next frame.
    }
    if (!stopped) timer = window.setTimeout(() => void scan(), 200);
  };
  void scan();

  return {
    stop() {
      stopped = true;
      window.clearTimeout(timer);
      stream.getTracks().forEach((item) => item.stop());
      if (video.srcObject === stream) video.srcObject = null;
    },
  };
}


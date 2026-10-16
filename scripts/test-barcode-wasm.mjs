import assert from 'node:assert/strict';
import { readBarcodes } from 'zxing-wasm/reader';
import { writeBarcode } from 'zxing-wasm/writer';

const barcodeValue = '9902452679609';

for (const rotate of [0, 90, 180, 270]) {
  const generated = await writeBarcode(barcodeValue, {
    format: 'EAN13',
    scale: 4,
    rotate,
    addQuietZones: true,
  });
  const results = await readBarcodes(generated.image, {
    formats: ['EAN13'],
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
    minLineCount: 1,
  });
  assert.equal(results[0]?.text, barcodeValue, `failed to decode EAN-13 at ${rotate} degrees`);
}

console.log('WASM barcode rotation tests passed');

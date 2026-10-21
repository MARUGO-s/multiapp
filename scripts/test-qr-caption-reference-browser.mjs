import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';
const output = process.env.QR_LOGO_EVIDENCE || path.join(tmpdir(), 'qr-caption-reference');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const expected = 'https://marugo-s.github.io/multiapp/?s=q#AbCd1234EfGh';
const rows = [];
try {
  const context = await browser.newContext();
  const unexpected = [];
  await context.route('**/*', route => {
    const host = new URL(route.request().url()).hostname;
    if (['127.0.0.1', 'localhost'].includes(host)) return route.continue();
    if (host === 'fonts.googleapis.com') return route.fulfill({ contentType: 'text/css', body: '' });
    unexpected.push(host); return route.abort();
  });
  const page = await context.newPage();
  await page.goto(process.env.QR_LOGO_PREVIEW || 'http://127.0.0.1:5197/__qr_logo_preview');
  for (const id of ['store-marugo-marunouchi', 'store-marugo-es']) {
    const result = await page.evaluate(async ({ id, expected }) => {
      const { qrImageWithStoreNameDataUrl } = await import('/src/qr-caption.mjs');
      const { qrImageDataUrl } = await import('/src/qr-image.mjs');
      const lines = [];
      const draw = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function(value,x,y,...rest) {
        const m = this.measureText(value);
        if (this.canvas.height > 640) lines.push({value,x,y,font:this.font,width:m.width,left:x-m.actualBoundingBoxLeft,right:x+m.actualBoundingBoxRight,top:y-m.actualBoundingBoxAscent});
        return draw.call(this,value,x,y,...rest);
      };
      let dataUrl, original;
      try { original=await qrImageDataUrl(expected,id,'/'); dataUrl=await qrImageWithStoreNameDataUrl(expected,id,'/'); }
      finally { CanvasRenderingContext2D.prototype.fillText=draw; }
      const c=document.createElement('canvas').getContext('2d'); c.textAlign='center'; c.textBaseline='middle';
      const selectedFont=lines[0].font, size=Number(selectedFont.match(/(\d+)px/)[1]);
      c.font=selectedFont.replace(/\d+px/,`${size+1}px`);
      const next=c.measureText('MARUGO Marunouchi');
      return {id,dataUrl,original,lines,size,nextWidth:Math.max(next.width,2*next.actualBoundingBoxLeft+2,2*next.actualBoundingBoxRight+2)};
    }, {id,expected});
    assert.equal(result.lines.length, 1, `${id}: a catalog name fits one line`);
    assert.ok(result.size > 40, 'reference-fit caption is larger than the previous 40px');
    assert.ok(result.nextWidth > 576, 'one pixel larger must exceed the reference-name bounds');
    for (const line of result.lines) {
      assert.ok(line.left >= 32 && line.right <= 608 && line.top >= 640 && line.top <= 642);
    }
    const bytes=Buffer.from(result.dataUrl.split(',')[1],'base64');
    const png=PNG.sync.read(bytes), original=PNG.sync.read(Buffer.from(result.original.split(',')[1],'base64'));
    assert.ok(png.data.subarray(0,original.data.length).equals(original.data));
    assert.equal(jsQR(new Uint8ClampedArray(png.data),png.width,png.height,{inversionAttempts:'dontInvert'})?.data,expected);
    await writeFile(path.join(output,`${id}-reference-max.png`),bytes);
    const {dataUrl,original:discard,...summary}=result;
    rows.push({...summary,width:png.width,height:png.height,originalPixelsEqual:true,exactDecode:true});
  }
  assert.equal(rows[0].size,rows[1].size,'both store labels share the reference size');
  assert.deepEqual(unexpected,[]);
} finally { await browser.close(); }
await writeFile(path.join(output,'reference-size-results.json'),JSON.stringify({count:rows.length,rows},null,2)+'\n');
console.log(JSON.stringify({count:rows.length,rows},null,2));

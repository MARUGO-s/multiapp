import test from "node:test";
import assert from "node:assert/strict";
import { createRequire, Module, registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import QRCode from "qrcode";
import ECLevel from "qrcode/lib/core/error-correction-level.js";
import ECCode from "qrcode/lib/core/error-correction-code.js";
import QRUtils from "qrcode/lib/core/utils.js";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { QR_LOGOS } from "../supabase/functions/_shared/qr-logos.mjs";

function syntheticLogo(width, height, color = [190, 25, 70, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(color, i);
  return { width, height, data, layout: "store" };
}

function resize(image, size) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const source =
        (Math.floor((y * image.height) / size) * image.width +
          Math.floor((x * image.width) / size)) *
        4;
      data.set(image.data.subarray(source, source + 4), (y * size + x) * 4);
    }
  return data;
}

const renderer = await import("../src/qr-image.mjs");
const require = createRequire(import.meta.url);
const tracking = "https://marugo-s.github.io/multiapp/?s=q#AbCd1234EfGh";

// Execute the installed generator's actual private functions in a test-only
// module. Do not modify node_modules or substitute a copied capacity table.
function installedGeneratorProbe() {
  const filename = require.resolve("qrcode/lib/core/qrcode.js");
  const probe = new Module(filename);
  probe.filename = filename;
  probe.paths = Module._nodeModulePaths(
    new URL("../node_modules/qrcode/lib/core/", import.meta.url).pathname,
  );
  const blocks = [];
  const RealEncoder = require("qrcode/lib/core/reed-solomon-encoder.js");
  const localRequire = createRequire(filename);
  probe.require = (id) =>
    id === "./reed-solomon-encoder"
      ? class extends RealEncoder {
          encode(input) {
            const ecc = super.encode(input);
            blocks.push({ input: Array.from(input), ecc: Array.from(ecc) });
            return ecc;
          }
        }
      : localRequire(id);
  let source = readFileSync(filename, "utf8");
  for (const statement of [
    "data[index++] = dcData[r][i]",
    "data[index++] = ecData[r][i]",
  ]) {
    assert.equal(
      source.split(statement).length,
      2,
      "installed interleave assignment must be uniquely traceable",
    );
    source = source.replace(
      statement,
      `interleavingTrace.push(r); ${statement}`,
    );
  }
  probe._compile(
    "const interleavingTrace = [];\n" +
      source +
      "\nexports.probe = { setupData, createCodewords, interleavingTrace };",
    filename,
  );
  return { ...probe.exports.probe, blocks };
}

// Browser I/O boundary only: real catalog PNG bytes, real pure renderer and
// actual PNG encoding/decoding. No DOM/browser executable is needed in CI.
function installCanvasIO(t, catalog) {
  const originals = Object.fromEntries(
    ["Image", "ImageData", "document"].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  const sources = [];
  globalThis.Image = class {
    set src(value) {
      sources.push(value);
      const item = catalog.find(
        (entry) => value === `/local/qr-logos/${entry.file}`,
      );
      assert.ok(item, "the adapter may only load an exact catalog PNG path");
      this.pixels = PNG.sync.read(
        readFileSync(
          new URL(`../public/qr-logos/${item.file}`, import.meta.url),
        ),
      );
      this.naturalWidth = this.pixels.width;
      this.naturalHeight = this.pixels.height;
      queueMicrotask(() => this.onload());
    }
  };
  globalThis.ImageData = class {
    constructor(data, width, height) {
      Object.assign(this, { data, width, height });
    }
  };
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "canvas");
      let input;
      let output;
      return {
        getContext(kind) {
          assert.equal(kind, "2d");
          return {
            drawImage(image) {
              input = image.pixels;
            },
            getImageData() {
              return { data: new Uint8ClampedArray(input.data) };
            },
            putImageData(image) {
              output = image;
            },
          };
        },
        toDataURL(type) {
          assert.equal(type, "image/png");
          return `data:image/png;base64,${PNG.sync.write(output).toString("base64")}`;
        },
      };
    },
  };
  t.after(() => {
    for (const [name, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  return sources;
}

function catalogRaster(item) {
  const pixels = PNG.sync.read(
    readFileSync(new URL(`../public/qr-logos/${item.file}`, import.meta.url)),
  );
  return {
    width: pixels.width,
    height: pixels.height,
    data: pixels.data,
    background: item.background,
  };
}

test("browser adapter derives store layout only from immutable catalog kind and leaves SNS on legacy pixels", async (t) => {
  // The metadata-only fixture exercises integration before store PNG/catalog
  // generation finishes; it never writes the catalog or replaces rendering.
  const fixture = QR_LOGOS.filter((item) => item.kind !== "store")
    .slice(0, 2)
    .map((item, i) => ({ ...item, kind: i === 0 ? "store" : "sns" }));
  const fixtureURL =
    "data:text/javascript," +
    encodeURIComponent(
      `const items=Object.freeze(${JSON.stringify(fixture)}.map(Object.freeze)); export function findQrLogo(id){ const value=items.find(item=>item.id===id); if(!value) throw new Error('INVALID_LOGO'); return value; }`,
    );
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        specifier === "../supabase/functions/_shared/qr-logos.mjs" &&
        context.parentURL?.includes("catalog-kind-fixture")
      )
        return { url: fixtureURL, shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
  let adapter;
  try {
    adapter = await import("../src/qr-image.mjs?catalog-kind-fixture");
  } finally {
    hook.deregister();
  }
  const sources = installCanvasIO(t, fixture);
  for (const item of fixture) {
    const actual = await adapter.qrImageDataUrl(tracking, item.id, "/local/", {
      layout: item.kind === "sns" ? "store" : "invalid",
      width: 9999,
    });
    const png = PNG.sync.read(Buffer.from(actual.split(",")[1], "base64"));
    const expected = renderer.createQrRaster(tracking, {
      ...catalogRaster(item),
      ...(item.kind === "store" ? { layout: "store" } : {}),
    });
    assert.equal(
      createHash("sha256").update(png.data).digest("hex"),
      createHash("sha256").update(expected.data).digest("hex"),
      `${item.kind} catalog pixels must select the intended layout`,
    );
    assert.equal(
      jsQR(new Uint8ClampedArray(png.data), png.width, png.height, {
        inversionAttempts: "dontInvert",
      })?.data,
      tracking,
    );
  }
  assert.deepEqual(
    sources,
    fixture.map((item) => `/local/qr-logos/${item.file}`),
  );
});

test("module and RS-block maps match installed qrcode setupData and real interleaving for all versions/levels", () => {
  assert.equal(
    typeof renderer.createQrCodewordMap,
    "function",
    "store placement needs an audited codeword map",
  );
  const probe = installedGeneratorProbe();
  for (let version = 1; version <= 40; version++) {
    for (const level of ["L", "M", "Q", "H"]) {
      const symbol = QRCode.create("A", {
        version,
        errorCorrectionLevel: level,
        maskPattern: 0,
      });
      const map = renderer.createQrCodewordMap(symbol);
      const total = QRUtils.getSymbolTotalCodewords(version);
      assert.equal(map.totalCodewords, total);
      assert.equal(map.moduleToCodeword.length, symbol.modules.size ** 2);
      let lastRead = -1;
      const bytes = new Proxy(
        { length: total },
        {
          get(target, key) {
            if (key === "length") return total;
            lastRead = Number(key);
            return 0;
          },
        },
      );
      const touched = new Set();
      probe.setupData(
        {
          size: symbol.modules.size,
          isReserved: (row, col) => symbol.modules.isReserved(row, col),
          set(row, col) {
            const index = row * symbol.modules.size + col;
            assert.equal(
              map.moduleToCodeword[index],
              lastRead,
              `v${version}/${level} at ${row},${col}`,
            );
            touched.add(index);
            lastRead = -1;
          },
        },
        bytes,
      );
      for (let index = 0; index < map.moduleToCodeword.length; index++) {
        if (!touched.has(index)) assert.equal(map.moduleToCodeword[index], -1);
      }
      const counts = new Uint8Array(total);
      for (const codeword of map.moduleToCodeword)
        if (codeword >= 0) counts[codeword]++;
      assert.ok(
        counts.every((count) => count === 8),
        `all codewords have eight bits: v${version}/${level}`,
      );

      const eccTotal = ECCode.getTotalCodewordsCount(version, ECLevel[level]);
      for (let seed = 0; seed < 2; seed++) {
        probe.blocks.length = 0;
        probe.interleavingTrace.length = 0;
        const buffer = Array.from(
          { length: total - eccTotal },
          (_, i) => (i * 73 + seed * 97 + (i >> 3)) & 255,
        );
        const actual = probe.createCodewords(
          { buffer },
          version,
          ECLevel[level],
        );
        assert.equal(map.blocks.length, probe.blocks.length);
        assert.deepEqual(
          Array.from(map.codewordToBlock),
          probe.interleavingTrace,
          `exact installed assignment provenance v${version}/${level}`,
        );
        assert.equal(map.codewordToBlock.length, actual.length);
        const cursors = new Uint16Array(map.blocks.length);
        for (let i = 0; i < actual.length; i++) {
          const blockIndex = map.codewordToBlock[i];
          const block = probe.blocks[blockIndex];
          const localIndex = cursors[blockIndex]++;
          const expected =
            localIndex < block.input.length
              ? block.input[localIndex]
              : block.ecc[localIndex - block.input.length];
          assert.equal(
            actual[i],
            expected,
            `real interleave v${version}/${level}, codeword ${i}, seed ${seed}`,
          );
        }
        for (let b = 0; b < map.blocks.length; b++) {
          assert.equal(
            map.blocks[b].dataCodewords,
            probe.blocks[b].input.length,
          );
          assert.equal(map.blocks[b].eccCodewords, probe.blocks[b].ecc.length);
          assert.equal(
            map.blocks[b].correctionCapacity,
            Math.floor(probe.blocks[b].ecc.length / 2),
          );
          assert.equal(
            map.blocks[b].logoBudget,
            Math.floor(map.blocks[b].correctionCapacity / 2),
          );
        }
      }
    }
  }
});

function candidateEligibility(symbol, map, bounds) {
  const { row, col, width, height } = bounds;
  if (
    Math.min(
      row,
      col,
      symbol.modules.size - row - height,
      symbol.modules.size - col - width,
    ) < 4
  )
    return "structure";
  const touched = map.blocks.map(() => new Set());
  for (let y = row; y < row + height; y++)
    for (let x = col; x < col + width; x++) {
      if (symbol.modules.isReserved(y, x)) return "structure";
      const cw = map.moduleToCodeword[y * symbol.modules.size + x];
      if (cw >= 0) touched[map.codewordToBlock[cw]].add(cw);
    }
  if (touched.some((set, b) => set.size > map.blocks[b].logoBudget))
    return "budget";
  return referenceLocatorConflicts(symbol, bounds).length ? "locator" : null;
}

// Independent scanline reference: build all five-run windows on each axis,
// then intersect them. The product walks outward from a scanline candidate.
// The L1 tolerances describe finder recognition, not a logo size/aspect cap.
const referenceLocatorControls = new WeakMap();
function referenceLocatorCenters(symbol, bounds = null) {
  const n = symbol.modules.size;
  const matrix = Array.from({ length: n }, (_, row) =>
    Array.from({ length: n }, (_, col) =>
      bounds &&
      row >= bounds.row &&
      row < bounds.row + bounds.height &&
      col >= bounds.col &&
      col < bounds.col + bounds.width
        ? 0
        : Number(Boolean(symbol.modules.get(row, col))),
    ),
  );
  function windows(line) {
    const runs = [];
    for (let start = 0; start < line.length;) {
      let end = start + 1;
      while (end < line.length && line[end] === line[start]) end++;
      runs.push({ start, end, ink: line[start] });
      start = end;
    }
    const matches = [];
    for (let i = 0; i + 4 < runs.length; i++) {
      if (!runs[i].ink) continue;
      const group = runs.slice(i, i + 5);
      const lengths = group.map((run) => run.end - run.start);
      const total = lengths.reduce((sum, value) => sum + value, 0);
      matches.push({
        center: (group[0].start + group[4].end) / 2,
        middle: group[2],
        lengths,
        weight: lengths.reduce(
          (sum, value, j) =>
            sum + Math.abs(value / total - [1, 1, 3, 1, 1][j] / 7),
          0,
        ),
      });
    }
    return matches;
  }
  const centers = new Map();
  for (const transpose of [false, true]) {
    const rows = transpose
      ? Array.from({ length: n }, (_, y) => matrix.map((row) => row[y]))
      : matrix;
    const horizontal = rows.map(windows);
    const vertical = Array.from({ length: n }, (_, x) =>
      windows(rows.map((row) => row[x])),
    );
    for (let y = 0; y < n; y++) {
      for (const scan of horizontal[y]) {
        if (scan.weight >= 0.2) continue;
        const x = Math.floor(scan.center);
        for (const cross of vertical[x] || []) {
          if (
            cross.weight >= 0.1 ||
            y < cross.middle.start ||
            y >= cross.middle.end
          )
            continue;
          const cy = (cross.middle.start + cross.middle.end) / 2;
          const point = transpose ? [cy, scan.center] : [scan.center, cy];
          centers.set(point.map((value) => 2 * value).join(":"), {
            point,
            scanRuns: scan.lengths,
            crossRuns: cross.lengths,
          });
        }
      }
    }
  }
  return centers;
}
function referenceLocatorConflicts(symbol, bounds) {
  if (!referenceLocatorControls.has(symbol))
    referenceLocatorControls.set(symbol, referenceLocatorCenters(symbol));
  const original = referenceLocatorControls.get(symbol);
  return [...referenceLocatorCenters(symbol, bounds)]
    .filter(([key]) => !original.has(key))
    .map(([, point]) => point);
}

test("store white badge does not introduce an extra finder-like run-length cross", () => {
  const item = QR_LOGOS.find((entry) => entry.id === "store-marugo-2");
  const symbol = QRCode.create(tracking, {
    errorCorrectionLevel: "H",
    maskPattern: 2,
  });
  const knownUnsafe = { row: 18, col: 11, width: 19, height: 5 };
  assert.deepEqual(
    referenceLocatorConflicts(symbol, knownUnsafe),
    [
      {
        point: [28, 26.5],
        scanRuns: [1, 1, 2, 1, 1],
        crossRuns: [1, 1, 3, 1, 1],
      },
    ],
    "clearing row 22 / column 28 truncates an outer run into a false finder cross",
  );
  const image = renderer.createQrRaster(
    tracking,
    { ...catalogRaster(item), layout: "store" },
    { maskPattern: 2 },
  );
  assert.deepEqual(
    referenceLocatorConflicts(symbol, image.logoBounds),
    [],
    "a successful jsQR decode alone must not admit the detector-confusing white footprint",
  );
});

// Independent reference compositing for counterfactual larger candidates.
function referenceRaster(symbol, logo, bounds) {
  const modulePixels = Math.floor(640 / (symbol.modules.size + 8));
  const offset = Math.floor((640 - symbol.modules.size * modulePixels) / 2);
  const data = new Uint8ClampedArray(640 * 640 * 4).fill(255);
  const scale = Math.min(
    ((bounds.width - 2) * modulePixels) / logo.width,
    ((bounds.height - 2) * modulePixels) / logo.height,
  );
  const width = Math.max(1, Math.floor(logo.width * scale));
  const height = Math.max(1, Math.floor(logo.height * scale));
  const left = offset + bounds.col * modulePixels;
  const top = offset + bounds.row * modulePixels;
  const x0 = left + Math.floor((bounds.width * modulePixels - width) / 2);
  const y0 = top + Math.floor((bounds.height * modulePixels - height) / 2);
  for (let y = 0; y < 640; y++) {
    for (let x = 0; x < 640; x++) {
      const i = (y * 640 + x) * 4;
      const badge =
        x >= left &&
        x < left + bounds.width * modulePixels &&
        y >= top &&
        y < top + bounds.height * modulePixels;
      if (badge) {
        if (x >= x0 && x < x0 + width && y >= y0 && y < y0 + height) {
          const sx = Math.min(logo.width - 1, Math.floor((x - x0) / scale));
          const sy = Math.min(logo.height - 1, Math.floor((y - y0) / scale));
          const source = (sy * logo.width + sx) * 4;
          const alpha = logo.data[source + 3] / 255;
          for (let c = 0; c < 3; c++)
            data[i + c] = Math.round(
              logo.data[source + c] * alpha +
                (logo.background || [255, 255, 255])[c] * (1 - alpha),
            );
        }
      } else {
        const row = Math.floor((y - offset) / modulePixels);
        const col = Math.floor((x - offset) / modulePixels);
        if (
          row >= 0 &&
          col >= 0 &&
          row < symbol.modules.size &&
          col < symbol.modules.size &&
          symbol.modules.get(row, col)
        )
          data.fill(0, i, i + 3);
      }
    }
  }
  return { data, width: 640, height: 640 };
}

test("store aspect fits are policy-maximal for wide, tall and square artwork across all eight masks", (t) => {
  let completed = 0;
  const rejected = { structure: 0, budget: 0, locator: 0, decode: 0 };
  for (const logo of [
    syntheticLogo(500, 90),
    syntheticLogo(68, 100),
    syntheticLogo(80, 80),
  ]) {
    for (let maskPattern = 0; maskPattern < 8; maskPattern++) {
      const raster = renderer.createQrRaster(tracking, logo, { maskPattern });
      const symbol = QRCode.create(tracking, {
        errorCorrectionLevel: "H",
        maskPattern,
      });
      const map = renderer.createQrCodewordMap(symbol);
      assert.equal(candidateEligibility(symbol, map, raster.logoBounds), null);
      assert.ok(
        Math.abs(
          raster.storeMetrics.logoPixels.width -
            logo.width * raster.storeMetrics.fitScale,
        ) < 1,
      );
      assert.ok(
        Math.abs(
          raster.storeMetrics.logoPixels.height -
            logo.height * raster.storeMetrics.fitScale,
        ) < 1,
      );
      const expected = referenceRaster(symbol, logo, raster.logoBounds);
      assert.equal(
        createHash("sha256").update(raster.data).digest("hex"),
        createHash("sha256").update(expected.data).digest("hex"),
        "padding, functional cells, data border and compositing match independent reference",
      );
      assert.equal(
        jsQR(resize(raster, 240), 240, 240, { inversionAttempts: "dontInvert" })
          ?.data,
        tracking,
      );
      for (let width = 3; width <= symbol.modules.size; width += 2)
        for (let height = 3; height <= symbol.modules.size; height += 2) {
          const fit = Math.min(
            ((width - 2) * raster.modulePixels) / logo.width,
            ((height - 2) * raster.modulePixels) / logo.height,
          );
          if (fit <= raster.storeMetrics.fitScale) continue;
          const bounds = {
            row: (symbol.modules.size - height) / 2,
            col: (symbol.modules.size - width) / 2,
            width,
            height,
          };
          const violation = candidateEligibility(symbol, map, bounds);
          if (violation) {
            rejected[violation]++;
            continue;
          }
          const larger = referenceRaster(symbol, logo, bounds);
          const exact640 =
            jsQR(larger.data, 640, 640, { inversionAttempts: "dontInvert" })
              ?.data === tracking;
          const exact240 =
            jsQR(resize(larger, 240), 240, 240, {
              inversionAttempts: "dontInvert",
            })?.data === tracking;
          assert.ok(
            !exact640 || !exact240,
            `a larger safe candidate was missed: ${JSON.stringify({ width, height, maskPattern, aspect: logo.width / logo.height })}`,
          );
          rejected.decode++;
        }
      completed++;
    }
  }
  assert.equal(completed, 24);
  assert.ok(rejected.structure > 0 && rejected.budget > 0);
  t.diagnostic(
    JSON.stringify({ completed, largerCandidatesRejected: rejected }),
  );
});

test("store transparency composites onto the catalog inner background with a completely white module padding", () => {
  const logo = {
    ...syntheticLogo(68, 100, [255, 255, 255, 128]),
    background: [38, 43, 53],
  };
  const raster = renderer.createQrRaster(tracking, logo);
  const { logoPixels: inner } = raster.storeMetrics;
  const bounds = raster.logoBounds;
  const left = raster.offset + bounds.col * raster.modulePixels;
  const top = raster.offset + bounds.row * raster.modulePixels;
  for (let y = top; y < top + bounds.height * raster.modulePixels; y++)
    for (let x = left; x < left + bounds.width * raster.modulePixels; x++) {
      const inside =
        x >= inner.x &&
        x < inner.x + inner.width &&
        y >= inner.y &&
        y < inner.y + inner.height;
      const expected = inside
        ? logo.background.map((value) =>
            Math.round((255 * 128) / 255 + value * (1 - 128 / 255)),
          )
        : [255, 255, 255];
      assert.deepEqual(
        Array.from(
          raster.data.subarray((y * 640 + x) * 4, (y * 640 + x) * 4 + 4),
        ),
        [...expected, 255],
      );
    }
});

test("central alignment and long payloads fail closed in store layout while the no-logo control stays usable", () => {
  for (let maskPattern = 0; maskPattern < 8; maskPattern++)
    assert.throws(
      () =>
        renderer.createQrRaster(tracking, syntheticLogo(500, 90), {
          version: 7,
          maskPattern,
        }),
      /中央にロゴを安全に配置できません/,
    );
  assert.equal(
    renderer.createQrRaster(tracking, null, { version: 7 }).verifiedText,
    tracking,
  );
  assert.throws(
    () => renderer.createQrRaster("x".repeat(100), syntheticLogo(500, 90)),
    /中央にロゴを安全に配置できません/,
  );
  assert.throws(
    () => renderer.createQrRaster("x".repeat(2000), syntheticLogo(500, 90)),
    /too big/,
  );
});

test("legacy no-logo and all fifteen SNS raster bytes retain their pre-change SHA-256 snapshots", async () => {
  const hashes = {
    none: "cc6888a36225c46f4186a4f97c8d4f970fcaf487a2b5265da70a651e018f3047",
    "instagram-black":
      "2a27adaf295411c5b9d7dfeb3e1a05b74dff618014bfe9090d76220ee7498d10",
    "instagram-gradient":
      "fb2e010f78aaa2f59d09542390b007d913a93a02cc1aacaa0cfe02447d62440d",
    "instagram-white":
      "039609af04563424710c1e33bb5e757c429513365af14db55e05648698b60a15",
    "line-android":
      "00d0889a97b0457bea0a6d071c69b338765e48ab9b66ec92d638267e20c1ff6a",
    "line-ios":
      "827ddc8729cd9dd2a742f5768112dd69cdad27017705fb4328b28b9adf9672fd",
    "line-icons8-100":
      "6ddde2ffdeb819179f599768717e29b2005021dc5a18742355d0c55ee383585e",
    "line-icons8-50":
      "a9300d1d2666f0378db03ca2ab23aa96641c26fb5dd63ffb89d8347eee7a2527",
    "instagram-icons8-100":
      "f22f3cdb4813618719407f140db001e1a163fb163bb25f85aa5258d1e8bc38e4",
    "instagram-icons8-50":
      "c0de22c6aec0a22b2344e793e7251eb44b9c6c296d5cff6a49535861737207d4",
    "x-icons8-100":
      "85e314077d6d946d5db5fd521062cb73bcfa7f313ef965602813d6c45d9d2993",
    "x-icons8-50":
      "3ff963ddd9c227aaecbe75fbd8705985527668aec99f9c3642458701e3732a1d",
    "facebook-icons8-100":
      "9ea23176bc788fd196c8a7ebb7025d09b36199315fd1dbcc8460bdf249684822",
    "facebook-icons8-48":
      "b9f4ea9f9f18326fe30d367fda9baec0e62de18a84207a2d72272553e9d2184c",
    "facebook-icons8-50":
      "5c6e9cdc55b87fc19d60cc6c1b63a8cb78e8ca482ced2b556ea086b34f83d37f",
    "facebook-icons8-96":
      "2a57cca7700ac559b588da50c29ce416f9684833d5b179833f2a41cda76b61a4",
  };
  let completed = 0;
  for (const [id, hash] of Object.entries(hashes)) {
    const item =
      id === "none" ? null : QR_LOGOS.find((entry) => entry.id === id);
    if (id !== "none") assert.ok(item, id);
    const raster = renderer.createQrRaster(
      tracking,
      item ? catalogRaster(item) : null,
    );
    assert.equal(
      createHash("sha256").update(raster.data).digest("hex"),
      hash,
      id,
    );
    assert.equal(raster.storeMetrics, undefined);
    if (item) assert.equal(raster.logoBounds.side, 9);
    completed++;
  }
  assert.equal(completed, 16);
  assert.equal(
    await renderer.qrImageDataUrl(tracking),
    await QRCode.toDataURL(tracking, {
      width: 640,
      margin: 4,
      errorCorrectionLevel: "M",
    }),
  );
});

test("an already unreadable 240px undecorated control is rejected before an expensive store candidate search", () => {
  const url = new URL("../src/qr-image.mjs", import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import { createQrRaster } from ${JSON.stringify(url)};
    assert.throws(() => createQrRaster('A', { width: 500, height: 90, data: new Uint8ClampedArray(500 * 90 * 4).fill(255), layout: 'store' }, { version: 34, maskPattern: 0 }), /読み取り確認/);
    console.log('unreadable-control-refused');
  `,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(
    child.error?.code,
    undefined,
    "preflight should reject an unreadable undecorated control, not spend a minute trying overlays",
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), "unreadable-control-refused");
});

test("all 23 real store PNGs preserve aspect, budgets and exact decoding for masks zero through seven", (t) => {
  const stores = QR_LOGOS.filter((item) => item.kind === "store");
  assert.equal(stores.length, 23);
  let completed = 0;
  let largerCandidatesChecked = 0;
  const largerCandidatesRejected = {
    structure: 0,
    budget: 0,
    locator: 0,
    decode: 0,
  };
  for (const item of stores) {
    const logo = { ...catalogRaster(item), layout: "store" };
    for (let maskPattern = 0; maskPattern < 8; maskPattern++) {
      const image = renderer.createQrRaster(tracking, logo, { maskPattern });
      const symbol = QRCode.create(tracking, {
        errorCorrectionLevel: "H",
        maskPattern,
      });
      const map = renderer.createQrCodewordMap(symbol);
      assert.equal(
        candidateEligibility(symbol, map, image.logoBounds),
        null,
        `${item.id}/${maskPattern}`,
      );
      assert.equal(image.verifiedText, tracking);
      for (const [dimension, source] of [
        ["width", logo.width],
        ["height", logo.height],
      ])
        assert.ok(
          Math.abs(
            image.storeMetrics.logoPixels[dimension] -
              source * image.storeMetrics.fitScale,
          ) < 1,
          `${item.id} ${dimension}`,
        );
      const expected = referenceRaster(symbol, logo, image.logoBounds);
      assert.equal(
        createHash("sha256").update(image.data).digest("hex"),
        createHash("sha256").update(expected.data).digest("hex"),
        `${item.id}/${maskPattern} complete pixels`,
      );
      for (let width = 3; width <= symbol.modules.size; width += 2)
        for (let height = 3; height <= symbol.modules.size; height += 2) {
          const fit = Math.min(
            ((width - 2) * image.modulePixels) / logo.width,
            ((height - 2) * image.modulePixels) / logo.height,
          );
          if (fit <= image.storeMetrics.fitScale) continue;
          largerCandidatesChecked++;
          const bounds = {
            row: (symbol.modules.size - height) / 2,
            col: (symbol.modules.size - width) / 2,
            width,
            height,
          };
          const violation = candidateEligibility(symbol, map, bounds);
          if (violation) {
            largerCandidatesRejected[violation]++;
            continue;
          }
          const larger = referenceRaster(symbol, logo, bounds);
          const large640 = jsQR(larger.data, 640, 640, {
            inversionAttempts: "dontInvert",
          })?.data;
          const large240 = jsQR(resize(larger, 240), 240, 240, {
            inversionAttempts: "dontInvert",
          })?.data;
          assert.ok(
            large640 !== tracking || large240 !== tracking,
            `${item.id}/${maskPattern}: larger eligible and decodable candidate was missed`,
          );
          largerCandidatesRejected.decode++;
        }
      const exported = PNG.sync.read(PNG.sync.write(image));
      for (const size of [640, 240])
        assert.equal(
          jsQR(
            size === 640
              ? new Uint8ClampedArray(exported.data)
              : resize(exported, size),
            size,
            size,
            { inversionAttempts: "dontInvert" },
          )?.data,
          tracking,
          `${item.id}/${maskPattern}/${size} exported PNG`,
        );
      completed++;
    }
  }
  assert.equal(completed, 184);
  assert.equal(
    Object.values(largerCandidatesRejected).reduce(
      (sum, count) => sum + count,
      0,
    ),
    largerCandidatesChecked,
  );
  assert.ok(
    largerCandidatesRejected.locator > 0,
    "larger but locator-confusing candidates must be checked, not silently capped",
  );
  t.diagnostic(
    JSON.stringify({
      storePNGCount: stores.length,
      masks: 8,
      exportedPNGRenders: completed,
      largerCandidatesChecked,
      largerCandidatesRejected,
      decodeSizes: [640, 240],
    }),
  );
});

test("browser PNG adapter applies the real catalog layout to all 38 local PNGs", async (t) => {
  assert.equal(QR_LOGOS.length, 38);
  const sources = installCanvasIO(t, QR_LOGOS);
  for (const item of QR_LOGOS) {
    const dataURL = await renderer.qrImageDataUrl(tracking, item.id, "/local/");
    const png = PNG.sync.read(Buffer.from(dataURL.split(",")[1], "base64"));
    const expected = renderer.createQrRaster(tracking, {
      ...catalogRaster(item),
      ...(item.kind === "store" ? { layout: "store" } : {}),
    });
    assert.equal(
      createHash("sha256").update(png.data).digest("hex"),
      createHash("sha256").update(expected.data).digest("hex"),
      item.id,
    );
    for (const size of [640, 240])
      assert.equal(
        jsQR(
          size === 640 ? new Uint8ClampedArray(png.data) : resize(png, size),
          size,
          size,
          { inversionAttempts: "dontInvert" },
        )?.data,
        tracking,
        `${item.id}/${size}`,
      );
  }
  assert.equal(sources.length, 38);
});

test("decoder fault injection rejects wrong payloads at either size, retries smaller candidates and refuses when every candidate fails", async () => {
  for (const fail of [3, 4, "all"]) {
    const suffix = `decoder-fault-${fail}`;
    const decoderURL = new URL(
      "../node_modules/jsqr/dist/jsQR.js",
      import.meta.url,
    ).href;
    const fixtureURL =
      "data:text/javascript," +
      encodeURIComponent(`
      import real from ${JSON.stringify(decoderURL)};
      let calls=0;
      export const getCalls=()=>calls;
      export default function(...args){
        const decoded=real(...args); calls++;
        if (${JSON.stringify(fail)}==='all' ? calls>=3 : calls===${JSON.stringify(fail)})
          return decoded ? {...decoded,data:'wrong-payload-injected'} : null;
        return decoded;
      }
    `);
    const hook = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "jsqr" && context.parentURL?.includes(suffix))
          return { url: fixtureURL, shortCircuit: true };
        return nextResolve(specifier, context);
      },
    });
    let module;
    try {
      module = await import(`../src/qr-image.mjs?${suffix}`);
    } finally {
      hook.deregister();
    }
    const logo = syntheticLogo(500, 90);
    if (fail === "all") {
      assert.throws(
        () => module.createQrRaster(tracking, logo),
        /読み取り確認/,
      );
      assert.ok(
        (await import(fixtureURL)).getCalls() > 4,
        "all structurally eligible candidates are actually evaluated",
      );
    } else {
      const result = module.createQrRaster(tracking, logo);
      assert.equal(result.storeMetrics.decodeRejected.length, 1);
      assert.equal(
        result.storeMetrics.decodeRejected[0].failedSize,
        fail === 3 ? 640 : 240,
      );
      assert.ok(
        result.storeMetrics.fitScale <=
          result.storeMetrics.decodeRejected[0].fitScale,
      );
      assert.equal(
        jsQR(result.data, 640, 640, { inversionAttempts: "dontInvert" })?.data,
        tracking,
      );
      assert.equal(
        jsQR(resize(result, 240), 240, 240, { inversionAttempts: "dontInvert" })
          ?.data,
        tracking,
      );
    }
  }
});

test("store rasters reject unknown layouts and non-catalog-sized or malformed pixel/background data", () => {
  for (const layout of [null, "", "sns", "wide", {}, 1]) {
    assert.throws(
      () =>
        renderer.createQrRaster(tracking, { ...syntheticLogo(2, 2), layout }),
      /レイアウト/,
    );
  }
  for (const bad of [
    { ...syntheticLogo(2, 2), width: 1.5 },
    { ...syntheticLogo(2, 2), width: -2 },
    { ...syntheticLogo(2, 2), data: new Uint8ClampedArray(4) },
    { ...syntheticLogo(2, 2), data: Array(16).fill(NaN) },
    { ...syntheticLogo(2, 2), data: new Float32Array(16).fill(255) },
    syntheticLogo(513, 1),
    syntheticLogo(1, 513),
    { ...syntheticLogo(2, 2), background: [255] },
    { ...syntheticLogo(2, 2), background: [255, 255, -1] },
    { ...syntheticLogo(2, 2), background: [255, NaN, 255] },
    { ...syntheticLogo(2, 2), background: [255, 255, 256] },
    { ...syntheticLogo(2, 2), background: [255, 255, 3.5] },
  ])
    assert.throws(() => renderer.createQrRaster(tracking, bad), /ロゴ画像/);
});

test("store layout expands wide artwork using a centered RS-budgeted rectangle with preserved functional pixels", () => {
  const logo = syntheticLogo(500, 90);
  const raster = renderer.createQrRaster(tracking, logo);
  assert.ok(
    raster.storeMetrics,
    "store layout must not silently use the legacy square",
  );
  const symbol = QRCode.create(tracking, { errorCorrectionLevel: "H" });
  const map = renderer.createQrCodewordMap(symbol);
  const bounds = raster.logoBounds;
  assert.equal(bounds.width % 2, 1);
  assert.equal(bounds.height % 2, 1);
  assert.equal(bounds.col * 2 + bounds.width, symbol.modules.size);
  assert.equal(bounds.row * 2 + bounds.height, symbol.modules.size);
  assert.ok(bounds.col >= 4 && bounds.row >= 4);
  assert.ok(
    bounds.width > 9,
    "wide store artwork is no longer limited to a nine-module square",
  );
  assert.ok(bounds.width > bounds.height);
  assert.equal(raster.verifiedText, tracking);
  assert.deepEqual(raster.storeMetrics.decodeSizes, [640, 240]);
  const seen = map.blocks.map(() => new Set());
  for (let row = bounds.row; row < bounds.row + bounds.height; row++)
    for (let col = bounds.col; col < bounds.col + bounds.width; col++) {
      assert.equal(Boolean(symbol.modules.isReserved(row, col)), false);
      const cw = map.moduleToCodeword[row * symbol.modules.size + col];
      if (cw >= 0) seen[map.codewordToBlock[cw]].add(cw);
    }
  assert.deepEqual(
    raster.storeMetrics.blocks.map((b) => b.touchedCodewords),
    seen.map((s) => s.size),
  );
  for (let b = 0; b < seen.length; b++) {
    assert.ok(seen[b].size <= map.blocks[b].logoBudget);
    assert.ok(
      map.blocks[b].correctionCapacity - seen[b].size >=
        Math.ceil(map.blocks[b].correctionCapacity / 2),
    );
  }
  const pixels = raster.storeMetrics.logoPixels;
  assert.ok(
    Math.abs(pixels.width / pixels.height - logo.width / logo.height) <=
      1 / pixels.height,
  );
  const left = raster.offset + bounds.col * raster.modulePixels;
  const top = raster.offset + bounds.row * raster.modulePixels;
  assert.ok(pixels.x >= left + raster.modulePixels);
  assert.ok(pixels.y >= top + raster.modulePixels);
  assert.ok(
    pixels.x + pixels.width <= left + (bounds.width - 1) * raster.modulePixels,
  );
  assert.ok(
    pixels.y + pixels.height <= top + (bounds.height - 1) * raster.modulePixels,
  );
  // Check every pixel of all reserved cells, and the whole external margin.
  for (let y = 0; y < 640; y++)
    for (let x = 0; x < 640; x++) {
      const row = Math.floor((y - raster.offset) / raster.modulePixels);
      const col = Math.floor((x - raster.offset) / raster.modulePixels);
      const outside =
        row < 0 ||
        col < 0 ||
        row >= symbol.modules.size ||
        col >= symbol.modules.size;
      if (!outside && !symbol.modules.isReserved(row, col)) continue;
      const expected = !outside && symbol.modules.get(row, col) ? 0 : 255;
      const index = (y * 640 + x) * 4;
      assert.deepEqual(Array.from(raster.data.subarray(index, index + 4)), [
        expected,
        expected,
        expected,
        255,
      ]);
    }
  assert.ok(raster.quietZone >= 4);
  for (const size of [640, 240])
    assert.equal(
      jsQR(size === 640 ? raster.data : resize(raster, size), size, size, {
        inversionAttempts: "dontInvert",
      })?.data,
      tracking,
    );
});

/**
 * End-to-end reader checks against real granules — the same sample datasets the
 * HyperCoast notebook examples use. The scene readers are DOM-free (only h5wasm,
 * geotiff, and proj4), so the exact browser `openScene` path runs in Node here.
 *
 * These are skipped unless `HC_SAMPLES_DIR` points at a directory holding the
 * granules (they are hundreds of MB and not committed), so `npm test` stays fast
 * in CI. Run locally with, e.g.:
 *
 *   HC_SAMPLES_DIR=/tmp/hc-samples npx vitest run tests/integration.sensors.test.ts
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openScene } from '../src/lib/io/registry';

const DIR = process.env.HC_SAMPLES_DIR;

/** Read a file into a fresh ArrayBuffer (mirrors `File.arrayBuffer()`). */
function readArrayBuffer(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

interface Case {
  file: string;
  sensor: string;
  /** Expected wavelength range [min, max] in nm, loosely bounded. */
  wlRange: [number, number];
}

const CASES: Case[] = [
  { file: 'desis.tif', sensor: 'DESIS', wlRange: [400, 1000] },
  { file: 'neon.h5', sensor: 'NEON', wlRange: [380, 2520] },
  { file: 'pace_aop.nc', sensor: 'PACE', wlRange: [330, 720] },
  { file: 'emit.nc', sensor: 'EMIT', wlRange: [380, 2500] },
  { file: 'tanager.h5', sensor: 'Tanager', wlRange: [370, 2520] },
  { file: 'wyvern.tif', sensor: 'Wyvern', wlRange: [440, 900] },
];

describe('real-granule reader integration', () => {
  for (const c of CASES) {
    const path = DIR ? join(DIR, c.file) : '';
    const present = Boolean(DIR && existsSync(path));

    it.skipIf(!present)(`reads a ${c.sensor} scene end-to-end`, async () => {
      const bytes = readArrayBuffer(path);
      const scene = await openScene(bytes, c.file);
      try {
        const md = scene.metadata;

        expect(md.sensor).toBe(c.sensor);
        expect(md.bandCount).toBeGreaterThan(10);
        expect(md.wavelengths.length).toBe(md.bandCount);

        // Wavelengths ascend monotonically and stay within the instrument range.
        for (let i = 1; i < md.bandCount; i++) {
          expect(md.wavelengths[i]).toBeGreaterThanOrEqual(md.wavelengths[i - 1]);
        }
        expect(md.wavelengths[0]).toBeGreaterThanOrEqual(c.wlRange[0]);
        expect(md.wavelengths[md.bandCount - 1]).toBeLessThanOrEqual(c.wlRange[1]);

        // Bounds are a sane lng/lat box.
        const [w, s, e, n] = md.bounds;
        expect(w).toBeGreaterThanOrEqual(-180);
        expect(e).toBeLessThanOrEqual(180);
        expect(w).toBeLessThan(e);
        expect(s).toBeLessThan(n);
        expect(s).toBeGreaterThanOrEqual(-90);
        expect(n).toBeLessThanOrEqual(90);

        // A mid band renders with at least some valid (non-NaN) cells.
        const mid = Math.floor(md.bandCount / 2);
        const band = await scene.readOrthoBand(mid);
        expect(band.length).toBe(md.width * md.height);
        const finite = band.reduce((acc, v) => acc + (Number.isNaN(v) ? 0 : 1), 0);
        expect(finite).toBeGreaterThan(0);

        // A spectrum at the scene center has the right length.
        const cx = (w + e) / 2;
        const cy = (s + n) / 2;
        const spec = await scene.readSpectrumAt(cx, cy);
        if (spec) expect(spec.length).toBe(md.bandCount);
      } finally {
        scene.close();
      }
    }, 120_000);
  }
});

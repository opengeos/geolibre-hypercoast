import { describe, it, expect } from 'vitest';
import {
  geotransformToBounds,
  lngLatToColRow,
  applyGlt,
  composeRgb,
  EMIT_FILL_VALUE,
  type GeoTransform,
} from '../src/lib/render/orthorectify';

// A small north-up geotransform: origin at (-100, 40), 1 degree cells.
const GT: GeoTransform = [-100, 1, 0, 40, 0, -1];

describe('geotransformToBounds', () => {
  it('spans the full grid extent (north-up)', () => {
    // 4 cols x 3 rows => east = -100 + 4 = -96, south = 40 - 3 = 37
    expect(geotransformToBounds(GT, 4, 3)).toEqual([-100, 37, -96, 40]);
  });
});

describe('lngLatToColRow', () => {
  it('maps a coordinate to the containing cell', () => {
    // (-100,40) is the top-left corner -> col 0, row 0
    expect(lngLatToColRow(GT, -100, 40)).toEqual({ col: 0, row: 0 });
    // (-98.5, 38.5) -> col 1, row 1
    expect(lngLatToColRow(GT, -98.5, 38.5)).toEqual({ col: 1, row: 1 });
  });

  it('returns out-of-range indices for points outside the grid', () => {
    const { col, row } = lngLatToColRow(GT, -101, 41);
    expect(col).toBeLessThan(0);
    expect(row).toBeLessThan(0);
  });
});

describe('applyGlt', () => {
  it('scatters swath pixels onto the ortho grid and marks nodata as NaN', () => {
    // 2x2 swath, row-major [downtrack, crosstrack]:
    //   [10, 20]
    //   [30, 40]
    const band = Float32Array.from([10, 20, 30, 40]);
    const swathW = 2;
    const swathH = 2;

    // 2x2 ortho grid GLT (1-based; 0 = nodata). glt index pairs (gx=col, gy=row):
    // cell (0,0) -> swath (col1,row1)=(0,0) => 10
    // cell (0,1) -> nodata
    // cell (1,0) -> swath (col2,row1)=(1,0) => 20
    // cell (1,1) -> swath (col1,row2)=(0,1) => 30
    const gltX = Int32Array.from([1, 0, 2, 1]);
    const gltY = Int32Array.from([1, 0, 1, 2]);

    const out = applyGlt(band, swathW, swathH, gltX, gltY, 2, 2, EMIT_FILL_VALUE);
    expect(out[0]).toBe(10);
    expect(Number.isNaN(out[1])).toBe(true);
    expect(out[2]).toBe(20);
    expect(out[3]).toBe(30);
  });

  it('treats the fill value as NaN', () => {
    const band = Float32Array.from([EMIT_FILL_VALUE, 5]);
    const gltX = Int32Array.from([1, 2]);
    const gltY = Int32Array.from([1, 1]);
    const out = applyGlt(band, 2, 1, gltX, gltY, 2, 1, EMIT_FILL_VALUE);
    expect(Number.isNaN(out[0])).toBe(true);
    expect(out[1]).toBe(5);
  });
});

describe('composeRgb', () => {
  it('applies a linear stretch and clamps to 0..255', () => {
    const r = Float32Array.from([0, 0.15, 0.3, 0.6]);
    const g = Float32Array.from([0, 0.15, 0.3, 0.6]);
    const b = Float32Array.from([0, 0.15, 0.3, 0.6]);
    const rgba = composeRgb(r, g, b, 0, 0.3);

    expect(rgba[0]).toBe(0); // 0 -> 0
    expect(rgba[4]).toBe(128); // 0.15 of 0.3 -> ~127.5 -> clamped channel 128
    expect(rgba[8]).toBe(255); // 0.3 -> 255
    expect(rgba[12]).toBe(255); // 0.6 over max -> clamped 255
    // Alpha opaque for valid pixels.
    expect(rgba[3]).toBe(255);
  });

  it('renders NaN cells as fully transparent', () => {
    const r = Float32Array.from([NaN, 0.2]);
    const g = Float32Array.from([NaN, 0.2]);
    const b = Float32Array.from([NaN, 0.2]);
    const rgba = composeRgb(r, g, b, 0, 0.3);
    expect(rgba[3]).toBe(0); // transparent
    expect(rgba[7]).toBe(255); // opaque
  });
});

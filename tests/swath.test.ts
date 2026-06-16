import { describe, it, expect } from 'vitest';
import { buildSwathGrid, swathGridColRow } from '../src/lib/render/orthorectify';

describe('buildSwathGrid', () => {
  // 2x2 swath, row-major [downtrack, crosstrack]:
  //   pixel (sy,sx): lon, lat
  //   (0,0)=0,1  (0,1)=1,1
  //   (1,0)=0,0  (1,1)=1,0
  const lon = [0, 1, 0, 1];
  const lat = [1, 1, 0, 0];

  it('scatters each swath pixel into its target cell', () => {
    const grid = buildSwathGrid(lon, lat, 2, 2);
    expect(grid.width).toBe(2);
    expect(grid.height).toBe(2);
    expect(grid.bounds).toEqual([0, 0, 1, 1]);
    // Row 0 = north (lat 1): cells map to source pixels 0 and 1.
    // Row 1 = south (lat 0): cells map to source pixels 2 and 3.
    expect(Array.from(grid.srcIndex)).toEqual([0, 1, 2, 3]);
  });

  it('marks cells with no contributing pixel as -1', () => {
    // Three valid pixels clustered, leaving one target cell empty.
    const g = buildSwathGrid([0, 0, 1, 1], [1, 1, 1, 1], 2, 2);
    // All latitudes equal → degenerate Y span, but X still spreads two columns.
    expect(g.srcIndex.some((v) => v === -1)).toBe(true);
  });

  it('throws when no pixel has a valid geolocation', () => {
    expect(() => buildSwathGrid([NaN, 999], [NaN, 999], 2, 1)).toThrow(/no valid geolocation/);
  });

  it('throws when the geolocation arrays are too small for the swath', () => {
    expect(() => buildSwathGrid([0, 1], [0, 1], 2, 2)).toThrow(/too small/);
  });
});

describe('swathGridColRow', () => {
  it('maps a lng/lat to the containing target cell', () => {
    const grid = buildSwathGrid([0, 1, 0, 1], [1, 1, 0, 0], 2, 2);
    expect(swathGridColRow(grid, 0.25, 0.75)).toEqual({ col: 0, row: 0 });
    expect(swathGridColRow(grid, 0.75, 0.25)).toEqual({ col: 1, row: 1 });
  });

  it('returns out-of-range indices for points outside the grid', () => {
    const grid = buildSwathGrid([0, 1, 0, 1], [1, 1, 0, 0], 2, 2);
    const { col } = swathGridColRow(grid, -1, 0.5);
    expect(col).toBeLessThan(0);
  });
});

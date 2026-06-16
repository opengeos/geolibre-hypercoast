import { describe, it, expect } from 'vitest';
import {
  parseEpsg,
  toLngLat,
  fromLngLat,
  projectedGridToLngLatBounds,
} from '../src/lib/render/reproject';
import type { GeoTransform } from '../src/lib/render/orthorectify';

describe('parseEpsg', () => {
  it('parses an "EPSG:code" string', () => {
    expect(parseEpsg('EPSG:32617')).toBe(32617);
  });

  it('parses an EPSG id out of a WKT string', () => {
    expect(parseEpsg('PROJCS[...,ID["EPSG",32617]]')).toBe(32617);
    expect(parseEpsg('...AUTHORITY["EPSG","4326"]]')).toBe(4326);
  });

  it('returns null for missing/invalid input', () => {
    expect(parseEpsg(null)).toBeNull();
    expect(parseEpsg('not a crs')).toBeNull();
  });
});

describe('toLngLat / fromLngLat (UTM)', () => {
  it('maps the UTM zone 17N false-easting origin to its central meridian', () => {
    // Easting 500000 sits on zone 17's central meridian (-81°).
    const [lng, lat] = toLngLat(32617, 500000, 4649776);
    expect(lng).toBeCloseTo(-81, 3);
    expect(lat).toBeGreaterThan(41);
    expect(lat).toBeLessThan(43);
  });

  it('round-trips lng/lat → metres → lng/lat', () => {
    const [x, y] = fromLngLat(32617, -81, 42);
    const [lng, lat] = toLngLat(32617, x, y);
    expect(lng).toBeCloseTo(-81, 6);
    expect(lat).toBeCloseTo(42, 6);
  });

  it('passes EPSG:4326 through unchanged', () => {
    expect(toLngLat(4326, -100, 40)).toEqual([-100, 40]);
    expect(fromLngLat(4326, -100, 40)).toEqual([-100, 40]);
  });

  it('throws on an unsupported CRS', () => {
    expect(() => toLngLat(2154, 0, 0)).toThrow(/Unsupported CRS/);
  });
});

describe('projectedGridToLngLatBounds', () => {
  it('returns a well-ordered lng/lat bbox for a north-up UTM grid', () => {
    // 100 x 100 cells of 30 m, origin near zone 17.
    const gt: GeoTransform = [400000, 30, 0, 4650000, 0, -30];
    const [west, south, east, north] = projectedGridToLngLatBounds(gt, 100, 100, 32617);
    expect(west).toBeLessThan(east);
    expect(south).toBeLessThan(north);
    expect(lonInZone17(west)).toBe(true);
    expect(lonInZone17(east)).toBe(true);
  });
});

function lonInZone17(lng: number): boolean {
  return lng > -85 && lng < -77;
}

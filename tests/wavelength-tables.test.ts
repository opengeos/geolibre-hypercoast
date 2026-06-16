import { describe, it, expect } from 'vitest';
import {
  parseWavelengthCsv,
  resolveWavelengths,
  DESIS_WAVELENGTHS,
  WYVERN_DRAGONETTE1,
  WYVERN_DRAGONETTE3,
} from '../src/lib/io/wavelength-tables';

describe('parseWavelengthCsv', () => {
  it('parses a band,wavelength CSV and tolerates a BOM', () => {
    const csv = '﻿band,wavelength\n1,400.5\n2,410\n';
    expect(parseWavelengthCsv(csv)).toEqual([400.5, 410]);
  });
});

describe('resolveWavelengths', () => {
  it('prefers complete in-file wavelengths', async () => {
    const wl = await resolveWavelengths({ sensor: 'EnMAP', bandCount: 3, inFile: [400, 500, 600] });
    expect(wl).toEqual([400, 500, 600]);
  });

  it('falls back to the bundled DESIS table when offline', async () => {
    const wl = await resolveWavelengths({ sensor: 'DESIS', bandCount: 235 });
    expect(wl).toBe(DESIS_WAVELENGTHS);
    expect(wl.length).toBe(235);
  });

  it('selects the right bundled Wyvern table by band count', async () => {
    expect(await resolveWavelengths({ sensor: 'Wyvern', bandCount: 23 })).toBe(WYVERN_DRAGONETTE1);
    expect(await resolveWavelengths({ sensor: 'Wyvern', bandCount: 31 })).toBe(WYVERN_DRAGONETTE3);
  });

  it('uses a fetched CSV when it matches the band count', async () => {
    const fetchArrayBuffer = async (): Promise<ArrayBuffer> => {
      const bytes = new TextEncoder().encode('band,wavelength\n1,401.43\n2,404.1\n3,406.72\n');
      return bytes.buffer as ArrayBuffer;
    };
    const wl = await resolveWavelengths({ sensor: 'DESIS', bandCount: 3, fetchArrayBuffer });
    expect(wl).toEqual([401.43, 404.1, 406.72]);
  });

  it('falls back to band indices when nothing else fits', async () => {
    const wl = await resolveWavelengths({ sensor: 'Hyperspectral', bandCount: 4 });
    expect(wl).toEqual([1, 2, 3, 4]);
  });
});

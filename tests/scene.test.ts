import { describe, it, expect } from 'vitest';
import { nearestBandIndex } from '../src/lib/io/SceneReader';
import { spectraToCsv, spectrumColor, type CollectedSpectrum } from '../src/lib/chart/spectra';

describe('nearestBandIndex', () => {
  const wavelengths = [400, 450, 500, 550, 600, 650];

  it('finds the closest band to a target wavelength', () => {
    expect(nearestBandIndex(wavelengths, 650)).toBe(5);
    expect(nearestBandIndex(wavelengths, 455)).toBe(1);
    expect(nearestBandIndex(wavelengths, 524)).toBe(2); // closer to 500 than 550
    expect(nearestBandIndex(wavelengths, 526)).toBe(3); // closer to 550
  });

  it('clamps to the ends for out-of-range targets', () => {
    expect(nearestBandIndex(wavelengths, 100)).toBe(0);
    expect(nearestBandIndex(wavelengths, 9999)).toBe(5);
  });

  it('returns 0 for an empty band list', () => {
    expect(nearestBandIndex([], 500)).toBe(0);
  });
});

describe('spectrumColor', () => {
  it('cycles through the palette', () => {
    expect(spectrumColor(0)).toBe('#1f77b4');
    expect(spectrumColor(10)).toBe(spectrumColor(0));
  });
});

describe('spectraToCsv', () => {
  it('builds a row per band and a column per point, blanking NaN', () => {
    const wavelengths = [450, 550, 650];
    const spectra: CollectedSpectrum[] = [
      { id: 'a', lng: -83.5, lat: 25.1, values: [0.1, NaN, 0.3], color: '#000' },
      { id: 'b', lng: -83.4, lat: 25.2, values: [0.2, 0.25, 0.35], color: '#111' },
    ];
    const csv = spectraToCsv(wavelengths, spectra);
    const lines = csv.trim().split('\n');

    expect(lines[0]).toBe(
      'wavelength_nm,point_1 (25.10000, -83.50000),point_2 (25.20000, -83.40000)',
    );
    expect(lines[1]).toBe('450,0.1,0.2');
    expect(lines[2]).toBe('550,,0.25'); // NaN -> blank cell
    expect(lines[3]).toBe('650,0.3,0.35');
  });
});

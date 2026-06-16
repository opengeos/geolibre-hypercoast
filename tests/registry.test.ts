import { describe, it, expect } from 'vitest';
import { detectContainer, openScene, SENSORS } from '../src/lib/io/registry';

/** Build an ArrayBuffer beginning with the given bytes. */
function bufferWith(bytes: number[]): ArrayBuffer {
  const u = new Uint8Array(16);
  u.set(bytes);
  return u.buffer;
}

describe('detectContainer', () => {
  it('detects an HDF5 superblock signature', () => {
    expect(detectContainer(bufferWith([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('hdf5');
  });

  it('detects little- and big-endian TIFF', () => {
    expect(detectContainer(bufferWith([0x49, 0x49, 0x2a, 0x00]))).toBe('tiff');
    expect(detectContainer(bufferWith([0x4d, 0x4d, 0x00, 0x2a]))).toBe('tiff');
  });

  it('detects BigTIFF (magic 43)', () => {
    expect(detectContainer(bufferWith([0x49, 0x49, 0x2b, 0x00]))).toBe('tiff');
  });

  it('detects classic netCDF', () => {
    expect(detectContainer(bufferWith([0x43, 0x44, 0x46, 0x01]))).toBe('netcdf-classic');
  });

  it('returns unknown for unrecognized bytes', () => {
    expect(detectContainer(bufferWith([0x00, 0x01, 0x02, 0x03]))).toBe('unknown');
  });
});

describe('openScene dispatch errors', () => {
  it('rejects classic netCDF with a helpful message', async () => {
    await expect(openScene(bufferWith([0x43, 0x44, 0x46, 0x01]), 'x.nc')).rejects.toThrow(
      /Classic netCDF is not supported/,
    );
  });

  it('rejects an unrecognized container', async () => {
    await expect(openScene(bufferWith([0x00, 0x01, 0x02, 0x03]), 'x.bin')).rejects.toThrow(
      /Unsupported file format/,
    );
  });
});

describe('SENSORS', () => {
  it('lists every supported sensor with a container', () => {
    const ids = SENSORS.map((s) => s.id);
    for (const id of ['EMIT', 'PACE', 'NEON', 'PRISMA', 'Tanager', 'AVIRIS', 'DESIS', 'EnMAP', 'Wyvern']) {
      expect(ids).toContain(id);
    }
    expect(SENSORS.every((s) => s.container === 'hdf5' || s.container === 'tiff')).toBe(true);
  });
});

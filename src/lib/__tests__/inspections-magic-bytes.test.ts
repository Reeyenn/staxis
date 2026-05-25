/**
 * Tests for the MIME magic-byte sniffer used by the inspection
 * upload-photo routes. Pure function — no DB, no network.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectImageMime,
  declaredMimeMatchesBytes,
} from '@/lib/inspections/image-magic-bytes';

// Helper — build a Uint8Array from an array of hex bytes.
function bytes(values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

// Real-world leading bytes for each format. Padded to 12 bytes (the
// minimum the detector inspects) so we exercise the actual length-check.
const JPEG_HEAD = bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PNG_HEAD  = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const WEBP_HEAD = bytes([0x52, 0x49, 0x46, 0x46, 0x40, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

describe('detectImageMime', () => {
  it('identifies a JPEG by its SOI marker', () => {
    assert.equal(detectImageMime(JPEG_HEAD), 'image/jpeg');
  });

  it('identifies a PNG by its 8-byte signature', () => {
    assert.equal(detectImageMime(PNG_HEAD), 'image/png');
  });

  it('identifies a WebP by the "RIFF...WEBP" pattern', () => {
    assert.equal(detectImageMime(WEBP_HEAD), 'image/webp');
  });

  it('rejects bytes that match no format (e.g. HTML)', () => {
    const html = bytes([0x3c, 0x21, 0x44, 0x4f, 0x43, 0x54, 0x59, 0x50, 0x45, 0x20, 0x68, 0x74]); // <!DOCTYPE h
    assert.equal(detectImageMime(html), null);
  });

  it('rejects bytes that almost-match (PNG with wrong byte 1)', () => {
    const broken = bytes([0x89, 0x4F, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    assert.equal(detectImageMime(broken), null);
  });

  it('rejects bytes that almost-match WebP (RIFF but no WEBP)', () => {
    // RIFF prefix is shared with WAV / AVI etc. The "WEBP" bytes must be at offset 8.
    const wav = bytes([0x52, 0x49, 0x46, 0x46, 0x40, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]); // WAVE
    assert.equal(detectImageMime(wav), null);
  });

  it('returns null for too-short buffers', () => {
    assert.equal(detectImageMime(bytes([0xff, 0xd8])), null);
    assert.equal(detectImageMime(bytes([])), null);
  });

  it('returns null when given a non-buffer input', () => {
    assert.equal(detectImageMime(undefined as unknown as Uint8Array), null);
    assert.equal(detectImageMime(null as unknown as Uint8Array), null);
  });
});

describe('declaredMimeMatchesBytes', () => {
  it('accepts matching declarations', () => {
    assert.equal(declaredMimeMatchesBytes('image/jpeg', JPEG_HEAD), true);
    assert.equal(declaredMimeMatchesBytes('image/png',  PNG_HEAD),  true);
    assert.equal(declaredMimeMatchesBytes('image/webp', WEBP_HEAD), true);
  });

  it('treats image/jpg as a synonym for image/jpeg', () => {
    assert.equal(declaredMimeMatchesBytes('image/jpg', JPEG_HEAD), true);
  });

  it('rejects a spoofed declaration that does NOT match the bytes', () => {
    // Bytes are PNG; declared image/jpeg → mismatch.
    assert.equal(declaredMimeMatchesBytes('image/jpeg', PNG_HEAD), false);
    // Bytes are JPEG; declared image/png → mismatch.
    assert.equal(declaredMimeMatchesBytes('image/png', JPEG_HEAD), false);
  });

  it('rejects when bytes do not match any known format, regardless of declaration', () => {
    const html = bytes([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    assert.equal(declaredMimeMatchesBytes('image/jpeg', html), false);
    assert.equal(declaredMimeMatchesBytes('image/png',  html), false);
    assert.equal(declaredMimeMatchesBytes('image/webp', html), false);
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { toBigIntBE, toBigIntLE, toBufferBE, toBufferLE } from '../vendor/bigint-buffer/index.cjs';

test('unsigned conversion preserves independent LE and BE byte vectors', () => {
  const value = 0x0102030405060708090a0b0c0d0e0f10n;
  const be = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex');
  const le = Buffer.from('100f0e0d0c0b0a090807060504030201', 'hex');
  assert.deepEqual(toBufferBE(value, 16), be);
  assert.deepEqual(toBufferLE(value, 16), le);
  assert.equal(toBigIntBE(be), value);
  assert.equal(toBigIntLE(le), value);
});

test('8-byte conversion agrees with Node unsigned integer encoders', () => {
  for (const value of [0n, 1n, 255n, 256n, 0x1020304050607080n, 0xffffffffffffffffn]) {
    const le = Buffer.alloc(8); le.writeBigUInt64LE(value);
    const be = Buffer.alloc(8); be.writeBigUInt64BE(value);
    assert.deepEqual(toBufferLE(value, 8), le);
    assert.deepEqual(toBufferBE(value, 8), be);
    assert.equal(toBigIntLE(le), value);
    assert.equal(toBigIntBE(be), value);
  }
});

test('SDK widths are exact, zero-padded and support their maximum unsigned values', () => {
  for (const width of [1, 8, 16, 32, 64, 1024]) {
    const maximum = (1n << BigInt(width * 8)) - 1n;
    for (const [encode, decode, oneIndex] of [[toBufferLE, toBigIntLE, 0], [toBufferBE, toBigIntBE, width - 1]]) {
      const zero = encode(0n, width);
      assert.equal(zero.length, width);
      assert.deepEqual(zero, Buffer.alloc(width));
      const one = Buffer.alloc(width); one[oneIndex] = 1;
      assert.deepEqual(encode(1n, width), one);
      assert.deepEqual(encode(maximum, width), Buffer.alloc(width, 255));
      assert.equal(decode(Buffer.alloc(width, 255)), maximum);
    }
  }
});

test('empty buffers encode only zero and decode as zero', () => {
  for (const encode of [toBufferLE, toBufferBE]) {
    assert.deepEqual(encode(0n, 0), Buffer.alloc(0));
    assert.throws(() => encode(1n, 0), RangeError);
  }
  assert.equal(toBigIntBE(Buffer.alloc(0)), 0n);
  assert.equal(toBigIntLE(Buffer.alloc(0)), 0n);
});

test('overflow is rejected without truncation in both byte orders', () => {
  for (const encode of [toBufferLE, toBufferBE]) {
    for (const width of [1, 8, 16, 32, 1024]) {
      assert.throws(() => encode(1n << BigInt(width * 8), width), /does not fit/);
    }
    assert.throws(() => encode(1n << 512n, 8), /does not fit/);
    assert.throws(() => encode(-1n, 8), RangeError);
    for (const value of [1, 0, '1', null, undefined, {}, true]) {
      assert.throws(() => encode(value, 8), RangeError);
    }
  }
});

test('invalid widths and excessive inputs are bounded before allocation', () => {
  for (const encode of [toBufferLE, toBufferBE]) {
    for (const width of [-1, 1.5, 1025, Number.MAX_SAFE_INTEGER, Infinity, NaN, '8', null, undefined]) {
      assert.throws(() => encode(1n, width), RangeError);
    }
  }
  for (const decode of [toBigIntLE, toBigIntBE]) {
    for (const input of [Buffer.alloc(1025), new Uint8Array(8), [], 'ff', null, undefined]) {
      assert.throws(() => decode(input), RangeError);
    }
  }
});

test('decoding respects Buffer view offsets and never mutates the source', () => {
  const source = Buffer.from('aa01020304bb', 'hex');
  const before = Buffer.from(source);
  const view = source.subarray(1, 5);
  assert.equal(toBigIntBE(view), 0x01020304n);
  assert.equal(toBigIntLE(view), 0x04030201n);
  assert.deepEqual(source, before);
  const first = toBufferLE(1n, 8), second = toBufferLE(1n, 8);
  first.fill(255);
  assert.deepEqual(second, Buffer.from('0100000000000000', 'hex'));
});

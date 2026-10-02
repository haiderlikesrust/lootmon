'use strict';

// Reviewed adaptation of Grailshot's native-addon-free compatibility module.
// Solana SDK layouts use unsigned 8/16/32-byte integers. Reject oversized
// values before allocation; no truncation or native unchecked copies.
const MAX_BYTES = 1024;

function decode(input, littleEndian) {
  if (!Buffer.isBuffer(input) || input.length > MAX_BYTES) {
    throw new RangeError('Invalid integer buffer');
  }
  let value = 0n;
  for (let i = 0; i < input.length; i++) {
    const byte = input[littleEndian ? input.length - i - 1 : i];
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

function encode(value, width, littleEndian) {
  if (typeof value !== 'bigint' || value < 0n || !Number.isSafeInteger(width) || width < 0 || width > MAX_BYTES) {
    throw new RangeError('Invalid unsigned integer');
  }
  if (value >= (1n << BigInt(width * 8))) {
    throw new RangeError('Integer does not fit in buffer');
  }
  const result = Buffer.alloc(width);
  for (let i = 0; i < width; i++) {
    result[littleEndian ? i : width - i - 1] = Number(value & 255n);
    value >>= 8n;
  }
  return result;
}

exports.toBigIntLE = input => decode(input, true);
exports.toBigIntBE = input => decode(input, false);
exports.toBufferLE = (value, width) => encode(value, width, true);
exports.toBufferBE = (value, width) => encode(value, width, false);

import { isIP } from 'node:net';

export function clientAddress(request, trustedHops = 0) {
  const peer = request.socket.remoteAddress ?? 'unknown';
  if (!Number.isInteger(trustedHops) || trustedHops < 1 || trustedHops > 2) return peer;
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded !== 'string') return peer;
  const addresses = forwarded.split(',').map(value => value.trim());
  // The game port must stay private when trusting a fixed reverse-proxy chain.
  // Choose from the right so client-supplied prefixes cannot alter the limiter.
  if (addresses.length < trustedHops || addresses.some(value => !isIP(value))) return peer;
  return addresses.at(-trustedHops);
}

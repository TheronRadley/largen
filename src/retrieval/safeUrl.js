/**
 * URL safety checks. Largen fetches pages chosen by search results, which are untrusted.
 * We only allow http(s) to public addresses, so a crafted result cannot reach
 * localhost, the LAN, or cloud metadata endpoints (SSRF).
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import { PageError } from '../errors.js';

export function parseHttpUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (!url.hostname || url.hostname.length > 253) return null;
  return url;
}

function isPrivateV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower.startsWith('::ffff:')) {
      const v4 = lower.slice(7);
      if (net.isIPv4(v4)) return isPrivateV4(v4);
    }
    if (lower === '::' || lower === '::1') return true;
    const first = parseInt(lower.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return true; // multicast
    return false;
  }
  return true; // not an IP at all: treat as unsafe
}

/**
 * Throws PageError('blocked_host') if the hostname is or resolves to a non-public address.
 */
export async function assertPublicHost(hostname, { allowPrivate = false, lookup = dns.lookup } = {}) {
  if (allowPrivate) return;
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const blocked = () => new PageError(`Blocked non-public host: ${hostname}`, 'blocked_host');

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw blocked();
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw blocked();
    return;
  }
  let addresses;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new PageError(`DNS lookup failed for ${hostname}`, 'dns_failed');
  }
  if (!addresses.length || addresses.some((a) => isPrivateIp(a.address))) throw blocked();
}

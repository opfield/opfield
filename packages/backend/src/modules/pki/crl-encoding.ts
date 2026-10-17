import { x509 } from '@/lib/x509.js';

/** RFC 5280 5.2.3 CRL Number. */
export const CRL_NUMBER_OID = '2.5.29.20';
/** RFC 5280 5.2.1 Authority Key Identifier. */
export const AUTHORITY_KEY_IDENTIFIER_OID = '2.5.29.35';

/**
 * Content octets of a certificate serial as a positive DER INTEGER.
 *
 * Serials are stored as unsigned hex. The CRL generator writes the hex bytes
 * as they are, and DER reads a first byte of 0x80 or more as a negative number,
 * so CRL-checking clients compared a negative serial with the certificate's
 * positive one and accepted revoked certificates. This keeps the value
 * positive (leading 0x00 when the high bit is set) and minimal (no redundant
 * leading zero bytes), the same encoding the certificate itself carries.
 */
export function crlSerialHex(serial: string): string {
  let hex = serial.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (!hex) throw new Error(`Certificate serial "${serial}" has no hex digits`);
  if (hex.length % 2) hex = `0${hex}`;
  while (hex.length > 2 && hex.startsWith('00')) hex = hex.slice(2);
  if (Number.parseInt(hex.slice(0, 2), 16) >= 0x80) hex = `00${hex}`;
  return hex;
}

/** DER encoding (tag, length, content) of a non-negative INTEGER. */
export function derPositiveInteger(value: bigint | number): ArrayBuffer {
  const n = BigInt(value);
  if (n < 0n) throw new Error('derPositiveInteger takes a non-negative value');
  const content = Buffer.from(crlSerialHex(n.toString(16)), 'hex');
  let length = Buffer.from([content.length]);
  if (content.length >= 0x80) {
    const lengthHex = content.length.toString(16);
    const lengthBytes = Buffer.from(lengthHex.length % 2 ? `0${lengthHex}` : lengthHex, 'hex');
    length = Buffer.concat([Buffer.from([0x80 | lengthBytes.length]), lengthBytes]);
  }
  const der = Buffer.concat([Buffer.from([0x02]), length, content]);
  return der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) as ArrayBuffer;
}

/**
 * A stored CRL written by an older release: it lists a serial as a negative
 * INTEGER, or lacks the CRL Number / Authority Key Identifier extensions that
 * RFC 5280 requires. Such a CRL is signed again on startup.
 */
export function crlNeedsRepublish(crlDer: Buffer | string): boolean {
  try {
    const der = typeof crlDer === 'string' ? Buffer.from(crlDer, 'base64') : crlDer;
    const crl = new x509.X509Crl(der);
    const types = new Set(crl.extensions.map((extension) => extension.type));
    if (!types.has(CRL_NUMBER_OID) || !types.has(AUTHORITY_KEY_IDENTIFIER_OID)) return true;
    return crl.entries.some((entry) => Number.parseInt(entry.serialNumber.slice(0, 2), 16) >= 0x80);
  } catch {
    // Unreadable: signing a fresh one is the repair.
    return true;
  }
}

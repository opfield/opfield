import crypto from 'node:crypto';
import * as x509 from '@peculiar/x509';

x509.cryptoProvider.set(crypto.webcrypto as any);

export { x509 };

/**
 * A value inside a string name such as `CN=<value>`. x509.Name parses that string, so a comma in the value ended the
 * attribute and whatever followed became attributes of the issued certificate (`a, O=Other`), and a leading # was
 * read as hex. Control characters cannot be expressed and are refused by the schemas (certificateNameText).
 */
export function x509DnValue(value: string): string {
  return value.replace(/[\\",+;<>=#]/g, '\\$&');
}

/** The text of a value written by x509DnValue, as read back from a stored subject. */
export function x509DnText(value: string): string {
  return value.replace(/\\([\\",+;<>=#])/g, '$1');
}

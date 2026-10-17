import crypto from 'node:crypto';
import { createChildLogger } from '@/lib/logger.js';

const _logger = createChildLogger('CryptoService');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export class CryptoService {
  private readonly masterKey: Buffer;

  constructor(masterKeyHex: string) {
    this.masterKey = Buffer.from(masterKeyHex, 'hex');
    if (this.masterKey.length !== 32) {
      throw new Error('PKI_MASTER_KEY must be exactly 32 bytes (64 hex chars)');
    }
  }

  /**
   * Encrypt a private key using envelope encryption.
   * 1. Generate a random DEK (Data Encryption Key)
   * 2. Encrypt the private key with the DEK using AES-256-GCM
   * 3. Encrypt the DEK with the master key using AES-256-GCM
   */
  encryptPrivateKey(privateKeyPem: string): {
    encryptedPrivateKey: string; // base64(iv + authTag + ciphertext)
    encryptedDek: string; // base64(iv + authTag + ciphertext)
    dekIv: string; // base64 (unused legacy field, kept for schema compat)
  } {
    // Generate random DEK
    const dek = crypto.randomBytes(32);

    // Encrypt private key with DEK
    const encryptedPrivateKey = this.aesEncrypt(Buffer.from(privateKeyPem, 'utf-8'), dek);

    // Encrypt DEK with master key
    const encryptedDek = this.aesEncrypt(dek, this.masterKey);

    return {
      encryptedPrivateKey: encryptedPrivateKey.toString('base64'),
      encryptedDek: encryptedDek.toString('base64'),
      dekIv: '', // IV is prepended to ciphertext
    };
  }

  /**
   * Decrypt a private key using envelope encryption.
   */
  decryptPrivateKey(encrypted: { encryptedPrivateKey: string; encryptedDek: string; dekIv: string }): string {
    // Decrypt DEK with master key
    const dek = this.aesDecrypt(Buffer.from(encrypted.encryptedDek, 'base64'), this.masterKey);

    // Decrypt private key with DEK
    const privateKeyBuffer = this.aesDecrypt(Buffer.from(encrypted.encryptedPrivateKey, 'base64'), dek);

    return privateKeyBuffer.toString('utf-8');
  }

  /**
   * Generate an RSA key pair.
   */
  generateRSAKeyPair(bits: 2048 | 4096): { publicKeyPem: string; privateKeyPem: string } {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: bits,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    return { publicKeyPem: publicKey, privateKeyPem: privateKey };
  }

  /**
   * Generate an ECDSA key pair.
   */
  generateECDSAKeyPair(curve: 'P-256' | 'P-384'): { publicKeyPem: string; privateKeyPem: string } {
    const namedCurve = curve === 'P-256' ? 'prime256v1' : 'secp384r1';
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
      namedCurve,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    return { publicKeyPem: publicKey, privateKeyPem: privateKey };
  }

  /**
   * Generate a key pair based on algorithm string.
   */
  generateKeyPair(algorithm: string): { publicKeyPem: string; privateKeyPem: string } {
    switch (algorithm) {
      case 'rsa-2048':
        return this.generateRSAKeyPair(2048);
      case 'rsa-4096':
        return this.generateRSAKeyPair(4096);
      case 'ecdsa-p256':
        return this.generateECDSAKeyPair('P-256');
      case 'ecdsa-p384':
        return this.generateECDSAKeyPair('P-384');
      default:
        throw new Error(`Unsupported key algorithm: ${algorithm}`);
    }
  }

  /**
   * Generate a unique serial number (20 bytes as hex).
   */
  generateSerialNumber(): string {
    // A positive DER INTEGER of at most 20 octets (RFC 5280 4.1.2.2): with the high bit clear the certificate needs no
    // leading zero byte, and a non-zero first byte keeps the stored hex equal to the serial the certificate carries.
    const bytes = crypto.randomBytes(20);
    bytes[0] = bytes[0] & 0x7f || 0x01;
    return bytes.toString('hex');
  }

  /**
   * Compute SHA-256 fingerprint of a DER-encoded certificate.
   */
  sha256Fingerprint(data: Buffer): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Compute SHA-1 fingerprint of a DER-encoded certificate.
   */
  sha1Fingerprint(data: Buffer): string {
    return crypto.createHash('sha1').update(data).digest('hex');
  }

  /** Derive a compartmentalized, non-reversible key for a daemon-owned config. */
  deriveScopedSecret(context: string): string {
    return crypto.createHmac('sha256', this.masterKey).update(context).digest('hex');
  }

  // --- String encryption (for API keys, secrets) ---

  /**
   * Encrypt an arbitrary string using envelope encryption.
   * Returns the encrypted data components for storage.
   */
  encryptString(plaintext: string): { encryptedKey: string; encryptedDek: string } {
    const dek = crypto.randomBytes(32);
    const encryptedData = this.aesEncrypt(Buffer.from(plaintext, 'utf-8'), dek);
    const encryptedDek = this.aesEncrypt(dek, this.masterKey);
    return {
      encryptedKey: encryptedData.toString('base64'),
      encryptedDek: encryptedDek.toString('base64'),
    };
  }

  /**
   * Decrypt a string that was encrypted with encryptString().
   */
  decryptString(encrypted: { encryptedKey: string; encryptedDek: string }): string {
    const dek = this.aesDecrypt(Buffer.from(encrypted.encryptedDek, 'base64'), this.masterKey);
    const data = this.aesDecrypt(Buffer.from(encrypted.encryptedKey, 'base64'), dek);
    return data.toString('utf-8');
  }

  // --- Internal AES-256-GCM helpers ---

  private aesEncrypt(plaintext: Buffer, key: Buffer): Buffer {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // Format: IV (12) + AuthTag (16) + Ciphertext
    return Buffer.concat([iv, authTag, encrypted]);
  }

  private aesDecrypt(data: Buffer, key: Buffer): Buffer {
    const iv = data.subarray(0, IV_LENGTH);
    const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}

import { beforeAll, describe, expect, it } from 'vitest';
import { CryptoService } from './crypto.service.js';

describe('CryptoService', () => {
  let cryptoService: CryptoService;
  const TEST_MASTER_KEY = 'a'.repeat(64); // 32 bytes hex

  beforeAll(() => {
    cryptoService = new CryptoService(TEST_MASTER_KEY);
  });

  describe('constructor', () => {
    it('should accept a valid 64-char hex master key', () => {
      expect(() => new CryptoService('ab'.repeat(32))).not.toThrow();
    });

    it('should reject a key that is too short', () => {
      expect(() => new CryptoService('abcd')).toThrow('PKI_MASTER_KEY must be exactly 32 bytes');
    });
  });

  describe('envelope encryption', () => {
    it('should encrypt and decrypt a private key round-trip', () => {
      const originalKey = '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBg...\n-----END PRIVATE KEY-----';

      const encrypted = cryptoService.encryptPrivateKey(originalKey);

      expect(encrypted.encryptedPrivateKey).toBeTruthy();
      expect(encrypted.encryptedDek).toBeTruthy();
      expect(encrypted.encryptedPrivateKey).not.toBe(originalKey);

      const decrypted = cryptoService.decryptPrivateKey(encrypted);
      expect(decrypted).toBe(originalKey);
    });

    it('should produce different ciphertexts for the same plaintext (random DEK)', () => {
      const key = 'test-private-key-content';

      const encrypted1 = cryptoService.encryptPrivateKey(key);
      const encrypted2 = cryptoService.encryptPrivateKey(key);

      expect(encrypted1.encryptedPrivateKey).not.toBe(encrypted2.encryptedPrivateKey);
      expect(encrypted1.encryptedDek).not.toBe(encrypted2.encryptedDek);

      // Both should decrypt to the same value
      expect(cryptoService.decryptPrivateKey(encrypted1)).toBe(key);
      expect(cryptoService.decryptPrivateKey(encrypted2)).toBe(key);
    });

    it('should fail decryption with a different master key', () => {
      const key = 'sensitive-private-key';
      const encrypted = cryptoService.encryptPrivateKey(key);

      const otherService = new CryptoService('b'.repeat(64));
      expect(() => otherService.decryptPrivateKey(encrypted)).toThrow();
    });

    it('should handle empty string encryption', () => {
      const encrypted = cryptoService.encryptPrivateKey('');
      const decrypted = cryptoService.decryptPrivateKey(encrypted);
      expect(decrypted).toBe('');
    });

    it('should handle large payloads', () => {
      const largeKey = 'x'.repeat(10000);
      const encrypted = cryptoService.encryptPrivateKey(largeKey);
      const decrypted = cryptoService.decryptPrivateKey(encrypted);
      expect(decrypted).toBe(largeKey);
    });
  });

  describe('key pair generation', () => {
    it('should generate RSA-2048 key pair', () => {
      const { publicKeyPem, privateKeyPem } = cryptoService.generateRSAKeyPair(2048);

      expect(publicKeyPem).toContain('-----BEGIN PUBLIC KEY-----');
      expect(privateKeyPem).toContain('-----BEGIN PRIVATE KEY-----');
    });

    it('should generate RSA-4096 key pair', () => {
      const { publicKeyPem, privateKeyPem } = cryptoService.generateRSAKeyPair(4096);

      expect(publicKeyPem).toContain('-----BEGIN PUBLIC KEY-----');
      expect(privateKeyPem).toContain('-----BEGIN PRIVATE KEY-----');
    });

    it('should generate ECDSA P-256 key pair', () => {
      const { publicKeyPem, privateKeyPem } = cryptoService.generateECDSAKeyPair('P-256');

      expect(publicKeyPem).toContain('-----BEGIN PUBLIC KEY-----');
      expect(privateKeyPem).toContain('-----BEGIN PRIVATE KEY-----');
    });

    it('should generate ECDSA P-384 key pair', () => {
      const { publicKeyPem, privateKeyPem } = cryptoService.generateECDSAKeyPair('P-384');

      expect(publicKeyPem).toContain('-----BEGIN PUBLIC KEY-----');
      expect(privateKeyPem).toContain('-----BEGIN PRIVATE KEY-----');
    });

    it('should generate unique key pairs each time', () => {
      const pair1 = cryptoService.generateECDSAKeyPair('P-256');
      const pair2 = cryptoService.generateECDSAKeyPair('P-256');

      expect(pair1.publicKeyPem).not.toBe(pair2.publicKeyPem);
      expect(pair1.privateKeyPem).not.toBe(pair2.privateKeyPem);
    });

    it('should generate key pair by algorithm string', () => {
      const algorithms = ['rsa-2048', 'ecdsa-p256', 'ecdsa-p384'];

      for (const algo of algorithms) {
        const { publicKeyPem, privateKeyPem } = cryptoService.generateKeyPair(algo);
        expect(publicKeyPem).toContain('-----BEGIN PUBLIC KEY-----');
        expect(privateKeyPem).toContain('-----BEGIN PRIVATE KEY-----');
      }
    });

    it('should throw for unsupported algorithm', () => {
      expect(() => cryptoService.generateKeyPair('rsa-1024')).toThrow('Unsupported key algorithm');
    });
  });

  describe('serial number generation', () => {
    it('should generate a hex serial number', () => {
      const serial = cryptoService.generateSerialNumber();

      expect(serial).toMatch(/^[0-9a-f]+$/);
      expect(serial.length).toBe(40); // 20 bytes = 40 hex chars
    });

    it('keeps the serial a positive 20-octet integer with no leading zero byte', () => {
      for (let i = 0; i < 200; i++) {
        const first = Number.parseInt(cryptoService.generateSerialNumber().slice(0, 2), 16);
        expect(first).toBeGreaterThan(0);
        expect(first).toBeLessThan(0x80);
      }
    });

    it('should generate unique serial numbers', () => {
      const serials = new Set(Array.from({ length: 100 }, () => cryptoService.generateSerialNumber()));
      expect(serials.size).toBe(100);
    });
  });

  describe('fingerprints', () => {
    it('should compute SHA-256 fingerprint', () => {
      const data = Buffer.from('test certificate data');
      const fingerprint = cryptoService.sha256Fingerprint(data);

      expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should compute SHA-1 fingerprint', () => {
      const data = Buffer.from('test certificate data');
      const fingerprint = cryptoService.sha1Fingerprint(data);

      expect(fingerprint).toMatch(/^[0-9a-f]{40}$/);
    });

    it('should produce consistent fingerprints for same input', () => {
      const data = Buffer.from('consistent data');

      expect(cryptoService.sha256Fingerprint(data)).toBe(cryptoService.sha256Fingerprint(data));
      expect(cryptoService.sha1Fingerprint(data)).toBe(cryptoService.sha1Fingerprint(data));
    });
  });

  describe('encrypt then decrypt key pair round-trip', () => {
    it('should encrypt a generated RSA key and decrypt it back', () => {
      const { privateKeyPem } = cryptoService.generateRSAKeyPair(2048);

      const encrypted = cryptoService.encryptPrivateKey(privateKeyPem);
      const decrypted = cryptoService.decryptPrivateKey(encrypted);

      expect(decrypted).toBe(privateKeyPem);
    });

    it('should encrypt a generated ECDSA key and decrypt it back', () => {
      const { privateKeyPem } = cryptoService.generateECDSAKeyPair('P-256');

      const encrypted = cryptoService.encryptPrivateKey(privateKeyPem);
      const decrypted = cryptoService.decryptPrivateKey(encrypted);

      expect(decrypted).toBe(privateKeyPem);
    });
  });
});

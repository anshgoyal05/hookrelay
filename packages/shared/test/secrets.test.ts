import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  generateSigningSecret,
  encryptSigningSecret,
  decryptSigningSecret,
} from "../src/crypto/secrets.js";

describe("packages/shared - Outbound Signing Secret Encryption", () => {
  const validKey = crypto.randomBytes(32).toString("hex");
  const alternateKey = crypto.randomBytes(32).toString("hex");
  const endpointId = crypto.randomUUID();
  const otherEndpointId = crypto.randomUUID();

  it("generates a signing secret with whsec_ prefix and high entropy", () => {
    const secret = generateSigningSecret();
    expect(secret.startsWith("whsec_")).toBe(true);

    const base64Part = secret.slice("whsec_".length);
    const decodedBytes = Buffer.from(base64Part, "base64");
    expect(decodedBytes.length).toBe(32);

    // Assert high randomness across multiple calls
    const secret2 = generateSigningSecret();
    expect(secret).not.toBe(secret2);
  });

  it("encrypts and decrypts round-trip with endpoint UUID as AAD", () => {
    const secret = generateSigningSecret();
    const encrypted = encryptSigningSecret(secret, validKey, endpointId);

    // Stored column MUST NEVER start with whsec_
    expect(encrypted.startsWith("whsec_")).toBe(false);
    expect(encrypted.startsWith("v1:k1:")).toBe(true);

    const decrypted = decryptSigningSecret(encrypted, validKey, endpointId);
    expect(decrypted).toBe(secret);
  });

  it("uses a fresh random IV every time for the same plaintext", () => {
    const secret = generateSigningSecret();
    const enc1 = encryptSigningSecret(secret, validKey, endpointId);
    const enc2 = encryptSigningSecret(secret, validKey, endpointId);

    expect(enc1).not.toBe(enc2);
    // IVs should be different
    const iv1 = enc1.split(":")[2];
    const iv2 = enc2.split(":")[2];
    expect(iv1).not.toBe(iv2);
  });

  it("rejects decryption if the Additional Authenticated Data (AAD / endpointId) is mismatched", () => {
    const secret = generateSigningSecret();
    const encrypted = encryptSigningSecret(secret, validKey, endpointId);

    expect(() => {
      decryptSigningSecret(encrypted, validKey, otherEndpointId);
    }).toThrow();
  });

  it("rejects decryption if ciphertext has been tampered with", () => {
    const secret = generateSigningSecret();
    const encrypted = encryptSigningSecret(secret, validKey, endpointId);

    const parts = encrypted.split(":");
    // Tamper with ciphertext by flipping last hex char
    const lastChar = parts[4].slice(-1);
    const flipped = lastChar === "a" ? "b" : "a";
    parts[4] = parts[4].slice(0, -1) + flipped;
    const tampered = parts.join(":");

    expect(() => {
      decryptSigningSecret(tampered, validKey, endpointId);
    }).toThrow();
  });

  it("rejects decryption if wrong key is used", () => {
    const secret = generateSigningSecret();
    const encrypted = encryptSigningSecret(secret, validKey, endpointId);

    expect(() => {
      decryptSigningSecret(encrypted, alternateKey, endpointId);
    }).toThrow();
  });

  it("rejects invalid key length or format", () => {
    const secret = generateSigningSecret();
    expect(() => {
      encryptSigningSecret(secret, "short_key", endpointId);
    }).toThrow(/64-character hex/);

    expect(() => {
      decryptSigningSecret("v1:k1:aa:bb:cc", "short_key", endpointId);
    }).toThrow(/64-character hex/);
  });
});

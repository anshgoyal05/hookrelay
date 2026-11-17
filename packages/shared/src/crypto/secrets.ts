import crypto from "node:crypto";

export interface EncryptOptions {
  keyId?: string;
}

/**
 * Generates an outbound webhook signing secret.
 * Format: whsec_ + 32 random bytes in base64.
 */
export function generateSigningSecret(): string {
  const bytes = crypto.randomBytes(32).toString("base64");
  return `whsec_${bytes}`;
}

/**
 * Encrypts a signing secret at rest using AES-256-GCM.
 * Uses the endpoint UUID as Additional Authenticated Data (AAD) to prevent ciphertext swapping.
 * Format: v1:<keyId>:<iv_hex>:<tag_hex>:<ciphertext_hex>
 */
export function encryptSigningSecret(
  secret: string,
  keyHex: string,
  endpointId: string,
  options?: EncryptOptions,
): string {
  if (!keyHex || keyHex.length !== 64) {
    throw new Error("Encryption key must be a 64-character hex string (32 bytes)");
  }

  const keyId = options?.keyId ?? "k1";
  const key = Buffer.from(keyHex, "hex");
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(endpointId, "utf8"));

  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `v1:${keyId}:${iv.toString("hex")}:${tag.toString("hex")}:${ciphertext.toString("hex")}`;
}

/**
 * Decrypts a signing secret encrypted with AES-256-GCM.
 * Validates the endpoint UUID via GCM Additional Authenticated Data (AAD).
 */
export function decryptSigningSecret(
  encryptedString: string,
  keyHex: string,
  endpointId: string,
): string {
  if (!keyHex || keyHex.length !== 64) {
    throw new Error("Encryption key must be a 64-character hex string (32 bytes)");
  }

  const parts = encryptedString.split(":");
  if (parts.length !== 5 || parts[0] !== "v1") {
    throw new Error("Unsupported or invalid ciphertext format");
  }

  const ivHex = parts[2];
  const tagHex = parts[3];
  const ciphertextHex = parts[4];
  if (!ivHex || !tagHex || !ciphertextHex) {
    throw new Error("Invalid ciphertext structure");
  }

  const key = Buffer.from(keyHex, "hex");
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(endpointId, "utf8"));
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

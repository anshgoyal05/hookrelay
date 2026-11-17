import crypto from "node:crypto";

export const API_KEY_FORMAT_REGEX = /^hr_live_[0-9a-f]{16}_[0-9a-f]{64}$/;

// Pre-computed 32-byte dummy buffer designed to avoid obvious timing differences
const DUMMY_SECRET = "0000000000000000000000000000000000000000000000000000000000000000";
export const DUMMY_HASH_BUFFER = crypto.createHash("sha256").update(DUMMY_SECRET).digest();

export interface GeneratedApiKey {
  key: string;
  prefix: string;
  secret: string;
  hash: string;
}

export type ParsedApiKey =
  | {
      valid: true;
      prefix: string;
      secret: string;
      hash: string;
      hashBuffer: Buffer;
    }
  | {
      valid: false;
    };

/**
 * Generates a high-entropy API key.
 * Shape: hr_live_<16_hex_prefix>_<64_hex_secret>
 */
export function generateApiKey(): GeneratedApiKey {
  const prefix = crypto.randomBytes(8).toString("hex");
  const secret = crypto.randomBytes(32).toString("hex");
  const key = `hr_live_${prefix}_${secret}`;
  const hash = crypto.createHash("sha256").update(secret).digest("hex");

  return {
    key,
    prefix,
    secret,
    hash,
  };
}

/**
 * Parses and validates the structural format of an API key.
 */
export function parseApiKey(rawKey: string): ParsedApiKey {
  if (typeof rawKey !== "string" || !API_KEY_FORMAT_REGEX.test(rawKey)) {
    return { valid: false };
  }

  const parts = rawKey.split("_");
  const prefix = parts[2];
  const secret = parts[3];

  if (!prefix || !secret) {
    return { valid: false };
  }

  const hashBuffer = crypto.createHash("sha256").update(secret).digest();
  const hash = hashBuffer.toString("hex");

  return {
    valid: true,
    prefix,
    secret,
    hash,
    hashBuffer,
  };
}

/**
 * Compares an incoming secret against a stored hash using timingSafeEqual.
 */
export function verifyApiKeySecret(storedHashHex: string, actualHashBuffer: Buffer): boolean {
  try {
    const storedBuffer = Buffer.from(storedHashHex, "hex");
    if (storedBuffer.length !== actualHashBuffer.length) {
      return false;
    }
    return crypto.timingSafeEqual(storedBuffer, actualHashBuffer);
  } catch {
    return false;
  }
}

/**
 * Performs a dummy timing-safe comparison designed to avoid obvious timing differences
 * when an API key prefix does not exist in the database.
 */
export function performDummyComparison(hashBuffer: Buffer): boolean {
  try {
    crypto.timingSafeEqual(DUMMY_HASH_BUFFER, hashBuffer);
    return false;
  } catch {
    return false;
  }
}

/**
 * Constant-time comparison for admin bearer token.
 * Compares SHA-256 digests to ensure fixed 32-byte lengths.
 */
export function verifyAdminToken(incomingToken: string, expectedAdminToken: string): boolean {
  if (!incomingToken || !expectedAdminToken || expectedAdminToken.length < 32) {
    return false;
  }

  const incomingDigest = crypto.createHash("sha256").update(incomingToken).digest();
  const expectedDigest = crypto.createHash("sha256").update(expectedAdminToken).digest();

  return crypto.timingSafeEqual(incomingDigest, expectedDigest);
}

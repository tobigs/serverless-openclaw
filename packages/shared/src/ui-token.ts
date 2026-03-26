import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_TTL_MS = 60_000; // 60 seconds

/**
 * Generate a short-lived signed UI access token.
 *
 * Format: `{random}.{timestamp}.{hmac}`
 * - random: 32-char hex nonce (unique per request)
 * - timestamp: Unix ms at generation time
 * - hmac: HMAC-SHA256(bridgeAuthToken, "${random}.${timestamp}") as hex
 *
 * The bridge auth token acts as the HMAC key so only the container that
 * knows the same secret can validate it — without exposing the bearer
 * credential itself in the URL.
 */
export function generateUiToken(bridgeAuthToken: string): string {
  const random = randomBytes(16).toString("hex");
  const ts = String(Date.now());
  const hmac = createHmac("sha256", bridgeAuthToken)
    .update(`${random}.${ts}`)
    .digest("hex");
  return `${random}.${ts}.${hmac}`;
}

/**
 * Validate a UI access token.
 *
 * Returns true only if:
 * 1. The token is well-formed (3 dot-separated parts)
 * 2. The timestamp is within TOKEN_TTL_MS of now
 * 3. The HMAC is correct (timing-safe comparison)
 * 4. The nonce has not been used before (single-use via usedTokens set)
 *
 * On success the nonce is added to usedTokens, consuming the token.
 */
export function validateUiToken(
  token: string,
  bridgeAuthToken: string,
  usedTokens: Set<string>,
): boolean {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const [random, ts, signature] = parts;

    // Expiry check
    if (Date.now() - Number(ts) > TOKEN_TTL_MS) return false;

    // HMAC verification
    const expected = createHmac("sha256", bridgeAuthToken)
      .update(`${random}.${ts}`)
      .digest("hex");
    if (signature.length !== expected.length) return false;
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;

    // Single-use check
    if (usedTokens.has(random)) return false;
    usedTokens.add(random);

    return true;
  } catch {
    return false;
  }
}

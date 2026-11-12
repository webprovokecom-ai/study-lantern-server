// Activation codes: a small signed note saying "user X has Student until date Y".
// The Study Lantern page checks the signature with the public key, so codes can't be made up.
import crypto from "node:crypto";

const GRACE_SECONDS = 3 * 24 * 3600; // a little slack so a renewal has time to go through
const b64url = buf => Buffer.from(buf).toString("base64url");

function privateKey() {
  const k = process.env.ACTIVATION_PRIVATE_KEY;
  if (!k) throw new Error('ACTIVATION_PRIVATE_KEY is missing. Run "npm run keys".');
  return crypto.createPrivateKey({ key: Buffer.from(k, "base64"), format: "der", type: "pkcs8" });
}

export function makeCode(userId, periodEnd) {
  const payload = { u: userId, p: "student", exp: periodEnd + GRACE_SECONDS, iat: Math.floor(Date.now() / 1000) };
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.sign("sha256", Buffer.from(body), { key: privateKey(), dsaEncoding: "ieee-p1363" });
  return `SL1.${body}.${b64url(sig)}`;
}

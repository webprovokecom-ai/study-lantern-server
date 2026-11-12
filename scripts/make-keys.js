// Creates the key pair that signs activation codes. The private key goes in .env (keep it secret);
// the public key goes into the Study Lantern page so it can check that a code is genuine.
import fs from "node:fs";
import crypto from "node:crypto";
import "dotenv/config";

let priv = process.env.ACTIVATION_PRIVATE_KEY;
if (!priv) {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  priv = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  fs.appendFileSync(".env", `\n# Signs Study Lantern activation codes. Keep secret.\nACTIVATION_PRIVATE_KEY=${priv}\n`);
  console.log("+ new signing key saved to .env");
} else {
  console.log("✓ signing key already in .env");
}
const pub = crypto.createPublicKey(crypto.createPrivateKey({ key: Buffer.from(priv, "base64"), format: "der", type: "pkcs8" }))
  .export({ type: "spki", format: "der" }).toString("base64");
console.log(`\nPublic key for the Study Lantern page:\n${pub}`);

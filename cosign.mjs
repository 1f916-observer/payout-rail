/**
 * Co-sign an existing wallet binding with the citizen's Ed25519 key.
 *
 * Run after bankr-sign.mjs. Takes the receipt it wrote, adds the citizen half,
 * and writes it back — so the finished receipt answers both questions:
 * who controls the address, and which citizen authorised the payment.
 *
 *   node cosign.mjs receipt.bankr.local.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, sign as edSign } from "node:crypto";
import { verifyBinding, verifyCitizenSignature } from "./binding.mjs";

const KEYFILE = "C:/Developer/1f916/.1f916-credentials-ed25519.json";
const path = process.argv[2] || "receipt.json";

const b64u = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const receipt = JSON.parse(readFileSync(path, "utf8"));
const key = JSON.parse(readFileSync(KEYFILE, "utf8"));

if (key.handle !== receipt.handle) {
  console.error(`the key belongs to ${key.handle} but the binding names ${receipt.handle}`);
  console.error("refusing to co-sign a binding for a citizen this key does not represent.");
  process.exit(1);
}

// Sign the SAME preimage the wallet signed. Two signatures over one string means
// there is no second document to disagree with the first.
const sig = edSign(null, Buffer.from(receipt.preimage, "utf8"), createPrivateKey(key.private_key_pkcs8_pem));

receipt.citizen_public_key = key.public_key_b64url;
receipt.citizen_signature = b64u(sig);
receipt.citizen_key_note =
  "Ed25519, bound to this handle on the society's identity chain. Verify independently: GET https://1f916.ai/api/keys/" + receipt.handle;
receipt.how_to_verify =
  "node verify.mjs <file> — recovers the payout address from the wallet signature and checks the citizen signature " +
  "against the Ed25519 key the society publishes for this handle. Needs no API key and no account.";

writeFileSync(path, JSON.stringify(receipt, null, 2) + "\n");
console.log(`co-signed ${path}`);
console.log("  citizen        :", receipt.handle);
console.log("  citizen key    :", receipt.citizen_public_key);

const wallet = await verifyBinding({ ...receipt, amountAtomic: BigInt(receipt.amount_atomic), chainId: receipt.chain_id });
const citizen = await verifyCitizenSignature({ ...receipt, amountAtomic: BigInt(receipt.amount_atomic), chainId: receipt.chain_id });
console.log("\n  wallet signature :", wallet.ok ? "verifies, recovers " + wallet.recovered : "FAILED: " + wallet.reason);
console.log("  citizen signature:", citizen.ok ? "verifies" : "FAILED: " + (citizen.reason || ""));
if (citizen.published?.checked) {
  console.log("  registry check   :", citizen.published.ok
    ? `the society publishes this key (thumbprint ${citizen.published.thumbprint}, custody ${citizen.published.custody})`
    : citizen.published.reason);
}

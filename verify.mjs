/**
 * The keyless verifier. This is the half that matters.
 *
 * A stranger runs this against a published receipt and learns, without holding a
 * citizen key, a Bankr account, or any credential at all, whether the agent that
 * signed it actually controls the address the payment would go to.
 *
 * No network calls. No API key. Nothing to trust except the arithmetic, which
 * runs on this machine.
 *
 *   node verify.mjs receipt.json
 *
 * Exit 0 = the binding holds. Exit 1 = it does not, with the reason named.
 */
import { readFileSync } from "node:fs";
import { verifyBinding, bindingPreimage } from "./binding.mjs";

const path = process.argv[2] || "receipt.json";
let r;
try {
  r = JSON.parse(readFileSync(path, "utf8"));
} catch (e) {
  console.error(`Could not read ${path}: ${e.message}`);
  process.exit(2);
}

const binding = {
  handle: r.handle,
  row: r.row,
  amountAtomic: BigInt(r.amount_atomic),
  chainId: r.chain_id,
  token: r.token,
  address: r.address,
  expiry: r.expiry,
  signature: r.signature,
};

console.log(`payout binding — verifying ${path}\n`);
console.log(`  citizen        : ${r.handle}`);
console.log(`  docket row     : ${r.row}`);
console.log(`  amount         : ${r.amount_display}`);
console.log(`  chain / token  : ${r.chain_id} / ${r.token}`);
console.log(`  expires        : ${r.expiry_utc}`);
console.log("");

// The receipt carries a preimage, but a verifier that trusts it is checking the
// signature against whatever the publisher chose to show. Rebuild it from the
// fields instead, and refuse if the two disagree — that mismatch is the whole
// attack this catches.
let rebuilt;
try {
  rebuilt = bindingPreimage(binding);
} catch (e) {
  console.log(`  DOES NOT MATCH   the receipt's fields are malformed: ${e.message}`);
  process.exit(1);
}
if (r.preimage && r.preimage !== rebuilt) {
  console.log("  DOES NOT MATCH   the published preimage is not what these fields produce");
  console.log(`    published : ${r.preimage}`);
  console.log(`    rebuilt   : ${rebuilt}`);
  console.log("\n  A signature over a string nobody rebuilt proves only that a string was signed.");
  process.exit(1);
}

const verdict = await verifyBinding(binding);

if (verdict.ok) {
  console.log("  RECOMPUTED HERE  the signature recovers the address this payment would go to");
  console.log(`  recovered      : ${verdict.recovered}`);
  console.log("");
  console.log("  What this proves: whoever signed controls that address, and authorised");
  console.log("  exactly this amount, for exactly this row, until the expiry above.");
  console.log("");
  console.log("  What it does NOT prove: that the work was done, that the funder will pay,");
  console.log("  or that the address belongs to a human rather than a script. A binding is");
  console.log("  an authorisation, not a delivery and not a reputation.");
  process.exit(0);
}

console.log(`  DOES NOT MATCH   ${verdict.reason}`);
process.exit(1);

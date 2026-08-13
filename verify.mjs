/**
 * The keyless verifier. This is the half that matters.
 *
 * A stranger runs this against a published receipt and learns, without holding a
 * citizen key, a Bankr account, or any credential at all:
 *
 *   1. whether whoever signed actually controls the address money would go to, and
 *   2. whether the citizen named on the binding authorised it.
 *
 * Add --offline to skip the registry lookup. The answer then degrades honestly to
 * NOT CHECKED HERE rather than pretending the key was confirmed.
 *
 *   node verify.mjs receipt.json [--offline]
 *
 * Exit 0 = the binding holds. Exit 1 = it does not, with the reason named.
 * Exit 2 = the file could not be read.
 */
import { readFileSync } from "node:fs";
import { verifyBinding, bindingPreimage, verifyCitizenSignature } from "./binding.mjs";

const path = process.argv.find((a, i) => i > 1 && !a.startsWith("--")) || "receipt.json";
const offline = process.argv.includes("--offline");

async function main() {
  let r;
  try {
    r = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`Could not read ${path}: ${e.message}`);
    return 2;
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
    citizen_public_key: r.citizen_public_key,
    citizen_signature: r.citizen_signature,
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
  // structured fields and refuse on disagreement — otherwise a receipt could
  // display $1000 beside a signature over $10 and still verify.
  let rebuilt;
  try {
    rebuilt = bindingPreimage(binding);
  } catch (e) {
    console.log(`  DOES NOT MATCH   the receipt's fields are malformed: ${e.message}`);
    return 1;
  }
  if (r.preimage && r.preimage !== rebuilt) {
    console.log("  DOES NOT MATCH   the published preimage is not what these fields produce");
    console.log(`    published : ${r.preimage}`);
    console.log(`    rebuilt   : ${rebuilt}`);
    console.log("\n  A signature over a string nobody rebuilt proves only that a string was signed.");
    return 1;
  }

  // Question one: does the signer control the address?
  const wallet = await verifyBinding(binding);
  if (!wallet.ok) {
    console.log(`  DOES NOT MATCH   wallet signature — ${wallet.reason}`);
    return 1;
  }
  console.log("  RECOMPUTED HERE  the wallet signature recovers the payout address");
  console.log(`  recovered      : ${wallet.recovered}`);

  // Question two: did the citizen agree? A wallet signature alone proves somebody
  // controls an address and typed a handle into a string.
  const citizen = await verifyCitizenSignature(binding, { fetchPublicKey: !offline });
  console.log("");
  if (!citizen.checked) {
    console.log(`  NOT CHECKED HERE the citizen half — ${citizen.reason}`);
    console.log("                   This proves address control only. Anyone can put a handle");
    console.log("                   in a string; without the citizen signature nothing ties");
    console.log("                   this address to that citizen.");
  } else if (!citizen.ok) {
    console.log(`  DOES NOT MATCH   citizen signature — ${citizen.reason}`);
    return 1;
  } else {
    console.log("  RECOMPUTED HERE  the citizen signature verifies over the same preimage");
    const p = citizen.published;
    if (p?.checked && p.ok) {
      console.log(`  registry       : the society publishes this key for ${r.handle}`);
      console.log(`                   thumbprint ${p.thumbprint}, custody ${p.custody}, status ${p.status}`);
    } else if (p?.checked) {
      console.log(`  DOES NOT MATCH   ${p.reason}`);
      return 1;
    } else {
      console.log(`  NOT CHECKED HERE whether this is the key the society publishes — ${p?.reason || "offline"}`);
      console.log("                   The signature is valid for the embedded key. Whether that");
      console.log("                   key is the citizen's is a separate claim, unchecked here.");
    }
  }

  console.log("");
  console.log("  What this proves: whoever signed controls that address, and — where the");
  console.log("  citizen half checks out — that citizen authorised exactly this amount, for");
  console.log("  exactly this row, until the expiry above.");
  console.log("");
  console.log("  What it does NOT prove: that the work was done, that the funder will pay,");
  console.log("  or that the address belongs to a human rather than a script. A binding is");
  console.log("  an authorisation, not a delivery and not a reputation.");
  return 0;
}

// Set exitCode rather than calling process.exit(), so an in-flight fetch handle is
// not torn down mid-close. process.exit() during a pending request trips a libuv
// assertion on Windows, which looks like a crash in a tool whose whole job is to
// look trustworthy.
process.exitCode = await main();

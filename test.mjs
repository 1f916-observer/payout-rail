/**
 * Proves the binding mechanism with a locally generated key. No Bankr account,
 * no network, no money. If this fails, the design is wrong and no amount of
 * integration work saves it.
 *
 * Run: node test.mjs
 */
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { bindingPreimage, verifyBinding, USDC_BASE } from "./binding.mjs";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${detail}`); }
};

const HOUR = 3600;
const now = Math.floor(Date.now() / 1000);
const account = privateKeyToAccount(generatePrivateKey());

const base = {
  handle: "head-of-engineering",
  row: "earning-economy",
  amountAtomic: 10_000_000n,            // $10.00 USDC, 6 decimals
  chainId: USDC_BASE.chainId,
  token: USDC_BASE.token,
  address: account.address,
  expiry: now + 24 * HOUR,
};

console.log("payout binding — self test\n");
console.log("  signer address :", account.address);
console.log("  preimage       :", bindingPreimage(base));
console.log("");

// 1. The happy path.
const sig = await account.signMessage({ message: bindingPreimage(base) });
const good = await verifyBinding({ ...base, signature: sig });
check("a correctly signed binding verifies", good.ok, good.reason || "");
check("it recovers the exact signing address", good.recovered?.toLowerCase() === account.address.toLowerCase());

// 2. Tamper with each scope field in turn. Every one must break the binding,
//    because each exists to stop a specific replay.
for (const [field, mutated] of [
  ["amount",  { amountAtomic: 1_000_000_000n }],   // $10 -> $1000
  ["row",     { row: "treasury-governance" }],
  ["handle",  { handle: "someone-else" }],
  ["chainId", { chainId: 1 }],
  ["token",   { token: "0x0000000000000000000000000000000000000001" }],
]) {
  const v = await verifyBinding({ ...base, ...mutated, signature: sig });
  check(`tampering with ${field} breaks it`, !v.ok, v.ok ? "STILL VERIFIED — replay possible" : "");
}

// 3. A binding for someone else's address must not verify, even correctly signed.
const other = privateKeyToAccount(generatePrivateKey());
const stolen = await verifyBinding({ ...base, address: other.address, signature: sig });
check("a signature cannot claim a different address", !stolen.ok);

// 4. Expiry is enforced, so a binding cannot be collected forever.
const expired = { ...base, expiry: now - 60 };
const expiredSig = await account.signMessage({ message: bindingPreimage(expired) });
const exp = await verifyBinding({ ...expired, signature: expiredSig });
check("an expired binding is refused even though the signature is valid", !exp.ok, exp.ok ? "" : "");
check("  ...and the reason names expiry", /expired/.test(exp.reason || ""));

// 5. Malformed input is refused rather than coerced.
const bad = await verifyBinding({ ...base, address: "not-an-address", signature: sig });
check("a malformed address is refused, not coerced", !bad.ok && /malformed/.test(bad.reason));

// 6. The separator cannot be smuggled through a field to forge a different preimage.
let injected = false;
try { bindingPreimage({ ...base, handle: "a:b" }); } catch { injected = true; }
check("a field containing the separator is rejected", injected);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

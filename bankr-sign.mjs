/**
 * The integration half: a Bankr wallet signs a payout binding, and we recover the
 * address from the signature without ever being told it.
 *
 * This stands in for the PAYEE, not the funder. The question it answers is the one
 * that decides whether the rail is real: can an agent prove which address it
 * controls, to a stranger, without pasting an address anywhere a human reads?
 *
 * Costs nothing and moves nothing. personal_sign is EIP-191; no gas, no balance,
 * no transaction. A wallet with zero funds signs exactly as well as a funded one —
 * which is why the account used here should have nothing in it.
 *
 * Run: node bankr-sign.mjs
 * Needs: C:\Developer\1f916\.bankr-credentials containing a key like bk_...
 */
import { readFileSync, writeFileSync } from "node:fs";
import { bindingPreimage, verifyBinding, USDC_BASE, BINDING_VERSION as BINDING_VERSION_OUT } from "./binding.mjs";

// Both spellings, because an editor that appends .txt on save is not a
// configuration error and should not read as one.
const CRED_PATHS = [
  "C:/Developer/1f916/.bankr-credentials",
  "C:/Developer/1f916/.bankr-credentials.txt",
];
const API = "https://api.bankr.bot";

function apiKey() {
  for (const p of CRED_PATHS) {
    let raw;
    try { raw = readFileSync(p, "utf8"); } catch { continue; }
    const m = raw.match(/bk_[A-Za-z0-9_-]+/);
    if (m) return m[0];
    console.error(`${p} exists but contains no bk_... key.`);
    process.exit(2);
  }
  console.error(`No credential file found. Looked in:\n  ${CRED_PATHS.join("\n  ")}`);
  process.exit(2);
}

async function call(path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: { "X-API-Key": apiKey(), "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 400) }; }
  return { status: res.status, body };
}

const HOUR = 3600;

console.log("payout binding — Bankr integration\n");

// 1. Who are we? The address is READ here so the script can build the preimage,
//    but note what happens next: the verifier never receives it. It gets the
//    signature and derives the address itself.
const me = await call("/wallet/me");
if (me.status !== 200) {
  console.error(`GET /wallet/me -> ${me.status}`, JSON.stringify(me.body).slice(0, 400));
  if (me.status === 401) console.error("\nThe key was rejected. Check it is current and not revoked.");
  process.exit(1);
}
const address =
  me.body.address || me.body.wallet?.address || me.body.evmAddress ||
  me.body.wallets?.find?.((w) => /base|evm|ethereum/i.test(w.chain || w.network || ""))?.address;
if (!address) {
  console.error("Could not find an EVM address in /wallet/me. Raw response:");
  console.error(JSON.stringify(me.body, null, 2).slice(0, 1200));
  process.exit(1);
}
console.log("  wallet address :", address);

// 2. Build the binding. $10 USDC on Base, scoped to one docket row, expiring in 24h.
const binding = {
  handle: "head-of-engineering",
  row: "earning-economy",
  amountAtomic: 10_000_000n,          // $10.00, USDC has 6 decimals
  chainId: USDC_BASE.chainId,
  token: USDC_BASE.token,
  address,
  expiry: Math.floor(Date.now() / 1000) + 24 * HOUR,
};
const preimage = bindingPreimage(binding);
console.log("  preimage       :", preimage);

// 3. Sign it. personal_sign = EIP-191, which is what recoverMessageAddress expects.
const signed = await call("/wallet/sign", {
  method: "POST",
  body: JSON.stringify({ signatureType: "personal_sign", message: preimage }),
});
if (signed.status !== 200 || !signed.body?.signature) {
  console.error(`\nPOST /wallet/sign -> ${signed.status}`, JSON.stringify(signed.body).slice(0, 400));
  if (signed.status === 403) {
    console.error("\n403 usually means one of:");
    console.error("  - the key is readOnly (signing is a WRITE endpoint; regenerate with --read-write)");
    console.error("  - this machine's IP is not on the key's allowlist");
  }
  process.exit(1);
}
console.log("  signature      :", signed.body.signature.slice(0, 26) + "…");
if (signed.body.signer) console.log("  bankr says signer:", signed.body.signer);

// 4. The actual test. Verify with ONLY the signature and the binding fields —
//    exactly what a third party would have.
const verdict = await verifyBinding({ ...binding, signature: signed.body.signature });
console.log("");
if (verdict.ok) {
  console.log("  RECOVERED HERE   the signature recovers the claimed address");
  console.log("  recovered      :", verdict.recovered);
  console.log("  expires        :", verdict.expiresAt);
} else {
  console.log("  DOES NOT MATCH  ", verdict.reason);
  process.exit(1);
}

// 5. And prove it is not a rubber stamp: the same signature over a bigger amount
//    must fail, or the binding is decorative.
const replay = await verifyBinding({ ...binding, amountAtomic: 1_000_000_000n, signature: signed.body.signature });
console.log("");
console.log(replay.ok
  ? "  REPLAY SUCCEEDED — the binding is decorative, do not ship this"
  : "  replay refused    the same signature will not collect $1000 instead of $10");

// 6. Write the receipt. This file is the whole point: it contains no key, no
//    credential and no secret, and it is sufficient for anyone to re-derive the
//    address themselves. Publishing it discloses nothing that reading the chain
//    would not already tell you.
const receipt = {
  version: BINDING_VERSION_OUT,
  handle: binding.handle,
  row: binding.row,
  amount_atomic: binding.amountAtomic.toString(),
  amount_display: `$${(Number(binding.amountAtomic) / 10 ** USDC_BASE.decimals).toFixed(2)} ${USDC_BASE.symbol}`,
  chain_id: binding.chainId,
  token: binding.token,
  address: binding.address,
  expiry: binding.expiry,
  expiry_utc: new Date(binding.expiry * 1000).toISOString(),
  signature: signed.body.signature,
  signed_by: "bankr wallet, personal_sign (EIP-191)",
  preimage,
  how_to_verify:
    "node verify.mjs receipt.json — recovers the address from the signature over `preimage` " +
    "and compares it to `address`. Needs no API key, no account, and no network.",
};
writeFileSync("receipt.json", JSON.stringify(receipt, null, 2) + "\n");
console.log("\n  wrote receipt.json — verifiable by anyone, contains no secret");

process.exit(replay.ok ? 1 : 0);

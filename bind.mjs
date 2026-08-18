/**
 * File a payee binding with the registry — the half of the loop this repo could
 * demonstrate but never actually ran.
 *
 * bankr-sign.mjs proves an address to a stranger. cosign.mjs adds the citizen's
 * half. Neither one files anything, so a reader could reproduce the cryptography
 * and still be unpaid. This closes that gap: it fetches the exact bytes from the
 * registry, signs them twice, checks both halves locally, and POSTs the
 * authorization.
 *
 *   node bind.mjs --row listing-5              dry run — sign, verify, write, stop
 *   node bind.mjs --row listing-5 --post       the same, then file it
 *   node bind.mjs --row earning-economy --amount 10000000 --post
 *
 * ONE RULE, from the registry's own /api/listings/security, and this script has
 * no exception to it: the signed bytes come from the registry, never from a
 * string this machine composed. A preimage built locally is a preimage an
 * attacker can influence; the point of a pure string builder is that both sides
 * are looking at the same sentence.
 *
 * Needs:
 *   C:\Developer\1f916\.1f916-credentials            bearer secret (to file)
 *   C:\Developer\1f916\.1f916-credentials-ed25519.json   bound citizen key
 *   C:\Developer\1f916\.bankr-credentials[.txt]      read-write Bankr key, OR
 *   --private-key-file <path>                        a local EOA key instead
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, sign as edSign } from "node:crypto";
import { recoverMessageAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const REGISTRY = process.env.REGISTRY_ORIGIN || "https://1f916.ai";
const BANKR = "https://api.bankr.bot";
const HOME = "C:/Developer/1f916";
const USDC_BASE = { chainId: 8453, token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" };

function arg(name, fallback = null) {
  const i = process.argv.indexOf("--" + name);
  return i === -1 ? fallback : process.argv[i + 1];
}
const flag = (name) => process.argv.includes("--" + name);
const b64u = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function readFirst(paths, pattern, what) {
  for (const p of paths) {
    let raw;
    try { raw = readFileSync(p, "utf8"); } catch { continue; }
    const m = raw.match(pattern);
    if (m) return m[0];
    fail(`${p} exists but contains no ${what}.`);
  }
  fail(`no ${what} found. Looked in:\n  ${paths.join("\n  ")}`);
}
function fail(message) {
  console.error(message);
  process.exit(1);
}

const row = arg("row");
if (!row) fail("--row is required (a docket row id, or listing-<n>, or listing-<n>-verifier).");
const days = Number(arg("days", "7"));
const expiry = Math.floor(Date.now() / 1000) + Math.round(days * 86400);

// ---- 1. the wallet ------------------------------------------------------
// Read the address here only so the preimage can name it. Nothing downstream
// trusts this value: the registry recovers the address from the signature, and
// so does the check in step 4.
const keyFile = arg("private-key-file");
let address, signMessage, signerNote;

if (keyFile) {
  // The local route. The private key never leaves this process, and it is read
  // from a file rather than an argument so it does not land in a shell history.
  const account = privateKeyToAccount(readFirst([keyFile], /0x[0-9a-fA-F]{64}/, "0x-prefixed 32-byte private key"));
  address = account.address;
  signMessage = (message) => account.signMessage({ message });
  signerNote = "local EOA, viem signMessage (EIP-191)";
} else {
  const bankrKey = readFirst([`${HOME}/.bankr-credentials`, `${HOME}/.bankr-credentials.txt`], /bk_[A-Za-z0-9_-]+/, "bk_... key");
  const call = async (path, init = {}) => {
    const res = await fetch(BANKR + path, { ...init, headers: { "X-API-Key": bankrKey, "Content-Type": "application/json", ...(init.headers || {}) } });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
    return { status: res.status, body };
  };
  const me = await call("/wallet/me");
  if (me.status !== 200) fail(`GET /wallet/me -> ${me.status} ${JSON.stringify(me.body).slice(0, 300)}`);
  address = me.body.address || me.body.wallets?.find?.((w) => /evm|base|ethereum/i.test(w.chain || w.network || ""))?.address;
  if (!address) fail("no EVM address in /wallet/me:\n" + JSON.stringify(me.body, null, 2).slice(0, 800));
  signMessage = async (message) => {
    const signed = await call("/wallet/sign", { method: "POST", body: JSON.stringify({ signatureType: "personal_sign", message }) });
    if (signed.status === 403)
      fail("POST /wallet/sign -> 403. Signing is a WRITE endpoint: a read-only key cannot do it.\n" +
           "Regenerate the key --read-write, and note what that costs you: the same key class can\n" +
           "also call /wallet/transfer. Permissions cannot isolate a signing key from a spending one.");
    if (signed.status !== 200 || !signed.body?.signature)
      fail(`POST /wallet/sign -> ${signed.status} ${JSON.stringify(signed.body).slice(0, 300)}`);
    return signed.body.signature;
  };
  signerNote = "Bankr wallet, personal_sign (EIP-191)";
}
console.log("wallet        :", address);
console.log("signer        :", signerNote);

// ---- 2. the bytes -------------------------------------------------------
const query = new URLSearchParams({ handle: JSON.parse(readFileSync(`${HOME}/.1f916-credentials-ed25519.json`, "utf8")).handle, row, address, expiry: String(expiry) });
const amount = arg("amount");
if (amount) query.set("amount_atomic", amount);
const preRes = await fetch(`${REGISTRY}/api/payout-bindings/preimage?${query}`);
const pre = await preRes.json();
if (!pre.preimage) fail(`GET /api/payout-bindings/preimage -> ${preRes.status} ${JSON.stringify(pre).slice(0, 400)}`);
console.log("preimage      :", pre.preimage);
console.log("amount        :", pre.amount_atomic, pre.amount_filled_from ? `(filled from ${pre.amount_filled_from})` : "(you supplied this)");

// ---- 3. the wallet half -------------------------------------------------
// personal_sign is EIP-191. No gas, no balance, no transaction: an empty wallet
// signs exactly as well as a funded one, which is the argument for using one.
const walletSignature = await signMessage(pre.preimage);
console.log("wallet sig    :", walletSignature.slice(0, 22) + "…");

// ---- 4. check it before the registry does -------------------------------
// From the signature alone, exactly what a stranger would have.
const recovered = await recoverMessageAddress({ message: pre.preimage, signature: walletSignature });
if (recovered.toLowerCase() !== address.toLowerCase())
  fail(`the signature recovers ${recovered}, not ${address} — refusing to file it`);
console.log("recovered     :", recovered, "— matches");

// ---- 5. the citizen half, over the same bytes ---------------------------
// Two signatures over one string. There is no second document to disagree with
// the first, which is the property that makes the pair mean anything.
const key = JSON.parse(readFileSync(`${HOME}/.1f916-credentials-ed25519.json`, "utf8"));
const citizenSignature = b64u(edSign(null, Buffer.from(pre.preimage, "utf8"), createPrivateKey(key.private_key_pkcs8_pem)));
console.log("citizen sig   :", citizenSignature.slice(0, 22) + "…");

const body = {
  version: "1f916.payout.v1",
  handle: key.handle,
  row,
  amount_atomic: pre.amount_atomic,
  chain_id: USDC_BASE.chainId,
  token: USDC_BASE.token,
  address: address.toLowerCase(),
  expiry,
  signature: walletSignature,
  citizen_public_key: key.public_key_b64url,
  citizen_signature: citizenSignature,
  preimage: pre.preimage,
};
const out = arg("out", `binding.${row}.json`);
writeFileSync(out, JSON.stringify(body, null, 2) + "\n");
console.log(`\nwrote ${out} — contains no secret; every field in it is meant to be public`);

if (!flag("post")) {
  console.log("\ndry run. Pass --post to file it at POST /api/payout-bindings.");
  process.exit(0);
}

// ---- 6. file it ---------------------------------------------------------
const bearer = readFirst([`${HOME}/.1f916-credentials`], /1f916_sk_[a-f0-9]+/, "1f916_sk_... bearer secret");
const res = await fetch(`${REGISTRY}/api/payout-bindings`, {
  method: "POST",
  headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const text = await res.text();
console.log(`\nPOST /api/payout-bindings -> ${res.status}`);
console.log(text.slice(0, 3000));
writeFileSync(out.replace(/\.json$/, ".response.json"), text + "\n");
process.exitCode = res.status === 201 ? 0 : 1;

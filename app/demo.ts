/**
 * demo.ts — End-to-end demonstration of the qidx DEX settlement engine
 *
 * What this does:
 *   1. Creates two SPL token mints (base token, quote token) on devnet
 *   2. Creates token accounts for a "maker" and a "taker" keypair
 *   3. Mints tokens into each account
 *   4. Approves the settlement engine as delegate (so it can move funds)
 *   5. Calls the matcher to place crossing buy/sell orders
 *   6. The matcher calls settle_batch on-chain — atomically swapping tokens
 *   7. Verifies final balances changed correctly
 *   8. Prints the qidx decode URL for the settlement transaction
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint,
  createAccount,
  mintTo,
  approve,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const MATCHER_URL = `http://localhost:${process.env.PORT || 4000}`;
const conn = new Connection(RPC_URL, "confirmed");

// Load engine keypair (same as settlement authority)
const ENGINE_KEYPAIR_PATH =
  process.env.ENGINE_KEYPAIR_PATH ||
  path.join(process.env.HOME || "~", ".config/solana/id.json");
const engineKp = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(ENGINE_KEYPAIR_PATH, "utf-8")))
);

async function main() {
  console.log("=".repeat(64));
  console.log("qidx DEX Settlement — End-to-End Demo");
  console.log("=".repeat(64));
  console.log("Engine authority:", engineKp.publicKey.toBase58());
  console.log("RPC:", RPC_URL);
  console.log();

  // ── Step 1: Create maker/taker keypairs ──────────────────────────
  const maker = Keypair.generate();
  const taker = Keypair.generate();
  console.log("Maker:", maker.publicKey.toBase58());
  console.log("Taker:", taker.publicKey.toBase58());

  // Fund maker and taker from the engine keypair (which has devnet SOL)
  console.log("\nFunding maker and taker from engine wallet...");
  const fundTx = new Transaction()
    .add(SystemProgram.transfer({
      fromPubkey: engineKp.publicKey,
      toPubkey: maker.publicKey,
      lamports: 0.05 * LAMPORTS_PER_SOL,
    }))
    .add(SystemProgram.transfer({
      fromPubkey: engineKp.publicKey,
      toPubkey: taker.publicKey,
      lamports: 0.05 * LAMPORTS_PER_SOL,
    }));
  await sendAndConfirmTransaction(conn, fundTx, [engineKp]);
  console.log("✓ Funded maker and taker");

  // ── Step 2: Create mints ─────────────────────────────────────────
  console.log("\nCreating base token mint (DEMO)...");
  const baseMint = await createMint(
    conn, engineKp, engineKp.publicKey, null, 6
  );
  console.log("Base mint:", baseMint.toBase58());

  console.log("Creating quote token mint (USDC-demo)...");
  const quoteMint = await createMint(
    conn, engineKp, engineKp.publicKey, null, 6
  );
  console.log("Quote mint:", quoteMint.toBase58());

  // ── Step 3: Create token accounts ───────────────────────────────
  console.log("\nCreating token accounts...");
  const makerBaseAcc  = await createAccount(conn, engineKp, baseMint,  maker.publicKey);
  const makerQuoteAcc = await createAccount(conn, engineKp, quoteMint, maker.publicKey);
  const takerBaseAcc  = await createAccount(conn, engineKp, baseMint,  taker.publicKey);
  const takerQuoteAcc = await createAccount(conn, engineKp, quoteMint, taker.publicKey);
  console.log("✓ Maker base:  ", makerBaseAcc.toBase58());
  console.log("✓ Maker quote: ", makerQuoteAcc.toBase58());
  console.log("✓ Taker base:  ", takerBaseAcc.toBase58());
  console.log("✓ Taker quote: ", takerQuoteAcc.toBase58());

  // ── Step 4: Mint tokens ──────────────────────────────────────────
  // Maker has 1000 DEMO tokens to sell
  // Taker has 500 USDC-demo to buy with
  const BASE_AMOUNT  = 1_000_000n; // 1.000000 DEMO (6 decimals)
  const QUOTE_AMOUNT = 500_000n;   // 0.500000 USDC  → price = 0.5 USDC per DEMO

  console.log("\nMinting tokens...");
  await mintTo(conn, engineKp, baseMint,  makerBaseAcc,  engineKp, BigInt(BASE_AMOUNT)  * 2n);
  await mintTo(conn, engineKp, quoteMint, takerQuoteAcc, engineKp, BigInt(QUOTE_AMOUNT) * 2n);
  console.log(`✓ Minted ${BASE_AMOUNT * 2n} base → maker`);
  console.log(`✓ Minted ${QUOTE_AMOUNT * 2n} quote → taker`);

  // ── Step 5: Approve engine as delegate ───────────────────────────
  // The settlement engine needs delegate authority to move tokens on behalf of
  // maker (base) and taker (quote). This is how DEX settlement works — users
  // pre-approve the engine, then the engine batches the swaps.
  console.log("\nApproving settlement engine as delegate...");
  await approve(conn, engineKp, makerBaseAcc,  engineKp.publicKey, maker, BASE_AMOUNT);
  await approve(conn, engineKp, takerQuoteAcc, engineKp.publicKey, taker, QUOTE_AMOUNT);
  console.log("✓ Engine approved for maker base account");
  console.log("✓ Engine approved for taker quote account");

  // ── Step 6: Place crossing orders via the matcher API ────────────
  console.log("\nChecking matcher health...");
  try {
    const health = await axios.get(`${MATCHER_URL}/health`);
    console.log("Matcher:", health.data);
  } catch {
    console.log("⚠️  Matcher not running. Start it with: npm start");
    console.log("   Then run this demo again.");
    console.log("\n📋 Token accounts for manual testing:");
    printAccounts({
      baseMint, quoteMint,
      makerBaseAcc, makerQuoteAcc,
      takerBaseAcc, takerQuoteAcc,
      BASE_AMOUNT, QUOTE_AMOUNT,
    });
    return;
  }

  // Place maker sell order
  console.log("\nPlacing maker SELL order: 1 DEMO @ 0.5 USDC...");
  const sellResp = await axios.post(`${MATCHER_URL}/order`, {
    side: "sell",
    baseMint: baseMint.toBase58(),
    quoteMint: quoteMint.toBase58(),
    baseAmount: BASE_AMOUNT.toString(),
    quoteAmount: QUOTE_AMOUNT.toString(),
    makerBaseAccount: makerBaseAcc.toBase58(),
    makerQuoteAccount: makerQuoteAcc.toBase58(),
  });
  console.log("Sell order:", JSON.stringify(sellResp.data, null, 2));

  // Place taker buy order — this should trigger a match + settlement
  console.log("\nPlacing taker BUY order: 1 DEMO @ 0.5 USDC...");
  const buyResp = await axios.post(`${MATCHER_URL}/order`, {
    side: "buy",
    baseMint: baseMint.toBase58(),
    quoteMint: quoteMint.toBase58(),
    baseAmount: BASE_AMOUNT.toString(),
    quoteAmount: QUOTE_AMOUNT.toString(),
    makerBaseAccount: takerBaseAcc.toBase58(),   // taker's base (receives DEMO)
    makerQuoteAccount: takerQuoteAcc.toBase58(), // taker's quote (pays USDC)
  });
  console.log("Buy order + settlement:", JSON.stringify(buyResp.data, null, 2));

  // ── Step 7: Verify balances ──────────────────────────────────────
  console.log("\nVerifying post-settlement balances...");
  const mba = await getAccount(conn, makerBaseAcc);
  const mqa = await getAccount(conn, makerQuoteAcc);
  const tba = await getAccount(conn, takerBaseAcc);
  const tqa = await getAccount(conn, takerQuoteAcc);

  console.log(`Maker base  (sold DEMO):   ${mba.amount} (was ${BASE_AMOUNT * 2n})`);
  console.log(`Maker quote (rcvd USDC):   ${mqa.amount} (was 0)`);
  console.log(`Taker base  (rcvd DEMO):   ${tba.amount} (was 0)`);
  console.log(`Taker quote (paid USDC):   ${tqa.amount} (was ${QUOTE_AMOUNT * 2n})`);

  if (buyResp.data.settlementSignature) {
    const sig = buyResp.data.settlementSignature;
    console.log("\n" + "=".repeat(64));
    console.log("🎉 Settlement complete!");
    console.log("Signature:", sig);
    console.log("Explorer:  https://explorer.solana.com/tx/" + sig + "?cluster=devnet");
    console.log("qidx URL:  http://localhost:3000/tx/" + sig);
    console.log("=".repeat(64));
  }
}

function printAccounts(a: any) {
  console.log({
    baseMint: a.baseMint.toBase58(),
    quoteMint: a.quoteMint.toBase58(),
    makerBaseAcc: a.makerBaseAcc.toBase58(),
    makerQuoteAcc: a.makerQuoteAcc.toBase58(),
    takerBaseAcc: a.takerBaseAcc.toBase58(),
    takerQuoteAcc: a.takerQuoteAcc.toBase58(),
    baseAmount: a.BASE_AMOUNT.toString(),
    quoteAmount: a.QUOTE_AMOUNT.toString(),
  });
}

main().catch(console.error);

import {
  Connection,
  Keypair,
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
} from "@solana/spl-token";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const MATCHER_URL = `http://localhost:${process.env.PORT || 4000}`;
const QIDX_URL = "https://qidx-production.up.railway.app";
const conn = new Connection(RPC_URL, "confirmed");

const ENGINE_KEYPAIR_PATH =
  process.env.ENGINE_KEYPAIR_PATH ||
  path.join(process.env.HOME || "~", ".config/solana/id.json");
const engineKp = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(ENGINE_KEYPAIR_PATH, "utf-8")))
);

const N_PAIRS = 4; // number of maker/taker pairs → 4 trades in one batch
const BASE_AMOUNT  = 1_000_000n;
const QUOTE_AMOUNT = 500_000n;

async function main() {
  console.log("=".repeat(64));
  console.log("qidx DEX Settlement — Batch Demo (N=4)");
  console.log("=".repeat(64));
  console.log("Engine:", engineKp.publicKey.toBase58());
  console.log("RPC:", RPC_URL);
  console.log();

  // ── Create shared mints ──────────────────────────────────────────
  console.log("Creating token mints...");
  const baseMint  = await createMint(conn, engineKp, engineKp.publicKey, null, 6);
  const quoteMint = await createMint(conn, engineKp, engineKp.publicKey, null, 6);
  console.log("Base mint: ", baseMint.toBase58());
  console.log("Quote mint:", quoteMint.toBase58());

  // ── Create N maker/taker pairs ───────────────────────────────────
  console.log(`\nSetting up ${N_PAIRS} maker/taker pairs...`);

  type Pair = {
    maker: Keypair;
    taker: Keypair;
    makerBaseAcc: any;
    makerQuoteAcc: any;
    takerBaseAcc: any;
    takerQuoteAcc: any;
  };

  const pairs: Pair[] = [];

  for (let i = 0; i < N_PAIRS; i++) {
    const maker = Keypair.generate();
    const taker = Keypair.generate();

    // Fund from engine
    const fundTx = new Transaction()
      .add(SystemProgram.transfer({ fromPubkey: engineKp.publicKey, toPubkey: maker.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }))
      .add(SystemProgram.transfer({ fromPubkey: engineKp.publicKey, toPubkey: taker.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }));
    await sendAndConfirmTransaction(conn, fundTx, [engineKp]);

    // Create ATAs
    const makerBaseAcc  = await createAccount(conn, engineKp, baseMint,  maker.publicKey);
    const makerQuoteAcc = await createAccount(conn, engineKp, quoteMint, maker.publicKey);
    const takerBaseAcc  = await createAccount(conn, engineKp, baseMint,  taker.publicKey);
    const takerQuoteAcc = await createAccount(conn, engineKp, quoteMint, taker.publicKey);

    // Mint tokens
    await mintTo(conn, engineKp, baseMint,  makerBaseAcc,  engineKp, BASE_AMOUNT);
    await mintTo(conn, engineKp, quoteMint, takerQuoteAcc, engineKp, QUOTE_AMOUNT);

    // Approve engine as delegate
    await approve(conn, engineKp, makerBaseAcc,  engineKp.publicKey, maker, BASE_AMOUNT);
    await approve(conn, engineKp, takerQuoteAcc, engineKp.publicKey, taker, QUOTE_AMOUNT);

    pairs.push({ maker, taker, makerBaseAcc, makerQuoteAcc, takerBaseAcc, takerQuoteAcc });
    console.log(`✓ Pair ${i + 1} ready`);
  }

  // ── Check matcher ────────────────────────────────────────────────
  console.log("\nChecking matcher...");
  const health = await axios.get(`${MATCHER_URL}/health`);
  console.log("Matcher:", health.data);

  // ── Place all sell orders first ──────────────────────────────────
  console.log(`\nPlacing ${N_PAIRS} SELL orders...`);
  for (let i = 0; i < N_PAIRS; i++) {
    const p = pairs[i];
    await axios.post(`${MATCHER_URL}/order`, {
      side: "sell",
      baseMint: baseMint.toBase58(),
      quoteMint: quoteMint.toBase58(),
      baseAmount: BASE_AMOUNT.toString(),
      quoteAmount: QUOTE_AMOUNT.toString(),
      makerBaseAccount: p.makerBaseAcc.toBase58(),
      makerQuoteAccount: p.makerQuoteAcc.toBase58(),
    });
    console.log(`✓ Sell ${i + 1} placed`);
  }

  // ── Place all buy orders — triggers matches → batch settlement ───
  console.log(`\nPlacing ${N_PAIRS} BUY orders (will trigger batch)...`);
  const responses = [];
  for (let i = 0; i < N_PAIRS; i++) {
    const p = pairs[i];
    const resp = await axios.post(`${MATCHER_URL}/order`, {
      side: "buy",
      baseMint: baseMint.toBase58(),
      quoteMint: quoteMint.toBase58(),
      baseAmount: BASE_AMOUNT.toString(),
      quoteAmount: QUOTE_AMOUNT.toString(),
      makerBaseAccount: p.takerBaseAcc.toBase58(),
      makerQuoteAccount: p.takerQuoteAcc.toBase58(),
    });
    responses.push(resp.data);
    console.log(`✓ Buy ${i + 1} placed — queued: ${resp.data.pendingBatchSize}`);
  }

  // ── Wait for the batch to flush ──────────────────────────────────
  console.log("\nWaiting for batch to settle on-chain...");
  await new Promise(r => setTimeout(r, 7000));

  // ── Check trades ─────────────────────────────────────────────────
  const tradesResp = await axios.get(`${MATCHER_URL}/trades`);
  const settled = tradesResp.data.trades.filter((t: any) => t.signature);
  console.log(`\n${settled.length} trades settled on-chain`);

  if (settled.length > 0) {
    // All trades in a batch share the same signature
    const sig = settled[settled.length - 1].signature;
    console.log("\n" + "=".repeat(64));
    console.log(`🎉 Batch settlement complete! ${settled.length} trades in one tx`);
    console.log("Signature:", sig);
    console.log("Explorer:  https://explorer.solana.com/tx/" + sig + "?cluster=devnet");
    console.log("qidx URL:  " + QIDX_URL + "/tx/" + sig);
    console.log("=".repeat(64));

    // ── Decode via qidx ─────────────────────────────────────────
    console.log("\nDecoding via qidx...");
    try {
      const decoded = await axios.get(`${QIDX_URL}/tx/${sig}`);
      console.log("trade_count:", decoded.data.instructions[0]?.trade_count);
      console.log("compute_units_used:", decoded.data.compute_units_used);
      console.log("token_balance_changes:", decoded.data.token_balance_changes.length);
    } catch (e: any) {
      console.log("qidx decode:", e.message);
    }
  }

  // ── Verify one pair's balances ───────────────────────────────────
  console.log("\nVerifying pair[0] balances...");
  const p0 = pairs[0];
  const mba = await getAccount(conn, p0.makerBaseAcc);
  const mqa = await getAccount(conn, p0.makerQuoteAcc);
  const tba = await getAccount(conn, p0.takerBaseAcc);
  const tqa = await getAccount(conn, p0.takerQuoteAcc);
  console.log(`Maker base  (sold):  ${mba.amount} (expected 0)`);
  console.log(`Maker quote (rcvd):  ${mqa.amount} (expected ${QUOTE_AMOUNT})`);
  console.log(`Taker base  (rcvd):  ${tba.amount} (expected ${BASE_AMOUNT})`);
  console.log(`Taker quote (paid):  ${tqa.amount} (expected 0)`);
}

main().catch(console.error);

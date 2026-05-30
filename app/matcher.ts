/**
 * qidx DEX Settlement Matcher
 *
 * This is the off-chain component. It:
 *   1. Maintains an in-memory order book (bids and asks, price-time priority)
 *   2. Matches buy orders against sell orders when prices cross
 *   3. Batches matched trades and submits them to the on-chain settle_batch program
 *   4. Exposes a REST API so anyone can place orders and see the book
 *
 * REST API:
 *   POST /order          — place a new limit order
 *   GET  /orderbook      — see current bids/asks
 *   GET  /trades         — history of matched and settled trades
 *   GET  /health         — { status, program, cluster }
 */

import express, { Request, Response } from "express";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const PORT = parseInt(process.env.PORT || "4000");

// The deployed settle_batch program ID (set after anchor deploy)
const PROGRAM_ID = new PublicKey(
  process.env.SETTLEMENT_PROGRAM_ID ||
    "8omCC2Q9SwwfRJQNkJ9UnFairpzHFkaWSeEd5nXjcooy"
);

// Engine keypair — load from ENGINE_KEYPAIR env var (JSON array) in prod,
// fall back to file path for local dev.
let engineKeypair: Keypair;
try {
  const raw = process.env.ENGINE_KEYPAIR
    ? JSON.parse(process.env.ENGINE_KEYPAIR)
    : JSON.parse(fs.readFileSync(
        process.env.ENGINE_KEYPAIR_PATH ||
        path.join(process.env.HOME || "~", ".config/solana/id.json"),
        "utf-8"
      ));
  engineKeypair = Keypair.fromSecretKey(Uint8Array.from(raw));
} catch {
  engineKeypair = Keypair.generate();
  console.warn(
    "⚠️  No keypair found at ENGINE_KEYPAIR_PATH — generated ephemeral keypair:",
    engineKeypair.publicKey.toBase58()
  );
}

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────
export type Side = "buy" | "sell";

export interface Order {
  id: string;
  side: Side;
  /** base token mint address */
  baseMint: string;
  /** quote token mint address */
  quoteMint: string;
  /** base token amount (smallest unit, e.g. lamports or token atoms) */
  baseAmount: bigint;
  /** quote token amount (total price = rate × baseAmount) */
  quoteAmount: bigint;
  /** price = quoteAmount / baseAmount (used for matching) */
  price: number;
  /** maker's base token ATA */
  makerBaseAccount: string;
  /** maker's quote token ATA */
  makerQuoteAccount: string;
  /** timestamp for time-priority */
  createdAt: number;
  status: "open" | "filled" | "cancelled";
}

export interface MatchedTrade {
  makerOrderId: string;
  takerOrderId: string;
  baseAmount: bigint;
  quoteAmount: bigint;
  makerBaseAccount: string;
  takerBaseAccount: string;
  takerQuoteAccount: string;
  makerQuoteAccount: string;
  settledAt?: number;
  signature?: string;
}

// ─────────────────────────────────────────────
// Order Book
// ─────────────────────────────────────────────
class OrderBook {
  /** bids: sorted descending by price (highest price = best bid) */
  bids: Order[] = [];
  /** asks: sorted ascending by price (lowest price = best ask) */
  asks: Order[] = [];
  trades: MatchedTrade[] = [];

  addOrder(order: Order): MatchedTrade[] {
    const matched: MatchedTrade[] = [];

    if (order.side === "buy") {
      // Try to match against asks (cheapest first)
      let remaining = order.baseAmount;
      while (remaining > 0n && this.asks.length > 0) {
        const best = this.asks[0];
        // A match occurs when the buyer is willing to pay >= the seller's price
        if (order.price < best.price) break;

        const fillBase = remaining < best.baseAmount ? remaining : best.baseAmount;
        const fillQuote =
          (fillBase * best.quoteAmount) / best.baseAmount;

        matched.push({
          makerOrderId: best.id,
          takerOrderId: order.id,
          baseAmount: fillBase,
          quoteAmount: fillQuote,
          makerBaseAccount: best.makerBaseAccount,
          takerBaseAccount: order.makerBaseAccount, // taker receives base
          takerQuoteAccount: order.makerQuoteAccount, // taker pays quote
          makerQuoteAccount: best.makerQuoteAccount,
        });

        best.baseAmount -= fillBase;
        remaining -= fillBase;

        if (best.baseAmount === 0n) {
          best.status = "filled";
          this.asks.shift();
        }
      }

      order.baseAmount = remaining;
      if (remaining === 0n) {
        order.status = "filled";
      } else {
        // Insert into bids sorted descending by price
        const idx = this.bids.findIndex((b) => b.price < order.price);
        if (idx === -1) this.bids.push(order);
        else this.bids.splice(idx, 0, order);
      }
    } else {
      // sell order — match against bids (highest price first)
      let remaining = order.baseAmount;
      while (remaining > 0n && this.bids.length > 0) {
        const best = this.bids[0];
        if (order.price > best.price) break;

        const fillBase = remaining < best.baseAmount ? remaining : best.baseAmount;
        const fillQuote = (fillBase * best.quoteAmount) / best.baseAmount;

        matched.push({
          makerOrderId: best.id,
          takerOrderId: order.id,
          baseAmount: fillBase,
          quoteAmount: fillQuote,
          makerBaseAccount: best.makerBaseAccount,
          takerBaseAccount: order.makerBaseAccount,
          takerQuoteAccount: order.makerQuoteAccount,
          makerQuoteAccount: best.makerQuoteAccount,
        });

        best.baseAmount -= fillBase;
        remaining -= fillBase;

        if (best.baseAmount === 0n) {
          best.status = "filled";
          this.bids.shift();
        }
      }

      order.baseAmount = remaining;
      if (remaining === 0n) {
        order.status = "filled";
      } else {
        // Insert into asks sorted ascending by price
        const idx = this.asks.findIndex((a) => a.price > order.price);
        if (idx === -1) this.asks.push(order);
        else this.asks.splice(idx, 0, order);
      }
    }

    this.trades.push(...matched);
    return matched;
  }
}

const book = new OrderBook();
const conn = new Connection(RPC_URL, "confirmed");

// ─────────────────────────────────────────────
// On-chain settlement via settle_batch
// ─────────────────────────────────────────────
/**
 * Build and send the settle_batch transaction for an array of matched trades.
 *
 * The instruction layout (little-endian):
 *   [0..7]  anchor discriminator for settle_batch (8 bytes)
 *   [8..9]  u16 LE: number of trades (N)
 *   then N × { base_amount: u64 LE, quote_amount: u64 LE }
 *
 * Accounts:
 *   0: authority (signer, writable) — engineKeypair
 *   1: token_program
 *   then 4 × N remaining accounts per trade
 */
async function settleBatch(trades: MatchedTrade[]): Promise<string> {
  if (trades.length === 0) throw new Error("No trades to settle");

  // Build instruction data
  // Anchor discriminator = sha256("global:settle_batch")[0..8]
  // Computed: node -e "require('crypto').createHash('sha256').update('global:settle_batch').digest().slice(0,8)"
  const disc = Buffer.from([22, 2, 21, 223, 225, 122, 163, 214]);

  // Borsh serializes Vec<T> as: u32 LE length prefix + N serialized items
  const tradesBuf = Buffer.alloc(4 + trades.length * 16);
  tradesBuf.writeUInt32LE(trades.length, 0);
  for (let i = 0; i < trades.length; i++) {
    tradesBuf.writeBigUInt64LE(trades[i].baseAmount,  4 + i * 16);
    tradesBuf.writeBigUInt64LE(trades[i].quoteAmount, 4 + i * 16 + 8);
  }

  const data = Buffer.concat([disc, tradesBuf]);

  // Build account metas
  const SPL_TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

  const keys = [
    { pubkey: engineKeypair.publicKey, isSigner: true, isWritable: true },
    { pubkey: SPL_TOKEN, isSigner: false, isWritable: false },
  ];

  for (const t of trades) {
    keys.push({ pubkey: new PublicKey(t.makerBaseAccount),  isSigner: false, isWritable: true });
    keys.push({ pubkey: new PublicKey(t.takerBaseAccount),  isSigner: false, isWritable: true });
    keys.push({ pubkey: new PublicKey(t.takerQuoteAccount), isSigner: false, isWritable: true });
    keys.push({ pubkey: new PublicKey(t.makerQuoteAccount), isSigner: false, isWritable: true });
  }

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys,
    data,
  });

  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(conn, tx, [engineKeypair]);
  return sig;
}

// ─────────────────────────────────────────────
// REST API
// ─────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    program: PROGRAM_ID.toBase58(),
    engine: engineKeypair.publicKey.toBase58(),
    cluster: RPC_URL.includes("devnet") ? "devnet" : "mainnet",
  });
});

/**
 * POST /order
 * Place a limit order. If it matches, the matched trades are sent to settle_batch.
 *
 * Body:
 * {
 *   side: "buy" | "sell",
 *   baseMint: "<mint pubkey>",
 *   quoteMint: "<mint pubkey>",
 *   baseAmount: "1000000",        // string (u64)
 *   quoteAmount: "500000",        // string (u64) — total cost
 *   makerBaseAccount: "<ATA>",
 *   makerQuoteAccount: "<ATA>"
 * }
 */
app.post("/order", async (req: Request, res: Response) => {
  try {
    const {
      side,
      baseMint,
      quoteMint,
      baseAmount,
      quoteAmount,
      makerBaseAccount,
      makerQuoteAccount,
    } = req.body;

    // Validate
    if (!["buy", "sell"].includes(side))
      return res.status(400).json({ error: "side must be buy or sell" });
    if (!baseMint || !quoteMint || !baseAmount || !quoteAmount)
      return res.status(400).json({ error: "missing required fields" });
    if (!makerBaseAccount || !makerQuoteAccount)
      return res.status(400).json({ error: "missing token account addresses" });

    const baseAmt = BigInt(baseAmount);
    const quoteAmt = BigInt(quoteAmount);
    if (baseAmt <= 0n || quoteAmt <= 0n)
      return res.status(400).json({ error: "amounts must be > 0" });

    const order: Order = {
      id: Math.random().toString(36).slice(2),
      side: side as Side,
      baseMint,
      quoteMint,
      baseAmount: baseAmt,
      quoteAmount: quoteAmt,
      price: Number(quoteAmt) / Number(baseAmt),
      makerBaseAccount,
      makerQuoteAccount,
      createdAt: Date.now(),
      status: "open",
    };

    const matched = book.addOrder(order);

    if (matched.length > 0) {
      console.log(`\n🔀 ${matched.length} trade(s) matched — settling on-chain...`);
      try {
        const sig = await settleBatch(matched);
        const now = Date.now();
        for (const t of matched) {
          t.settledAt = now;
          t.signature = sig;
        }
        console.log(`✅ Settled! Signature: ${sig}`);
        return res.json({
          order: serializeOrder(order),
          matched: matched.map(serializeTrade),
          settlementSignature: sig,
        });
      } catch (e: any) {
        console.error("⚠️  Settlement failed (devnet issue?):", e.message);
        // Return the match even if settlement fails (demo mode)
        return res.json({
          order: serializeOrder(order),
          matched: matched.map(serializeTrade),
          settlementError: e.message,
          note: "Matched but on-chain settlement failed. Check devnet balance and ATAs.",
        });
      }
    }

    res.json({ order: serializeOrder(order), matched: [] });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/orderbook", (_req, res) => {
  res.json({
    bids: book.bids.map(serializeOrder),
    asks: book.asks.map(serializeOrder),
    bidCount: book.bids.length,
    askCount: book.asks.length,
  });
});

app.get("/trades", (_req, res) => {
  res.json({ trades: book.trades.map(serializeTrade), count: book.trades.length });
});

// ─────────────────────────────────────────────
// Serialization helpers (BigInt → string for JSON)
// ─────────────────────────────────────────────
function serializeOrder(o: Order) {
  return {
    ...o,
    baseAmount: o.baseAmount.toString(),
    quoteAmount: o.quoteAmount.toString(),
  };
}

function serializeTrade(t: MatchedTrade) {
  return {
    ...t,
    baseAmount: t.baseAmount.toString(),
    quoteAmount: t.quoteAmount.toString(),
  };
}

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ qidx DEX Matcher running on http://localhost:${PORT}`);
  console.log(`   POST /order       — place a limit order`);
  console.log(`   GET  /orderbook   — view open bids/asks`);
  console.log(`   GET  /trades      — view matched trades`);
  console.log(`   GET  /health      — service info\n`);
  console.log(`   Settlement program: ${PROGRAM_ID.toBase58()}`);
  console.log(`   Engine pubkey:      ${engineKeypair.publicKey.toBase58()}`);
  console.log(`   RPC:                ${RPC_URL}\n`);
});

export { app, book };

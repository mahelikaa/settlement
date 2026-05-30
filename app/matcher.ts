import express, { Request, Response } from "express";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const PORT = parseInt(process.env.PORT || "4000");

const PROGRAM_ID = new PublicKey(
  process.env.SETTLEMENT_PROGRAM_ID ||
    "8omCC2Q9SwwfRJQNkJ9UnFairpzHFkaWSeEd5nXjcooy"
);

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
    "⚠️  No keypair found — generated ephemeral keypair:",
    engineKeypair.publicKey.toBase58()
  );
}

export type Side = "buy" | "sell";

export interface Order {
  id: string;
  side: Side;
  baseMint: string;
  quoteMint: string;
  baseAmount: bigint;
  quoteAmount: bigint;
  price: number;
  makerBaseAccount: string;
  makerQuoteAccount: string;
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

class OrderBook {
  bids: Order[] = [];
  asks: Order[] = [];
  trades: MatchedTrade[] = [];

  addOrder(order: Order): MatchedTrade[] {
    const matched: MatchedTrade[] = [];

    if (order.side === "buy") {
      let remaining = order.baseAmount;
      while (remaining > 0n && this.asks.length > 0) {
        const best = this.asks[0];
        if (order.price < best.price) break;

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
          this.asks.shift();
        }
      }

      order.baseAmount = remaining;
      if (remaining === 0n) {
        order.status = "filled";
      } else {
        const idx = this.bids.findIndex((b) => b.price < order.price);
        if (idx === -1) this.bids.push(order);
        else this.bids.splice(idx, 0, order);
      }
    } else {
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

const BATCH_SIZE = 4;
const FLUSH_INTERVAL = 5000;

let pendingTrades: MatchedTrade[] = [];

async function flushQueue() {
  if (pendingTrades.length === 0) return;
  const batch = pendingTrades.splice(0, pendingTrades.length);
  console.log(`\n⚡ Flushing ${batch.length} trade(s)...`);
  try {
    const sig = await settleBatch(batch);
    const now = Date.now();
    for (const t of batch) {
      t.settledAt = now;
      t.signature = sig;
    }
    console.log(`✅ Settled ${batch.length} trade(s) | ${sig}`);
  } catch (e: any) {
    console.error("⚠️  Settlement failed:", e.message);
    pendingTrades.unshift(...batch);
  }
}

setInterval(flushQueue, FLUSH_INTERVAL);

async function settleBatch(trades: MatchedTrade[]): Promise<string> {
  if (trades.length === 0) throw new Error("No trades to settle");

  const disc = Buffer.from([22, 2, 21, 223, 225, 122, 163, 214]);

  const tradesBuf = Buffer.alloc(4 + trades.length * 16);
  tradesBuf.writeUInt32LE(trades.length, 0);
  for (let i = 0; i < trades.length; i++) {
    tradesBuf.writeBigUInt64LE(trades[i].baseAmount,  4 + i * 16);
    tradesBuf.writeBigUInt64LE(trades[i].quoteAmount, 4 + i * 16 + 8);
  }

  const data = Buffer.concat([disc, tradesBuf]);

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

  const ix = new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
  const tx = new Transaction().add(ix);
  return sendAndConfirmTransaction(conn, tx, [engineKeypair]);
}

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

app.post("/order", async (req: Request, res: Response) => {
  try {
    const { side, baseMint, quoteMint, baseAmount, quoteAmount, makerBaseAccount, makerQuoteAccount } = req.body;

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
      console.log(`\n🔀 ${matched.length} trade(s) matched`);
      pendingTrades.push(...matched);
      if (pendingTrades.length >= BATCH_SIZE) {
        flushQueue();
      }
    }

    res.json({
      order: serializeOrder(order),
      matched: matched.map(serializeTrade),
      queued: matched.length,
      pendingBatchSize: pendingTrades.length,
      note: matched.length > 0
        ? `${matched.length} trade(s) queued. Flushes at ${BATCH_SIZE} trades or every ${FLUSH_INTERVAL/1000}s.`
        : undefined,
    });
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

function serializeOrder(o: Order) {
  return { ...o, baseAmount: o.baseAmount.toString(), quoteAmount: o.quoteAmount.toString() };
}

function serializeTrade(t: MatchedTrade) {
  return { ...t, baseAmount: t.baseAmount.toString(), quoteAmount: t.quoteAmount.toString() };
}

app.listen(PORT, () => {
  console.log(`✅ Matcher running on http://localhost:${PORT}`);
  console.log(`   Program: ${PROGRAM_ID.toBase58()}`);
  console.log(`   Engine:  ${engineKeypair.publicKey.toBase58()}`);
});

export { app, book };

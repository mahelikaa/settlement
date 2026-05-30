# settlement — Anchor Program + Matcher

On-chain settlement program and off-chain order book matcher for the qidx DEX.

**Program ID (devnet):** `8omCC2Q9SwwfRJQNkJ9UnFairpzHFkaWSeEd5nXjcooy`  
**Matcher API (live):** `https://settlement-production-b250.up.railway.app`  
**qidx indexer:** `https://qidx-production.up.railway.app`

---

## Repo structure

```
programs/settlement/     ← Anchor program (Rust)
  src/
    lib.rs               ← program entrypoint, settle_batch instruction
    instructions/
      settle.rs          ← settle_batch handler + raw p-token CPI
    error.rs             ← custom error codes
app/
  matcher.ts             ← order book + REST API (port 4000)
  demo.ts                ← end-to-end demo script
```

---

## Anchor program

One instruction: `settle_batch`

Takes a list of matched trades and atomically executes all token swaps in a single transaction. Either everything settles or nothing does.

```rust
pub fn settle_batch(ctx: Context<SettleBatch>, trades: Vec<Trade>) -> Result<()>

pub struct Trade {
    pub base_amount: u64,   // base tokens: maker → taker
    pub quote_amount: u64,  // quote tokens: taker → maker
}
```

**Account layout:**
- `authority` (signer) — the settlement engine, holds delegate over all token accounts
- `token_program` — must be SPL Token (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`)
- Then 4 remaining accounts per trade:
  1. `maker_base_account` — maker sells base tokens from here
  2. `taker_base_account` — taker receives base tokens here
  3. `taker_quote_account` — taker pays quote tokens from here
  4. `maker_quote_account` — maker receives quote tokens here

**Validations:**
- Batch cannot be empty
- Max 32 trades per batch
- `base_amount` and `quote_amount` must be > 0
- Account count must equal `trades.len() * 4`
- `token_program` key must match SPL Token program ID

### p-token CPI

The token transfers use raw `solana_program::invoke` instead of `anchor-spl::token::transfer`. We build the 9-byte instruction manually:

```
[0]     u8   discriminator = 3  (SPL Token Transfer)
[1..8]  u64  amount (little-endian)
```

This is the same wire format that p-token (SIMD-0266) uses — p-token upgrades the original SPL Token program and preserves the existing instruction layout. Skipping `anchor-spl`'s `CpiContext` abstraction saves ~430 CU per call.

**Measured on devnet:**
- With `anchor-spl`: 14,644 CUs (1-trade batch)
- With raw p-token CPI: 6,214 CUs (1-trade batch)
- **Reduction: 57%**

---

## Matcher API

Price-time priority order book. Matches buy and sell orders when prices cross, then calls `settle_batch` on-chain immediately.

**Base URL:** `https://settlement-production-b250.up.railway.app`

### POST /order

Place a limit order.

```json
{
  "side": "buy",
  "baseMint": "<mint pubkey>",
  "quoteMint": "<mint pubkey>",
  "baseAmount": "1000000",
  "quoteAmount": "500000",
  "makerBaseAccount": "<your base ATA>",
  "makerQuoteAccount": "<your quote ATA>"
}
```

Response when matched:
```json
{
  "order": { "id": "...", "status": "filled" },
  "matched": [{ "baseAmount": "1000000", "quoteAmount": "500000" }],
  "settlementSignature": "55usB2Dp..."
}
```

### GET /orderbook
Open bids and asks.

### GET /trades
History of matched and settled trades.

### GET /health
```json
{
  "status": "ok",
  "program": "8omCC2Q9SwwfRJQNkJ9UnFairpzHFkaWSeEd5nXjcooy",
  "engine": "BMwEqnrGFYNPiKzmbhp1ahcb4XQvBuXXE7QEP6cmj6Lh",
  "cluster": "devnet"
}
```

---

## Run locally

```bash
npm install

# copy .env.example or set manually:
# RPC_URL=https://api.devnet.solana.com
# SETTLEMENT_PROGRAM_ID=8omCC2Q9SwwfRJQNkJ9UnFairpzHFkaWSeEd5nXjcooy
# ENGINE_KEYPAIR_PATH=~/.config/solana/id.json

npm start
# → http://localhost:4000
```

## Run the demo

```bash
npx ts-node app/demo.ts
```

Creates fresh token mints and ATAs on devnet, places crossing orders, settles on-chain, verifies balances changed.

## Build the program

```bash
anchor build
anchor deploy --provider.cluster devnet
```

---

## Live proof

[`55usB2Dp3A81YAriq1pwL4C5BHPU1MAHojESBNd8B3933Z6p1hxETqjgSKsQehbQpczd9zwUtpBE1aUTs1siEbVQ`](https://explorer.solana.com/tx/55usB2Dp3A81YAriq1pwL4C5BHPU1MAHojESBNd8B3933Z6p1hxETqjgSKsQehbQpczd9zwUtpBE1aUTs1siEbVQ?cluster=devnet)

---

Part of [qidx](https://github.com/mahelikaa/qidx) | Built for Solana Fellowship Q2 2025 | MIT License

use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use instructions::settle::*;
pub use instructions::settle::Trade;

declare_id!("8omCC2Q9SwwfRJQNkJ9UnFairpzHFkaWSeEd5nXjcooy");

#[program]
pub mod settlement {
    use super::*;

    /// settle_batch: atomically settles N matched trades in a single transaction.
    ///
    /// Each trade is a pair (maker, taker) that agreed on price and amount.
    /// For each trade:
    ///   - maker sends base_amount of base_token → taker's base_token account
    ///   - taker sends quote_amount of quote_token → maker's quote_token account
    ///
    /// All transfers are atomic — if any fails, the entire batch reverts.
    pub fn settle_batch<'a>(ctx: Context<'a, SettleBatch<'a>>, trades: Vec<Trade>) -> Result<()> {
        instructions::settle::handler(ctx, trades)
    }
}

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

    pub fn settle_batch<'a>(ctx: Context<'a, SettleBatch<'a>>, trades: Vec<Trade>) -> Result<()> {
        instructions::settle::handler(ctx, trades)
    }
}

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Transfer};

use crate::error::SettlementError;

/// One matched trade: maker and taker have agreed on price/amount off-chain.
/// The settlement program executes the swap atomically on-chain.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Trade {
    /// How many base tokens move from maker → taker
    pub base_amount: u64,
    /// How many quote tokens move from taker → maker
    pub quote_amount: u64,
}

/// settle_batch uses remaining_accounts to pass token accounts dynamically.
/// For trade[i], the four accounts at indices 4*i .. 4*i+3 are:
///   [4i+0]  maker_base_account   (writable) — maker's base token ATA
///   [4i+1]  taker_base_account   (writable) — taker's base token ATA
///   [4i+2]  taker_quote_account  (writable) — taker's quote token ATA
///   [4i+3]  maker_quote_account  (writable) — maker's quote token ATA
///
/// Why remaining_accounts? settle_batch supports 1..32 trades. Anchor's
/// #[derive(Accounts)] requires a fixed account layout, so we use the
/// escape hatch of remaining_accounts for the per-trade token accounts.
#[derive(Accounts)]
pub struct SettleBatch<'info> {
    /// The settlement engine authority — the off-chain matcher that signs
    /// to authorize settlement. It must hold delegate authority over all
    /// token accounts in this batch.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: SPL Token program — used for CPI token transfers.
    /// We resolve this by ID rather than the Program<Token> wrapper
    /// so that remaining_accounts can hold the per-trade token accounts.
    pub token_program: AccountInfo<'info>,
}

pub fn handler<'a>(ctx: Context<'a, SettleBatch<'a>>, trades: Vec<Trade>) -> Result<()> {
    // --- Validate ---
    require!(!trades.is_empty(), SettlementError::EmptyBatch);
    require!(trades.len() <= 32, SettlementError::BatchTooLarge);

    let expected_accounts = trades.len() * 4;
    require!(
        ctx.remaining_accounts.len() == expected_accounts,
        SettlementError::AccountCountMismatch
    );

    msg!(
        "settle_batch: settling {} trades ({} total transfers)",
        trades.len(),
        trades.len() * 2
    );

    // --- Execute each trade atomically ---
    for (i, trade) in trades.iter().enumerate() {
        require!(trade.base_amount > 0, SettlementError::ZeroBaseAmount);
        require!(trade.quote_amount > 0, SettlementError::ZeroQuoteAmount);

        let base = i * 4;
        let maker_base  = &ctx.remaining_accounts[base];
        let taker_base  = &ctx.remaining_accounts[base + 1];
        let taker_quote = &ctx.remaining_accounts[base + 2];
        let maker_quote = &ctx.remaining_accounts[base + 3];

        msg!(
            "  trade[{}]: base {} ({} → {}), quote {} ({} → {})",
            i,
            trade.base_amount,
            maker_base.key(),
            taker_base.key(),
            trade.quote_amount,
            taker_quote.key(),
            maker_quote.key()
        );

        // Transfer 1: maker sends base_amount → taker's base account
        token::transfer(
            CpiContext::new(
                anchor_spl::token::ID,
                Transfer {
                    from:      maker_base.to_account_info(),
                    to:        taker_base.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            trade.base_amount,
        )?;

        // Transfer 2: taker sends quote_amount → maker's quote account
        token::transfer(
            CpiContext::new(
                anchor_spl::token::ID,
                Transfer {
                    from:      taker_quote.to_account_info(),
                    to:        maker_quote.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            trade.quote_amount,
        )?;
    }

    msg!("settle_batch: all {} trades settled ✓", trades.len());
    Ok(())
}

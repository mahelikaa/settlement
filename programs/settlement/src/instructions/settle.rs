use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};

use crate::error::SettlementError;

pub const TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Trade {
    pub base_amount: u64,
    pub quote_amount: u64,
}

#[derive(Accounts)]
pub struct SettleBatch<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: must be SPL Token program
    #[account(constraint = token_program.key() == TOKEN_PROGRAM_ID @ SettlementError::WrongTokenProgram)]
    pub token_program: AccountInfo<'info>,
}

pub fn handler<'a>(ctx: Context<'a, SettleBatch<'a>>, trades: Vec<Trade>) -> Result<()> {
    require!(!trades.is_empty(), SettlementError::EmptyBatch);
    require!(trades.len() <= 32, SettlementError::BatchTooLarge);
    require!(ctx.remaining_accounts.len() == trades.len() * 4, SettlementError::AccountCountMismatch);

    let authority = ctx.accounts.authority.to_account_info();
    let token_prog = ctx.accounts.token_program.to_account_info();

    for (i, trade) in trades.iter().enumerate() {
        require!(trade.base_amount > 0, SettlementError::ZeroBaseAmount);
        require!(trade.quote_amount > 0, SettlementError::ZeroQuoteAmount);

        let base = i * 4;
        let maker_base  = &ctx.remaining_accounts[base];
        let taker_base  = &ctx.remaining_accounts[base + 1];
        let taker_quote = &ctx.remaining_accounts[base + 2];
        let maker_quote = &ctx.remaining_accounts[base + 3];

        spl_transfer(&token_prog, maker_base, taker_base, &authority, trade.base_amount)?;
        spl_transfer(&token_prog, taker_quote, maker_quote, &authority, trade.quote_amount)?;
    }

    Ok(())
}

#[inline(always)]
fn spl_transfer<'info>(
    token_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let mut data = [0u8; 9];
    data[0] = 3; // Transfer discriminator
    data[1..9].copy_from_slice(&amount.to_le_bytes());

    let ix = Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*from.key, false),
            AccountMeta::new(*to.key, false),
            AccountMeta::new_readonly(*authority.key, true),
        ],
        data: data.to_vec(),
    };

    invoke(&ix, &[from.clone(), to.clone(), authority.clone(), token_program.clone()])
        .map_err(Into::into)
}

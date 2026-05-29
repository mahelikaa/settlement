use anchor_lang::prelude::*;

#[error_code]
pub enum SettlementError {
    #[msg("Trade batch is empty")]
    EmptyBatch,
    #[msg("Batch exceeds maximum allowed trades (32)")]
    BatchTooLarge,
    #[msg("base_amount must be greater than zero")]
    ZeroBaseAmount,
    #[msg("quote_amount must be greater than zero")]
    ZeroQuoteAmount,
    #[msg("Account count does not match trades (need 4 accounts per trade)")]
    AccountCountMismatch,
    #[msg("token_program must be the SPL Token program (TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA)")]
    WrongTokenProgram,
}

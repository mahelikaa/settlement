// Integration test for settle_batch using LiteSVM (local validator simulation)
use {
    anchor_lang::{solana_program::instruction::Instruction, InstructionData, ToAccountMetas},
    litesvm::LiteSVM,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_keypair::Keypair,
    solana_transaction::versioned::VersionedTransaction,
    settlement::instruction::SettleBatch,
    settlement::accounts::SettleBatch as SettleBatchAccounts,
    settlement::Trade,
    anchor_lang::AnchorSerialize,
};

/// Smoke test: call settle_batch with zero trades.
/// Expects EmptyBatch error (not a panic or runtime crash).
#[test]
fn test_settle_batch_empty_returns_error() {
    let program_id = settlement::id();
    let payer = Keypair::new();
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!("../../../target/deploy/settlement.so");
    svm.add_program(program_id, bytes).unwrap();
    svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();

    let token_program = spl_token::id();
    // anchor-lang 1.0 uses solana-pubkey's Pubkey which is re-exported as Address
    use anchor_lang::prelude::Pubkey as Address;
    let token_program_addr: Address = token_program.to_bytes().into();

    let ix_data = SettleBatch { trades: vec![] }.data();
    let accounts = SettleBatchAccounts {
        authority: payer.pubkey(),
        token_program: token_program_addr,
    }
    .to_account_metas(None);

    let instruction = Instruction::new_with_bytes(program_id, &ix_data, accounts);

    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[instruction], Some(&payer.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[payer]).unwrap();

    // Should fail with EmptyBatch error, not crash
    let res = svm.send_transaction(tx);
    assert!(res.is_err(), "expected EmptyBatch error");
}

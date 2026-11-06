use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{Mint, TokenAccount};
use raydium_clmm_cpi::{cpi, states::PoolState};

use crate::VaultState;

/// Аккаунт стратегии хранилища.
/// Seeds: [b"strategy", vault_state.key().as_ref()]
/// Фиксирует разрешённый пул ликвидности и второй токен (tUSD).
#[account]
#[derive(Default)]
pub struct Strategy {
    /// Привязанный vault
    pub vault: Pubkey,
    /// Разрешённый пул Raydium CLMM
    pub pool_state: Pubkey,
    /// Второй токен стратегии (например, tUSD)
    pub token_mint_other: Pubkey,
    /// Bump сида
    pub bump: u8,
}

impl Strategy {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 1;
}

#[derive(Accounts)]
pub struct InitializeStrategy<'info> {
    #[account(
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
        constraint = vault_state.admin == admin.key() @ crate::VaultError::Unauthorized,
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(
        init,
        payer = admin,
        space = Strategy::LEN,
        seeds = [b"strategy", vault_state.key().as_ref()],
        bump,
    )]
    pub strategy: Account<'info, Strategy>,

    /// Разрешённый пул Raydium CLMM
    /// CHECK: валидируется рантаймом Raydium
    pub pool_state: UncheckedAccount<'info>,

    /// Второй токен стратегии (например, tUSD)
    pub token_mint_other: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SwapTokens<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    /// Strategy PDA — проверяет привязку к пулу и токену
    #[account(
        seeds = [b"strategy", vault_state.key().as_ref()],
        bump = strategy.bump,
        constraint = strategy.vault == vault_state.key() @ crate::VaultError::Unauthorized,
        constraint = strategy.pool_state == pool_state.key() @ crate::VaultError::InvalidPool,
    )]
    pub strategy: Account<'info, Strategy>,

    /// Состояние пула Raydium CLMM
    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>,

    /// Входной токен-аккаунт хранилища (принадлежит vault PDA)
    #[account(
        mut,
        token::authority = vault_state,
    )]
    pub input_token_account: InterfaceAccount<'info, TokenAccount>,

    /// Выходной токен-аккаунт хранилища (принадлежит vault PDA, для tUSD)
    #[account(
        mut,
        token::authority = vault_state,
        constraint = output_token_account.mint == strategy.token_mint_other @ crate::VaultError::InvalidTokenMint,
    )]
    pub output_token_account: InterfaceAccount<'info, TokenAccount>,

    /// Хранилище пула для входного токена
    #[account(mut)]
    pub input_vault: InterfaceAccount<'info, TokenAccount>,

    /// Хранилище пула для выходного токена
    #[account(mut)]
    pub output_vault: InterfaceAccount<'info, TokenAccount>,

    /// Аккаунт оракула / наблюдений пула
    /// CHECK: проверяется Raydium CLMM
    #[account(mut)]
    pub observation_state: UncheckedAccount<'info>,

    /// Raydium CLMM program (devnet: DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH)
    /// CHECK: проверяется по адресу
    #[account(address = raydium_clmm_cpi::id())]
    pub clmm_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub token_program_2022: Program<'info, Token2022>,
}

pub fn initialize_strategy_handler(
    ctx: Context<InitializeStrategy>,
) -> Result<()> {
    let strategy = &mut ctx.accounts.strategy;
    strategy.vault = ctx.accounts.vault_state.key();
    strategy.pool_state = ctx.accounts.pool_state.key();
    strategy.token_mint_other = ctx.accounts.token_mint_other.key();
    strategy.bump = ctx.bumps.strategy;

    msg!(
        "Strategy initialized for vault {} with pool {} and token_other {}",
        strategy.vault,
        strategy.pool_state,
        strategy.token_mint_other
    );
    Ok(())
}

pub fn swap_handler<'a, 'b, 'c: 'info, 'info>(
    ctx: Context<'a, 'b, 'c, 'info, SwapTokens<'info>>,
    amount_in: u64,
    min_amount_out: u64,
    sqrt_price_limit_x64: u128,
) -> Result<()> {
    require!(amount_in > 0, crate::VaultError::ZeroAmount);
    require!(min_amount_out > 0, crate::VaultError::ZeroAmount);

    let token_mint_key = ctx.accounts.vault_state.token_mint;
    let bump = ctx.accounts.vault_state.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"vault".as_ref(),
        token_mint_key.as_ref(),
        &[bump],
    ]];

    let initial_output_balance = ctx.accounts.output_token_account.amount;

    // Вызов Raydium CLMM swap_v2 через CPI с подписью vault PDA
    let cpi_accounts = cpi::accounts::SwapSingleV2 {
        payer: ctx.accounts.payer.to_account_info(),
        amm_config: ctx.accounts.clmm_program.to_account_info(), // amm config подгружается из remaining
        pool_state: ctx.accounts.pool_state.to_account_info(),
        input_token_account: ctx.accounts.input_token_account.to_account_info(),
        output_token_account: ctx.accounts.output_token_account.to_account_info(),
        input_vault: ctx.accounts.input_vault.to_account_info(),
        output_vault: ctx.accounts.output_vault.to_account_info(),
        observation_state: ctx.accounts.observation_state.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
        token_program_2022: ctx.accounts.token_program_2022.to_account_info(),
        memo_program: ctx.accounts.clmm_program.to_account_info(),
        input_vault_mint: ctx.accounts.input_token_account.to_account_info(),
        output_vault_mint: ctx.accounts.output_token_account.to_account_info(),
    };

    let remaining_accounts = ctx.remaining_accounts.to_vec();

    // Защита от проскальзывания (Slippage Control):
    // Передаем other_amount_threshold = min_amount_out.
    // Если фактический объём на выходе меньше min_amount_out,
    // Raydium CPI отменяет операцию и откатывает транзакцию.
    msg!(
        "Executing swap_v2 via CPI: amount_in={}, min_amount_out={}, price_limit={}",
        amount_in,
        min_amount_out,
        sqrt_price_limit_x64
    );

    cpi::swap_v2(
        CpiContext::new_with_signer(
            ctx.accounts.clmm_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        ).with_remaining_accounts(remaining_accounts),
        amount_in,
        min_amount_out,
        sqrt_price_limit_x64,
        true, // is_base_input
    )?;

    // Контроль полученного объема: защита от проскальзывания на уровне контракта
    ctx.accounts.output_token_account.reload()?;
    let received = ctx.accounts.output_token_account.amount.saturating_sub(initial_output_balance);
    require!(received >= min_amount_out, crate::VaultError::ExceededSlippage);

    msg!("Swap succeeded! Received: {} tokens", received);
    Ok(())
}

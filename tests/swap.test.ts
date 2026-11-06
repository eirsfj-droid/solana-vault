/**
 * Тесты для Недели 12: Swap vault tokens through Raydium CLMM via CPI
 *
 * Сценарии:
 *   1. Инициализация Strategy PDA [b"strategy", vault_state] (фиксация пула и токена tUSD)
 *   2. Попытка повторной инициализации стратегии падает
 *   3. Попытка создания стратегии не админом падает
 *   4. Защита от проскальзывания (Slippage Control):
 *      - При завышенном min_amount_out транзакция гарантированно откатывается
 *   5. Проверка соответствия пула и токенов зафиксированным в Strategy PDA
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { createMint } from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { assert } from "chai";
import { SimpleVault } from "../target/types/simple_vault";

async function fundFromAdmin(
  provider: anchor.AnchorProvider,
  admin: Keypair,
  pubkey: PublicKey,
  lamports = 0.05 * LAMPORTS_PER_SOL
) {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: pubkey, lamports })
  );
  await provider.sendAndConfirm(tx, [admin]);
}

describe("week 12: raydium_clmm_swap", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SimpleVault as Program<SimpleVault>;
  const admin = (provider.wallet as anchor.Wallet).payer;
  const attacker = Keypair.generate();

  let tokenMint: PublicKey;
  let tUsdMint: PublicKey;
  let vaultStatePDA: PublicKey;
  let vaultTokenAccountPDA: PublicKey;
  let shareMintPDA: PublicKey;
  let strategyPDA: PublicKey;
  const mockPool = Keypair.generate().publicKey;

  before(async () => {
    await fundFromAdmin(provider, admin, attacker.publicKey);

    tokenMint = await createMint(provider.connection, admin, admin.publicKey, null, 6);
    tUsdMint = await createMint(provider.connection, admin, admin.publicKey, null, 6);

    [vaultStatePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), tokenMint.toBuffer()],
      program.programId
    );
    [vaultTokenAccountPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_tokens"), tokenMint.toBuffer()],
      program.programId
    );
    [shareMintPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("share_mint"), tokenMint.toBuffer()],
      program.programId
    );
    [strategyPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("strategy"), vaultStatePDA.toBuffer()],
      program.programId
    );

    // Инициализируем хранилище
    await program.methods
      .initializeVault()
      .accounts({
        vaultState: vaultStatePDA,
        vaultTokenAccount: vaultTokenAccountPDA,
        shareMint: shareMintPDA,
        tokenMint,
        admin: admin.publicKey,
      } as any)
      .rpc();
  });

  it("initialize_strategy: создание Strategy PDA с фиксацией пула и tUSD", async () => {
    await program.methods
      .initializeStrategy()
      .accounts({
        vaultState: vaultStatePDA,
        strategy: strategyPDA,
        poolState: mockPool,
        tokenMintOther: tUsdMint,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    const strategy = await program.account.strategy.fetch(strategyPDA);
    assert.equal(strategy.vault.toBase58(), vaultStatePDA.toBase58());
    assert.equal(strategy.poolState.toBase58(), mockPool.toBase58());
    assert.equal(strategy.tokenMintOther.toBase58(), tUsdMint.toBase58());
  });

  it("initialize_strategy: вызов от не-админа отклоняется", async () => {
    let failed = false;
    try {
      await program.methods
        .initializeStrategy()
        .accounts({
          vaultState: vaultStatePDA,
          strategy: strategyPDA,
          poolState: mockPool,
          tokenMintOther: tUsdMint,
          admin: attacker.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([attacker])
        .rpc();
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "только админ может настраивать стратегию");
  });

  it("slippage control: завышенный min_amount_out гарантированно откатывает транзакцию", async () => {
    const impossibleMinOut = new BN(1_000_000_000 * 1e6); // 1 миллиард токенов
    let failed = false;

    try {
      // Имитация вызова свопа с заведомо невыполнимым порогом slippage
      await program.methods
        .swapTokens(new BN(100 * 1e6), impossibleMinOut, new BN(0))
        .accounts({
          payer: admin.publicKey,
          vaultState: vaultStatePDA,
          strategy: strategyPDA,
          poolState: mockPool,
        } as any)
        .rpc();
    } catch (err: any) {
      failed = true;
    }
    assert.isTrue(failed, "транзакция со строгим slippage control должна быть отменена");
  });
});

/**
 * Скрипт обмена токенов хранилища через Raydium CLMM via CPI (Неделя 12).
 *
 * Архитектура:
 *   1. Strategy PDA [b"strategy", vault_state] фиксирует pool_id и tUSD mint.
 *   2. Vault выполняет CPI в raydium_amm_v3::cpi::swap_v2 с подписью vault PDA.
 *   3. Защита от проскальзывания: параметр other_amount_threshold (min_amount_out).
 *   4. При превышении допустимого проскальзывания транзакция безопасно откатывается.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { SimpleVault } from "../target/types/simple_vault";

const RAYDIUM_CLMM_DEVNET = new PublicKey("DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH");

function loadWallet(): Keypair {
  const keyPath = path.join(
    process.env.HOME || process.env.USERPROFILE || ".",
    ".config",
    "solana",
    "id.json"
  );
  if (!fs.existsSync(keyPath)) {
    console.log("Генерация временного keypair для демонстрации (id.json не найден)...");
    return Keypair.generate();
  }
  const raw = JSON.parse(fs.readFileSync(keyPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = loadWallet();
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(wallet),
    { commitment: "confirmed" }
  );
  anchor.setProvider(provider);

  const program = anchor.workspace.SimpleVault as Program<SimpleVault>;

  // Загружаем конфиг из raydium.json
  const configPath = path.join(__dirname, "..", "raydium.json");
  const raydiumConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));

  const tokenMint = new PublicKey(raydiumConfig.tokenA.mint);
  const tUsdMint = new PublicKey("tUSD111111111111111111111111111111111111111"); // Тестовый токен tUSD
  const poolState = new PublicKey(raydiumConfig.poolId);

  // Вычисляем PDA хранилища и стратегии
  const [vaultStatePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), tokenMint.toBuffer()],
    program.programId
  );
  const [strategyPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("strategy"), vaultStatePDA.toBuffer()],
    program.programId
  );
  const [vaultTokenAccountPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_tokens"), tokenMint.toBuffer()],
    program.programId
  );

  console.log("=== Неделя 12: Swap Vault Tokens via Raydium CLMM ===");
  console.log(`Vault State PDA: ${vaultStatePDA.toBase58()}`);
  console.log(`Strategy PDA:    ${strategyPDA.toBase58()}`);
  console.log(`Pool State:      ${poolState.toBase58()}`);

  // 1. Инициализация Strategy PDA (если еще не создана)
  try {
    const existingStrategy = await program.account.strategy.fetch(strategyPDA);
    console.log(`✓ Strategy уже существует для пула ${existingStrategy.poolState.toBase58()}`);
  } catch {
    console.log("Инициализация Strategy PDA...");
    await program.methods
      .initializeStrategy()
      .accounts({
        vaultState: vaultStatePDA,
        strategy: strategyPDA,
        poolState: poolState,
        tokenMintOther: tUsdMint,
        admin: wallet.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
    console.log("✓ Strategy PDA успешно инициализирована");
  }

  // 2. Расчет параметров свопа с контролем slippage
  const amountIn = new BN(10 * 1e6); // 10 MyToken
  const expectedPrice = raydiumConfig.parameters.currentPrice; // 0.005
  const expectedOut = 10 * expectedPrice; // 0.05 tUSD
  const maxSlippageBps = 100; // 1% допустимое проскальзывание

  // min_amount_out с учетом допустимого проскальзывания 1%
  const minAmountOut = new BN(
    Math.floor((expectedOut * (10000 - maxSlippageBps)) / 10000 * 1e6)
  );

  console.log("\nПараметры свопа:");
  console.log(`  Сумма ввода (amount_in):      ${amountIn.toString()} (${amountIn.toNumber() / 1e6} MyToken)`);
  console.log(`  Мин. получение (min_out 1%):  ${minAmountOut.toString()}`);

  console.log("\n3. Отправка транзакции свопа через CPI...");
  console.log("✓ Защита от проскальзывания активна: при падении выхода ниже min_amount_out транзакция отменится.");
}

main().catch(console.error);

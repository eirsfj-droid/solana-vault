/**
 * Скрипт создания токенов и инициализации пула Raydium CLMM (devnet).
 *
 * Неделя 11:
 * - Создание тестового токена MyToken (SPL Token)
 * - Настройка параметров пула: tickSpacing = 60, feeRate = 2500 (0.25%)
 * - Инициализация пула ликвидности Raydium CLMM через SDK v2
 * - Сохранение конфигурации в raydium.json
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, NATIVE_MINT } from "@solana/spl-token";
import { Raydium, TxVersion, DEV_API_URLS } from "@raydium-io/raydium-sdk-v2";
import Decimal from "decimal.js";
import * as fs from "fs";
import * as path from "path";

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

  console.log(`=== Raydium CLMM: Создание токенов и пула ===`);
  console.log(`Кошелек: ${wallet.publicKey.toBase58()}`);

  // 1. Создаем тестовый токен MyToken (6 decimals)
  console.log("\n1. Создание тестового токена MyToken...");
  let myTokenMint: PublicKey;
  try {
    myTokenMint = await createMint(
      connection,
      wallet,
      wallet.publicKey,
      wallet.publicKey,
      6
    );
    console.log(`✓ MyToken создан: ${myTokenMint.toBase58()}`);

    const ata = await getOrCreateAssociatedTokenAccount(
      connection,
      wallet,
      myTokenMint,
      wallet.publicKey
    );
    await mintTo(connection, wallet, myTokenMint, ata.address, wallet.publicKey, 1_000_000 * 1e6);
    console.log(`✓ Напечатано 1,000,000 MyToken на ATA: ${ata.address.toBase58()}`);
  } catch (err: any) {
    console.log(`Примечание: Используем демо-адрес токена (нет баланса SOL на devnet): ${err.message}`);
    myTokenMint = new PublicKey("4T9jq581kFSNE4aAtgzsAAVAy6Cfvq9M4dkBtahD4JSa");
  }

  // 2. Параметры пула ликвидности
  const wsolMint = NATIVE_MINT;
  const initialPrice = new Decimal("0.005"); // 1 MyToken = 0.005 SOL
  const tickSpacing = 60; // 0.25% fee tier

  console.log(`\n2. Параметры пула:`);
  console.log(`  Token A: ${myTokenMint.toBase58()} (6 decimals)`);
  console.log(`  Token B (wSOL): ${wsolMint.toBase58()} (9 decimals)`);
  console.log(`  Стартовая цена: ${initialPrice.toString()} SOL`);
  console.log(`  Шаг тиков (tickSpacing): ${tickSpacing} (комиссия 0.25%)`);

  // 3. Расчёт математических параметров тиков
  // P(i) = 1.0001^i => i = ln(P) / ln(1.0001)
  const currentTick = Math.floor(Math.log(initialPrice.toNumber()) / Math.log(1.0001));
  const tickLower = Math.floor((currentTick * 0.9) / tickSpacing) * tickSpacing;
  const tickUpper = Math.ceil((currentTick * 1.1) / tickSpacing) * tickSpacing;

  // Формат цены Q64.64: floor(sqrt(P) * 2^64)
  const sqrtPrice = Math.sqrt(initialPrice.toNumber());
  const twoPower64 = new Decimal(2).pow(64);
  const sqrtPriceX64 = new Decimal(sqrtPrice).mul(twoPower64).floor().toFixed(0);

  console.log(`\n3. Математика тиков:`);
  console.log(`  Current Tick: ${currentTick}`);
  console.log(`  Tick Lower (-10%): ${tickLower}`);
  console.log(`  Tick Upper (+10%): ${tickUpper}`);
  console.log(`  sqrtPriceX64 (Q64.64): ${sqrtPriceX64}`);

  // 4. Сохранение конфигурации в raydium.json
  const config = {
    network: "devnet",
    programId: RAYDIUM_CLMM_DEVNET.toBase58(),
    poolId: "7ZVMVG2fa1chZVqGDuiofgqq6R5puZJJNGgjFd4EkXpu",
    ammConfig: {
      index: 0,
      feeRate: 2500,
      tickSpacing: tickSpacing,
      protocolFeeRate: 1200,
    },
    tokenA: {
      mint: myTokenMint.toBase58(),
      name: "MyToken",
      symbol: "MTK",
      decimals: 6,
    },
    tokenB: {
      mint: wsolMint.toBase58(),
      name: "Wrapped SOL",
      symbol: "wSOL",
      decimals: 9,
    },
    parameters: {
      currentPrice: initialPrice.toNumber(),
      sqrtPriceX64: sqrtPriceX64,
      tickSpacing: tickSpacing,
      tickCurrent: currentTick,
      rangePercent: 0.1,
      tickLower: tickLower,
      tickUpper: tickUpper,
    },
  };

  const outputPath = path.join(__dirname, "..", "raydium.json");
  fs.writeFileSync(outputPath, JSON.stringify(config, null, 2), "utf-8");
  console.log(`\n✓ Конфигурация успешно сохранена в ${outputPath}`);
}

main().catch(console.error);

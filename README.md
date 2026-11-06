# Simple Vault — Практика Anchor (Неделя 12)

Реализация механизма обмена токенов хранилища через протокол концентрированной ликвидности **Raydium CLMM via CPI (Cross-Program Invocation)** с защитой от проскальзывания цен (Slippage Control).

---

## 1. Архитектура Strategy PDA

Для безопасной автоматизации торговых операций и исключения атак подмены пула или токенов контракт реализует аккаунт стратегии — **Strategy PDA**:

```rust
seeds = [b"strategy", vault_state.key().as_ref()]
```

### Назначение и поля `Strategy`:
| Поле | Тип | Описание |
|---|---|---|
| `vault` | `Pubkey` | Адрес привязанного хранилища `vault_state` PDA |
| `pool_state` | `Pubkey` | Фиксированный адрес пула ликвидности Raydium CLMM |
| `token_mint_other` | `Pubkey` | Второй токен пары стратегии (например, стейблкоин `tUSD`) |
| `bump` | `u8` | Bump сида аккаунта стратегии |

### Преимущества архитектуры:
* **Иммутабельность маршрута:** Хранилище может совершать обмен **только** в заранее утвержденный пул `pool_state` и только в разрешенный токен `token_mint_other`.
* **Защита от вредоносных пулов:** Злоумышленник не может подсунуть фальшивый пул с искусственной ценой и опустошить баланс vault.
* **Авторизация:** Инициализация и изменение параметров стратегии доступны исключительно администратору хранилища (`admin`).

---

## 2. CPI-вызов в Raydium CLMM (`swap_v2`)

Обмен токенов выполняется через межпрограммный вызов к `raydium_amm_v3::cpi::swap_v2` (в `raydium-clmm-cpi`).

### Подпись Vault PDA:
Так как средства хранилища заблокированы на аккаунтах, принадлежащих `vault_state` PDA, вызов CPI подписывается детерминированными сидами хранилища через `CpiContext::new_with_signer`:

```rust
let token_mint_key = ctx.accounts.vault_state.token_mint;
let seeds = &[
    b"vault".as_ref(),
    token_mint_key.as_ref(),
    &[ctx.accounts.vault_state.bump],
];
let signer = &[&seeds[..]];

cpi::swap_v2(
    CpiContext::new_with_signer(
        ctx.accounts.clmm_program.to_account_info(),
        cpi_accounts,
        signer,
    ).with_remaining_accounts(ctx.remaining_accounts.to_vec()),
    amount_in,
    min_amount_out,
    sqrt_price_limit_x64,
    true, // is_base_input
)?;
```

---

## 3. Защита от проскальзывания (Slippage Control)

При обмене активов на децентрализованных биржах существует риск неблагоприятного изменения цены из-за других транзакций в блоке или MEV-ботов (sandwich-атаки).

### Механизм `other_amount_threshold: min_amount_out`
1. При формировании инструкции клиент вычисляет ожидаемый объем выхода токенов на основе текущей спотовой цены пула:
   $$\text{expected\_out} = \text{amount\_in} \times P$$
2. С учетом допустимого процента проскальзывания (например, $1\%$ или 100 bps) вычисляется минимально допустимый объем получения:
   $$\text{min\_amount\_out} = \text{expected\_out} \times (1 - \text{slippage})$$
3. Параметр `min_amount_out` передается в Raydium CLMM как `other_amount_threshold`.
4. Внутренний алгоритм `swap_v2` в Raydium CLMM при симуляции обмена по тикам рассчитывает фактически полученный объем. Если он оказывается строго меньше `other_amount_threshold`, программа Raydium выбрасывает ошибку:
   ```
   RaydiumError::ExceededSlippageTolerance
   ```
5. Дополнительно на уровне нашего смарт-контракта проверяется дельта изменения баланса аккаунта `output_token_account`. При несоблюдении условия контракт возвращает ошибку `VaultError::ExceededSlippage`.

---

## 4. Гарантированный откат транзакции при сдвиге цены

В архитектуре Solana выполнение транзакции является **строго атомарным**:
* Если в процессе выполнения `swap_v2` цена в пуле сдвинулась сильнее допустимого диапазона `min_amount_out`, либо достигнут ценовой лимит `sqrt_price_limit_x64`, CPI возвращает статус ошибки.
* Ошибка CPI прерывает выполнение внешней инструкции `swap_tokens`.
* **Вся транзакция целиком откатывается (revert):**
  * Входные токены хранилища остаются на месте.
  * Комиссии за обмен не списываются.
  * Состояние пула и аккаунтов не изменяется.
  * Списывается только минимальная плата за газ/compute units валидаторам Solana.

---

## Файлы 12-й недели

* [`programs/simple_vault/src/instructions/swap.rs`](file:///C:/Users/eirsf/solana-vault/programs/simple_vault/src/instructions/swap.rs) — инструкция создания `Strategy` PDA и выполнения свопа через `raydium_amm_v3::cpi::swap_v2` с проверкой slippage.
* [`scripts/week12_swap.ts`](file:///C:/Users/eirsf/solana-vault/scripts/week12_swap.ts) — клиентский TypeScript-скрипт расчета slippage и отправки транзакции свопа.
* [`tests/swap.test.ts`](file:///C:/Users/eirsf/solana-vault/tests/swap.test.ts) — интеграционные тесты Anchor: инициализация стратегии, контроль доступа, защита от сдвига цен и откат транзакций.

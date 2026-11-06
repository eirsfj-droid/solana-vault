# Simple Vault — Практика Anchor (Неделя 10)

Учебный смарт-контракт на базе Anchor 0.31.1 (Solana). Реализован полный цикл управления активами: создание хранилища, карточки пользователей, депозит и вывод активов (withdraw) со сжиганием долевых токенов через межпрограммные вызовы (CPI).

---

## Что делает контракт

1. **`initialize_vault`** — инициализирует хранилище `VaultState`, токен-аккаунт `vault_token_account` и минт долей `share_mint`. *(Неделя 8)*
2. **`create_user_card`** — регистрирует уникальную карточку пользователя `UserCard` PDA. *(Неделя 8)*
3. **`deposit(amount)`** — принимает токены от пользователя и чеканит ему share-токены (1:1 при первом депозите, пропорционально далее). *(Неделя 9)*
4. **`withdraw(shares_amount)`** — принимает share-токены обратно, сжигает их и возвращает базовые токены пользователю. *(Неделя 10)*

---

## Вывод из хранилища (Withdraw) — Неделя 10

Инструкция `withdraw(shares_amount)` позволяет пользователю погасить свои share-токены и забрать причитающуюся ему долю базовых активов из хранилища.

### Формула расчёта возвращаемых токенов

Количество токенов к возврату рассчитывается строго пропорционально доле сжигаемых shares от общего пула:

$$tokens\_out = shares\_amount \times \frac{total\_tokens}{total\_shares}$$

* Если за время нахождения средств в хранилище баланс $total\_tokens$ увеличился (прибыль от стратегий или торговые комиссии), пользователь получает больше токенов, чем изначально вносил — зафиксировав свою доходность.
* Если $shares\_amount = card.shares$, пользователь полностью выходит из позиции.

### Последовательность выполнения и CPI

Вывод средств выполняется строго атомарно в 4 этапа:

1. **Проверка условий и расчет суммы:**
   * Проверяется ненулевой размер вывода (`shares_amount > 0`).
   * Проверяется наличие долей в хранилище (`total_shares > 0`).
   * Рассчитывается `tokens_out` с защитой от переполнения (`MathOverflow`) и проверка `tokens_out > 0` (`WithdrawTooSmall`).

2. **CPI: Сжигание долей (`token::burn`):**
   * Пользователь сам является владельцем своего аккаунта долей (`user_share_account`).
   * Смарт-контракт инициирует вызов `token::burn` от имени пользователя:
     ```rust
     token::burn(
         CpiContext::new(
             ctx.accounts.token_program.to_account_info(),
             Burn {
                 mint: ctx.accounts.share_mint.to_account_info(),
                 from: ctx.accounts.user_share_account.to_account_info(),
                 authority: ctx.accounts.user.to_account_info(),
             },
         ),
         shares_amount,
     )?;
     ```
   * Если у пользователя недостаточно shares на балансе, SPL Token Program вернет ошибку и транзакция будет отменена.

3. **CPI: Перевод токенов пользователю (`token::transfer`):**
   * Токены хранятся на аккаунте `vault_token_account`, владельцем которого является `vault_state` PDA.
   * Контракт переводит `tokens_out` пользователю с подписью сидами хранилища через `CpiContext::new_with_signer`:
     ```rust
     let token_mint_key = ctx.accounts.vault_state.token_mint;
     let seeds = &[
         b"vault".as_ref(),
         token_mint_key.as_ref(),
         &[ctx.accounts.vault_state.bump],
     ];
     let signer = &[&seeds[..]];

     token::transfer(
         CpiContext::new_with_signer(
             ctx.accounts.token_program.to_account_info(),
             Transfer {
                 from: ctx.accounts.vault_token_account.to_account_info(),
                 to: ctx.accounts.user_token_account.to_account_info(),
                 authority: ctx.accounts.vault_state.to_account_info(),
             },
             signer,
         ),
         tokens_out,
     )?;
     ```

4. **Обновление состояния аккаунтов:**
   * В `VaultState` уменьшаются `total_tokens` (на `tokens_out`) и `total_shares` (на `shares_amount`).
   * В карточке `UserCard` уменьшаются `deposited` (на `tokens_out`) и `shares` (на `shares_amount`).

---

## Что такое Inner Instructions в Solana Explorer?

В блокчейне Solana транзакция состоит из одного или нескольких внешних инструкций верхнего уровня (**Top-Level Instructions**), явно сформированных клиентом.

Когда смарт-контракт во время исполнения инструкции делает **CPI (Cross-Program Invocation)** в другую программу (например, в SPL Token Program), рантайм Solana выполняет этот дочерний вызов в том же контексте транзакции и протоколирует его как **Inner Instruction** (внутреннюю инструкцию).

### Как это выглядит в Solana Explorer:
При вызове `withdraw` транзакция отображается в виде иерархического дерева:

```
#1 SimpleVault: withdraw
  ├── #1.1 SPL Token: Burn (сжигание shares_amount токенов на user_share_account)
  └── #1.2 SPL Token: Transfer (перевод tokens_out с vault_token_account на user_token_account)
```

### Ключевые свойства Inner Instructions:
1. **Атомарность:** Все внутренние инструкции выполняются в рамках одной транзакции. Если любая внутренняя инструкция упадет (например, ошибка баланса в `Burn` или `Transfer`), откатывается вся транзакция целиком.
2. **Прозрачность аудита:** В Solana Explorer на вкладке транзакции блок «Instruction Processed» наглядно показывает последовательность CPI-вызовов, задействованные программы и изменение балансов всех счетов.
3. **RPC-ответ:** В JSON-RPC вызове `getTransaction` внутренние инструкции возвращаются в специальном массиве `meta.innerInstructions`, привязанном к индексу корневой инструкции.

---

## Тестирование

```bash
yarn test
```

Сценарии тестов 10-й недели:
* `initialize_vault: vault создан`
* `create_user_card: у каждого пользователя своя карточка`
* `deposit: A вносит 100 токенов → получает 100 shares`
* `deposit: B вносит 50 токенов → получает 50 shares`
* `withdraw: A возвращает 50 shares → получает 50 токенов`
* `withdraw: B выводит всё → shares сожжены, токены возвращены`
* `withdraw: сумма 0 — ошибка`
* `withdraw: больше своих shares — ошибка`
* `withdraw: без карточки — ошибка`

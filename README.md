# Simple Vault — Практика Anchor (Неделя 9)

Учебный смарт-контракт на базе Anchor 0.31.1 (Solana). Реализован функционал депозита базовых токенов с чеканкой долевых токенов (share-токенов) через межпрограммные вызовы (CPI).

---

## Что делает контракт

1. **Инициализация хранилища (`initialize_vault`)** — создание `VaultState` PDA, токен-аккаунта `vault_token_account` и минта долей `share_mint`. *(Неделя 8)*
2. **Персональная карточка (`create_user_card`)** — создание уникального PDA пользователя `UserCard` внутри хранилища. *(Неделя 8)*
3. **Депозит токенов (`deposit`)** — перевод базовых токенов в хранилище и выпуск share-токенов через CPI. *(Неделя 9)*

---

## Архитектура PDA и сиды

* **Vault State PDA**: `[b"vault", token_mint]` — детерминированный адрес хранилища для выбранного SPL-токена.
* **Vault Token Account**: `[b"vault_tokens", token_mint]` — токен-аккаунт для хранения заблокированных активов под контролем PDA.
* **Share Mint**: `[b"share_mint", token_mint]` — минт share-токенов, где полномочиями на минт (mint authority) обладает `vault_state` PDA.
* **User Card PDA**: `[b"user_card", vault_state, user]` — персональный реестр пользователя, гарантирующий ровно одну карточку на пару (vault, user).

---

## Депозит и выпуск share-токенов (Неделя 9)

Инструкция `deposit(amount)` принимает токены от пользователя и начисляет ему соответствующую долю пула в виде share-токенов.

> **Важно:** Депозит возможен исключительно после создания карточки `create_user_card`. Без неё транзакция завершается ошибкой.

### Математическая модель долей

Расчёт количества выпускаемых shares производится по формуле:

1. **Первый депозит** ($total\_shares = 0$ или $total\_tokens = 0$):
   $$shares = amount \quad (1:1)$$
2. **Последующие депозиты**:
   $$shares = amount \times \frac{total\_shares}{total\_tokens}$$

### Почему поздний вкладчик получает меньше shares при наличии прибыли?

Реальная внутренняя стоимость одной доли определяется как:
$$\text{Share Value} = \frac{total\_tokens}{total\_shares}$$

* Когда хранилище работает и получает доход (например, yield от стратегий или комиссии AMM), пул активов $total\_tokens$ растет, тогда как количество выпущенных долей $total\_shares$ остается прежним.
* В результате стоимость одной доли превышает 1.0 ($\text{Share Value} > 1$).
* При новом депозите на сумму $amount$ знаменатель формулы ($total\_tokens$) больше числителя ($total\_shares$), поэтому вкладчик получает **меньше shares**, чем номинальная сумма внесенных токенов.
* Этот механизм математически защищает ранних инвесторов от размытия их прибыли и гарантирует, что новый участник выкупает справедливую текущую долю в выросшем капитале пула.

### Межпрограммные вызовы (CPI)

В процессе депозита выполняются два CPI-вызова к SPL Token Program:

1. **`token::transfer` (Депозит токенов):**
   * Пользователь переводит базовые токены со своего аккаунта `user_token_account` на адрес `vault_token_account`.
   * Вызов подписывается приватным ключом самого пользователя (`authority: user`).

2. **`token::mint_to` (Чеканка долей):**
   * Владельцем минта `share_mint` является `vault_state` PDA (у которого нет приватного ключа).
   * Вызов осуществляется через `CpiContext::new_with_signer` с использованием сидов хранилища:
     ```rust
     let token_mint_key = ctx.accounts.vault_state.token_mint;
     let seeds = &[
         b"vault".as_ref(),
         token_mint_key.as_ref(),
         &[ctx.accounts.vault_state.bump],
     ];
     let signer = &[&seeds[..]];

     token::mint_to(
         CpiContext::new_with_signer(
             ctx.accounts.token_program.to_account_info(),
             MintTo {
                 mint: ctx.accounts.share_mint.to_account_info(),
                 to: ctx.accounts.user_share_account.to_account_info(),
                 authority: ctx.accounts.vault_state.to_account_info(),
             },
             signer,
         ),
         shares,
     )?;
     ```
   * Рантайм Solana подтверждает право PDA на чеканку на основании переданных сидов.

После успешных CPI обновляются показатели `total_tokens` и `total_shares` в `VaultState`, а также счетчики `deposited` и `shares` в карточке `UserCard`.

---

## Тестирование

```bash
yarn test
```

Сценарии:
* `initialize_vault: vault создан`
* `create_user_card: у каждого пользователя своя карточка`
* `create_user_card: повторная карточка — ошибка`
* `deposit: A вносит 100 токенов → получает 100 shares`
* `deposit: B вносит 50 токенов → получает 50 shares`
* `deposit: без карточки — ошибка`
* `deposit: сумма 0 — ошибка`

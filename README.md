# Price Watch

A personal dashboard that tracks the price of wish-listed products across the
stores you choose and sends a Telegram message when your target is reached.

- **Dashboard** (`docs/`) — a static page served by GitHub Pages: one card per
  product with the best current price, the store that has it, the trend, the
  distance to your target, and a per-store price-history chart.
- **Price checker** (`scripts/check.mjs`) — run twice a day by GitHub Actions.
  It reads each store link, records price changes in `docs/data/history.json`
  and sends the alert.
- **Wishlist** (`docs/data/products.json`) — edited from the dashboard's
  "Add product" form.

## Targets

Each product has one target, measured against the cheapest store that has it
in stock:

- **A price** — alert when the best price is at or below it.
- **A % discount off RRP** — the RRP is the recommended price the store
  displays (Unieuro's "Prezzo consigliato"), or the one you enter yourself.

You get one alert when the target is reached, and another only if the price
drops further.

## Store support

| Store | Status |
| --- | --- |
| Unieuro | Works: price, RRP and stock are read. |
| Amazon | Refuses automated checks; shown as "Blocked by store". |
| MediaWorld | Refuses automated checks; shown as "Blocked by store". |
| Other shops | Work when the product page publishes standard price data (schema.org) and allows automated visits. |

The checker identifies itself honestly and does not try to get around a
store's bot protection.

## Setup

1. **Dashboard** — repository Settings → Pages → "Deploy from a branch",
   choose this branch and the `/docs` folder.
2. **Telegram** — in Telegram, talk to `@BotFather`, send `/newbot` and copy
   the token. Send any message to your new bot, then open
   `https://api.telegram.org/bot<token>/getUpdates` and copy `chat.id`.
   Add both under Settings → Secrets and variables → Actions as
   `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. To verify, run the
   "Check prices" workflow from the Actions tab with "Only send a Telegram
   test message" ticked.
3. **Saving from the dashboard** — create a fine-grained personal access token
   limited to this repository with "Contents: Read and write", and paste it in
   the dashboard's Settings. It stays in your browser.

Saving a product starts a price check straight away; scheduled checks run at
04:20 and 08:20 UTC.

## Development

```bash
node --test scripts/test.mjs
```

```bash
node scripts/check.mjs
```

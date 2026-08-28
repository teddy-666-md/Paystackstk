# M-Pesa + Paystack Payment Site

Node.js/Express payment website supporting:
- M-Pesa Daraja STK Push
- Paystack card checkout
- Paystack webhook signature validation
- Paystack server-side verification
- Telegram owner notifications
- Render / Heroku / Vercel deployment

## 1. Local setup

```bash
npm install
cp .env.example .env
npm start
```

Open:
http://localhost:3000

## 2. Environment variables

Copy `.env.example` to `.env` locally. In production, put the same values in your host's environment-variable settings.

Important:
- Never commit `.env`.
- Never put PAYSTACK_SECRET_KEY in browser JavaScript.
- Use HTTPS in production.
- For M-Pesa, the callback URL must be publicly reachable.
- Set BASE_URL to your real HTTPS domain.

## 3. Telegram

Create a Telegram bot with BotFather, then:
- TELEGRAM_BOT_TOKEN = bot token
- TELEGRAM_OWNER_CHAT_ID = owner's chat ID

The bot must be able to message that chat.

## 4. Paystack

Set:
- PAYSTACK_SECRET_KEY
- PAYSTACK_PUBLIC_KEY
- PAYSTACK_CALLBACK_URL

For the webhook, configure this URL in Paystack Dashboard:

https://YOUR-DOMAIN.example/api/paystack/webhook

The application validates x-paystack-signature and then verifies the transaction before marking it successful.

## 5. M-Pesa

For sandbox:
MPESA_ENV=sandbox

For live:
MPESA_ENV=production

Set the Daraja consumer key, consumer secret, shortcode, passkey and callback URL.

Callback:
https://YOUR-DOMAIN.example/api/mpesa/callback

## 6. Render

Build:
npm install

Start:
npm start

Add environment variables in the Render dashboard.

## 7. Heroku

```bash
git push heroku main
```

The Procfile uses:
web: npm start

Add config vars in Heroku.

## 8. Vercel

Import the repository and deploy. Add the environment variables in Vercel.

The included vercel.json routes requests to index.js.

## Important production note

The sample uses an in-memory Map for transaction records. That is suitable for testing but not durable on serverless/restarting deployments. Before handling real customer orders or digital value, replace it with MongoDB/PostgreSQL and make fulfillment idempotent.

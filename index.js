require("dotenv").config();

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = Buffer.from(buf);
  }
}));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const CONFIG = {
  BASE_URL: process.env.BASE_URL || `http://localhost:${PORT}`,
  MPESA: {
    ENV: process.env.MPESA_ENV || "sandbox",
    CONSUMER_KEY: process.env.MPESA_CONSUMER_KEY,
    CONSUMER_SECRET: process.env.MPESA_CONSUMER_SECRET,
    SHORTCODE: process.env.MPESA_SHORTCODE,
    PASSKEY: process.env.MPESA_PASSKEY,
    CALLBACK_URL: process.env.MPESA_CALLBACK_URL ||
      `${process.env.BASE_URL || `http://localhost:${PORT}`}/api/mpesa/callback`
  },
  PAYSTACK: {
    SECRET_KEY: process.env.PAYSTACK_SECRET_KEY,
    PUBLIC_KEY: process.env.PAYSTACK_PUBLIC_KEY,
    CALLBACK_URL: process.env.PAYSTACK_CALLBACK_URL ||
      `${process.env.BASE_URL || `http://localhost:${PORT}`}/api/paystack/callback`
  },
  TELEGRAM: {
    BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    OWNER_CHAT_ID: process.env.TELEGRAM_OWNER_CHAT_ID
  },
  PAYMENT: {
    CURRENCY: process.env.CURRENCY || "KES",
    MIN_AMOUNT: Number(process.env.MIN_AMOUNT || 10)
  }
};

// Demo in-memory transaction store.
// For production, replace this with MongoDB/PostgreSQL so data survives restarts.
const transactions = new Map();

function reference(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(5).toString("hex")}`;
}

function normalizePhone(phone) {
  let p = String(phone || "").replace(/\D/g, "");
  if (p.startsWith("254")) return p;
  if (p.startsWith("07") || p.startsWith("01")) return "254" + p.slice(1);
  return p;
}

function validPhone(phone) {
  return /^254(?:7|1)\d{8}$/.test(phone);
}

function safeText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function notifyTelegram(text) {
  if (!CONFIG.TELEGRAM.BOT_TOKEN || !CONFIG.TELEGRAM.OWNER_CHAT_ID) {
    console.log("Telegram not configured.");
    return;
  }

  try {
    await axios.post(
      `https://api.telegram.org/bot${CONFIG.TELEGRAM.BOT_TOKEN}/sendMessage`,
      {
        chat_id: CONFIG.TELEGRAM.OWNER_CHAT_ID,
        text,
        parse_mode: "HTML"
      },
      { timeout: 15000 }
    );
  } catch (err) {
    console.error("Telegram notification error:", err.response?.data || err.message);
  }
}

async function mpesaToken() {
  const base = CONFIG.MPESA.ENV === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";

  const auth = Buffer.from(
    `${CONFIG.MPESA.CONSUMER_KEY}:${CONFIG.MPESA.CONSUMER_SECRET}`
  ).toString("base64");

  const response = await axios.get(
    `${base}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: { Authorization: `Basic ${auth}` },
      timeout: 15000
    }
  );

  return { base, token: response.data.access_token };
}

function markSuccessful(tx, details) {
  if (!tx || tx.status === "success") return false;
  tx.status = "success";
  tx.successAt = new Date().toISOString();
  tx.details = details || {};
  return true;
}

// ---------------- HEALTH ----------------

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "payment-site",
    mpesaConfigured: Boolean(
      CONFIG.MPESA.CONSUMER_KEY &&
      CONFIG.MPESA.CONSUMER_SECRET &&
      CONFIG.MPESA.SHORTCODE &&
      CONFIG.MPESA.PASSKEY
    ),
    paystackConfigured: Boolean(CONFIG.PAYSTACK.SECRET_KEY),
    telegramConfigured: Boolean(
      CONFIG.TELEGRAM.BOT_TOKEN &&
      CONFIG.TELEGRAM.OWNER_CHAT_ID
    )
  });
});

// ---------------- M-PESA STK ----------------

app.post("/api/mpesa/stkpush", async (req, res) => {
  try {
    const { name, email, phone, amount } = req.body;
    const value = Number(amount);

    if (!name || !email || !phone || !Number.isFinite(value)) {
      return res.status(400).json({ success: false, message: "All fields are required." });
    }
    if (value < CONFIG.PAYMENT.MIN_AMOUNT) {
      return res.status(400).json({
        success: false,
        message: `Minimum payment is KES ${CONFIG.PAYMENT.MIN_AMOUNT}.`
      });
    }

    const msisdn = normalizePhone(phone);
    if (!validPhone(msisdn)) {
      return res.status(400).json({ success: false, message: "Enter a valid Kenyan phone number." });
    }

    if (!CONFIG.MPESA.CONSUMER_KEY || !CONFIG.MPESA.CONSUMER_SECRET ||
        !CONFIG.MPESA.SHORTCODE || !CONFIG.MPESA.PASSKEY) {
      return res.status(500).json({ success: false, message: "M-Pesa is not configured." });
    }

    const { base, token } = await mpesaToken();
    const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const password = Buffer.from(
      `${CONFIG.MPESA.SHORTCODE}${CONFIG.MPESA.PASSKEY}${timestamp}`
    ).toString("base64");

    const ref = reference("MPESA");

    const response = await axios.post(
      `${base}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: CONFIG.MPESA.SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: Math.round(value),
        PartyA: msisdn,
        PartyB: CONFIG.MPESA.SHORTCODE,
        PhoneNumber: msisdn,
        CallBackURL: CONFIG.MPESA.CALLBACK_URL,
        AccountReference: ref,
        TransactionDesc: "Website Payment"
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        timeout: 20000
      }
    );

    const data = response.data;
    transactions.set(ref, {
      reference: ref,
      method: "mpesa",
      name,
      email,
      phone: msisdn,
      amount: value,
      currency: CONFIG.PAYMENT.CURRENCY,
      status: "pending",
      checkoutRequestID: data.CheckoutRequestID,
      createdAt: new Date().toISOString()
    });

    res.json({
      success: true,
      message: "STK Push sent. Check your phone and enter your M-Pesa PIN.",
      reference: ref,
      checkoutRequestID: data.CheckoutRequestID
    });
  } catch (err) {
    console.error("M-Pesa STK error:", err.response?.data || err.message);
    res.status(500).json({
      success: false,
      message: err.response?.data?.errorMessage || "Unable to initiate M-Pesa payment."
    });
  }
});

app.post("/api/mpesa/callback", async (req, res) => {
  // Acknowledge Safaricom quickly.
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });

  try {
    const callback = req.body?.Body?.stkCallback;
    if (!callback) return;

    const items = callback.CallbackMetadata?.Item || [];
    const get = (key) => items.find(x => x.Name === key)?.Value;

    let tx;
    for (const candidate of transactions.values()) {
      if (candidate.checkoutRequestID === callback.CheckoutRequestID) {
        tx = candidate;
        break;
      }
    }

    if (callback.ResultCode === 0) {
      const details = {
        amount: get("Amount"),
        receipt: get("MpesaReceiptNumber"),
        phone: get("PhoneNumber"),
        transactionDate: get("TransactionDate"),
        checkoutRequestID: callback.CheckoutRequestID
      };

      const firstSuccess = markSuccessful(tx, details);
      if (firstSuccess) {
        await notifyTelegram(
          `<b>✅ M-PESA PAYMENT SUCCESSFUL</b>\n\n` +
          `<b>Amount:</b> KES ${safeText(details.amount)}\n` +
          `<b>Receipt:</b> ${safeText(details.receipt)}\n` +
          `<b>Phone:</b> ${safeText(details.phone)}\n` +
          `<b>Customer:</b> ${safeText(tx?.name)}\n` +
          `<b>Email:</b> ${safeText(tx?.email)}\n` +
          `<b>Reference:</b> ${safeText(tx?.reference)}`
        );
      }
    } else {
      if (tx) tx.status = "failed";
      await notifyTelegram(
        `<b>❌ M-PESA PAYMENT FAILED</b>\n\n` +
        `<b>Reason:</b> ${safeText(callback.ResultDesc)}\n` +
        `<b>Reference:</b> ${safeText(tx?.reference || callback.CheckoutRequestID)}`
      );
    }
  } catch (err) {
    console.error("M-Pesa callback processing error:", err.message);
  }
});

// ---------------- PAYSTACK ----------------

app.post("/api/paystack/initialize", async (req, res) => {
  try {
    const { name, email, phone, amount } = req.body;
    const value = Number(amount);

    if (!name || !email || !phone || !Number.isFinite(value)) {
      return res.status(400).json({ success: false, message: "All fields are required." });
    }
    if (value < CONFIG.PAYMENT.MIN_AMOUNT) {
      return res.status(400).json({
        success: false,
        message: `Minimum payment is KES ${CONFIG.PAYMENT.MIN_AMOUNT}.`
      });
    }
    if (!CONFIG.PAYSTACK.SECRET_KEY) {
      return res.status(500).json({ success: false, message: "Paystack is not configured." });
    }

    const ref = reference("PAYSTACK");

    // Paystack expects amount in the currency subunit.
    const amountSubunit = Math.round(value * 100);

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: String(amountSubunit),
        currency: CONFIG.PAYMENT.CURRENCY,
        reference: ref,
        callback_url: CONFIG.PAYSTACK.CALLBACK_URL,
        channels: ["card"],
        metadata: {
          customer_name: name,
          phone,
          email
        }
      },
      {
        headers: {
          Authorization: `Bearer ${CONFIG.PAYSTACK.SECRET_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 20000
      }
    );

    transactions.set(ref, {
      reference: ref,
      method: "paystack",
      name,
      email,
      phone,
      amount: value,
      currency: CONFIG.PAYMENT.CURRENCY,
      status: "pending",
      paystackId: response.data.data.id,
      createdAt: new Date().toISOString()
    });

    res.json({
      success: true,
      authorization_url: response.data.data.authorization_url,
      reference: ref
    });
  } catch (err) {
    console.error("Paystack initialize error:", err.response?.data || err.message);
    res.status(500).json({
      success: false,
      message: err.response?.data?.message || "Unable to initialize card payment."
    });
  }
});

async function verifyPaystack(referenceValue) {
  const response = await axios.get(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(referenceValue)}`,
    {
      headers: {
        Authorization: `Bearer ${CONFIG.PAYSTACK.SECRET_KEY}`
      },
      timeout: 20000
    }
  );
  return response.data.data;
}

app.get("/api/paystack/callback", async (req, res) => {
  try {
    const ref = req.query.reference;
    if (!ref) return res.redirect("/failed.html");

    const transaction = await verifyPaystack(ref);
    const local = transactions.get(ref);

    const expected = local ? Math.round(local.amount * 100) : null;
    const amountMatches = expected === null || transaction.amount === expected;

    if (transaction.status !== "success" || !amountMatches) {
      if (local) local.status = "failed";
      return res.redirect("/failed.html");
    }

    const firstSuccess = markSuccessful(local, {
      paystackId: transaction.id,
      channel: transaction.channel,
      paidAt: transaction.paid_at,
      customerEmail: transaction.customer?.email
    });

    if (firstSuccess) {
      await notifyTelegram(
        `<b>✅ PAYSTACK PAYMENT SUCCESSFUL</b>\n\n` +
        `<b>Amount:</b> KES ${transaction.amount / 100}\n` +
        `<b>Email:</b> ${safeText(transaction.customer?.email)}\n` +
        `<b>Channel:</b> ${safeText(transaction.channel)}\n` +
        `<b>Reference:</b> ${safeText(ref)}\n` +
        `<b>Transaction ID:</b> ${safeText(transaction.id)}`
      );
    }

    res.redirect(`/success.html?reference=${encodeURIComponent(ref)}`);
  } catch (err) {
    console.error("Paystack callback error:", err.response?.data || err.message);
    res.redirect("/failed.html");
  }
});

app.post("/api/paystack/webhook", async (req, res) => {
  try {
    const signature = req.headers["x-paystack-signature"];
    const secret = CONFIG.PAYSTACK.SECRET_KEY;

    if (!signature || !secret || !req.rawBody) {
      return res.sendStatus(401);
    }

    const expected = crypto
      .createHmac("sha512", secret)
      .update(req.rawBody)
      .digest("hex");

    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.sendStatus(401);
    }

    // Acknowledge immediately; processing continues after validation.
    res.sendStatus(200);

    const event = req.body;
    if (event.event !== "charge.success") return;

    const data = event.data;
    const ref = data.reference;
    const local = transactions.get(ref);

    // Verify with Paystack and compare amount before treating as successful.
    const verified = await verifyPaystack(ref);
    const expectedAmount = local ? Math.round(local.amount * 100) : null;

    if (verified.status !== "success") return;
    if (expectedAmount !== null && verified.amount !== expectedAmount) {
      console.error("Paystack amount mismatch:", { ref, expectedAmount, received: verified.amount });
      return;
    }

    const firstSuccess = markSuccessful(local, {
      paystackId: verified.id,
      channel: verified.channel,
      paidAt: verified.paid_at
    });

    if (firstSuccess) {
      await notifyTelegram(
        `<b>🔔 PAYSTACK WEBHOOK PAYMENT SUCCESS</b>\n\n` +
        `<b>Amount:</b> KES ${verified.amount / 100}\n` +
        `<b>Reference:</b> ${safeText(ref)}\n` +
        `<b>Email:</b> ${safeText(verified.customer?.email)}\n` +
        `<b>Channel:</b> ${safeText(verified.channel)}`
      );
    }
  } catch (err) {
    console.error("Paystack webhook error:", err.response?.data || err.message);
  }
});

// ---------------- OPTIONAL STATUS ----------------

app.get("/api/payment/:reference", (req, res) => {
  const tx = transactions.get(req.params.reference);
  if (!tx) return res.status(404).json({ success: false, message: "Transaction not found." });

  res.json({
    success: true,
    transaction: {
      reference: tx.reference,
      method: tx.method,
      amount: tx.amount,
      currency: tx.currency,
      status: tx.status,
      createdAt: tx.createdAt,
      successAt: tx.successAt || null
    }
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Payment site listening on port ${PORT}`);
  });
}

module.exports = app;

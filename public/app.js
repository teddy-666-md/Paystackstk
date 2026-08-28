const $ = (id) => document.getElementById(id);

function data() {
  return {
    name: $("name").value.trim(),
    email: $("email").value.trim(),
    phone: $("phone").value.trim(),
    amount: $("amount").value
  };
}

function message(text, ok = true) {
  const el = $("message");
  el.textContent = text;
  el.className = `message ${ok ? "ok" : "bad"}`;
}

function validate(d) {
  if (!d.name || !d.email || !d.phone || !d.amount) {
    message("Please complete all fields.", false);
    return false;
  }
  if (Number(d.amount) < 10) {
    message("Minimum payment is KES 10.", false);
    return false;
  }
  return true;
}

$("mpesa").onclick = async () => {
  const d = data();
  if (!validate(d)) return;

  $("mpesa").disabled = true;
  $("mpesa").textContent = "Sending STK Push...";

  try {
    const r = await fetch("/api/mpesa/stkpush", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(d)
    });
    const result = await r.json();
    if (!result.success) throw new Error(result.message);

    message("STK Push sent. Check your phone and enter your M-Pesa PIN.");
  } catch (e) {
    message(e.message || "M-Pesa payment failed.", false);
  } finally {
    $("mpesa").disabled = false;
    $("mpesa").textContent = "📱 Pay with M-Pesa";
  }
};

$("card").onclick = async () => {
  const d = data();
  if (!validate(d)) return;

  $("card").disabled = true;
  $("card").textContent = "Opening checkout...";

  try {
    const r = await fetch("/api/paystack/initialize", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(d)
    });
    const result = await r.json();
    if (!result.success) throw new Error(result.message);

    window.location.href = result.authorization_url;
  } catch (e) {
    message(e.message || "Unable to open card checkout.", false);
    $("card").disabled = false;
    $("card").textContent = "💳 Pay with Card";
  }
};
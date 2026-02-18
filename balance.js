require("dotenv").config();
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { createClient } = require("@supabase/supabase-js");

// ============================================
// CONFIGURATION
// ============================================
const INSTANCE_ID = parseInt(process.env.INSTANCE_ID);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const BOT = "patrickstarsrobot";
const ADMIN = "Aliorythm";
const API_ID = parseInt(process.env.API_ID);
const API_HASH = process.env.API_HASH;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ============================================
// GET BALANCE
// ============================================
async function getBalance(client) {
  console.log("[BALANCE] Getting balance...");
  
  await client.sendMessage(BOT, { message: "/start" });
  await sleep(4000);
  
  const msgs = await client.getMessages(BOT, { limit: 5 });
  const menu = msgs.find(m => m.text?.includes("Получи свою личную ссылку") && m.replyMarkup);
  
  if (!menu) throw new Error("Main menu not found");
  
  await sleep(2000);
  await menu.click({ text: "👤 Профиль" });
  await sleep(3000);
  
  const profileMsgs = await client.getMessages(BOT, { limit: 3 });
  const profile = profileMsgs.find(m => m.text?.includes("✨ Профиль"));
  
  if (!profile) throw new Error("Profile not found");
  
  console.log("[BALANCE] Profile found:");
  console.log(profile.text);
  
  const balanceMatch = profile.text.match(/💰 Баланс:\s*([\d.]+)\s*⭐️/);
  if (!balanceMatch) throw new Error("Balance not found in profile");
  
  const balance = parseFloat(balanceMatch[1]);
  console.log(`[BALANCE] Balance: ${balance} ⭐️`);
  
  return balance;
}

// ============================================
// SEND TO ADMIN
// ============================================
async function sendBalanceToAdmin(client, phone, balance) {
  const message = `💰 Balance Report\n\nPhone: ${phone}\nBalance: ${balance} ⭐️\n\nTime: ${new Date().toLocaleString()}`;
  await client.sendMessage(ADMIN, { message });
  console.log(`[BALANCE] Sent to @${ADMIN}`);
}

// ============================================
// PROCESS ACCOUNT
// ============================================
async function processAccount(acc) {
  console.log(`\n━━━ Account ${acc.phone} ━━━`);
  
  let client;
  try {
    client = new TelegramClient(new StringSession(acc.session_string), API_ID, API_HASH, {
      connectionRetries: 5,
      receiveUpdates: false,
    });

    await client.connect();
    console.log("✅ Connected");

    const balance = await getBalance(client);
    await sleep(2000);
    await sendBalanceToAdmin(client, acc.phone, balance);

    console.log("✅ Balance check complete");
    return balance;
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    return null;
  } finally {
    if (client) {
      await sleep(500);
      try {
        await client.destroy();
        console.log("🔌 Disconnected");
      } catch (e) {}
    }
  }
}

// ============================================
// MAIN
// ============================================
async function main() {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`💰 BALANCE CHECK - Instance ${INSTANCE_ID}`);
  console.log(`📅 ${new Date().toLocaleString()}`);
  console.log("=".repeat(50));

  const { data: accounts } = await supabase
    .from("accounts")
    .select("*")
    .eq("instance_id", INSTANCE_ID)
    .eq("is_active", true);

  if (!accounts || accounts.length === 0) {
    console.log("❌ No active accounts found");
    return;
  }

  console.log(`📋 Found ${accounts.length} account(s)\n`);

  let totalBalance = 0;
  let successCount = 0;

  for (const acc of accounts) {
    const balance = await processAccount(acc);
    if (balance !== null) {
      totalBalance += balance;
      successCount++;
    }
    await sleep(2000);
  }

  const summary = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 TOTAL BALANCE SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Instance: ${INSTANCE_ID}
Accounts checked: ${successCount}/${accounts.length}
Total Balance: ${totalBalance.toFixed(2)} ⭐️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

  console.log(`\n${summary}`);

  // Also send summary to admin via first available client
  if (successCount > 0) {
    let adminClient;
    try {
      adminClient = new TelegramClient(new StringSession(accounts[0].session_string), API_ID, API_HASH, {
        connectionRetries: 3,
        receiveUpdates: false,
      });
      await adminClient.connect();
      await adminClient.sendMessage(ADMIN, { message: `📊 Balance Summary\n\nInstance: ${INSTANCE_ID}\nAccounts: ${successCount}/${accounts.length}\nTotal: ${totalBalance.toFixed(2)} ⭐️\n\nTime: ${new Date().toLocaleString()}` });
      await adminClient.destroy();
    } catch (e) {
      console.log(`Failed to send summary to admin: ${e.message}`);
    }
  }

  console.log("\n✅ All accounts processed\n");
}

// ============================================
// RUN (only when executed directly)
// ============================================
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Fatal error:", err);
      process.exit(1);
    });
}

module.exports = { main };
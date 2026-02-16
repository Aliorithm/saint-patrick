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
  
  // Send /start to get main menu
  await client.sendMessage(BOT, { message: "/start" });
  await sleep(4000);
  
  // Get messages and find main menu
  const msgs = await client.getMessages(BOT, { limit: 5 });
  const menu = msgs.find(m => m.text?.includes("Получи свою личную ссылку") && m.replyMarkup);
  
  if (!menu) {
    throw new Error("Main menu not found");
  }
  
  // Click on Профиль
  await sleep(2000);
  await menu.click({ text: "👤 Профиль" });
  await sleep(3000);
  
  // Get profile message
  const profileMsgs = await client.getMessages(BOT, { limit: 3 });
  const profile = profileMsgs.find(m => m.text?.includes("✨ Профиль"));
  
  if (!profile) {
    throw new Error("Profile not found");
  }
  
  console.log("[BALANCE] Profile found:");
  console.log(profile.text);
  
  // Extract balance using regex
  const balanceMatch = profile.text.match(/💰 Баланс:\s*([\d.]+)\s*⭐️/);
  if (!balanceMatch) {
    throw new Error("Balance not found in profile");
  }
  
  const balance = balanceMatch[1];
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
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
  } finally {
    if (client) {
      await sleep(500);
      try {
        await client.destroy();
        console.log("🔌 Disconnected");
      } catch (e) {
        // Suppress errors
      }
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

  // Get all active accounts for this instance
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

  for (const acc of accounts) {
    await processAccount(acc);
    await sleep(2000);
  }

  console.log("\n✅ All accounts processed\n");
}

// ============================================
// RUN
// ============================================
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
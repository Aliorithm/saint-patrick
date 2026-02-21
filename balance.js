require("dotenv").config();
const { TelegramClient, Api } = require("telegram");
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
// SPONSOR DETECTION
// Mirrors index.js — all known gate screen patterns in one place.
// Update here when the bot adds new sponsor message variants.
// ============================================
function isSponsorMsg(m) {
  if (!m?.replyMarkup) return false;
  const t = m.text || "";
  return (
    t.includes("Чтобы активировать бота:")          ||  // classic activation gate
    t.includes("Для продолжения фарма звёзд")        ||  // farming continuation gate
    t.includes("Подпишись на спонсорский канал")     ||  // direct subscribe request
    t.includes("Подпишись на канал спонсора")        ||  // alt phrasing
    t.includes("Спонсорский канал")                  ||  // generic sponsor channel header
    t.includes("Подпишитесь на канал")               ||  // polite subscribe form
    (t.includes("спонсор") && t.includes("подпис"))  ||  // loose combo: sponsor + subscribe
    t.includes("активируй бота")                     ||  // activate bot phrase
    (t.includes("канал") && t.includes("Продолжить") && !!m.replyMarkup) // channel + continue btn
  );
}

// ============================================
// HELPERS
// ============================================
function resolveUrl(url) {
  try {
    const p = new URL(url);
    const real = p.searchParams.get("redirect_url")
      || p.searchParams.get("redirectUrl")
      || p.searchParams.get("redirect")
      || p.searchParams.get("url")
      || p.searchParams.get("link");
    if (real) return decodeURIComponent(real);
  } catch (_) {}
  return url;
}

async function getCallbackAnswer(client, msg, data) {
  try {
    const r = await client.invoke(new Api.messages.GetBotCallbackAnswer({
      peer: BOT, msgId: msg.id, data,
    }));
    return r.message || null;
  } catch (e) {
    return e.message?.includes("MESSAGE_ID_INVALID") ? "MESSAGE_EXPIRED" : null;
  }
}

async function joinChannel(client, identifier, tag) {
  try {
    if (identifier.startsWith("+")) {
      await client.invoke(new Api.messages.ImportChatInvite({ hash: identifier.substring(1) }));
    } else {
      await client.invoke(new Api.channels.JoinChannel({ channel: identifier }));
    }
    console.log(`[${tag}] Joined OK`);
    return "joined";
  } catch (e) {
    if (e.message?.includes("USER_ALREADY_PARTICIPANT") || e.message?.includes("INVITE_REQUEST_SENT")) {
      console.log(`[${tag}] Already a member`);
      return "already";
    }
    if ((e.message || "").toUpperCase().includes("CHANNELS_TOO_MUCH")) {
      console.log(`[${tag}] Channel limit reached`);
      return "limit";
    }
    console.log(`[${tag}] Join failed (skipping): ${e.message}`);
    return "failed";
  }
}

// ============================================
// SPONSOR HANDLER
// Same logic as index.js — handles all known sponsor/gate screen types.
// Returns true if the gate was cleared, false if unresolvable.
// ============================================
async function handleSponsor(client, sponsorMsg) {
  console.log("[SPONSOR] Processing...");

  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`[SPONSOR] Attempt ${attempt}/3`);

    const msgs     = await client.getMessages(BOT, { limit: 5 });
    const freshMsg = msgs.find(m => isSponsorMsg(m)) || sponsorMsg;

    if (!freshMsg?.replyMarkup?.rows) { console.log("[SPONSOR] No buttons"); return false; }

    const actionBtns = [];
    let verifyBtn    = null;

    for (const row of freshMsg.replyMarkup.rows)
      for (const btn of row.buttons) {
        const t = btn.text || "";
        // Verify / continue / done buttons (callback, no URL)
        if (
          (t.includes("Я выполнил") || t.includes("Проверить") ||
           t.includes("Продолжить") || t.includes("Готово")) &&
          !btn.url
        ) {
          verifyBtn = btn;
          continue;
        }
        if (btn.url) { actionBtns.push(btn); continue; }
        // Callback-only subscribe/open buttons
        if (t.includes("Подписаться") || t.includes("Перейти") || t.includes("Открыть")) {
          actionBtns.push(btn);
        }
      }

    console.log(`[SPONSOR] ${actionBtns.length} action(s), verify: ${!!verifyBtn}`);

    for (const btn of actionBtns) {
      const url  = resolveUrl(btn.url || "");
      const text = btn.text || "";
      console.log(`[SPONSOR] "${text}" → ${url || "(callback)"}`);
      await sleep(2000 + Math.random() * 2000);

      // Callback-only button (no URL)
      if (!btn.url && btn.data) {
        try {
          await getCallbackAnswer(client, freshMsg, btn.data);
          console.log(`[SPONSOR] Callback clicked: "${text}"`);
          await sleep(2000 + Math.random() * 1000);
        } catch (e) { console.log(`[SPONSOR] Callback click failed: ${e.message}`); }
        continue;
      }

      try {
        const botMatch     = url.match(/t\.me\/([^?/]+)\?start=(.+)/);
        const channelMatch = !botMatch && url.match(/t\.me\/(.+)/);

        if (botMatch) {
          console.log(`[SPONSOR] Starting bot @${botMatch[1]}`);
          await client.sendMessage(botMatch[1], { message: `/start ${botMatch[2]}` });
          await sleep(3000 + Math.random() * 2000);

        } else if (channelMatch) {
          const id = channelMatch[1].split("?")[0];
          await joinChannel(client, id, "SPONSOR");

        } else if (url.includes("startapp")) {
          if (url.includes("patrickgamesbot")) {
            await joinChannel(client, "patrickgames_news", "SPONSOR");
          } else {
            const bot = url.match(/t\.me\/([^/?]+)/)?.[1];
            if (bot) {
              console.log(`[SPONSOR] Webapp /start @${bot}`);
              await client.sendMessage(bot, { message: "/start" });
              await sleep(3000 + Math.random() * 2000);
            }
          }

        } else {
          console.log(`[SPONSOR] Unknown URL — simulating visit`);
          await sleep(4000 + Math.random() * 3000);
        }
      } catch (e) {
        console.log(`[SPONSOR] Button error (skipping): ${e.message}`);
      }

      await sleep(1500 + Math.random() * 1500);
    }

    if (!verifyBtn) { console.log("[SPONSOR] No verify button"); return false; }

    console.log("[SPONSOR] Clicking verify...");
    await sleep(2000 + Math.random() * 1000);
    const verifyPopup = await getCallbackAnswer(client, freshMsg, verifyBtn.data);
    console.log(`[SPONSOR] Verify: ${verifyPopup || "none"}`);

    if (verifyPopup?.includes("Подпишись на все каналы")) {
      console.log(`[SPONSOR] Not all done — RequestAppWebView fallback`);
      for (const btn of actionBtns) {
        const burl = resolveUrl(btn.url || "");
        if (!burl.includes("startapp") || burl.includes("patrickgamesbot")) continue;
        const bot = burl.match(/t\.me\/([^/?]+)/)?.[1];
        if (!bot) continue;
        try {
          const peer = await client.getEntity(bot);
          await client.invoke(new Api.messages.RequestAppWebView({
            peer, platform: "android", startParam: "", writeAllowed: true,
            app: new Api.InputBotAppShortName({ botId: peer, shortName: "app" }),
          }));
          console.log(`[SPONSOR] RequestAppWebView done @${bot}`);
        } catch (e) { console.log(`[SPONSOR] RequestAppWebView failed @${bot}: ${e.message}`); }
        await sleep(2000);
      }
      await sleep(3000);
      continue; // retry verification
    }

    console.log("[SPONSOR] Verified");
    await sleep(5000 + Math.random() * 3000);
    return true;
  }

  console.log("[SPONSOR] Failed after 3 attempts");
  return false;
}

// ============================================
// GET BALANCE
// Navigates to the Profile page and reads the star balance.
// Handles sponsor/gate screens that may block the main menu.
// ============================================
async function getBalance(client) {
  console.log("[BALANCE] Getting balance...");

  // Step 1: Open main menu
  await client.sendMessage(BOT, { message: "/start" });
  await sleep(4000);

  let msgs = await client.getMessages(BOT, { limit: 5 });

  // Step 2: Detect and resolve any sponsor/gate screen before proceeding
  const sponsorMsg = msgs.find(m => isSponsorMsg(m));
  if (sponsorMsg) {
    console.log("[BALANCE] Sponsor screen detected — resolving before reading balance...");
    const resolved = await handleSponsor(client, sponsorMsg);
    if (!resolved) {
      throw new Error("Sponsor screen could not be cleared — balance check aborted");
    }
    // Re-open main menu after sponsor is cleared
    await client.sendMessage(BOT, { message: "/start" });
    await sleep(4000);
    msgs = await client.getMessages(BOT, { limit: 5 });
  }

  // Step 3: Find the main menu
  const menu = msgs.find(m => m.text?.includes("Получи свою личную ссылку") && m.replyMarkup);
  if (!menu) throw new Error("Main menu not found");

  // Step 4: Navigate to Profile (prefer callback data for reliability)
  await sleep(2000);
  const profileBtn = menu.replyMarkup?.rows
    ?.flatMap(r => r.buttons)
    .find(b => b.text?.includes("Профиль"));

  if (profileBtn?.data) {
    await getCallbackAnswer(client, menu, profileBtn.data);
  } else {
    try { await menu.click({ text: "👤 Профиль" }); } catch (_) {}
  }
  await sleep(3000);

  // Step 5: Another sponsor may appear after clicking Profile — handle it
  msgs = await client.getMessages(BOT, { limit: 5 });
  const midSponsor = msgs.find(m => isSponsorMsg(m));
  if (midSponsor) {
    console.log("[BALANCE] Sponsor appeared after Profile click — resolving...");
    const resolved = await handleSponsor(client, midSponsor);
    if (!resolved) throw new Error("Mid-flow sponsor screen could not be cleared");

    // Navigate back to Profile after clearing
    await client.sendMessage(BOT, { message: "/start" });
    await sleep(4000);
    msgs = await client.getMessages(BOT, { limit: 5 });
    const menu2 = msgs.find(m => m.text?.includes("Получи свою личную ссылку") && m.replyMarkup);
    if (menu2) {
      const pb2 = menu2.replyMarkup?.rows?.flatMap(r => r.buttons).find(b => b.text?.includes("Профиль"));
      if (pb2?.data) await getCallbackAnswer(client, menu2, pb2.data);
      else try { await menu2.click({ text: "👤 Профиль" }); } catch (_) {}
    }
    await sleep(3000);
    msgs = await client.getMessages(BOT, { limit: 5 });
  }

  // Step 6: Read the profile message
  const profile = msgs.find(m => m.text?.includes("✨ Профиль") || m.text?.includes("Профиль"));
  if (!profile) throw new Error("Profile not found");

  console.log("[BALANCE] Profile found:");
  console.log(profile.text);

  // Step 7: Extract balance
  const balanceMatch = profile.text.match(/💰 Баланс:\s*([\d.]+)\s*⭐️/);
  if (!balanceMatch) throw new Error("Balance not found in profile");

  const balance = parseFloat(balanceMatch[1]);
  console.log(`[BALANCE] Balance: ${balance} ⭐️`);
  return balance;
}

// ============================================
// SEND TO ADMIN
// ============================================
async function sendBalanceToAdmin(client, phone, balance, sponsorCleared) {
  const sponsorNote = sponsorCleared ? "\n⚠️ Note: Sponsor screen was cleared before check" : "";
  const message = `💰 Balance Report\n\nPhone: ${phone}\nBalance: ${balance} ⭐️${sponsorNote}\n\nTime: ${new Date().toLocaleString()}`;
  await client.sendMessage(ADMIN, { message });
  console.log(`[BALANCE] Sent to @${ADMIN}`);
}

// ============================================
// PROCESS ACCOUNT
// ============================================
async function processAccount(acc) {
  console.log(`\n━━━ Account ${acc.phone} ━━━`);

  let client;
  let sponsorCleared = false;

  try {
    client = new TelegramClient(new StringSession(acc.session_string), API_ID, API_HASH, {
      connectionRetries: 5,
      receiveUpdates: false,
    });

    await client.connect();
    console.log("Connected");

    // Pre-check: look for any sponsor screen immediately after connecting
    const initMsgs = await client.getMessages(BOT, { limit: 5 });
    const initSponsor = initMsgs.find(m => isSponsorMsg(m));
    if (initSponsor) {
      console.log("[BALANCE] Pre-check sponsor screen found — resolving...");
      const ok = await handleSponsor(client, initSponsor);
      if (ok) {
        sponsorCleared = true;
        console.log("[BALANCE] Sponsor cleared");
      } else {
        console.log("[BALANCE] Could not clear sponsor — attempting balance check anyway");
      }
    }

    const balance = await getBalance(client);
    await sleep(2000);
    await sendBalanceToAdmin(client, acc.phone, balance, sponsorCleared);

    console.log("Balance check complete");
    return balance;
  } catch (error) {
    console.error(`Error: ${error.message}`);
    return null;
  } finally {
    if (client) {
      await sleep(500);
      try { await client.destroy(); console.log("Disconnected"); } catch (e) {}
    }
  }
}

// ============================================
// MAIN
// ============================================
async function main() {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`BALANCE CHECK - Instance ${INSTANCE_ID}`);
  console.log(`${new Date().toLocaleString()}`);
  console.log("=".repeat(50));

  const { data: accounts } = await supabase
    .from("accounts")
    .select("*")
    .eq("instance_id", INSTANCE_ID)
    .eq("is_active", true);

  if (!accounts || accounts.length === 0) {
    console.log("No active accounts found");
    return;
  }

  console.log(`Found ${accounts.length} account(s)\n`);

  let totalBalance = 0;
  let successCount = 0;
  const richAccounts = []; // accounts with balance >= 50 stars

  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    const balance = await processAccount(acc);
    if (balance !== null) {
      totalBalance += balance;
      successCount++;
      if (balance >= 50) {
        richAccounts.push({ num: i + 1, phone: acc.phone, balance });
      }
    }
    await sleep(2000);
  }

  // Build the "50+ stars" section
  const richSection = richAccounts.length > 0
    ? `\n\n⭐️ Accounts with 50+ stars (${richAccounts.length}):\n` +
      richAccounts
        .sort((a, b) => b.balance - a.balance)
        .map(a => `  #${a.num} ${a.phone} — ${a.balance.toFixed(2)} ⭐️`)
        .join("\n")
    : "\n\nNo accounts reached 50 ⭐️";

  const summary = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TOTAL BALANCE SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Instance: ${INSTANCE_ID}
Accounts checked: ${successCount}/${accounts.length}
Total Balance: ${totalBalance.toFixed(2)} ⭐️${richSection}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

  console.log(`\n${summary}`);

  if (successCount > 0) {
    let adminClient;
    try {
      adminClient = new TelegramClient(new StringSession(accounts[0].session_string), API_ID, API_HASH, {
        connectionRetries: 3,
        receiveUpdates: false,
      });
      await adminClient.connect();
      await adminClient.sendMessage(ADMIN, {
        message: `💰 Balance Summary\n\nInstance: ${INSTANCE_ID}\nAccounts: ${successCount}/${accounts.length}\nTotal: ${totalBalance.toFixed(2)} ⭐️${richSection}\n\nTime: ${new Date().toLocaleString()}`,
      });
      await adminClient.destroy();
    } catch (e) {
      console.log(`Failed to send summary to admin: ${e.message}`);
    }
  }

  console.log("\nAll accounts processed\n");
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
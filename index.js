require("dotenv").config();
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { createClient } = require("@supabase/supabase-js");
const express = require("express");

// ============================================
// CONFIG
// ============================================
const INSTANCE_ID = parseInt(process.env.INSTANCE_ID);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const BOT = "patrickstarsrobot";
const ADMIN = "Aliorythm"; // Admin username for error notifications
const API_ID = parseInt(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const PORT = process.env.PORT || 10000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const delay = () => 2000 + Math.random() * 2000; // 2-4s

const CLICKER_MIN = 10;
const CLICKER_MAX = 5;
const DAILY = 24 * 60;

// ============================================
// SUPABASE
// ============================================
async function getAccountsDue() {
  const now = new Date().toISOString();
  const { data } = await supabase
    .from("accounts")
    .select("*")
    .eq("instance_id", INSTANCE_ID)
    .eq("is_active", true)
    .or(`next_clicker_time.lte.${now},next_daily_time.lte.${now}`);
  return data || [];
}

async function updateAccount(userId, updates) {
  await supabase.from("accounts").update(updates).eq("user_id", userId);
}

async function incrementError(userId, error) {
  const { data } = await supabase.from("accounts").select("error_count").eq("user_id", userId).single();
  const count = (data?.error_count || 0) + 1;
  
  if (count >= 3) {
    await updateAccount(userId, { is_active: false, last_error: error, error_count: count });
    console.log(`❌ Account ${userId} disabled after 3 errors`);
  } else {
    await updateAccount(userId, { last_error: error, error_count: count });
    console.log(`⚠️ Account ${userId} error ${count}/3`);
  }
}

async function sendErrorNotification(client, userId, error, phone) {
  try {
    const message = `⚠️ Error Alert\n\nInstance: ${INSTANCE_ID}\nUser: ${userId}\nPhone: ${phone || "unknown"}\nError: ${error}\n\nTime: ${new Date().toLocaleString()}`;
    await client.sendMessage(ADMIN, { message });
    console.log(`📨 Error notification sent to @${ADMIN}`);
  } catch (e) {
    console.log(`Failed to send notification: ${e.message}`);
  }
}

// ============================================
// HELPERS
// ============================================
async function getCallbackAnswer(client, msg, buttonData) {
  try {
    const result = await client.invoke(
      new Api.messages.GetBotCallbackAnswer({
        peer: BOT,
        msgId: msg.id,
        data: buttonData,
      })
    );
    return result.message || null;
  } catch {
    return null;
  }
}

function findButton(msg, textPart) {
  if (!msg.replyMarkup?.rows) return null;
  for (const row of msg.replyMarkup.rows) {
    for (const btn of row.buttons) {
      if (btn.text?.includes(textPart)) return btn;
    }
  }
  return null;
}

async function getMainMenu(client) {
  const msgs = await client.getMessages(BOT, { limit: 5 });
  return msgs.find(m => m.text?.includes("Получи свою личную ссылку") && m.replyMarkup);
}

async function ensureMenu(client) {
  let menu = await getMainMenu(client);
  if (!menu) {
    await client.sendMessage(BOT, { message: "/start" });
    await sleep(4000);
    menu = await getMainMenu(client);
  }
  return menu;
}

// ============================================
// CAPTCHA
// ============================================
async function solveCaptcha(client) {
  const msgs = await client.getMessages(BOT, { limit: 3 });
  const captcha = msgs.find(m => m.text?.includes("ПРОВЕРКА НА РОБОТА"));
  if (!captcha) return true;

  const match = captcha.text.match(/(\d+)\s*([\+\-\*\/])\s*(\d+)/);
  if (!match) return false;

  const [, a, op, b] = match;
  const answer = eval(`${a}${op}${b}`);
  console.log(`[CAPTCHA] ${a} ${op} ${b} = ${answer}`);

  await sleep(3000 + Math.random() * 3000);

  for (const row of captcha.replyMarkup.rows) {
    for (const btn of row.buttons) {
      if (btn.text === answer.toString()) {
        await captcha.click({ data: btn.data });
        return true;
      }
    }
  }
  return false;
}

// ============================================
// TASKS
// ============================================
async function handleTasks(client, userId) {
  console.log("[TASK] Starting...");
  
  const menu = await ensureMenu(client);
  await sleep(delay());
  await menu.click({ text: "📝 Задания" });
  await sleep(delay());

  const joined = [];
  let completed = 0;

  for (let i = 0; i < 5; i++) {
    console.log(`[TASK] Attempt ${i + 1}/5`);
    
    const msgs = await client.getMessages(BOT, { limit: 3 });
    const taskMsg = msgs.find(m => m.text?.includes("Новое задание") && m.replyMarkup);
    
    if (!taskMsg) {
      console.log("[TASK] No more tasks");
      break;
    }

    // Find buttons
    const buttons = {};
    for (const row of taskMsg.replyMarkup.rows) {
      for (const btn of row.buttons) {
        if (btn.url && (btn.text.includes("бота") || btn.text.includes("Подпис") || btn.text.includes("приложение"))) {
          buttons.action = btn;
          console.log(`[TASK] Action: ${btn.text}`);
        }
        if (btn.text?.includes("Подтвердить")) buttons.verify = btn;
        if (btn.text?.includes("Пропустить")) buttons.skip = btn;
      }
    }

    if (!buttons.action?.url) {
      console.log("[TASK] No action button");
      break;
    }

    const url = buttons.action.url;
    console.log(`[TASK] URL: ${url.substring(0, 50)}...`);

    // Parse URL
    let entity = null;
    if (url.includes("?start=") && !url.includes("startapp")) {
      // Bot
      const match = url.match(/t\.me\/([^?]+)\?start=(.+)/);
      if (match) {
        const [, bot, param] = match;
        console.log(`[TASK] Bot: @${bot}`);
        await sleep(2000);
        await client.sendMessage(bot, { message: `/start ${param}` });
        entity = { type: "bot", name: bot };
      }
    } else if (!url.includes("startapp")) {
      // Channel or Group
      const match = url.match(/t\.me\/(.+)/);
      if (match) {
        const identifier = match[1];
        console.log(`[TASK] Channel: ${identifier}`);
        await sleep(2000);
        
        try {
          if (identifier.startsWith("+")) {
            // Private channel - use invite hash
            const hash = identifier.substring(1); // Remove '+'
            console.log(`[TASK] Using invite hash: ${hash}`);
            await client.invoke(
              new Api.messages.ImportChatInvite({
                hash: hash,
              })
            );
          } else {
            // Public channel - use username
            await client.invoke(
              new Api.channels.JoinChannel({
                channel: identifier,
              })
            );
          }
          entity = { type: "channel", name: identifier };
          console.log("[TASK] Join successful");
        } catch (e) {
          // USER_ALREADY_PARTICIPANT and INVITE_REQUEST_SENT are both success!
          if (e.message.includes("USER_ALREADY_PARTICIPANT") || e.message.includes("INVITE_REQUEST_SENT")) {
            console.log("[TASK] Already joined or request sent (success)");
            entity = { type: "channel", name: identifier };
          } else {
            console.log(`[TASK] Join failed: ${e.message}`);
          }
        }
      }
    } else {
      console.log("[TASK] Web app - will try verify anyway");
    }

    // Verify
    if (buttons.verify) {
      console.log("[TASK] Clicking verify...");
      await sleep(2000);
      
      let popup = null;
      try {
        popup = await getCallbackAnswer(client, taskMsg, buttons.verify.data);
        console.log(`[TASK] Popup: ${popup || "none"}`);
      } catch (e) {
        if (e.message.includes("MESSAGE_ID_INVALID")) {
          console.log("[TASK] Message expired, checking messages...");
          await sleep(1000);
          const msgs = await client.getMessages(BOT, { limit: 3 });
          const successMsg = msgs.find(m => 
            m.text?.includes("выполнено") || m.text?.includes("получена")
          );
          const failMsg = msgs.find(m => 
            m.text?.includes("не найдена")
          );
          
          if (successMsg) {
            popup = "✅ Задание выполнено";
            console.log("[TASK] Found success in messages");
          } else if (failMsg) {
            popup = "❌ Подписка не найдена";
            console.log("[TASK] Found failure in messages");
          } else {
            console.log("[TASK] No clear result, assuming success");
            popup = "✅ Задание выполнено"; // Assume success if we joined
          }
        } else {
          console.log(`[TASK] Callback error: ${e.message} - assuming success`);
          popup = "✅ Задание выполнено"; // Assume success
        }
      }

      if (popup?.includes("выполнено") || popup?.includes("получена")) {
        console.log("[TASK] ✅ Success!");
        if (entity) joined.push(entity);
        completed++;
        // Bot says "2 tasks" but 1 is enough - break here!
        console.log("[TASK] Task completed, that's enough!");
        break;
      }

      if (popup?.includes("не найдена")) {
        console.log("[TASK] ❌ Failed");
        if (buttons.skip) {
          await sleep(1500);
          await taskMsg.click({ data: buttons.skip.data });
          await sleep(2000);
          continue;
        }
      }
      
      // If we get here and we joined something, assume success
      if (entity) {
        console.log("[TASK] ✅ Joined but unclear result - assuming success");
        joined.push(entity);
        completed++;
        break; // That's enough
      }
    }

    // If we get here, something went wrong - skip
    if (buttons.skip) {
      await sleep(1500);
      await taskMsg.click({ data: buttons.skip.data });
      await sleep(2000);
    } else {
      break;
    }
  }

  // Leave channels
  for (const entity of joined) {
    if (entity.type === "channel") {
      try {
        await sleep(1000);
        await client.invoke(new Api.channels.LeaveChannel({ channel: entity.name }));
        console.log(`[TASK] Left ${entity.name}`);
      } catch (e) {
        console.log(`[TASK] Leave failed: ${e.message}`);
      }
    }
  }

  console.log(`[TASK] Completed ${completed} task(s)`);
  return completed > 0;
}

// ============================================
// CLICKER
// ============================================
async function doClicker(client, userId) {
  console.log("[CLICKER] Starting...");
  
  const menu = await ensureMenu(client);
  await sleep(delay());
  
  const clickerBtn = findButton(menu, "Кликер");
  if (!clickerBtn?.data) {
    await menu.click({ text: "✨ Кликер" });
  } else {
    const popup = await getCallbackAnswer(client, menu, clickerBtn.data);
    console.log(`[CLICKER] Popup: ${popup || "none"}`);
    
    // Check for daily limit FIRST
    if (popup?.includes("завтра") || popup?.includes("слишком много")) {
      console.log("[CLICKER] ⚠️ Daily limit reached!");
      await updateAccount(userId, {
        next_clicker_time: new Date(Date.now() + DAILY * 60000).toISOString(),
        last_error: "Daily limit: Ты слишком много кликал",
      });
      return false;
    }
    
    // Check for task required
    if (popup?.includes("выполни хотя бы")) {
      console.log("[CLICKER] Task required!");
      const ok = await handleTasks(client, userId);
      
      if (ok) {
        console.log("[CLICKER] Tasks done, clicking again...");
        await sleep(delay());
        await client.sendMessage(BOT, { message: "/start" });
        await sleep(4000);
        const menu2 = await ensureMenu(client);
        await menu2.click({ text: "✨ Кликер" });
      } else {
        console.log("[CLICKER] Tasks failed");
        return false;
      }
    }
  }

  await sleep(delay());
  await solveCaptcha(client);

  await updateAccount(userId, {
    next_clicker_time: new Date(Date.now() + (CLICKER_MIN + Math.random() * CLICKER_MAX) * 60000).toISOString(),
    error_count: 0,
    last_error: null,
  });

  console.log("[CLICKER] ✅ Success");
  return true;
}

// ============================================
// DAILY
// ============================================
async function doDaily(client, userId) {
  console.log("[DAILY] Starting...");
  
  const menu = await ensureMenu(client);
  await sleep(delay());
  await menu.click({ text: "👤 Профиль" });
  await sleep(delay());

  const msgs = await client.getMessages(BOT, { limit: 3 });
  const profile = msgs.find(m => m.replyMarkup && m.text?.includes("Профиль"));
  
  if (!profile) throw new Error("Profile not found");

  await profile.click({ text: "🎁 Ежедневка" });
  await sleep(delay());
  await solveCaptcha(client);

  await updateAccount(userId, {
    next_daily_time: new Date(Date.now() + DAILY * 60000).toISOString(),
    error_count: 0,
    last_error: null,
  });

  console.log("[DAILY] ✅ Success");
  return true;
}

// ============================================
// PROCESS
// ============================================
async function processAccount(acc) {
  console.log(`\n━━━ Account ${acc.user_id} ━━━`);
  
  let client;
  try {
    client = new TelegramClient(new StringSession(acc.session_string), API_ID, API_HASH, {
      connectionRetries: 5,
      receiveUpdates: false,
    });

    await client.connect();
    console.log("✅ Connected");

    const now = new Date();
    const clickerDue = new Date(acc.next_clicker_time) <= now;
    const dailyDue = new Date(acc.next_daily_time) <= now;

    if (clickerDue) {
      await updateAccount(acc.user_id, {
        next_clicker_time: new Date(Date.now() + (CLICKER_MIN + Math.random() * CLICKER_MAX) * 60000).toISOString()
      });
      await doClicker(client, acc.user_id);
    }

    if (dailyDue) {
      await updateAccount(acc.user_id, {
        next_daily_time: new Date(Date.now() + DAILY * 60000).toISOString()
      });
      await doDaily(client, acc.user_id);
    }

    if (!clickerDue && !dailyDue) {
      console.log("⏭️ Nothing due");
    }
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    await incrementError(acc.user_id, error.message);
    
    // Send notification to admin
    if (client) {
      await sendErrorNotification(client, acc.user_id, error.message, acc.phone);
    }
  } finally {
    if (client) {
      await sleep(500);
      await client.destroy();
      console.log("🔌 Disconnected");
    }
  }
}

// ============================================
// TRIGGER
// ============================================
async function runTrigger() {
  console.log(`\n${"=".repeat(40)}`);
  console.log(`🚀 Instance ${INSTANCE_ID} - ${new Date().toLocaleString()}`);
  console.log("=".repeat(40));

  const accounts = await getAccountsDue();
  console.log(`📋 ${accounts.length} account(s) due`);

  for (const acc of accounts) {
    await processAccount(acc);
    await sleep(1000 + Math.random() * 2000);
  }

  console.log("\n✅ Done\n");
}

// ============================================
// SERVER
// ============================================
const app = express();

app.get("/", (req, res) => res.send(`Instance ${INSTANCE_ID} ✅`));
app.get("/trigger", (req, res) => {
  res.send("Triggered");
  runTrigger().catch(console.error);
});

app.listen(PORT, () => {
  console.log(`\n🌐 Server on port ${PORT} | Instance ${INSTANCE_ID}\n`);
});
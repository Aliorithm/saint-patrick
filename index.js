require("dotenv").config();
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { createClient } = require("@supabase/supabase-js");
const express = require("express");

// ============================================
// CONFIGURATION
// ============================================
const INSTANCE_ID = parseInt(process.env.INSTANCE_ID);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);
const BOT_USERNAME = "patrickstarsrobot";
const API_ID = parseInt(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const PORT = process.env.PORT || 10000;

// Delays (in ms)
const DELAY = {
  BETWEEN_CLICKS: () => 2000 + Math.random() * 3000, // 2-5s
  CAPTCHA_SOLVE: () => 3000 + Math.random() * 3000, // 3-6s
  AFTER_START: 4000, // Wait for sticker to disappear
  BETWEEN_ACCOUNTS: () => 1000 + Math.random() * 2000, // 1-3s
  AFTER_BUTTON_CLICK: 2000, // Wait after clicking button
  AFTER_TASK_CLICK: () => 2000 + Math.random() * 1000, // 2-3s
  AFTER_SUBSCRIBE: () => 3000 + Math.random() * 2000, // 3-5s
  AFTER_JOIN: () => 2000 + Math.random() * 1000, // 2-3s
  BEFORE_VERIFY: () => 2000 + Math.random() * 1000, // 2-3s
  AFTER_LEAVE: () => 1000 + Math.random() * 1000, // 1-2s
};

// Next clicker time: 6-10 minutes from now
const getNextClickerTime = () => {
  const mins = 6 + Math.floor(Math.random() * 5); // 6-10 mins
  return new Date(Date.now() + mins * 60000);
};

// Next daily time: 24 hours from now
const getNextDailyTime = () => {
  return new Date(Date.now() + 24 * 60 * 60000);
};

// Next clicker time: 1 hour from now (when task unavailable)
const getNextClickerTimeDelayed = () => {
  return new Date(Date.now() + 60 * 60000);
};

// ============================================
// HELPER FUNCTIONS
// ============================================
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchAccountsDue() {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("accounts")
    .select("*")
    .eq("instance_id", INSTANCE_ID)
    .eq("is_active", true)
    .or(`next_clicker_time.lte.${now},next_daily_time.lte.${now}`);

  if (error) {
    console.error("[SUPABASE ERROR]", error);
    return [];
  }
  return data || [];
}

async function updateAccount(userId, updates) {
  const { error } = await supabase
    .from("accounts")
    .update(updates)
    .eq("user_id", userId)
    .eq("instance_id", INSTANCE_ID);

  if (error) {
    console.error(`[SUPABASE ERROR] Failed to update user ${userId}:`, error);
  }
}

async function markAccountInactive(userId, errorMsg) {
  const { data } = await supabase
    .from("accounts")
    .select("error_count")
    .eq("user_id", userId)
    .single();

  const newCount = (data?.error_count || 0) + 1;

  await updateAccount(userId, {
    is_active: false,
    last_error: errorMsg,
    error_count: newCount,
  });
  console.log(`❌ Account ${userId} marked as INACTIVE: ${errorMsg}`);
}

async function incrementErrorCount(userId, errorMsg) {
  const { data } = await supabase
    .from("accounts")
    .select("error_count")
    .eq("user_id", userId)
    .single();

  const newErrorCount = (data?.error_count || 0) + 1;

  if (newErrorCount >= 3) {
    await markAccountInactive(userId, errorMsg);
  } else {
    await updateAccount(userId, {
      last_error: errorMsg,
      error_count: newErrorCount,
    });
    console.log(`⚠️ Account ${userId} error count: ${newErrorCount}/3`);
  }
}

// ============================================
// TELEGRAM CLIENT LOGIC
// ============================================
async function findMainMenu(client) {
  const messages = await client.getMessages(BOT_USERNAME, { limit: 5 });

  // Look for the main menu message
  const mainMenu = messages.find(
    (m) =>
      m.text?.includes("Получи свою личную ссылку") &&
      m.text?.includes("Заработать звезды") &&
      m.replyMarkup
  );

  return mainMenu;
}

async function ensureMainMenu(client) {
  let menu = await findMainMenu(client);

  if (!menu) {
    console.log("[MENU] Main menu not found. Sending /start...");
    await client.sendMessage(BOT_USERNAME, { message: "/start" });
    await sleep(DELAY.AFTER_START);
    menu = await findMainMenu(client);
  }

  return menu;
}

async function handleCaptcha(client, captchaMsg) {
  const text = captchaMsg.text || "";
  console.log("[CAPTCHA] Detected:", text.substring(0, 50));

  // Extract math expression: "82 + 1 = ?"
  const match = text.match(/(\d+)\s*([\+\-\*\/])\s*(\d+)/);
  if (!match) {
    console.log("[CAPTCHA] Failed to parse math expression");
    return false;
  }

  const num1 = parseInt(match[1]);
  const operator = match[2];
  const num2 = parseInt(match[3]);

  let answer;
  switch (operator) {
    case "+":
      answer = num1 + num2;
      break;
    case "-":
      answer = num1 - num2;
      break;
    case "*":
      answer = num1 * num2;
      break;
    case "/":
      answer = Math.floor(num1 / num2);
      break;
    default:
      console.log("[CAPTCHA] Unknown operator:", operator);
      return false;
  }

  console.log(`[CAPTCHA] Solving: ${num1} ${operator} ${num2} = ${answer}`);

  if (!captchaMsg.replyMarkup || !captchaMsg.replyMarkup.rows) {
    console.log("[CAPTCHA] No inline buttons found");
    return false;
  }

  await sleep(DELAY.CAPTCHA_SOLVE());

  // Search through all buttons to find the answer
  for (const row of captchaMsg.replyMarkup.rows) {
    for (const button of row.buttons) {
      if (button.text === answer.toString()) {
        console.log(`[CAPTCHA] Clicking button: ${button.text}`);
        await captchaMsg.click({ data: button.data });
        return true;
      }
    }
  }

  console.log("[CAPTCHA] Answer button not found");
  return false;
}

// ============================================
// TASK HANDLER
// ============================================
async function handleTask(client, userId) {
  console.log("[TASK] Starting task handler...");

  const menu = await ensureMainMenu(client);
  if (!menu) {
    throw new Error("Failed to find main menu for tasks");
  }

  await sleep(DELAY.AFTER_TASK_CLICK());

  // Click "📝 Задания"
  console.log("[TASK] Clicking 📝 Задания...");
  await menu.click({ text: "📝 Задания" });

  await sleep(DELAY.AFTER_BUTTON_CLICK);

  let taskCompleted = false;
  let channelToLeave = null;

  // Try up to 5 tasks (in case we need to skip web apps)
  for (let attempt = 0; attempt < 5; attempt++) {
    // Get the task message
    const messages = await client.getMessages(BOT_USERNAME, { limit: 3 });
    const taskMsg = messages.find(
      (m) =>
        m.text?.includes("Новое задание") &&
        m.replyMarkup &&
        m.replyMarkup.rows
    );

    if (!taskMsg) {
      console.log("[TASK] No task message found");
      break;
    }

    console.log(`[TASK] Task ${attempt + 1} received`);

    // Find "🔗 Подписаться" button (URL button)
    let subscribeButton = null;
    let skipButton = null;
    let verifyButton = null;

    for (const row of taskMsg.replyMarkup.rows) {
      for (const button of row.buttons) {
        if (button.text === "🔗 Подписаться" && button.url) {
          subscribeButton = button;
        }
        if (button.text?.includes("Пропустить")) {
          skipButton = button;
        }
        if (button.text?.includes("Подтвердить подписку")) {
          verifyButton = button;
        }
      }
    }

    if (!subscribeButton || !subscribeButton.url) {
      console.log("[TASK] No subscribe button found");
      break;
    }

    const url = subscribeButton.url;
    console.log(`[TASK] URL: ${url.substring(0, 50)}...`);

    // Check URL type
    if (url.includes("startapp")) {
      // Web app - skip it
      console.log("[TASK] Web app detected, skipping...");
      if (skipButton) {
        await sleep(DELAY.AFTER_SUBSCRIBE());
        await taskMsg.click({ data: skipButton.data });
        await sleep(DELAY.AFTER_BUTTON_CLICK);
        continue; // Next task will load
      } else {
        console.log("[TASK] Skip button not found");
        break;
      }
    }

    // Extract username/channel from URL
    let channelUsername = null;
    let botUsername = null;
    let startParam = null;

    // Type 1: Bot link - https://t.me/botusername?start=123
    if (url.includes("?start=")) {
      const match = url.match(/t\.me\/([^?]+)\?start=(.+)/);
      if (match) {
        botUsername = match[1];
        startParam = match[2];
        console.log(`[TASK] Bot link: @${botUsername} with start=${startParam}`);
      }
    }
    // Type 2: Channel/Group - https://t.me/+invite or https://t.me/username
    else if (url.includes("t.me/")) {
      const match = url.match(/t\.me\/(.+)/);
      if (match) {
        channelUsername = match[1];
        console.log(`[TASK] Channel link: ${channelUsername}`);
      }
    }

    try {
      // Handle bot link
      if (botUsername && startParam) {
        console.log(`[TASK] Starting bot @${botUsername}...`);
        await sleep(DELAY.AFTER_SUBSCRIBE());
        await client.sendMessage(botUsername, { message: `/start ${startParam}` });
        await sleep(DELAY.AFTER_JOIN());
      }
      // Handle channel/group link
      else if (channelUsername) {
        console.log(`[TASK] Joining channel ${channelUsername}...`);
        await sleep(DELAY.AFTER_SUBSCRIBE());

        try {
          await client.invoke(
            new Api.channels.JoinChannel({
              channel: channelUsername,
            })
          );
          console.log("[TASK] Successfully joined channel");
          channelToLeave = channelUsername; // Save to leave later
        } catch (joinError) {
          console.log(`[TASK] Failed to join: ${joinError.message}`);
          // If join failed, skip this task
          if (skipButton) {
            await sleep(DELAY.AFTER_SUBSCRIBE());
            await taskMsg.click({ data: skipButton.data });
            await sleep(DELAY.AFTER_BUTTON_CLICK);
            continue;
          } else {
            break;
          }
        }

        await sleep(DELAY.AFTER_JOIN());
      }

      // Click "✅ Подтвердить подписку"
      if (verifyButton) {
        console.log("[TASK] Clicking ✅ Подтвердить подписку...");
        await sleep(DELAY.BEFORE_VERIFY());
        await taskMsg.click({ data: verifyButton.data });
        await sleep(DELAY.AFTER_BUTTON_CLICK);

        // Check for success message
        const successMessages = await client.getMessages(BOT_USERNAME, {
          limit: 2,
        });
        const successMsg = successMessages.find((m) =>
          m.text?.includes("Задание выполнено")
        );

        if (successMsg) {
          console.log("[TASK] ✅ Task completed successfully!");
          taskCompleted = true;
          break; // Exit loop, task done
        } else {
          console.log("[TASK] No success confirmation found");
        }
      }
    } catch (error) {
      console.log(`[TASK] Error during task: ${error.message}`);
      // Try to skip if possible
      if (skipButton) {
        await sleep(DELAY.AFTER_SUBSCRIBE());
        await taskMsg.click({ data: skipButton.data });
        await sleep(DELAY.AFTER_BUTTON_CLICK);
        continue;
      } else {
        break;
      }
    }
  }

  // Leave channel if we joined one
  if (channelToLeave && taskCompleted) {
    console.log(`[TASK] Leaving channel ${channelToLeave}...`);
    try {
      await sleep(DELAY.AFTER_LEAVE());
      await client.invoke(
        new Api.channels.LeaveChannel({
          channel: channelToLeave,
        })
      );
      console.log("[TASK] Successfully left channel");
    } catch (leaveError) {
      console.log(`[TASK] Failed to leave channel: ${leaveError.message}`);
      // Not critical, continue
    }
  }

  return taskCompleted;
}

// ============================================
// CLICKER FUNCTION
// ============================================
async function performClicker(client, userId) {
  console.log(`[CLICKER] Starting for user ${userId}...`);

  const menu = await ensureMainMenu(client);
  if (!menu) {
    throw new Error("Failed to find main menu");
  }

  await sleep(DELAY.BETWEEN_CLICKS());

  // Click "✨ Кликер"
  console.log("[CLICKER] Clicking ✨ Кликер button...");
  await menu.click({ text: "✨ Кликер" });

  await sleep(DELAY.AFTER_BUTTON_CLICK);

  // Check for captcha or error
  const recentMessages = await client.getMessages(BOT_USERNAME, { limit: 3 });

  // Check for task error: "Чтобы кликать дальше — выполни хотя бы 1 задание!"
  const taskError = recentMessages.find((m) =>
    m.text?.includes("Чтобы кликать дальше")
  );

  if (taskError) {
    console.log("[CLICKER] Task required! Handling task...");
    const taskCompleted = await handleTask(client, userId);

    if (taskCompleted) {
      // Task done, now click again
      console.log("[CLICKER] Task completed, clicking again...");
      await sleep(DELAY.BETWEEN_CLICKS());

      // Go back to main menu and click
      await client.sendMessage(BOT_USERNAME, { message: "/start" });
      await sleep(DELAY.AFTER_START);

      const menu2 = await ensureMainMenu(client);
      if (menu2) {
        await menu2.click({ text: "✨ Кликер" });
        await sleep(DELAY.AFTER_BUTTON_CLICK);
      }
    } else {
      // Failed to complete task, delay next click
      console.log(
        "[CLICKER] Failed to complete task, delaying next click by 1 hour"
      );
      await updateAccount(userId, {
        next_clicker_time: getNextClickerTimeDelayed().toISOString(),
        last_error: "Failed to complete required task",
      });
      return;
    }
  }

  // Check for captcha after click
  const messagesAfterClick = await client.getMessages(BOT_USERNAME, {
    limit: 3,
  });
  const captchaMsg = messagesAfterClick.find((m) =>
    m.text?.includes("ПРОВЕРКА НА РОБОТА")
  );

  if (captchaMsg) {
    const solved = await handleCaptcha(client, captchaMsg);
    if (!solved) {
      throw new Error("Failed to solve captcha");
    }
  }

  // Get current counts
  const { data } = await supabase
    .from("accounts")
    .select("total_clicks")
    .eq("user_id", userId)
    .single();

  // Update next clicker time and increment counter
  await updateAccount(userId, {
    next_clicker_time: getNextClickerTime().toISOString(),
    total_clicks: (data?.total_clicks || 0) + 1,
    last_click_at: new Date().toISOString(),
    error_count: 0,
    last_error: null,
  });

  console.log(`✅ [CLICKER] Success for user ${userId}`);
}

// ============================================
// DAILY FUNCTION
// ============================================
async function performDaily(client, userId) {
  console.log(`[DAILY] Starting for user ${userId}...`);

  const menu = await ensureMainMenu(client);
  if (!menu) {
    throw new Error("Failed to find main menu");
  }

  await sleep(DELAY.BETWEEN_CLICKS());

  // Click "👤 Профиль"
  console.log("[DAILY] Clicking 👤 Профиль...");
  await menu.click({ text: "👤 Профиль" });

  await sleep(DELAY.AFTER_BUTTON_CLICK);

  // Get the profile menu and click "🎁 Ежедневка"
  const messages = await client.getMessages(BOT_USERNAME, { limit: 3 });
  const profileMenu = messages.find(
    (m) => m.replyMarkup && m.text?.includes("Профиль")
  );

  if (!profileMenu) {
    throw new Error("Profile menu not found");
  }

  console.log("[DAILY] Clicking 🎁 Ежедневка...");
  await profileMenu.click({ text: "🎁 Ежедневка" });

  await sleep(DELAY.AFTER_BUTTON_CLICK);

  // Get current counts
  const { data } = await supabase
    .from("accounts")
    .select("total_dailies")
    .eq("user_id", userId)
    .single();

  // Update next daily time and increment counter
  await updateAccount(userId, {
    next_daily_time: getNextDailyTime().toISOString(),
    total_dailies: (data?.total_dailies || 0) + 1,
    last_daily_at: new Date().toISOString(),
    error_count: 0,
    last_error: null,
  });

  console.log(`✅ [DAILY] Success for user ${userId}`);
}

// ============================================
// ACCOUNT PROCESSOR
// ============================================
async function processAccount(account) {
  const { user_id, session_string, next_clicker_time, next_daily_time } =
    account;

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🔄 Processing account: ${user_id}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  let client;

  try {
    // Initialize client with session string
    const stringSession = new StringSession(session_string);
    client = new TelegramClient(stringSession, API_ID, API_HASH, {
      connectionRetries: 5,
      receiveUpdates: false, // Disable update loop to prevent TIMEOUT errors
    });

    await client.connect();
    console.log(`✅ Connected to account ${user_id}`);

    const now = new Date();
    const clickerDue = new Date(next_clicker_time) <= now;
    const dailyDue = new Date(next_daily_time) <= now;

    // Perform clicker if due
    if (clickerDue) {
      await performClicker(client, user_id);
    }

    // Perform daily if due
    if (dailyDue) {
      await performDaily(client, user_id);
    }

    if (!clickerDue && !dailyDue) {
      console.log(`⏭️ No tasks due for user ${user_id}`);
    }
  } catch (error) {
    console.error(`❌ Error processing account ${user_id}:`, error.message);
    await incrementErrorCount(user_id, error.message);
  } finally {
    // Always destroy client to properly stop it (not just disconnect)
    if (client) {
      await client.destroy();
      console.log(`🔌 Disconnected from account ${user_id}`);
    }
  }
}

// ============================================
// MAIN TRIGGER FUNCTION
// ============================================
async function runTrigger() {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`🚀 TRIGGER STARTED - Instance ${INSTANCE_ID}`);
  console.log(`⏰ ${new Date().toLocaleString()}`);
  console.log(`${"=".repeat(50)}\n`);

  try {
    const accounts = await fetchAccountsDue();

    if (accounts.length === 0) {
      console.log("✨ No accounts due for processing at this time.");
      return;
    }

    console.log(`📋 Found ${accounts.length} account(s) due for processing.\n`);

    // Process accounts one by one (sequential, not parallel)
    for (const account of accounts) {
      await processAccount(account);
      await sleep(DELAY.BETWEEN_ACCOUNTS());
    }

    console.log(`\n${"=".repeat(50)}`);
    console.log(`✅ TRIGGER COMPLETED`);
    console.log(`${"=".repeat(50)}\n`);
  } catch (error) {
    console.error("❌ TRIGGER ERROR:", error);
  }
}

// ============================================
// WEB SERVER FOR UPTIMEROBOT
// ============================================
const app = express();

app.get("/", (req, res) => {
  res.send(`Instance ${INSTANCE_ID} is alive ✅`);
});

app.get("/trigger", async (req, res) => {
  res.send("Trigger received. Processing accounts...");
  runTrigger().catch(console.error);
});

app.listen(PORT, () => {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`🌐 Health check server running on port ${PORT}`);
  console.log(`📡 Instance ID: ${INSTANCE_ID}`);
  console.log(`${"=".repeat(50)}\n`);
});

// Optional: Run trigger on startup (for testing)
// Uncomment to test locally:
// runTrigger();
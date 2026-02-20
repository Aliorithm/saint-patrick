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
const ADMIN = "Aliorythm";
const API_ID = parseInt(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const PORT = process.env.PORT || 10000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const delay = () => 4000 + Math.random() * 2000;

// TIME DELAYS (in minutes)
const CLICKER_MIN = 8;
const CLICKER_MAX = 10;
const CAP_LIMIT = 25;
const CAP_DELAY = () => 120 + Math.floor(Math.random() * 181); // 2h to 5h random
const DAILY = (24 * 60) + Math.floor(Math.random() * 120); // 24h to 26h random
const DAILY_LIMIT_DELAY = 10 * 60;
const SPONSOR_DELAY = 10 * 60;
const CHANNEL_LIMIT_DELAY = 10 * 60;
const NO_TASKS_DELAY = 30;
const LEAVE_DELAY_MIN = 24 * 60;  // 24h in minutes
const LEAVE_DELAY_MAX = 48 * 60;  // 48h in minutes

// ============================================
// SUPABASE
// ============================================
async function getAccountsDue() {
  const now = new Date().toISOString();
  
  // Use atomic claiming function to prevent race conditions
  const { data, error } = await supabase.rpc('claim_due_accounts', {
    p_instance_id: INSTANCE_ID,
    p_now: now,
    p_clicker_delay_min: CLICKER_MIN,
    p_clicker_delay_max: CLICKER_MAX,
    p_daily_delay: DAILY
  });
  
  if (error) {
    console.log(`[ERROR] claim_due_accounts failed: ${error.message}`);
    console.log('[FALLBACK] Using simple query (race conditions possible)');
    // Fallback to simple query if function doesn't exist
    const { data: fallbackData } = await supabase
      .from("accounts")
      .select("*")
      .eq("instance_id", INSTANCE_ID)
      .eq("is_active", true)
      .or(`next_clicker_time.lte.${now},next_daily_time.lte.${now}`);
    return fallbackData || [];
  }
  
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

async function sendAdminNotification(client, title, details) {
  try {
    const message = `${title}\n\n${details}\n\nTime: ${new Date().toLocaleString()}`;
    await client.sendMessage(ADMIN, { message });
    console.log(`📨 Notification sent to @${ADMIN}`);
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
  } catch (e) {
    if (e.message?.includes("MESSAGE_ID_INVALID")) {
      return "MESSAGE_EXPIRED";
    }
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

async function ensureMenu(client) {
  let msgs = await client.getMessages(BOT, { limit: 5 });
  let menu = msgs.find(m => m.text?.includes("Получи свою личную ссылку") && m.replyMarkup);

  if (!menu) {
    await withCaptcha(client, async () => {
      await client.sendMessage(BOT, { message: "/start" });
      await sleep(4000);
    });
    msgs = await client.getMessages(BOT, { limit: 5 });
    menu = msgs.find(m => m.text?.includes("Получи свою личную ссылку") && m.replyMarkup);
  }

  // Check for any blocking sponsor-like screen:
  //   1. Bot activation screen ("Чтобы активировать бота:")
  //   2. Mid-farm task screen ("Для продолжения фарма звёзд") — may have 1+ buttons
  const sponsorMsg = msgs.find(m =>
    (m.text?.includes("Чтобы активировать бота:") ||
     m.text?.includes("Для продолжения фарма звёзд")) &&
    m.replyMarkup
  );

  if (sponsorMsg) {
    const preview = sponsorMsg.text.substring(0, 50).trim().replace(/\n/g, " ");
    console.log(`[SPONSOR] Blocking screen: "${preview}..." — resolving...`);
    const resolved = await handleSponsor(client, sponsorMsg);
    if (!resolved) throw new Error("SPONSOR_UNRESOLVABLE");
    // Re-fetch menu after sponsors cleared
    await sleep(5000);
    msgs = await client.getMessages(BOT, { limit: 5 });
    menu = msgs.find(m => m.text?.includes("Получи свою личную ссылку") && m.replyMarkup);
    if (!menu) {
      await withCaptcha(client, async () => {
        await client.sendMessage(BOT, { message: "/start" });
        await sleep(4000);
      });
      msgs = await client.getMessages(BOT, { limit: 5 });
      menu = msgs.find(m => m.text?.includes("Получи свою личную ссылку") && m.replyMarkup);
    }
  }

  return menu;
}

// ============================================
// CAPTCHA
// ============================================
async function solveCaptcha(client) {
  const msgs = await client.getMessages(BOT, { limit: 3 });
  const captcha = msgs.find(m => m.text?.includes("ПРОВЕРКА НА РОБОТА"));
  if (!captcha) return false; // No captcha present

  console.log("[CAPTCHA] Detected!");

  // Math captcha
  const mathMatch = captcha.text.match(/(\d+)\s*([\+\-\*\/])\s*(\d+)/);
  if (mathMatch) {
    const [, a, op, b] = mathMatch;
    const answer = eval(`${a}${op}${b}`);
    console.log(`[CAPTCHA] Math: ${a} ${op} ${b} = ${answer}`);
    await sleep(3000 + Math.random() * 3000);

    for (const row of captcha.replyMarkup.rows) {
      for (const btn of row.buttons) {
        if (btn.text === answer.toString()) {
          await captcha.click({ data: btn.data });
          console.log("[CAPTCHA] Solved ✅");
          await sleep(2000);
          return true;
        }
      }
    }
    return false;
  }

  // Fruit emoji captcha
  const fruitMap = {
    "Киви": "🥝", "киви": "🥝",
    "Банан": "🍌", "банан": "🍌",
    "Арбуз": "🍉", "арбуз": "🍉",
    "Апельсин": "🍊", "апельсин": "🍊",
    "Клубника": "🍓", "клубника": "🍓",
    "Виноград": "🍇", "виноград": "🍇",
    "Яблоко": "🍎", "яблоко": "🍎",
    "Вишня": "🍒", "вишня": "🍒",
    "Кокос": "🥥", "кокос": "🥥",
    "Помидор": "🍅", "помидор": "🍅",
  };

  for (const [name, emoji] of Object.entries(fruitMap)) {
    if (captcha.text.includes(name)) {
      console.log(`[CAPTCHA] Fruit: ${name} = ${emoji}`);
      await sleep(3000 + Math.random() * 3000);
      
      for (const row of captcha.replyMarkup.rows) {
        for (const btn of row.buttons) {
          if (btn.text === emoji) {
            await captcha.click({ data: btn.data });
            console.log("[CAPTCHA] Solved ✅");
            await sleep(2000);
            return true;
          }
        }
      }
    }
  }

  return false;
}

async function withCaptcha(client, action) {
  await action();
  await sleep(1500);
  await solveCaptcha(client);
}

function resolveUrl(url) {
  try {
    const parsed = new URL(url);
    const redirectParam = parsed.searchParams.get("redirect_url")
      || parsed.searchParams.get("redirectUrl")
      || parsed.searchParams.get("redirect")
      || parsed.searchParams.get("url")
      || parsed.searchParams.get("link");
    if (redirectParam) {
      const decoded = decodeURIComponent(redirectParam);
      console.log(`[URL] Resolved redirect: ${url.substring(0, 60)}... → ${decoded}`);
      return decoded;
    }
  } catch (e) {
    // Not a valid URL — return as-is
  }
  return url;
}

// ============================================
// SPONSOR HANDLER
// ============================================
async function handleSponsor(client, sponsorMsg) {
  console.log("[SPONSOR] Processing sponsor requirements...");
  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`[SPONSOR] Attempt ${attempt}/${MAX_RETRIES}`);

    // Always re-fetch fresh — buttons may change between attempts
    const msgs = await client.getMessages(BOT, { limit: 5 });
    const freshMsg = msgs.find(m =>
      (m.text?.includes("Чтобы активировать бота:") ||
       m.text?.includes("Для продолжения фарма звёзд")) &&
      m.replyMarkup
    ) || sponsorMsg;

    if (!freshMsg?.replyMarkup?.rows) {
      console.log("[SPONSOR] No buttons found");
      return false;
    }

    // Separate action buttons from verify button
    const actionButtons = [];
    let verifyBtn = null;

    for (const row of freshMsg.replyMarkup.rows) {
      for (const btn of row.buttons) {
        const text = btn.text || "";
        if (text.includes("Я выполнил") || text.includes("Проверить")) {
          verifyBtn = btn;
        } else if (btn.url) {
          actionButtons.push(btn);
        }
      }
    }

    console.log(`[SPONSOR] ${actionButtons.length} action button(s), verify: ${!!verifyBtn}`);

    // Process each button one by one with human-like delays
    for (const btn of actionButtons) {
      const rawUrl = btn.url || "";
      const url    = resolveUrl(rawUrl);  // unwrap tracker/redirect if present
      const text   = btn.text || "";
      console.log(`[SPONSOR] Processing: "${text}" -> ${url}`);

      await sleep(2000 + Math.random() * 2000);

      try {
        // t.me/botname?start=PARAM → bot start
        // t.me/channel or t.me/+hash → channel/group join
        const botMatch     = url.match(/t\.me\/([^?/]+)\?start=(.+)/);
        const channelMatch = !botMatch && url.match(/t\.me\/(.+)/);

        if (botMatch) {
          const botName    = botMatch[1];
          const startParam = botMatch[2];
          console.log(`[SPONSOR] Starting bot @${botName}`);
          await withCaptcha(client, async () => {
            await client.sendMessage(botName, { message: `/start ${startParam}` });
          });
          await sleep(3000 + Math.random() * 2000);
          console.log("[SPONSOR] Bot started ✅");

        } else if (channelMatch) {
          const identifier = channelMatch[1].split("?")[0];
          console.log(`[SPONSOR] Joining: ${identifier}`);
          await withCaptcha(client, async () => {
            try {
              if (identifier.startsWith("+")) {
                await client.invoke(new Api.messages.ImportChatInvite({ hash: identifier.substring(1) }));
              } else {
                await client.invoke(new Api.channels.JoinChannel({ channel: identifier }));
              }
              console.log("[SPONSOR] Joined ✅");
            } catch (e) {
              const eu = (e.message || "").toUpperCase();
              if (eu.includes("CHANNELS_TOO_MUCH") || eu.includes("TOO MANY CHANNELS")) {
                console.log("[SPONSOR] CHANNELS_TOO_MUCH — skipping this button");
                await sendAdminNotification(client,
                  "🚨 Sponsor: Channel Limit Hit",
                  `Instance: ${INSTANCE_ID}\nCould not join sponsor channel (500 limit reached).\nURL: ${url}`
                );
              } else if (e.message?.includes("USER_ALREADY_PARTICIPANT") || e.message?.includes("INVITE_REQUEST_SENT")) {
                console.log("[SPONSOR] Already a member — OK");
              } else {
                console.log(`[SPONSOR] Join failed (skipping): ${e.message}`);
              }
            }
          });

        } else if (url.includes("startapp")) {
          // Webapp sponsor button
          if (url.includes("patrickgamesbot")) {
            // Patrick games webapp — join the news channel first
            console.log("[SPONSOR] Patrick webapp — joining patrickgames_news");
            await withCaptcha(client, async () => {
              try {
                await client.invoke(new Api.channels.JoinChannel({ channel: "patrickgames_news" }));
                console.log("[SPONSOR] Joined patrickgames_news ✅");
              } catch (e) {
                const eu = (e.message || "").toUpperCase();
                if (eu.includes("CHANNELS_TOO_MUCH") || eu.includes("TOO MANY CHANNELS")) {
                  console.log("[SPONSOR] CHANNELS_TOO_MUCH on patrickgames_news — skipping");
                  await sendAdminNotification(client,
                    "🚨 Sponsor: Channel Limit Hit",
                    `Instance: ${INSTANCE_ID}\nCould not join patrickgames_news (500 limit reached).`
                  );
                } else if (e.message?.includes("USER_ALREADY_PARTICIPANT")) {
                  console.log("[SPONSOR] Already in patrickgames_news");
                } else {
                  console.log(`[SPONSOR] Join patrickgames_news failed (skipping): ${e.message}`);
                }
              }
            });
          } else {
            // Other webapp — extract bot name and /start it
            const webappBotMatch = url.match(/t\.me\/([^/?]+)/);
            const webappBot = webappBotMatch ? webappBotMatch[1] : null;
            if (webappBot) {
              console.log(`[SPONSOR] Webapp — starting bot @${webappBot}`);
              try {
                await withCaptcha(client, async () => {
                  await client.sendMessage(webappBot, { message: "/start" });
                });
                await sleep(3000 + Math.random() * 2000);
                console.log(`[SPONSOR] Bot @${webappBot} started ✅`);
              } catch (e) {
                console.log(`[SPONSOR] Failed to start @${webappBot}: ${e.message}`);
              }
            } else {
              console.log(`[SPONSOR] Could not extract bot from webapp URL: ${url}`);
            }
          }
        } else {
          // Unknown URL — simulate visiting it (sleep like webapp open)
          console.log(`[SPONSOR] Unknown URL — simulating visit (4-7s): ${url}`);
          await sleep(4000 + Math.random() * 3000);
          console.log(`[SPONSOR] Visit simulated ✅`);
        }

      } catch (e) {
        console.log(`[SPONSOR] Button error (skipping): ${e.message}`);
      }

      await sleep(1500 + Math.random() * 1500);
    }

    // Click verify
    if (!verifyBtn) {
      console.log("[SPONSOR] No verify button found — cannot complete");
      return false;
    }

    console.log("[SPONSOR] Clicking verify...");
    await sleep(2000 + Math.random() * 1000);

    let verifyPopup = null;
    try {
      verifyPopup = await getCallbackAnswer(client, freshMsg, verifyBtn.data);
    } catch (e) {
      console.log(`[SPONSOR] Verify click error: ${e.message}`);
    }

    console.log(`[SPONSOR] Verify response: ${verifyPopup || "none"}`);

    // "Подпишись на все каналы" = not all done
    if (verifyPopup?.includes("Подпишись на все каналы")) {
      console.log(`[SPONSOR] Not all completed (attempt ${attempt}) — trying RequestAppWebView for webapp buttons`);
      // On verify failure, invoke RequestAppWebView for each webapp button as fallback
      for (const btn of actionButtons) {
        const burl = resolveUrl(btn.url || "");
        if (!burl.includes("startapp") || burl.includes("patrickgamesbot")) continue;
        const webappBotMatch = burl.match(/t\.me\/([^/?]+)/);
        const webappBot = webappBotMatch ? webappBotMatch[1] : null;
        if (!webappBot) continue;
        try {
          console.log(`[SPONSOR] RequestAppWebView for @${webappBot}...`);
          const peer = await client.getEntity(webappBot);
          await client.invoke(new Api.messages.RequestAppWebView({
            peer: peer,
            app: new Api.InputBotAppShortName({ botId: peer, shortName: "app" }),
            platform: "android",
            startParam: "",
            writeAllowed: true,
          }));
          console.log(`[SPONSOR] RequestAppWebView done for @${webappBot}`);
        } catch (e) {
          console.log(`[SPONSOR] RequestAppWebView failed for @${webappBot}: ${e.message}`);
        }
        await sleep(2000);
      }
      await sleep(3000);
      continue;
    }

    // Success
    console.log("[SPONSOR] ✅ Verified — waiting for main menu...");
    await sleep(5000 + Math.random() * 3000);
    return true;
  }

  console.log(`[SPONSOR] ❌ Failed after ${MAX_RETRIES} attempts`);
  return false;
}

// ============================================
// LEAVE CHANNELS
// ============================================
async function leaveChannels(client, userId) {
  console.log("[LEAVE] Starting broadcast channel cleanup...");

  let dialogs;
  try {
    dialogs = await client.getDialogs({ limit: 500 });
  } catch (e) {
    console.log(`[LEAVE] Failed to get dialogs: ${e.message}`);
    return 0;
  }

  // Only broadcast channels (not supergroups, not regular groups)
  const channels = dialogs.filter(d => {
    const e = d.entity;
    return e?.className === "Channel" && e?.broadcast === true && e?.megagroup !== true;
  });

  console.log(`[LEAVE] Found ${channels.length} broadcast channel(s)`);

  let leftCount = 0;
  for (const dialog of channels) {
    try {
      await client.invoke(new Api.channels.LeaveChannel({ channel: dialog.entity }));
      leftCount++;
      console.log(`[LEAVE] Left: ${dialog.entity.title} (${leftCount}/${channels.length})`);
    } catch (e) {
      console.log(`[LEAVE] Failed to leave ${dialog.entity.title}: ${e.message}`);
    }
    await sleep(800 + Math.random() * 700);
  }

  console.log(`[LEAVE] ✅ Done — left ${leftCount}/${channels.length} channels`);

  const nextLeaveMin = LEAVE_DELAY_MIN + Math.floor(Math.random() * (LEAVE_DELAY_MAX - LEAVE_DELAY_MIN));
  await updateAccount(userId, {
    next_leave_time: new Date(Date.now() + nextLeaveMin * 60000).toISOString(),
  });
  console.log(`[LEAVE] Next leave in ${Math.round(nextLeaveMin / 60)}h`);
  return leftCount;
}

// ============================================
// TASKS
// ============================================
async function handleTasks(client, userId) {
  console.log("[TASK] Starting...");
  
  const menu = await ensureMenu(client);
  await withCaptcha(client, async () => {
    await sleep(delay());
    await menu.click({ text: "📝 Задания" });
    await sleep(delay());
  });

  // Check if no tasks available
  let msgs = await client.getMessages(BOT, { limit: 3 });
  if (msgs.find(m => m.text?.includes("выполнил все задания"))) {
    console.log("[TASK] ⏰ No tasks available");
    return "NO_TASKS_AVAILABLE";
  }

  let completed = 0;

  for (let i = 0; i < 5; i++) {
    console.log(`[TASK] Attempt ${i + 1}/5`);
    
    // ALWAYS get fresh messages
    msgs = await client.getMessages(BOT, { limit: 3 });
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
        }
        if (btn.text?.includes("Подтвердить")) buttons.verify = btn;
        if (btn.text?.includes("Пропустить")) buttons.skip = btn;
      }
    }

    if (!buttons.action?.url) {
      console.log("[TASK] No action button");
      break;
    }

    const url = resolveUrl(buttons.action.url || "");
    console.log(`[TASK] Action: ${buttons.action.text} -> ${url}`);

    // Handle different task types
    let entity = null;
    
    if (url.includes("?start=") && !url.includes("startapp")) {
      // Bot task
      const match = url.match(/t\.me\/([^?]+)\?start=(.+)/);
      if (match) {
        const [, bot, param] = match;
        console.log(`[TASK] Bot: @${bot}`);
        await withCaptcha(client, async () => {
          await sleep(2000);
          await client.sendMessage(bot, { message: `/start ${param}` });
        });
        entity = { type: "bot" };
      }
    } else if (!url.includes("startapp")) {
      // Channel/Group task — or unknown URL fallback
      const match = url.match(/t\.me\/(.+)/);
      if (match) {
        const identifier = match[1];
        console.log(`[TASK] Channel: ${identifier}`);
        
        await withCaptcha(client, async () => {
          await sleep(2000);
          try {
            if (identifier.startsWith("+")) {
              await client.invoke(new Api.messages.ImportChatInvite({ hash: identifier.substring(1) }));
            } else {
              await client.invoke(new Api.channels.JoinChannel({ channel: identifier }));
            }
            console.log("[TASK] Joined");
            entity = { type: "channel" };
          } catch (e) {
            const errorText = (e.message || '').toUpperCase();
            if (errorText.includes("CHANNELS_TOO_MUCH") || errorText.includes("TOO MANY CHANNELS")) {
              throw new Error("CHANNELS_TOO_MUCH");
            }
            if (e.message?.includes("USER_ALREADY_PARTICIPANT") || e.message?.includes("INVITE_REQUEST_SENT")) {
              console.log("[TASK] Already joined");
              entity = { type: "channel" };
            } else {
              console.log(`[TASK] Join failed: ${e.message}`);
            }
          }
        });
      } else {
        // Not a t.me URL — simulate visiting it
        console.log(`[TASK] Unknown URL — simulating visit (4-7s): ${url}`);
        await sleep(4000 + Math.random() * 3000);
        console.log(`[TASK] Visit simulated ✅`);
        entity = { type: "unknown" };
      }
    } else if (url.includes("startapp")) {
      // Webapp task
      if (url.includes("patrickgamesbot")) {
        // Patrick games webapp — join the news channel then verify
        console.log("[TASK] Patrick webapp — joining patrickgames_news");
        await withCaptcha(client, async () => {
          try {
            await client.invoke(new Api.channels.JoinChannel({ channel: "patrickgames_news" }));
            console.log("[TASK] Joined patrickgames_news ✅");
            entity = { type: "channel" };
          } catch (e) {
            const errorText = (e.message || "").toUpperCase();
            if (errorText.includes("CHANNELS_TOO_MUCH") || errorText.includes("TOO MANY CHANNELS")) {
              throw new Error("CHANNELS_TOO_MUCH");
            }
            if (e.message?.includes("USER_ALREADY_PARTICIPANT")) {
              console.log("[TASK] Already in patrickgames_news");
              entity = { type: "channel" };
            } else {
              console.log(`[TASK] Join patrickgames_news failed: ${e.message}`);
            }
          }
        });
      } else {
        // Other webapp — extract bot name and /start it first
        const webappBotMatch = url.match(/t\.me\/([^/?]+)/);
        const webappBot = webappBotMatch ? webappBotMatch[1] : null;
        if (webappBot) {
          console.log(`[TASK] Webapp — starting bot @${webappBot} first`);
          try {
            await withCaptcha(client, async () => {
              await client.sendMessage(webappBot, { message: "/start" });
            });
            await sleep(3000 + Math.random() * 2000);
            console.log(`[TASK] Bot @${webappBot} started ✅`);
            entity = { type: "webapp", bot: webappBot, url };
          } catch (e) {
            console.log(`[TASK] Failed to start @${webappBot}: ${e.message}`);
          }
        } else {
          console.log(`[TASK] Could not extract bot from webapp URL: ${url}`);
        }
      }
    }

    // Verify task
    if (buttons.verify) {
      console.log("[TASK] Clicking verify...");
      await sleep(2000);
      
      const popup = await getCallbackAnswer(client, taskMsg, buttons.verify.data);
      
      if (popup === "MESSAGE_EXPIRED") {
        console.log("[TASK] Message expired, checking result...");
        await sleep(1000);
        msgs = await client.getMessages(BOT, { limit: 3 });
        const successMsg = msgs.find(m => m.text?.includes("выполнено") || m.text?.includes("получена"));
        
        if (successMsg || entity) {
          console.log("[TASK] ✅ Success!");
          completed++;
          break;
        } else {
          console.log("[TASK] ❌ Failed - skipping");
          if (buttons.skip) {
            await withCaptcha(client, async () => {
              await sleep(1500);
              await taskMsg.click({ data: buttons.skip.data });
              await sleep(2000);
            });
          }
          continue;
        }
      }

      console.log(`[TASK] Popup: ${popup || "none"}`);
      
      if (popup?.includes("выполнено") || popup?.includes("получена")) {
        console.log("[TASK] ✅ Success!");
        completed++;
        break;
      }

      if (popup?.includes("не найдена")) {
        // If this was a webapp task, try RequestAppWebView as fallback before giving up
        if (entity?.type === "webapp" && entity.bot) {
          console.log(`[TASK] Webapp verify failed — trying RequestAppWebView for @${entity.bot}`);
          try {
            const peer = await client.getEntity(entity.bot);
            await client.invoke(new Api.messages.RequestAppWebView({
              peer: peer,
              app: new Api.InputBotAppShortName({ botId: peer, shortName: "app" }),
              platform: "android",
              startParam: "",
              writeAllowed: true,
            }));
            console.log(`[TASK] RequestAppWebView done — re-verifying...`);
            await sleep(3000 + Math.random() * 2000);
            const popup2 = await getCallbackAnswer(client, taskMsg, buttons.verify.data);
            console.log(`[TASK] Re-verify popup: ${popup2 || "none"}`);
            if (popup2?.includes("выполнено") || popup2?.includes("получена")) {
              console.log("[TASK] ✅ Success after RequestAppWebView!");
              completed++;
              break;
            }
          } catch (e) {
            console.log(`[TASK] RequestAppWebView failed: ${e.message}`);
          }
        }
        console.log("[TASK] ❌ Failed");
        if (buttons.skip) {
          await withCaptcha(client, async () => {
            await sleep(1500);
            await taskMsg.click({ data: buttons.skip.data });
            await sleep(2000);
          });
        }
        continue;
      }
      
      // If we joined/started but unclear result, assume success
      if (entity) {
        console.log("[TASK] ✅ Joined/started - assuming success");
        completed++;
        break;
      }
    }

    // No verify button or something went wrong - skip
    if (buttons.skip) {
      await withCaptcha(client, async () => {
        await sleep(1500);
        await taskMsg.click({ data: buttons.skip.data });
        await sleep(2000);
      });
    } else {
      break;
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
  
  let popup = null;
  let captchaSolvedDuringClick = false;
  
  await withCaptcha(client, async () => {
    await sleep(delay());
    const clickerBtn = findButton(menu, "Кликер");
    if (!clickerBtn?.data) {
      await menu.click({ text: "✨ Кликер" });
    } else {
      popup = await getCallbackAnswer(client, menu, clickerBtn.data);
      console.log(`[CLICKER] Popup: ${popup || "none"}`);
    }
  });
  
  // Check if captcha was already solved inside withCaptcha
  const afterClickMsgs = await client.getMessages(BOT, { limit: 3 });
  const captchaGone = !afterClickMsgs.find(m => m.text?.includes("ПРОВЕРКА НА РОБОТА"));
  if (popup === null && captchaGone) {
    // If popup was null, it means bot sent captcha instead of popup - captcha was solved
    captchaSolvedDuringClick = true;
  }

  // Check for daily limit
  if (popup?.includes("завтра") || popup?.includes("слишком много")) {
    console.log("[CLICKER] ⚠️ Daily limit reached — resetting cap to 0");
    const delayMinutes = DAILY_LIMIT_DELAY + (CLICKER_MIN + Math.random() * CLICKER_MAX);
    await updateAccount(userId, {
      next_clicker_time: new Date(Date.now() + delayMinutes * 60000).toISOString(),
      last_error: "Daily limit",
      cap: 0,
    });
    return false;
  }
  
  // Check for task required
  if (popup?.includes("выполни хотя бы")) {
    console.log("[CLICKER] Task required!");
    const result = await handleTasks(client, userId);
    
    if (result === "NO_TASKS_AVAILABLE") {
      console.log("[CLICKER] No tasks, delaying 30min");
      await updateAccount(userId, {
        next_clicker_time: new Date(Date.now() + NO_TASKS_DELAY * 60000).toISOString(),
        last_error: "No tasks available",
      });
      return false;
    }
    
    if (result === true) {
      console.log("[CLICKER] Tasks done, clicking again...");
      await withCaptcha(client, async () => {
        await sleep(delay());
        await client.sendMessage(BOT, { message: "/start" });
        await sleep(4000);
      });
      const menu2 = await ensureMenu(client);
      await withCaptcha(client, async () => {
        await sleep(delay());
        const clickerBtn2 = findButton(menu2, "Кликер");
        if (clickerBtn2?.data) {
          popup = await getCallbackAnswer(client, menu2, clickerBtn2.data);
          console.log(`[CLICKER] Popup after tasks: ${popup || "none"}`);
        } else {
          await menu2.click({ text: "✨ Кликер" });
        }
      });
    } else {
      console.log("[CLICKER] Tasks failed");
      return false;
    }
  }
  
  // Check for sponsor subscription requirement — resolve inline
  if (popup?.includes("Подпишись на все каналы")) {
    console.log("[CLICKER] Sponsor screen detected mid-click — resolving...");
    const sponsorMsgs = await client.getMessages(BOT, { limit: 5 });
    const sponsorMsg = sponsorMsgs.find(m =>
      (m.text?.includes("Чтобы активировать бота:") ||
       m.text?.includes("Для продолжения фарма звёзд")) &&
      m.replyMarkup
    );
    if (sponsorMsg) {
      const resolved = await handleSponsor(client, sponsorMsg);
      if (!resolved) throw new Error("SPONSOR_UNRESOLVABLE");
      await updateAccount(userId, {
        next_clicker_time: new Date(Date.now() + (CLICKER_MIN + Math.random() * CLICKER_MAX) * 60000).toISOString(),
        last_error: "Sponsor cleared — retrying next cycle",
      });
      return false;
    }
    throw new Error("SPONSOR_UNRESOLVABLE");
  }
  
  // Solve captcha if present (this happens after click)
  await sleep(delay());
  const captchaSolved = await solveCaptcha(client);
  
  // If captcha was solved (either now or during click), click succeeded - skip reward check
  if (captchaSolved || captchaSolvedDuringClick) {
    console.log("[CLICKER] ✅ Captcha solved - click succeeded");
  } else {
    // No captcha involved, check popup for reward
    if (!popup?.includes("получил")) {
      console.log("[CLICKER] ❌ Click failed - no reward received");
      console.log(`[CLICKER] Popup was: ${popup}`);
      await updateAccount(userId, {
        next_clicker_time: new Date(Date.now() + (CLICKER_MIN + Math.random() * CLICKER_MAX) * 60000).toISOString(),
        last_error: `Click failed: ${popup?.substring(0, 50)}`,
      });
      return false;
    }
    console.log("[CLICKER] ✅ Reward confirmed in popup");
  }

  // Get current stats
  const { data } = await supabase.from("accounts").select("total_clicks, cap").eq("user_id", userId).single();
  const totalClicks = (data?.total_clicks || 0) + 1;
  const currentCap = (data?.cap || 0) + 1;

  // Check cap limit
  if (currentCap >= CAP_LIMIT) {
    const capDelay = CAP_DELAY();
    console.log(`[CLICKER] 🛑 Cap limit (${CAP_LIMIT}), reset & delay ${capDelay}min`);
    await updateAccount(userId, {
      next_clicker_time: new Date(Date.now() + capDelay * 60000).toISOString(),
      last_click_at: new Date().toISOString(),
      total_clicks: totalClicks,
      cap: 0,
      error_count: 0,
      last_error: null,
    });
    console.log("[CLICKER] ✅ Success");
    return true;
  }

  // Normal update
  await updateAccount(userId, {
    next_clicker_time: new Date(Date.now() + (CLICKER_MIN + Math.random() * CLICKER_MAX) * 60000).toISOString(),
    last_click_at: new Date().toISOString(),
    total_clicks: totalClicks,
    cap: currentCap,
    error_count: 0,
    last_error: null,
  });

  console.log(`[CLICKER] ✅ Success (cap: ${currentCap}/${CAP_LIMIT})`);
  return true;
}

// ============================================
// DAILY
// ============================================
async function doDaily(client, userId) {
  console.log("[DAILY] Starting...");
  console.log(`[DEBUG-DAILY] Getting menu for user ${userId}`);
  
  const menu = await ensureMenu(client);
  console.log(`[DEBUG-DAILY] Menu obtained, clicking Profile`);
  
  await withCaptcha(client, async () => {
    await sleep(delay());
    await menu.click({ text: "👤 Профиль" });
    await sleep(delay());
  });
  console.log(`[DEBUG-DAILY] Profile clicked, getting messages`);

  const msgs = await client.getMessages(BOT, { limit: 3 });
  const profile = msgs.find(m => m.replyMarkup && m.text?.includes("Профиль"));
  
  if (!profile) {
    console.log(`[DEBUG-DAILY] Profile not found in messages`);
    throw new Error("Profile not found");
  }

  console.log(`[DEBUG-DAILY] Profile found, clicking Daily reward`);

  let dailyPopup = null;
  await withCaptcha(client, async () => {
    const dailyBtn = findButton(profile, "Ежедневка");
    if (dailyBtn?.data) {
      dailyPopup = await getCallbackAnswer(client, profile, dailyBtn.data);
      console.log(`[DAILY] Popup: ${dailyPopup || "none"}`);
    } else {
      await profile.click({ text: "🎁 Ежедневка" });
    }
    await sleep(delay());
  });

  // Check for profile link / privacy settings error
  if (dailyPopup?.includes("Сначала поставь свою личную ссылку")) {
    console.log("[DAILY] ⚠️ Profile link required — notifying admin");
    await sendAdminNotification(client,
      "⚠️ Daily: Profile Link Required",
      `Instance: ${INSTANCE_ID}\nUser: ${userId}\n\nBot requires personal link in bio or privacy settings change.`
    );
    // Still schedule next daily on normal 24h cycle
    await updateAccount(userId, {
      next_daily_time: new Date(Date.now() + DAILY * 60000).toISOString(),
      last_error: "Profile link required for daily",
    });
    return false;
  }

  console.log(`[DEBUG-DAILY] Daily clicked, updating database`);
  const { data } = await supabase.from("accounts").select("total_dailies").eq("user_id", userId).single();
  const totalDailies = (data?.total_dailies || 0) + 1;

  await updateAccount(userId, {
    next_daily_time: new Date(Date.now() + DAILY * 60000).toISOString(),
    last_daily_at: new Date().toISOString(),
    total_dailies: totalDailies,
    error_count: 0,
    last_error: null,
  });

  console.log("[DAILY] ✅ Success");
  console.log(`[DEBUG-DAILY] Completed for user ${userId}`);
  return true;
}

// ============================================
// PROCESS
// ============================================
async function processAccount(acc) {
  console.log(`\n━━━ Account ${acc.phone} ━━━`);
  
  let client;
  try {
    client = new TelegramClient(new StringSession(acc.session_string), API_ID, API_HASH, {
      connectionRetries: 5,
      receiveUpdates: false,
      autoReconnect: false, // Don't auto-reconnect
    });

    await client.connect();
    console.log("✅ Connected");

    const now = new Date();
    const clickerDue = new Date(acc.next_clicker_time) <= now;
    const dailyDue   = new Date(acc.next_daily_time) <= now;
    // next_leave_time null = account never participates in leaving
    const leaveDue   = acc.next_leave_time && new Date(acc.next_leave_time) <= now;

    if (clickerDue) await doClicker(client, acc.user_id);
    if (dailyDue)   await doDaily(client, acc.user_id);
    if (leaveDue)   await leaveChannels(client, acc.user_id);
    if (!clickerDue && !dailyDue && !leaveDue) console.log("⏭️ Nothing due");
    
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    
    const delayMinutes = (delay) => delay + (CLICKER_MIN + Math.random() * CLICKER_MAX);
    
    if (error.message === "CHANNELS_TOO_MUCH") {
      await sendAdminNotification(client, "🚨 Channel Limit (500)",
        `Instance: ${INSTANCE_ID}
Phone: ${acc.phone}
User: ${acc.user_id}`);
      await updateAccount(acc.user_id, {
        next_clicker_time: new Date(Date.now() + delayMinutes(CHANNEL_LIMIT_DELAY) * 60000).toISOString(),
        next_leave_time: new Date().toISOString(), // trigger leave on next cycle
        last_error: "Channel limit (500)",
      });
    } else if (error.message === "SPONSOR_UNRESOLVABLE") {
      console.log("[SPONSOR] Unresolvable after 3 attempts — delaying account");
      await sendAdminNotification(client,
        "🚨 Sponsor: Unresolvable After 3 Attempts",
        `Instance: ${INSTANCE_ID}\nPhone: ${acc.phone}\nUser: ${acc.user_id}\n\nAll 3 sponsor verification attempts failed.`
      );
      await updateAccount(acc.user_id, {
        next_clicker_time: new Date(Date.now() + delayMinutes(SPONSOR_DELAY) * 60000).toISOString(),
        last_error: "Sponsor screen unresolvable after 3 attempts",
      });
    } else {
      await incrementError(acc.user_id, error.message);
      if (client) {
        await sendAdminNotification(client, "⚠️ Error Alert",
          `Instance: ${INSTANCE_ID}\nUser: ${acc.user_id}\nPhone: ${acc.phone}\nError: ${error.message}`);
      }
    }
  } finally {
    if (client) {
      console.log(`[DEBUG-PROCESS] Cleanup started`);
      try {
        await sleep(500);
        console.log(`[DEBUG-PROCESS] Calling destroy()`);
        await client.destroy();
        console.log("🔌 Disconnected");
      } catch (e) {
        console.log(`[DEBUG-PROCESS] Destroy error (suppressing): ${e.message}`);
      }
      console.log(`[DEBUG-PROCESS] Cleanup finished`);
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
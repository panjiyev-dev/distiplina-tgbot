// ================================================
// StudyTrack Telegram Bot
// Node.js + node-telegram-bot-api + firebase-admin
// npm install node-telegram-bot-api firebase-admin node-cron
// ================================================

const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const cron = require('node-cron');

// ==============================
// 🔥 CONFIG — O'ZGARTIRING
// ==============================
const BOT_TOKEN = process.env.BOT_TOKEN; // @BotFather dan oling
// Firebase Console > Project Settings > Service Accounts
const serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ==============================
// /start command
// ==============================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name || 'Do\'stim';

  await bot.sendMessage(chatId, 
    `👋 Salom, ${firstName}!\n\n` +
    `🎯 *StudyTrack* botiga xush kelibsiz!\n\n` +
    `Bu bot sizga o'rganilgan mavzularni takrorlashni eslatib turadi.\n\n` +
    `📋 *Qanday ulash:*\n` +
    `1. Sizning Chat ID: \`${chatId}\`\n` +
    `2. Saytga kiring: https://panjiyevdev-ditiplin.netlify.app\n` +
    `3. Telegram Bot sahifasida shu ID ni kiriting\n\n` +
    `✅ Tayyor! Eslatmalar avtomatik boshlanadi.`,
    { parse_mode: 'Markdown' }
  );
});

// ==============================
// Tasdiqlash tugmasi callback
// ==============================
bot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  const chatId = msg.chat.id;
  const data = callbackQuery.data; // format: "confirm_ENTRYID" or "skip_ENTRYID"

  if (data.startsWith('confirm_')) {
    const entryId = data.replace('confirm_', '');
    await handleConfirm(chatId, entryId, msg);
    await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Tasdiqlandi!' });
  }
});

async function handleConfirm(chatId, entryId, msg) {
  try {
    const entryRef = db.collection('entries').doc(entryId);
    const snap = await entryRef.get();
    if (!snap.exists) return;

    const data = snap.data();
    const now = new Date();
    const reminderDate = data.reminderDate;
    const todayStr = getTodayStr();

    // Determine next reminder date based on spaced repetition
    let nextStatus, nextDate, responseMsg;
    const daysSinceFirst = daysBetween(data.date, todayStr);

    if (daysSinceFirst <= 4) {
      // First confirmation (~3 days): schedule 7 days later
      nextDate = getDatePlusDays(todayStr, 7);
      nextStatus = 'confirmed_once';
      responseMsg = `🎉 Ajoyib! Birinchi takrorlash tasdiqlandi!\n⏭ Keyingi takrorlash: *${nextDate}*`;
    } else if (daysSinceFirst <= 12) {
      // Second confirmation (~3+7=10 days): schedule 15 days later
      nextDate = getDatePlusDays(todayStr, 15);
      nextStatus = 'confirmed_twice';
      responseMsg = `🔥 Zo'r! Ikkinchi takrorlash tasdiqlandi!\n⏭ Keyingi takrorlash: *${nextDate}*`;
    } else {
      // Third confirmation: MASTERED!
      nextDate = null;
      nextStatus = 'mastered';
      responseMsg = `🏆 MUKAMMAL! Bu mavzu to'liq o'zlashtirildi! ✨`;
    }

    await entryRef.update({
      reminderStatus: nextStatus,
      reminderDate: nextDate,
      lastConfirmedAt: now.toISOString(),
      [`confirmations.${todayStr}`]: true
    });

    await bot.editMessageText(
      msg.text + `\n\n✅ *TASDIQLANDI* — ${now.toLocaleString('uz')}`,
      { chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown' }
    );

    await bot.sendMessage(chatId, responseMsg, { parse_mode: 'Markdown' });

  } catch (e) {
    console.error('Confirm error:', e);
  }
}

// ==============================
// CRON JOB — har soatda tekshir
// ==============================
// Har soatda (7:00 dan 21:00 gacha) ishlaydi
cron.schedule('0 7-21 * * *', async () => {
  const hour = new Date().getHours();
  console.log(`[${new Date().toISOString()}] Checking reminders... Hour: ${hour}`);
  await sendReminders(hour);
});

async function sendReminders(currentHour) {
  const todayStr = getTodayStr();

  try {
    // Find all entries that need reminder today
    const snap = await db.collection('entries')
      .where('reminderDate', '==', todayStr)
      .get();

    for (const docSnap of snap.docs) {
      const data = docSnap.data();
      const entryId = docSnap.id;
      const uid = data.uid;

      // Get user's telegram chat ID
      const userSnap = await db.collection('users').doc(uid).get();
      if (!userSnap.exists) continue;
      const userData = userSnap.data();
      const chatId = userData.tgChatId;
      if (!chatId) continue;

      // Check if already confirmed today
      if (data.confirmations && data.confirmations[todayStr]) {
        console.log(`Already confirmed: ${entryId}`);
        continue;
      }

      // Check reminder timing: send at 7:00 first, then every 3 hours
      const sentHours = data.sentHours || [];
      const alreadySentThisHour = sentHours.includes(currentHour);
      if (alreadySentThisHour) continue;

      // Only send at 7, 10, 13, 16, 19, 21
      const allowedHours = [7, 10, 13, 16, 19, 21];
      if (!allowedHours.includes(currentHour)) continue;

      // Build message
      const subjects = data.subjects || [];
      const subjectText = subjects.map(s => 
        `📚 *${s.subject}*\n${s.notes ? '   ' + s.notes.substring(0, 100) + (s.notes.length > 100 ? '...' : '') : ''}`
      ).join('\n\n');

      const reminderNum = sentHours.length + 1;
      const message = 
        `🔔 *TAKRORLASH ESLATMASI* (${reminderNum}-marta)\n\n` +
        `📅 Sana: ${data.date}\n\n` +
        `O'rganilgan mavzular:\n\n${subjectText}\n\n` +
        `❓ Bularni hali ham eslaysizmi?\n` +
        `Tasdiqlasangiz, keyingi eslatma ${currentHour === 7 ? '3' : '3'} soatdan so\'ng takrorlanmaydi.`;

      const keyboard = {
        inline_keyboard: [[
          { text: '✅ Ha, eslayapman! (Tasdiqlash)', callback_data: `confirm_${entryId}` }
        ]]
      };

      try {
        await bot.sendMessage(chatId, message, {
          parse_mode: 'Markdown',
          reply_markup: keyboard
        });

        // Mark as sent this hour
        await docSnap.ref.update({
          sentHours: admin.firestore.FieldValue.arrayUnion(currentHour),
          lastSentAt: new Date().toISOString()
        });

        console.log(`✅ Sent reminder to ${chatId} for entry ${entryId}`);
      } catch (e) {
        console.error(`Failed to send to ${chatId}:`, e.message);
      }
    }

    // Check end of day (21:00) — mark unconfirmed as not_learned
    if (currentHour === 21) {
      await markUnconfirmedEntries(todayStr);
    }

  } catch (e) {
    console.error('Reminder cron error:', e);
  }
}

async function markUnconfirmedEntries(todayStr) {
  const snap = await db.collection('entries')
    .where('reminderDate', '==', todayStr)
    .get();

  for (const docSnap of snap.docs) {
    const data = docSnap.data();
    if (data.confirmations && data.confirmations[todayStr]) continue;
    if (data.reminderStatus === 'mastered') continue;

    const sentHours = data.sentHours || [];
    if (sentHours.length === 0) continue; // never sent, skip

    await docSnap.ref.update({
      reminderStatus: 'not_learned',
      notLearnedAt: new Date().toISOString()
    });

    // Notify user
    const userSnap = await db.collection('users').doc(data.uid).get();
    if (!userSnap.exists) continue;
    const chatId = userSnap.data().tgChatId;
    if (!chatId) continue;

    const subjects = (data.subjects || []).map(s => s.subject).join(', ');
    await bot.sendMessage(chatId,
      `😔 *${data.date}* sanasidagi mavzular tasdiqllanmadi:\n` +
      `📚 ${subjects}\n\n` +
      `Saytda statistikada "O'rganilmadi" bo'limida ko'rinadi.\n` +
      `💪 Ertaga yana takrorlab ko'ring!`,
      { parse_mode: 'Markdown' }
    );
  }
}

// ==============================
// HELPERS
// ==============================
function getTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function getDatePlusDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function daysBetween(date1, date2) {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  return Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
}

console.log('🤖 StudyTrack Bot ishga tushdi!');
console.log('📅 Har kuni 7:00-21:00 orasida tekshiradi');
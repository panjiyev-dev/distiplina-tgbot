require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const cron = require('node-cron');
const express = require('express');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = -1002097002247;
const CHANNEL_USERNAME = 'panjiyevdev';
const SITE_URL = 'https://study-track.uz';
const HTTP_PORT = process.env.PORT || 3000;

const serviceAccount = process.env.GOOGLE_CREDENTIALS 
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS) 
    : require('./serviceAccount.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ==============================
// EXPRESS HTTP SERVER
// ==============================
const app = express();
app.use(express.json());

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// POST /sendOtp
app.post('/sendOtp', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Telefon raqam kiritilmadi' });
    const normalPhone = phone.replace(/\s/g, '');

    try {
        const tgSnap = await db.collection('tg_users')
            .where('phone', '==', normalPhone).limit(1).get();

        if (tgSnap.empty) {
            return res.status(404).json({
                error: 'no-chat-id',
                message: 'Bu raqam Telegram bot bilan boglanmagan. @panjiyevdevbot ga /start bosing'
            });
        }

        const tgUser = tgSnap.docs[0].data();
        const chatId = tgUser.chatId;

        // Rate limit
        const oldCode = await db.collection('tg_codes').doc(normalPhone).get();
        if (oldCode.exists) {
            const sentAt = oldCode.data().sentAt?.toDate();
            if (sentAt && (Date.now() - sentAt.getTime()) < 60 * 1000) {
                return res.status(429).json({ error: 'too-many-requests', message: 'Iltimos, 1 daqiqa kuting' });
            }
        }

        const code = String(Math.floor(100000 + Math.random() * 900000));
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

        await db.collection('tg_codes').doc(normalPhone).set({
            code, chatId,
            phone: normalPhone,
            name: tgUser.firstName || '',
            photoUrl: tgUser.photoUrl || '',
            sentAt: admin.firestore.FieldValue.serverTimestamp(),
            expiresAt,
            attempts: 0
        });

        await bot.sendMessage(chatId,
            `🔐 *StudyTrack — Tasdiqlash kodi*\n\n` +
            `Sizning kodingiz:\n\n` +
            `┌─────────────┐\n` +
            `│   *${code}*   │\n` +
            `└─────────────┘\n\n` +
            `⏱ Kod 5 daqiqa ichida amal qiladi.\n` +
            `🚫 Kodni hech kimga bermang!`,
            { parse_mode: 'Markdown' }
        );

        console.log(`OTP sent to chatId ${chatId} for phone ${normalPhone}`);
        return res.json({ success: true });

    } catch (e) {
        console.error('sendOtp error:', e);
        return res.status(500).json({ error: e.message });
    }
});

// POST /verifyOtp
app.post('/verifyOtp', async (req, res) => {
    const { phone, code } = req.body;
    if (!phone || !code) return res.status(400).json({ error: 'Malumotlar yetarli emas' });
    const normalPhone = phone.replace(/\s/g, '');

    try {
        const codeDoc = await db.collection('tg_codes').doc(normalPhone).get();
        if (!codeDoc.exists) {
            return res.status(400).json({ error: 'invalid-code', message: 'Kod topilmadi' });
        }

        const codeData = codeDoc.data();

        // Muddati
        const expiresAt = codeData.expiresAt?.toDate();
        if (!expiresAt || Date.now() > expiresAt.getTime()) {
            await codeDoc.ref.delete();
            return res.status(400).json({ error: 'code-expired', message: 'Kod muddati otdi. Yangi kod oling' });
        }

        // Urinish soni
        if (codeData.attempts >= 5) {
            await codeDoc.ref.delete();
            return res.status(400).json({ error: 'too-many-attempts', message: 'Yangi kod oling' });
        }

        // Tekshirish
        if (codeData.code !== code) {
            await codeDoc.ref.update({ attempts: admin.firestore.FieldValue.increment(1) });
            const left = 5 - (codeData.attempts + 1);
            return res.status(400).json({ error: 'invalid-code', message: `Notogri kod. ${left} ta urinish qoldi` });
        }

        // User yaratish yoki topish
        const uid = `tg_${codeData.chatId}`;
        const displayName = codeData.name || '';
        const photoUrl = codeData.photoUrl || '';

        try {
            await admin.auth().getUser(uid);
        } catch (e) {
            await admin.auth().createUser({ uid, displayName, phoneNumber: normalPhone });
        }

        // Firestore users saqlash (ism, telefon, tgChatId, avatar)
        await db.collection('users').doc(uid).set({
            phone: normalPhone,
            name: displayName,
            tgChatId: String(codeData.chatId),
            tgPhotoUrl: photoUrl,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        const token = await admin.auth().createCustomToken(uid);
        await codeDoc.ref.delete();

        await bot.sendMessage(codeData.chatId,
            `✅ *Muvaffaqiyatli kirdingiz!*\n\nStudyTrack'ga xush kelibsiz! 🎉`,
            { parse_mode: 'Markdown' }
        );

        console.log(`User ${uid} verified`);
        return res.json({ success: true, token, uid });

    } catch (e) {
        console.error('verifyOtp error:', e);
        return res.status(500).json({ error: e.message });
    }
});

app.listen(HTTP_PORT, () => console.log(`🌐 HTTP server: http://localhost:${HTTP_PORT}`));

// ==============================
// USER STATES
// ==============================
const userStates = new Map();
function getState(chatId) { return userStates.get(chatId) || { step: 'idle' }; }
function setState(chatId, state) {
    userStates.set(chatId, state);
    setTimeout(() => userStates.delete(chatId), 10 * 60 * 1000);
}
function clearState(chatId) { userStates.delete(chatId); }

// ==============================
// HELPERS
// ==============================
async function isSubscribed(userId) {
    try {
        const member = await bot.getChatMember(CHANNEL_ID, userId);
        return ['creator', 'administrator', 'member'].includes(member.status);
    } catch (e) { return false; }
}

function normalizePhone(raw) {
    let p = raw.replace(/[\s\-\(\)]/g, '');
    if (p.startsWith('+')) return p;
    if (p.startsWith('998')) return '+' + p;
    if (p.length === 9) return '+998' + p;
    if (p.startsWith('0')) return '+998' + p.slice(1);
    return '+' + p;
}
function isValidPhone(p) { return /^\+998[0-9]{9}$/.test(p); }

function getTodayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function getDatePlusDays(dateStr, days) {
    const d = new Date(dateStr); d.setDate(d.getDate() + days); return d.toISOString().split('T')[0];
}
function daysBetween(d1, d2) { return Math.round((new Date(d2) - new Date(d1)) / 86400000); }

// Telegram dan avatar URL olish
async function getTgPhotoUrl(userId) {
    try {
        const photos = await bot.getUserProfilePhotos(userId, { limit: 1 });
        if (!photos.photos.length) return '';
        const fileId = photos.photos[0][0].file_id;
        const file = await bot.getFile(fileId);
        return `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    } catch (e) { return ''; }
}

// ==============================
// /start COMMAND
// ==============================
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const firstName = msg.from.first_name || 'Dostim';

    clearState(chatId);

    const subscribed = await isSubscribed(userId);
    if (!subscribed) {
        return bot.sendMessage(chatId,
            `🔔 *Davom etish uchun obuna bolishingiz kerak!*\n\n` +
            `📢 @${CHANNEL_USERNAME} kanalimizga obuna boling, keyin "Tasdiqlash" tugmasini bosing.`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📢 Kanalimiz', url: `https://t.me/${CHANNEL_USERNAME}` }],
                        [{ text: '✅ Obunani tasdiqlash', callback_data: `verify_sub_${userId}` }]
                    ]
                }
            }
        );
    }

    const existing = await db.collection('tg_users').where('chatId', '==', chatId).limit(1).get();
    if (!existing.empty) {
        const userData = existing.docs[0].data();
        return bot.sendMessage(chatId,
            `👋 Salom, ${firstName}!\n\n` +
            `✅ Siz allaqachon royxatdan otgansiz.\n` +
            `📱 Telefon: \`${userData.phone}\`\n\n` +
            `🚀 Saytga kiring va organishni boshlang!\n\n` +
            `💡 *Spaced Repetition:*\n3 kun → 7 kun → 15 kun → 🏆`,
            {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '🌐 Saytga kirish', url: SITE_URL }]] }
            }
        );
    }

    setState(chatId, { step: 'waiting_phone', firstName });
    return bot.sendMessage(chatId,
        `👋 Salom, ${firstName}!\n\n` +
        `🎯 *StudyTrack* botiga xush kelibsiz!\n\n` +
        `📱 Botdan foydalanish uchun telefon raqamingizni yuboring:`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                keyboard: [[{ text: '📱 Telefon raqamimni yuborish', request_contact: true }]],
                resize_keyboard: true, one_time_keyboard: true
            }
        }
    );
});

// ==============================
// CONTACT HANDLER
// ==============================
bot.on('contact', async (msg) => {
    const chatId = msg.chat.id;
    const contact = msg.contact;
    if (contact.user_id !== msg.from.id) {
        return bot.sendMessage(chatId, "❌ Iltimos faqat oz raqamingizni yuboring.");
    }
    const phone = normalizePhone(contact.phone_number);
    await savePhoneAndRespond(chatId, phone, msg.from.first_name || '', msg.from.id);
});

// ==============================
// TEXT HANDLER
// ==============================
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text || text.startsWith('/')) return;
    const state = getState(chatId);
    if (state.step === 'waiting_phone') {
        const phone = normalizePhone(text);
        if (!isValidPhone(phone)) {
            return bot.sendMessage(chatId,
                `❌ Telefon raqam notogri.\n\nTogri format: \`901234567\``,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        keyboard: [[{ text: '📱 Telefon raqamimni yuborish', request_contact: true }]],
                        resize_keyboard: true, one_time_keyboard: true
                    }
                }
            );
        }
        await savePhoneAndRespond(chatId, phone, msg.from.first_name || '', msg.from.id);
    }
});

// ==============================
// SAVE PHONE + AVATAR
// ==============================
async function savePhoneAndRespond(chatId, phone, firstName, userId) {
    clearState(chatId);
    try {
        const phoneSnap = await db.collection('tg_users').where('phone', '==', phone).limit(1).get();
        if (!phoneSnap.empty && phoneSnap.docs[0].data().chatId !== chatId) {
            return bot.sendMessage(chatId,
                `⚠️ Bu telefon raqami boshqa akkauntga bogliq.`,
                { reply_markup: { remove_keyboard: true } }
            );
        }

        // Telegram avatar olish
        const photoUrl = await getTgPhotoUrl(userId);

        await db.collection('tg_users').doc(String(chatId)).set({
            chatId, phone, firstName, photoUrl,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        await bot.sendMessage(chatId,
            `✅ *Ajoyib, ${firstName}!*\n\n` +
            `📱 Telefon raqam saqlandi: \`${phone}\`\n\n` +
            `Endi saytga kirib tasdiqlash kodini oling.\n\n` +
            `💡 *Spaced Repetition:*\n3 kun → 7 kun → 15 kun → 🏆`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    remove_keyboard: true,
                    inline_keyboard: [[{ text: '🌐 Saytga kirish', url: SITE_URL }]]
                }
            }
        );
        console.log(`Saved phone ${phone} for chatId ${chatId}`);
    } catch (e) {
        console.error('savePhone error:', e);
        bot.sendMessage(chatId, '❌ Xatolik yuz berdi. Qayta /start bosing.');
    }
}

// ==============================
// CALLBACK QUERY
// ==============================
bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const userId = callbackQuery.from.id;
    const data = callbackQuery.data;

    if (data.startsWith('verify_sub_')) {
        const subscribed = await isSubscribed(userId);
        if (subscribed) {
            await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Raxmat!', show_alert: false });
            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
            const firstName = callbackQuery.from.first_name || 'Dostim';
            setState(chatId, { step: 'waiting_phone', firstName });
            await bot.sendMessage(chatId, `✅ Obuna tasdiqlandi!\n\n📱 Telefon raqamingizni yuboring:`, {
                parse_mode: 'Markdown',
                reply_markup: {
                    keyboard: [[{ text: '📱 Telefon raqamimni yuborish', request_contact: true }]],
                    resize_keyboard: true, one_time_keyboard: true
                }
            });
        } else {
            await bot.answerCallbackQuery(callbackQuery.id, { text: "❌ Avval kanalga obuna boling!", show_alert: true });
        }
        return;
    }

    if (data.startsWith('confirm_')) {
        await handleConfirm(chatId, data.replace('confirm_', ''), msg, callbackQuery.id);
    }
});

// ==============================
// TAKRORLASH TASDIQLASH
// ==============================
async function handleConfirm(chatId, entryId, msg, callbackQueryId) {
    try {
        const entryRef = db.collection('entries').doc(entryId);
        const snap = await entryRef.get();
        if (!snap.exists) return bot.answerCallbackQuery(callbackQueryId, { text: '❌ Topilmadi!', show_alert: true });

        const data = snap.data();
        const todayStr = getTodayStr();
        const days = daysBetween(data.date, todayStr);
        let nextStatus, nextDate, responseMsg;

        if (days <= 4) {
            nextDate = getDatePlusDays(todayStr, 7); nextStatus = 'confirmed_once';
            responseMsg = `🎉 *Birinchi takrorlash tasdiqlandi!*\n\n⏭ Keyingi: \`${nextDate}\``;
        } else if (days <= 12) {
            nextDate = getDatePlusDays(todayStr, 15); nextStatus = 'confirmed_twice';
            responseMsg = `🔥 *Ikkinchi takrorlash tasdiqlandi!*\n\n⏭ Keyingi: \`${nextDate}\``;
        } else {
            nextDate = null; nextStatus = 'mastered';
            responseMsg = `🏆 *MUKAMMAL! Toliq ozlashtirildi!* ✨`;
        }

        await entryRef.update({
            reminderStatus: nextStatus, reminderDate: nextDate,
            lastConfirmedAt: new Date().toISOString(),
            [`confirmations.${todayStr}`]: true
        });

        await bot.editMessageText(msg.text + `\n\n✅ *TASDIQLANDI*`, {
            chat_id: chatId, message_id: msg.message_id,
            parse_mode: 'Markdown', reply_markup: { inline_keyboard: [] }
        });
        await bot.sendMessage(chatId, responseMsg, { parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(callbackQueryId, { text: '✅ Tasdiqlandi!' });
    } catch (e) {
        console.error('Confirm error:', e);
        bot.answerCallbackQuery(callbackQueryId, { text: '❌ Xatolik!', show_alert: true });
    }
}

// ==============================
// CRON
// ==============================
cron.schedule('0 7-21 * * *', async () => {
    const hour = new Date().getHours();
    await sendReminders(hour);
});

async function sendReminders(currentHour) {
    const todayStr = getTodayStr();
    const allowedHours = [7, 10, 13, 16, 19, 21];
    if (!allowedHours.includes(currentHour)) return;

    try {
        const snap = await db.collection('entries').where('reminderDate', '==', todayStr).get();
        for (const docSnap of snap.docs) {
            const data = docSnap.data();
            if (data.confirmations?.[todayStr]) continue;
            const userSnap = await db.collection('users').doc(data.uid).get();
            if (!userSnap.exists) continue;
            const chatId = userSnap.data().tgChatId;
            if (!chatId) continue;
            const sentHours = data.sentHours || [];
            if (sentHours.includes(currentHour)) continue;

            const subjectText = (data.subjects || []).map(s =>
                `📚 *${s.subject}*${s.notes ? '\n   ' + s.notes.substring(0, 100) : ''}`
            ).join('\n\n');

            await bot.sendMessage(chatId,
                `🔔 *TAKRORLASH ESLATMASI* (${sentHours.length+1}-marta)\n\n📅 ${data.date}\n\n${subjectText}\n\n❓ Bularni eslaysizmi?`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '✅ Ha, eslayapman!', callback_data: `confirm_${docSnap.id}` }]] }
                }
            );
            await docSnap.ref.update({
                sentHours: admin.firestore.FieldValue.arrayUnion(currentHour),
                lastSentAt: new Date().toISOString()
            });
        }
        if (currentHour === 21) await markUnconfirmed(todayStr);
    } catch (e) { console.error('Cron error:', e); }
}

async function markUnconfirmed(todayStr) {
    const snap = await db.collection('entries').where('reminderDate', '==', todayStr).get();
    for (const docSnap of snap.docs) {
        const data = docSnap.data();
        if (data.confirmations?.[todayStr] || data.reminderStatus === 'mastered' || !data.sentHours?.length) continue;
        await docSnap.ref.update({ reminderStatus: 'not_learned', notLearnedAt: new Date().toISOString() });
        const userSnap = await db.collection('users').doc(data.uid).get();
        if (!userSnap.exists) continue;
        const chatId = userSnap.data().tgChatId;
        if (!chatId) continue;
        await bot.sendMessage(chatId,
            `😔 *${data.date}* sanasidagi mavzular tasdiqlanmadi.\n\n💪 Ertaga takrorlab koring!`,
            { parse_mode: 'Markdown' }
        ).catch(() => {});
    }
}

console.log('🤖 StudyTrack Bot v3.0 ishga tushdi!');
console.log('📢 Majburiy obuna: @' + CHANNEL_USERNAME);
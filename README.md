# StudyTrack Telegram Bot

Telegram bot for **StudyTrack** — o'rganilgan mavzularni takrorlash va eslatib turish uchun.


## Nima qiladi?

- Foydalanuvchi `/start` yozganda o'z **Chat ID** sini ko'rsatadi
- Har kuni ertalab 7:00 dan kechgacha (7, 10, 13, 16, 19, 21 soatlarda) eslatma tekshiradi
- +3 kundan keyin birinchi eslatma yuboradi
- Foydalanuvchi tasdiqlasa → keyingi takrorlash oralig'i uzoqlashadi (3 → 7 → 15 kun)
- Tasdiqlanmasa → kun oxirida "o'rganilmadi" statusiga o'tkazadi va xabar yuboradi
- Spaced repetition (takrorlash oralig'i) tizimi bilan ishlaydi

## Texnologiyalar

- Node.js
- node-telegram-bot-api
- firebase-admin
- node-cron (har soatlik tekshirish uchun)

## Tez boshlash

1. Repository ni klon qiling:
   ```bash
   git clone https://github.com/panjiyev-dev/distiplina-tgbot.git
   cd distiplina-tgbot

# مساعد — مساعد شخصي ذكي على واتساب

بوت واتساب (Baileys) بيشتغل ٢٤/٧ على Render، ومعاه:
- علامتين زرق (قراءة الرسائل)
- رد بالاقتباس + رياكشن إيموجي
- بحث في النت (Bing + ويكيبيديا)
- توليد صور مجاني (Pollinations)
- جلسة محفوظة على Upstash Redis (مفيش QR كل مرة)

## التشغيل على Render
1. New → Web Service → اربط المستودع ده.
2. Build Command: `npm install`
3. Start Command: `npm start`
4. Environment:
   - `AI_API_KEY` مفتاح Z.ai
   - `AI_BASE_URL` = `https://api.z.ai/api/paas/v4`
   - `AI_MODEL` = `glm-4.5-flash`
   - `AI_THINKING` = `disabled`
   - `GROUP_NAME` = `العواطليه`
   - `UPSTASH_REDIS_REST_URL` و `UPSTASH_REDIS_REST_TOKEN`
   - `CONTACT_PHONE` = `01213737181`
5. افتح `/qr` وصوّر الكود من الموبايل مرة واحدة.

## المسارات
- `/` حالة البوت
- `/qr` كود الربط (لو محتاج)
- `/health` فحص سريع JSON

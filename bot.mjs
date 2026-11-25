/**
 * «مساعد» — مساعد شخصي ذكي على واتساب (Baileys).
 *
 * الميزات: قراءة الرسائل (علامتين زرق) · رد بالاقتباس · رياكشن بالإيموجي ·
 * بحث في النت · روابط · إرسال صور (توليد مجاني بـ Pollinations) · ردود سريعة جاهزة.
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import * as baileys from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const makeWASocket = baileys.default || baileys.makeWASocket;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, initAuthCreds, BufferJSON, proto } = baileys;

// ---------- إعدادات ----------
const secretsPath = path.resolve(__dirname, '..', '.local-secrets.json');
const secrets = fs.existsSync(secretsPath) ? JSON.parse(fs.readFileSync(secretsPath, 'utf8')) : {};

process.env.AI_API_KEY = process.env.AI_API_KEY || secrets.AI_API_KEY || '';
process.env.AI_BASE_URL = process.env.AI_BASE_URL || secrets.AI_BASE_URL || 'https://api.z.ai/api/paas/v4';
process.env.AI_MODEL = process.env.AI_MODEL || secrets.AI_MODEL || 'glm-4.5-flash';
process.env.AI_THINKING = process.env.AI_THINKING || 'disabled';
process.env.AI_TIMEOUT_MS = process.env.AI_TIMEOUT_MS || '25000';
process.env.CONTACT_PHONE = process.env.CONTACT_PHONE || '01213737181';

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const skipContacts = new Set((config.skipContacts || []).map((s) => String(s).replace(/[^0-9]/g, '')));
const groupName = process.env.GROUP_NAME || config.groupName || 'العواطليه';
const replyPrivate = process.env.REPLY_PRIVATE ? process.env.REPLY_PRIVATE === 'true' : Boolean(config.replyPrivate);

const { buildSystemPrompt } = require('./lib/persona.cjs');
const { generateReply } = require('./lib/brain.cjs');
const { webSearch } = require('./lib/search.cjs');

if (!process.env.AI_API_KEY) {
  console.error('❌ مفيش AI_API_KEY');
  process.exit(1);
}

// ---------- ذاكرة ----------
const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const historyFile = path.join(dataDir, 'history.json');

let history = {};
try {
  history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
} catch (e) {
  history = {};
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(historyFile, JSON.stringify(history));
    } catch (e) {
      console.error('history save failed', e.message);
    }
  }, 1500);
}

const getHistory = (jid) => (Array.isArray(history[jid]) ? history[jid] : []);
function pushHistory(jid, role, content) {
  const arr = getHistory(jid);
  arr.push({ role, content: String(content).slice(0, 1200) });
  history[jid] = arr.slice(-(config.historyLimit || 20));
  persist();
}

// ---------- أدوات ----------
const logger = pino({ level: 'silent' });

const phoneOf = (jid) => String(jid || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

function unwrap(message) {
  let m = message || {};
  for (let i = 0; i < 4; i += 1) {
    if (m.ephemeralMessage) m = m.ephemeralMessage.message || {};
    else if (m.viewOnceMessage) m = m.viewOnceMessage.message || {};
    else if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message || {};
    else if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message || {};
    else break;
  }
  return m;
}

function extractText(message) {
  const m = unwrap(message);
  return (
    m.conversation ||
    (m.extendedTextMessage && m.extendedTextMessage.text) ||
    (m.imageMessage && m.imageMessage.caption) ||
    (m.videoMessage && m.videoMessage.caption) ||
    (m.buttonsResponseMessage && m.buttonsResponseMessage.selectedDisplayText) ||
    (m.listResponseMessage && m.listResponseMessage.title) ||
    ''
  );
}

const isMediaOnly = (message) => {
  const m = unwrap(message);
  return !extractText(message) && Boolean(m.imageMessage || m.audioMessage || m.videoMessage || m.documentMessage || m.stickerMessage);
};

// ---------- الجروب المسموح ----------
const groupCache = new Map();

function normalizeAr(text) {
  return String(text || '')
    .replace(/[\u064B-\u0652\u0640\u200f\u200e]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, '')
    .toLowerCase();
}

const targetGroup = normalizeAr(config.groupName || 'العواطليه');

async function isTargetGroup(jid) {
  if (groupCache.has(jid)) return groupCache.get(jid);
  try {
    const meta = await sock.groupMetadata(jid);
    const subject = normalizeAr(meta && meta.subject);
    const match = subject === targetGroup || subject.includes(targetGroup) || targetGroup.includes(subject);
    groupCache.set(jid, match);
    console.log('[group]', meta && meta.subject, '→', match ? 'مسموح' : 'متجاهل');
    return match;
  } catch (err) {
    console.log('[group] metadata error:', err.message);
    return false;
  }
}

// ---------- صور مجانية (Pollinations) ----------
function imageUrlFor(prompt) {
  return 'https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt) + '?width=1024&height=1024&nologo=true';
}

// ---------- ردود سريعة بدون API ----------
const fastRules = [
  { re: /^(السلام عليكم|سلام عليكم|السلامو عليكم)\s*$/i, reply: 'وعليكم السلام ورحمة الله وبركاته 🌿' },
  { re: /^(صباح الخير|صباح النور)\s*$/i, reply: 'صباح الفل ☀️' },
  { re: /^(مساء الخير|مساء النور)\s*$/i, reply: 'مساء الورد 🌙' },
  { re: /^(شكرا|شكرًا|تسلم|تسلمي|متشكر|برافو|جزاك الله خير)\s*[!.،]*$/i, reply: 'العفو يا صاحبي ❤️' },
];

function fastReply(text) {
  const t = String(text || '').trim();
  for (const r of fastRules) if (r.re.test(t)) return r.reply;
  return null;
}

// ---------- جلسة على Upstash Redis (للسيرفرات بقرص مؤقت) ----------
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const useRedis = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

async function redisCmd(cmd) {
  const res = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(10000),
  });
  const json = await res.json().catch(() => ({}));
  return json.result;
}

async function useRedisAuthState() {
  const raw = await redisCmd(['GET', 'wa:creds']);
  const creds = raw ? JSON.parse(raw, BufferJSON.reviver) : initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            const v = await redisCmd(['GET', 'wa:' + type + ':' + id]);
            if (!v) continue;
            let value = JSON.parse(v, BufferJSON.reviver);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          for (const type of Object.keys(data)) {
            for (const id of Object.keys(data[type])) {
              const value = data[type][id];
              if (value) {
                await redisCmd(['SET', 'wa:' + type + ':' + id, JSON.stringify(value, BufferJSON.replacer)]);
              } else {
                await redisCmd(['DEL', 'wa:' + type + ':' + id]);
              }
            }
          }
        },
      },
    },
    saveCreds: async () => {
      await redisCmd(['SET', 'wa:creds', JSON.stringify(creds, BufferJSON.replacer)]);
    },
  };
}

async function buildAuthState() {
  if (useRedis) {
    console.log('🔐 الجلسة على Upstash Redis');
    return useRedisAuthState();
  }
  console.log('🔐 الجلسة على ملفات محلية');
  return useMultiFileAuthState(path.join(__dirname, 'session'));
}

// ---------- البوت ----------
let sock = null;
let latestQR = null;
let connected = false;

async function start() {
  const { state, saveCreds } = await buildAuthState();

  let version;
  try {
    version = (await fetchLatestBaileysVersion()).version;
  } catch (e) {
    version = undefined;
  }

  sock = makeWASocket({
    auth: state,
    version,
    logger,
    printQRInTerminal: false,
    browser: Browsers ? Browsers.ubuntu('Chrome') : ['Chrome', 'Desktop', '1.0'],
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const file = path.join(__dirname, 'qr.png');
      await QRCode.toFile(file, qr, { width: 640, margin: 2 });
      latestQR = qr;
      connected = false;
      console.log('📷 QR جاهز: ' + file);
    }

    if (connection === 'open') {
      connected = true;
      latestQR = null;
      console.log('✅ متصل — ' + (sock.user && sock.user.id));
    }

    if (connection === 'close') {
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
      console.log('⚠️ الاتصال اتقفل (' + code + ')');
      if (code === DisconnectReason.loggedOut) {
        console.log('🚪 اتعمل خروج من الجلسة — امسح مجلد session وشغّل تاني.');
        process.exit(0);
      }
      setTimeout(() => start().catch((e) => console.error('restart failed', e.message)), 3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        await handleMessage(msg);
      } catch (err) {
        console.error('[handler]', err && err.message);
      }
    }
  });

  return sock;
}

async function reactTo(msg, emoji) {
  try {
    await sock.sendMessage(msg.key.remoteJid, { react: { text: emoji, key: msg.key } });
  } catch (e) {
    /* الرياكشن مش حرج */
  }
}

async function handleMessage(msg) {
  if (!msg.message) return;
  if (msg.key.fromMe) return;

  const jid = msg.key.remoteJid || '';
  if (jid === 'status@broadcast') return;

  const isGroup = jid.endsWith('@g.us');
  if (isGroup) {
    if (!(await isTargetGroup(jid))) return;
  } else if (!jid.endsWith('@s.whatsapp.net') || !config.replyPrivate) {
    return;
  }

  const phone = phoneOf(msg.key.participant || jid);
  if (skipContacts.has(phone)) return;

  // ✅ علامتين زرق
  try {
    await sock.readMessages([msg.key]);
  } catch (e) {
    /* مش حرج */
  }

  const pushName = msg.pushName || '';
  const text = String(extractText(msg.message)).trim();

  if (!text) {
    if (isMediaOnly(msg.message)) {
      await reactTo(msg, '👀');
      await sock.sendMessage(jid, { text: 'شفت إنك بعت مرفق 👀 بس أنا لسه بقرأ النصوص بس — اكتبلي السؤال أو التفاصيل وأنا أرد.' }, { quoted: msg });
    }
    return;
  }

  console.log('[msg]', phone, '→', text.slice(0, 70));

  // رد سريع بدون انتظار الموديل
  const cached = fastReply(text);
  if (cached) {
    try {
      await sock.sendPresenceUpdate('composing', jid);
    } catch (e) {}
    await sock.sendMessage(jid, { text: cached }, { quoted: msg });
    if (/شكرا|شكرًا|تسلم|برافو/i.test(text)) await reactTo(msg, '❤️');
    return;
  }

  try {
    await sock.sendPresenceUpdate('composing', jid);
  } catch (e) {}

  // طلب صورة؟
  const imageAsk = text.match(/(?:ارسم|اعمل|ولد|ابعتلي صورة|صمم)\s+(.+)/i);

  // طلب بحث؟
  let searchBlock = '';
  if (/(ابحث|ابحثلي|بحث|دور على|قولي|هات لي|search|google)/i.test(text) && text.length > 8) {
    const q = text.replace(/(ابحث|ابحثلي|عن|في النت|على النت|بحث|دور على|قولي|هات لي)/gi, ' ').trim().slice(0, 120);
    const results = await webSearch(q || text.slice(0, 120));
    if (results.length) {
      searchBlock = results.map((r, i) => `${i + 1}) ${r.title}\n${r.snippet}\n${r.url}`).join('\n\n');
      console.log('[search]', results.length, 'results for', q);
    }
  }

  const systemPrompt =
    buildSystemPrompt() +
    (searchBlock
      ? '\n\nنتايج بحث حديثة من النت (استخدمها كمرجع، واذكر الروابط المهمة للمستخدم في سطر واحد):\n' + searchBlock
      : '');

  let reply =
    (await generateReply({
      history: getHistory(jid),
      userText: text,
      systemPrompt,
      userName: pushName,
    })) || 'معلش، حصلت مشكلة عندي دلوقتي. جرّب تاني بعد شوية 🙏';

  // لو طلب صورة: نبعتله صورة مولّدة
  if (imageAsk && imageAsk[1]) {
    const prompt = imageAsk[1].trim().slice(0, 200);
    try {
      await sock.sendMessage(jid, { image: { url: imageUrlFor(prompt) }, caption: reply.slice(0, 500) }, { quoted: msg });
      pushHistory(jid, 'user', text);
      pushHistory(jid, 'assistant', '[صورة] ' + prompt);
      console.log('[image]', prompt);
      return;
    } catch (e) {
      console.log('[image] failed:', e.message);
      reply += '\n(معلش، توليد الصورة فشل دلوقتي 🙏)';
    }
  }

  await sock.sendMessage(jid, { text: reply }, { quoted: msg });

  // رياكشن عشوائي خفيف
  if (Math.random() < 0.15) await reactTo(msg, '👍');

  pushHistory(jid, 'user', text);
  pushHistory(jid, 'assistant', reply);
  console.log('[sent]', reply.slice(0, 60));
}

// ---------- سيرفر HTTP (للاستضافة) ----------
if (process.env.PORT) {
  const port = Number(process.env.PORT);
  http
    .createServer(async (req, res) => {
      const url = (req.url || '/').split('?')[0];

      if (url === '/qr') {
        if (!latestQR) {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(connected ? '✅ متصل بالفعل — مفيش QR مطلوب' : '⏳ مفيش QR دلوقتي، استنى ثانيتين وحدّث الصفحة');
          return;
        }
        try {
          const png = await QRCode.toBuffer(latestQR, { width: 640, margin: 2 });
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
          res.end(png);
        } catch (e) {
          res.writeHead(500).end('qr error');
        }
        return;
      }

      if (url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, connected, qr: Boolean(latestQR), session: useRedis ? 'redis' : 'file' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<html dir="rtl"><meta charset="utf-8"><body style="font-family:system-ui;text-align:center;padding:40px">' +
          '<h2>مساعد شغّال ✅</h2>' +
          '<p>الحالة: ' + (connected ? 'متصل بواتساب' : 'مستني ربط الجهاز') + '</p>' +
          (connected ? '' : '<p><a href="/qr">افتح QR وامسحه من الموبايل</a></p>') +
          '</body></html>'
      );
    })
    .listen(port, () => console.log('🌐 HTTP على المنفذ ' + port));
}

process.on('uncaughtException', (err) => console.error('uncaught:', err.message));
process.on('unhandledRejection', (err) => console.error('unhandled:', err && err.message));

start().catch((e) => {
  console.error('start failed:', e.message);
  process.exit(1);
});

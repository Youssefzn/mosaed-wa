'use strict';

/**
 * المخ — أي API متوافق مع OpenAI (Groq افتراضي، مجاني).
 */

const BASE = String(process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
const KEY = process.env.AI_API_KEY || '';
const MODEL = process.env.AI_MODEL || 'llama-3.3-70b-versatile';
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 14000);
const MAX_CHARS = Number(process.env.MAX_REPLY_CHARS || 600);

function trimReply(text) {
  let out = String(text || '').trim();
  if (!out) return '';
  const fence = out.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (fence) out = fence[1].trim();
  out = out.replace(/^(AI|Assistant|مساعد|البوت)\s*[:：]\s*/i, '').trim();
  if (out.length > MAX_CHARS) {
    const cut = out.slice(0, MAX_CHARS);
    const idx = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '), cut.lastIndexOf('؟ '));
    out = (idx > 120 ? cut.slice(0, idx + 1) : cut).trim() + ' …';
  }
  return out;
}

async function callApi(messages) {
  const payload = {
    model: MODEL,
    messages,
    temperature: 0.6,
    max_tokens: 400,
  };

  // بعض الموديلات (Z.ai GLM) بتحرق التوكنز في التفكير — نقدر نقفله
  if (String(process.env.AI_THINKING || '').toLowerCase() === 'disabled') {
    payload.thinking = { type: 'disabled' };
  }

  const res = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + KEY,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('API ' + res.status + ' :: ' + body.slice(0, 250));
  }

  const data = await res.json();
  const choice = data && data.choices && data.choices[0];
  return (choice && choice.message && choice.message.content) || '';
}

async function generateReply({ history, userText, systemPrompt, userName }) {
  if (!KEY) {
    console.error('AI_API_KEY ناقص');
    return null;
  }

  const messages = [{ role: 'system', content: systemPrompt }];
  if (userName) messages.push({ role: 'system', content: 'اسم المرسل: ' + userName });

  for (const m of (history || []).slice(-10)) {
    if (!m || !m.content) continue;
    messages.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content).slice(0, 1000),
    });
  }

  messages.push({ role: 'user', content: String(userText).slice(0, 1200) });

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const clean = trimReply(await callApi(messages));
      if (clean) return clean;
    } catch (err) {
      console.error('AI error (' + attempt + '):', err.message);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 800));
    }
  }
  return null;
}

module.exports = { generateReply, trimReply };

'use strict';

/**
 * الدماغ — أي API متوافق مع OpenAI، مع مزوّد احتياطي.
 * الافتراضي: Groq (سريع جدًا) واحتياطي Z.ai.
 */

const MAX_CHARS = Number(process.env.MAX_REPLY_CHARS || 600);
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 20000);

function provider(prefix) {
  const base = process.env[prefix + 'BASE_URL'];
  const key = process.env[prefix + 'API_KEY'];
  const model = process.env[prefix + 'MODEL'];
  if (!base || !key || !model) return null;
  return { base: String(base).replace(/\/+$/, ''), key, model };
}

const chain = [
  provider('AI_'),
  provider('AI_FALLBACK_'),
].filter(Boolean);

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

async function callApi(p, messages) {
  const payload = {
    model: p.model,
    messages,
    temperature: 0.6,
    max_tokens: 400,
  };

  // بعض موديلات Z.ai بتحرق التوكنز في التفكير — نقفلها لو مطلوب
  if (String(process.env.AI_THINKING || '').toLowerCase() === 'disabled' && /z\.ai/.test(p.base)) {
    payload.thinking = { type: 'disabled' };
  }

  const res = await fetch(p.base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.key },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(p.model + ' → ' + res.status + ' :: ' + body.slice(0, 160));
  }

  const data = await res.json();
  const choice = data && data.choices && data.choices[0];
  const message = (choice && choice.message) || {};
  return message.content || message.reasoning_content || '';
}

async function generateReply({ history, userText, systemPrompt, userName }) {
  if (!chain.length) {
    console.error('مفيش مزوّد ذكاء اصطناعي مضبوط');
    return null;
  }

  const messages = [{ role: 'system', content: systemPrompt }];
  if (userName) messages.push({ role: 'system', content: 'اسم المرسل: ' + userName });

  for (const m of (history || []).slice(-10)) {
    if (!m || !m.content) continue;
    messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 800) });
  }

  messages.push({ role: 'user', content: String(userText).slice(0, 1200) });

  for (const p of chain) {
    const t0 = Date.now();
    try {
      const clean = trimReply(await callApi(p, messages));
      if (clean) {
        console.log('[brain]', p.model, Date.now() - t0 + 'ms');
        return clean;
      }
    } catch (err) {
      console.error('[brain] failed:', err.message);
    }
  }

  return null;
}

module.exports = { generateReply, trimReply };

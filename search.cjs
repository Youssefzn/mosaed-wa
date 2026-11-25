'use strict';

/**
 * بحث بسيط من غير أي مفاتيح: Bing (HTML) مع Wikipedia كخطة بديلة.
 */

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'ar,en;q=0.8',
};

function strip(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// روابط Bing بتبقى ملوّفة: bing.com/ck/a?...&u=a1<base64>
function unwrapBingUrl(href) {
  try {
    const decoded = String(href).replace(/&amp;/g, '&');
    if (!/bing\.com\/ck\/a/.test(decoded)) return decoded;
    const u = new URL(decoded);
    const raw = u.searchParams.get('u');
    if (!raw) return decoded;
    const b64 = raw.startsWith('a1') ? raw.slice(2) : raw;
    const url = Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return /^https?:\/\//.test(url) ? url : decoded;
  } catch (e) {
    return href;
  }
}

async function bingSearch(query, limit) {
  const url = 'https://www.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=ar&count=' + (limit + 2);
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!res.ok) return [];
  const html = await res.text();
  const blocks = html.split('class="b_algo"').slice(1);
  const out = [];
  for (const b of blocks) {
    const link = b.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"/) || b.match(/<a[^>]+href="(https?:\/\/[^"]+)"/);
    const title = b.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    const snip = b.match(/<p[^>]*>([\s\S]*?)<\/p>/) || b.match(/class="b_caption"[^>]*>([\s\S]*?)<\/div>/);
    if (!link) continue;
    const href = link[1];
    if (!/^https?:\/\//.test(href)) continue;
    out.push({
      title: strip(title && title[1]).slice(0, 120) || href,
      url: unwrapBingUrl(href),
      snippet: strip(snip && snip[1]).slice(0, 240),
    });
    if (out.length >= limit) break;
  }
  return out;
}

async function wikiSearch(query, limit) {
  const api =
    'https://ar.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=' +
    limit +
    '&srsearch=' +
    encodeURIComponent(query);
  const res = await fetch(api, { headers: UA, signal: AbortSignal.timeout(12000) });
  if (!res.ok) return [];
  const json = await res.json();
  const hits = (json.query && json.query.search) || [];
  return hits.map((h) => ({
    title: h.title,
    url: 'https://ar.wikipedia.org/wiki/' + encodeURIComponent(h.title.replace(/ /g, '_')),
    snippet: strip(h.snippet).slice(0, 240),
  }));
}

async function webSearch(query, limit = 4) {
  try {
    const b = await bingSearch(query, limit);
    if (b.length) return b;
  } catch (err) {
    console.log('[search] bing failed:', err.message);
  }
  try {
    return await wikiSearch(query, limit);
  } catch (err) {
    console.log('[search] wiki failed:', err.message);
    return [];
  }
}

module.exports = { webSearch };

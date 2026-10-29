/*
 * 824 Shield — defense against AI-driven attacks.
 * Copyright (C) 2026 Nicholas Smith / 824
 *
 * This file is part of 824 Shield, free software licensed under the
 * GNU General Public License v3.0 (see the LICENSE file).
 */

// Heuristic scoring of how automated a request looks. Not a verdict on
// its own — the Shield combines this with rate and content signals.
// Real browsers send a rich, consistent header set; scripts, headless
// browsers, and AI crawlers usually do not.

const UA_SIGNALS = [
  { weight: 45, label: 'Known AI crawler user-agent', pattern: /gptbot|oai-searchbot|claudebot|claude-web|anthropic-ai|ccbot|bytespider|amazonbot|meta-externalagent|perplexitybot|cohere-ai|google-extended/i },
  { weight: 40, label: 'Headless browser user-agent', pattern: /headlesschrome|puppeteer|playwright|phantomjs|selenium/i },
  { weight: 40, label: 'Scripting-library user-agent', pattern: /python-requests|python-urllib|aiohttp|okhttp|axios|node-fetch|go-http-client|scrapy|httpclient/i },
  { weight: 35, label: 'Command-line tool user-agent', pattern: /curl\/|wget\//i },
  { weight: 25, label: 'Generic bot user-agent', pattern: /\b(bot|crawler|spider|scraper)\b/i },
];

// headers: plain object with lowercase keys (adapters normalize for you).
export function scoreBot(headers = {}, { allowlist = [] } = {}) {
  const reasons = [];
  const ua = String(headers['user-agent'] || '');

  if (ua && allowlist.some((token) => ua.toLowerCase().includes(String(token).toLowerCase()))) {
    return { score: 0, reasons: ['Allowlisted agent'] };
  }

  let uaScore = 0;
  if (!ua) {
    uaScore = 35;
    reasons.push('No User-Agent header');
  } else {
    for (const signal of UA_SIGNALS) {
      if (signal.pattern.test(ua)) {
        reasons.push(signal.label);
        uaScore = Math.max(uaScore, signal.weight);
      }
    }
  }

  let headerScore = 0;
  if (!headers['accept-language']) { headerScore += 15; reasons.push('No Accept-Language header (real browsers send one)'); }
  if (!headers['accept']) { headerScore += 10; reasons.push('No Accept header'); }
  if (Object.keys(headers).length <= 3) { headerScore += 10; reasons.push('Very few headers (real browsers send many)'); }

  const score = Math.min(100, uaScore + headerScore);
  return { score, reasons };
}

/*
 * 824 Shield — defense against AI-driven attacks.
 * Copyright (C) 2026 Nicholas Smith / 824
 *
 * This file is part of 824 Shield, free software licensed under the
 * GNU General Public License v3.0 (see the LICENSE file).
 */

// Prompt-injection / jailbreak detection.
//
// The scanner is deliberately explainable: a set of weighted rules, each
// with a human-readable label. It scores text; the Shield (guard.js)
// decides what to do with the score. It also normalizes common evasions
// (zero-width characters, leetspeak) and decodes base64-looking blobs so
// a payload cannot hide inside an encoding.

const RULES = [
  {
    id: 'ignore-instructions',
    weight: 45,
    label: 'Tells the AI to ignore its instructions',
    pattern: /ignore\s+(all\s+|the\s+)?(previous|prior|above|earlier|preceding)\s+(instructions?|prompts?|rules?|messages?)/,
  },
  {
    id: 'disregard-system',
    weight: 40,
    label: 'Tells the AI to disregard its system prompt',
    pattern: /(disregard|forget|override)\s+(the\s+|your\s+)?(system|developer)\s*(prompt|message|instructions?)?/,
  },
  {
    id: 'reveal-system-prompt',
    weight: 40,
    label: 'Tries to extract the system prompt',
    pattern: /(reveal|show|print|repeat|output|display)\s+(me\s+)?(your\s+|the\s+)?(system|initial|hidden|original)\s+(prompt|instructions?|message)/,
  },
  {
    id: 'developer-mode',
    weight: 40,
    label: 'Invokes a jailbreak or developer mode',
    pattern: /\b(developer mode|jailbreak|jailbroken|dan mode|god mode|unrestricted mode)\b/,
  },
  {
    id: 'role-escape',
    weight: 35,
    label: 'Assigns the AI an unrestricted alter ego',
    pattern: /\b(you are now|act as|pretend( to be)?|roleplay as|from now on you are)\b[^.]{0,60}\b(unrestricted|unfiltered|evil|no (rules|limits|restrictions|filters)|without (any )?(rules|limits|restrictions|filters))\b/,
  },
  {
    id: 'exfiltration',
    weight: 35,
    label: 'Tries to exfiltrate secrets or credentials',
    pattern: /\b(send|post|upload|leak|transmit)\b[^.]{0,40}\b(api[ _-]?keys?|secrets?|passwords?|credentials?|tokens?|private keys?)\b/,
  },
  {
    id: 'delimiter-smuggle',
    weight: 25,
    label: 'Smuggles chat-template delimiters',
    pattern: /(<\|[^|]{0,40}\|>|\[\/?INST\]|###\s*(system|instruction)|^\s*system\s*:\s*you are)/m,
  },
  {
    id: 'policy-bypass',
    weight: 30,
    label: 'Asks to bypass safety controls',
    pattern: /\b(bypass|circumvent|evade|disable|turn off)\b[^.]{0,30}\b(filters?|safety|guardrails?|restrictions?|polic(y|ies)|moderation)\b/,
  },
];

const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };

export function normalizeForScan(text) {
  return String(text ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // zero-width characters
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function leetVariant(text) {
  return text.replace(/[013457@$]/g, (ch) => LEET[ch] ?? ch);
}

function runRules(text) {
  const hits = [];
  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      hits.push({ id: rule.id, label: rule.label, weight: rule.weight });
    }
  }
  return hits;
}

function decodeBase64Candidates(text) {
  const decoded = [];
  const tokens = String(text).match(/[A-Za-z0-9+/=_-]{16,}/g) || [];
  for (const token of tokens.slice(0, 8)) {
    try {
      const buf = Buffer.from(token.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      if (buf.length < 8) continue;
      const str = buf.toString('utf8');
      const printable = [...str].filter((c) => c >= ' ' && c !== '\uFFFD').length;
      if (str.length > 0 && printable / str.length > 0.9) decoded.push(str);
    } catch {
      // Not base64 after all; ignore.
    }
  }
  return decoded;
}

// Scan one piece of text. Returns { score: 0..100, hits: [...] }.
export function scanText(text, { _depth = 0 } = {}) {
  const base = normalizeForScan(text);
  const byId = new Map();
  for (const variant of [base, leetVariant(base)]) {
    for (const hit of runRules(variant)) {
      if (!byId.has(hit.id)) byId.set(hit.id, hit);
    }
  }
  if (_depth === 0) {
    for (const decoded of decodeBase64Candidates(text)) {
      const inner = scanText(decoded, { _depth: 1 });
      for (const hit of inner.hits) {
        const wrapped = { ...hit, id: `base64:${hit.id}`, label: `${hit.label} (hidden in base64)` };
        if (!byId.has(wrapped.id)) byId.set(wrapped.id, wrapped);
      }
    }
  }
  const hits = [...byId.values()];
  const score = Math.min(100, hits.reduce((sum, h) => sum + h.weight, 0));
  return { score, hits };
}

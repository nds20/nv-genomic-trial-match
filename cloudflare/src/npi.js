const NPPES_API = 'https://npiregistry.cms.hhs.gov/api/';

function luhnValid(digits) {
  let sum = 0;
  let doubleDigit = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = digits.charCodeAt(i) - 48;
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

export function validateNpiFormat(npi) {
  const value = String(npi ?? '').trim();
  if (!/^\d{10}$/.test(value) || !/^[12]/.test(value)) return false;
  return luhnValid(`80840${value}`);
}

function normalizeName(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function namesRoughlyMatch(suppliedName, registryFirst, registryLast) {
  const supplied = ` ${normalizeName(suppliedName)} `;
  const first = normalizeName(registryFirst);
  const last = normalizeName(registryLast);
  if (!last) return false;
  const lastOk = supplied.includes(` ${last} `) || supplied.endsWith(` ${last}`);
  const firstOk = !first || supplied.includes(` ${first} `) || supplied.startsWith(`${first} `);
  return lastOk && firstOk;
}

export async function lookupNpi(npi, { suppliedName, fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  if (!validateNpiFormat(npi)) {
    return { status: 'invalid', detail: 'NPI fails format or check-digit validation.' };
  }
  let response;
  try {
    const url = `${NPPES_API}?version=2.1&number=${encodeURIComponent(npi)}`;
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { status: 'manual_review', detail: `NPPES lookup unreachable (${error.name || 'network error'}); queued for manual review.` };
  }
  if (!response || response.status !== 200) {
    return { status: 'manual_review', detail: `NPPES lookup returned HTTP ${response ? response.status : 'no response'}; queued for manual review.` };
  }
  let body;
  try {
    body = await response.json();
  } catch {
    return { status: 'manual_review', detail: 'NPPES lookup returned an unreadable response; queued for manual review.' };
  }
  const result = Array.isArray(body.results) ? body.results[0] : undefined;
  if (!result || result.enumeration_type === 'NPI-2') {
    return { status: 'not_found', detail: 'NPI not found in the NPPES registry as an individual provider.' };
  }
  const basic = result.basic || {};
  if (basic.status && basic.status !== 'A') {
    return { status: 'not_found', detail: 'NPI is deactivated in the NPPES registry.' };
  }
  const registryName = [basic.first_name, basic.last_name].filter(Boolean).join(' ');
  if (suppliedName && !namesRoughlyMatch(suppliedName, basic.first_name, basic.last_name)) {
    return { status: 'mismatch', detail: `Registry name "${registryName}" does not roughly match the supplied name.`, registryName };
  }
  return { status: 'verified', detail: 'NPI found in NPPES and registry name roughly matches.', registryName };
}

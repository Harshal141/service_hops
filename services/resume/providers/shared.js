// Transport and response classification shared by every provider.
// Providers never throw for expected failures: they return a result with `error_code` set.
// `error_message` and `raw` are internal (stored in ai_enrichment_call), never logged or sent.

function baseResult(provider, model) {
  return {
    ok: false, json: null, raw: null, model, provider,
    usage: { in: null, out: null, thinking: null },
    latency_ms: null, http_status: null, finish_reason: null,
    error_code: null, error_message: null,
  };
}

// fetch under an AbortController deadline that also covers reading the body.
async function timedFetch(url, init, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    const body = await res.text();
    return { status: res.status, body, latency_ms: Date.now() - t0 };
  } catch (err) {
    const latency_ms = Date.now() - t0;
    if (err.name === 'AbortError') {
      return { error_code: 'ai_timeout', error_message: `aborted after ${timeoutMs}ms`, latency_ms };
    }
    return { error_code: 'ai_unavailable', error_message: `network: ${err.cause?.code || err.message}`, latency_ms };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One JSON POST to a provider. `classify(status, bodyText, result)` turns the HTTP response into
 * the final result; transport failures (timeout, network) are classified here.
 */
async function post({ provider, model, url, headers, body, timeoutMs, classify }) {
  const out = baseResult(provider, model);
  const r = await timedFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }, timeoutMs);
  out.latency_ms = r.latency_ms;
  if (r.error_code) return { ...out, error_code: r.error_code, error_message: r.error_message };
  return classify(r.status, r.body, { ...out, http_status: r.status });
}

// HTTP status → error code. Provider-specific 400 bodies are handled by the caller first.
function classifyHttp(status) {
  if (status === 429) return 'ai_rate_limited';
  if (status === 413) return 'ai_input_too_large';
  if (status >= 500) return 'ai_unavailable';
  if (status === 401 || status === 403) return 'ai_auth';
  return 'ai_bad_request';
}

// Model text → JSON. Cut-off JSON → ai_truncated, other garbage → ai_invalid_output.
function parseModelJson(text) {
  if (text == null || text.trim() === '') return { error_code: 'ai_invalid_output', error_message: 'empty output' };
  try {
    return { json: JSON.parse(text) };
  } catch (e) {
    const t = text.trim();
    const opens = (t.match(/[{[]/g) || []).length;
    const closes = (t.match(/[}\]]/g) || []).length;
    const unterminated = opens > closes || !/[}\]]$/.test(t);
    return { error_code: unterminated ? 'ai_truncated' : 'ai_invalid_output', error_message: `json: ${e.message}` };
  }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

module.exports = { baseResult, post, classifyHttp, parseModelJson, safeJson };

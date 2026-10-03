// Gemini generateContent (plain fetch, no SDK). Auth via x-goog-api-key, which also works for
// the newer "AQ."-prefixed keys.
const { toGemini } = require('../schema');
const { post, classifyHttp, parseModelJson, safeJson } = require('./shared');

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const BLOCK_FINISH = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']);
// Gemini reports a bad or revoked key as HTTP 400, not 401/403.
const AUTH_STATUSES = new Set(['PERMISSION_DENIED', 'UNAUTHENTICATED']);

// generationConfig minus the schema; also what ai_enrichment_call.input records.
// Never also send thinkingBudget alongside thinkingLevel: the API rejects the pair with 400.
const settings = ({ maxOutputTokens }) => ({
  maxOutputTokens,
  temperature: 0,
  responseMimeType: 'application/json',
  thinkingConfig: { thinkingLevel: 'minimal' },
});

function buildBody({ system, user, schema, maxOutputTokens }) {
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { ...settings({ maxOutputTokens }), responseJsonSchema: toGemini(schema) },
  };
}

function httpErrorCode(status, err) {
  const keyInvalid = (err?.details || []).some((d) => d?.reason === 'API_KEY_INVALID');
  if (keyInvalid || AUTH_STATUSES.has(err?.status)) return 'ai_auth';
  return classifyHttp(status);
}

/** Pure: HTTP status + body text → result fields. */
function classifyResponse(status, bodyText, out) {
  const body = safeJson(bodyText);
  if (status < 200 || status >= 300) {
    return { ...out, raw: bodyText, error_code: httpErrorCode(status, body?.error), error_message: body?.error?.message || bodyText.slice(0, 500) };
  }

  const um = body?.usageMetadata || {};
  out = {
    ...out,
    model: body?.modelVersion || out.model,
    usage: { in: um.promptTokenCount ?? null, out: um.candidatesTokenCount ?? null, thinking: um.thoughtsTokenCount ?? null },
  };

  if (body?.promptFeedback?.blockReason) {
    return { ...out, raw: bodyText, error_code: 'ai_blocked', error_message: `blockReason ${body.promptFeedback.blockReason}` };
  }
  const cand = body?.candidates?.[0];
  if (!cand) return { ...out, raw: bodyText, error_code: 'ai_blocked', error_message: 'no candidates' };

  const text = (cand.content?.parts || []).filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
  out = { ...out, finish_reason: cand.finishReason || null, raw: text };

  if (BLOCK_FINISH.has(cand.finishReason)) return { ...out, error_code: 'ai_blocked', error_message: `finishReason ${cand.finishReason}` };
  if (cand.finishReason === 'MAX_TOKENS') return { ...out, error_code: 'ai_truncated', error_message: 'finishReason MAX_TOKENS' };

  const parsed = parseModelJson(text);
  if (parsed.error_code) return { ...out, ...parsed };
  return { ...out, ok: true, json: parsed.json };
}

const complete = ({ apiKey, model, timeoutMs, ...prompt }) => post({
  provider: 'gemini',
  model,
  url: `${BASE}/${encodeURIComponent(model)}:generateContent`,
  headers: { 'x-goog-api-key': apiKey },
  body: buildBody(prompt),
  timeoutMs,
  classify: classifyResponse,
});

module.exports = { complete, buildBody, classifyResponse, settings };

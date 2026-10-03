// Groq chat-completions (OpenAI-compatible REST, plain fetch). Auth via Bearer.
const { toGroq } = require('../schema');
const { post, classifyHttp, parseModelJson, safeJson } = require('./shared');

const URL = 'https://api.groq.com/openai/v1/chat/completions';

// Request fields minus model, messages and schema; also what ai_enrichment_call.input records.
const settings = ({ maxOutputTokens }) => ({
  temperature: 0,
  max_completion_tokens: maxOutputTokens,
  reasoning_effort: 'low',
});

function buildBody({ model, system, user, schema, maxOutputTokens }) {
  return {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    ...settings({ maxOutputTokens }),
    response_format: { type: 'json_schema', json_schema: { name: 'resume', strict: true, schema: toGroq(schema) } },
  };
}

/** Pure: HTTP status + body text → result fields. */
function classifyResponse(status, bodyText, out) {
  const body = safeJson(bodyText);
  if (status < 200 || status >= 300) {
    const err = body?.error || {};
    const base = { ...out, raw: bodyText, error_message: err.message || bodyText.slice(0, 500) };
    // Strict mode reports output that failed the schema as 400 json_validate_failed. In practice
    // that is truncation: "max completion tokens reached" with the cut-off JSON in
    // failed_generation, or an EMPTY failed_generation when reasoning used the whole budget.
    if (status === 400 && err.code === 'json_validate_failed') {
      return { ...base, raw: err.failed_generation ?? '', error_code: 'ai_truncated' };
    }
    return { ...base, error_code: classifyHttp(status) };
  }

  const u = body?.usage || {};
  const choice = body?.choices?.[0];
  out = {
    ...out,
    model: body?.model || out.model,
    usage: { in: u.prompt_tokens ?? null, out: u.completion_tokens ?? null, thinking: u.completion_tokens_details?.reasoning_tokens ?? null },
    finish_reason: choice?.finish_reason ?? null,
    raw: choice?.message?.content ?? null,
  };

  if (out.finish_reason === 'length') return { ...out, error_code: 'ai_truncated', error_message: 'finish_reason length' };
  if (out.finish_reason === 'content_filter') return { ...out, error_code: 'ai_blocked', error_message: 'finish_reason content_filter' };

  const parsed = parseModelJson(out.raw);
  if (parsed.error_code) return { ...out, ...parsed };
  return { ...out, ok: true, json: parsed.json };
}

const complete = ({ apiKey, model, timeoutMs, ...prompt }) => post({
  provider: 'groq',
  model,
  url: URL,
  headers: { authorization: `Bearer ${apiKey}` },
  body: buildBody({ model, ...prompt }),
  timeoutMs,
  classify: classifyResponse,
});

module.exports = { complete, buildBody, classifyResponse, settings };

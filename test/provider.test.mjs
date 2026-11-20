import assert from 'node:assert/strict'
import test from 'node:test'
import { createProvider } from '../provider.mjs'

const input = {
  max_tokens: 2200,
  system: 'Make a safe study app.',
  messages: [{ role: 'user', content: 'Draft one science flashcard.' }],
}
const model = 'fixture-model'
const endpoint = 'http://127.0.0.1:9090/test'
const signal = AbortSignal.timeout(5000)
const fixtureText = '{"status":"declined"}'
const env = { STUDY_API_URL: endpoint, STUDY_MODEL: model, STUDY_API_KEY: 'synthetic-key' }

test('OpenCode Go uses the default model and the configured conversation header', async () => {
  const custom = createProvider({ STUDY_API_KEY: 'synthetic-key' }, async (url, options) => {
    assert.equal(url.href, 'https://opencode.ai/inference/go/anthropic/v1/messages')
    assert.equal(options.headers['x-opencode-session'], 'ses_fixture')
    assert.equal(options.headers['x-api-key'], 'synthetic-key')
    assert.deepEqual(JSON.parse(options.body), {
      ...input, model: 'deepseek-v4.1-flash', stream: true, thinking: { type: 'disabled' },
    })
    return new Response('fixture stream')
  })
  assert.equal(await (await custom(input, 'ses_fixture', signal)).text(), 'fixture stream')
})

test('Messages uses a custom endpoint and adds only standard Messages fields', async () => {
  const custom = createProvider({ ...env, STUDY_PROVIDER: 'messages' }, async (url, options) => {
    assert.equal(url.href, endpoint)
    assert.equal(options.headers['anthropic-version'], '2023-06-01')
    assert.equal(options.headers['x-api-key'], 'synthetic-key')
    assert.equal(options.headers['x-opencode-session'], undefined)
    assert.deepEqual(JSON.parse(options.body), { ...input, model, stream: true })
    return new Response('fixture stream')
  })
  assert.equal(await (await custom(input, 'ses_fixture', signal)).text(), 'fixture stream')
})

test('Chat Completions supports max_completion_tokens and normalizes its text', async () => {
  const custom = createProvider({
    ...env, STUDY_PROVIDER: 'chat-completions', STUDY_CHAT_TOKEN_FIELD: 'max_completion_tokens',
  }, async (url, options) => {
    assert.equal(url.href, endpoint)
    assert.equal(options.headers.Authorization, 'Bearer synthetic-key')
    assert.deepEqual(JSON.parse(options.body), {
      model, max_completion_tokens: 2200,
      messages: [{ role: 'system', content: input.system }, ...input.messages],
    })
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: fixtureText } }] })
  })
  const response = await custom(input, 'ses_fixture', signal)
  assert.match(response.headers.get('content-type'), /text\/event-stream/)
  assert.match(await response.text(), /event: content_block_delta/)
})

test('Responses requests no storage and normalizes its completed text', async () => {
  const custom = createProvider({ ...env, STUDY_PROVIDER: 'responses' }, async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer synthetic-key')
    assert.deepEqual(JSON.parse(options.body), {
      model, max_output_tokens: 2200, instructions: input.system, input: input.messages, store: false,
    })
    return Response.json({ status: 'completed', output: [
      { type: 'reasoning' },
      { type: 'message', content: [{ type: 'output_text', text: fixtureText }] },
    ] })
  })
  assert.match(await (await custom(input, 'ses_fixture', signal)).text(), /event: message_stop/)
})

test('providers reject unexpected actions, incomplete responses, and nonlocal HTTP', async () => {
  assert.throws(() => createProvider({
    ...env, STUDY_PROVIDER: 'responses', STUDY_API_URL: 'http://example.test/v1/responses',
  }), /HTTPS/)
  const custom = createProvider({ ...env, STUDY_PROVIDER: 'chat-completions' }, async () => {
    return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{}] } }] })
  })
  await assert.rejects(() => custom(input, 'ses_fixture', signal), /did not complete/)
})

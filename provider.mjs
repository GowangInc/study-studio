import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const goEndpoint = 'https://opencode.ai/inference/go/anthropic/v1/messages'
const defaultModel = 'deepseek-v4.1-flash'
const protocols = ['opencode-go', 'messages', 'chat-completions', 'responses']

async function goKey(env) {
  if (env.OPENCODE_GO_KEY_FILE) return (await readFile(env.OPENCODE_GO_KEY_FILE, 'utf8')).trim()
  if (env.OPENCODE_GO_API_KEY) return env.OPENCODE_GO_API_KEY.trim()
  const config = env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  try {
    return (await readFile(join(config, 'study-studio', 'opencode-go.key'), 'utf8')).trim()
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const file = join(env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'opencode/auth.json')
  const credentials = JSON.parse(await readFile(file, 'utf8'))
  return credentials['opencode-go']?.key
}

async function readKey(env, protocol) {
  if (env.STUDY_API_KEY_FILE) return (await readFile(env.STUDY_API_KEY_FILE, 'utf8')).trim()
  if (env.STUDY_API_KEY) return env.STUDY_API_KEY.trim()
  if (protocol === 'opencode-go') return goKey(env)
}

function upstreamURL(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('Set STUDY_API_URL to the full model request endpoint.')
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
      url.username || url.password || url.hash) {
    throw new Error('Use an HTTPS model endpoint or a loopback HTTP endpoint, without URL credentials.')
  }
  return url
}

function harnessStream(model, text, inputTokens, outputTokens) {
  if (typeof text !== 'string' || !text.trim() || text.length > 32_000) {
    throw new Error('Model provider returned invalid study content.')
  }
  const tokens = value => Number.isSafeInteger(value) && value >= 0 ? value : 0
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', content: [],
        model, stop_reason: null, stop_sequence: null,
        usage: { input_tokens: tokens(inputTokens), output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: tokens(outputTokens) } },
    { type: 'message_stop' },
  ]
  const body = events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join('')
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
}

async function openAIResult(response, protocol, model) {
  const result = await response.json()
  if (protocol === 'responses') {
    if (result.status !== 'completed' || result.output?.some(item => !['message', 'reasoning'].includes(item.type))) {
      throw new Error('Model provider did not complete the study response.')
    }
    const text = result.output?.filter(item => item.type === 'message')
      .flatMap(item => item.content ?? [])
      .filter(part => part.type === 'output_text')
      .map(part => part.text).join('')
    return harnessStream(model, text, result.usage?.input_tokens, result.usage?.output_tokens)
  }
  const choice = result.choices?.[0]
  if (choice?.finish_reason !== 'stop' || choice.message?.tool_calls?.length || choice.message?.function_call) {
    throw new Error('Model provider did not complete the study response.')
  }
  return harnessStream(model, choice.message?.content, result.usage?.prompt_tokens, result.usage?.completion_tokens)
}

export function createProvider(env = process.env, transport = fetch) {
  const protocol = env.STUDY_PROVIDER ?? 'opencode-go'
  if (!protocols.includes(protocol)) {
    throw new Error('STUDY_PROVIDER must be one of ' + protocols.join(', '))
  }
  const go = protocol === 'opencode-go'
  const messages = go || protocol === 'messages'
  const endpoint = upstreamURL(go ? goEndpoint : env.STUDY_API_URL)
  const model = (env.STUDY_MODEL ?? (go ? defaultModel : '')).trim()
  if (!model) throw new Error('Set STUDY_MODEL to the model name used by your provider.')
  const tokenField = env.STUDY_CHAT_TOKEN_FIELD ?? 'max_tokens'
  if (protocol === 'chat-completions' && !['max_tokens', 'max_completion_tokens'].includes(tokenField)) {
    throw new Error('STUDY_CHAT_TOKEN_FIELD must be max_tokens or max_completion_tokens.')
  }

  return async ({ max_tokens, system, messages: input }, session, signal) => {
    const key = await readKey(env, protocol)
    if (go && !key) throw new Error('Missing OpenCode Go API key')
    const headers = { 'content-type': 'application/json', 'user-agent': 'study-studio/0.1' }
    if (key) headers[messages ? 'x-api-key' : 'Authorization'] = messages ? key : 'Bearer ' + key
    if (messages) headers['anthropic-version'] = '2023-06-01'
    if (go) headers['x-opencode-session'] = session

    let body
    if (messages) {
      body = { model, max_tokens, system, messages: input, stream: true }
      if (go) body.thinking = { type: 'disabled' }
    } else if (protocol === 'responses') {
      body = { model, instructions: system, input, max_output_tokens: max_tokens, store: false }
    } else {
      body = { model, messages: [{ role: 'system', content: system }, ...input], [tokenField]: max_tokens }
    }
    const response = await transport(endpoint, {
      method: 'POST', redirect: 'error', signal, headers, body: JSON.stringify(body),
    })
    if (messages || !response.ok) return response
    return openAIResult(response, protocol, model)
  }
}

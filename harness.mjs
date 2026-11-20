import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { systemPrompt } from './study.mjs'

import { createProvider } from './provider.mjs'

const installation = join(homedir(), '.local/share/study-studio/runtime')
const patch = fileURLToPath(new URL('./study-only.cordis.yml', import.meta.url))
const resolveSdk = createRequire(join(installation, 'package.json'))

function textOnly(content) {
  return typeof content === 'string' || Array.isArray(content) && content.every(
    block => block.type === 'text' && typeof block.text === 'string',
  )
}

export function makeGenerator(forward = createProvider()) {
  return async function generate({ message, current, signal, session = randomUUID() }) {
    signal.throwIfAborted()
    const { DeepSeekHarness } = await import(pathToFileURL(resolveSdk.resolve('@deepseek-ai/dsh-sdk-client')).href)
    const directory = await mkdtemp(join(tmpdir(), 'study-harness-'))
    const relayKey = randomBytes(24).toString('hex')
    const abort = new AbortController()
    const relaySignal = AbortSignal.any([signal, abort.signal])
    const input = JSON.stringify({ request: message, currentApp: current })
    let accepted = false
    let relayFailure
    const relay = createServer(async (req, res) => {
      try {
        if (req.method !== 'POST' || req.url !== '/v1/messages' || req.headers['x-api-key'] !== relayKey) {
          res.writeHead(403).end()
          return
        }
        if (accepted) {
          res.writeHead(429).end()
          return
        }
        accepted = true
        let raw = ''
        for await (const chunk of req) {
          raw += chunk
          if (raw.length > 65_536) throw new Error('Oversized harness request')
        }
        const payload = JSON.parse(raw)
        if ((payload.tools?.length ?? 0) !== 0 || payload.tool_choice ||
            !Array.isArray(payload.messages) || payload.messages.length !== 1 ||
            payload.messages[0].role !== 'user' || !textOnly(payload.messages[0].content)) {
          throw new Error('Unexpected harness tool or message')
        }
        const text = typeof payload.messages[0].content === 'string'
          ? payload.messages[0].content : payload.messages[0].content.map(block => block.text).join('')
        if (!text.includes(input)) throw new Error('Unexpected harness context')
        const upstream = await forward({
          max_tokens: 2200,
          system: systemPrompt,
          messages: [{ role: 'user', content: input }],
        }, 'ses_' + session, relaySignal)
        if (!upstream.ok || !upstream.body) {
          relayFailure = 'Model provider HTTP ' + upstream.status
          await upstream.body?.cancel()
          res.writeHead(upstream.ok ? 502 : upstream.status, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: relayFailure } }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        await pipeline(Readable.fromWeb(upstream.body), res, { signal: relaySignal })
      } catch (error) {
        relayFailure = error.message
        if (!res.headersSent) res.writeHead(502).end()
        else res.destroy()
      }
    })
    let harness
    const onAbort = () => { harness?.close().catch(() => {}) }
    try {
      const cwd = join(directory, 'workspace')
      await mkdir(cwd)
      await new Promise((resolve, reject) => {
        relay.once('error', reject)
        relay.listen(0, '127.0.0.1', resolve)
      })
      signal.throwIfAborted()
      harness = new DeepSeekHarness({
        profile: 'sdk-minimal',
        patches: [patch],
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        cwd,
        processCwd: cwd,
        dshHome: join(directory, 'home'),
        env: {
          HOME: directory,
          PATH: process.env.PATH,
          DEEPSEEK_API_KEY: relayKey,
          DEEPSEEK_BASE_URL: 'http://127.0.0.1:' + relay.address().port,
          DSH_SYSTEM_PROMPT: systemPrompt,
        },
        maxTokens: 2200,
        initializeTimeoutMs: 15_000,
        requestTimeoutMs: 40_000,
        disposeEofGraceMs: 750,
      })
      signal.addEventListener('abort', onAbort, { once: true })
      const result = await harness.run(input)
      if (relayFailure) throw new Error(relayFailure)
      if (!accepted || result.finishReason !== 'completed' && result.finishReason !== 'stop') {
        // Fail closed for interruption, provider errors, and output limits.
        throw new Error('Harness turn ended: ' + result.finishReason)
      }
      return result.finalResponse
    } finally {
      signal.removeEventListener('abort', onAbort)
      abort.abort()
      try {
        await harness?.close()
      } finally {
        relay.close()
        relay.closeAllConnections()
        await rm(directory, { recursive: true, force: true })
      }
    }
  }
}

export const generate = makeGenerator()

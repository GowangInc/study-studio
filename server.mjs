import { createServer } from 'node:http'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { readFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { StudyError, shortText, proposal, exportApp, demoDraft, moderationPrompt, reviewCategory } from './study.mjs'
import { previewProject, zipProject } from './project-files.mjs'
import { readSource, sourceFileLimit } from './sources.mjs'
import { demoProject } from './demo-project.mjs'

const engine = process.env.STUDY_ENGINE ?? (process.argv.includes('--live') ? 'live' : 'demo')
const mode = engine === 'opencode' ? 'live' : engine
if (!['demo', 'live'].includes(mode)) throw new Error('STUDY_ENGINE must be demo or live')
const host = '127.0.0.1'
const dataDir = process.env.STUDY_DATA_DIR ?? join(homedir(), '.local/share/study-studio', mode === 'live' ? 'opencode' : mode)
const port = Number(process.env.STUDY_PORT ?? 8765)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid STUDY_PORT')
const loopback = new URL('http://' + host + ':' + port)
const site = new URL(process.env.STUDY_ORIGIN ?? loopback)
if (site.href !== loopback.href && (site.protocol !== 'https:' || site.href !== site.origin + '/')) {
  throw new Error('STUDY_ORIGIN must be the HTTPS origin of the reverse proxy')
}
const cookieSecurity = site.protocol === 'https:' ? '; Secure' : ''
const code = () => randomBytes(12).toString('base64url')
const hash = value => createHash('sha256').update(value).digest('hex')
const adminCode = code()
const credentials = new Map([[hash(adminCode), { role: 'teacher' }]])
const sessions = new Map()
let window = { id: '', end: 0 }
const active = new Map()
const live = mode === 'live' ? await import('./harness.mjs') : null
mkdirSync(dataDir, { recursive: true, mode: 0o700 })
const db = new DatabaseSync(join(dataDir, 'studio.sqlite'))
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS apps (
    id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(id), filename TEXT NOT NULL, text TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reviewed_requests (
    seq INTEGER PRIMARY KEY, time TEXT NOT NULL, actor TEXT NOT NULL, project TEXT NOT NULL,
    message TEXT NOT NULL, category TEXT NOT NULL
  );
  UPDATE reviewed_requests SET category = 'needs-review' WHERE category = 'checking';
  CREATE TABLE IF NOT EXISTS activity (
    seq INTEGER PRIMARY KEY, time TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL
  );
`)
const addEvent = db.prepare('INSERT INTO activity (time, actor, action, detail) VALUES (?, ?, ?, ?)')
const log = (actor, action, detail = '') => addEvent.run(new Date().toISOString(), actor, action, detail)
const drafts = new Map()
const studentCodes = new Map()
const cookie = 'study_session'
const maxTurns = 15
const usage = new Map()
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/studio.css', ['studio.css', 'text/css; charset=utf-8']],
  ['/studio.js', ['studio.js', 'text/javascript; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
  ['/worker.js', ['worker.js', 'text/javascript; charset=utf-8']],
  ['/icon-192.png', ['icon-192.png', 'image/png']],
  ['/icon-512.png', ['icon-512.png', 'image/png']],
].map(([url, [name, type]]) => [url, [readFileSync(new URL('./public/' + name, import.meta.url)), type]]))

function studentAccess(identity) {
  if (identity.role !== 'student') throw new StudyError(403, 'Enter a student access code.')
}

function requireOpen() {
  if (Date.now() >= window.end) throw new StudyError(403, 'Your teacher has closed the ASA session.')
}

function studentProjects(owner) {
  return db.prepare('SELECT id, title FROM projects WHERE owner = ? ORDER BY rowid').all(owner).map(project => ({
    ...project,
    sources: db.prepare('SELECT id, filename FROM sources WHERE project = ? ORDER BY rowid').all(project.id),
    apps: db.prepare('SELECT id, data FROM apps WHERE project = ? ORDER BY rowid').all(project.id)
      .map(row => ({ id: row.id, ...JSON.parse(row.data) })),
  }))
}

function ownedProject(id, owner) {
  const row = db.prepare('SELECT * FROM projects WHERE id = ? AND owner = ?').get(String(id), owner)
  if (!row) throw new StudyError(404, 'Project not found.')
  return row
}

function ownedApp(id, project) {
  const row = db.prepare('SELECT data FROM apps WHERE id = ? AND project = ?').get(String(id), project)
  if (!row) throw new StudyError(404, 'Study app not found.')
  return JSON.parse(row.data)
}

async function bodyBytes(req, limit) {
  if (Number(req.headers['content-length']) > limit) throw new StudyError(413, 'Request is too large.')
  let bytes = 0
  const chunks = []
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length
    if (bytes > limit) {
      req.resume()
      throw new StudyError(413, 'Request is too large.')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function body(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new StudyError(415, 'Send JSON.')
  }
  const bytes = await bodyBytes(req, 49_152)
  try {
    const parsed = JSON.parse(bytes)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed
  } catch {
    throw new StudyError(400, 'Invalid request.')
  }
}

function selectedSources(ids, project) {
  if (ids === undefined) return []
  if (!Array.isArray(ids) || ids.length > 3 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) {
    throw new StudyError(400, 'Choose up to three sources.')
  }
  return ids.map(id => {
    const file = db.prepare('SELECT filename, text FROM sources WHERE project = ? AND id = ?').get(project, id)
    if (!file) throw new StudyError(404, 'Source not found.')
    return file
  })
}

function contextHistory(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 6) throw new StudyError(400, 'Invalid conversation history.')
  return value.map(item => {
    if (!['You', 'Study Studio'].includes(item?.role)) throw new StudyError(400, 'Invalid conversation history.')
    return { role: item.role, text: shortText(item.text, 1000, 'Earlier message') }
  })
}

function demoResponse(message, current) {
  if (/timeline|narrative order/i.test(message) || current?.kind === 'project') return demoProject()
  const result = demoDraft(message, current)
  return result.status === 'declined' ? {
    status: 'reply', message: 'You are in demo mode. Try asking for an interactive timeline, a quiz, or flashcards to see a sample.',
  } : result
}

async function draft(identity, input) {
  requireOpen()
  const owner = identity.id
  const project = ownedProject(input.project, owner)
  const message = shortText(input.message, 4000, 'Your message')
  const appId = typeof input.app === 'string' && input.app ? input.app : null
  const priorDraft = input.draft ? drafts.get(input.draft) : null
  if (input.draft && (!priorDraft || priorDraft.owner !== owner ||
      priorDraft.project !== project.id || priorDraft.appId !== appId || priorDraft.windowId !== window.id)) {
    throw new StudyError(404, 'Draft not found.')
  }
  const previous = priorDraft ? priorDraft.previous : appId ? ownedApp(appId, project.id) : null
  const current = priorDraft ? priorDraft.result : previous
  const sources = selectedSources(input.sources, project.id)
  const history = contextHistory(input.history)
  if (active.has(owner) || active.size >= 4) throw new StudyError(429, 'The builder is busy. Try again shortly.')
  if ((usage.get(owner) ?? 0) >= maxTurns) throw new StudyError(429, 'You have used your requests for this ASA session.')
  const review = db.prepare(
    'INSERT INTO reviewed_requests (time, actor, project, message, category) VALUES (?, ?, ?, ?, ?)',
  ).run(new Date().toISOString(), owner, project.title, message, 'checking').lastInsertRowid
  db.prepare('DELETE FROM reviewed_requests WHERE seq <= ?').run(Number(review) - 500)
  const updateReview = category => db.prepare('UPDATE reviewed_requests SET category = ? WHERE seq = ?').run(category, review)
  const controller = new AbortController()
  const run = { controller, id: window.id }
  active.set(owner, run)
  usage.set(owner, (usage.get(owner) ?? 0) + 1)
  const timer = setTimeout(() => controller.abort(), Math.min(window.end - Date.now(), 90_000))
  try {
    const session = hash([run.id, project.id, appId ?? 'new'].join('/')).slice(0, 32)
    let result
    if (live) {
      const moderation = live.generate({
        message, current: null, sources, session: hash(session + '-review-' + review).slice(0, 32), signal: controller.signal,
        system: moderationPrompt, maxTokens: 160,
      }).then(reviewCategory).catch(() => 'needs-review').then(updateReview)
      try {
        result = proposal(await live.generate({ message, current, sources, history, session, signal: controller.signal }))
      } finally {
        await moderation
      }
    } else {
      updateReview('demo')
      result = demoResponse(message, current)
    }
    requireOpen()
    if (run.id !== window.id || controller.signal.aborted) throw new StudyError(403, 'This ASA session ended.')
    if (result.status === 'reply') return { message: result.message }
    if (result.status === 'declined') {
      log(owner, 'Request declined')
      return { message: 'I couldn’t help with that request. Tell me more about what you want to make.' }
    }
    const id = randomUUID()
    if (priorDraft) drafts.delete(input.draft)
    drafts.set(id, { owner, windowId: window.id, project: project.id, appId, previous, result })
    return { id, draft: result, message: result.message ?? 'Try the draft in the preview. Save it when you are happy with it.' }
  } catch (error) {
    if (error instanceof StudyError && error.status === 403) throw error
    if (controller.signal.aborted && run.id !== window.id) throw new StudyError(403, 'This ASA session ended.')
    const status = error.message?.match(/^Model provider HTTP (\d{3})$/)?.[1]
    if (status) console.error('Model provider returned HTTP ' + status)
    if (error.message === 'Model provider connection failed') {
      log(owner, 'Request failed', 'Model provider connection failed')
      throw new StudyError(502, 'The model provider could not be reached. Ask your teacher to check the connection.')
    }
    log(owner, 'Request failed', 'The model did not return a usable reply')
    throw new StudyError(502, 'Study Studio could not finish your request. Try again in a moment.')
  } finally {
    clearTimeout(timer)
    if (active.get(owner) === run) active.delete(owner)
  }
}

function closeWindow() {
  window = { id: '', end: 0 }
  for (const { controller } of active.values()) controller.abort()
  drafts.clear()
  usage.clear()
}

function reply(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; frame-src 'self' blob:")
  try {
    // A same-host TLS proxy must preserve the host. Ignore forwarded authority headers.
    if (req.headers.host !== site.host) throw new StudyError(403, 'Use the Study Studio address printed in the terminal.')
    if (req.method === 'POST' && req.headers.origin !== site.origin) throw new StudyError(403, 'Open Study Studio before sending a request.')
    const url = new URL(req.url, site.origin)
    const path = url.pathname
    if (req.method === 'GET' && assets.has(path)) {
      const [contents, type] = assets.get(path)
      res.writeHead(200, { 'Content-Type': type })
      return res.end(contents)
    }
    const token = req.headers.cookie?.match(new RegExp('(?:^|; )' + cookie + '=([\\w-]+)'))?.[1]
    const identity = sessions.get(token)
    if (req.method === 'POST' && path === '/api/login') {
      const input = await body(req)
      const access = typeof input.code === 'string' && input.code.length <= 64 && credentials.get(hash(input.code.trim()))
      if (!access) throw new StudyError(401, 'That access code did not match.')
      sessions.delete(token)
      const newToken = code()
      sessions.set(newToken, access)
      res.setHeader('Set-Cookie', `${cookie}=${newToken}; HttpOnly; SameSite=Strict; Path=/${cookieSecurity}`)
      return reply(res, { role: access.role })
    }
    if (!identity) throw new StudyError(401, 'Enter your access code.')
    if (req.method === 'POST' && path === '/api/logout') {
      sessions.delete(token)
      res.setHeader('Set-Cookie', `${cookie}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${cookieSecurity}`)
      return reply(res, {})
    }
    if (req.method === 'GET' && path === '/api/state') {
      const state = { role: identity.role, end: window.end, now: Date.now(), demo: mode === 'demo' }
      if (identity.role === 'teacher') {
        state.activity = db.prepare('SELECT time, actor, action, detail FROM activity ORDER BY seq DESC LIMIT 40').all()
        state.reviews = db.prepare(
          'SELECT seq, time, actor, project, message, category FROM reviewed_requests ORDER BY seq DESC LIMIT 40',
        ).all()
        state.students = [...studentCodes].map(([id, accessCode]) => ({ id, accessCode }))
      } else {
        state.projects = studentProjects(identity.id)
      }
      return reply(res, state)
    }
    if (req.method === 'GET' && ['/api/download', '/api/preview'].includes(path)) {
      studentAccess(identity)
      const draftId = path === '/api/preview' && url.searchParams.get('draft')
      let app
      if (draftId) {
        requireOpen()
        const entry = drafts.get(draftId)
        if (!entry || entry.owner !== identity.id || entry.windowId !== window.id) {
          throw new StudyError(404, 'Draft not found.')
        }
        app = entry.result
      } else {
        const project = ownedProject(url.searchParams.get('project'), identity.id)
        app = ownedApp(url.searchParams.get('app'), project.id)
      }
      if (path === '/api/download' && app.kind === 'project') {
        res.setHeader('Content-Type', 'application/zip')
        res.setHeader('Content-Disposition', 'attachment; filename="study-studio-project.zip"')
        return res.end(zipProject(app.files))
      }
      const html = app.kind === 'project' ? previewProject(app, url.searchParams.get('file')) : exportApp(app)
      if (html === null) throw new StudyError(404, 'Project file not found.')
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Content-Security-Policy', "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'")
      if (path === '/api/download') res.setHeader('Content-Disposition', 'attachment; filename="study-app.html"')
      return res.end(html)
    }
    if (req.method !== 'POST') throw new StudyError(404, 'Page not found.')
    if (path === '/api/source/upload') {
      studentAccess(identity)
      requireOpen()
      const project = ownedProject(url.searchParams.get('project'), identity.id)
      if (req.headers['content-type'] !== 'application/octet-stream') throw new StudyError(415, 'Upload a source file.')
      const session = window.id
      const file = await readSource(url.searchParams.get('name'), await bodyBytes(req, sourceFileLimit))
      requireOpen()
      if (window.id !== session) throw new StudyError(403, 'This ASA session ended.')
      const count = db.prepare('SELECT COUNT(*) AS count FROM sources WHERE project = ?').get(project.id).count
      if (count >= 8) throw new StudyError(409, 'Remove a source before adding another.')
      const id = randomUUID()
      db.prepare('INSERT INTO sources VALUES (?, ?, ?, ?)').run(id, project.id, file.filename, file.text)
      log(identity.id, 'Added a source')
      return reply(res, { id, filename: file.filename })
    }
    const input = await body(req)
    if (path.startsWith('/api/teacher/')) {
      if (identity.role !== 'teacher') throw new StudyError(403, 'Teacher access is required.')
      if (path === '/api/teacher/open') {
        if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 120) {
          throw new StudyError(400, 'Choose between 1 and 120 minutes.')
        }
        closeWindow()
        window = { id: randomUUID(), end: Date.now() + input.minutes * 60_000 }
        log('Teacher', 'Session opened', input.minutes + ' minutes')
      } else if (path === '/api/teacher/close') {
        closeWindow()
        log('Teacher', 'Session closed')
      } else if (path === '/api/teacher/student') {
        const id = shortText(input.id, 30, 'Student label')
        if (!/^Student [1-9][0-9]?$/.test(id)) throw new StudyError(400, 'Use a label such as Student 1.')
        if (studentCodes.has(id)) throw new StudyError(409, 'That label already has a code.')
        const accessCode = code()
        studentCodes.set(id, accessCode)
        credentials.set(hash(accessCode), { id, role: 'student' })
      } else throw new StudyError(404, 'Page not found.')
      return reply(res, {})
    }
    studentAccess(identity)
    const owner = identity.id
    if (path === '/api/draft') return reply(res, await draft(identity, input))
    requireOpen()
    if (path === '/api/source/remove') {
      const project = ownedProject(input.project, owner)
      const result = db.prepare('DELETE FROM sources WHERE id = ? AND project = ?').run(String(input.id), project.id)
      if (!result.changes) throw new StudyError(404, 'Source not found.')
      return reply(res, {})
    }
    if (path === '/api/project') {
      const title = shortText(input.title, 80, 'Project name')
      const id = randomUUID()
      db.prepare('INSERT INTO projects VALUES (?, ?, ?)').run(id, owner, title)
      log(owner, 'Created a project')
      return reply(res, { id })
    }
    if (path === '/api/save') {
      const entry = drafts.get(input.id)
      if (!entry || entry.owner !== owner || entry.windowId !== window.id) throw new StudyError(404, 'Draft not found.')
      const id = entry.appId ?? randomUUID()
      if (entry.appId) {
        const current = ownedApp(id, entry.project)
        if (JSON.stringify(current) !== JSON.stringify(entry.previous)) {
          throw new StudyError(409, 'This app changed after the draft was made. Open it and try again.')
        }
        db.prepare('UPDATE apps SET data = ? WHERE id = ?').run(JSON.stringify(entry.result), id)
      } else {
        db.prepare('INSERT INTO apps VALUES (?, ?, ?)').run(id, entry.project, JSON.stringify(entry.result))
      }
      drafts.delete(input.id)
      log(owner, entry.appId ? 'Saved a revision' : 'Saved a new artifact', entry.result.kind)
      return reply(res, { id })
    }
    throw new StudyError(404, 'Page not found.')
  } catch (error) {
    if (!(error instanceof StudyError)) console.error('Study Studio request failed:', error.code ?? error.name)
    if (!res.headersSent) reply(res, { error: error instanceof StudyError ? error.message : 'Something went wrong.' }, error.status ?? 500)
  }
})

server.listen(port, host, () => console.log(`Study Studio (${mode})\n${site.origin}\nTeacher access code: ${adminCode}`))

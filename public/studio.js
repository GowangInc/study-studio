const el = id => document.getElementById(id)
let state
let projectId
let appId
let pending
let sending = false
const conversations = new Map()

async function api(path, input) {
  const response = await fetch('/api/' + path, input === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const result = await response.json()
  if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status })
  return result
}

function report(error) {
  el('notice').textContent = error.message
}

function on(id, event, action) {
  el(id).addEventListener(event, async e => {
    e.preventDefault()
    el('notice').textContent = ''
    try { await action(e) } catch (error) { report(error) }
  })
}

const active = () => state.end > Date.now()
const studentProject = () => state.projects.find(project => project.id === projectId)
const conversationKey = () => projectId + '/' + (appId ?? 'new')
const params = values => new URLSearchParams(values).toString()
function list(id, values) {
  el(id).replaceChildren(...values.map(value => {
    const item = document.createElement('li')
    item.textContent = value
    return item
  }))
}

function renderTeacher(status) {
  el('teacher-status').textContent = status
  el('close-session').disabled = !active()
  list('student-list', state.students.map(({ id, accessCode }) => id + ' · ' + accessCode))
  list('activity', state.activity.map(event => [
    new Date(event.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    event.actor, event.action, event.detail,
  ].filter(Boolean).join(' · ')))
}

function renderStudent(status) {
  el('student-status').textContent = status
  el('project-form').hidden = !active()
  if (!studentProject()) projectId = state.projects[0]?.id
  el('projects').replaceChildren(...state.projects.map(project => {
    const button = document.createElement('button')
    button.className = 'project secondary'
    button.textContent = project.title
    button.setAttribute('aria-current', String(projectId === project.id))
    button.disabled = sending
    button.onclick = () => {
      projectId = project.id
      appId = null
      pending = null
      render()
    }
    return button
  }))
  const project = studentProject()
  el('workbench').hidden = !project
  el('preview').hidden = true
  if (!project) return
  const app = project.apps.find(candidate => candidate.id === appId)
  el('project-name').textContent = project.title
  el('app-picker').replaceChildren(new Option('New study app', ''),
    ...project.apps.map(record => new Option(record.title, record.id)))
  el('app-picker').value = app?.id ?? ''
  el('app-picker').disabled = sending
  el('draft-form').hidden = !active()
  el('draft-form').querySelector('button').disabled = sending
  el('draft-form').querySelector('button').textContent = sending ? 'Making your draft…' : 'Send request'
  const history = conversations.get(conversationKey()) ?? []
  el('conversation').replaceChildren(...history.map(({ role, text }) => {
    const message = document.createElement('p')
    message.className = role === 'You' ? 'your' : ''
    const by = document.createElement('strong')
    by.textContent = role + ' '
    message.append(by, text)
    return message
  }))
  el('conversation').scrollTop = el('conversation').scrollHeight
  const draft = pending && active()
  if (!draft && !app) return
  el('preview').hidden = false
  el('preview-title').textContent = draft ? 'Draft preview' : 'Saved app'
  const query = draft ? params({ draft: pending.id }) : params({ project: project.id, app: app.id })
  const url = '/api/preview?' + query
  if (el('app-frame').getAttribute('src') !== url) el('app-frame').src = url
  el('save-app').hidden = !draft
  el('discard-app').hidden = !draft
  el('save-app').disabled = sending
  el('discard-app').disabled = sending
  el('download-app').hidden = Boolean(draft)
  if (!draft) el('download-app').href = '/api/download?' + query
}

function render() {
  const role = state?.role
  el('login').hidden = Boolean(role)
  el('signout').hidden = !role
  el('teacher').hidden = role !== 'teacher'
  el('student').hidden = role !== 'student'
  if (!role) return
  const status = (active()
    ? 'Session open until ' + new Date(state.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '.'
    : 'ASA session closed.') + (state.demo ? ' Demo mode uses a sample solar-system app.' : '')
  if (role === 'teacher') renderTeacher(status)
  else renderStudent(status)
}

async function refresh() {
  try { state = await api('state') } catch (error) {
    if (error.status !== 401) throw error
    state = undefined
  }
  render()
}

on('login-form', 'submit', async e => {
  await api('login', { code: e.target.elements.code.value })
  e.target.reset()
  await refresh()
  const target = state.role === 'teacher' ? el('minutes') : el('project-title')
  if (!target.closest('[hidden]')) target.focus()
})
on('signout', 'click', async () => {
  await api('logout', {})
  projectId = appId = pending = undefined
  conversations.clear()
  el('app-frame').removeAttribute('src')
  try { await refresh() } finally { el('code').focus() }
})
on('open-form', 'submit', async e => {
  await api('teacher/open', { minutes: e.target.elements.minutes.valueAsNumber })
  await refresh()
})
on('close-session', 'click', async () => {
  await api('teacher/close', {})
  await refresh()
})
on('student-form', 'submit', async e => {
  await api('teacher/student', { id: e.target.elements.id.value })
  e.target.reset()
  await refresh()
})
on('project-form', 'submit', async e => {
  const project = await api('project', { title: e.target.elements.title.value })
  e.target.reset()
  projectId = project.id
  appId = pending = undefined
  await refresh()
  el('message').focus()
})
on('app-picker', 'change', e => {
  appId = e.target.value || null
  pending = null
  render()
})
on('draft-form', 'submit', async e => {
  if (sending) return
  const field = e.target.elements.message
  const key = conversationKey()
  const history = conversations.get(key) ?? []
  const message = field.value.trim()
  if (!message) return
  history.push({ role: 'You', text: message })
  conversations.set(key, history)
  sending = true
  el('signout').disabled = true
  render()
  try {
    const result = await api('draft', { project: projectId, app: appId, draft: pending?.id, message })
    history.push({ role: 'Study Studio', text: result.message })
    if (result.id) pending = result
    if (field.value.trim() === message) field.value = ''
  } finally {
    sending = false
    el('signout').disabled = false
    await refresh()
  }
})
on('save-app', 'click', async () => {
  const key = conversationKey()
  const result = await api('save', { id: pending.id })
  pending = null
  appId = result.id
  if (conversations.has(key)) conversations.set(conversationKey(), conversations.get(key))
  await refresh()
  el('notice').textContent = 'Study app saved.'
})
on('discard-app', 'click', () => {
  pending = null
  render()
})
refresh().catch(report)
setInterval(() => {
  if (state && !sending) refresh().catch(report)
}, 5000)

const installButton = el('install-app')
let installPrompt
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault()
  installPrompt = event
  installButton.hidden = false
})
window.addEventListener('appinstalled', () => {
  installButton.hidden = true
})
const webInstall = typeof navigator.install === 'function'
if (webInstall && !matchMedia('(display-mode: standalone)').matches) installButton.hidden = false
on('install-app', 'click', async () => {
  if (installButton.getAttribute('aria-disabled') === 'true') return
  installButton.setAttribute('aria-disabled', 'true')
  try {
    if (webInstall) {
      await navigator.install()
      installButton.hidden = true
    } else if (installPrompt) {
      const prompt = installPrompt
      installPrompt = undefined
      await prompt.prompt()
      installButton.hidden = !installPrompt
    }
  } catch (error) {
    if (error.name !== 'AbortError') report(new Error('You can open the browser menu to install Study Studio.'))
  } finally {
    installButton.removeAttribute('aria-disabled')
  }
})
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/worker.js').catch(console.error)

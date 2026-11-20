const el = id => document.getElementById(id)
let state
let projectId
let appId
let pending
let sending = false
let previewOpen = true
let mobileView = 'chat'
let sidebarOpen = false
let previewFile
const attachedSources = new Map()
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
function updateItems(node, items, create) {
  const signature = JSON.stringify(items)
  if (node.dataset.items === signature) return false
  node.replaceChildren(...items.map(create))
  node.dataset.items = signature
  return true
}

const flagged = category => !['clear', 'checking', 'demo'].includes(category)
const reviewLabels = {
  clear: 'No flag', checking: 'Checking', demo: 'Demo', 'needs-review': 'Needs review',
  violence: 'Violence', exploitation: 'Exploitation', harassment: 'Harassment',
  'self-harm': 'Self-harm', 'cyber-abuse': 'Cyber abuse', privacy: 'Privacy', other: 'Other',
}

function renderTeacher(status) {
  el('teacher-status').textContent = status
  el('teacher-status').dataset.open = active()
  el('close-session').disabled = !active()
  updateItems(el('student-list'), state.students, ({ id, accessCode }) => {
    const item = document.createElement('li')
    item.textContent = id + ' · ' + accessCode
    return item
  })
  el('activity-empty').hidden = state.activity.length > 0
  updateItems(el('activity'), state.activity, event => {
    const item = document.createElement('li')
    const time = document.createElement('time')
    time.className = 'activity-time'
    time.dateTime = event.time
    time.textContent = new Date(event.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    item.append(time, [event.actor, event.action, event.detail].filter(Boolean).join(' · '))
    return item
  })
  const requests = el('review-flagged').checked ? state.reviews.filter(entry => flagged(entry.category)) : state.reviews
  el('review-empty').hidden = requests.length > 0
  el('review-empty').textContent = el('review-flagged').checked
    ? 'There are no flagged requests in this list.' : 'Student requests will appear here.'
  updateItems(el('review-list'), requests, entry => {
    const item = document.createElement('li')
    const details = document.createElement('details')
    const summary = document.createElement('summary')
    const category = document.createElement('span')
    category.className = flagged(entry.category) ? 'review-flag' : 'review-status'
    category.textContent = reviewLabels[entry.category] ?? 'Needs review'
    summary.append(entry.actor + ' · ' + entry.project, category)
    const prompt = document.createElement('p')
    prompt.textContent = entry.message
    details.append(summary, prompt)
    item.append(details)
    return item
  })

}

function resetPreview() {
  previewOpen = true
  mobileView = 'chat'
  previewFile = undefined
}

function selectProject(id) {
  if (projectId !== id) {
    projectId = id
    appId = pending = null
    resetPreview()
  }
  sidebarOpen = false
  render()
}

function selectApp(id) {
  appId = id || null
  pending = null
  sidebarOpen = false
  resetPreview()
  if (appId) mobileView = 'preview'
  render()
}

function renderPreview(project, app) {
  const draft = pending && active() ? pending : null
  const hasPreview = Boolean(draft || app)
  const visible = hasPreview && previewOpen
  const view = hasPreview ? mobileView : 'chat'
  const workspace = el('workspace')
  workspace.dataset.preview = visible
  workspace.dataset.view = view
  el('preview-toggle').hidden = !hasPreview
  el('preview-toggle').setAttribute('aria-expanded', String(visible))
  el('preview-toggle').textContent = visible ? 'Hide preview' : 'Show preview'
  el('workspace-tabs').hidden = !hasPreview
  el('chat-tab').setAttribute('aria-pressed', String(view === 'chat'))
  el('preview-tab').setAttribute('aria-pressed', String(view === 'preview'))
  el('preview').hidden = !hasPreview
  if (!hasPreview) return
  el('preview-title').textContent = draft ? 'Draft preview' : 'Saved app'
  const artifact = draft?.draft ?? app
  el('preview-app-name').textContent = artifact.title
  const files = artifact.files ?? []
  el('preview-file-tools').hidden = !files.length
  updateItems(el('preview-file'), files.map(file => file.path), path => new Option(path, path))
  if (!files.some(file => file.path === previewFile)) {
    previewFile = files.find(file => /(^|\/)index\.html?$/i.test(file.path))?.path
      ?? files.find(file => /\.html?$/i.test(file.path))?.path ?? files[0]?.path
  }
  if (previewFile) el('preview-file').value = previewFile
  const query = draft ? params({ draft: draft.id }) : params({ project: project.id, app: app.id })
  const url = '/api/preview?' + query + (previewFile ? '&' + params({ file: previewFile }) : '')
  if (el('app-frame').getAttribute('src') !== url) el('app-frame').src = url
  el('save-app').hidden = !draft
  el('discard-app').hidden = !draft
  el('save-app').disabled = sending
  el('discard-app').disabled = sending
  el('download-app').hidden = Boolean(draft)
  el('save-app').textContent = files.length ? 'Save files' : 'Save app'
  if (!draft) {
    el('download-app').href = '/api/download?' + query
    el('download-app').textContent = files.length ? 'Download ZIP ↓' : 'Download HTML ↓'
  }
}

function sourceSelection(project) {
  if (!attachedSources.has(project.id)) attachedSources.set(project.id, new Set())
  return attachedSources.get(project.id)
}

function renderSources(project) {
  const selected = sourceSelection(project)
  const files = project.sources ?? []
  for (const id of selected) if (!files.some(file => file.id === id)) selected.delete(id)
  el('sources-heading').textContent = selected.size ? 'Sources · ' + selected.size + ' selected' : 'Sources'
  el('source-form').hidden = !active()
  el('source-file').disabled = sending
  el('source-form').querySelector('button').disabled = sending
  updateItems(el('sources-list'), files.map(file => ({
    ...file, selected: selected.has(file.id), disabled: !active() || sending,
  })), file => {
    const item = document.createElement('li')
    const label = document.createElement('label')
    const check = document.createElement('input')
    check.type = 'checkbox'
    check.checked = file.selected
    check.disabled = file.disabled
    check.onchange = () => {
      if (check.checked && selected.size >= 3) {
        check.checked = false
        report(new Error('Choose up to three sources.'))
        return
      }
      if (check.checked) selected.add(file.id)
      else selected.delete(file.id)
      render()
    }
    label.append(check, file.filename)
    const remove = document.createElement('button')
    remove.className = 'quiet'
    remove.textContent = 'Remove'
    remove.disabled = file.disabled
    remove.setAttribute('aria-label', 'Remove ' + file.filename)
    remove.onclick = async () => {
      try {
        await api('source/remove', { project: project.id, id: file.id })
        await refresh()
      } catch (error) { report(error) }
    }
    item.append(label, remove)
    return item
  })
}

function renderStudent(status) {
  const open = active()
  el('student-status').textContent = status
  el('student-status').dataset.open = open
  el('project-form').hidden = !open
  el('workspace').dataset.sidebar = sidebarOpen
  el('workspace-menu').setAttribute('aria-expanded', String(sidebarOpen))
  if (!studentProject()) projectId = state.projects[0]?.id
  const projects = state.projects.map(project => ({
    id: project.id, title: project.title, selected: project.id === projectId, disabled: sending,
    canCreate: open, creating: !appId,
    apps: project.id === projectId ? project.apps.map(app => ({
      id: app.id, title: app.title, kind: app.kind, selected: app.id === appId,
    })) : [],
  }))
  updateItems(el('projects'), projects, project => {
    const group = document.createElement('div')
    group.className = 'project-group'
    const button = document.createElement('button')
    button.className = 'project secondary'
    const icon = document.createElement('span')
    icon.className = 'project-symbol'
    icon.setAttribute('aria-hidden', 'true')
    icon.textContent = '▱'
    const title = document.createElement('span')
    title.textContent = project.title
    button.append(icon, title)
    button.setAttribute('aria-current', String(project.selected))
    button.disabled = project.disabled
    button.onclick = () => selectProject(project.id)
    group.append(button)
    if (!project.selected) return group
    const appList = document.createElement('div')
    appList.className = 'project-apps'
    appList.setAttribute('role', 'group')
    appList.setAttribute('aria-label', 'Study apps')
    const apps = [...project.apps]
    if (project.canCreate) apps.push({
      id: '', title: 'New chat', kind: 'new', selected: project.creating,
    })
    for (const app of apps) {
      const item = document.createElement('button')
      item.className = 'project-app quiet'
      item.disabled = project.disabled
      item.setAttribute('aria-current', String(app.selected))
      if (app.kind !== 'new') {
        const label = app.title + ' · ' + (app.kind === 'quiz' ? 'Quiz' : app.kind === 'flashcards' ? 'Flashcards' : 'Project files')
        item.setAttribute('aria-label', label)
        item.title = label
      }
      const marker = document.createElement('span')
      marker.setAttribute('aria-hidden', 'true')
      marker.className = 'project-symbol'
      marker.textContent = app.kind === 'new' ? '＋' : app.kind === 'quiz' ? '?' : app.kind === 'flashcards' ? '▤' : '◇'
      const name = document.createElement('span')
      name.textContent = app.title
      item.append(marker, name)
      item.onclick = () => selectApp(app.id)
      appList.append(item)
    }
    group.append(appList)
    return group
  })
  const project = studentProject()
  el('no-project').hidden = Boolean(project)
  el('start-project').hidden = !open
  el('no-project-help').textContent = open
    ? 'Give your project a name, then ask a question or start making something.'
    : 'You can create a project when your teacher opens the session.'
  el('project-name').textContent = project?.title ?? 'Your workspace'
  el('workbench').hidden = !project
  el('app-picker').hidden = !project
  const app = project?.apps.find(candidate => candidate.id === appId)
  renderPreview(project, app)
  if (!project) return
  renderSources(project)
  updateItems(el('app-picker'), [{ title: 'New chat', id: '' }, ...project.apps.map(app => ({
    title: app.title + ' · ' + (app.kind === 'quiz' ? 'Quiz' : app.kind === 'flashcards' ? 'Flashcards' : 'Project files'), id: app.id,
  }))], app => new Option(app.title, app.id))
  el('app-picker').value = app?.id ?? ''
  el('app-picker').disabled = sending
  el('draft-form').hidden = !open
  el('draft-form').querySelector('button').disabled = sending
  el('composer-progress').textContent = sending ? 'Working on your request…' : ''
  const history = conversations.get(conversationKey()) ?? []
  el('chat-empty').hidden = history.length > 0
  el('chat-heading').textContent = !open ? 'Session closed' : app ? 'Revise this study app' : 'What would you like to work on?'
  el('chat-help').textContent = !open
    ? 'You can still open and download your saved study apps.'
    : app
      ? 'Describe what you want to change, then try the new version in the preview.'
      : 'Ask a question, use a source, or describe something you want to make.'
  el('starter-actions').hidden = !open || Boolean(app)
  const changed = updateItems(el('conversation'), history, ({ role, text }) => {
    const message = document.createElement('div')
    message.className = role === 'You' ? 'message your' : 'message'
    if (role !== 'You') {
      const mark = document.createElement('span')
      mark.className = 'brand-mark'
      mark.textContent = '✦'
      mark.setAttribute('aria-hidden', 'true')
      message.append(mark)
    }
    const copy = document.createElement('div')
    copy.className = 'message-copy'
    const by = document.createElement('strong')
    by.textContent = role
    const body = document.createElement('p')
    body.textContent = text
    copy.append(by, body)
    message.append(copy)
    return message
  })
  if (changed) el('chat-scroll').scrollTop = el('chat-scroll').scrollHeight
}

function render() {
  const role = state?.role
  el('login').hidden = Boolean(role)
  el('signout').hidden = !role
  el('teacher').hidden = role !== 'teacher'
  el('student').hidden = role !== 'student'
  el('workspace-menu').hidden = role !== 'student'
  el('role-label').hidden = !role
  el('role-label').textContent = role === 'teacher' ? 'Teacher' : 'Student workspace'
  if (!role) return
  const status = (active()
    ? 'Session open until ' + new Date(state.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '.'
    : 'ASA session closed.') + (state.demo ? ' Demo mode uses sample content.' : '')
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
  if (state.role === 'teacher') el('minutes').focus()
})
on('signout', 'click', async () => {
  await api('logout', {})
  projectId = appId = pending = undefined
  sidebarOpen = false
  resetPreview()
  conversations.clear()
  attachedSources.clear()
  el('app-frame').removeAttribute('src')
  try { await refresh() } finally { el('code').focus() }
})
on('open-form', 'submit', async e => {
  await api('teacher/open', { minutes: e.target.elements.minutes.valueAsNumber })
  await refresh()
})
on('review-flagged', 'change', () => render())
on('preview-file', 'change', event => {
  previewFile = event.target.value
  render()
})
on('source-form', 'submit', async event => {
  const project = studentProject()
  const file = event.target.elements.source.files[0]
  if (!file || !project) return
  if (file.size > 1024 * 1024) throw new Error('Use a source smaller than 1 MB.')
  const response = await fetch('/api/source/upload?' + params({ project: project.id, name: file.name }), {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error)
  const selected = sourceSelection(project)
  if (selected.size < 3) selected.add(result.id)
  event.target.reset()
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
  sidebarOpen = false
  resetPreview()
  await refresh()
  el('message').focus()
})
on('app-picker', 'change', e => selectApp(e.target.value))
on('workspace-menu', 'click', () => {
  sidebarOpen = !sidebarOpen
  render()
})
on('start-project', 'click', () => {
  sidebarOpen = true
  render()
  el('project-title').focus()
})
on('preview-toggle', 'click', () => {
  previewOpen = !previewOpen
  render()
})
on('chat-tab', 'click', () => {
  mobileView = 'chat'
  render()
})
on('preview-tab', 'click', () => {
  mobileView = 'preview'
  render()
})
for (const button of document.querySelectorAll('[data-prompt]')) {
  button.addEventListener('click', () => {
    const message = el('message')
    message.value = button.dataset.prompt
    message.focus()
  })
}
el('message').addEventListener('keydown', event => {
  if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.isComposing) return
  event.preventDefault()
  el('draft-form').requestSubmit()
})
on('draft-form', 'submit', async e => {
  if (sending) return
  const field = e.target.elements.message
  const key = conversationKey()
  const history = conversations.get(key) ?? []
  const message = field.value.trim()
  if (!message) return
  const earlier = history.slice(-6).filter(item => item.text.trim()).map(item => ({
    role: item.role, text: item.text.slice(0, 1000),
  }))
  const sources = [...sourceSelection(studentProject())]
  history.push({ role: 'You', text: message })
  conversations.set(key, history)
  sending = true
  el('signout').disabled = true
  render()
  try {
    const result = await api('draft', { project: projectId, app: appId, draft: pending?.id, message, sources, history: earlier })
    history.push({ role: 'Study Studio', text: result.message })
    if (result.id) {
      pending = result
      previewFile = undefined
      previewOpen = true
      mobileView = 'preview'
    }
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
  const savedKey = conversationKey()
  if (key !== savedKey && conversations.has(key)) {
    conversations.set(savedKey, conversations.get(key))
    conversations.delete(key)
  }
  await refresh()
  el('notice').textContent = 'Study app saved.'
})
on('discard-app', 'click', () => {
  pending = null
  if (!appId) resetPreview()
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

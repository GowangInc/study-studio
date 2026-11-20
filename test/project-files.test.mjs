import test from 'node:test'
import assert from 'node:assert/strict'
import { proposal, reviewCategory } from '../study.mjs'
import { previewProject, projectFiles, zipProject } from '../project-files.mjs'
import { readSource } from '../sources.mjs'

test('a creative draft can mix source code and other formats', () => {
  const files = [{ path: 'src/review.py', content: 'print("Review")\n' }, { path: '.gitignore', content: '*.pyc\n' }]
  const draft = proposal(JSON.stringify({ status: 'draft', kind: 'project', title: 'Review', message: 'Try it.', files }))
  assert.deepEqual(draft.files, files)
  const zip = zipProject(files)
  assert.equal(zip.readUInt32LE(0), 0x04034b50)
  assert.ok(zip.includes(Buffer.from('src/review.py')))
  assert.ok(zip.includes(Buffer.from('.gitignore')))
  assert.ok(zip.includes(Buffer.from(files[0].content)))
})

test('file paths stay inside the exported project folder', () => {
  for (const path of ['../example.txt', 'src/../file.txt', 'C:\\file.txt', '/file.txt', 'src//file.txt', 'CON.txt']) {
    assert.throws(() => projectFiles([{ path, content: 'test' }]))
  }
  assert.throws(() => projectFiles([{ path: 'src', content: '' }, { path: 'src/file.txt', content: '' }]))
  assert.throws(() => projectFiles([{ path: 'Readme.md', content: '' }, { path: 'README.md', content: '' }]))
})

test('an ordinary chat reply creates no project files and review categories are restricted', () => {
  assert.deepEqual(proposal('{"status":"reply","message":"Try ordering the evidence first."}'),
    { status: 'reply', message: 'Try ordering the evidence first.' })
  assert.equal(reviewCategory('{"category":"harassment"}'), 'harassment')
  assert.equal(reviewCategory('{"category":"custom label"}'), 'needs-review')
})

test('non-HTML files are displayed as escaped text', () => {
  const javascript = { path: 'review.js', content: '<script>example</script>' }
  const html = { path: 'index.html', content: '<h1>Test</h1>' }
  assert.equal(previewProject({ files: [javascript, html] }), html.content)
  assert.match(previewProject({ files: [javascript, html] }, javascript.path), /&lt;script&gt;example/)
  assert.equal(previewProject({ files: [javascript] }, 'not-in-project'), null)
})

test('a source accepts arbitrary UTF-8 text formats and rejects binary data', async () => {
  assert.deepEqual(await readSource('example.py', Buffer.from('print("Hello")')), {
    filename: 'example.py', text: 'print("Hello")',
  })
  await assert.rejects(() => readSource('example.bin', Buffer.from([0, 255, 0])), /UTF-8/)
  await assert.rejects(() => readSource('bad.pdf', Buffer.from('I am not a PDF')), /not a PDF/)
})

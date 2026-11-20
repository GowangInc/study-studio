import { spawn } from 'node:child_process'
import { StudyError, shortText } from './study.mjs'

export const sourceFileLimit = 1024 * 1024
export const sourceTextLimit = 12_000

function extractPDF(bytes) {
  return new Promise((resolve, reject) => {
    const child = spawn('pdftotext', ['-enc', 'UTF-8', '-nopgbrk', '-', '-'], {
      stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000, killSignal: 'SIGKILL',
      env: { PATH: process.env.PATH },
    })
    let result = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      result += chunk
      if (result.length > sourceTextLimit) child.kill('SIGKILL')
    })
    child.stdin.on('error', () => {})
    child.once('error', error => reject(new StudyError(415,
      error.code === 'ENOENT' ? 'PDF uploads need Poppler on the teacher server.' : 'Could not read this PDF.')))
    child.once('close', code => {
      if (result.length > sourceTextLimit) reject(new StudyError(413, 'This PDF has too much text. Upload a shorter excerpt.'))
      else if (code !== 0) reject(new StudyError(415, 'Use a readable PDF or a text file.'))
      else resolve(result)
    })
    child.stdin.end(bytes)
  })
}

export async function readSource(name, bytes) {
  const filename = shortText(name, 120, 'File name')
  if (/[\\/\x00-\x1f\x7f]/.test(filename)) throw new StudyError(400, 'File name is invalid.')
  const pdf = filename.toLowerCase().endsWith('.pdf')
  let text
  if (pdf) {
    if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new StudyError(415, 'This file is not a PDF.')
    text = await extractPDF(bytes)
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (/[\x00-\x08\x0e-\x1f]/.test(text)) throw new Error()
    } catch {
      throw new StudyError(415, 'Upload a UTF-8 text file or a PDF with selectable text.')
    }
  }
  text = text.trim()
  if (!text) throw new StudyError(400, 'This file has no readable text. A scanned PDF needs text recognition first.')
  if (text.length > sourceTextLimit) throw new StudyError(413, 'This source has too much text. Upload a shorter excerpt.')
  return { filename, text }
}

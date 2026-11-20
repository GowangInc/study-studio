import { crc32 } from 'node:zlib'

function filePath(value) {
  if (typeof value !== 'string' || !value.length || value.length > 120) throw new Error('Invalid file path')
  const path = value.normalize('NFC')
  const parts = path.split('/')
  if (parts.length > 8 || parts.some(part =>
    !/^[\p{L}\p{N}_. ()@+-]+$/u.test(part) || /[ .]$/.test(part) ||
    /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) {
    throw new Error('Invalid project file path')
  }
  return path
}

export function projectFiles(value) {
  if (!Array.isArray(value) || !value.length || value.length > 16) throw new Error('Invalid project files')
  const paths = new Set()
  let bytes = 0
  const files = value.map(file => {
    const path = filePath(file.path)
    const comparison = path.normalize('NFC').toLowerCase()
    if (paths.has(comparison) || typeof file.content !== 'string' || file.content.includes('\0')) {
      throw new Error('Duplicate path or invalid file content')
    }
    paths.add(comparison)
    bytes += Buffer.byteLength(file.content)
    return { path, content: file.content }
  })
  for (const path of paths) {
    const parts = path.split('/')
    for (let depth = 1; depth < parts.length; depth++) {
      if (paths.has(parts.slice(0, depth).join('/'))) throw new Error('A file cannot also be a folder')
    }
  }
  if (bytes > 48_000) throw new Error('Project file contents are too large')
  return files
}

export function previewProject(project, selectedPath) {
  const file = selectedPath ? project.files.find(item => item.path === selectedPath)
    : project.files.find(item => /(^|\/)index\.html?$/i.test(item.path))
      ?? project.files.find(item => /\.html?$/i.test(item.path))
      ?? project.files[0]
  if (!file) return null
  if (/\.html?$/i.test(file.path)) return file.content
  const escape = text => text.replace(/[&<>"']/g, char => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
  ))
  return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Project file</title><style>body{margin:0;padding:1rem;color:#262842;background:#f2f1f6}' +
    'h1{font:650 .9rem system-ui;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:white;border:1px solid #dedde6;padding:.9rem;border-radius:.65rem}</style>' +
    '<h1>' + escape(file.path) + '</h1><pre>' + escape(file.content) + '</pre></html>'
}

// ZIP stores small text files without compression. Central directory entries point to the local records.
export function zipProject(files) {
  const records = []
  const directory = []
  let offset = 0
  let directorySize = 0
  for (const file of files) {
    const name = Buffer.from(file.path)
    const data = Buffer.from(file.content)
    const checksum = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0x0021, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    local.copy(central, 6, 4, 28)
    central.writeUInt32LE(offset, 42)
    records.push(local, name, data)
    directory.push(central, name)
    offset += local.length + name.length + data.length
    directorySize += central.length + name.length
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directorySize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...records, ...directory, end])
}

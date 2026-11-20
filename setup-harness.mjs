import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const runtime = join(homedir(), '.local/share/study-studio/runtime')
mkdirSync(runtime, { recursive: true, mode: 0o700 })
const npm = process.env.npm_execpath
if (!npm) throw new Error('Run npm run setup:harness')
const result = spawnSync(process.execPath, [
  npm, 'install', '--prefix', runtime, '--save-exact', '@deepseek-ai/dsh-sdk-client@0.2.2-rc.5',
], { stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1

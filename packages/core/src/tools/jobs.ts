import { spawn, type ChildProcess } from 'node:child_process'

/** How much output a background job keeps (the tail matters most). */
const MAX_BUFFER = 1_000_000

export interface Job {
  id: string
  command: string
  startedAt: number
  child: ChildProcess
  output: string
  /** Offset into `output` up to which the agent has already seen it. */
  read: number
  exitCode: number | null
  done: boolean
}

export function killTree(pid: number | undefined) {
  if (!pid) return
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    else process.kill(-pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

const live = new Set<JobRegistry>()
let exitHook = false

/** Background shell jobs started by one agent. They outlive a turn but not the agent or the process. */
export class JobRegistry {
  private jobs = new Map<string, Job>()
  private next = 1

  constructor() {
    live.add(this)
    if (!exitHook) {
      exitHook = true
      process.on('exit', () => {
        for (const r of live) r.killAll()
      })
    }
  }

  start(command: string, spawnArgs: { cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }): Job {
    const child = spawn(spawnArgs.cmd, spawnArgs.args, {
      cwd: spawnArgs.cwd,
      env: spawnArgs.env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const job: Job = { id: `job${this.next++}`, command, startedAt: Date.now(), child, output: '', read: 0, exitCode: null, done: false }
    const onData = (b: Buffer) => {
      job.output += b.toString('utf8')
      if (job.output.length > MAX_BUFFER) {
        const drop = job.output.length - MAX_BUFFER
        job.output = job.output.slice(drop)
        job.read = Math.max(0, job.read - drop)
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (e) => {
      job.output += `\n[failed to start: ${e.message}]`
      job.done = true
    })
    child.on('close', (code) => {
      job.exitCode = code
      job.done = true
    })
    this.jobs.set(job.id, job)
    return job
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id)
  }

  list(): Job[] {
    return [...this.jobs.values()]
  }

  /** Output produced since the last call. */
  takeNew(job: Job): string {
    const out = job.output.slice(job.read)
    job.read = job.output.length
    return out
  }

  kill(id: string): boolean {
    const job = this.jobs.get(id)
    if (!job || job.done) return false
    killTree(job.child.pid)
    return true
  }

  killAll() {
    for (const j of this.jobs.values()) if (!j.done) killTree(j.child.pid)
  }

  dispose() {
    this.killAll()
    live.delete(this)
  }
}

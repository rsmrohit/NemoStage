import path from 'path'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import fs from 'fs-extra'

type AnalyzerStatus = 'idle' | 'running' | 'stopped' | 'error'

interface AnalyzerRuntime {
  presentationId: string
  sessionId: string
  timelineDir: string
  startedAtMs: number
  process: ChildProcessWithoutNullStreams
  status: AnalyzerStatus
  errorMessage: string | null
}

const runtimeByPresentationId = new Map<string, AnalyzerRuntime>()

function analyzerScriptPath(): string {
  return path.resolve(process.cwd(), '..', 'backend', 'engagement_analyzer', 'run_analyzer.py')
}

function pythonBinPath(): string {
  const venvPython = path.resolve(process.cwd(), '.tmp_docling', 'bin', 'python')
  if (fs.existsSync(venvPython)) {
    return venvPython
  }
  return 'python3'
}

export async function startEngagementAnalyzer(params: {
  presentationId: string
  sessionId: string
  timelineDir: string
}): Promise<{ status: AnalyzerStatus; outputDir: string }> {
  const existing = runtimeByPresentationId.get(params.presentationId)
  if (existing && existing.status === 'running') {
    return { status: 'running', outputDir: path.join(params.timelineDir, 'engagement') }
  }

  const scriptPath = analyzerScriptPath()
  const pythonPath = pythonBinPath()
  const outputDir = path.join(params.timelineDir, 'engagement')
  await fs.ensureDir(outputDir)
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Analyzer script not found: ${scriptPath}`)
  }

  const child = spawn(
    pythonPath,
    [
      scriptPath,
      '--video',
      '0',
      '--output',
      outputDir,
      '--bucket-seconds',
      '5',
      '--log-mode',
      'summary',
      '--summary-format',
      'production'
    ],
    {
      cwd: path.dirname(scriptPath),
      env: process.env
    }
  )

  const runtime: AnalyzerRuntime = {
    presentationId: params.presentationId,
    sessionId: params.sessionId,
    timelineDir: params.timelineDir,
    startedAtMs: Date.now(),
    process: child,
    status: 'running',
    errorMessage: null
  }

  child.stderr.on('data', (data) => {
    const text = data.toString('utf8').trim()
    if (text.length > 0) {
      runtime.errorMessage = text
    }
  })

  child.on('error', (error) => {
    runtime.status = 'error'
    runtime.errorMessage = error.message
  })

  child.on('exit', (code) => {
    if (runtime.status !== 'error') {
      runtime.status = code === 0 ? 'stopped' : 'error'
    }
  })

  runtimeByPresentationId.set(params.presentationId, runtime)
  return { status: runtime.status, outputDir }
}

export async function stopEngagementAnalyzer(presentationId: string): Promise<{ status: AnalyzerStatus }> {
  const runtime = runtimeByPresentationId.get(presentationId)
  if (!runtime) {
    return { status: 'idle' }
  }

  if (runtime.status !== 'running') {
    return { status: runtime.status }
  }

  runtime.process.kill('SIGINT')
  runtime.status = 'stopped'
  return { status: runtime.status }
}

export function getEngagementAnalyzerStatus(
  presentationId: string
): { status: AnalyzerStatus; errorMessage: string | null } {
  const runtime = runtimeByPresentationId.get(presentationId)
  if (!runtime) {
    return { status: 'idle', errorMessage: null }
  }
  return { status: runtime.status, errorMessage: runtime.errorMessage }
}

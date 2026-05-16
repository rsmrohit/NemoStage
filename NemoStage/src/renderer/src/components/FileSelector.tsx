import { useMemo, useState } from 'react'

interface FileMetadata {
  name: string
  path: string
  sizeLabel: string
  lastModified: string
}

interface FileSelectorProps {
  onSelect: (path: string) => void
}

function formatBytes(bytes: number): string {
  if (bytes === 0) {
    return '0 B'
  }

  const units = ['B', 'KB', 'MB', 'GB']
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** unitIndex
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`
}

export function FileSelector({ onSelect }: FileSelectorProps): React.JSX.Element {
  const [metadata, setMetadata] = useState<FileMetadata | null>(null)
  const [error, setError] = useState<string | null>(null)

  const dropHint = useMemo(() => {
    if (metadata) {
      return `${metadata.name} ready for extraction`
    }
    return 'Drag and drop a .pptx file here'
  }, [metadata])

  const processSelectedPath = async (filePath: string): Promise<void> => {
    if (!filePath.toLowerCase().endsWith('.pptx')) {
      setError('Please choose a .pptx file.')
      return
    }

    try {
      const stats = await window.electronAPI.getFileStats?.(filePath)
      setMetadata({
        name: filePath.split(/[\\/]/).pop() ?? filePath,
        path: filePath,
        sizeLabel: stats ? formatBytes(stats.size) : 'Unknown size',
        lastModified: stats
          ? new Date(stats.mtimeMs).toLocaleString(undefined, {
              dateStyle: 'medium',
              timeStyle: 'short'
            })
          : 'Unknown date'
      })
      setError(null)
      onSelect(filePath)
    } catch {
      setMetadata({
        name: filePath.split(/[\\/]/).pop() ?? filePath,
        path: filePath,
        sizeLabel: 'Unknown size',
        lastModified: 'Unknown date'
      })
      setError(null)
      onSelect(filePath)
    }
  }

  const handleSelect = async (): Promise<void> => {
    const filePath = await window.electronAPI.selectPPTX()
    if (!filePath) {
      return
    }

    await processSelectedPath(filePath)
  }

  const handleDrop: React.DragEventHandler<HTMLDivElement> = async (event) => {
    event.preventDefault()
    const firstFile = event.dataTransfer.files?.[0] as File & { path?: string }
    if (!firstFile?.path) {
      setError('Unable to read dropped file path.')
      return
    }

    await processSelectedPath(firstFile.path)
  }

  const handleDragOver: React.DragEventHandler<HTMLDivElement> = (event) => {
    event.preventDefault()
  }

  return (
    <section className="file-selector">
      <h1>NemoStage</h1>
      <p className="subtitle">Live Presentation Co-Pilot</p>

      <button className="primary" onClick={handleSelect} type="button">
        Select PPTX
      </button>

      <div className="drop-zone" onDragOver={handleDragOver} onDrop={handleDrop}>
        {dropHint}
      </div>

      {metadata && (
        <div className="file-metadata">
          <div>{metadata.name}</div>
          <div>{metadata.sizeLabel}</div>
          <div>{metadata.lastModified}</div>
          <div className="muted">{metadata.path}</div>
        </div>
      )}

      {error && <p className="error-text">{error}</p>}
    </section>
  )
}

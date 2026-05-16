import path from 'path'

const MEDIA_URL_HOST = 'local'

function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
  return Buffer.from(padded, 'base64').toString('utf8')
}

export function pathToMediaUrl(absolutePath: string): string {
  return `nemostage-media://${MEDIA_URL_HOST}/${encodeBase64Url(path.resolve(absolutePath))}`
}

export function mediaUrlToPath(rawUrl: string): string {
  const url = new URL(rawUrl)

  if (url.hostname === MEDIA_URL_HOST) {
    return path.normalize(decodeBase64Url(url.pathname.replace(/^\/+/, '')))
  }

  // Backward compatibility for previously emitted absolute-path URLs.
  let filePath = decodeURIComponent(url.pathname)

  if (process.platform === 'win32') {
    if (/^\/[A-Za-z]:[\\/]/.test(filePath)) {
      filePath = filePath.slice(1)
    } else if (/^[A-Za-z]$/.test(url.hostname) && filePath.startsWith('/')) {
      filePath = `${url.hostname.toUpperCase()}:/${filePath.slice(1)}`
    } else if (url.hostname) {
      filePath = `/${url.hostname}${filePath}`
    }
  } else if (url.hostname) {
    filePath = `/${url.hostname}${filePath}`
  }

  return path.normalize(filePath)
}

export function mimeTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase()
  const mimeTypes: Record<string, string> = {
    woff2: 'font/woff2',
    woff: 'font/woff',
    ttf: 'font/ttf',
    otf: 'font/otf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    svg: 'image/svg+xml',
    gif: 'image/gif'
  }

  return mimeTypes[ext] ?? 'application/octet-stream'
}

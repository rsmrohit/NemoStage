import { useEffect, useState } from 'react'
import * as QRCode from 'qrcode'

interface AudienceQrSlideProps {
  audienceUrl: string
}

export function AudienceQrSlide({ audienceUrl }: AudienceQrSlideProps): React.JSX.Element {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true

    void QRCode.toDataURL(audienceUrl, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 720,
      color: {
        dark: '#10233f',
        light: '#ffffff'
      }
    }).then((dataUrl) => {
      if (mounted) {
        setQrDataUrl(dataUrl)
      }
    })

    return () => {
      mounted = false
    }
  }, [audienceUrl])

  return (
    <div className="slide-canvas-shell">
      <section className="audience-slide-canvas" aria-label="Audience feedback QR code slide">
        <div className="audience-slide-copy">
          <p className="audience-slide-kicker">Live audience feedback</p>
          <h2>Join from your phone</h2>
          <p>Ask questions and send quick reactions during the presentation.</p>
          <div className="audience-slide-url">{audienceUrl}</div>
        </div>

        <div className="audience-slide-qr-wrap">
          {qrDataUrl ? (
            <img className="audience-slide-qr" src={qrDataUrl} alt={`QR code for ${audienceUrl}`} />
          ) : (
            <div className="audience-slide-qr-placeholder">QR</div>
          )}
        </div>
      </section>
    </div>
  )
}

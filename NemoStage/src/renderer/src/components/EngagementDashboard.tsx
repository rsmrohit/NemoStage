import { useMemo } from 'react'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  type Plugin,
  type ChartData,
  type ChartDataset,
  type ChartOptions
} from 'chart.js'
import { Line } from 'react-chartjs-2'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend)

const slideBoundaryPlugin: Plugin<'line'> = {
  id: 'slideBoundaryPlugin',
  afterDatasetsDraw(chart) {
    const pluginOptions = (chart.options.plugins as Record<string, unknown>)?.slideBoundaryPlugin as
      | { boundaries?: number[]; color?: string; dash?: number[]; width?: number }
      | undefined
    const boundaries = pluginOptions?.boundaries ?? []
    if (boundaries.length === 0) return

    const xScale = chart.scales.x
    const yScale = chart.scales.y
    if (!xScale || !yScale) return

    const ctx = chart.ctx
    ctx.save()
    ctx.strokeStyle = pluginOptions?.color ?? 'rgba(251,191,36,0.9)'
    ctx.lineWidth = pluginOptions?.width ?? 1.25
    ctx.setLineDash(pluginOptions?.dash ?? [6, 5])

    for (const boundary of boundaries) {
      const x = xScale.getPixelForValue(boundary)
      if (!Number.isFinite(x)) continue
      ctx.beginPath()
      ctx.moveTo(x, yScale.top)
      ctx.lineTo(x, yScale.bottom)
      ctx.stroke()
    }
    ctx.restore()
  }
}

ChartJS.register(slideBoundaryPlugin)

type TimelineSlideType = 'qr' | 'deck' | 'generated'

interface DashboardPoint {
  elapsedMs: number
  value: number
}

interface DashboardMemberSeries {
  memberId: string
  averageEngagementScore: number
  points: DashboardPoint[]
  intervalPoints?: DashboardPoint[]
}

interface DashboardInterval {
  intervalIndex: number
  slideLabel: string
  slideType: TimelineSlideType
  startMs: number
  endMs: number
  durationMs: number
  avgEngagement: number
  peakEngagement: number
  deltaFromPrevious: number
}

interface TimelineEntry {
  liveSlideIndex: number
  deckSlideIndex: number | null
  slideType: TimelineSlideType
  timestampMs: number
  elapsedMs: number
}

interface DashboardData {
  meta: { presentationId: string; sessionId: string; fileName: string; startedAtMs: number }
  timeline: TimelineEntry[]
  averageSeries: DashboardPoint[]
  memberSeries: DashboardMemberSeries[]
  intervals: DashboardInterval[]
  coverage?: {
    timelineMs: number
    engagementMs: number
    ratio: number
  }
}

interface EngagementDashboardProps {
  data: DashboardData | null
  selectedMemberIds: string[]
  onSelectedMemberIdsChange: (memberIds: string[]) => void
}

function msToLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r.toString().padStart(2, '0')}`
}

function valueAtElapsed(points: DashboardPoint[], targetElapsed: number): number | null {
  if (points.length === 0) return null
  let closest = points[0]
  let bestDiff = Math.abs(points[0].elapsedMs - targetElapsed)
  for (let i = 1; i < points.length; i++) {
    const diff = Math.abs(points[i].elapsedMs - targetElapsed)
    if (diff < bestDiff) {
      closest = points[i]
      bestDiff = diff
    }
  }
  return closest.value
}

export function EngagementDashboard({
  data,
  selectedMemberIds,
  onSelectedMemberIdsChange
}: EngagementDashboardProps): React.JSX.Element {
  const palette = ['#60a5fa', '#f97316', '#f472b6', '#22d3ee', '#a78bfa', '#facc15']
  const chart = useMemo(() => {
    if (!data) return null

    const avgMax = data.averageSeries.length
      ? data.averageSeries[data.averageSeries.length - 1].elapsedMs
      : 0
    const timelineMax = data.timeline.length
      ? data.timeline[data.timeline.length - 1].elapsedMs
      : 0
    const intervalMax = data.intervals.length
      ? data.intervals[data.intervals.length - 1].endMs
      : 0
    const xMin = 0
    const xMax = Math.max(avgMax, timelineMax, intervalMax, 1)

    const datasets: ChartDataset<'line', { x: number; y: number }[]>[] = [
      {
        label: 'Average Engagement',
        data: data.averageSeries.map((point) => ({ x: point.elapsedMs, y: point.value })),
        borderColor: '#34d399',
        backgroundColor: 'rgba(52,211,153,0.2)',
        pointRadius: 0,
        borderWidth: 3,
        tension: 0.25
      }
    ]

    datasets.push({
      label: 'Slide Markers',
      data: data.timeline.map((entry) => ({
        x: entry.elapsedMs,
        y: valueAtElapsed(data.averageSeries, entry.elapsedMs) ?? 0
      })),
      borderColor: 'transparent',
      backgroundColor: '#fbbf24',
      pointRadius: 3.5,
      pointHoverRadius: 5,
      showLine: false,
      order: 11
    })

    datasets.push({
      label: 'Engagement Intervals',
      data: data.averageSeries.map((point) => ({
        x: point.elapsedMs,
        y: 0.02
      })),
      borderColor: 'transparent',
      backgroundColor: '#a1a1aa',
      pointRadius: 2.5,
      pointHoverRadius: 4,
      showLine: false,
      order: 12
    })

    selectedMemberIds.forEach((memberId, index) => {
      const member = data.memberSeries.find((series) => series.memberId === memberId)
      const sourcePoints = member?.intervalPoints?.length ? member.intervalPoints : member?.points ?? []
      if (!member || sourcePoints.length === 0) return
      datasets.push({
        label: member.memberId,
        data: sourcePoints.map((point) => ({ x: point.elapsedMs, y: point.value })),
        borderColor: palette[index % palette.length],
        backgroundColor: `${palette[index % palette.length]}55`,
        pointRadius: 0,
        borderWidth: 1.8,
        tension: 0.25
      })
    })

    const chartData: ChartData<'line', { x: number; y: number }[]> = { datasets }
    const pluginOptions = {
      slideBoundaryPlugin: {
        boundaries: data.timeline.map((entry) => entry.elapsedMs),
        color: 'rgba(251,191,36,0.9)',
        dash: [6, 5],
        width: 1.25
      },
      legend: { display: true, labels: { color: '#d1d5db', boxWidth: 18 } },
      tooltip: {
        callbacks: {
          title: (items: Array<{ parsed: { x: number } }>) =>
            items.length > 0 ? msToLabel(Number(items[0].parsed.x)) : '',
          label: (context: { dataset: { label?: string }; parsed: { y: number } }) =>
            `${context.dataset.label}: ${Number(context.parsed.y).toFixed(2)}`
        }
      }
    } as ChartOptions<'line'>['plugins'] & Record<string, unknown>

    const chartOptions: ChartOptions<'line'> = {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: pluginOptions,
      scales: {
        x: {
          type: 'linear',
          min: xMin,
          max: xMax,
          ticks: {
            color: '#9ca3af',
            callback: (value) => msToLabel(Number(value))
          },
          grid: { color: 'rgba(255,255,255,0.08)' }
        },
        y: {
          min: 0,
          max: 1,
          ticks: { color: '#9ca3af' },
          grid: { color: 'rgba(255,255,255,0.08)' }
        }
      }
    }

    return { chartData, chartOptions }
  }, [data, selectedMemberIds])

  if (!data) {
    return (
      <section className="engagement-dashboard">
        <h3>Engagement Dashboard</h3>
        <p className="placeholder-text">Select a previous session to view trends.</p>
      </section>
    )
  }

  return (
    <section className="engagement-dashboard">
      <header className="engagement-dashboard-header">
        <h3>Engagement Dashboard</h3>
        <span>{new Date(data.meta.startedAtMs).toLocaleString()}</span>
      </header>
      {data.coverage && data.coverage.ratio < 0.8 && (
        <p className="warn-text">
          Low analyzer coverage: captured {Math.round(data.coverage.engagementMs / 1000)}s of{' '}
          {Math.round(data.coverage.timelineMs / 1000)}s timeline.
        </p>
      )}

      <div className="engagement-chart-shell chartjs-shell">
        {chart && <Line data={chart.chartData} options={chart.chartOptions} />}
      </div>

      <div className="engagement-member-select">
        {data.memberSeries.map((member) => {
          const checked = selectedMemberIds.includes(member.memberId)
          return (
            <label key={member.memberId}>
              <input
                type="checkbox"
                checked={checked}
                onChange={(event) => {
                  if (event.currentTarget.checked) {
                    onSelectedMemberIdsChange([...selectedMemberIds, member.memberId])
                    return
                  }
                  onSelectedMemberIdsChange(selectedMemberIds.filter((id) => id !== member.memberId))
                }}
              />
              {member.memberId}
            </label>
          )
        })}
      </div>

      <div className="engagement-interval-table">
        <table>
          <thead>
            <tr>
              <th>Slide</th>
              <th>Duration</th>
              <th>Avg</th>
              <th>Peak</th>
              <th>Delta</th>
            </tr>
          </thead>
          <tbody>
            {data.intervals.map((interval) => (
              <tr key={interval.intervalIndex}>
                <td>{interval.slideLabel}</td>
                <td>{Math.round(interval.durationMs / 1000)}s</td>
                <td>{interval.avgEngagement.toFixed(2)}</td>
                <td>{interval.peakEngagement.toFixed(2)}</td>
                <td>{interval.deltaFromPrevious.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

import https from 'https'
import http from 'http'
import { URL } from 'url'

export interface PrintJob {
  orderId: string
  orderNumber: string
  branchName: string
  tableLabel?: string
  items: { name: string; quantity: number; notes?: string; variant?: string }[]
  total: number
  createdAt: string
  copies: number
}

interface SocketOptions {
  apiKey: string
  onConnected: () => void
  onDisconnected: () => void
  onPrintJob: (job: PrintJob) => void
}

const BASE_URL = 'https://qrokan.com'

export class QrokanSocket {
  private req: http.ClientRequest | null = null
  private shouldReconnect = true
  private buffer = ''

  constructor(private opts: SocketOptions) {}

  connect() {
    this.shouldReconnect = true
    const url = new URL(`${BASE_URL}/api/agent/stream?apiKey=${this.opts.apiKey}`)

    const lib = url.protocol === 'https:' ? https : http
    this.req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
      },
      (res) => {
        if (res.statusCode === 401) {
          console.error('Geçersiz API key')
          this.opts.onDisconnected()
          return
        }

        this.opts.onConnected()
        this.buffer = ''

        res.on('data', (chunk: Buffer) => {
          this.buffer += chunk.toString()
          const lines = this.buffer.split('\n')
          this.buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const msg = JSON.parse(line.slice(6))
                if (msg.type === 'print_job') {
                  this.opts.onPrintJob(msg.job as PrintJob)
                }
              } catch {}
            }
          }
        })

        res.on('end', () => {
          if (this.shouldReconnect) {
            this.opts.onDisconnected()
            setTimeout(() => this.connect(), 10_000)
          }
        })
      }
    )

    this.req.on('error', (err) => {
      console.error('SSE error:', err.message)
      if (this.shouldReconnect) {
        this.opts.onDisconnected()
        setTimeout(() => this.connect(), 10_000)
      }
    })

    this.req.end()
  }

  disconnect() {
    this.shouldReconnect = false
    this.req?.destroy()
  }
}

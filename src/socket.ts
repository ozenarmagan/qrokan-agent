import WebSocket from 'ws'

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

const WS_URL = 'wss://qrokan.com/api/agent/ws'

export class QrokanSocket {
  private ws: WebSocket | null = null
  private shouldReconnect = true
  private pingInterval: NodeJS.Timeout | null = null

  constructor(private opts: SocketOptions) {}

  connect() {
    this.shouldReconnect = true
    this.ws = new WebSocket(`${WS_URL}?apiKey=${this.opts.apiKey}`)

    this.ws.on('open', () => {
      console.log('WebSocket connected')
      this.opts.onConnected()
      // Bağlantıyı canlı tut
      this.pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'ping' }))
        }
      }, 30_000)
    })

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'print_job') {
          this.opts.onPrintJob(msg.job as PrintJob)
        }
      } catch (e) {
        console.error('WS message parse error:', e)
      }
    })

    this.ws.on('close', () => {
      console.log('WebSocket disconnected')
      this.clearPing()
      if (this.shouldReconnect) {
        this.opts.onDisconnected()
      }
    })

    this.ws.on('error', (err) => {
      console.error('WebSocket error:', err.message)
    })
  }

  disconnect() {
    this.shouldReconnect = false
    this.clearPing()
    this.ws?.close()
  }

  private clearPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
  }
}

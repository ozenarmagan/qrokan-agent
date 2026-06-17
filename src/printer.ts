import type { PrinterInfo } from './store'
import type { PrintJob } from './socket'

// ESC/POS komutları
const ESC = 0x1b
const GS = 0x1d

function buildEscPos(job: PrintJob): Buffer {
  const lines: number[] = []

  const push = (str: string) => {
    for (const c of Buffer.from(str, 'utf-8')) lines.push(c)
  }
  const pushBytes = (...bytes: number[]) => lines.push(...bytes)

  // Init
  pushBytes(ESC, 0x40)

  // Büyük başlık — işletme / şube
  pushBytes(ESC, 0x61, 0x01)          // ortala
  pushBytes(ESC, 0x21, 0x30)          // çift boy + çift genişlik
  push(job.branchName + '\n')
  pushBytes(ESC, 0x21, 0x00)          // normal

  // Masa ve sipariş no
  if (job.tableLabel) push(job.tableLabel + '\n')
  push('#' + job.orderNumber + '\n')
  push(new Date(job.createdAt).toLocaleString('tr-TR') + '\n')

  // Ayırıcı
  pushBytes(ESC, 0x61, 0x00)          // sola hizala
  push('--------------------------------\n')

  // Ürünler
  pushBytes(ESC, 0x21, 0x08)          // bold
  for (const item of job.items) {
    const qty = `${item.quantity}x `
    const name = item.name
    // sağa qty+fiyat hizalama için basit padding
    const line = qty + name
    push(line + '\n')
    if (item.variant) push('   > ' + item.variant + '\n')
    if (item.notes) push('   Not: ' + item.notes + '\n')
  }
  pushBytes(ESC, 0x21, 0x00)          // normal

  push('--------------------------------\n')

  // Toplam
  pushBytes(ESC, 0x61, 0x02)          // sağa hizala
  pushBytes(ESC, 0x21, 0x10)          // bold
  push('TOPLAM: ' + job.total.toFixed(2) + ' TL\n')
  pushBytes(ESC, 0x21, 0x00)
  pushBytes(ESC, 0x61, 0x01)

  push('\n\n\n')

  // Kağıt kes
  pushBytes(GS, 0x56, 0x42, 0x00)

  return Buffer.from(lines)
}

export class PrinterManager {
  static async list(): Promise<PrinterInfo[]> {
    const printers: PrinterInfo[] = []

    // USB yazıcılar (node-escpos-usb varsa)
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const USB = require('escpos-usb')
      const devices = USB.findPrinter()
      for (const d of devices) {
        printers.push({
          name: `USB Yazıcı (${d.deviceDescriptor?.idVendor?.toString(16) ?? '?'}:${d.deviceDescriptor?.idProduct?.toString(16) ?? '?'})`,
          type: 'usb',
          vendorId: d.deviceDescriptor?.idVendor,
          productId: d.deviceDescriptor?.idProduct,
        })
      }
    } catch {}

    // Sistem yazıcıları (CUPS — macOS/Linux)
    try {
      const { execSync } = require('child_process')
      const out: string = execSync('lpstat -p 2>/dev/null', { encoding: 'utf-8' })
      for (const line of out.split('\n')) {
        // "PrinterName yazıcısı ..." (TR) veya "printer PrinterName ..." (EN)
        const m = line.match(/^(\S+)\s+yazıcısı/i) ?? line.match(/^printer\s+(\S+)/i)
        const sysName = m?.[1]
        if (sysName) {
          printers.push({
            name: sysName.replace(/_/g, ' '),
            type: 'system',
            systemName: sysName,
          })
        }
      }
    } catch {}

    // Manuel ağ yazıcısı (ESC/POS TCP — son seçenek)
    printers.push({
      name: 'Manuel IP (ESC/POS — 192.168.1.100:9100)',
      type: 'network',
      address: '192.168.1.100:9100',
    })

    return printers
  }

  static async print(printer: PrinterInfo, job: PrintJob): Promise<void> {
    const copies = job.copies ?? 1

    for (let i = 0; i < copies; i++) {
      if (printer.type === 'system' && printer.systemName) {
        await this.printSystem(printer.systemName, job)
      } else if (printer.type === 'network' && printer.address) {
        await this.printNetwork(printer.address, buildEscPos(job))
      } else if (printer.type === 'usb') {
        await this.printUsb(printer, buildEscPos(job))
      }
    }
  }

  private static printSystem(printerName: string, job: PrintJob): Promise<void> {
    return new Promise((resolve, reject) => {
      const { spawn } = require('child_process')
      const lines: string[] = []
      lines.push(job.branchName)
      if (job.tableLabel) lines.push(job.tableLabel)
      lines.push('#' + job.orderNumber)
      lines.push(new Date(job.createdAt).toLocaleString('tr-TR'))
      lines.push('--------------------------------')
      for (const item of job.items) {
        lines.push(`${item.quantity}x ${item.name}`)
        if (item.variant) lines.push(`   > ${item.variant}`)
        if (item.notes) lines.push(`   Not: ${item.notes}`)
      }
      lines.push('--------------------------------')
      lines.push(`TOPLAM: ${job.total.toFixed(2)} TL`)
      lines.push('')
      const text = lines.join('\n')

      const proc = spawn('lp', ['-d', printerName], { stdio: ['pipe', 'ignore', 'pipe'] })
      proc.stdin.write(text)
      proc.stdin.end()
      proc.on('close', (code: number) => {
        if (code === 0) resolve()
        else reject(new Error(`lp çıkış kodu: ${code}`))
      })
      proc.on('error', reject)
    })
  }

  private static printNetwork(address: string, data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const net = require('net')
      const [host, portStr] = address.split(':')
      const port = parseInt(portStr ?? '9100')
      const client = net.createConnection({ host, port }, () => {
        client.write(data, () => {
          client.end()
          resolve()
        })
      })
      client.on('error', reject)
      client.setTimeout(5000, () => {
        client.destroy()
        reject(new Error('Yazıcı bağlantısı zaman aşımına uğradı'))
      })
    })
  }

  private static printUsb(printer: PrinterInfo, data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const USB = require('escpos-usb')
        const device = new USB(printer.vendorId, printer.productId)
        device.open((err: Error) => {
          if (err) return reject(err)
          device.write(data, (writeErr: Error) => {
            device.close()
            if (writeErr) reject(writeErr)
            else resolve()
          })
        })
      } catch (e) {
        reject(e)
      }
    })
  }
}

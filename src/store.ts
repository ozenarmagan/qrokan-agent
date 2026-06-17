import fs from 'fs'
import path from 'path'
import { app } from 'electron'

export interface PrinterInfo {
  name: string
  type: 'usb' | 'network' | 'system'
  address?: string     // network yazıcı için IP:port
  systemName?: string  // CUPS/lpstat yazıcı adı
  vendorId?: number
  productId?: number
}

interface StoreData {
  apiKey?: string
  printer?: PrinterInfo
}

export class Store {
  private filePath: string
  private data: StoreData

  constructor() {
    const dir = app.getPath('userData')
    this.filePath = path.join(dir, 'config.json')
    this.data = this.load()
  }

  private load(): StoreData {
    try {
      if (fs.existsSync(this.filePath)) {
        return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'))
      }
    } catch {}
    return {}
  }

  private save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2))
    } catch (e) {
      console.error('Store save error:', e)
    }
  }

  get<K extends keyof StoreData>(key: K): StoreData[K] {
    return this.data[key]
  }

  set<K extends keyof StoreData>(key: K, value: StoreData[K]) {
    this.data[key] = value
    this.save()
  }
}

import { app, Tray, Menu, nativeImage, dialog, shell, BrowserWindow, ipcMain } from 'electron'
import path from 'path'
import { autoUpdater } from 'electron-updater'
import { Store } from './store'
import { PrinterManager } from './printer'
import { QrokanSocket } from './socket'

let tray: Tray | null = null
let socket: QrokanSocket | null = null
const store = new Store()

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

app.whenReady().then(async () => {
  app.setAppUserModelId('com.qrokan.agent')

  const iconPath = path.join(__dirname, '../assets/tray-icon.png')
  const icon = nativeImage.createFromPath(iconPath)
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  updateTray('disconnected')

  const apiKey = store.get('apiKey')
  if (apiKey) {
    connect(apiKey)
  } else {
    promptApiKey()
  }

  autoUpdater.checkForUpdatesAndNotify().catch(() => {})
})

app.on('window-all-closed', () => {
  // Tray uygulaması — pencere kapansa da çalışmaya devam et
})

function updateTray(status: 'connected' | 'disconnected' | 'printing') {
  if (!tray) return

  const labels = {
    connected: '🟢 Qrokan Agent — Bağlı',
    disconnected: '🔴 Qrokan Agent — Bağlantı yok',
    printing: '🖨️ Qrokan Agent — Yazdırıyor...',
  }

  const printer = store.get('printer')
  const printerLabel = printer ? `Yazıcı: ${printer.name}` : 'Yazıcı seçilmemiş'

  tray.setToolTip(labels[status])
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: labels[status], enabled: false },
    { label: printerLabel, enabled: false },
    { type: 'separator' },
    { label: 'Yazıcıyı Otomatik Tara', click: () => autoDetectPrinter() },
    { label: 'Yazıcı Seç', click: () => selectPrinter() },
    { label: 'API Anahtarını Değiştir', click: () => promptApiKey() },
    { type: 'separator' },
    { label: 'Qrokan Dashboard', click: () => shell.openExternal('https://qrokan.com/dashboard') },
    { type: 'separator' },
    { label: 'Çıkış', click: () => { socket?.disconnect(); app.quit() } },
  ]))
}

async function autoDetectPrinter(silent = false) {
  const printers = await PrinterManager.list()
  // Ağ placeholder'ını çıkar — sadece gerçek yazıcılar
  const real = printers.filter(p => !(p.type === 'network' && p.name.includes('Manuel')))

  if (real.length === 0) {
    if (!silent) {
      dialog.showMessageBox({
        type: 'warning',
        title: 'Yazıcı Bulunamadı',
        message: 'Bağlı USB veya ağ yazıcısı tespit edilemedi.',
        detail: 'Yazıcınızın açık ve bağlı olduğundan emin olun.',
      })
    }
    return
  }

  if (real.length === 1) {
    // Tek yazıcı — otomatik seç
    store.set('printer', real[0])
    updateTray('connected')
    if (!silent) {
      dialog.showMessageBox({
        type: 'info',
        title: 'Yazıcı Bulundu',
        message: `Yazıcı otomatik seçildi: ${real[0].name}`,
      })
    }
    return
  }

  // Birden fazla yazıcı — kullanıcıya sor
  await selectPrinterFromList(real)
}

async function selectPrinter() {
  const printers = await PrinterManager.list()
  if (printers.length === 0) {
    dialog.showMessageBox({
      type: 'info',
      message: 'Yazıcı bulunamadı',
      detail: 'USB veya ağ yazıcısı bağlı değil.',
    })
    return
  }
  await selectPrinterFromList(printers)
}

function selectPrinterFromList(printers: Awaited<ReturnType<typeof PrinterManager.list>>) {
  return new Promise<void>((resolve) => {
    const win = new BrowserWindow({
      width: 440,
      height: 320,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: 'Yazıcı Seç — Qrokan Agent',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    })

    const options = printers.map((p, i) =>
      `<option value="${i}">${p.name}${p.type === 'network' ? ' (Ağ)' : ' (USB)'}</option>`
    ).join('')

    win.loadURL(`data:text/html,<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:system-ui,sans-serif;padding:20px;background:#1a1a1a;color:#fff;margin:0">
<p style="margin:0 0 10px;font-size:14px;color:#aaa">Yazıcı seçin:</p>
<select id="p" style="width:100%;padding:10px;background:#2a2a2a;color:#fff;border:1px solid #444;border-radius:8px;font-size:14px;margin-bottom:16px">
${options}
</select>
<button onclick="require('electron').ipcRenderer.send('printer-select',document.getElementById('p').value)"
  style="width:100%;padding:10px;background:#7c3aed;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600">
  Seç ve Kaydet
</button>
</body></html>`)

    ipcMain.once('printer-select', (_, idx: string) => {
      win.close()
      const selected = printers[parseInt(idx)]
      store.set('printer', selected)
      updateTray('connected')
      dialog.showMessageBox({
        type: 'info',
        title: 'Yazıcı Seçildi',
        message: `✓ ${selected.name}`,
        detail: 'Bundan sonra siparişler bu yazıcıya gönderilecek.',
      })
      resolve()
    })

    win.on('closed', () => resolve())
  })
}

async function promptApiKey() {
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: 'Qrokan Agent',
    message: 'API Anahtarı Gerekli',
    detail: 'Qrokan Dashboard → Kiosk Ekranı → Yazıcı Agent bölümünden API anahtarınızı kopyalayın.',
    buttons: ['API Anahtarı Gir', 'İptal'],
    defaultId: 0,
  })

  if (response !== 0) return

  const win = new BrowserWindow({
    width: 440,
    height: 220,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Qrokan Agent — API Anahtarı',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  })

  win.loadURL(`data:text/html,<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:system-ui,sans-serif;padding:20px;background:#1a1a1a;color:#fff;margin:0">
<p style="margin:0 0 10px;font-size:14px;color:#aaa">API Anahtarınızı girin:</p>
<input id="k" type="text" autofocus
  style="width:100%;padding:10px;background:#2a2a2a;color:#fff;border:1px solid #444;border-radius:8px;font-size:13px;box-sizing:border-box;margin-bottom:16px"
  placeholder="qrk_...">
<button onclick="const k=document.getElementById('k').value.trim();if(k)require('electron').ipcRenderer.send('api-key',k)"
  style="width:100%;padding:10px;background:#7c3aed;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600">
  Bağlan
</button>
</body></html>`)

  ipcMain.once('api-key', async (_, key: string) => {
    win.close()
    store.set('apiKey', key)
    connect(key)
    // Bağlandıktan sonra yazıcıyı otomatik tara
    setTimeout(() => autoDetectPrinter(false), 2000)
  })
}

function connect(apiKey: string) {
  socket?.disconnect()
  socket = new QrokanSocket({
    apiKey,
    onConnected: () => {
      updateTray('connected')
      // İlk bağlantıda yazıcı seçili değilse otomatik tara
      if (!store.get('printer')) {
        setTimeout(() => autoDetectPrinter(false), 1500)
      }
    },
    onDisconnected: () => {
      updateTray('disconnected')
      setTimeout(() => connect(apiKey), 10_000)
    },
    onPrintJob: async (job) => {
      updateTray('printing')
      let printer = store.get('printer')

      if (!printer) {
        // Yazıcı seçili değil — otomatik tara, bulamazsan uyar
        const printers = await PrinterManager.list()
        const real = printers.filter(p => !(p.type === 'network' && p.name.includes('Manuel')))
        if (real.length === 1) {
          store.set('printer', real[0])
          printer = real[0]
        } else {
          dialog.showMessageBox({
            type: 'warning',
            title: 'Yazıcı Seçilmemiş',
            message: 'Sipariş geldi ama yazıcı seçili değil.',
            detail: 'Tray ikonuna sağ tıklayıp "Yazıcıyı Otomatik Tara" veya "Yazıcı Seç" seçeneğini kullanın.',
          })
          updateTray('connected')
          return
        }
      }

      try {
        await PrinterManager.print(printer, job)
      } catch (e: unknown) {
        console.error('Print error:', e)
        dialog.showMessageBox({
          type: 'error',
          title: 'Yazdırma Hatası',
          message: 'Sipariş yazdırılamadı.',
          detail: e instanceof Error ? e.message : 'Bilinmeyen hata',
        })
      }
      updateTray('connected')
    },
  })
  socket.connect()
}

import { app, Tray, Menu, nativeImage, dialog, shell } from 'electron'
import path from 'path'
import { autoUpdater } from 'electron-updater'
import { Store } from './store'
import { PrinterManager } from './printer'
import { QrokanSocket } from './socket'

let tray: Tray | null = null
let socket: QrokanSocket | null = null
const store = new Store()

// Windows 7 uyumluluğu için single instance lock
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.qrokan.agent')

  const icon = nativeImage.createFromPath(
    path.join(__dirname, '../assets/tray-icon.png')
  )
  tray = new Tray(icon)
  updateTray('disconnected')

  const apiKey = store.get('apiKey')
  if (apiKey) {
    connect(apiKey)
  } else {
    promptApiKey()
  }

  autoUpdater.checkForUpdatesAndNotify()
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

  tray.setToolTip(labels[status])

  const menu = Menu.buildFromTemplate([
    { label: labels[status], enabled: false },
    { type: 'separator' },
    {
      label: 'Yazıcı Seç',
      click: () => selectPrinter(),
    },
    {
      label: 'API Anahtarını Değiştir',
      click: () => promptApiKey(),
    },
    { type: 'separator' },
    {
      label: 'Qrokan Dashboard',
      click: () => shell.openExternal('https://qrokan.com/dashboard'),
    },
    { type: 'separator' },
    {
      label: 'Çıkış',
      click: () => {
        socket?.disconnect()
        app.quit()
      },
    },
  ])
  tray.setContextMenu(menu)
}

async function promptApiKey() {
  const { response, checkboxChecked } = await dialog.showMessageBox({
    type: 'question',
    title: 'Qrokan Agent',
    message: 'API Anahtarı Gerekli',
    detail: 'Qrokan dashboard\'dan Ayarlar → Agent bölümünden API anahtarınızı kopyalayın.',
    buttons: ['API Anahtarı Gir', 'İptal'],
    defaultId: 0,
  })

  if (response !== 0) return

  // Basit input dialog — electron'da native input yok, prompt penceresi açıyoruz
  const { BrowserWindow } = require('electron')
  const win = new BrowserWindow({
    width: 420,
    height: 200,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Qrokan Agent — API Anahtarı',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  })

  win.loadURL(`data:text/html,
    <html><body style="font-family:sans-serif;padding:20px;background:#1a1a1a;color:#fff">
    <p style="margin-bottom:8px">API Anahtarınızı girin:</p>
    <input id="k" type="text" style="width:100%;padding:8px;background:#333;color:#fff;border:1px solid #555;border-radius:6px;font-size:14px" placeholder="qrk_...">
    <button onclick="const k=document.getElementById('k').value;if(k){require('electron').ipcRenderer.send('api-key',k)}"
      style="margin-top:12px;width:100%;padding:8px;background:#7c3aed;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px">
      Bağlan
    </button>
    </body></html>
  `)

  const { ipcMain } = require('electron')
  ipcMain.once('api-key', (_: unknown, key: string) => {
    win.close()
    store.set('apiKey', key)
    connect(key)
  })
}

async function selectPrinter() {
  const printers = await PrinterManager.list()
  if (printers.length === 0) {
    dialog.showMessageBox({ type: 'info', message: 'Yazıcı bulunamadı', detail: 'USB veya ağ yazıcısı bağlı değil.' })
    return
  }

  const { BrowserWindow } = require('electron')
  const win = new BrowserWindow({
    width: 420,
    height: 300,
    resizable: false,
    title: 'Yazıcı Seç',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  })

  const options = printers.map((p, i) =>
    `<option value="${i}">${p.name}${p.type === 'network' ? ' (Ağ)' : ' (USB)'}</option>`
  ).join('')

  win.loadURL(`data:text/html,
    <html><body style="font-family:sans-serif;padding:20px;background:#1a1a1a;color:#fff">
    <p style="margin-bottom:8px">Yazıcı seçin:</p>
    <select id="p" style="width:100%;padding:8px;background:#333;color:#fff;border:1px solid #555;border-radius:6px;font-size:14px">
    ${options}
    </select>
    <button onclick="require('electron').ipcRenderer.send('printer-select',document.getElementById('p').value)"
      style="margin-top:12px;width:100%;padding:8px;background:#7c3aed;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px">
      Seç
    </button>
    </body></html>
  `)

  const { ipcMain } = require('electron')
  ipcMain.once('printer-select', (_: unknown, idx: string) => {
    win.close()
    const selected = printers[parseInt(idx)]
    store.set('printer', selected)
    dialog.showMessageBox({ type: 'info', message: `Yazıcı seçildi: ${selected.name}` })
  })
}

function connect(apiKey: string) {
  socket?.disconnect()
  socket = new QrokanSocket({
    apiKey,
    onConnected: () => updateTray('connected'),
    onDisconnected: () => {
      updateTray('disconnected')
      // 10 saniye sonra yeniden bağlan
      setTimeout(() => connect(apiKey), 10_000)
    },
    onPrintJob: async (job) => {
      updateTray('printing')
      const printer = store.get('printer')
      if (!printer) {
        dialog.showMessageBox({ type: 'warning', message: 'Yazıcı seçilmemiş', detail: 'Tray ikonuna sağ tıklayıp yazıcı seçin.' })
        updateTray('connected')
        return
      }
      try {
        await PrinterManager.print(printer, job)
      } catch (e: unknown) {
        console.error('Print error:', e)
      }
      updateTray('connected')
    },
  })
  socket.connect()
}

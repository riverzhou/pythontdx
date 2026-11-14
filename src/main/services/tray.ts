/** 系统托盘：关闭主窗口时隐藏而不是退出。 */
import { app, Menu, Tray, nativeImage, type BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

let tray: Tray | null = null

function trayIcon(): string | undefined {
  const candidates = [
    join(__dirname, '../../resources/icon.png'),
    join(process.resourcesPath, 'resources/icon.png'),
    join(process.resourcesPath, 'icon.png')
  ]
  return candidates.find((file) => existsSync(file))
}

export function setupTray(window: BrowserWindow): void {
  if (tray) return
  const icon = trayIcon()
  if (!icon) return
  tray = new Tray(nativeImage.createFromPath(icon))
  console.log('[tray] 托盘已创建')
  tray.setToolTip('pythontdx 行情')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示 pythontdx',
        click: () => {
          window.show()
          window.focus()
        }
      },
      {
        label: '退出',
        click: () => app.quit()
      }
    ])
  )
  tray.on('click', () => {
    window.show()
    window.focus()
  })
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}

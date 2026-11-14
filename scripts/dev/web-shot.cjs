/**
 * Web 前端截图：用 Electron 作为浏览器加载 `tdx_server --web-dir out/web`。
 * 仅开发验收使用；不参与打包，也不启动第二套数据源。
 */
const { app, BrowserWindow } = require('electron')
const { writeFile } = require('node:fs/promises')
const { join } = require('node:path')

const url = process.env.PYTHONTDX_WEB_URL || 'http://127.0.0.1:8765'
const output = process.env.PYTHONTDX_WEB_SHOT || join(process.cwd(), 'screenshots/web-latest.png')
const width = Number(process.env.PYTHONTDX_WEB_WIDTH || 1440)
const height = Number(process.env.PYTHONTDX_WEB_HEIGHT || 900)

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width,
    height,
    show: false,
    backgroundColor: '#0a0c12',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })
  await window.loadURL(url)
  await new Promise((resolve) => setTimeout(resolve, 6000))
  const image = await window.webContents.capturePage()
  await writeFile(output, image.toPNG())
  console.log(`[web-shot] ${url} -> ${output}`)
  app.quit()
}).catch((error) => {
  console.error(error)
  app.exit(1)
})

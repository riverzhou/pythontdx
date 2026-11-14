import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import solid from 'vite-plugin-solid'

/**
 * electron-vite 把三个「入口世界」分开构建：
 *   main     → Node 环境，产物 out/main/index.js（CommonJS）
 *   preload  → 沙箱桥接层，产物 out/preload/index.js
 *   renderer → 开发期由 Vite 提供（生产页面由 Python 服务托管 out/web）
 *
 * 开发时渲染层走 5173，`/api` 和 `/ws` 代理到本地 Python 服务 8765；
 * 打包后 Electron 直接加载本地服务 URL，两者是同一套 HTTP 协议。
 */
const shared = resolve(__dirname, 'src/shared')
const { version } = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as {
  version: string
}

export default defineConfig({
  main: {
    // 把 dependencies 里的包标记为 external，交给 Node 运行时 require，
    // 这样主进程代码不会被无谓地打进 bundle。
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': shared }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': shared }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': shared
      }
    },
    plugins: [solid()],
    define: {
      __APP_VERSION__: JSON.stringify(version)
    },
    server: {
      // 开发模式：渲染层与浏览器走同一个 HTTP 数据面，Vite 只做代理。
      proxy: {
        '/api': { target: 'http://127.0.0.1:8765', changeOrigin: false },
        '/ws': { target: 'ws://127.0.0.1:8765', ws: true }
      }
    },
    build: {
      // 渲染层不需要 sourcemap 进生产包，但保留 chunk 体积警告阈值
      chunkSizeWarningLimit: 1200
    }
  }
})

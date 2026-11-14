/**
 * Web 版本号不能写死。
 *
 * 回归来源：0.13.2 的 Linux 验证发现 Web 右下角仍是 `v0.7.0-web`。
 * 现在版本由构建注入，`webVersion()` 只负责格式；这里锁住格式与 package.json 一致。
 *
 * 为什么放在 `scripts/` 而不是 `src/shared/version.test.ts`：这个用例要读
 * `node:fs` / `package.json`，而 `src/shared` 会被 Web 侧 tsconfig 编译，
 * 那里没有 Node 类型。需要 Node API 的测试一律放 `scripts/` 下的 `test.mjs`，
 * vitest 两个位置都收（见 `vitest.config.ts`）。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { webVersion } from '../../src/shared/version'

describe('Web 版本号', () => {
  it('跟随 package.json 的版本，而不是写死', () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'))
    expect(webVersion(pkg.version)).toBe(`${pkg.version}-web`)
  })
})

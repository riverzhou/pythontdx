/**
 * ESLint 扁平配置（ESLint 9+ 唯一支持的格式）。
 *
 * 分工：
 *   Prettier  —— 管「长什么样」（缩进、引号、换行），不参与 ESLint；
 *   ESLint    —— 管「对不对」（未使用变量、危险写法、Solid 响应式陷阱）。
 *
 * 所以最后一项必须是 eslint-config-prettier，用它关掉所有和格式相关的规则，
 * 避免两个工具互相打架。
 */
import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import solid from 'eslint-plugin-solid'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const NODE_SIDE = [
  'src/main/**/*.ts',
  'src/preload/**/*.ts',
  'src/shared/**/*.ts',
  'scripts/**/*.mjs',
  '*.ts',
  '*.mjs'
]
const RENDERER = ['src/renderer/**/*.{ts,tsx}']
const TESTS = ['src/**/*.test.ts']

const solidTypeScript = solid.configs['flat/typescript']

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'release/**',
      'node_modules/**',
      'screenshots/**',
      '.tmp/**',
      'build/**',
      'resources/**',
      'scripts/**/*.cjs',
      'package-lock.json'
    ]
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  /* ------------------------------------------------------ 主进程 / 共享层 */
  {
    files: NODE_SIDE,
    languageOptions: {
      globals: { ...globals.node }
    },
    rules: {
      // 主进程里 console 是唯一的日志出口，dev 诊断也依赖它
      'no-console': 'off'
    }
  },

  /* ---------------------------------------------------------- 渲染进程 */
  {
    files: RENDERER,
    ...solidTypeScript
  },
  {
    files: RENDERER,
    languageOptions: {
      ...(solidTypeScript.languageOptions ?? {}),
      globals: { ...globals.browser }
    },
    rules: {
      // Solid 的响应式陷阱是渲染层最容易犯的错，这些规则全部当错误处理
      'solid/reactivity': 'error',
      'solid/no-destructure': 'error',
      'solid/jsx-no-duplicate-props': 'error',
      // 图表里大量使用 SVG 属性，class 名也走 CSS 变量，交给 Prettier 就够
      'solid/style-prop': 'off'
    }
  },

  /* -------------------------------------------------------------- 测试 */
  {
    files: TESTS,
    languageOptions: {
      globals: { ...globals.node }
    },
    rules: {
      // fixture 里保留大量「看起来没用」的字段，正是为了验证解析器的容错
      '@typescript-eslint/no-unused-vars': 'off'
    }
  },

  // 必须放最后：关掉所有与 Prettier 冲突的格式化规则
  prettier
)

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/client', () => ({
  api: {},
  shell: {
    info: async () => ({ platform: 'web', version: 'test' }),
    state: { patch: async () => undefined }
  },
  errorMessage: (error: unknown) => String(error)
}))

import {
  activeView,
  closePopup,
  closeView,
  openPopup,
  openView,
  popup,
  resetWorkspace,
  tabs,
  togglePopup
} from './workspace'

beforeEach(() => resetWorkspace())

describe('主工作区标签', () => {
  it('打开视图只加一次标签，并激活它', () => {
    openView('ranking')
    openView('market')
    openView('ranking')
    expect(tabs()).toEqual(['chart', 'ranking', 'market'])
    expect(activeView()).toBe('ranking')
  })

  it('关闭当前标签回到左侧标签，全部关闭回到行情', () => {
    openView('ranking')
    openView('market')
    closeView('market')
    expect(activeView()).toBe('ranking')
    closeView('ranking')
    expect(tabs()).toEqual(['chart'])
    expect(activeView()).toBe('chart')
  })

  it('关闭非当前标签不改变当前视图', () => {
    openView('ranking')
    openView('market')
    closeView('ranking')
    expect(activeView()).toBe('market')
    expect(tabs()).toEqual(['chart', 'market'])
  })

  it('弹窗一次只保留一个，重复点击同一入口会关闭', () => {
    openPopup('settings')
    expect(popup()).toBe('settings')
    openPopup('data')
    expect(popup()).toBe('data')
    togglePopup('data')
    expect(popup()).toBeNull()
    closePopup()
    expect(popup()).toBeNull()
  })
})

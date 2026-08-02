import { expect, test } from 'vitest'
import { SETTINGS_KEY, loadSettings, saveSettings } from './settings.ts'
import { fakeStorage } from './testStorage.ts'

test('settings round-trip; the default is Draw 3', () => {
  const storage = fakeStorage()
  expect(loadSettings(storage)).toEqual({ drawCount: 3 })
  saveSettings(storage, { drawCount: 1 })
  expect(loadSettings(storage)).toEqual({ drawCount: 1 })
})

test('damaged or throwing storage falls back to the default', () => {
  for (const raw of ['garbage', '[]', '{"drawCount":2}', '{"drawCount":"3"}']) {
    const storage = fakeStorage()
    storage.setItem(SETTINGS_KEY, raw)
    expect(loadSettings(storage), raw).toEqual({ drawCount: 3 })
  }
  const throwing = {
    getItem: () => {
      throw new Error('disabled')
    },
    setItem: () => {
      throw new Error('disabled')
    },
    removeItem: () => {},
  }
  expect(loadSettings(throwing)).toEqual({ drawCount: 3 })
  expect(() => saveSettings(throwing, { drawCount: 1 })).not.toThrow()
})

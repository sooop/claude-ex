// 사용자 설정(chrome.storage.local). 현재는 AI 품질(tier) 하나다.
import { TIERS, type Tier } from '@/lib/messages'

const KEY = 'settings.tier'
const DEFAULT_TIER: Tier = 'normal'

export const isTier = (x: unknown): x is Tier => typeof x === 'string' && (TIERS as readonly string[]).includes(x)

export async function getTier(): Promise<Tier> {
  try {
    const v = (await chrome.storage.local.get(KEY))[KEY]
    return isTier(v) ? v : DEFAULT_TIER
  } catch {
    return DEFAULT_TIER
  }
}

export async function setTier(tier: Tier): Promise<void> {
  await chrome.storage.local.set({ [KEY]: tier })
}

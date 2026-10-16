import { getPageCache, putPageCache, prunePageCache } from '@/lib/db'
import { fetchZipcdList } from '@/lib/epost'
import { fetchJusoList, normalizeJusoPage } from '@/lib/juso'
import { normalizePage } from '@/lib/normalize'
import { withPageCache, type PageStore } from '@/lib/pageCache'
import type { Fetchers } from '@/lib/provider'
import { setBlocked } from './badge'

/** 조회처별 "가져오기 + 정규화". 네트워크를 직접 부른다 */
const rawFetchers: Fetchers = {
  epost: async (keyword, pageIdx, pageSize, signal) =>
    normalizePage(await fetchZipcdList(keyword, pageIdx, pageSize, signal), pageIdx, pageSize),
  juso: async (keyword, pageIdx, pageSize, signal) =>
    normalizeJusoPage(await fetchJusoList(keyword, pageIdx, pageSize, signal), pageIdx, pageSize),
}

let puts = 0
const store: PageStore = {
  get: async (key) => getPageCache(key),
  put: async (key, page, at) => {
    await putPageCache({ key, page, at })
    if (++puts % 25 === 0) await prunePageCache().catch(() => undefined)
  },
}

/** 팝업 검색과 앱 lookup 이 함께 쓰는 단일 조회 계층: 응답 캐시(24시간) + 차단 감지(배지) */
export const fetchers: Fetchers = withPageCache(rawFetchers, store, { onBlocked: setBlocked })

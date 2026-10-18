import type { PopupEvent, PopupRequest } from '../lib/messages'

/** 서비스 워커로 요청을 보내고 응답을 기다린다. lastError/undefined 응답이면 reject. */
export function send<T>(req: PopupRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    chrome.runtime.sendMessage(req, (res: T | undefined) => {
      const err = chrome.runtime.lastError
      if (err) {
        reject(new Error(err.message ?? '메시지 전송 실패'))
        return
      }
      if (res === undefined) {
        reject(new Error('서비스 워커 응답 없음'))
        return
      }
      resolve(res)
    })
  })
}

/** 서비스 워커 브로드캐스트 구독. jobUpdate|statusChanged|pluginsChanged 만 전달하고, 해제 함수를 반환한다. */
export function onEvent(fn: (e: PopupEvent) => void): () => void {
  const listener = (msg: unknown) => {
    if (typeof msg !== 'object' || msg === null) return
    const kind = (msg as { kind?: unknown }).kind
    if (kind === 'jobUpdate' || kind === 'statusChanged' || kind === 'pluginsChanged') fn(msg as PopupEvent)
  }
  chrome.runtime.onMessage.addListener(listener)
  return () => chrome.runtime.onMessage.removeListener(listener)
}

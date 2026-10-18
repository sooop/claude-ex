// 확장 아이콘 생성: Lucide 아이콘 + 배경으로 public/icons/icon{16,32,48,128}.png 와 icon.svg 를 만든다.
// 설정은 아이콘 고르기 페이지(claude-ex 아이콘 고르기 아티팩트)의 "설정 복사" 값이고, 합성 규칙도 그 페이지와 같다.
import { mkdirSync, writeFileSync } from 'node:fs'
import { Resvg } from '@resvg/resvg-js'
import { icons } from 'lucide'

const CFG = { icon: 'Bot', shape: 'squircle', fg: '#ffffff', bg: '#d9622b', stroke: 2, scale: 82 }
const SIZES = [16, 32, 48, 128]
const OUT = 'public/icons'

const node = icons[CFG.icon]
if (!node) throw new Error(`Lucide 아이콘 없음: ${CFG.icon}`)
const kids = node[0] === 'svg' ? node[2] : node

const attrs = (o) => Object.entries(o).filter(([k]) => k !== 'key').map(([k, v]) => `${k}="${v}"`).join(' ')

function compose(c) {
  const bgShape =
    c.shape === 'circle' ? `<circle cx="64" cy="64" r="64" fill="${c.bg}"/>`
    : c.shape === 'squircle' ? `<rect x="0" y="0" width="128" height="128" rx="30" fill="${c.bg}"/>`
    : c.shape === 'square' ? `<rect x="0" y="0" width="128" height="128" rx="6" fill="${c.bg}"/>`
    : ''
  const size = (128 * (c.shape === 'none' ? Math.min(100, c.scale + 16) : c.scale)) / 100
  const off = (128 - size) / 2
  const stroke = c.shape === 'none' ? c.bg : c.fg
  const body = kids.map(([tag, a]) => `<${tag} ${attrs(a)}/>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">${bgShape}` +
    `<svg x="${off}" y="${off}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" ` +
    `stroke-width="${c.stroke}" stroke-linecap="round" stroke-linejoin="round">${body}</svg></svg>`
}

mkdirSync(OUT, { recursive: true })
const svg = compose(CFG)
writeFileSync(`${OUT}/icon.svg`, svg)
for (const px of SIZES) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: px } }).render().asPng()
  writeFileSync(`${OUT}/icon${px}.png`, png)
}
console.log(`아이콘 ${SIZES.join(', ')}px → ${OUT}`)

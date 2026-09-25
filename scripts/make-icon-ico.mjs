/**
 * Writes build/icon.ico from build/icon.png. Run with Electron, whose nativeImage does the
 * resizing, so this needs no image library:
 *
 *   npx electron scripts/make-icon-ico.mjs
 *
 * Why a hand-made .ico: given a PNG, electron-builder generates an .ico whose every image,
 * 16x16 included, is PNG-compressed. Windows reads PNG-compressed icon images reliably only
 * at 256x256. The shell paths that load the small sizes (the taskbar button resolved through
 * the Start-menu shortcut, the shortcut itself) can fail on them and show a blank placeholder.
 * That's what 0.4.2 and 0.5.0 showed in the taskbar, even though the window's own title-bar
 * icon, which Electron draws from the PNG, was fine. So the small sizes here are classic
 * uncompressed 32-bit bitmaps, and only 256x256 is PNG, which is the layout Windows' own icons use.
 */
import { app, nativeImage } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(root, 'build', 'icon.png')
const TARGET = join(root, 'build', 'icon.ico')
/** Every size the Windows shell asks for across 100–200% scaling, plus the 256 PNG. */
const BITMAP_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128]

/**
 * nativeImage#toBitmap() hands back Skia's native order, which is BGRA on every little-endian
 * machine, the same order a DIB wants. Checked, not assumed: a solid red 1x1 image must come
 * back as 00 00 FF FF.
 */
function assertBgra() {
  const red = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
  )
  const px = [...red.toBitmap().subarray(0, 4)]
  if (px.join() !== '0,0,255,255') throw new Error(`unexpected bitmap byte order: ${px}`)
}

/** One 32bpp DIB icon image: BITMAPINFOHEADER, bottom-up BGRA rows, then an all-zero AND mask. */
function dib(image, size) {
  const bgra = image.resize({ width: size, height: size, quality: 'best' }).toBitmap()
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0) // biSize
  header.writeInt32LE(size, 4) // biWidth
  header.writeInt32LE(size * 2, 8) // biHeight: XOR bitmap plus AND mask, per the ICO format
  header.writeUInt16LE(1, 12) // biPlanes
  header.writeUInt16LE(32, 14) // biBitCount
  const row = size * 4
  const pixels = Buffer.alloc(row * size)
  for (let y = 0; y < size; y++) bgra.copy(pixels, (size - 1 - y) * row, y * row, (y + 1) * row)
  const maskRow = Math.ceil(size / 32) * 4 // rows are 32-bit aligned; alpha does the masking
  header.writeUInt32LE(pixels.length + maskRow * size, 20) // biSizeImage
  return Buffer.concat([header, pixels, Buffer.alloc(maskRow * size)])
}

app.whenReady().then(() => {
  try {
    build()
  } catch (e) {
    console.error(e)
    app.exit(1)
    return
  }
  app.exit(0)
})

function build() {
  assertBgra()
  const source = nativeImage.createFromBuffer(readFileSync(SOURCE))
  const { width, height } = source.getSize()
  if (width < 256 || height < 256) throw new Error(`build/icon.png must be at least 256x256, is ${width}x${height}`)

  const images = [
    ...BITMAP_SIZES.map((size) => ({ size, data: dib(source, size) })),
    { size: 256, data: source.resize({ width: 256, height: 256, quality: 'best' }).toPNG() }
  ]

  const dir = Buffer.alloc(6 + 16 * images.length)
  dir.writeUInt16LE(0, 0) // reserved
  dir.writeUInt16LE(1, 2) // type: icon
  dir.writeUInt16LE(images.length, 4)
  let offset = dir.length
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i
    dir.writeUInt8(size === 256 ? 0 : size, e) // 0 means 256
    dir.writeUInt8(size === 256 ? 0 : size, e + 1)
    dir.writeUInt16LE(1, e + 4) // planes
    dir.writeUInt16LE(32, e + 6) // bits per pixel
    dir.writeUInt32LE(data.length, e + 8)
    dir.writeUInt32LE(offset, e + 12)
    offset += data.length
  })

  writeFileSync(TARGET, Buffer.concat([dir, ...images.map((i) => i.data)]))
  console.log(`wrote ${TARGET} (${images.map((i) => i.size).join(', ')})`)
}

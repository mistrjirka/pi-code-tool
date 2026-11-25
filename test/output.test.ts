import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CodeOutput, OUTPUT_PREVIEW_BYTES, readCodeOutput } from '../src/pi/output.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'code-output-'))
  directories.push(path)
  return path
}

describe('bounded code output', () => {
  it('keeps small output exact and large output recoverable with its error tail', async () => {
    const path = await directory()
    const small = new CodeOutput(path)
    small.append('hello\n')
    expect(small.finish('code')).toEqual({ text: 'hello\n' })
    const capture = new CodeOutput(path)
    const text = 'BEGIN\n' + '🙂 data\n'.repeat(20_000) + 'FAIL: useful final error'
    for (let offset = 0; offset < text.length; offset += 1000) capture.append(text.slice(offset, offset + 1000))
    const result = capture.finish('code')
    expect(Buffer.byteLength(result.text)).toBeLessThan(8192)
    expect(result.text).toContain('BEGIN')
    expect(result.text).toContain('FAIL: useful final error')
    expect(result.output?.bytes).toBe(Buffer.byteLength(text))
    expect(await readFile(join(path, capture.id + '.txt'), 'utf8')).toBe(text)
    expect((await stat(join(path, capture.id + '.txt'))).mode & 0o777).toBe(0o600)
  })

  it('pages UTF-8 without replacement characters and rejects invalid offsets and ids', async () => {
    const path = await directory()
    const capture = new CodeOutput(path)
    const original = '🙂é終'.repeat(1200)
    capture.append(original)
    capture.finish('code')
    let offset = 0
    let restored = ''
    do {
      const page = readCodeOutput(path, capture.id, offset, 509)
      restored += page.text.slice(0, page.text.lastIndexOf('\n[Output '))
      expect(page.text).not.toContain('�')
      if (page.nextOffset === null) break
      expect(page.nextOffset).toBeGreaterThan(offset)
      offset = page.nextOffset
    } while (true)
    expect(restored).toBe(original)
    expect(() => readCodeOutput(path, capture.id, 1)).toThrow('UTF-8')
    expect(() => readCodeOutput(path, '../secret')).toThrow('Invalid output id')
    expect(() => readCodeOutput(path, capture.id, 0, 100_000)).toThrow('limit')
  })

  it('stops storage at the first clipped multibyte chunk without filling the gap later', async () => {
    const path = await directory()
    const capture = new CodeOutput(path, 10)
    capture.append('A'.repeat(9) + '🙂' + 'B'.repeat(OUTPUT_PREVIEW_BYTES))
    capture.append('C')
    const result = capture.finish('code')
    expect(await readFile(join(path, capture.id + '.txt'), 'utf8')).toBe('A'.repeat(9))
    expect(result.output?.storedBytes).toBe(9)
    expect(result.text).toContain('storage limit reached')
    expect(result.text).not.toContain('Full output saved')
  })

  it('keeps execution output usable if the spill directory cannot be written', async () => {
    const path = await directory()
    const blocked = join(path, 'file')
    await writeFile(blocked, 'not a directory')
    const capture = new CodeOutput(blocked)
    capture.append('x'.repeat(20_000) + '\nuseful tail')
    const result = capture.finish('code')
    expect(result.text).toContain('useful tail')
    expect(result.text).toContain('Could not save omitted output')
    expect(result.output).toBeUndefined()
  })
})

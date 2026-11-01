// SPDX-License-Identifier: AGPL-3.0-only
// STL, binary or ASCII, read as the triangle soup it is — nine floats a
// triangle, each corner written out again for every face that meets there —
// and left to geometry/weld.ts to join up. The file's facet normals are
// skipped; the normals are worked out from the welded mesh instead.

import type { ParsedMesh } from '../types'
import { decodeText } from './text'

/** Binary if the byte length matches the triangle count in the header;
 *  some binary files start with "solid", so the size check comes first. */
export function parseSTL(buffer: ArrayBuffer, onProgress?: (text: string) => void): ParsedMesh {
  if (buffer.byteLength >= 84) {
    const dv = new DataView(buffer)
    const triCount = dv.getUint32(80, true)
    if (84 + triCount * 50 === buffer.byteLength) return parseBinary(dv, triCount, onProgress)
  }
  const head = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(512, buffer.byteLength)))
  if (/^\s*solid/.test(head)) {
    // CAD exporters write "solid" into binary headers too, and padding or a
    // truncated download leaves such a file off its exact size. When the
    // text reading finds no triangles, the size-tolerant binary read below
    // gets its turn rather than the file being refused. Any other failure,
    // such as text too long to decode, stands.
    try {
      return parseAscii(buffer, onProgress)
    } catch (err) {
      if (buffer.byteLength < 84 || !(err instanceof Error && err.message === NO_TRIANGLES)) throw err
    }
  }
  if (buffer.byteLength >= 84) {
    const dv = new DataView(buffer)
    return parseBinary(dv, Math.floor((buffer.byteLength - 84) / 50), onProgress)
  }
  throw new Error('Not a valid STL file.')
}

function parseBinary(dv: DataView, triCount: number, onProgress?: (text: string) => void): ParsedMesh {
  const positions = new Float32Array(triCount * 9)
  let off = 84
  let k = 0
  for (let t = 0; t < triCount; t++) {
    off += 12 // skip facet normal
    for (let v = 0; v < 9; v++) {
      positions[k++] = dv.getFloat32(off, true)
      off += 4
    }
    off += 2 // attribute byte count
    if (onProgress && (t & 0x3ffff) === 0 && t > 0) {
      onProgress(`Reading STL… ${Math.round((t / triCount) * 100)}%`)
    }
  }
  return { kind: 'soup', positions }
}

const NO_TRIANGLES = 'Could not read triangles from ASCII STL.'

function parseAscii(buffer: ArrayBuffer, onProgress?: (text: string) => void): ParsedMesh {
  onProgress?.('Reading STL…')
  const text = decodeText(buffer, 'ASCII STL', 'Export it as binary STL instead.')
  const re = /vertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/g
  const coords: number[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    coords.push(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]))
  }
  if (coords.length === 0 || coords.length % 9 !== 0) {
    throw new Error(NO_TRIANGLES)
  }
  return { kind: 'soup', positions: Float32Array.from(coords) }
}

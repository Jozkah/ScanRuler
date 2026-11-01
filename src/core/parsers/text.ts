// SPDX-License-Identifier: AGPL-3.0-only
// Decoding a whole text file into one string, for the parsers that read
// their format as text. Browsers cap a string at about 512 MiB of
// characters, and past that the decoder throws a bare RangeError; this says
// instead what happened and what the user can do about it.

/** The bytes as UTF-8 text, or an error naming the size limit when the
 *  file is too long for one string. `advice` follows that message. */
export function decodeText(bytes: ArrayBuffer | Uint8Array, format: string, advice = ''): string {
  try {
    return new TextDecoder().decode(bytes)
  } catch (err) {
    if (!(err instanceof RangeError)) throw err
    const tail = advice ? ` ${advice}` : ''
    throw new Error(`This ${format} file is too large to read as text (the limit is about 512 MiB).${tail}`)
  }
}

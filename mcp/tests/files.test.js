// SPDX-License-Identifier: AGPL-3.0-only
// Files around the scan: a folder given to scan_open or project_load opens
// the one file of its kind in it, or is refused with the list; the folders
// scans came from are kept, so a copy of the server started afresh lists
// and writes where the last one did; scanruler_files lists them; and a
// { "$file": path } in any argument is that file's JSON.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { loadFolders, saveFolders } from '../src/config.js'
import { PageLink } from '../src/link.js'
import { createMcpServer, SNAPSHOT } from '../src/mcp.js'
import { httpServer } from '../src/serve.js'
import { fileKind, inputFor, withFiles } from '../src/tools.js'
import { fakePage } from './fakePage.js'

const TOKEN = 'a-token-for-the-files-tests'
const echo = { name: 'demo.echo', title: 'Echo', description: 'Gives its input back.', input: { type: 'object', properties: {} }, readOnly: true, returnsFile: false, returnsImage: false }

let dir
let config
const closers = []
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'scanruler-mcp-files-'))
  config = join(dir, 'config')
})
after(async () => {
  for (const close of closers.reverse()) await close()
})

/** A copy of the server whose folders are kept in `config`, with the fake
 *  page connected. */
async function copy(store = config) {
  const link = new PageLink({ token: TOKEN })
  const http = httpServer({})
  link.attach(http)
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  const server = createMcpServer({
    link,
    version: '0.0.0',
    cwd: dir,
    outDir: dir,
    connectHelp: () => 'Pair it.',
    serverInfo: () => ({}),
    pageTimeoutMs: 50,
    folderStore: { load: () => loadFolders(store), save: (folders) => saveFolders(folders, store) },
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(a), client.connect(b)])
  const { page } = await fakePage(http.address().port, {
    token: TOKEN,
    commands: [...SNAPSHOT, echo],
    answer: (name, input) => {
      if (name === 'session.state') return { busy: null, running: null }
      if (name === 'scan.open') return { scan: { fileName: input.name, bytes: input.bytes.byteLength } }
      if (name === 'project.load') return { project: input.name }
      if (name === 'demo.echo') return input
      if (name === 'export.step') return { file: { name: 'part-elements.step', mimeType: 'model/step', bytes: new TextEncoder().encode('ISO-10303-21;') } }
      throw { code: 'invalid_input', message: `${name} refused.` }
    },
  })
  const close = async () => {
    await client.close()
    page.close()
    link.close()
    http.close()
  }
  closers.push(close)
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args })
    const text = r.content[0].text
    return { error: r.isError === true, text, json: r.isError ? null : JSON.parse(text) }
  }
  return { call, client, page, close }
}

test('a file’s kind by its extension', () => {
  assert.deepEqual(['a.STL', 'b.scanruler', 'c.step', 'd.png', 'e.dxf', 'f.md', 'g.bin'].map(fileKind), ['mesh', 'project', 'step', 'picture', 'drawing', 'text', 'other'])
})

test('$file: an object of that one key, at any depth, is the file’s JSON; a path is left as it is', async () => {
  await writeFile(join(dir, 'stations.json'), JSON.stringify([{ z: 0 }, { z: 5 }]))
  const args = { path: 'stations.json', sketch: { stations: { $file: 'stations.json' } }, list: [{ $file: join(dir, 'stations.json') }], other: { $file: 'x', more: 1 } }
  const out = await withFiles(args, dir)
  assert.deepEqual(out.sketch.stations, [{ z: 0 }, { z: 5 }])
  assert.deepEqual(out.list[0], [{ z: 0 }, { z: 5 }])
  assert.equal(out.path, 'stations.json')
  assert.deepEqual(out.other, { $file: 'x', more: 1 }, 'not that one key alone: left')
  await assert.rejects(withFiles({ a: { $file: 'missing.json' } }, dir), (e) => e.code === 'invalid_input' && /^\$file: .*missing\.json could not be read as JSON \(there is no such file\)\.$/.test(e.message))
})

test('a folder in place of a file: the one mesh in it opens; none, or several, is refused with the list', async () => {
  const scanOpen = SNAPSHOT.find((c) => c.name === 'scan.open')
  const one = join(dir, 'one')
  await mkdir(one, { recursive: true })
  await writeFile(join(one, 'notes.md'), '#')
  await writeFile(join(one, 'Part.STL'), Buffer.alloc(84))
  const read = await inputFor(scanOpen, { path: one }, { cwd: dir })
  assert.equal(read.file, join(one, 'Part.STL'))
  assert.equal(read.input.name, 'Part.STL')
  assert.equal(read.input.bytes.byteLength, 84)

  const two = join(dir, 'two')
  await mkdir(two, { recursive: true })
  await writeFile(join(two, 'a.stl'), Buffer.alloc(84))
  await writeFile(join(two, 'b.ply'), 'ply')
  await assert.rejects(inputFor(scanOpen, { path: two }, { cwd: dir }), (e) => e.code === 'invalid_input' && /is a folder with 2 mesh files — give one of them by its path: a\.stl, b\.ply\.$/.test(e.message))
  const none = join(dir, 'none')
  await mkdir(none, { recursive: true })
  await writeFile(join(none, 'readme.txt'), 'x')
  await assert.rejects(inputFor(scanOpen, { path: none }, { cwd: dir }), (e) => /no mesh file in it \(\.stl, \.ply, \.obj, \.3mf\) — it holds readme\.txt\. Give the file’s path\.$/.test(e.message))
  // A command that takes no folder says so, with what is there.
  const reference = SNAPSHOT.find((c) => c.name === 'deviation.open_reference')
  await assert.rejects(inputFor(reference, { path: one }, { cwd: dir }), (e) => /is a folder — give a file in it: /.test(e.message))
})

test('scan_open and project_load with a folder, the folders kept for a copy started afresh, and scanruler_files listing them', async () => {
  const folder = join(dir, 'fan')
  await mkdir(join(folder, 'renders'), { recursive: true })
  await writeFile(join(folder, 'Ventilador.stl'), Buffer.alloc(84))
  await writeFile(join(folder, 'fan.scanruler'), Buffer.alloc(4))
  await writeFile(join(folder, 'report.md'), '# Fan')

  const first = await copy()
  assert.equal((await first.call('scanruler_files')).error, true, 'nothing opened yet')
  const opened = await first.call('scan_open', { path: folder, discard: true })
  assert.equal(opened.error, false, opened.text)
  assert.deepEqual(opened.json.scan, { fileName: 'Ventilador.stl', bytes: 84 })
  const loaded = await first.call('project_load', { path: folder, discard: true })
  assert.equal(loaded.json.project, 'fan.scanruler')
  assert.deepEqual((await first.call('scanruler_status')).json.folders, [folder])
  await first.close()

  // Started afresh: the folder is still known — listed, and written into.
  const second = await copy()
  assert.deepEqual((await second.call('scanruler_status')).json.folders, [folder])
  const wrote = await second.call('scanruler_write', { path: 'notes.txt', text: 'kept' })
  assert.equal(wrote.json.path, join(folder, 'notes.txt'))
  assert.equal(await readFile(join(folder, 'notes.txt'), 'utf8'), 'kept')
  const files = (await second.call('scanruler_files')).json
  assert.equal(files.folder, folder)
  assert.deepEqual(files.folders, ['renders'])
  const byName = Object.fromEntries(files.files.map((f) => [f.name, f]))
  assert.deepEqual(Object.keys(byName).sort(), ['Ventilador.stl', 'fan.scanruler', 'notes.txt', 'report.md'])
  assert.deepEqual([byName['Ventilador.stl'].size, byName['Ventilador.stl'].kind], [84, 'mesh'])
  assert.equal(byName['fan.scanruler'].kind, 'project')
  assert.equal(files.files[0].name, 'notes.txt', 'newest first')
  assert.deepEqual((await second.call('scanruler_files', { path: 'renders' })).json.files, [])
  for (const path of ['..', join(tmpdir())]) assert.equal((await second.call('scanruler_files', { path })).error, true, path)

  // $file through a call: the page gets the file's contents — a relative
  // path taken from the scan's folder.
  await writeFile(join(folder, 'input.json'), JSON.stringify({ a: [1, 2] }))
  assert.deepEqual((await second.call('demo_echo', { value: { $file: 'input.json' } })).json, { value: { a: [1, 2] } })
  const batch = await second.call('scanruler_batch', { calls: [{ tool: 'demo_echo', arguments: { $file: 'input.json' } }] })
  assert.deepEqual(batch.json.results[0].result, { a: [1, 2] })
  const bad = await second.call('demo_echo', { value: { $file: 'nope.json' } })
  assert.equal(bad.error, true)
  assert.match(bad.text, /^invalid_input: \$file: /)
  await second.close()
})

test('relative paths from one folder: the scan’s once one is opened, else where the server started — for a batch file, $file, a file read and a file written; the status and every path field say so', async () => {
  const c = await copy(join(dir, 'config-relative'))
  const before = (await c.call('scanruler_status')).json.server
  assert.equal(before.cwd, dir)
  assert.equal(before.relativeTo, dir, 'no scan opened yet: where the server started')
  await writeFile(join(dir, 'early.json'), JSON.stringify([{ tool: 'demo_echo', arguments: { at: 'start' } }]))
  assert.deepEqual((await c.call('scanruler_batch', { file: 'early.json' })).json.results[0].result, { at: 'start' })

  const bracket = join(dir, 'bracket')
  await mkdir(bracket, { recursive: true })
  await writeFile(join(bracket, 'bracket.stl'), Buffer.alloc(84))
  assert.equal((await c.call('scan_open', { path: join(bracket, 'bracket.stl'), discard: true })).error, false)
  const after = (await c.call('scanruler_status')).json.server
  assert.equal(after.cwd, dir)
  assert.equal(after.relativeTo, bracket)

  // A batch file beside the scan, its $file beside it too.
  await writeFile(join(bracket, 'part.json'), JSON.stringify({ tabs: 4 }))
  await writeFile(join(bracket, 'stage1.json'), JSON.stringify({ calls: [{ tool: 'demo_echo', arguments: { part: { $file: 'part.json' } } }] }))
  const staged = await c.call('scanruler_batch', { file: 'stage1.json' })
  assert.equal(staged.error, false, staged.text)
  assert.deepEqual(staged.json.results[0].result, { part: { tabs: 4 } })
  // Not from where the server started any more: the refusal names the scan's folder.
  const gone = await c.call('scanruler_batch', { file: 'early.json' })
  assert.equal(gone.error, true)
  assert.ok(gone.text.includes(join(bracket, 'early.json')), gone.text)
  // A file read and a file written by a relative path: the scan's folder.
  await writeFile(join(bracket, 'second.stl'), Buffer.alloc(84))
  assert.deepEqual((await c.call('scan_open', { path: 'second.stl', discard: true })).json.scan, { fileName: 'second.stl', bytes: 84 })
  const exported = await c.call('export_step', { path: 'bracket.step' })
  assert.equal(exported.json.file.path, join(bracket, 'bracket.step'))
  assert.equal(await readFile(join(bracket, 'bracket.step'), 'utf8'), 'ISO-10303-21;')

  // Every path field names the base.
  const { tools } = await c.client.listTools()
  const field = (tool, key) => tools.find((t) => t.name === tool).inputSchema.properties[key].description
  for (const [tool, key] of [['scan_open', 'path'], ['scan_open', 'saveTo'], ['export_step', 'path'], ['view_render', 'path'], ['scanruler_batch', 'file']]) {
    assert.match(field(tool, key), /relative path is taken from the folder of the scan or project last opened or saved \(scanruler_status: server\.relativeTo\)/, `${tool}.${key}`)
    assert.ok(field(tool, key).includes(dir), `${tool}.${key} names where the server started`)
  }
  assert.match(tools.find((t) => t.name === 'scanruler_batch').description, /\$file.*relative path is taken from the folder of the scan/)
  await c.close()
})

test('a batch file of more calls than a spread can pass still answers', async () => {
  const c = await copy()
  await writeFile(join(dir, 'many.json'), JSON.stringify(Array.from({ length: 130_000 }, () => ({ tool: 'demo_echo' }))))
  const r = await c.call('scanruler_batch', { file: join(dir, 'many.json'), wait: false })
  const done = await c.call('scanruler_wait', { for: 'job', job: r.json.job, timeoutSeconds: 600 })
  assert.equal(done.error, false, done.text)
  assert.equal(done.json.state, 'done', done.text)
  await c.close()
})

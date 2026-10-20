const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')

test('folder menu uses the runtime plugin id, current settings and HFS clipboard helper', async () => {
    let menu, copied
    const HFS = {
        plugins: { renamed: { enabled: true } }, state: { props: {} },
        getPluginKey: () => 'renamed', onEvent: (_, callback) => menu = callback,
        copyTextToClipboard: async value => { copied = value }, t: (_, fallback) => fallback
    }
    const location = { origin: 'https://books.example', pathname: '/proxy/books/' }
    vm.runInNewContext(readFileSync(join(__dirname, '../dist/public/main.js'), 'utf8'), { HFS, location, URL })
    const entry = { isFolder: true, uri: '/proxy/books/' }
    await menu({ entry }).onClick()
    assert.equal(copied, 'https://books.example/proxy/books/?get=opds')
    for (const p of ['l', 'L']) assert.equal(menu({ entry: { ...entry, p } }), undefined)
    assert.equal(menu({ entry: { ...entry, isFolder: false } }), undefined)
    HFS.state.props = undefined
    assert.equal(menu({ entry }), undefined)
    HFS.state.props = {}
    HFS.plugins.renamed = { enabled: false }
    assert.equal(menu({ entry }), undefined)
    HFS.plugins.renamed = { enabled: true }
    const nested = { isFolder: true, uri: '/proxy/books/r%C3%A9%20%26%20shelf/' }
    await menu({ entry: nested }).onClick()
    assert.equal(copied, 'https://books.example/proxy/books/r%C3%A9%20%26%20shelf/?get=opds')
})

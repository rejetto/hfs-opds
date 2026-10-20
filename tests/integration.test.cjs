const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const http = require('node:http')

const hfs = process.env.HFS_ROOT || resolve(__dirname, '../../../hfs')
const { XMLParser, XMLValidator } = require(require.resolve('fast-xml-parser', { paths: [hfs] }))
const parser = new XMLParser({ ignoreAttributes: false, isArray: name => ['entry', 'link'].includes(name) })
const id = 'opds-test'
const auth = { Authorization: 'Basic ' + Buffer.from('reader:books-pass').toString('base64') }
const mime = {
    epub: 'application/epub+zip', pdf: 'application/pdf', mobi: 'application/x-mobipocket-ebook',
    azw: 'application/vnd.amazon.ebook', azw3: 'application/vnd.amazon.mobi8-ebook',
    cbz: 'application/vnd.comicbook+zip', cbr: 'application/vnd.comicbook-rar'
}

test('OPDS with real HFS routing, VFS, authentication and downloads', { timeout: 60000 }, async t => {
    const cwd = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'hfs-opds-')))
    const shared = join(cwd, 'files')
    await fs.mkdir(join(shared, 'nested'), { recursive: true })
    for (const name of [...Object.keys(mime).map(ext => `book.${ext}`), 'é & < > " 😀.EPUB', 'unrelated.txt', 'secret.epub', 'hidden.epub', '.dot.epub'])
        await fs.writeFile(join(shared, name), 'contents: ' + name)
    await fs.writeFile(join(shared, 'nested', 'child.pdf'), 'nested book')
    await fs.cp(resolve(__dirname, '../dist'), join(cwd, 'plugins', id), { recursive: true })
    const config = {
        port: 0, https_port: -1, listen_interface: '127.0.0.1', open_browser_at_start: false,
        log: '', error_log: '', proxies: 1, enable_plugins: [id], directory_cache: Number(process.env.HFS_CACHE || 0),
        accounts: { reader: { password: 'books-pass' } },
        plugins_config: { [id]: { pageSize: 3 } },
        roots: { 'public.example': '/virtual/' },
        vfs: { children: [
            { name: 'books', source: shared, masks: { 'secret.epub': { can_see: true, can_read: false }, 'hidden.epub': { can_see: false }, nested: { can_list: false } } },
            { name: 'private', source: shared, can_see: true, can_list: ['reader'], can_read: ['reader'] },
            { name: 'forbidden', can_list: false },
            { name: 'invisible', source: shared, can_see: false },
            { name: 'empty' },
            { name: 'virtual', children: [{ name: 'ré & shelf', source: shared }] }
        ] }
    }
    await fs.writeFile(join(cwd, 'config.yaml'), JSON.stringify(config))
    const args = process.env.HFS_SOURCE
        ? ['--import', require.resolve('tsx', { paths: [hfs] }), join(hfs, 'src/index.ts')]
        : [join(hfs, 'dist/src/index.js')]
    const child = spawn(process.execPath, [...args, '--cwd', cwd, '--no-central'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const exited = once(child, 'exit')
    let output = '', base = ''
    child.stdout.on('data', chunk => output += chunk)
    child.stderr.on('data', chunk => output += chunk)
    t.after(async () => {
        child.kill()
        await exited
        // remove only fixtures created by this test
        await fs.rm(cwd, { recursive: true, force: true, maxRetries: 5 })
    })
    for (let n = 0; n < 300; n++) {
        assert.equal(child.exitCode, null, output)
        base = /Serving on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1] || ''
        if (base && (await fetch(base + '/empty/?get=opds')).headers.get('content-type')?.includes('opds-catalog')) break
        await delay(50)
    }
    assert.ok(base, output)

    await t.test('acquisition structure, formats, escaping, pagination, stable IDs and real downloads', async () => {
        const entries = await all('/books/?get=opds')
        assert.equal(entries.length, 8)
        assert.equal(new Set(entries.map(e => e.id)).size, 8)
        assert.deepEqual(entries.map(e => e.id), (await all('/books/?get=opds')).map(e => e.id))
        for (const entry of entries) {
            assert.ok(entry.title)
            assert.ok(Number.isFinite(Date.parse(entry.updated)))
            assert.ok(entry.content)
            const acquisition = link(entry, 'http://opds-spec.org/acquisition')
            const url = acquisition['@_href']
            const name = decodeURIComponent(new URL(url).pathname.split('/').at(-1))
            assert.equal(acquisition['@_type'], mime[name.split('.').at(-1).toLowerCase()])
            const downloaded = await fetch(url)
            assert.equal(downloaded.status, 200)
            assert.equal(await downloaded.text(), 'contents: ' + name)
        }
        const { feed, response } = await catalog('/books/?get=opds')
        assert.match(response.headers.get('content-type'), /kind=acquisition/)
        assert.equal(response.headers.get('cache-control'), 'private, no-store')
        assert.ok(link(feed, 'next'))
        assert.ok(link(feed, 'last'))
        assert.equal((await fetch(base + '/books/?get=opds', { method: 'HEAD' })).status, 200)
    })

    await t.test('virtual and mixed folders use navigation feeds and a separate books feed', async () => {
        const { feed } = await catalog('/virtual/?get=opds')
        assert.equal(feed.entry[0].title, 'ré & shelf')
        const mixed = new URL(link(feed.entry[0], 'subsection')['@_href'])
        const children = await all(mixed.pathname + mixed.search)
        assert.deepEqual(children.map(e => e.title), ['Books in this folder', 'nested'])
        assert.match(link(children[0], 'subsection')['@_type'], /kind=acquisition/)
        const books = new URL(link(children[0], 'subsection')['@_href'])
        assert.equal((await all(books.pathname + books.search)).length, 8 + 2) // no permission masks on this alias
        const nested = new URL(link(children[1], 'subsection')['@_href'])
        assert.equal((await all(nested.pathname + nested.search))[0].title, 'child')
    })

    await t.test('empty folders and denied or invalid paths reveal no names', async () => {
        assert.equal((await catalog('/empty/?get=opds')).feed.entry, undefined)
        for (const [path, status] of [
            ['/forbidden/', 403], ['/invisible/', 404], ['/missing/', 404], ['/books/book.pdf', 404],
            ['/books/%2e%2e%2f/', 400], ['/books/%ZZ/', 404], ['/books/%5c/', 400]
        ]) {
            const response = await fetch(base + path + '?get=opds')
            assert.equal(response.status, status, path)
            assert.doesNotMatch(await response.text(), /secret\.epub|book\.pdf|hidden\.epub/)
        }
        for (const query of ['opds_page=0', 'opds_page=1.5', 'opds_page=Infinity', 'opds_view=invalid'])
            assert.equal((await fetch(base + '/books/?get=opds&' + query)).status, 400)
        assert.equal((await fetch(base + '/books/?get=opds&opds_page=999')).status, 404)
        assert.equal((await fetch(base + '/books/secret.epub')).status, 403)
    })

    await t.test('Basic authentication uses HFS accounts for both catalog and acquisitions', async () => {
        const denied = await fetch(base + '/private/?get=opds')
        assert.equal(denied.status, 401)
        assert.match(denied.headers.get('www-authenticate'), /^Basic /)
        assert.equal((await fetch(base + '/private/?get=opds', { headers: { Authorization: 'Basic ' + Buffer.from('reader:wrong').toString('base64') } })).status, 401)
        const entries = await all('/private/?get=opds&opds_view=books', auth)
        assert.equal(entries.length, 10)
        const acquisition = link(entries[0], 'http://opds-spec.org/acquisition')['@_href']
        assert.equal((await fetch(acquisition)).status, 401)
        assert.equal((await fetch(acquisition, { headers: auth })).status, 200)
        for (const entry of entries) assert.doesNotMatch(JSON.stringify(entry), /books-pass|reader:|login=/)
    })

    await t.test('host roots and reverse-proxy prefixes preserve public paths and stable IDs', async () => {
        const { feed } = await catalog('/r%C3%A9%20%26%20shelf/?get=opds&opds_view=books', {
            Host: 'internal.example',
            'X-Forwarded-Prefix': '/library', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'public.example'
        })
        const self = link(feed, 'self')['@_href']
        assert.equal(self, 'https://public.example/library/r%C3%A9%20%26%20shelf/?get=opds&opds_view=books')
        assert.ok(link(feed, 'start')['@_href'].endsWith('/library/?get=opds'))
        for (const entry of feed.entry) {
            assert.ok(link(entry, 'http://opds-spec.org/acquisition')['@_href'].includes('/library/r%C3%A9%20%26%20shelf/'))
            assert.ok(!JSON.stringify(entry).includes('/virtual/'))
        }
        const direct = await catalog('/virtual/r%C3%A9%20%26%20shelf/?get=opds&opds_view=books')
        assert.deepEqual(feed.entry.map(e => e.id), direct.feed.entry.map(e => e.id))
    })

    await t.test('catalog identity persists across plugin unload and reload', async () => {
        const before = (await all('/books/?get=opds')).map(entry => entry.id)
        const identity = await fs.readFile(join(cwd, 'plugins', id, 'storage/catalog-id'), 'utf8')
        assert.match(identity, /^[a-f\d-]{36}$/)
        await setPlugin({ enabled: false })
        await waitForService(false)
        await setPlugin({ enabled: true })
        await waitForService(true)
        assert.deepEqual((await all('/books/?get=opds')).map(entry => entry.id), before)
    })

    await t.test('configuration changes, service disable, normal browsing and download routing', async () => {
        await configure({ extensions: '.PDF', pageSize: 1, title: 'My & books' })
        const { feed } = await catalog('/books/?get=opds')
        assert.equal(feed.title, 'My & books')
        assert.equal(feed.entry.length, 1)
        assert.equal(feed.entry[0].title, 'book')
        assert.equal(link(feed, 'next'), undefined)
        await configure({ enabled: false })
        const off = await fetch(base + '/books/?get=opds')
        assert.doesNotMatch(off.headers.get('content-type'), /opds-catalog/)
        assert.equal((await fetch(base + '/books/book.epub')).status, 200)
        assert.equal((await fetch(base + '/books/')).status, 200)
        await configure({ enabled: true })
        assert.equal((await catalog('/books/?get=opds')).feed.title, 'My & books')
    })

    if (process.env.HFS_UI) await t.test('real browser folder menu copies catalog URL and hides denied folders', async () => {
        const { chromium } = require(require.resolve('@playwright/test', { paths: [hfs] }))
        const browser = await chromium.launch({ headless: true })
        let page
        try {
            const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
            page = await context.newPage()
            page.setDefaultTimeout(5000)
            await page.goto(base + '/books/')
            await page.waitForFunction(() => window.HFS?.state.loading === false)
            await page.locator('.breadcrumb').last().click()
            await page.getByText('Copy OPDS catalog URL', { exact: true }).click()
            assert.equal(await page.evaluate(() => navigator.clipboard.readText()), base + '/books/?get=opds')
            await page.goto(base + '/')
            await page.waitForFunction(() => window.HFS?.state.loading === false)
            const forbidden = page.locator('li.folder').filter({ has: page.locator('a[href="/forbidden/"]') })
            await forbidden.hover()
            await forbidden.locator('button').last().click()
            assert.equal(await page.getByText('Copy OPDS catalog URL', { exact: true }).count(), 0)
        }
        catch (error) {
            throw new Error(error.message + '\nPage: ' + await page?.locator('body').innerText())
        }
        finally { await browser.close() }
    })

    function configure(config) {
        return setPlugin({ config })
    }

    async function setPlugin(values) {
        // use the real Admin endpoint to exercise runtime configuration changes
        const response = await fetch(base + '/~/api/set_plugin', { method: 'POST', headers: {
            'Content-Type': 'application/json', 'x-hfs-anti-csrf': '1'
        }, body: JSON.stringify({ id, ...values }) })
        assert.equal(response.status, 200, await response.text())
    }

    async function waitForService(enabled) {
        for (let n = 0; n < 100; n++) {
            const response = await fetch(base + '/empty/?get=opds')
            if (response.headers.get('content-type')?.includes('opds-catalog') === enabled) return
            await delay(50)
        }
        assert.fail('plugin did not reach expected state: ' + enabled + '\n' + output)
    }

    async function catalog(path, headers = {}) {
        // http.request keeps a custom Host while fetch normalizes it on some Node versions
        const response = await new Promise((resolve, reject) => {
            http.get(base + path, { headers }, res => {
                let body = ''
                res.setEncoding('utf8').on('data', chunk => body += chunk).on('end', () => resolve({
                    status: res.statusCode, headers: new Headers(res.headers), body
                }))
            }).on('error', reject)
        })
        assert.equal(response.status, 200, response.body + '\n' + output)
        assert.equal(XMLValidator.validate(response.body), true, response.body)
        const feed = parser.parse(response.body).feed
        assert.equal(feed['@_xmlns'], 'http://www.w3.org/2005/Atom')
        assert.equal(feed.author.name, 'HFS')
        assert.ok(feed.id)
        assert.ok(Number.isFinite(Date.parse(feed.updated)))
        return { feed, response }
    }

    async function all(path, headers) {
        const entries = []
        while (path) {
            const { feed } = await catalog(path, headers)
            entries.push(...feed.entry || [])
            const next = link(feed, 'next')
            path = next && new URL(next['@_href'])
            if (path) path = path.pathname + path.search
        }
        return entries
    }
})

function link(entry, rel) {
    return entry.link?.find(link => link['@_rel'] === rel)
}

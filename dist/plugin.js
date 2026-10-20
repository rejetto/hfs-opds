exports.description = "Browse shared ebooks with OPDS readers"
exports.version = 1
exports.apiRequired = 13.1
exports.repo = "rejetto/hfs-opds"
exports.frontend_js = "main.js"
exports.config = {
    enabled: { type: 'boolean', label: "Enable OPDS service", defaultValue: true, frontend: true },
    extensions: {
        type: 'string', label: "Book extensions", defaultValue: "epub,pdf,mobi,azw,azw3,cbz,cbr",
        helperText: "Comma-separated extensions. Supported: epub, pdf, mobi, azw, azw3, cbz, cbr."
    },
    pageSize: { type: 'number', label: "Entries per page", defaultValue: 100, min: 1, max: 1000 },
    title: { type: 'string', label: "Catalog title", defaultValue: "" }
}

const { createHash, randomUUID } = require('node:crypto')
const MIME = {
    __proto__: null,
    epub: 'application/epub+zip', pdf: 'application/pdf', mobi: 'application/x-mobipocket-ebook',
    azw: 'application/vnd.amazon.ebook', azw3: 'application/vnd.amazon.mobi8-ebook',
    cbz: 'application/vnd.comicbook+zip', cbr: 'application/vnd.comicbook-rar'
}
const ATOM = 'application/atom+xml;profile=opds-catalog'
// kind is advisory; uninspected folder links suggest navigation without scanning their contents
const NAVIGATION = ATOM + ';kind=navigation'
const EPOCH = '1970-01-01T00:00:00.000Z'

exports.init = async api => {
    // no public VFS listing API exists; keep all permission and path resolution in HFS's VFS module
    const { urlToNode, walkNode, nodeIsFolder, nodeStats, getNodeName, hasPermission, statusCodeForMissingPerm } = api.require('./vfs')
    const { readFile, writeFile } = require('node:fs/promises')
    const { join } = require('node:path')
    const identityFile = join(api.storageDir, 'catalog-id')
    let identity
    try { identity = await readFile(identityFile, 'utf8') }
    catch (error) {
        if (error.code !== 'ENOENT') throw error
        // persist a catalog namespace so different servers have distinct IDs that survive hostname changes
        identity = randomUUID()
        await writeFile(identityFile, identity)
    }
    return {
        async middleware(ctx) {
            if (!api.getConfig('enabled') || ctx.query.get !== 'opds' || !['GET', 'HEAD'].includes(ctx.method)) return
            ctx.stop()
            // catalogs vary by account; shared caches must never reuse a privileged listing
            ctx.set('Cache-Control', 'private, no-store')
            try {
                await catalog(ctx)
            }
            catch (error) {
                api.log("Cannot generate OPDS catalog:", error.message)
                ctx.status = 500
                ctx.body = "Cannot generate OPDS catalog"
            }
        }
    }

    async function catalog(ctx) {
        const publicPath = canonicalPath(ctx.state.originalPath || ctx.path)
        const vfsPath = canonicalPath(ctx.path)
        if (!publicPath || !vfsPath) return fail(400, "Invalid path")
        const page = Number(ctx.query.opds_page || 1)
        if (!Number.isSafeInteger(page) || page < 1) return fail(400, "Invalid page")
        const view = ctx.query.opds_view || ''
        if (view && view !== 'books') return fail(400, "Invalid view")
        const node = await urlToNode(ctx.path, ctx)
        if (!node) return fail(404, "Not found")
        if (!nodeIsFolder(node)) return fail(404, "Not a folder")
        const denied = statusCodeForMissingPerm(node, 'can_list', ctx)
        if (denied) {
            if (denied === 401) ctx.set('WWW-Authenticate', 'Basic realm="HFS"')
            return
        }

        const extensions = new Set(api.getConfig('extensions').toLowerCase().split(/[\s,;]+/).map(x => x.replace(/^\./, '')))
        const pageSize = Math.min(1000, Math.max(1, Math.floor(Number(api.getConfig('pageSize'))) || 100))
        const folders = [], books = []
        let updated = timestamp(await nodeStats(node))
        for await (const child of walkNode(node, { ctx, depth: 0, useCache: true })) {
            const name = getNodeName(child)
            const folder = nodeIsFolder(child)
            const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
            if (folder ? !hasPermission(child, 'can_list', ctx)
                : !extensions.has(extension) || !(extension in MIME) || !hasPermission(child, 'can_read', ctx) || child.url) continue
            const stats = await nodeStats(child)
            if (!folder && !stats?.isFile()) continue
            const date = timestamp(stats)
            if (date > updated) updated = date
            const path = publicPath + encodeURIComponent(name) + (folder ? '/' : '')
            const item = { name, path, date, id: stableId(vfsPath + name + (folder ? '/' : '')) }
            if (folder) folders.push(item)
            else books.push({ ...item, extension })
        }
        const navigation = !view && folders.length > 0
        const kind = navigation ? 'navigation' : 'acquisition'
        const mainType = folders.length ? NAVIGATION : ATOM + ';kind=acquisition'
        const items = navigation ? folders : books
        // sort independently of disk/cache enumeration so page boundaries remain stable between requests
        items.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
        if (navigation && books.length)
            items.unshift({ name: "Books in this folder", path: publicPath, date: updated, id: stableId(vfsPath + '?books'), books: true })
        const pages = Math.max(1, Math.ceil(items.length / pageSize))
        if (page > pages) return fail(404, "Page not found")
        const title = api.getConfig('title') || getNodeName(node) || "HFS books"
        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
            + '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">'
            + element('id', stableId(vfsPath + (view ? '?books' : '?catalog')))
            + element('title', title) + element('updated', updated) + '<author><name>HFS</name></author>'
            + link('self', feedUrl(publicPath, view, page), ATOM + ';kind=' + kind)
            + link('start', feedUrl('/'), publicPath === '/' ? mainType : NAVIGATION)
        if (view) xml += link('up', feedUrl(publicPath), mainType)
        else if (publicPath !== '/') xml += link('up', feedUrl(publicPath.replace(/[^/]+\/$/, '')), NAVIGATION)
        xml += link('first', feedUrl(publicPath, view, 1), ATOM + ';kind=' + kind)
            + link('last', feedUrl(publicPath, view, pages), ATOM + ';kind=' + kind)
        if (page > 1) xml += link('previous', feedUrl(publicPath, view, page - 1), ATOM + ';kind=' + kind)
        if (page < pages) xml += link('next', feedUrl(publicPath, view, page + 1), ATOM + ';kind=' + kind)
        for (const item of items.slice((page - 1) * pageSize, page * pageSize)) {
            xml += '<entry>' + element('id', item.id)
                + element('title', navigation ? item.name : item.name.slice(0, -item.extension.length - 1))
                + element('updated', item.date)
                + (navigation
                    ? element('content', item.books ? "Download books in this folder" : "Browse this folder")
                        + link('subsection', feedUrl(item.path, item.books ? 'books' : ''), item.books ? ATOM + ';kind=acquisition' : NAVIGATION)
                    : element('content', "Download " + item.name)
                        + link('http://opds-spec.org/acquisition', absolute(item.path), MIME[item.extension]))
                + '</entry>'
        }
        ctx.body = xml + '</feed>'
        ctx.type = ATOM + ';kind=' + kind + ';charset=utf-8'

        function absolute(path) {
            // originalPath is before host-root mapping; the proxy prefix belongs only in public URLs
            return ctx.URL.origin + ctx.state.revProxyPath + path
        }

        function feedUrl(path, selectedView = '', selectedPage = 1) {
            const query = new URLSearchParams({ get: 'opds' })
            if (selectedView) query.set('opds_view', selectedView)
            if (selectedPage > 1) query.set('opds_page', selectedPage)
            return absolute(path) + '?' + query
        }

        function fail(status, message) {
            ctx.status = status
            ctx.body = message
        }
    }

    function stableId(path) {
        return 'urn:hfs-opds:' + createHash('sha256').update(identity + path).digest('hex')
    }
}

function canonicalPath(path) {
    try {
        const segments = path.split('/').filter(Boolean).map(decodeURIComponent)
        if (segments.some(x => x === '.' || x === '..' || /[/\\\x00-\x1f]/.test(x))) return
        return '/' + segments.map(encodeURIComponent).join('/') + (segments.length ? '/' : '')
    }
    catch { return undefined }
}

function timestamp(stats) {
    return stats?.mtime?.toISOString() || EPOCH
}

function escapeXml(value) {
    // filenames can contain characters forbidden by XML 1.0, even after entity escaping
    return String(value).replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '')
        .replace(/[&<>"']/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[x])
}

function element(name, value) {
    return `<${name}>${escapeXml(value)}</${name}>`
}

function link(rel, href, type) {
    return `<link rel="${rel}" href="${escapeXml(href)}" type="${escapeXml(type)}"/>`
}

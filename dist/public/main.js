{
    const { onEvent, getPluginKey, copyTextToClipboard, t } = HFS
    const plugin = getPluginKey()
    onEvent('fileMenu', ({ entry }) => {
        if (!HFS.plugins[plugin]?.enabled || !entry.isFolder || entry.p?.match(/l/i)) return
        if (entry.uri === location.pathname && !HFS.state.props) return
        return {
            id: 'opds-copy', icon: 'copy', label: t('opds_copy', "Copy OPDS catalog URL"),
            onClick() {
                const url = new URL(entry.uri, location.origin)
                url.search = '?get=opds'
                url.hash = ''
                return copyTextToClipboard(url.href)
            }
        }
    })
}

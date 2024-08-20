import type { Deeplink } from './common.js'
import { deeplinkBuilder } from './common.js'

/**
 * MTProxy links
 */
export const mtproxy: Deeplink<{
    server: string
    port: number
    secret: string
}> = /* #__PURE__ */ deeplinkBuilder({
    internalBuild: params => ['proxy', params],
    externalBuild: params => ['proxy', params],
    internalParse: (path, query) => {
        if (path !== 'proxy') return null

        const server = query.get('server')
        const port = Number(query.get('port'))
        const secret = query.get('secret')

        if (!server || Number.isNaN(port) || !secret) return null

        return { server, port, secret }
    },
    externalParse: (path, query) => {
        if (path !== 'proxy') return null

        const server = query.get('server')
        const port = Number(query.get('port'))
        const secret = query.get('secret')

        if (!server || Number.isNaN(port) || !secret) return null

        return { server, port, secret }
    },
})

/**
 * Socks5 proxy links
 */
export const socks5: Deeplink<{
    server: string
    port: number
    user?: string
    pass?: string
}> = /* #__PURE__ */ deeplinkBuilder({
    internalBuild: params => ['socks', params],
    externalBuild: params => ['socks', params],
    internalParse: (path, query) => {
        if (path !== 'socks') return null

        const server = query.get('server')
        const port = Number(query.get('port'))
        const user = query.get('user')
        const pass = query.get('pass')

        if (!server || Number.isNaN(port)) return null

        return { server, port, user: user || undefined, pass: pass || undefined }
    },
    externalParse: (path, query) => {
        if (path !== 'socks') return null

        const server = query.get('server')
        const port = Number(query.get('port'))
        const user = query.get('user')
        const pass = query.get('pass')

        if (!server || Number.isNaN(port)) return null

        return { server, port, user: user || undefined, pass: pass || undefined }
    },
})

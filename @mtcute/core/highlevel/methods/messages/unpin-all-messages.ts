import type { ITelegramClient } from '../../client.types.js'
import type { InputPeerLike } from '../../types/index.js'
import { createDummyUpdate } from '../../updates/utils.js'
import { isInputPeerChannel } from '../../utils/peer-utils.js'
import { resolvePeer } from '../users/resolve-peer.js'

/**
 * Unpin all pinned messages in a chat.
 *
 * @param chatId  Chat or user ID
 */
export async function unpinAllMessages(
    client: ITelegramClient,
    chatId: InputPeerLike,
    params?: {
        /**
         * For forums - unpin only messages from the given topic
         */
        topicId?: number

        /**
         * Whether to dispatch updates that will be generated by this call.
         * Doesn't follow `disableNoDispatch`
         */
        shouldDispatch?: true
    },
): Promise<void> {
    const { topicId, shouldDispatch } = params ?? {}

    const peer = await resolvePeer(client, chatId)

    const res = await client.call({
        _: 'messages.unpinAllMessages',
        peer,
        topMsgId: topicId,
    })

    if (!shouldDispatch) {
        if (isInputPeerChannel(peer)) {
            client.handleClientUpdate(createDummyUpdate(res.pts, res.ptsCount, peer.channelId))
        } else {
            client.handleClientUpdate(createDummyUpdate(res.pts, res.ptsCount))
        }
    }
}

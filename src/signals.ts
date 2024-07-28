import { batch, createSignal, observable } from "solid-js";
import { EventEmitter } from "eventemitter3";
import { telegram } from "./lib/telegram";
import {
	Chat,
	ChatPermissions,
	Dialog,
	InputPeerLike,
	Message,
	Peer,
	Poll,
	PollUpdate,
	TelegramClient,
	TextWithEntities,
	tl,
	UserStatus,
	UserStatusUpdate,
} from "@mtcute/web";
import { capitalize, debounce } from "lodash-es";
import { get, writable, Writable } from "./lib/stores";
import playVideo from "./lib/playVideo";
import localforage from "localforage";
import { QRCode } from "./lib/qrCode";
import { GetHistoryOffset } from "@mtcute/core/methods";
import { capitalizeFirstLetter, sleep } from "./lib/utils";
import Deferred from "./lib/Deffered";
import dayjs from "dayjs";
import Queue from "queue";

const [softleft, setSoftleft] = createSignal("");
const [softcenter, setSoftcenter] = createSignal("");
const [softright, setSoftright] = createSignal("");
const [softkeysLoading, setSoftkeysLoading] = createSignal(false);
const [softkeysBlack, setSoftkeysBlack] = createSignal(false);

export { softleft, softcenter, softright, softkeysLoading, softkeysBlack };

export const [statusbarColor, setStatusbarColor] = createSignal("#000");

observable(statusbarColor).subscribe((color) => {
	document.head.querySelector(`meta[name="theme-color"]`)?.setAttribute("content", color);
});

export function setSoftkeys(
	left?: string | null,
	center?: string | null,
	right?: string | null,
	loading?: boolean | null,
	black?: boolean | null
) {
	batch(() => {
		left != undefined && setSoftleft(left);
		center != undefined && setSoftcenter(center);
		right != undefined && setSoftright(right);

		loading == undefined ? setSoftkeysLoading(false) : setSoftkeysLoading(Boolean(loading));
		black == undefined ? setSoftkeysBlack(false) : setSoftkeysBlack(Boolean(black));
	});
}

export const [currentView, setView] = createSignal(
	"loading" as "login" | "loading" | "home" | "room" | "info"
);

export const [messageInfo, setMessageInfo] = createSignal<null | {
	dialog: UIDialog | null;
	message: UIMessage;
}>(null);

export const [replyingMessage, setReplyingMessage] = createSignal<null | UIMessage>(null);
export const [editingMessage, setEditingMessage] = createSignal<null | UIMessage>(null);

export const [room, setRoom] = createSignal<Chat | UIDialog | null>(null);

type StringCallback = (s: string) => void;
type VoidCallback = () => void;

export const EE = new EventEmitter<{
	phone: StringCallback;
	code: StringCallback;
	password: StringCallback;
	loginError: (e: { code: number; message: string }) => void;
	requestJump: (msgId: number, chatId: number) => void;
}>();

export const enum LoginState {
	Phone,
	Password,
	Code,
}

export const [loginState, setLoginState] = createSignal<LoginState>(LoginState.Phone);
export const [qrLink, setQrLink] = createSignal<null | string>(null);

export { telegram };

export const [client, setClient] = createSignal<TelegramClient | null>(null);

export class UIPoll {
	closed = writable(false);

	constructor(public $: Poll) {
		this.update($);

		pollJar.set($.id.toInt(), this);
	}

	results = writable<null | tl.RawPollResults>(null);

	update($: Poll) {
		this.$ = $;

		$.results && this.results.set($.results);

		this.closed.set($.isClosed);
	}

	resultsUpdate($: tl.RawPollResults) {
		this.results.set($);
	}
}

class PollJar extends Map<number, UIPoll> {
	add($: Poll) {
		const id = $.id.toInt();

		const has = this.get(id);
		if (has) {
			has.update($);
			return has;
		}

		const uiPoll = new UIPoll($);

		this.set(id, uiPoll);
		return uiPoll;
	}
}

export const pollJar = new PollJar();

export class UIMessage {
	text: Writable<string>;
	entities: Writable<TextWithEntities>;

	editDate: Writable<Date | null>;

	date: Date;
	id: number;
	sender: Peer;
	isOutgoing: boolean;

	isSticker = false;

	private __replyToCache: any;
	private __deferredReply = new Deferred<UIMessage | null>();
	private __isGettingUser = false;

	poll: UIPoll | null = null;

	updateText($: Message) {
		let newText = $.text;

		if ($.action) {
			switch ($.action.type) {
				case "chat_created": {
					newText = ($.isOutgoing ? "You" : $.sender.displayName) + " created the group";
					break;
				}
				case "title_changed": {
					newText = $.sender.displayName + ' changed the group name to "' + $.action.title + '"';
					break;
				}
				case "message_pinned": {
					this.getReply().then((msg) => {
						if (msg) {
							const text = msg.$.text;
							const ellipses = (text: string) => {
								const e = text.slice(0, 52);
								if (e.length != text.length) {
									return e + "...";
								}
								return text;
							};

							this.text.set($.sender.displayName + ' pinned "' + ellipses(text) + '"');
						}
					});

					newText = $.sender.displayName + " pinned a message";

					break;
				}

				case "users_added": {
					const sender = $.isOutgoing ? "You" : $.sender.displayName;
					if ($.action.users[0] === $.sender.id) {
						newText = sender + " joined the group";
						break;
					}

					client()!
						.getUsers($.action.users[0])
						.then((_user) => {
							const user = _user[0];
							if (user) {
								this.text.set(sender + " added " + user.displayName);
							} else {
								// @ts-ignore
								console.error("USER NOT FOUND", $.action.users);
							}
						});

					if (!this.__isGettingUser) {
						newText = sender + " added a user";
						this.__isGettingUser = true;
					} else {
						return;
					}
					break;
				}

				case "user_removed": {
					const sender = $.isOutgoing ? "You" : $.sender.displayName;

					if ($.action.user === $.sender.id) {
						newText = sender + " left the group";
						break;
					}

					client()!
						.getUsers($.action.user)
						.then((_user) => {
							const user = _user[0];
							if (user) {
								this.text.set(sender + " removed " + user.displayName);
							} else {
								// @ts-ignore
								console.error("USER NOT FOUND", $.action.user);
							}
						});

					if (!this.__isGettingUser) {
						newText = sender + " removed a user";
						this.__isGettingUser = true;
					} else {
						return;
					}

					break;
				}

				default: {
					newText = "Unsupported Message Action: " + $.action.type;
				}
			}
		} else {
		}

		if ($.media) {
			switch ($.media.type) {
				case "location": {
					newText = "Location";
					break;
				}

				case "photo": {
					newText = "Photo";
					break;
				}

				case "webpage": {
					break;
				}

				case "sticker": {
					newText = $.media.emoji + " Sticker";

					this.isSticker = true;
					break;
				}

				default: {
					console.log("unsupported media type:", $.media.type, $);
					newText = capitalizeFirstLetter($.media.type);
				}
			}
		}

		this.text.set(newText);
	}

	async getReply(_dialog?: UIDialog) {
		if (!this.$.replyToMessage) return null;

		if (this.__replyToCache) {
			return this.__deferredReply.promise;
		}

		const promise = client()!
			.getReplyTo(this.$)
			.then((msg) => {
				if (msg) {
					const dialog = _dialog || dialogsJar.get(msg.chat.peer.id);

					if (dialog) {
						const _msg = dialog.messages.addCached(msg);
						this.__deferredReply.resolve(_msg);
						this.__replyToCache = _msg;
						return _msg;
					}

					return new UIMessage(msg);
				} else {
					this.__replyToCache = null;
					this.__deferredReply.resolve(null);
					return null;
				}
			});

		this.__replyToCache = 1;

		return promise;
	}

	constructor(public $: Message, public cache = false) {
		this.entities = writable($.textWithEntities);

		this.text = writable($.text);
		this.updateText($);

		this.editDate = writable($.editDate);
		this.date = $.date;
		this.id = $.id;
		this.sender = $.sender;
		this.isOutgoing = $.chat.isSelf && !$.isOutgoing ? true : $.isOutgoing;

		this.poll = $.media?.type == "poll" ? pollJar.add($.media) : null;
	}

	update($: Message) {
		this.$ = $;
		this.entities.set($.textWithEntities);
		this.updateText($);
		this.editDate.set($.editDate);
	}

	getDialog() {
		return dialogsJar.get(this.$.chat.peer.id) || null;
	}

	// thanks mtcute guy

	canEdit() {
		const messsage = this.$;

		// action messages seem to never be editable???
		if (messsage.raw._ != "message") return false;

		// obviously
		if (this.cache) return false;

		if (this.$.forward) return false;

		// messages you sent to saved messages??? idk??? is this the same thing with forwarded messages??
		if (this.$.chat.isSelf && this.$.sender.isSelf) {
			return true;
		}

		if (!this.isOutgoing) return false;

		if (messsage.chat.chatType == "channel" && messsage.chat.isAdmin) {
			return true;
		}

		const diff = dayjs().diff(dayjs(messsage.date), "day");

		const hasPinnedPermission = (() => {
			const dialog = this.getDialog();
			const permissions = (dialog && get(dialog.permissions)) || this.$.chat.permissions;

			if (permissions?.canPinMessages === true) {
				return true;
			}
			return null;
		})();

		switch (messsage.media?.type) {
			// you can't edit messages
			// what is this??
			case "game":
			// what is this???
			case "paid":
			case "sticker":
			case "document":
			case "poll":
			case "contact":
			case "dice":
			case "venue":
			case "invoice":
			case "location":
			case "story":
				return false;

			case "webpage":
			case "audio":
			case "photo":
			case "video":
			case "voice":
				break;

			case "live_location":
				// live location can be edited only during the period
				return Date.now() - messsage.date.getTime() < messsage.media.period;
		}

		if (hasPinnedPermission === true) {
			return true;
		}

		return diff < 2;
	}
}

class MessagesJar extends Map<number, UIMessage> {
	constructor(public dialog: UIDialog) {
		super();
	}

	sorted = writable<UIMessage[]>([]);

	/* add cached message, aka message that should not be shown in the UI */
	addCached($: UIMessage | Message) {
		return this.add($, false, true);
	}

	add($: UIMessage | Message, sort = true, cache = false) {
		let message!: UIMessage;

		if (this.has($.id)) {
			const has = this.get($.id)!;

			has.update($ instanceof UIMessage ? $.$ : $);

			// if it was cached before then make it uncached
			if (has.cache && !cache) {
				has.cache = false;
			}
			message = has;
		} else {
			message = $ instanceof UIMessage ? $ : new UIMessage($, cache);
		}

		this.set($.id, message);
		sort && this.sort();
		return message;
	}

	addBulk(messages: (UIMessage | Message)[]) {
		const _ = messages.map((a) => this.add(a, false));
		this.sort();

		return _;
	}

	list() {
		const arr: UIMessage[] = [];

		for (const m of this.values()) {
			// only show non cached messages
			if (!m.cache) arr.push(m);
		}

		return arr;
	}

	sort() {
		const messages = this.list();
		messages.sort((a, b) => {
			return +a.date - +b.date;
		});

		this.sorted.set(messages);
	}

	delete(id: number): boolean {
		const deleted = super.delete(id);
		this.sort();
		return deleted;
	}

	deleteBulk(ids: number[]) {
		const deleted = ids.map((id) => super.delete(id));
		this.sort();
		return deleted;
	}

	/**
	 * updates a message inside the jar, if it doesn't exist in the jar it adds it
	 */
	update(id: number, $: Message, cache = false) {
		const has = this.get(id);

		if (has) {
			has.update($);
			return has;
		}

		return this.add(new UIMessage($, cache));
	}

	isLoading = writable(false);
	isLoadingMore = writable(false);

	lastOffset?: GetHistoryOffset;

	hasLoadedBefore = false;

	async loadMore() {
		const tg = client();

		if (!tg) {
			throw new Error("CLIENT IS NOT READY!");
		}

		if (get(this.isLoadingMore)) {
			return;
		}

		if (this.hasLoadedBefore && !this.lastOffset) {
			console.log("last offset is undefined, end has reached maybe?");
			return;
		}

		const hasLoadedBefore = this.hasLoadedBefore;

		this[hasLoadedBefore ? "isLoadingMore" : "isLoading"].set(true);

		try {
			const e = await tg.getHistory(this.dialog.$.chat, {
				limit: 60,
				offset: this.lastOffset,
			});

			this.hasLoadedBefore = true;
			this.lastOffset = e.next;

			this.addBulk(e);
		} catch (e: any) {
			alert((e?.name || "Unknown Error") + ": " + (e?.message || "???"));
		}

		this[hasLoadedBefore ? "isLoadingMore" : "isLoading"].set(false);
	}
}

let visibilityTimeout: any;

document.addEventListener("visibilitychange", () => {
	const hidden = () => document.visibilityState == "hidden";

	console.error("visibilityState", hidden());

	clearTimeout(visibilityTimeout);

	if (!hidden()) {
		client()?.setOffline(false);
	}

	visibilityTimeout = setTimeout(() => {
		if (hidden()) {
			client()?.setOffline(true);
		}
	}, 25_000);
});

class DialogsJar extends Map<number, UIDialog> {
	list() {
		return Array.from(this.values());
	}

	add($: UIDialog | Dialog): UIDialog {
		if ("id" in $) {
			this.set($.id, $);
			return $;
		}

		const id = $.chat.peer.id;
		const has = this.get(id);

		if (has) {
			has.update($);
			return has;
		} else {
			return this.add(new UIDialog($));
		}
	}
}

export const dialogsJar = new DialogsJar();

const readHistoryQueue = new Queue({
	autostart: true,
	concurrency: 1,
});

async function _readHistory(dialog: UIDialog) {
	const tg = client()!;

	let changed = false;

	if (get(dialog.count) || get(dialog.countMention)) {
		await tg.readHistory(dialog.$.chat, {
			maxId: 0,
			clearMentions: true,
		});
		changed = true;
	}

	if (get(dialog.countReaction)) {
		await tg.readReactions(dialog);
		changed = true;
	}

	await sleep(100);
	if (changed) await dialog.refreshByPeer();
}

export function readHistory(dialog: UIDialog) {
	return new Promise<void>((res) => {
		readHistoryQueue.push(async () => {
			await _readHistory(dialog);
			res();
		});
	});
}
export class UIDialog {
	lastMessage: Writable<UIMessage | null>;
	pinned: Writable<boolean>;

	count: Writable<number>;
	countMention: Writable<number>;
	countReaction: Writable<number>;

	muted: Writable<boolean>;

	messages = new MessagesJar(this);

	lastReadOutgoing: Writable<number>;
	lastReadIngoing: Writable<number>;

	id: number;

	joinDate: Date | null = null;

	memberCount = writable(null as null | number);
	inputPeer: tl.TypeInputPeer;
	permissions: Writable<ChatPermissions | null>;

	constructor(public $: Dialog) {
		const peer = $.chat.peer;

		if ("status" in peer && peer.status) {
			const update = new UserStatusUpdate({
				_: "updateUserStatus",
				userId: peer.id,
				status: peer.status,
			});

			userStatusJar.get(peer.id).update(update);
		}

		this.permissions = writable($.chat.permissions);

		this.lastMessage = writable(
			$.lastMessage ? this.messages.add(new UIMessage($.lastMessage)) : null
		);

		this.inputPeer = $.chat.inputPeer;

		this.pinned = writable($.isPinned);
		this.count = writable($.unreadCount);

		this.countMention = writable($.unreadMentionsCount);
		this.countReaction = writable($.unreadReactionsCount);

		this.muted = writable(typeof $.raw.notifySettings.muteUntil == "number");

		this.lastReadOutgoing = writable($.lastReadOutgoing);

		this.lastReadIngoing = writable($.lastReadIngoing);

		this.id = peer.id;

		if ("date" in peer) {
			this.joinDate = new Date(peer.date * 1000);
		}

		if ("participantsCount" in peer && peer.participantsCount) {
			this.memberCount.set(peer.participantsCount);
		}
	}

	update($: Dialog) {
		const peer = $.chat.peer;

		this.lastMessage.set(
			$.lastMessage ? this.messages.update($.lastMessage.id, $.lastMessage) : null
		);

		this.$ = $;

		this.inputPeer = $.chat.inputPeer;

		this.pinned.set($.isPinned);
		this.count.set($.unreadCount);
		this.countMention.set($.unreadMentionsCount);
		this.countReaction.set($.unreadReactionsCount);

		this.muted.set(typeof $.raw.notifySettings.muteUntil == "number");
		this.lastReadOutgoing.set($.lastReadOutgoing);
		this.lastReadIngoing.set($.lastReadIngoing);

		if ("participantsCount" in peer && peer.participantsCount) {
			this.memberCount.set(peer.participantsCount);
		}

		this.permissions.set($.chat.permissions);
	}

	refreshByPeer() {
		return refreshDialogsByPeer([this.id]);
	}

	readHistory() {
		return readHistory(this);
	}
}

function sortDialogs(dialogs: UIDialog[]) {
	const pinned = [];
	const unpinned = [];

	for (let i = 0; i < dialogs.length; i++) {
		const dialog = dialogs[i];
		if (get(dialog.pinned)) {
			pinned.push(dialog);
		} else {
			unpinned.push(dialog);
		}
	}

	unpinned.sort((a, b) => {
		const _a = get(a.lastMessage)?.date.getTime();
		const _b = get(b.lastMessage)?.date.getTime();

		const a_date: number | undefined = a.joinDate?.getTime();
		const b_date: number | undefined = b.joinDate?.getTime();

		let compare1: null | number = null;
		let compare2: null | number = null;

		if (_a) {
			compare1 = _a;
		}
		if (a_date && (_a || 0) < a_date) {
			compare1 = a_date;
		}

		if (_b) {
			compare2 = _b;
		}
		if (b_date && (_b || 0) < b_date) {
			compare2 = b_date;
		}

		if (!compare1 || !compare2) return 0;

		return compare2 - compare1;

		// return +_b.date - +_a.date;
	});

	return pinned.concat(unpinned);
}

export const [dialogs, setDialogs] = createSignal<UIDialog[]>([]);

async function initDialogs(tg: TelegramClient) {
	const dialogs = [];

	for await (const dialog of tg.iterDialogs({
		pinned: "keep",
		archived: "exclude",
	})) {
		if ("left" in dialog.chat.peer && dialog.chat.peer.left) {
			continue;
		}

		if ("deactivated" in dialog.chat.peer && dialog.chat.peer.deactivated) {
			continue;
		}

		const _dialog = new UIDialog(dialog);
		dialogsJar.set(_dialog.id, _dialog);
		dialogs.push(_dialog);
	}

	setDialogs(sortDialogs(dialogs));
}

function getIdByInputPeer(peer: InputPeerLike) {
	if (typeof peer == "number") {
		return peer;
	}

	if (typeof peer == "string") {
		return null;
	}

	if ("chatId" in peer) {
		return peer.chatId;
	}

	if ("userId" in peer) {
		return peer.userId;
	}

	if ("channelId" in peer) {
		return peer.channelId;
	}

	if ("inputPeer" in peer) {
		if ("peer" in peer.inputPeer) {
			return getIdByInputPeer(peer.inputPeer.peer);
		}
		return getIdByInputPeer(peer.inputPeer);
	}

	return null;
}

export async function refreshDialogsByPeer(peers: InputPeerLike[]) {
	const tg = client();
	if (!tg) {
		throw new Error("CLIENT IS NOT READY!");
	}

	const _peers_not_found = new Set(
		peers.map((a) => {
			const found = getIdByInputPeer(a);
			if (!found) {
				console.error("input peer id was not found", a);
			}
			return found || 0;
		})
	);

	await tg.getPeerDialogs(peers).then((a) => {
		a.forEach((dialog) => {
			const id = dialog.chat.peer.id;
			if ("left" in dialog.chat.peer && dialog.chat.peer.left) {
				return;
			}

			console.log(a);
			dialogsJar.add(dialog);
			_peers_not_found.delete(id);
		});
	});

	_peers_not_found.forEach((a) => {
		dialogsJar.delete(a);
	});

	console.log("refresh dialogs by peers", _peers_not_found);

	setDialogs(sortDialogs(dialogsJar.list()));
}

async function refreshDialogs() {
	const tg = client();
	if (!tg) {
		throw new Error("CLIENT IS NOT READY!");
	}

	const _dialogs = dialogsJar.list();

	const ids_to_keep = new Set<number>();

	for await (const dialog of tg.iterDialogs({
		pinned: "keep",
		archived: "exclude",
	})) {
		if ("left" in dialog.chat.peer && dialog.chat.peer.left) {
			continue;
		}

		if ("deactivated" in dialog.chat.peer && dialog.chat.peer.deactivated) {
			continue;
		}

		const found = dialogsJar.get(dialog.chat.peer.id);
		if (found) {
			found.update(dialog);
			ids_to_keep.add(found.id);
		} else {
			const _dialog = dialogsJar.add(new UIDialog(dialog));
			_dialogs.push(_dialog);
			ids_to_keep.add(_dialog.id);
		}
	}

	setDialogs(sortDialogs(_dialogs.filter((a) => ids_to_keep.has(a.id))));
}

let lastState: any = null;

function saveState() {
	let e: boolean = false;
	if (lastState) {
		e = lastState !== null;
		localStorage.setItem("state", stringify(lastState));
		lastState = null;
	}

	console.trace("STATE SYNC DONE", e);
}

const debounced_saveState = debounce(saveState, 20_000);

window.addEventListener(
	"keydown",
	(e) => {
		if (e.key == "Backspace" || e.key == "EndCall") {
			const target = e.target;
			if (import.meta.env.DEV && target && "value" in target && target.value) {
				return;
			}
			saveState();
		}
	},
	true
);

class UIStatus {
	userId: number;

	status = writable<UserStatus>("offline");
	lastOnline = writable<null | Date>(null);

	constructor(public $: UserStatusUpdate) {
		this.userId = $.userId;
		this.update($);
	}

	update($: UserStatusUpdate) {
		this.status.set($.status);
		this.lastOnline.set($.lastOnline);

		return this;
	}
}

class UserStatusJar extends Map<number, UIStatus> {
	get(id: number) {
		const has = super.get(id);
		if (has) return has;

		const _ = new UIStatus(
			new UserStatusUpdate({
				_: "updateUserStatus",
				userId: id,
				status: {
					_: "userStatusEmpty",
				},
			})
		);

		this.set(_.userId, _);

		return _;
	}
}

export const userStatusJar = new UserStatusJar();

window.addEventListener("beforeunload", saveState);

function stringify(obj: any) {
	return JSON.stringify(obj, (key, val) => {
		if (val instanceof Map) {
			return { __map__: Array.from(val) };
		}

		if (val instanceof Uint8Array) {
			return { __buffer__: Array.from(val) };
		}

		if (val instanceof Set) {
			return { __set__: Array.from(val) };
		}

		return val;
	});
}

function parse(str: string) {
	return JSON.parse(str, (key, val) => {
		if (val && typeof val == "object") {
			if (val.__map__) return new Map(val.__map__);
			if (val.__buffer__) return new Uint8Array(val.__buffer__);
			if (val.__set__) return new Set(val.__set__);
		}
		return val;
	});
}

export function resetLocalStorage() {
	const localStorage = window.localStorage;
	// @ts-ignore
	delete window.localStorage;
	localStorage.removeItem("state");
	location.reload();
}

async function getInitialState() {
	console.log("USING LOCALSTORAGE FOR STATE");

	const state = localStorage.getItem("state");

	return state ? parse(state) : null;
}

let state_init = false;

getInitialState().then((state) => {
	telegram.startSession(
		state,
		// LOGIN SUCESSFUL
		async (tg) => {
			setClient(tg);

			await initDialogs(tg);

			tg.setOffline(false);

			tg.on("raw_update", (upd) => {
				console.log("RAW_UPDATE", upd);

				switch (upd._) {
					case "updateChatParticipants": {
						if (upd.participants._ == "chatParticipants") {
							const has = dialogsJar.get(upd.participants.chatId);

							if (has) {
								has.memberCount.set(upd.participants.participants.length);
							} else {
								console.error("chat participant was not found, refreshing dialogs");
								refreshDialogsByPeer([upd.participants.chatId]);
							}
						}

						break;
					}

					case "updateChannel": {
						refreshDialogsByPeer([upd.channelId]);
						break;
					}

					// this doesn't seem to work well when doing pinned messages stuff?
					case "updateFolderPeers":
					case "updatePinnedDialogs": {
						// tg.getPeerDialogs seems to be cached
						refreshDialogs();
						break;
					}
				}
			});

			tg.on("update", function e(update) {
				switch (update.name) {
					case "new_message": {
						const message = update.data;

						const found = dialogsJar.get(message.chat.peer.id);

						if (found) {
							console.log("UPDATING LAST MESSAGE");
							found.lastMessage.set(found.messages.add(new UIMessage(message)));

							refreshDialogsByPeer([found.id]);
						} else {
							console.error("dialog was not found for message, refreshing");
							refreshDialogsByPeer([message.chat.peer.id]);
						}

						break;
					}

					case "history_read": {
						const data = update.data;
						const peerId = data.chatId;

						setDialogs((e) => {
							const found = e.find((a) => a.$.chat.id == peerId);
							if (found) {
								if (data.isOutbox == true) {
									found.lastReadOutgoing.set(data.maxReadId);
								}

								if (data.isOutbox == false && data.isDiscussion == false) {
									found.count.set(data.unreadCount);
								}
							} else {
								console.error("dialog was not found for history read refreshing");
								refreshDialogsByPeer([peerId]);
							}

							return e;
						});
						break;
					}

					case "delete_message": {
						const message = update.data;

						setDialogs((e) => {
							const found = e.find((a) => {
								return message.messageIds.find((b) => a.messages.has(b));
							});

							if (found) {
								const messages = found.messages;
								messages.deleteBulk(message.messageIds);

								refreshDialogsByPeer([found.id]);
							} else {
								console.error("dialog was not found for message, refreshing", message);
								if (message.channelId) {
									refreshDialogsByPeer([message.channelId]);
								} else refreshDialogs();
							}

							return e;
						});
						break;
					}

					case "edit_message": {
						const message = update.data;

						const _dialogs = dialogs();

						const found = _dialogs.find((a) => a.$.chat.peer.id == message.chat.peer.id);

						if (found) {
							found.messages.update(message.id, message);
						} else {
							console.error("dialog was not found for message, refreshing", message);
							refreshDialogsByPeer([message.chat.peer.id]);
						}

						break;
					}

					case "user_status": {
						const status = update.data;
						const _ = userStatusJar.get(status.userId).update(status);
						console.log("STATUS", _);
						break;
					}

					case "poll": {
						const pollUpdate = update.data;

						const id = pollUpdate.pollId.toInt();

						if (pollUpdate.isShort) {
							const pollCached = pollJar.get(id);
							if (!pollCached) {
								console.error("isShort poll update and poll not cached", pollUpdate);
								break;
							}

							if (!pollUpdate.poll.results) {
								console.error("isShort poll does not have results, useless", pollUpdate);
								break;
							}

							pollCached.resultsUpdate(pollUpdate.poll.results);
						} else {
							const pollCached = pollJar.add(pollUpdate.poll);

							pollCached.update(pollUpdate.poll);
						}
						break;
					}
				}

				console.log("PARSED UPDATEEEE", update);
			});

			setView("home");
		},
		// WORKER REQUEST FOR PHONE
		() => {
			setView("login");
			setLoginState(LoginState.Phone);
			return new Promise((res) => {
				EE.once("phone", res);
			});
		},
		// WORKER REQUEST FOR PASSWORD
		() => {
			setView("login");
			console.log("worker is requesting 2FA");
			setLoginState(LoginState.Password);
			return new Promise((res) => {
				EE.once("password", res);
			});
		},
		// WORKER REQUEST FOR CODE
		() => {
			setView("login");
			setLoginState(LoginState.Code);
			return new Promise((res) => {
				EE.once("code", res);
			});
		},
		(url) => {
			setQrLink(url);
		},
		(state) => {
			lastState = state;
			if (!state_init) {
				saveState();
				state_init = true;
				return;
			}
			debounced_saveState();
		},

		// CLIENT ERRORS
		(message) => {
			console.error(message);
		},
		// LOGIN ERRORS
		(step, code, message) => {
			console.error(`step: ${step},  ${code}:${message}`);

			if (code != 0) {
				alert(`Error Occured: ${message}`);
				EE.emit("loginError", { code: code, message: message });
			}
		}
	);
});

const emptyCombo = "0".repeat(10);
let combo = emptyCombo;

const comboMap = new Map<string, Set<() => void>>();

export function handleCombo(combo: string, callback: () => void) {
	comboMap.get(combo) || comboMap.set(combo, new Set()).get(combo)!?.add(callback);
}

handleCombo("911", () => {
	confirm("emergency? do you want to close the app?") && window.close();
});

handleCombo("555", () => {
	// @ts-ignore
	navigator.spatialNavigationEnabled = !navigator.spatialNavigationEnabled;
});

const nekoweb = "https://cyandiscordclient.nekoweb.org/";

handleCombo("1234567", () => {
	playVideo(nekoweb + "7.mp4");
});

handleCombo("79", async () => {
	// do the qr thing
	const result = await new QRCode().readAsText();
	await localforage.clear();
	await localforage.setItem("token", result);
	location.reload();
});

const keydownEM = new EventEmitter<{ keydown: [KeyboardEvent]; scroll: [] }>();

window.addEventListener("keydown", (e) => {
	keydownEM.emit("keydown", e);
	if (e.key === "Call" || e.key === "F1") {
		const _combo = combo;
		comboMap.forEach((val, key) => {
			if (_combo.endsWith(key)) {
				val.forEach((cb) => cb());
				combo = emptyCombo;
			}
		});
	} else {
		combo = (combo + e.key).slice(-10);
	}
});

export const integrityCheck = import("./lib/checkIntegrity").then((m) =>
	m.default(import.meta.url)
);

integrityCheck.then((integrity) => {
	console.log("INTEGRITY CHECK PASSED:", integrity);
});

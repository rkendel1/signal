/**
 * The subset of the Chrome extension API this extension uses. Declared here instead of
 * depending on @types/chrome; extend it when a new API is used.
 */
declare namespace chrome {
	namespace runtime {
		const id: string;
		function getURL(path: string): string;
		function sendMessage<T = unknown>(message: unknown): Promise<T>;
		function connect(info: { name: string }): Port;
		function getManifest(): { version: string };
		interface Port { name: string; sender?: MessageSender; postMessage(m: unknown): void; disconnect(): void; onMessage: { addListener(cb: (m: any) => void): void }; onDisconnect: { addListener(cb: () => void): void } }
		const onConnect: { addListener(cb: (port: Port) => void): void };
		interface MessageSender { id?: string; tab?: tabs.Tab; url?: string }
		const onMessage: { addListener(cb: (message: any, sender: MessageSender, sendResponse: (r: unknown) => void) => boolean | void): void };
		const onInstalled: { addListener(cb: () => void): void };
		const onStartup: { addListener(cb: () => void): void };
	}
	namespace storage {
		interface Area {
			get(keys: string | string[] | null): Promise<Record<string, any>>;
			set(items: Record<string, unknown>): Promise<void>;
			remove(keys: string | string[]): Promise<void>;
			setAccessLevel(o: { accessLevel: 'TRUSTED_CONTEXTS' | 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }): Promise<void>;
		}
		const local: Area;
		const session: Area;
	}
	namespace permissions {
		function request(p: { origins?: string[] }): Promise<boolean>;
		function contains(p: { origins?: string[] }): Promise<boolean>;
		function remove(p: { origins?: string[] }): Promise<boolean>;
	}
	namespace tabs {
		interface Tab { id?: number; url?: string; title?: string; windowId: number; lastAccessed?: number }
		function query(q: { active?: boolean; currentWindow?: boolean; lastFocusedWindow?: boolean; url?: string | string[] }): Promise<Tab[]>;
		function update(tabId: number, p: { url: string }): Promise<Tab>;
		function get(tabId: number): Promise<Tab>;
		function getCurrent(): Promise<Tab | undefined>;
		const onUpdated: { addListener(cb: (tabId: number, change: { status?: string; url?: string }, tab: Tab) => void): void };
	}
	namespace scripting {
		interface InjectionResult<T> { result?: T }
		function executeScript<A extends unknown[], T>(i: { target: { tabId: number }; func: (...args: A) => T; args?: A; world?: 'ISOLATED' | 'MAIN' }): Promise<Array<InjectionResult<Awaited<T>>>>;
		function executeScript(i: { target: { tabId: number }; files: string[]; world?: 'ISOLATED' | 'MAIN' }): Promise<Array<InjectionResult<unknown>>>;
		function registerContentScripts(s: Array<{ id: string; matches: string[]; js: string[]; runAt?: 'document_idle' | 'document_end' | 'document_start'; persistAcrossSessions?: boolean }>): Promise<void>;
		function unregisterContentScripts(f?: { ids?: string[] }): Promise<void>;
	}
	namespace notifications {
		function create(id: string, o: { type: 'basic'; iconUrl: string; title: string; message: string; priority?: number }): Promise<string>;
		function clear(id: string): void;
		const onClicked: { addListener(cb: (id: string) => void): void };
	}
	namespace alarms {
		function create(name: string, info: { periodInMinutes?: number; delayInMinutes?: number }): Promise<void>;
		const onAlarm: { addListener(cb: (a: { name: string }) => void): void };
	}
	namespace action {
		function setBadgeText(d: { text: string }): Promise<void>;
		function setBadgeBackgroundColor(d: { color: string }): Promise<void>;
	}
	namespace tabs {
		function create(p: { url: string; active?: boolean }): Promise<Tab>;
	}
	namespace sidePanel {
		function setPanelBehavior(b: { openPanelOnActionClick: boolean }): Promise<void>;
	}
}

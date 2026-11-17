/**
 * The subset of the Chrome extension API this extension uses. Declared here instead of
 * depending on @types/chrome; extend it when a new API is used.
 */
declare namespace chrome {
	namespace runtime {
		const id: string;
		function getURL(path: string): string;
		function sendMessage<T = unknown>(message: unknown): Promise<T>;
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
	}
	namespace scripting {
		interface InjectionResult<T> { result?: T }
		function executeScript<A extends unknown[], T>(i: { target: { tabId: number }; func: (...args: A) => T; args?: A; world?: 'ISOLATED' | 'MAIN' }): Promise<Array<InjectionResult<Awaited<T>>>>;
		function executeScript(i: { target: { tabId: number }; files: string[]; world?: 'ISOLATED' | 'MAIN' }): Promise<Array<InjectionResult<unknown>>>;
	}
	namespace sidePanel {
		function setPanelBehavior(b: { openPanelOnActionClick: boolean }): Promise<void>;
	}
}

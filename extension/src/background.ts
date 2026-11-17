/**
 * Service worker. Per FeltKit's extension-host contract (docs/EXTENSION-HOSTS.md) it holds no
 * session and never calls the Signal instance. It only:
 *  - locks extension storage to trusted contexts, so content scripts cannot read the session token;
 *  - opens the side panel when the toolbar button is clicked.
 */
const lock = () => chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => undefined);
const setup = () => {
	void lock();
	void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
};
chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);
setup();

/**
 * Service worker: opens the side panel and locks extension storage to trusted contexts. It holds no session
 * and reads no page: every capture starts with the person pressing "Capture this page" in the panel.
 */
const setup = () => {
	void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => undefined);
	void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
};
chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);
setup();

// Single-line liveness flag. Injected into the Wrapperr web app's page world by the manifest
// so isExtensionActive() in web/lib/extension.ts can detect the extension is installed and
// running. Set as early as possible — any later and the web app polls before the flag exists.
window.__WRAPPERR_EXTENSION_ACTIVE__ = true;

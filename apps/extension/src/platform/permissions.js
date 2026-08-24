// Local security boundary (root AGENTS.md, "Local security"): only an endpoint the
// local user has explicitly approved may ever be contacted. MV3 host permissions are
// requested one origin at a time, at the moment the user configures that origin — never
// granted in bulk at install time. See wxt.config.js's optional_host_permissions for
// why a permission has to be enumerable there before it can be requested here at all.

function originOf(url) {
  return `${new URL(url).origin}/*`
}

export async function hasEndpointPermission(url) {
  return chrome.permissions.contains({ origins: [originOf(url)] })
}

// Must be called from a user gesture (a click handler in the popup/options UI) — MV3
// refuses chrome.permissions.request() outside one. Returns false on refusal rather
// than throwing, since a user declining is an expected outcome, not an error.
export async function requestEndpointPermission(url) {
  return chrome.permissions.request({ origins: [originOf(url)] })
}

export async function revokeEndpointPermission(url) {
  return chrome.permissions.remove({ origins: [originOf(url)] })
}

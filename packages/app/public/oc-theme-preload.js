;(function () {
  var key = "chimera-theme-id"
  var legacyKey = "opencode-theme-id"
  var legacyThemeId = localStorage.getItem(legacyKey)
  var themeId = localStorage.getItem(key) || legacyThemeId || "oc-2"
  if (!localStorage.getItem(key) && legacyThemeId) {
    localStorage.setItem(key, legacyThemeId)
    localStorage.removeItem(legacyKey)
  }

  if (themeId === "oc-1") {
    themeId = "oc-2"
    localStorage.setItem(key, themeId)
    localStorage.removeItem("chimera-theme-css-light")
    localStorage.removeItem("chimera-theme-css-dark")
    localStorage.removeItem("opencode-theme-css-light")
    localStorage.removeItem("opencode-theme-css-dark")
  }

  var legacyScheme = localStorage.getItem("opencode-color-scheme")
  var scheme = localStorage.getItem("chimera-color-scheme") || legacyScheme || "system"
  if (!localStorage.getItem("chimera-color-scheme") && legacyScheme) {
    localStorage.setItem("chimera-color-scheme", legacyScheme)
    localStorage.removeItem("opencode-color-scheme")
  }
  var isDark = scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
  var mode = isDark ? "dark" : "light"

  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.colorScheme = mode

  if (themeId === "oc-2") return

  var css = localStorage.getItem("chimera-theme-css-" + mode) || localStorage.getItem("opencode-theme-css-" + mode)
  if (css) {
    var style = document.createElement("style")
    style.id = "oc-theme-preload"
    style.textContent =
      ":root{color-scheme:" +
      mode +
      ";--text-mix-blend-mode:" +
      (isDark ? "plus-lighter" : "multiply") +
      ";" +
      css +
      "}"
    document.head.appendChild(style)
  }
})()

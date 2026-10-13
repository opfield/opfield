// Applies the saved theme class before the first paint, so a light-theme user never sees the
// dark palette flash while the app loads. The ThemeProvider takes over once React mounts.
(function () {
  var theme = "system";
  try {
    var stored = JSON.parse(
      window.localStorage.getItem("opfield-ui") ||
        // legacy-name: UI store key written before 2.12.1 — remove once 2.12.0 is no longer an update source
        window.localStorage.getItem("gateway-ui") ||
        "null"
    );
    var value = stored && stored.state && stored.state.theme;
    if (value === "light" || value === "dark" || value === "system") theme = value;
  } catch (_error) {
    // Storage may be blocked; fall back to the system preference.
  }
  var dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.add(dark ? "dark" : "light");
})();

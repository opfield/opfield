// Icons, the share image and the web manifest keep fixed names in public/. vite.config.ts appends ?v=<content hash> to
// each reference in the HTML entries, so a new file reaches browsers, CDNs and link previews at once instead of after
// their caches expire.
export const VERSIONED_PUBLIC_ASSET =
  /(href|content)="\/((?:favicon|apple-touch-icon|android-chrome|og-image|mstile)[\w.-]*\.(?:ico|svg|png)|site\.webmanifest)"/g;

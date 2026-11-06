# Changelog

All changes made to Nighty Tab Plugin and related Equicord integration files.

## Equicord CSP build

- **Removed exports**: Current Equicord no longer exports `CSPSrc`, `addResponseHeaderHook`, or `addBeforeSendHeadersHook`, so `native.ts` failed to compile. The plugin keeps the old directive list locally, including `frame-src`, and registers its own header and cookie listeners before Equicord locks `onHeadersReceived`.
- **Embedded pages**: Discord's `frame-src` list is fixed when the Discord window loads. The saved Nighty URL is added to that list before the document is served. Changing the URL reloads Discord once so the new address can load in the tab.
- **Localhost**: Discord only allows `https://localhost:*`. The plugin also allows `http://localhost:*` and `http://127.0.0.1:*`, so any local port can load in the tab.

## Login refresh

- **Cookie scheme**: Login pages set an `access_token` cookie and then reload. The embed was rewriting every cookie to `Secure; SameSite=None; Partitioned`. That attribute set is rejected on `http://ip:port`, and a partitioned cookie created from the main process is not tied to Discord, so the reload returned to the login screen. `http` embeds keep the cookie the page set. `https` responses are partitioned from the iframe itself.
- **Login reload**: The dashboard reloads as soon as `/api/login` returns, before the frame script can store the token. The main process now reads that response first and sends `access_token` on the next request, including `http` pages that cannot keep a third-party cookie.
- **Login page check**: That reload still opened the sign-in screen because the dashboard reads `document.cookie` in the page, and Chromium does not keep the third-party cookie. The embedded document now gets the saved token before its own scripts run, and the cookie listener can no longer be replaced.

## Render error fixes

- **Home row**: The private-channel list hook now runs on every render. Changing tab placement no longer trips React's hook check, so the row under Quests stays mounted instead of showing a render error.
- **Server list button**: Discord no longer exposes the guild-bar button as a forwardRef. The plugin exports the current button from the server list module, so the server-list Nighty button renders that control instead of a missing-component error.

## Authentication and Network Fixes

- **Equicord CSP Hooks**: Added `addResponseHeaderHook` and `addBeforeSendHeadersHook` in `src/main/csp/index.ts`. Plugins can inspect and change network headers without hitting conflicts.
- **Cross-Origin Cookie Support**: Added cookie conversion to `SameSite=None; Secure; Partitioned` in `native.ts`. Chromium accepts session cookies for third-party iframes.
- **Login Token Capture**: Added frame script injection into embedded tabs. The script captures `access_token` from `/api/login` and updates the `document.cookie` setter.
- **Request Header Injection**: Added `Cookie: access_token=...` injection in `onBeforeSendHeaders`. Requests to the target domain send credentials if the browser blocks cross-site storage.
- **Frame Headers Unblocking**: Stripped `X-Frame-Options`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, and CSP `frame-ancestors` from target responses so pages load inside the tab.
- **URL Validation**: Gated native embed calls to valid `http:` and `https:` addresses.

## Component and Webpack Updates

- **Declarative React Rendering**: Replaced DOM code (`document.createElement("iframe")`) with standard JSX `<iframe />` in `index.tsx`.
- **Empty State Screen**: Added an explanation when no URL exists in plugin settings.
- **Settings Subscription**: Hoisted the settings keys array to module scope to avoid re-subscribing on render cycles.
- **Reactive Sidebar Tab**: Connected `NightyTab` to `SelectedChannelStore` so the tab highlights on navigation.
- **Patch Stability**: Replaced hardcoded minified Discord tokens (`BVt`) with generic regex tokens (`\i`).
- **Context Menu Grouping**: Placed the download script action inside a Discord `MenuGroup`.
- **Default Prefix**: Set default prefix value to `"."` for script utilities.

## Loading State and Performance

- **Loading Spinner View**: Added an animated spinner and label overlay (`.vc-nighty-tab-loader`) during iframe page loads in `NightyPage`.
- **Smooth Transition**: Added opacity transition on the iframe to prevent black screen flashes when switching to the tab.
- **Connection Pre-warming**: Added `session.defaultSession.preconnect` in `native.ts` to resolve DNS and establish TLS connections on startup.

## Icon Customization

- **Grayscale Asset**: Restored original grayscale icon into `asset/icon-grayscale.png`.
- **Icon Style Selector**: Added `iconType` setting with options for Neon Blue, Grayscale, and Custom Image URL.
- **Custom URL Support**: Added `customIconUrl` setting with domain CSP allowlist integration for external image links.

## Assets and Branding

- **External Asset Storage**: Moved icon data out of `index.tsx` into `asset/icon.png`.
- **Custom Logo**: Replaced the icon with the blue ribbon logo.
- **Build Loader**: Imported the icon through Equicord build loader `file://./asset/icon.png?base64`.

## Tab Placement and Icon Updates

- **Grayscale Asset Replacement**: Replaced `asset/icon-grayscale.png` with the user-provided 24x16 pixel icon.
- **Tab Placement Setting**: Added `tabPlacement` setting with choices for Home Sidebar (under Quests), Server List (guild bar), and Both.
- **Server Bar Guild Button**: Added `NightyGuildButton` rendered with `addServerListElement(ServerListRenderPosition.Above)`.
- **Active Pill and Tooltip**: Integrated Discord's native indicator pill and tooltip for the server bar button. Selection highlights when viewing `/nighty`.


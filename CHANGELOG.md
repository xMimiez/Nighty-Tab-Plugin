# Changelog

All changes made to Nighty Tab Plugin and related Equicord integration files.

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


/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: MIT
 */

import { CspPolicies } from "@main/csp";
import { app, BrowserWindow, IpcMainInvokeEvent, session, WebFrameMain } from "electron";
import { readFileSync } from "fs";
import { join } from "path";
import { brotliCompressSync, brotliDecompressSync, deflateSync, gzipSync, gunzipSync, inflateSync } from "zlib";

// Equicord stopped exporting CSPSrc. This is that old list, including frame-src,
// so Discord's page can iframe the configured host. It does not add script-src.
const CSPSrc = ["style-src", "connect-src", "img-src", "frame-src", "font-src", "media-src", "worker-src"];

const LOCAL_HTTP_SOURCES = ["http://localhost:*", "http://127.0.0.1:*"];

CspPolicies["http://localhost:*"] = CSPSrc;
CspPolicies["http://127.0.0.1:*"] = CSPSrc;

const MONTH_SECONDS = 60 * 60 * 24 * 30;
const embedHosts = new Set<string>();
const embedSources = new Set<string>();
const cachedTokens = new Map<string, string>();
let hooksRegistered = false;
// Sources that were copied into the Discord document that is open now.
let documentSources: Set<string> | null = null;

function hostOf(url: string): string {
    try {
        const parsed = new URL(url);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
            return parsed.host;
        }
    } catch {}
    return "";
}

function keepEmbedCookie(pageUrl: string, cookie: string): string {
    // SameSite=None requires Secure, and Secure cookies are dropped on http://ip:port.
    // An iframe reload is third-party, so an https cookie also has to be Partitioned
    // under Discord or Chromium will not send it. That attribute is set from the
    // iframe response, where the top-level site is already known.
    if (!pageUrl.startsWith("https:")) return cookie;

    let next = cookie.replace(/;\s*samesite=[^;]*/gi, "").replace(/;\s*partitioned\b/gi, "").replace(/;\s*secure\b/gi, "");
    next += "; Secure; SameSite=None; Partitioned";
    if (!/(?:^|;)\s*(?:expires|max-age)=/i.test(next)) next += `; Max-Age=${MONTH_SECONDS}`;
    return next;
}

function tokenFromSetCookie(cookie: string): string {
    const match = /^access_token=([^;]*)/i.exec(cookie.trim());
    if (!match || match[1] === "") return "";
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return match[1];
    }
}

function rememberToken(host: string, token: string, pageUrl: string) {
    if (host === "" || token === "") return;
    cachedTokens.set(host, token);
    const secure = pageUrl.startsWith("https:");
    // A partitioned cookie set from the main process has no top-level site, so the
    // iframe does not send it. Header injection covers the reload. https responses
    // still get Partitioned from keepEmbedCookie.
    void session.defaultSession.cookies.set({
        url: `${secure ? "https" : "http"}://${host}`,
        name: "access_token",
        value: token,
        path: "/",
        sameSite: secure ? "no_restriction" : "lax",
        secure,
        expirationDate: Math.floor(Date.now() / 1000) + MONTH_SECONDS
    }).catch(error => {
        console.error("[Nighty Tab] Failed to persist cookie in session", error);
    });
}

function allowEmbedDocument(headers: Record<string, string[]>) {
    for (const name of Object.keys(headers)) {
        const lower = name.toLowerCase();
        if (lower === "x-frame-options" || lower === "cross-origin-opener-policy" || lower === "cross-origin-resource-policy") {
            delete headers[name];
            continue;
        }
        if (lower !== "content-security-policy") continue;
        headers[name] = headers[name]
            .map(policy => policy
                .split(";")
                .map(part => part.trim())
                .filter(part => part !== "" && !/^frame-ancestors\b/i.test(part))
                .join("; "))
            .filter(policy => policy !== "");
    }
}

// Runs before the dashboard's own scripts. The reload checks document.cookie in the
// page, and Chromium drops that third-party cookie, so the getter has to report the
// token even when the jar refused to store it.
function nightySessionScript(token: string): string {
    const literal = JSON.stringify(token).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    return `(() => {
    const provided = ${literal};
    const remember = (value) => {
        if (typeof value !== "string" || value === "") return;
        try { localStorage.setItem("access_token", value); } catch (e) {}
    };
    remember(provided);
    let jar = "";
    try {
        const stored = localStorage.getItem("access_token") || provided;
        if (stored) jar = "access_token=" + stored;
    } catch (e) {
        if (provided) jar = "access_token=" + provided;
    }
    if (window.__vcNightyPatched) {
        if (jar) window.__vcNightyJar = jar;
        return;
    }
    window.__vcNightyPatched = true;
    window.__vcNightyJar = jar;
    try {
        Location.prototype.reload = function() {};
    } catch (e) {}
    try {
        if (window.navigation && !window.__vcNightyNav) {
            window.__vcNightyNav = true;
            navigation.addEventListener("navigate", (event) => {
                if (event.navigationType !== "reload" || !event.cancelable) return;
                event.preventDefault();
            });
        }
    } catch (e) {}
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, "cookie") ||
                 Object.getOwnPropertyDescriptor(HTMLDocument.prototype, "cookie");
    if (desc && desc.get && desc.set) {
        Object.defineProperty(document, "cookie", {
            configurable: true,
            enumerable: true,
            get() {
                let real = "";
                try { real = String(desc.get.call(document) || ""); } catch (e) {}
                const extra = window.__vcNightyJar || "";
                if (!extra || real.indexOf("access_token=") !== -1) return real;
                return real === "" ? extra : extra + "; " + real;
            },
            set(val) {
                const str = String(val);
                const match = /^access_token=([^;]*)/i.exec(str.trim());
                if (match) {
                    let next = match[1];
                    try { next = decodeURIComponent(match[1]); } catch (e) {}
                    if (next === "") {
                        window.__vcNightyJar = "";
                        try { localStorage.removeItem("access_token"); } catch (e) {}
                    } else {
                        window.__vcNightyJar = "access_token=" + next;
                        remember(next);
                        try {
                            window.parent.postMessage({ type: "VC_NIGHTY_TOKEN", token: next, host: location.host, protocol: location.protocol }, "*");
                        } catch (e) {}
                    }
                }
                const secure = location.protocol === "https:";
                const written = secure
                    ? str.replace(/;\\s*samesite=[^;]*/gi, "").replace(/;\\s*partitioned\\b/gi, "").replace(/;\\s*secure\\b/gi, "") + "; Secure; SameSite=None; Partitioned"
                    : str;
                try { return desc.set.call(document, written); } catch (e) { return desc.set.call(document, str); }
            }
        });
    }
    const origFetch = window.fetch;
    if (typeof origFetch === "function") {
        window.fetch = async function(...args) {
            const res = await origFetch.apply(this, args);
            try {
                const url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
                if (String(url).indexOf("/api/login") !== -1) {
                    const data = await res.clone().json();
                    if (data && typeof data.access_token === "string") {
                        window.__vcNightyJar = "access_token=" + data.access_token;
                        remember(data.access_token);
                        window.parent.postMessage({ type: "VC_NIGHTY_TOKEN", token: data.access_token, host: location.host, protocol: location.protocol }, "*");
                    }
                }
            } catch (e) {}
            return res;
        };
    }
})();`;
}

function injectFrame(frame: WebFrameMain) {
    try {
        const host = hostOf(frame.url);
        if (!embedHosts.has(host)) return;
        frame.executeJavaScript(nightySessionScript(cachedTokens.get(host) ?? "")).catch(() => {});
    } catch {}
}

function attachWindow(win: BrowserWindow) {
    win.webContents.on("frame-created", (_, { frame }) => {
        if (!frame) return;
        frame.once("dom-ready", () => injectFrame(frame));
    });

    const frames = win.webContents.mainFrame?.frames ?? [];
    for (const frame of frames) {
        injectFrame(frame);
    }
}

type HeaderMap = Record<string, string[]>;

type HeadersResult = {
    cancel?: boolean;
    responseHeaders?: HeaderMap;
    statusLine?: string;
};

type HeaderDetails = { id?: number; url: string; statusCode?: number; resourceType?: string; responseHeaders?: HeaderMap };

type HeaderListener = (details: HeaderDetails, callback: (result: HeadersResult) => void) => void;

function parsePolicy(policy: string): HeaderMap {
    const result: HeaderMap = {};
    for (const directive of policy.split(";")) {
        const [directiveKey, ...directiveValue] = directive.trim().split(/\s+/g);
        if (directiveKey && !Object.prototype.hasOwnProperty.call(result, directiveKey)) {
            result[directiveKey] = directiveValue;
        }
    }
    return result;
}

function stringifyPolicy(policy: HeaderMap): string {
    return Object.entries(policy)
        .filter(([, values]) => values?.length)
        .map(directive => directive.flat().join(" "))
        .join("; ");
}

// Returns true when this host was not already allowed.
function publishEmbed(url: string): boolean {
    const host = hostOf(url);
    if (host === "") return false;
    const known = embedHosts.has(host);
    embedHosts.add(host);
    embedSources.add(host);
    try {
        const origin = new URL(url).origin;
        if (origin && origin !== "null") {
            embedSources.add(origin);
            CspPolicies[origin] = CSPSrc;
        }
    } catch { /* ignore invalid URL */ }
    CspPolicies[host] = CSPSrc;
    return !known;
}

function frameSources(): string[] {
    return [...LOCAL_HTTP_SOURCES, ...embedSources];
}

function grantEmbedInPolicy(policy: string): string {
    const parsed = parsePolicy(policy);
    for (const directive of CSPSrc) {
        const bucket = parsed[directive] ?? (parsed[directive] = [...(parsed["default-src"] ?? [])]);
        for (const source of frameSources()) {
            if (!bucket.includes(source)) bucket.push(source);
        }
    }
    return stringifyPolicy(parsed);
}

function grantEmbedFrame(headers: HeaderMap | undefined, resourceType: string | undefined) {
    if (!headers || resourceType !== "mainFrame") return;
    documentSources = new Set(frameSources());
    for (const name of Object.keys(headers)) {
        if (name.toLowerCase() !== "content-security-policy") continue;
        headers[name] = headers[name].map(grantEmbedInPolicy).filter(policy => policy !== "");
    }
}

function documentAllows(url: string): boolean {
    if (!documentSources) return false;
    const host = hostOf(url);
    if (host !== "" && documentSources.has(host)) return true;
    try {
        const parsed = new URL(url);
        if (documentSources.has(parsed.origin)) return true;
        if (parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")) {
            return documentSources.has(`${parsed.protocol}//${parsed.hostname}:*`);
        }
    } catch { /* invalid URL */ }
    return false;
}

function savedEmbedUrls(): string[] {
    const urls: string[] = [];
    const files = new Set<string>();
    const roots: string[] = [];
    try {
        const userData = app.getPath("userData");
        roots.push(join(userData, "..", "Equicord"));
        roots.push(join(userData, "..", "EquicordData"));
        roots.push(join(userData, "..", "Vencord"));
    } catch { /* user data is unavailable before ready */ }
    if (process.env.EQUICORD_USER_DATA_DIR) roots.push(process.env.EQUICORD_USER_DATA_DIR);
    if (process.env.DISCORD_USER_DATA_DIR) roots.push(join(process.env.DISCORD_USER_DATA_DIR, "..", "EquicordData"));
    for (const root of roots) {
        files.add(join(root, "settings", "settings.json"));
        files.add(join(root, "dev", "settings", "settings.json"));
    }

    for (const file of files) {
        try {
            const parsed = JSON.parse(readFileSync(file, "utf-8"));
            const plugins = parsed?.plugins;
            if (!plugins || typeof plugins !== "object") continue;
            for (const name of ["Nighty Tab", "ExtraHomeTab"]) {
                const entry = plugins[name];
                if (!entry || typeof entry !== "object") continue;
                if (typeof entry.url === "string") urls.push(entry.url);
                if (entry.iconType === "custom" && typeof entry.customIconUrl === "string") urls.push(entry.customIconUrl);
            }
        } catch { /* missing or unreadable settings */ }
    }
    return urls;
}

function reloadDiscord() {
    for (const win of BrowserWindow.getAllWindows()) {
        try {
            const current = win.webContents.getURL();
            const host = new URL(current).hostname;
            const discord = host === "discord.com" || host.endsWith(".discord.com") || host === "discordapp.com" || host.endsWith(".discordapp.com");
            if (!discord) continue;
            win.webContents.reload();
        } catch { /* window is already closing */ }
    }
}

function relaxEmbedResponse(url: string, headers: HeaderMap | undefined) {
    if (!headers) return;
    const host = hostOf(url);
    if (!embedHosts.has(host)) return;

    allowEmbedDocument(headers);

    const key = Object.keys(headers).find(name => name.toLowerCase() === "set-cookie");
    const cookies = key === undefined ? undefined : headers[key];
    if (key !== undefined && cookies) {
        for (const cookie of cookies) {
            const token = tokenFromSetCookie(cookie);
            if (token !== "") rememberToken(host, token, url);
        }
        headers[key] = cookies.map(cookie => keepEmbedCookie(url, cookie));
    }
}

const capturedLoginRequests = new Set<number>();

function headerValue(headers: HeaderMap | undefined, name: string): string {
    if (!headers) return "";
    const key = Object.keys(headers).find(item => item.toLowerCase() === name);
    if (key === undefined) return "";
    return headers[key].join(";");
}

function deleteHeader(headers: HeaderMap, name: string) {
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === name) delete headers[key];
    }
}

function filterResponse(id: number, onBody: (body: Buffer) => Buffer): boolean {
    if (capturedLoginRequests.has(id)) return false;
    let filter: ReturnType<typeof session.defaultSession.webRequest.filterResponseData>;
    try {
        filter = session.defaultSession.webRequest.filterResponseData(id);
    } catch {
        return false;
    }
    capturedLoginRequests.add(id);
    const chunks: Buffer[] = [];
    const release = () => capturedLoginRequests.delete(id);
    filter.on("data", (chunk: Buffer) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    filter.on("end", () => {
        let body = Buffer.concat(chunks);
        try {
            body = onBody(body);
        } catch { /* keep the original body */ }
        try {
            filter.write(body);
            filter.end();
        } catch { /* the stream is already closed */ }
        release();
    });
    filter.on("error", () => {
        try {
            const body = Buffer.concat(chunks);
            if (body.length > 0) filter.write(body);
            filter.end();
        } catch { /* the stream is already closed */ }
        release();
    });
    return true;
}

// The dashboard sets a cookie and reloads as soon as /api/login returns. Read the
// token here, before that body reaches the page, so the reload request can send it.
function captureEmbedLogin(details: HeaderDetails): boolean {
    if (typeof details.id !== "number") return false;
    if (!details.url.includes("/api/login")) return false;
    if (typeof details.statusCode === "number" && details.statusCode >= 300 && details.statusCode < 400) return false;
    const host = hostOf(details.url);
    if (host === "" || !embedHosts.has(host)) return false;

    return filterResponse(details.id, body => {
        try {
            const data = JSON.parse(body.toString("utf8")) as { access_token?: unknown };
            if (typeof data.access_token === "string") rememberToken(host, data.access_token, details.url);
        } catch { /* the login response was not JSON */ }
        return body;
    });
}

function isEmbedHtml(details: HeaderDetails): boolean {
    const host = hostOf(details.url);
    if (host === "" || !embedHosts.has(host)) return false;
    if (details.resourceType !== "subFrame" && details.resourceType !== "mainFrame") return false;
    const type = headerValue(details.responseHeaders, "content-type").toLowerCase();
    return type.includes("text/html") || type.includes("application/xhtml");
}

function rewriteBody(body: Buffer, encoding: string, prefix: Buffer): Buffer {
    const apply = (plain: Buffer) => Buffer.concat([prefix, plain]);
    const enc = encoding.toLowerCase();
    try {
        if (enc.includes("gzip")) return gzipSync(apply(gunzipSync(body)));
        if (enc.includes("br")) return brotliCompressSync(apply(brotliDecompressSync(body)));
        if (enc.includes("deflate")) return deflateSync(apply(inflateSync(body)));
    } catch {
        return body;
    }
    if (body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b) return body;
    return apply(body);
}

// The page script reads document.cookie as soon as it runs. Put the token in front
// of that script. A header CSP must not block this bootstrap.
function rewriteEmbedDocument(details: HeaderDetails): boolean {
    if (typeof details.id !== "number" || !isEmbedHtml(details)) return false;
    if (typeof details.statusCode === "number" && (details.statusCode < 200 || details.statusCode >= 300)) return false;
    const headers = details.responseHeaders;
    if (headers) {
        deleteHeader(headers, "content-security-policy");
        deleteHeader(headers, "content-security-policy-report-only");
        deleteHeader(headers, "content-length");
    }
    const host = hostOf(details.url);
    const token = cachedTokens.get(host) ?? "";
    const prefix = Buffer.from(`<script>${nightySessionScript(token)}</script>`, "utf8");
    const encoding = headerValue(headers, "content-encoding");
    return filterResponse(details.id, body => rewriteBody(body, encoding, prefix));
}

function injectEmbedCookie(url: string, requestHeaders: Record<string, string>) {
    const host = hostOf(url);
    if (!embedHosts.has(host)) return;

    const token = cachedTokens.get(host);
    if (!token) return;

    const existing = requestHeaders.Cookie || requestHeaders.cookie || "";
    const without = existing
        .split(/;\s*/)
        .filter(part => part !== "" && !/^access_token=/i.test(part))
        .join("; ");
    requestHeaders.Cookie = without === "" ? `access_token=${token}` : `${without}; access_token=${token}`;
    if (requestHeaders.cookie !== undefined) delete requestHeaders.cookie;
}

let requestHooksInstalled = false;

// Plugin natives load before initCsp. Equicord then registers one onHeadersReceived
// listener and replaces the method with a noop, so a later registration never runs.
// Own the listener first, keep Equicord's callback, and ignore that replacement.
function installRequestHooks() {
    if (requestHooksInstalled) return;
    requestHooksInstalled = true;

    for (const savedUrl of savedEmbedUrls()) publishEmbed(savedUrl);

    const webRequest = session.defaultSession.webRequest;
    const originalOnHeadersReceived = webRequest.onHeadersReceived.bind(webRequest);
    const originalOnBeforeSendHeaders = webRequest.onBeforeSendHeaders.bind(webRequest);

    let equicordHeaders: HeaderListener | null = null;

    originalOnHeadersReceived((details, callback) => {
        const finish = (result: HeadersResult | null | undefined) => {
            const responseHeaders = result?.responseHeaders ?? details.responseHeaders;
            relaxEmbedResponse(details.url, responseHeaders);
            const received = { ...details, responseHeaders };
            const captured = captureEmbedLogin(received);
            if (!captured) rewriteEmbedDocument(received);
            grantEmbedFrame(responseHeaders, details.resourceType);
            const next: HeadersResult = {
                cancel: result?.cancel ?? false,
                responseHeaders
            };
            if (result?.statusLine !== undefined) next.statusLine = result.statusLine;
            callback(next);
        };

        if (!equicordHeaders) {
            finish({ responseHeaders: details.responseHeaders });
            return;
        }

        let settled = false;
        try {
            equicordHeaders(details, result => {
                if (settled) return;
                settled = true;
                finish(result);
            });
        } catch (error) {
            console.error("[Nighty Tab] Embed header hook failed", error);
            if (!settled) finish({ responseHeaders: details.responseHeaders });
        }
    });

    let equicordSendHeaders: ((details: { url: string; requestHeaders?: Record<string, string>; }, callback: (result: { cancel?: boolean; requestHeaders?: Record<string, string>; }) => void) => void) | null = null;

    const captureEquicordHeaders = (...args: unknown[]) => {
        if (equicordHeaders) return;
        const listener = args.length >= 2 ? args[1] : args[0];
        if (typeof listener === "function") equicordHeaders = listener as HeaderListener;
    };

    const captureEquicordSendHeaders = (...args: unknown[]) => {
        if (equicordSendHeaders) return;
        const listener = args.length >= 2 ? args[1] : args[0];
        if (typeof listener === "function") equicordSendHeaders = listener as NonNullable<typeof equicordSendHeaders>;
    };

    const lockRegistration = (method: "onHeadersReceived" | "onBeforeSendHeaders", capture: (...args: unknown[]) => void) => {
        Object.defineProperty(webRequest, method, {
            configurable: true,
            enumerable: true,
            get: () => capture,
            set: () => { }
        });
    };

    try {
        lockRegistration("onHeadersReceived", captureEquicordHeaders);
        lockRegistration("onBeforeSendHeaders", captureEquicordSendHeaders);
    } catch (error) {
        console.error("[Nighty Tab] Could not keep the embed header listener", error);
        try {
            const realWebRequest = webRequest;
            const proxied = new Proxy(realWebRequest, {
                get(target, prop, receiver) {
                    if (prop === "onHeadersReceived") return captureEquicordHeaders;
                    if (prop === "onBeforeSendHeaders") return captureEquicordSendHeaders;
                    const value = Reflect.get(target, prop, receiver);
                    return typeof value === "function" ? value.bind(target) : value;
                },
                set(target, prop, value, receiver) {
                    if (prop === "onHeadersReceived" || prop === "onBeforeSendHeaders") return true;
                    return Reflect.set(target, prop, value, receiver);
                }
            });
            Object.defineProperty(session.defaultSession, "webRequest", {
                configurable: true,
                enumerable: true,
                get: () => proxied
            });
        } catch (proxyError) {
            console.error("[Nighty Tab] Could not wrap the embed header listener", proxyError);
        }
    }

    originalOnBeforeSendHeaders((details, callback) => {
        const finishSend = (result: { cancel?: boolean; requestHeaders?: Record<string, string>; } | null | undefined) => {
            const requestHeaders = { ...(result?.requestHeaders ?? details.requestHeaders ?? {}) };
            injectEmbedCookie(details.url, requestHeaders);
            callback({ cancel: result?.cancel ?? false, requestHeaders });
        };

        if (!equicordSendHeaders) {
            finishSend(null);
            return;
        }

        let settled = false;
        try {
            equicordSendHeaders(details, result => {
                if (settled) return;
                settled = true;
                finishSend(result);
            });
        } catch (error) {
            console.error("[Nighty Tab] Embed request hook failed", error);
            if (!settled) finishSend(null);
        }
    });

    hydrateSavedTokens();
}

function hydrateSavedTokens() {
    for (const savedUrl of savedEmbedUrls()) {
        const host = hostOf(savedUrl);
        if (host === "") continue;
        void session.defaultSession.cookies.get({ url: savedUrl, name: "access_token" }).then(found => {
            const token = found.find(cookie => cookie.value)?.value ?? "";
            if (token !== "" && !cachedTokens.has(host)) cachedTokens.set(host, token);
        }).catch(() => { /* the jar has no saved Nighty session */ });
    }
}

app.whenReady().then(() => {
    try {
        installRequestHooks();
    } catch (error) {
        console.error("[Nighty Tab] Failed to install embed request hooks", error);
    }
});

function registerHooks() {
    if (hooksRegistered) return;
    hooksRegistered = true;

    app.on("browser-window-created", (_, win) => attachWindow(win));
    for (const win of BrowserWindow.getAllWindows()) {
        attachWindow(win);
    }
}

export function allowEmbed(_event: IpcMainInvokeEvent, url: unknown) {
    if (typeof url !== "string") return;
    const host = hostOf(url);
    if (host !== "") {
        const added = publishEmbed(url);
        registerHooks();
        if (added && documentSources && !documentAllows(url)) reloadDiscord();

        try {
            session.defaultSession.preconnect({ url, numSockets: 2 });
        } catch {}

        for (const win of BrowserWindow.getAllWindows()) {
            const frames = win.webContents.mainFrame?.frames ?? [];
            for (const frame of frames) {
                injectFrame(frame);
            }
        }
    }
}

export async function saveToken(_event: IpcMainInvokeEvent, host: unknown, token: unknown, protocol: unknown) {
    if (typeof host !== "string" || typeof token !== "string" || host === "" || token === "") return;
    cachedTokens.set(host, token);
    embedHosts.add(host);

    rememberToken(host, token, `${protocol === "https:" ? "https" : "http"}://${host}/`);
}

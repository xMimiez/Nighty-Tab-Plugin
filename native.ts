/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: MIT
 */

import { CspPolicies } from "@main/csp";
import { app, BrowserWindow, IpcMainInvokeEvent, session, WebFrameMain } from "electron";
import { createServer, request as httpRequest, IncomingMessage, ServerResponse } from "http";
import { readFileSync } from "fs";
import { connect as connectTcp } from "net";
import { join } from "path";

// Equicord stopped exporting CSPSrc. This is that old list, including frame-src,
// so Discord's page can iframe the configured host. It does not add script-src.
const CSPSrc = ["style-src", "connect-src", "img-src", "frame-src", "font-src", "media-src", "worker-src"];

const LOCAL_HTTP_SOURCES = ["http://localhost:*", "http://127.0.0.1:*"];

CspPolicies["http://localhost:*"] = CSPSrc;
CspPolicies["http://127.0.0.1:*"] = CSPSrc;

const MONTH_SECONDS = 60 * 60 * 24 * 30;
const embedHosts = new Set<string>();
const embedSources = new Set<string>();
// Every cookie the embed set, keyed by host then cookie name. The live app logs in
// with an HttpOnly session cookie and does not return access_token.
const cachedCookies = new Map<string, Map<string, string>>();
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

function jarFor(host: string): Map<string, string> {
    let jar = cachedCookies.get(host);
    if (!jar) {
        jar = new Map();
        cachedCookies.set(host, jar);
    }
    return jar;
}

function cookieValue(host: string, name: string): string {
    return cachedCookies.get(host)?.get(name) ?? "";
}

function rememberCookie(host: string, name: string, value: string, pageUrl: string) {
    if (host === "" || name === "") return;
    const jar = jarFor(host);
    if (value === "") jar.delete(name);
    else jar.set(name, value);

    const secure = pageUrl.startsWith("https:");
    const url = `${secure ? "https" : "http"}://${host}/`;
    // A partitioned cookie set from the main process has no top-level site, so the
    // iframe does not send it. Header injection covers the reload. https responses
    // still get Partitioned from keepEmbedCookie.
    const write = value === ""
        ? session.defaultSession.cookies.remove(url, name)
        : session.defaultSession.cookies.set({
            url,
            name,
            value,
            path: "/",
            httpOnly: name.toLowerCase() !== "access_token",
            sameSite: secure ? "no_restriction" : "lax",
            secure,
            expirationDate: Math.floor(Date.now() / 1000) + MONTH_SECONDS
        });
    void write.catch(error => {
        console.error("[Nighty Tab] Failed to persist cookie in session", error);
    });
    if (value !== "" && name.toLowerCase() === "session") {
        console.log(`[Nighty Tab] Saved session cookie for ${host}`);
    }
}

function cookieShouldDrop(cookie: string, value: string): boolean {
    if (value === "") return true;
    const maxAge = /(?:^|;)\s*max-age=(-?\d+)/i.exec(cookie);
    return maxAge !== null && Number(maxAge[1]) <= 0;
}

function rememberSetCookie(host: string, cookie: string, pageUrl: string) {
    const pair = cookie.split(";")[0]?.trim() ?? "";
    const eq = pair.indexOf("=");
    if (eq <= 0) return;
    const name = pair.slice(0, eq).trim();
    let value = pair.slice(eq + 1).trim();
    if (cookieShouldDrop(cookie, value)) {
        rememberCookie(host, name, "", pageUrl);
        return;
    }
    if (name.toLowerCase() === "access_token") {
        try {
            value = decodeURIComponent(value);
        } catch { /* keep the raw cookie value */ }
    }
    rememberCookie(host, name, value, pageUrl);
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

// Older builds put access_token in document.cookie and localStorage. Chromium drops
// that third-party cookie, so the getter reports the saved token. Do not block
// location.reload(): the current server renders the dashboard on the next document,
// and that request only succeeds when the HttpOnly session cookie is sent.
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
        frame.executeJavaScript(nightySessionScript(cookieValue(host, "access_token"))).catch(() => {});
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
    if (process.env.APPDATA) {
        roots.push(join(process.env.APPDATA, "Equicord"));
        roots.push(join(process.env.APPDATA, "EquicordData"));
        roots.push(join(process.env.APPDATA, "Vencord"));
    }
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
        const lines: string[] = [];
        for (const entry of cookies) {
            for (const line of entry.split(/\r?\n/)) {
                if (line.trim() !== "") lines.push(line);
            }
        }
        for (const cookie of lines) rememberSetCookie(host, cookie, url);
        headers[key] = lines.map(cookie => keepEmbedCookie(url, cookie));
    }
}

const capturedLoginRequests = new Set<number>();

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
            if (typeof data.access_token === "string" && data.access_token !== "") {
                rememberCookie(host, "access_token", data.access_token, details.url);
            }
        } catch { /* the login response was not JSON */ }
        return body;
    });
}

function injectEmbedCookie(url: string, requestHeaders: Record<string, string>) {
    const host = hostOf(url);
    const jar = cachedCookies.get(host);
    if (!jar || jar.size === 0 || !embedHosts.has(host)) return;

    const existingKey = Object.keys(requestHeaders).find(name => name.toLowerCase() === "cookie");
    const existing = existingKey === undefined ? "" : requestHeaders[existingKey];
    const parts = new Map<string, string>();
    for (const part of existing.split(/;\s*/)) {
        if (part === "") continue;
        const eq = part.indexOf("=");
        if (eq <= 0) continue;
        parts.set(part.slice(0, eq).trim(), part.slice(eq + 1));
    }
    for (const [name, value] of jar) parts.set(name, value);

    if (existingKey !== undefined && existingKey !== "Cookie") delete requestHeaders[existingKey];
    requestHeaders.Cookie = [...parts.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
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
            captureEmbedLogin(received);
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
        void session.defaultSession.cookies.get({ url: savedUrl }).then(found => {
            const jar = jarFor(host);
            for (const cookie of found) {
                if (cookie.name === "" || cookie.value === "" || jar.has(cookie.name)) continue;
                jar.set(cookie.name, cookie.value);
            }
        }).catch(() => { /* the jar has no saved Nighty session */ });
    }
}

const PROXY_HOST = "127.0.0.1";
let proxyPort = 0;
let proxyTarget: URL | null = null;
const proxyCookies = new Map<string, Map<string, string>>();
let proxyListening = false;

function remoteHttp(url: URL): boolean {
    return url.protocol === "http:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1" && url.hostname !== "::1";
}

function proxyJar(origin: string): Map<string, string> {
    let jar = proxyCookies.get(origin);
    if (!jar) {
        jar = new Map();
        proxyCookies.set(origin, jar);
    }
    return jar;
}

function rememberProxyCookies(origin: string, setCookie: string | string[] | undefined) {
    if (!setCookie) return;
    const jar = proxyJar(origin);
    for (const cookie of Array.isArray(setCookie) ? setCookie : [setCookie]) {
        const pair = cookie.split(";")[0]?.trim() ?? "";
        const eq = pair.indexOf("=");
        if (eq <= 0) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (value === "" || /(?:^|;)\s*max-age=(?:0|-)/i.test(cookie)) jar.delete(name);
        else jar.set(name, value);
    }
}

function proxyCookieHeader(origin: string, existing: string | string[] | undefined): string {
    const parts = new Map<string, string>();
    const raw = Array.isArray(existing) ? existing.join("; ") : (existing ?? "");
    for (const part of raw.split(/;\s*/)) {
        if (part === "") continue;
        const eq = part.indexOf("=");
        if (eq <= 0) continue;
        parts.set(part.slice(0, eq).trim(), part.slice(eq + 1));
    }
    for (const [name, value] of proxyJar(origin)) parts.set(name, value);
    return [...parts.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function rewriteProxyLocation(location: string, target: URL): string {
    try {
        const next = new URL(location, target);
        if (next.origin !== target.origin || proxyPort === 0) return location;
        return `http://${PROXY_HOST}:${proxyPort}${next.pathname}${next.search}${next.hash}`;
    } catch {
        return location;
    }
}

function forwardHttp(req: IncomingMessage, res: ServerResponse) {
    const target = proxyTarget;
    if (!target || !req.url) {
        res.writeHead(503);
        res.end();
        return;
    }
    const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: target.host };
    const cookie = proxyCookieHeader(target.origin, req.headers.cookie);
    if (cookie !== "") headers.cookie = cookie;
    const upstream = httpRequest({
        hostname: target.hostname,
        port: target.port || 80,
        method: req.method,
        path: req.url,
        headers
    }, upstreamRes => {
        rememberProxyCookies(target.origin, upstreamRes.headers["set-cookie"]);
        const responseHeaders = { ...upstreamRes.headers };
        if (typeof responseHeaders.location === "string") responseHeaders.location = rewriteProxyLocation(responseHeaders.location, target);
        res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
        upstreamRes.pipe(res);
    });
    upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
    });
    req.pipe(upstream);
}

function startEmbedProxy() {
    if (proxyListening) return;
    proxyListening = true;
    const server = createServer(forwardHttp);
    server.on("upgrade", (req, socket, head) => {
        const target = proxyTarget;
        if (!target) {
            socket.destroy();
            return;
        }
        const upstream = connectTcp(Number(target.port || 80), target.hostname, () => {
            const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1`, `Host: ${target.host}`];
            for (const [key, value] of Object.entries(req.headers)) {
                if (value === undefined || key.toLowerCase() === "host") continue;
                const values = Array.isArray(value) ? value : [value];
                for (const item of values) lines.push(`${key}: ${item}`);
            }
            upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
            if (head.length > 0) upstream.write(head);
            socket.pipe(upstream);
            upstream.pipe(socket);
        });
        const closeBoth = () => {
            socket.destroy();
            upstream.destroy();
        };
        upstream.on("error", closeBoth);
        socket.on("error", closeBoth);
    });
    server.listen(0, PROXY_HOST, () => {
        const address = server.address();
        if (address && typeof address === "object") {
            proxyPort = address.port;
            console.log(`[Nighty Tab] HTTP embed proxy listening on ${proxyPort}`);
        }
    });
}

export function localEmbedUrl(_event: IpcMainInvokeEvent, url: unknown): Promise<string> {
    if (typeof url !== "string" || url === "") return Promise.resolve("");
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return Promise.resolve("");
    }
    if (!remoteHttp(parsed)) return Promise.resolve(parsed.href);
    startEmbedProxy();
    proxyTarget = new URL(parsed.href);
    publishEmbed(parsed.href);
    if (proxyPort !== 0) return Promise.resolve(`http://${PROXY_HOST}:${proxyPort}${parsed.pathname}${parsed.search}${parsed.hash}`);
    return new Promise(resolve => {
        const timer = setInterval(() => {
            if (proxyPort === 0) return;
            clearInterval(timer);
            resolve(`http://${PROXY_HOST}:${proxyPort}${parsed.pathname}${parsed.search}${parsed.hash}`);
        }, 20);
    });
}

for (const savedUrl of savedEmbedUrls()) {
    publishEmbed(savedUrl);
    try {
        const parsed = new URL(savedUrl);
        if (remoteHttp(parsed)) proxyTarget = parsed;
    } catch { /* ignore invalid saved URL */ }
}
startEmbedProxy();

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
    embedHosts.add(host);
    rememberCookie(host, "access_token", token, `${protocol === "https:" ? "https" : "http"}://${host}/`);
}

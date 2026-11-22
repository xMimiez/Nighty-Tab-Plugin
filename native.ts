/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: MIT
 */

import { CspPolicies } from "@main/csp";
import { RendererSettings } from "@main/settings";
import { app, BrowserWindow, IpcMainInvokeEvent, session, webFrameMain, WebFrameMain } from "electron";
import { createServer, IncomingMessage, request as httpRequest, ServerResponse } from "http";
import { connect as connectTcp } from "net";

const CSPSrc = ["style-src", "connect-src", "img-src", "frame-src", "font-src", "media-src", "worker-src"] as const;
const LOCAL_HTTP_SOURCES = ["http://localhost:*", "http://127.0.0.1:*"] as const;
const MONTH_SECONDS = 60 * 60 * 24 * 30;
const MAX_URL_LENGTH = 2048;
const MAX_TOKEN_LENGTH = 4096;
const CSP_ORIGIN_PATTERN = /^https?:\/\/[^;\s,'"]+$/i;
const INVALID_COOKIE_PATTERN = /[\r\n;\x00-\x1f\x7f]/;
const PROXY_HOST = "127.0.0.1";

const embedOrigins = new Set<string>();
const embedSources = new Set<string>();
const iconOrigins = new Set<string>();
const cachedCookies = new Map<string, Map<string, string>>();
const capturedLoginRequests = new Set<number>();
const attachedWindows = new WeakSet<BrowserWindow>();
const proxyCookies = new Map<string, Map<string, string>>();

let hooksRegistered = false;
let requestHooksInstalled = false;
let documentSources: Set<string> | null = null;
let proxyPort = 0;
let proxyTarget: URL | null = null;
let proxyListening = false;

interface ParsedOrigin {
    origin: string;
    host: string;
    href: string;
    parsed: URL;
}

type HeaderMap = Record<string, string[]>;

interface HeadersResult {
    cancel?: boolean;
    responseHeaders?: HeaderMap;
    statusLine?: string;
}

interface HeaderDetails {
    id?: number;
    url: string;
    statusCode?: number;
    resourceType?: string;
    responseHeaders?: HeaderMap;
}

type HeaderListener = (details: HeaderDetails, callback: (result: HeadersResult) => void) => void;

function parseOrigin(url: unknown): ParsedOrigin | null {
    if (typeof url !== "string") return null;
    const trimmed = url.trim();
    if (trimmed === "" || trimmed.length > MAX_URL_LENGTH) return null;
    try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
        if (!parsed.hostname || !CSP_ORIGIN_PATTERN.test(parsed.origin)) return null;
        return { origin: parsed.origin, host: parsed.host, href: parsed.href, parsed };
    } catch {
        return null;
    }
}

function addCspDirectives(source: string, directives: readonly string[]): boolean {
    const existing = CspPolicies[source] ?? [];
    const missing = directives.filter(d => !existing.includes(d));
    if (missing.length === 0) return false;
    CspPolicies[source] = [...existing, ...missing];
    return true;
}

for (const source of LOCAL_HTTP_SOURCES) {
    addCspDirectives(source, CSPSrc);
}

function keepEmbedCookie(pageUrl: string, cookie: string): string {
    if (!pageUrl.startsWith("https:")) return cookie;

    let next = cookie
        .replace(/;\s*samesite=[^;]*/gi, "")
        .replace(/;\s*partitioned\b/gi, "")
        .replace(/;\s*secure\b/gi, "");
    next += "; Secure; SameSite=None; Partitioned";
    if (!/(?:^|;)\s*(?:expires|max-age)=/i.test(next)) next += `; Max-Age=${MONTH_SECONDS}`;
    return next;
}

function jarFor(origin: string): Map<string, string> {
    let jar = cachedCookies.get(origin);
    if (!jar) {
        jar = new Map();
        cachedCookies.set(origin, jar);
    }
    return jar;
}

function cookieValue(origin: string, name: string): string {
    return cachedCookies.get(origin)?.get(name) ?? "";
}

function rememberCookie(origin: string, name: string, value: string) {
    if (origin === "" || name === "") return;
    if (INVALID_COOKIE_PATTERN.test(name) || (value !== "" && (value.length > MAX_TOKEN_LENGTH || INVALID_COOKIE_PATTERN.test(value)))) {
        return;
    }

    const jar = jarFor(origin);
    if (value === "") jar.delete(name);
    else jar.set(name, value);

    const secure = origin.startsWith("https:");
    const cookieUrl = `${origin}/`;
    const write = value === ""
        ? session.defaultSession.cookies.remove(cookieUrl, name)
        : session.defaultSession.cookies.set({
            url: cookieUrl,
            name,
            value,
            path: "/",
            httpOnly: name.toLowerCase() !== "access_token",
            sameSite: secure ? "no_restriction" : "lax",
            secure,
            expirationDate: Math.floor(Date.now() / 1000) + MONTH_SECONDS
        });
    void write.catch(() => {});
}

function cookieShouldDrop(cookie: string, value: string): boolean {
    if (value === "") return true;
    const maxAge = /(?:^|;)\s*max-age=(-?\d+)/i.exec(cookie);
    return maxAge !== null && Number(maxAge[1]) <= 0;
}

function rememberSetCookie(origin: string, cookie: string) {
    const pair = cookie.split(";")[0]?.trim() ?? "";
    const eq = pair.indexOf("=");
    if (eq <= 0) return;
    const name = pair.slice(0, eq).trim();
    let value = pair.slice(eq + 1).trim();
    if (cookieShouldDrop(cookie, value)) {
        rememberCookie(origin, name, "");
        return;
    }
    if (name.toLowerCase() === "access_token") {
        try {
            value = decodeURIComponent(value);
        } catch {}
    }
    rememberCookie(origin, name, value);
}

function allowEmbedDocument(headers: HeaderMap) {
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

function nightySessionScript(token: string): string {
    const literal = JSON.stringify(token)
        .replace(/</g, "\\u003c")
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");
    return `(() => {
    const provided = ${literal};
    const remember = (value) => {
        if (typeof value !== "string" || value === "") return;
        try { localStorage.setItem("access_token", value); } catch {}
    };
    const notifyParent = (tokenValue) => {
        try {
            const parentOrigin = window.location.ancestorOrigins?.[0];
            if (!parentOrigin) return;
            window.parent.postMessage({
                type: "VC_NIGHTY_TOKEN",
                token: tokenValue,
                origin: window.location.origin
            }, parentOrigin);
        } catch {}
    };
    remember(provided);
    let jar = "";
    try {
        const stored = localStorage.getItem("access_token") || provided;
        if (stored) jar = "access_token=" + stored;
    } catch {
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
        const origGet = desc.get;
        const origSet = desc.set;
        Object.defineProperty(document, "cookie", {
            configurable: true,
            enumerable: true,
            get() {
                let real = "";
                try { real = String(origGet.call(document) || ""); } catch {}
                const extra = window.__vcNightyJar || "";
                if (!extra || /(?:^|;\\s*)access_token=/.test(real)) return real;
                return real === "" ? extra : extra + "; " + real;
            },
            set(val) {
                const str = String(val);
                const match = /^access_token=([^;]*)/i.exec(str.trim());
                if (match) {
                    let next = match[1];
                    try { next = decodeURIComponent(match[1]); } catch {}
                    if (next === "") {
                        window.__vcNightyJar = "";
                        try { localStorage.removeItem("access_token"); } catch {}
                    } else {
                        window.__vcNightyJar = "access_token=" + next;
                        remember(next);
                        notifyParent(next);
                    }
                }
                const secure = window.location.protocol === "https:";
                const written = secure
                    ? str.replace(/;\\s*samesite=[^;]*/gi, "").replace(/;\\s*partitioned\\b/gi, "").replace(/;\\s*secure\\b/gi, "") + "; Secure; SameSite=None; Partitioned"
                    : str;
                try { return origSet.call(document, written); } catch { return origSet.call(document, str); }
            }
        });
    }
    const origFetch = window.fetch;
    if (typeof origFetch === "function") {
        window.fetch = async function(...args) {
            const res = await origFetch.apply(this, args);
            try {
                const input = args[0];
                const rawUrl = typeof input === "string"
                    ? input
                    : input instanceof URL
                        ? input.href
                        : input?.url || "";
                if (rawUrl) {
                    const resolved = new URL(rawUrl, window.location.href);
                    if (resolved.origin === window.location.origin && resolved.pathname.includes("/api/login")) {
                        const data = await res.clone().json();
                        if (data && typeof data.access_token === "string" && data.access_token.length > 0) {
                            window.__vcNightyJar = "access_token=" + data.access_token;
                            remember(data.access_token);
                            notifyParent(data.access_token);
                        }
                    }
                }
            } catch {}
            return res;
        };
    }
})();`;
}

function injectFrame(frame: WebFrameMain) {
    try {
        const parsed = parseOrigin(frame.url);
        if (!parsed || !embedOrigins.has(parsed.origin)) return;
        frame.executeJavaScript(nightySessionScript(cookieValue(parsed.origin, "access_token"))).catch(() => {});
    } catch {}
}

function attachWindow(win: BrowserWindow) {
    if (attachedWindows.has(win) || win.isDestroyed()) return;
    attachedWindows.add(win);

    win.webContents.on("did-frame-finish-load", (_event, isMainFrame, frameProcessId, frameRoutingId) => {
        if (isMainFrame) return;
        const frame = webFrameMain.fromId(frameProcessId, frameRoutingId);
        if (frame) injectFrame(frame);
    });

    const frames = win.webContents.mainFrame?.frames ?? [];
    for (const frame of frames) {
        injectFrame(frame);
    }
}

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

function publishEmbed(url: string): boolean {
    const parsed = parseOrigin(url);
    if (!parsed) return false;
    const known = embedOrigins.has(parsed.origin);
    embedOrigins.add(parsed.origin);
    embedSources.add(parsed.origin);
    addCspDirectives(parsed.origin, CSPSrc);
    return !known;
}

function publishIcon(url: string): boolean {
    const parsed = parseOrigin(url);
    if (!parsed) return false;
    iconOrigins.add(parsed.origin);
    return addCspDirectives(parsed.origin, ["img-src"]);
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
    const imgBucket = parsed["img-src"] ?? (parsed["img-src"] = [...(parsed["default-src"] ?? [])]);
    for (const source of iconOrigins) {
        if (!imgBucket.includes(source)) imgBucket.push(source);
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
    if (!documentSources) return true;
    const parsed = parseOrigin(url);
    if (!parsed) return true;
    if (documentSources.has(parsed.origin)) return true;
    if (parsed.parsed.protocol === "http:" && (parsed.parsed.hostname === "localhost" || parsed.parsed.hostname === "127.0.0.1")) {
        return documentSources.has(`${parsed.parsed.protocol}//${parsed.parsed.hostname}:*`);
    }
    return false;
}

function relaxEmbedResponse(url: string, headers: HeaderMap | undefined) {
    if (!headers) return;
    const parsed = parseOrigin(url);
    if (!parsed || !embedOrigins.has(parsed.origin)) return;

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
        for (const cookie of lines) rememberSetCookie(parsed.origin, cookie);
        headers[key] = lines.map(cookie => keepEmbedCookie(parsed.href, cookie));
    }
}

function filterResponse(id: number, onBody: (body: Buffer) => Buffer): boolean {
    if (capturedLoginRequests.has(id)) return false;
    const webReq = session.defaultSession.webRequest as typeof session.defaultSession.webRequest & {
        filterResponseData?: (requestId: number) => NodeJS.ReadWriteStream & { write(chunk: Buffer): void; end(): void; };
    };
    if (typeof webReq.filterResponseData !== "function") return false;
    let filter: ReturnType<NonNullable<typeof webReq.filterResponseData>>;
    try {
        filter = webReq.filterResponseData(id);
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
        let body: Buffer = Buffer.concat(chunks);
        try {
            body = onBody(body);
        } catch {}
        try {
            filter.write(body);
            filter.end();
        } catch {}
        release();
    });
    filter.on("error", () => {
        try {
            const body = Buffer.concat(chunks);
            if (body.length > 0) filter.write(body);
            filter.end();
        } catch {}
        release();
    });
    return true;
}

function captureEmbedLogin(details: HeaderDetails): boolean {
    if (typeof details.id !== "number") return false;
    if (typeof details.statusCode === "number" && details.statusCode >= 300 && details.statusCode < 400) return false;
    const parsed = parseOrigin(details.url);
    if (!parsed || !embedOrigins.has(parsed.origin)) return false;
    if (!parsed.parsed.pathname.includes("/api/login")) return false;

    return filterResponse(details.id, body => {
        try {
            const data = JSON.parse(body.toString("utf8")) as { access_token?: unknown; };
            if (typeof data.access_token === "string" && data.access_token !== "") {
                rememberCookie(parsed.origin, "access_token", data.access_token);
            }
        } catch {}
        return body;
    });
}

function injectEmbedCookie(url: string, requestHeaders: Record<string, string>) {
    const parsed = parseOrigin(url);
    if (!parsed || !embedOrigins.has(parsed.origin)) return;
    const jar = cachedCookies.get(parsed.origin);
    if (!jar || jar.size === 0) return;

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

function hydrateSavedTokens() {
    for (const origin of embedOrigins) {
        void session.defaultSession.cookies.get({ url: `${origin}/` }).then(found => {
            const jar = jarFor(origin);
            for (const cookie of found) {
                if (cookie.name === "" || cookie.value === "" || jar.has(cookie.name)) continue;
                jar.set(cookie.name, cookie.value);
            }
        }).catch(() => {});
    }
}

function installRequestHooks() {
    if (requestHooksInstalled) return;
    requestHooksInstalled = true;

    const { webRequest } = session.defaultSession;
    const originalOnHeadersReceived = webRequest.onHeadersReceived.bind(webRequest);
    const originalOnBeforeSendHeaders = webRequest.onBeforeSendHeaders.bind(webRequest);

    let equicordHeaders: HeaderListener | null = null;
    let equicordSendHeaders: ((details: { url: string; requestHeaders?: Record<string, string>; }, callback: (result: { cancel?: boolean; requestHeaders?: Record<string, string>; }) => void) => void) | null = null;

    originalOnHeadersReceived((details, callback) => {
        const finish = (result: HeadersResult | null | undefined) => {
            const responseHeaders = result?.responseHeaders ?? details.responseHeaders;
            relaxEmbedResponse(details.url, responseHeaders);
            captureEmbedLogin({ ...details, responseHeaders });
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
        } catch {
            if (!settled) finish({ responseHeaders: details.responseHeaders });
        }
    });

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
            set: () => {}
        });
    };

    try {
        lockRegistration("onHeadersReceived", captureEquicordHeaders);
        lockRegistration("onBeforeSendHeaders", captureEquicordSendHeaders);
    } catch {
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
        } catch {}
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
        } catch {
            if (!settled) finishSend(null);
        }
    });

    hydrateSavedTokens();
}

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
    const items = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const entry of items) {
        const pair = entry.split(";")[0]?.trim() ?? "";
        const eq = pair.indexOf("=");
        if (eq <= 0) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (INVALID_COOKIE_PATTERN.test(name) || INVALID_COOKIE_PATTERN.test(value)) continue;
        if (cookieShouldDrop(entry, value)) jar.delete(name);
        else jar.set(name, value);
    }
}

function proxyCookieHeader(origin: string, incoming: string | undefined): string {
    const parts = new Map<string, string>();
    if (incoming) {
        for (const part of incoming.split(/;\s*/)) {
            if (part === "") continue;
            const eq = part.indexOf("=");
            if (eq <= 0) continue;
            parts.set(part.slice(0, eq).trim(), part.slice(eq + 1));
        }
    }
    for (const [name, value] of proxyJar(origin)) parts.set(name, value);
    return [...parts.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function rewriteProxyLocation(location: string, target: URL): string {
    try {
        const resolved = new URL(location, target);
        if (resolved.origin !== target.origin) return location;
        return `http://${PROXY_HOST}:${proxyPort}${resolved.pathname}${resolved.search}${resolved.hash}`;
    } catch {
        return location;
    }
}

function forwardHttp(req: IncomingMessage, res: ServerResponse) {
    const target = proxyTarget;
    if (!target) {
        res.writeHead(502);
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
        if (typeof responseHeaders.location === "string") {
            responseHeaders.location = rewriteProxyLocation(responseHeaders.location, target);
        }
        delete responseHeaders["x-frame-options"];
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
        }
    });
}

function registerHooks() {
    if (hooksRegistered) return;
    hooksRegistered = true;

    app.on("browser-window-created", (_, win) => attachWindow(win));
    for (const win of BrowserWindow.getAllWindows()) {
        attachWindow(win);
    }
}

function initFromSettings() {
    const pluginSettings = (RendererSettings.store.plugins?.["Nighty Tab"] ?? RendererSettings.store.plugins?.ExtraHomeTab) as {
        url?: unknown;
        iconType?: unknown;
        customIconUrl?: unknown;
    } | undefined;
    if (!pluginSettings) return;

    const embedParsed = parseOrigin(pluginSettings.url);
    if (embedParsed) {
        publishEmbed(embedParsed.href);
        if (remoteHttp(embedParsed.parsed)) {
            proxyTarget = embedParsed.parsed;
            startEmbedProxy();
        }
    }

    if (pluginSettings.iconType === "custom") {
        const iconParsed = parseOrigin(pluginSettings.customIconUrl);
        if (iconParsed) publishIcon(iconParsed.href);
    }
}

initFromSettings();

void app.whenReady().then(() => {
    try {
        installRequestHooks();
        registerHooks();
    } catch {}
});

export function localEmbedUrl(_event: IpcMainInvokeEvent, url: unknown): Promise<string> {
    const parsed = parseOrigin(url);
    if (!parsed) return Promise.resolve("");
    if (!remoteHttp(parsed.parsed)) return Promise.resolve(parsed.href);

    startEmbedProxy();
    proxyTarget = new URL(parsed.href);
    publishEmbed(parsed.href);
    if (proxyPort !== 0) {
        return Promise.resolve(`http://${PROXY_HOST}:${proxyPort}${parsed.parsed.pathname}${parsed.parsed.search}${parsed.parsed.hash}`);
    }
    return new Promise(resolve => {
        const timer = setInterval(() => {
            if (proxyPort === 0) return;
            clearInterval(timer);
            resolve(`http://${PROXY_HOST}:${proxyPort}${parsed.parsed.pathname}${parsed.parsed.search}${parsed.parsed.hash}`);
        }, 20);
    });
}

export function allowEmbed(_event: IpcMainInvokeEvent, url: unknown): { needsReload: boolean; } {
    const parsed = parseOrigin(url);
    if (!parsed) return { needsReload: false };

    publishEmbed(parsed.href);
    registerHooks();

    try {
        session.defaultSession.preconnect({ url: parsed.origin, numSockets: 2 });
    } catch {}

    for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        const frames = win.webContents.mainFrame?.frames ?? [];
        for (const frame of frames) {
            injectFrame(frame);
        }
    }

    return { needsReload: !remoteHttp(parsed.parsed) && !documentAllows(parsed.href) };
}

export function allowIcon(_event: IpcMainInvokeEvent, url: unknown): { needsReload: boolean; } {
    const parsed = parseOrigin(url);
    if (!parsed) return { needsReload: false };
    const added = publishIcon(parsed.href);
    return { needsReload: added && documentSources !== null };
}

export async function saveToken(_event: IpcMainInvokeEvent, origin: unknown, token: unknown): Promise<{ success: boolean; }> {
    const parsed = parseOrigin(origin);
    if (!parsed || !embedOrigins.has(parsed.origin)) return { success: false };
    if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH || INVALID_COOKIE_PATTERN.test(token)) {
        return { success: false };
    }

    rememberCookie(parsed.origin, "access_token", token);
    return { success: true };
}

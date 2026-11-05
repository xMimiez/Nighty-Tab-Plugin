/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: MIT
 */

import { CspPolicies } from "@main/csp";
import { app, BrowserWindow, IpcMainInvokeEvent, session, WebFrameMain } from "electron";

// Equicord stopped exporting CSPSrc. This is that old list, including frame-src,
// so Discord's page can iframe the configured host. It does not add script-src.
const CSPSrc = ["style-src", "connect-src", "img-src", "frame-src", "font-src", "media-src", "worker-src"];

CspPolicies["http://localhost:*"] = CSPSrc;

const MONTH_SECONDS = 60 * 60 * 24 * 30;
const embedHosts = new Set<string>();
const cachedTokens = new Map<string, string>();
let hooksRegistered = false;

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
    if (!pageUrl.startsWith("https:")) return cookie;

    let next = cookie.replace(/;\s*samesite=[^;]*/gi, "").replace(/;\s*partitioned\b/gi, "").replace(/;\s*secure\b/gi, "");
    next += "; Secure; SameSite=None";
    if (!/(?:^|;)\s*(?:expires|max-age)=/i.test(next)) next += `; Max-Age=${MONTH_SECONDS}`;
    return next;
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

const INJECT_SCRIPT = `
(() => {
    if (window.__vcNightyPatched) return;
    window.__vcNightyPatched = true;

    const desc = Object.getOwnPropertyDescriptor(Document.prototype, "cookie") ||
                 Object.getOwnPropertyDescriptor(HTMLDocument.prototype, "cookie");
    if (desc && desc.set) {
        const origSet = desc.set;
        Object.defineProperty(document, "cookie", {
            configurable: true,
            enumerable: true,
            get() {
                return desc.get.call(document);
            },
            set(val) {
                const str = String(val);
                if (location.protocol !== "https:") return origSet.call(document, str);
                const next = str.replace(/;\\s*samesite=[^;]*/gi, "").replace(/;\\s*partitioned\\b/gi, "").replace(/;\\s*secure\\b/gi, "");
                try {
                    return origSet.call(document, next + "; Secure; SameSite=None");
                } catch {
                    return origSet.call(document, str);
                }
            }
        });
    }

    const origFetch = window.fetch;
    window.fetch = async function(...args) {
        const res = await origFetch.apply(this, args);
        try {
            const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
            if (url.includes("/api/login")) {
                const clone = res.clone();
                clone.json().then(data => {
                    if (data && data.access_token) {
                        window.parent.postMessage({
                            type: "VC_NIGHTY_TOKEN",
                            token: data.access_token,
                            host: window.location.host,
                            protocol: window.location.protocol
                        }, "*");
                    }
                }).catch(() => {});
            }
        } catch {}
        return res;
    };
})();
`;

function injectFrame(frame: WebFrameMain) {
    try {
        const host = hostOf(frame.url);
        if (!embedHosts.has(host)) return;
        frame.executeJavaScript(INJECT_SCRIPT).catch(() => {});
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

type HeaderListener = (details: { url: string; responseHeaders?: HeaderMap; }, callback: (result: HeadersResult) => void) => void;

function relaxEmbedResponse(url: string, headers: HeaderMap | undefined) {
    if (!headers) return;
    const host = hostOf(url);
    if (!embedHosts.has(host)) return;

    allowEmbedDocument(headers);

    const key = Object.keys(headers).find(name => name.toLowerCase() === "set-cookie");
    const cookies = key === undefined ? undefined : headers[key];
    if (key !== undefined && cookies) {
        headers[key] = cookies.map(cookie => keepEmbedCookie(url, cookie));
    }
}

function injectEmbedCookie(url: string, requestHeaders: Record<string, string>) {
    const host = hostOf(url);
    if (!embedHosts.has(host)) return;

    const token = cachedTokens.get(host);
    if (!token) return;

    const existing = requestHeaders.Cookie || requestHeaders.cookie || "";
    if (!existing.includes("access_token=")) {
        requestHeaders.Cookie = existing ? `${existing}; access_token=${token}` : `access_token=${token}`;
    }
}

let requestHooksInstalled = false;

// Plugin natives load before initCsp. Equicord then registers one onHeadersReceived
// listener and replaces the method with a noop, so a later registration never runs.
// Own the listener first, keep Equicord's callback, and ignore that replacement.
function installRequestHooks() {
    if (requestHooksInstalled) return;
    requestHooksInstalled = true;

    const webRequest = session.defaultSession.webRequest;
    const originalOnHeadersReceived = webRequest.onHeadersReceived.bind(webRequest);
    const originalOnBeforeSendHeaders = webRequest.onBeforeSendHeaders.bind(webRequest);

    let equicordHeaders: HeaderListener | null = null;

    originalOnHeadersReceived((details, callback) => {
        const finish = (result: HeadersResult | null | undefined) => {
            const responseHeaders = result?.responseHeaders ?? details.responseHeaders;
            relaxEmbedResponse(details.url, responseHeaders);
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

    const captureEquicordHeaders = (...args: unknown[]) => {
        if (equicordHeaders) return;
        const listener = args.length >= 2 ? args[1] : args[0];
        if (typeof listener === "function") equicordHeaders = listener as HeaderListener;
    };

    const lockHeadersRegistration = () => {
        Object.defineProperty(webRequest, "onHeadersReceived", {
            configurable: true,
            enumerable: true,
            get: () => captureEquicordHeaders,
            set: () => { }
        });
    };

    try {
        lockHeadersRegistration();
    } catch (error) {
        console.error("[Nighty Tab] Could not keep the embed header listener", error);
        try {
            const realWebRequest = webRequest;
            const proxied = new Proxy(realWebRequest, {
                get(target, prop, receiver) {
                    if (prop === "onHeadersReceived") return captureEquicordHeaders;
                    const value = Reflect.get(target, prop, receiver);
                    return typeof value === "function" ? value.bind(target) : value;
                },
                set(target, prop, value, receiver) {
                    if (prop === "onHeadersReceived") return true;
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
        const requestHeaders = { ...(details.requestHeaders ?? {}) };
        injectEmbedCookie(details.url, requestHeaders);
        callback({ cancel: false, requestHeaders });
    });
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
        embedHosts.add(host);
        CspPolicies[host] = CSPSrc;
        registerHooks();

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

    const secure = protocol === "https:";
    try {
        await session.defaultSession.cookies.set({
            url: `${secure ? "https" : "http"}://${host}`,
            name: "access_token",
            value: token,
            path: "/",
            sameSite: secure ? "no_restriction" : "lax",
            secure,
            expirationDate: Math.floor(Date.now() / 1000) + MONTH_SECONDS
        });
    } catch (e) {
        console.error("[Nighty Tab] Failed to persist cookie in session", e);
    }
}

/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: MIT
 */

import { addBeforeSendHeadersHook, addResponseHeaderHook, CspPolicies, CSPSrc } from "@main/csp";
import { app, BrowserWindow, IpcMainInvokeEvent, session, WebFrameMain } from "electron";

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

function keepEmbedCookie(cookie: string): string {
    let next = cookie.replace(/;\s*samesite=[^;]*/gi, "").replace(/;\s*partitioned\b/gi, "");
    if (!/;\s*secure\b/i.test(next)) next += "; Secure";
    next += "; SameSite=None; Partitioned";
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
                let str = String(val);
                let next = str.replace(/;\\s*samesite=[^;]*/gi, "").replace(/;\\s*partitioned\\b/gi, "");
                if (!/;\\s*secure\\b/i.test(next)) next += "; Secure";
                next += "; SameSite=None; Partitioned";
                return origSet.call(document, next);
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
                            host: window.location.host
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

function registerHooks() {
    if (hooksRegistered) return;
    hooksRegistered = true;

    addResponseHeaderHook(({ url, responseHeaders }) => {
        if (!responseHeaders) return;
        const host = hostOf(url);
        if (!embedHosts.has(host)) return;

        allowEmbedDocument(responseHeaders);

        const key = Object.keys(responseHeaders).find(name => name.toLowerCase() === "set-cookie");
        const cookies = key === undefined ? undefined : responseHeaders[key];
        if (key !== undefined && cookies) {
            responseHeaders[key] = cookies.map(keepEmbedCookie);
        }
    });

    addBeforeSendHeadersHook(({ url, requestHeaders }) => {
        const host = hostOf(url);
        if (!embedHosts.has(host)) return;

        const token = cachedTokens.get(host);
        if (!token) return;

        const existing = requestHeaders.Cookie || requestHeaders.cookie || "";
        if (!existing.includes("access_token=")) {
            requestHeaders.Cookie = existing ? `${existing}; access_token=${token}` : `access_token=${token}`;
        }
    });

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

export async function saveToken(_event: IpcMainInvokeEvent, host: unknown, token: unknown) {
    if (typeof host !== "string" || typeof token !== "string" || host === "" || token === "") return;
    cachedTokens.set(host, token);
    embedHosts.add(host);

    try {
        await session.defaultSession.cookies.set({
            url: `https://${host}`,
            name: "access_token",
            value: token,
            sameSite: "no_restriction",
            secure: true,
            partitioned: true
        });
    } catch (e) {
        console.error("[Nighty Tab] Failed to persist cookie in session", e);
    }
}

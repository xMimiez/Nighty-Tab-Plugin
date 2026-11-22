/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: MIT
 */

import "./style.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { addServerListElement, removeServerListElement, ServerListItem, ServerListRenderPosition } from "@api/ServerList";
import { definePluginSettings, migratePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import { sendMessage } from "@utils/discord";
import { classes } from "@utils/misc";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { Message } from "@vencord/discord-types";
import { findByCodeLazy, findComponentByCodeLazy } from "@webpack";
import { ChannelStore, Menu, MessageActions, NavigationRouter, useEffect, useRef, useState } from "@webpack/common";
import blueIconBase64 from "file://./asset/icon.webp?base64";
import grayscaleIconBase64 from "file://./asset/icon-grayscale.webp?base64";
import type { MouseEvent, ReactElement } from "react";

const Native = IS_DISCORD_DESKTOP
    ? VencordNative.pluginHelpers["Nighty Tab"] as PluginNative<typeof import("./native")>
    : null;

const NIGHTY_ROUTE = "/nighty";
const NIGHTY_ITEM_ID = "nighty";
const SLOW_LOAD_TIMEOUT_MS = 10_000;
const cl = classNameFactory("vc-nighty-tab-");
const URL_SETTINGS_KEYS = ["url"] as ("url")[];
const ICON_SETTINGS_KEYS = ["iconType", "customIconUrl"] as ("iconType" | "customIconUrl")[];
const TAB_PLACEMENT_KEYS = ["tabPlacement"] as ("tabPlacement")[];

const BLUE_ICON = `data:image/webp;base64,${blueIconBase64}`;
const GRAYSCALE_ICON = `data:image/webp;base64,${grayscaleIconBase64}`;

migratePluginSettings("Nighty Tab", "ExtraHomeTab");

function pageUrl(value: string | undefined): string | null {
    const trimmed = (value ?? "").trim();
    if (trimmed === "") return null;
    try {
        const url = new URL(trimmed);
        if (url.protocol !== "http:" && url.protocol !== "https:") return null;
        return url.href;
    } catch {
        return null;
    }
}

const settings = definePluginSettings({
    url: {
        type: OptionType.STRING,
        description: "URL the Nighty tab opens in the page beside the home sidebar.",
        placeholder: "https://",
        default: "",
        isValid(value: string) {
            const trimmed = value.trim();
            if (trimmed === "") return true;
            if (pageUrl(trimmed) !== null) return true;
            return "Use an http or https URL.";
        },
        onChange(newValue: string) {
            const valid = pageUrl(newValue);
            if (Native && valid !== null) void Native.allowEmbed(valid);
        }
    },
    tabPlacement: {
        type: OptionType.SELECT,
        description: "Choose where the Nighty tab appears.",
        displayName: "Tab Placement",
        options: [
            { label: "Home Sidebar (Under Quests)", value: "sidebar", default: true },
            { label: "Server List (Guild Bar)", value: "guilds" },
            { label: "Both Sidebar and Server List", value: "both" }
        ]
    },
    iconType: {
        type: OptionType.SELECT,
        description: "Select the sidebar and menu icon style.",
        displayName: "Tab Icon Style",
        options: [
            { label: "Neon Blue (Default)", value: "blue", default: true },
            { label: "Grayscale (Original)", value: "grayscale" },
            { label: "Custom Image URL", value: "custom" }
        ]
    },
    customIconUrl: {
        type: OptionType.STRING,
        description: "Direct image link (PNG, JPG, SVG, WebP) for the tab icon.",
        displayName: "Custom Icon URL",
        placeholder: "https://...",
        default: "",
        hidden() {
            return this.store.iconType !== "custom";
        },
        isValid(value: string) {
            if (this.store.iconType !== "custom") return true;
            const trimmed = value.trim();
            if (trimmed === "") return "Enter a valid image URL.";
            if (pageUrl(trimmed) !== null) return true;
            return "Use an http or https image URL.";
        },
        onChange(newValue: string) {
            const valid = pageUrl(newValue);
            if (Native && valid !== null) void Native.allowIcon(valid);
        }
    },
    scriptUtils: {
        type: OptionType.BOOLEAN,
        description: "Shows Download Script when you right-click a message with an attachment.",
        displayName: "Script Utils functions",
        default: false
    },
    nightyPrefix: {
        type: OptionType.STRING,
        description: "One character placed before dls.",
        displayName: "Nighty Prefix",
        default: ".",
        placeholder: ".",
        componentProps: { maxLength: 1 },
        hidden() {
            return !this.store.scriptUtils;
        },
        isValid(value: string) {
            if (!this.store.scriptUtils) return true;
            if (value.trim().length === 1) return true;
            return "Use one non-whitespace character.";
        }
    }
});

const routeListeners = new Set<() => void>();
let onNightyRoute = false;

function setNightyRouteActive(active: boolean) {
    if (onNightyRoute === active) return;
    onNightyRoute = active;
    for (const listener of routeListeners) listener();
}

function useIsNightySelected(): boolean {
    const [selected, setSelected] = useState(onNightyRoute);

    useEffect(() => {
        const update = () => setSelected(onNightyRoute);
        routeListeners.add(update);
        update();
        return () => {
            routeListeners.delete(update);
        };
    }, []);

    return selected;
}

function getNightyIcon(iconType: string | undefined, customUrl: string | undefined): string {
    if (iconType === "grayscale") return GRAYSCALE_ICON;
    if (iconType === "custom") {
        const valid = pageUrl(customUrl);
        if (valid !== null) return valid;
    }
    return BLUE_ICON;
}

function openInBrowser(url: string) {
    if (IS_DISCORD_DESKTOP) {
        void VencordNative.native.openExternal(url);
    } else {
        window.open(url, "_blank", "noopener,noreferrer");
    }
}

interface LinkIconProps {
    className?: string;
    size?: string;
    color?: string;
}

interface PrivateChannelLinkProps {
    selected: boolean;
    route: string;
    icon: (props: LinkIconProps) => ReactElement;
    text: string;
    className?: string;
    role?: "listitem";
    tabIndex?: number;
    onFocus?: () => void;
    "data-nighty-tab"?: string;
}

interface PrivateChannelListItem {
    role: "listitem";
    tabIndex: number;
    onFocus: () => void;
    [dataAttribute: `data-${string}`]: string;
}

const PrivateChannelLink = findComponentByCodeLazy<PrivateChannelLinkProps>(
    "nitroHoverGradient",
    "refresh_sm",
    "listItemRef"
);

const usePrivateChannelListItem: (id: string) => PrivateChannelListItem = findByCodeLazy(
    'role:"listitem"',
    "setFocus",
    "useState(-1)"
);

function useResolvedIconSrc(): string {
    const { iconType, customIconUrl } = settings.use(ICON_SETTINGS_KEYS);
    const configuredSrc = getNightyIcon(iconType, customIconUrl);

    useEffect(() => {
        if (Native && iconType === "custom") {
            const valid = pageUrl(customIconUrl);
            if (valid !== null) void Native.allowIcon(valid);
        }
    }, [iconType, customIconUrl]);

    return configuredSrc;
}

function NightyIcon({ className }: LinkIconProps) {
    const configuredSrc = useResolvedIconSrc();
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        setFailed(false);
    }, [configuredSrc]);

    return (
        <img
            alt=""
            aria-hidden="true"
            className={classes(className, cl("icon"))}
            draggable={false}
            height={20}
            onError={() => setFailed(true)}
            src={failed ? BLUE_ICON : configuredSrc}
            width={20}
        />
    );
}

function NightyServerListIcon() {
    const configuredSrc = useResolvedIconSrc();
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        setFailed(false);
    }, [configuredSrc]);

    return (
        <div className={cl("guild-icon-container")}>
            <img
                alt=""
                aria-hidden="true"
                className={cl("guild-icon")}
                draggable={false}
                height={24}
                onError={() => setFailed(true)}
                src={failed ? BLUE_ICON : configuredSrc}
                width={24}
            />
        </div>
    );
}

function NightyMenuIcon({ className, height = 20, width = 20 }: { className?: string; height?: number | string; width?: number | string; }) {
    const iconSrc = useResolvedIconSrc();

    return (
        <svg aria-hidden="true" className={className} height={height} viewBox="0 0 24 24" width={width}>
            <image height="18" href={iconSrc} width="18" x="3" y="3" />
        </svg>
    );
}

function sendDownloadScript(message: Message) {
    const channel = ChannelStore.getChannel(message.channel_id);
    if (!channel) return;
    const prefix = settings.plain.nightyPrefix.trim().slice(0, 1) || ".";
    const options = MessageActions.getSendMessageOptionsForReply({
        channel,
        message,
        shouldMention: false,
        showMentionToggle: false
    });
    void sendMessage(channel.id, { content: `${prefix}dls` }, true, options);
}

const messageContextMenuPatch: NavContextMenuPatchCallback = (children, { message }: { message?: Message; }) => {
    if (!settings.plain.scriptUtils || !message || message.attachments.length === 0) return;

    const group = findGroupChildrenByChildId("copy-text", children);
    const item = (
        <Menu.MenuItem
            id="vc-nighty-dls"
            label="Download Script"
            icon={NightyMenuIcon}
            leadingAccessory={{ type: "icon", icon: NightyMenuIcon }}
            action={() => sendDownloadScript(message)}
        />
    );

    if (group) {
        const index = group.findIndex(c => c?.props?.id === "copy-text");
        group.splice(index + 1, 0, item);
    } else {
        children.push(<Menu.MenuGroup>{item}</Menu.MenuGroup>);
    }
};

type EmbedState = "checking" | "ready" | "needsReload";

const NightyPage = ErrorBoundary.wrap(function NightyPage() {
    const { url } = settings.use(URL_SETTINGS_KEYS);
    const configured = pageUrl(url);
    const configuredOrigin = configured !== null ? new URL(configured).origin : null;
    const iframeRef = useRef<HTMLIFrameElement>(null);

    const [src, setSrc] = useState<string | null>(configured);
    const [embedState, setEmbedState] = useState<EmbedState>(Native && configured !== null ? "checking" : "ready");
    const [loaded, setLoaded] = useState(false);
    const [slowLoad, setSlowLoad] = useState(false);
    const [loadError, setLoadError] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);

    const frameOrigin = src !== null ? new URL(src).origin : null;

    useEffect(() => {
        setNightyRouteActive(true);
        return () => setNightyRouteActive(false);
    }, []);

    useEffect(() => {
        setLoaded(false);
        setSlowLoad(false);
        setLoadError(false);

        if (configured === null) {
            setSrc(null);
            setEmbedState("ready");
            return;
        }

        if (!Native) {
            setSrc(configured);
            setEmbedState("ready");
            return;
        }

        let cancelled = false;
        setEmbedState("checking");
        void Promise.all([
            Native.allowEmbed(configured),
            Native.localEmbedUrl(configured)
        ]).then(([allowRes, resolvedUrl]) => {
            if (cancelled) return;
            setSrc(resolvedUrl || configured);
            setEmbedState(allowRes.needsReload ? "needsReload" : "ready");
        }).catch(() => {
            if (cancelled) return;
            setSrc(configured);
            setEmbedState("ready");
        });

        return () => {
            cancelled = true;
        };
    }, [configured]);

    useEffect(() => {
        if (embedState !== "ready" || loaded || loadError || src === null) return;
        const timer = setTimeout(() => setSlowLoad(true), SLOW_LOAD_TIMEOUT_MS);
        return () => clearTimeout(timer);
    }, [embedState, loaded, loadError, src, reloadKey]);

    useEffect(() => {
        if (!Native || frameOrigin === null || configuredOrigin === null) return;

        const handleMessage = (e: MessageEvent) => {
            if (e.source !== iframeRef.current?.contentWindow) return;
            if (e.origin !== frameOrigin) return;
            if (
                e.data?.type === "VC_NIGHTY_TOKEN"
                && typeof e.data.token === "string"
                && e.data.origin === frameOrigin
            ) {
                void Native.saveToken(configuredOrigin, e.data.token);
            }
        };

        window.addEventListener("message", handleMessage);
        return () => window.removeEventListener("message", handleMessage);
    }, [frameOrigin, configuredOrigin]);

    if (configured === null) {
        return (
            <div className={cl("page")}>
                <div className={cl("empty")}>
                    <h2>No URL configured</h2>
                    <p>Configure a valid HTTP or HTTPS URL in the Nighty Tab plugin settings to view it here.</p>
                </div>
            </div>
        );
    }

    if (embedState === "needsReload") {
        return (
            <div className={cl("page")}>
                <div className={cl("empty")}>
                    <h2>Reload required</h2>
                    <p>Discord needs to reload once so its security policy allows embedding {configuredOrigin}.</p>
                    <div className={cl("actions")}>
                        <Button size="small" onClick={() => location.reload()}>
                            Reload Discord
                        </Button>
                        <Button size="small" variant="secondary" onClick={() => openInBrowser(configured)}>
                            Open in Browser
                        </Button>
                    </div>
                </div>
            </div>
        );
    }

    if (loadError) {
        return (
            <div className={cl("page")}>
                <div className={cl("empty")}>
                    <h2>Failed to load page</h2>
                    <p>Could not load {configuredOrigin} inside Discord.</p>
                    <div className={cl("actions")}>
                        <Button
                            size="small"
                            onClick={() => {
                                setLoadError(false);
                                setLoaded(false);
                                setSlowLoad(false);
                                setReloadKey(k => k + 1);
                            }}
                        >
                            Retry
                        </Button>
                        <Button size="small" variant="secondary" onClick={() => openInBrowser(configured)}>
                            Open in Browser
                        </Button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className={cl("page")}>
            {(embedState === "checking" || !loaded) && (
                <div className={cl("loader")}>
                    <div className={cl("spinner")} />
                    <span className={cl("loader-text")}>Loading Nighty...</span>
                    {slowLoad && (
                        <div className={cl("actions")}>
                            <Button
                                size="small"
                                variant="secondary"
                                onClick={() => {
                                    setSlowLoad(false);
                                    setReloadKey(k => k + 1);
                                }}
                            >
                                Reload Tab
                            </Button>
                            <Button size="small" variant="secondary" onClick={() => openInBrowser(configured)}>
                                Open in Browser
                            </Button>
                        </div>
                    )}
                </div>
            )}
            {embedState === "ready" && src !== null && (
                <iframe
                    key={reloadKey}
                    ref={iframeRef}
                    className={classes(cl("frame"), !loaded && cl("frame-hidden"))}
                    onError={() => setLoadError(true)}
                    onLoad={() => {
                        setLoaded(true);
                        setSlowLoad(false);
                    }}
                    src={src}
                    title="Nighty"
                />
            )}
        </div>
    );
}, { noop: true });

const NightyGuildButton = ErrorBoundary.wrap(function NightyGuildButton() {
    const { tabPlacement } = settings.use(TAB_PLACEMENT_KEYS);
    const isSelected = useIsNightySelected();

    if (tabPlacement === "sidebar") return null;

    return (
        <ServerListItem
            id="vc-nighty-guild-button"
            icon={NightyServerListIcon}
            tooltip="Nighty"
            selected={isSelected}
            onClick={(e: MouseEvent<Element>) => {
                e.preventDefault();
                e.stopPropagation();
                NavigationRouter.transitionTo(NIGHTY_ROUTE);
            }}
        />
    );
}, { noop: true });

const NightyTab = ErrorBoundary.wrap(function NightyTab() {
    const { tabPlacement } = settings.use(TAB_PLACEMENT_KEYS);
    const listItem = usePrivateChannelListItem(NIGHTY_ITEM_ID);
    const isSelected = useIsNightySelected();

    if (tabPlacement === "guilds") return null;

    return (
        <PrivateChannelLink
            {...listItem}
            data-nighty-tab="true"
            icon={NightyIcon}
            route={NIGHTY_ROUTE}
            selected={isSelected}
            text="Nighty Tab"
        />
    );
}, { noop: true });

export default definePlugin({
    name: "Nighty Tab",
    description: "Adds a Nighty tab on the home sidebar.",
    authors: [
        {
            name: "Mime | N0_.q3",
            id: 123456789012345678n
        },
        {
            name: "rico | wkcp",
            id: 1361736124858630274n
        }
    ],
    enabledByDefault: true,
    dependencies: ["MessagePopoverAPI", "ServerListAPI"],
    settings,
    contextMenus: {
        message: messageContextMenuPatch
    },
    messagePopoverButton: {
        icon: NightyMenuIcon,
        render(message) {
            if (!settings.plain.scriptUtils || message.attachments.length === 0) return null;
            const channel = ChannelStore.getChannel(message.channel_id);
            if (!channel) return null;
            return {
                label: "Download Script",
                icon: NightyMenuIcon,
                message,
                channel,
                onClick: () => sendDownloadScript(message)
            };
        }
    },

    renderGuildButton: NightyGuildButton,

    start() {
        const src = pageUrl(settings.plain.url);
        if (Native && src !== null) void Native.allowEmbed(src);
        if (Native && settings.plain.iconType === "custom") {
            const iconSrc = pageUrl(settings.plain.customIconUrl);
            if (iconSrc !== null) void Native.allowIcon(iconSrc);
        }
        addServerListElement(ServerListRenderPosition.Above, this.renderGuildButton);
    },

    stop() {
        removeServerListElement(ServerListRenderPosition.Above, this.renderGuildButton);
    },

    patches: [
        {
            find: '"section-divider-top"',
            replacement: {
                match: /\(0,\i\.jsx\)\(\i,\{\},"section-divider-top"\)/,
                replace: "$self.renderExtraTab(),$&"
            }
        },
        {
            find: ".QUEST_HOME,render:",
            replacement: {
                match: /\(0,(\i)\.jsx\)\((\i\.\i),\{path:\i\.\i\.QUEST_HOME,render:\i,impressionName:\i\.ImpressionNames\.QUEST_HOME,disableTrack:!0\}\)/,
                replace: '$&,(0,$1.jsx)($2,{path:"/nighty",render:$self.renderPage})'
            }
        },
        {
            find: "isChatRoute:!0",
            replacement: {
                match: /\i\.\i\.FAMILY_CENTER\],render:(\i),isChatRoute:!0\}/,
                replace: '$&,{path:["/nighty"],render:$1}'
            }
        }
    ],

    renderExtraTab() {
        return <NightyTab />;
    },

    renderPage() {
        return <NightyPage />;
    }
});

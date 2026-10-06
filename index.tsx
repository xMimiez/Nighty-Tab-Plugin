/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: MIT
 */

import "./style.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { addServerListElement, removeServerListElement, ServerListRenderPosition } from "@api/ServerList";
import { definePluginSettings, migratePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import { sendMessage } from "@utils/discord";
import { classes } from "@utils/misc";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { Message } from "@vencord/discord-types";
import { findByCodeLazy, findComponentByCodeLazy } from "@webpack";
import { ChannelStore, Menu, MessageActions, NavigationRouter, SelectedChannelStore, useEffect, useState, useStateFromStores } from "@webpack/common";
import type { MouseEvent, ReactElement } from "react";

const Native = IS_DISCORD_DESKTOP
    ? VencordNative.pluginHelpers["Nighty Tab"] as PluginNative<typeof import("./native")>
    : null;

const NIGHTY_ROUTE = "/nighty";
const NIGHTY_ITEM_ID = "nighty";
const cl = classNameFactory("vc-nighty-tab-");
const SETTINGS_KEYS = ["url"] as const;
const ICON_SETTINGS_KEYS = ["iconType", "customIconUrl"] as const;

const settings = definePluginSettings({
    url: {
        type: OptionType.STRING,
        description: "URL the Nighty tab opens in the page beside the home sidebar.",
        placeholder: "https://",
        default: "",
        isValid(value: string) {
            const trimmed = value.trim();
            if (trimmed === "") return true;
            try {
                const url = new URL(trimmed);
                if (url.protocol === "https:" || url.protocol === "http:") return true;
            } catch { /* invalid URL */ }
            return "Use an http or https URL";
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
            if (trimmed === "") return "Enter a valid image URL";
            try {
                const url = new URL(trimmed);
                if (url.protocol === "https:" || url.protocol === "http:") return true;
            } catch { /* invalid */ }
            return "Use an http or https image URL";
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
            if (value.length === 1) return true;
            return "Use one character.";
        }
    }
});

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
import blueIconBase64 from "file://./asset/icon.png?base64";
import grayscaleIconBase64 from "file://./asset/icon-grayscale.png?base64";

const BLUE_ICON = `data:image/png;base64,${blueIconBase64}`;
const GRAYSCALE_ICON = `data:image/png;base64,${grayscaleIconBase64}`;

function getNightyIcon(iconType: string | undefined, customUrl: string | undefined): string {
    if (iconType === "grayscale") return GRAYSCALE_ICON;
    if (iconType === "custom") {
        const trimmed = (customUrl ?? "").trim();
        if (trimmed !== "") return trimmed;
    }
    return BLUE_ICON;
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

function NightyIcon({ className }: LinkIconProps) {
    const { iconType, customIconUrl } = settings.use(ICON_SETTINGS_KEYS);
    const iconSrc = getNightyIcon(iconType, customIconUrl);

    useEffect(() => {
        if (Native && iconType === "custom" && customIconUrl) {
            void Native.allowEmbed(customIconUrl);
        }
    }, [iconType, customIconUrl]);

    return (
        <img
            alt=""
            aria-hidden="true"
            className={classes(className, cl("icon"))}
            draggable={false}
            height={20}
            src={iconSrc}
            width={20}
        />
    );
}

function NightyMenuIcon({ className, height = 20, width = 20 }: { className?: string; height?: number | string; width?: number | string; }) {
    const { iconType, customIconUrl } = settings.use(ICON_SETTINGS_KEYS);
    const iconSrc = getNightyIcon(iconType, customIconUrl);

    return (
        <svg aria-hidden="true" className={className} height={height} viewBox="0 0 24 24" width={width}>
            <image height="18" href={iconSrc} width="18" x="3" y="3" />
        </svg>
    );
}

function sendDownloadScript(message: Message) {
    const channel = ChannelStore.getChannel(message.channel_id);
    if (!channel) return;
    const options = MessageActions.getSendMessageOptionsForReply({
        channel,
        message,
        shouldMention: false,
        showMentionToggle: false
    });
    void sendMessage(channel.id, { content: `${settings.store.nightyPrefix.slice(0, 1)}dls` }, true, options);
}

const messageContextMenuPatch: NavContextMenuPatchCallback = (children, { message }: { message?: Message; }) => {
    if (!settings.store.scriptUtils || !message || message.attachments.length === 0) return;

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

const NightyPage = ErrorBoundary.wrap(function NightyPage() {
    const { url } = settings.use(SETTINGS_KEYS);
    const src = pageUrl(url);
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        setLoaded(false);
    }, [src]);

    useEffect(() => {
        if (Native && src !== null) void Native.allowEmbed(src);
    }, [src]);

    useEffect(() => {
        const handleMessage = (e: MessageEvent) => {
            if (e.data?.type === "VC_NIGHTY_TOKEN" && typeof e.data.token === "string" && typeof e.data.host === "string") {
                if (Native) void Native.saveToken(e.data.host, e.data.token);
            }
        };
        window.addEventListener("message", handleMessage);
        return () => window.removeEventListener("message", handleMessage);
    }, []);

    if (src === null) {
        return (
            <div className={cl("page")}>
                <div className={cl("empty")}>
                    <h2>No URL configured</h2>
                    <p>Configure a valid HTTP or HTTPS URL in the Nighty Tab plugin settings to view it here.</p>
                </div>
            </div>
        );
    }

    return (
        <div className={cl("page")}>
            {!loaded && (
                <div className={cl("loader")}>
                    <div className={cl("spinner")} />
                    <span className={cl("loader-text")}>Loading Nighty...</span>
                </div>
            )}
            <iframe
                className={classes(cl("frame"), !loaded && cl("frame-hidden"))}
                onLoad={() => setLoaded(true)}
                src={src}
                title="Nighty"
            />
        </div>
    );
}, { noop: true });

const GuildlessServerListItemComponent = findComponentByCodeLazy("tooltip:", "lowerBadgeSize:");
const ServerListItemPillComponent = findComponentByCodeLazy("=!1,hovered:", "=!1,unread:", "=!1,disabled:");

function NightyServerListIcon() {
    const { iconType, customIconUrl } = settings.use(ICON_SETTINGS_KEYS);
    const iconSrc = getNightyIcon(iconType, customIconUrl);

    useEffect(() => {
        if (Native && iconType === "custom" && customIconUrl) {
            void Native.allowEmbed(customIconUrl);
        }
    }, [iconType, customIconUrl]);

    return (
        <img
            alt=""
            aria-hidden="true"
            className={cl("guild-icon")}
            draggable={false}
            height={24}
            src={iconSrc}
            width={24}
        />
    );
}

const NightyGuildButton = ErrorBoundary.wrap(function NightyGuildButton() {
    const { tabPlacement } = settings.use(["tabPlacement"]);
    const isSelected = useStateFromStores(
        [SelectedChannelStore],
        () => window.location.pathname.startsWith(NIGHTY_ROUTE)
    );
    const [hovered, setHovered] = useState(false);

    if (tabPlacement === "sidebar") return null;

    const icon = (
        <div className={cl("guild-icon-container")}>
            <NightyServerListIcon />
        </div>
    );

    return (
        <div className={cl("guild-item-container")}>
            <div className={cl("guild-item-pill")}>
                <ServerListItemPillComponent
                    unread={false}
                    selected={isSelected}
                    hovered={hovered}
                    className={classes(
                        cl("guild-pill"),
                        isSelected && "selected",
                        hovered && "hovered"
                    )}
                />
            </div>
            <div className={cl("guild-button-container")}>
                <GuildlessServerListItemComponent
                    icon={() => icon}
                    tooltip="Nighty"
                    showPill={false}
                    selected={isSelected}
                    className={cl("guild-button")}
                    onClick={(e: MouseEvent<Element>) => {
                        e.preventDefault();
                        e.stopPropagation();
                        NavigationRouter.transitionTo(NIGHTY_ROUTE);
                    }}
                    onMouseEnter={() => setHovered(true)}
                    onMouseLeave={() => setHovered(false)}
                />
            </div>
        </div>
    );
}, { noop: true });

const NightyTab = ErrorBoundary.wrap(function NightyTab() {
    const { tabPlacement } = settings.use(["tabPlacement"]);
    if (tabPlacement === "guilds") return null;

    const listItem = usePrivateChannelListItem(NIGHTY_ITEM_ID);
    const isSelected = useStateFromStores(
        [SelectedChannelStore],
        () => window.location.pathname.startsWith(NIGHTY_ROUTE)
    );

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
            if (!settings.store.scriptUtils || message.attachments.length === 0) return null;
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

    renderGuildButton: ErrorBoundary.wrap(NightyGuildButton, { noop: true }),

    start() {
        const src = pageUrl(settings.store.url);
        if (Native && src !== null) void Native.allowEmbed(src);
        if (Native && settings.store.iconType === "custom" && settings.store.customIconUrl) {
            void Native.allowEmbed(settings.store.customIconUrl);
        }
        addServerListElement(ServerListRenderPosition.Above, this.renderGuildButton);
    },

    stop() {
        removeServerListElement(ServerListRenderPosition.Above, this.renderGuildButton);
    },

    patches: [
        {
            // Exports the guildless server list item component used by the guild bar button.
            find: '="DOWNLOAD_APPS";function',
            replacement: {
                match: /(?<!GuildlessServerListItemComponent:\(\)=>\i,)(?=\i:\(\)=>\i.{0,30000}?asContainer:!\i.{0,50};let (\i)=\i.forwardRef\(function)/,
                replace: "GuildlessServerListItemComponent:()=>$1,"
            }
        },
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

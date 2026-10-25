"use client"

import type React from "react"
import { useState, useEffect, useRef, useCallback, useLayoutEffect } from "react"
import { io, type Socket } from "socket.io-client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { FaceMemeArtwork } from "@/components/facememe-artwork"
import { NormalMemeArtwork } from "@/components/normalmeme-artwork"
import {
  MessageSquare,
  ImageIcon,
  Mic,
  Volume2,
  Music,
  Users,
  Send,
  Smile,
  Star,
  X,
  Palette,
  Upload,
  Trash2,
  Shield,
  Award,
  ChevronDown,
  ChevronUp,
  ExternalLink,
} from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

type ChatMessage = {
  message: string
  literal_emojis?: string[]
  id?: string
  badge?: BadgeAsset | null
} & (
  | { system: true; actor?: string; user?: never; rank?: never; rank_color?: never }
  | { system?: false; user: string; rank?: string; rank_color?: string | null; actor?: never }
)

interface ManagedUser {
  username: string
  rank: string
  rank_id: string | null
  staff: boolean | null
  rank_immutable: boolean
  points: number
  chat_timeout_until: string | null
  registered_at: string | null
  message_count: number
  email: string | null
  banned: boolean
  badges: BadgeAsset[]
  visible_badge_id: string | null
}

interface BadgeAsset {
  asset_id: string
  name: string
  file: string
  url: string
}

interface RankOption {
  id: string
  rank: string
  color: string
  staff: boolean | null
  rank_immutable: boolean
}

interface RolePermissions {
  rank_id: string
  staff: boolean | null
  capabilities: Record<string, unknown>
}

interface StreamPointSettings {
  points_per_interval: string
  interval_seconds: string
}

interface PointPricing {
  send_your_chaos: Record<string, number>
  catalog: {
    emoji: {
      default: number
      categories: Record<string, number>
      items: Record<string, number>
    }
    theme: {
      default: number
      categories: Record<string, number>
      items: Record<string, number>
    }
    sound: {
      default: number
      categories: Record<string, number>
      items: Record<string, number>
      play_default: number
      play_items: Record<string, number>
    }
  }
  proposal_rewards: Record<string, {
    default: number
    exclusive: number
    items: Record<string, number>
  }>
  asset_limits: {
    emoji: { max_px: number; max_px_admin: number }
    sound: { max_length: number; max_length_admin: number }
  }
}

interface SoundAsset {
  asset_id: string
  name: string
  file: string
  title: string
  display_name: string
  loudness: number
  price: number
  favorite: boolean
  play_cost: number
  url: string
}

interface EmojiAsset {
  asset_id: string
  name: string
  file: string
  price: number
  url: string
}

interface ShopAsset {
  asset_id: string
  name: string
  title?: string
  price: number
  owned: boolean
  status: "owned" | "available" | "unavailable"
  loudness?: number
  url: string
}

interface ThemeOption extends ShopAsset {
  primary_color: string
  panel_color: string
  accent_color: string
  background_image_exists: boolean
  background_opacity: number
  background_image_name: string | null
  is_standard: boolean
  price_overridden?: boolean
}

interface AdminThemeDraft {
  name: string
  primary_color: string
  panel_color: string
  accent_color: string
  price: string
  background_url: string
  background_opacity: string
  background_file: File | null
  remove_background: boolean
}

interface ShopCatalog {
  emoji: ShopAsset[]
  sound: ShopAsset[]
  theme: ThemeOption[]
  proposal_prices?: Record<"emoji" | "sound", {
    default: number
    exclusive: number
    items: Record<string, number>
  }>
}

interface AdminAsset {
  asset_id: string
  name: string
  file: string
  display_name?: string
  loudness?: number
  price: number
  default_price: number
  price_exception: number | null
  play_default_price?: number
  play_price_exception?: number | null
  url: string
}

interface AdminAssetDraft {
  name: string
  display_name: string
  loudness: string
  price: string
  play_price: string
}

type ProposalDraft = {
  name: string
  sourceUrl: string
  loudness: string
  exclusive: boolean
}

type ShopCategory = "emoji" | "sound" | "theme" | "add"

const STANDARD_THEME_ID = "65f0a0000000000000000001"
const STANDARD_THEME: ThemeOption = {
  asset_id: STANDARD_THEME_ID,
  name: "Standard",
  title: "Standard",
  price: 0,
  owned: true,
  status: "owned",
  primary_color: "#000000",
  panel_color: "#171717",
  accent_color: "#f9a8d4",
  background_image_exists: false,
  background_opacity: 0,
  background_image_name: null,
  is_standard: true,
  url: "",
}

const SEND_YOUR_CHAOS_ACTIONS = [
  { key: "normalmeme", label: "Normal meme" },
  { key: "facemememe", label: "Face meme" },
  { key: "soundmeme", label: "Soundboard" },
  { key: "tts", label: "TTS" },
] as const

function isValidPointBalance(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function parsePointPrice(value: string): number | null {
  const normalized = value.trim()
  if (!/^(?:-1|\d+)$/.test(normalized)) return null
  const price = Number(normalized)
  return Number.isSafeInteger(price) && price >= -1 ? price : null
}

function contrastingTextColor(color: string): "#000000" | "#ffffff" {
  const match = /^#([0-9a-f]{6})$/i.exec(color)
  if (!match) return "#ffffff"
  const channels = [0, 2, 4].map((offset) => {
    const value = Number.parseInt(match[1].slice(offset, offset + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
  return luminance > 0.179 ? "#000000" : "#ffffff"
}

function formatBanUntil(value: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return "Unknown"
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? ""
  return `${part("day")}.${part("month")}.${part("year")} ${part("hour")}:${part("minute")}:${part("second")}`
}

export default function AnnoyTheStreamer() {
  const [isChatOnly, setIsChatOnly] = useState(false)
  const [chatPopoutBlocked, setChatPopoutBlocked] = useState(false)
  const [username, setUsername] = useState<string>("")
  const [sessionRestored, setSessionRestored] = useState(false)
  const [usernameInput, setUsernameInput] = useState("")
  const [emailInput, setEmailInput] = useState("")
  const [passwordInput, setPasswordInput] = useState("")
  const [passwordConfirmation, setPasswordConfirmation] = useState("")
  const [registrationUsername, setRegistrationUsername] = useState("")
  const [registrationPassword, setRegistrationPassword] = useState("")
  const [showRegistrationForm, setShowRegistrationForm] = useState(false)
  const [passwordResetMode, setPasswordResetMode] = useState(false)
  const [passwordResetUsername, setPasswordResetUsername] = useState("")
  const [passwordResetToken, setPasswordResetToken] = useState("")
  const [passwordResetAccount, setPasswordResetAccount] = useState<{
    username: string
    recoveryType: "password" | "email"
  } | null>(null)
  const [resetPasswordInput, setResetPasswordInput] = useState("")
  const [resetPasswordConfirmation, setResetPasswordConfirmation] = useState("")
  const [resetEmailInput, setResetEmailInput] = useState("")
  const [authError, setAuthError] = useState("")
  const [logoutError, setLogoutError] = useState("")
  const [isLoggingOut, setIsLoggingOut] = useState(false)
  const [currentRank, setCurrentRank] = useState("User")
  const [currentPermissions, setCurrentPermissions] = useState<RolePermissions | null>(null)
  const [currentPoints, setCurrentPoints] = useState<number | null>(null)
  const [usageCosts, setUsageCosts] = useState<Record<string, number>>({})
  const [actionError, setActionError] = useState("")
  const [pointsLoading, setPointsLoading] = useState(true)
  const [pointsError, setPointsError] = useState(false)
  const [adminView, setAdminView] = useState<"users" | "admin" | "pricing" | "soundboard" | "emoji" | "themes" | "badges">("users")
  const [lookupUsername, setLookupUsername] = useState("")
  const [managedUser, setManagedUser] = useState<ManagedUser | null>(null)
  const [adminBadges, setAdminBadges] = useState<BadgeAsset[]>([])
  const [adminBadgeName, setAdminBadgeName] = useState("")
  const [adminBadgeFile, setAdminBadgeFile] = useState<File | null>(null)
  const [adminBadgeUrl, setAdminBadgeUrl] = useState("")
  const [adminBadgeDrafts, setAdminBadgeDrafts] = useState<Record<string, { name: string }>>({})
  const [adminBadgeReplacementFiles, setAdminBadgeReplacementFiles] = useState<Record<string, File | null>>({})
  const [adminBadgeReplacementUrls, setAdminBadgeReplacementUrls] = useState<Record<string, string>>({})
  const [adminBadgeError, setAdminBadgeError] = useState("")
  const [adminBadgeNotice, setAdminBadgeNotice] = useState("")
  const [adminBadgeSaving, setAdminBadgeSaving] = useState(false)
  const [adminBadgeLookup, setAdminBadgeLookup] = useState("")
  const [selectedAdminBadgeId, setSelectedAdminBadgeId] = useState<string | null>(null)
  const [adminBadgeGrantName, setAdminBadgeGrantName] = useState("")
  const [adminBadgeGranting, setAdminBadgeGranting] = useState(false)
  const [showUserInfoPanel, setShowUserInfoPanel] = useState(false)
  const userInfoPanelBodyRef = useRef<HTMLDivElement>(null)
  const onlineUsersScrollRef = useRef<HTMLDivElement>(null)
  const userInfoPanelRef = useRef({ open: false })
  const [userInfo, setUserInfo] = useState<ManagedUser | null>(null)
  const managedUserRef = useRef<ManagedUser | null>(null)
  const [userInfoLoading, setUserInfoLoading] = useState(false)
  const [userInfoError, setUserInfoError] = useState("")
  const [userBadgeSelection, setUserBadgeSelection] = useState("")
  const [userBadgeSaving, setUserBadgeSaving] = useState(false)
  const [userRecoveryToken, setUserRecoveryToken] = useState("")
  const [userRecoveryError, setUserRecoveryError] = useState("")
  const [userRecoveryNotice, setUserRecoveryNotice] = useState("")
  const [userRecoveryCopyNotice, setUserRecoveryCopyNotice] = useState("")
  useLayoutEffect(() => {
    const card = userInfoPanelBodyRef.current?.closest<HTMLElement>("[data-user-info-panel]")
    const body = userInfoPanelBodyRef.current
    if (!card || !body) return

    const desktop = window.matchMedia("(min-width: 1024px)").matches
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const content = body.querySelector<HTMLElement>("[data-user-info-content]")
    if (content) content.style.overflowY = "hidden"
    let animationTimeout = 0

    if (showUserInfoPanel) {
      const closedCardHeight = Math.max(
        0,
        card.getBoundingClientRect().height - body.getBoundingClientRect().height,
      )
      const maxHeight = Number.parseFloat(getComputedStyle(card).maxHeight)
      const targetCardHeight = desktop
        ? Math.max(closedCardHeight, Math.min(375, Number.isFinite(maxHeight) ? maxHeight : 375))
        : closedCardHeight + (body.querySelector<HTMLElement>("[data-user-info-content]")?.scrollHeight ?? 0)
      const targetBodyHeight = targetCardHeight - closedCardHeight

      card.style.height = `${closedCardHeight}px`
      body.style.height = "0px"
      void card.offsetHeight

      if (reducedMotion) {
        card.style.height = desktop ? `${targetCardHeight}px` : "auto"
        body.style.height = desktop ? `${targetBodyHeight}px` : "auto"
        if (content) content.style.overflowY = "auto"
      } else {
        animationTimeout = window.setTimeout(() => {
          card.style.height = `${targetCardHeight}px`
          body.style.height = `${targetBodyHeight}px`
        }, 16)
      }
    } else {
      const currentCardHeight = card.getBoundingClientRect().height
      const currentBodyHeight = body.getBoundingClientRect().height
      const closedCardHeight = Math.max(0, currentCardHeight - currentBodyHeight)

      card.style.height = `${currentCardHeight}px`
      body.style.height = `${currentBodyHeight}px`
      void card.offsetHeight

      if (reducedMotion) {
        card.style.height = "auto"
        body.style.height = "0px"
        if (content) content.style.overflowY = "auto"
      } else {
        animationTimeout = window.setTimeout(() => {
          card.style.height = `${closedCardHeight}px`
          body.style.height = "0px"
        }, 16)
      }
    }

    return () => window.clearTimeout(animationTimeout)
  }, [showUserInfoPanel])
  const [currentModerationStatus, setCurrentModerationStatus] = useState<{
    chat_timeout_until: string | null
  } | null>(null)
  const [timeoutClock, setTimeoutClock] = useState(() => Date.now())
  const [rankOptions, setRankOptions] = useState<RankOption[]>([])
  const [rankSelection, setRankSelection] = useState("")
  const [pointsAdjustment, setPointsAdjustment] = useState("")
  const [timeoutDurationSeconds, setTimeoutDurationSeconds] = useState("")
  const [adminError, setAdminError] = useState("")
  const [adminNotice, setAdminNotice] = useState("")
  const [confirmingPasswordReset, setConfirmingPasswordReset] = useState(false)
  const [confirmingEmailReset, setConfirmingEmailReset] = useState(false)
  const [adminIssuedRecoveryToken, setAdminIssuedRecoveryToken] = useState("")
  const [adminRecoveryCopyNotice, setAdminRecoveryCopyNotice] = useState("")
  const [pointPricing, setPointPricing] = useState<PointPricing | null>(null)
  const [editedCatalogPrices, setEditedCatalogPrices] = useState<Record<string, string>>({})
  const [pricingLoading, setPricingLoading] = useState(false)
  const [pricingSaving, setPricingSaving] = useState(false)
  const [pricingError, setPricingError] = useState("")
  const [pricingNotice, setPricingNotice] = useState("")
  const [newEmojiItem, setNewEmojiItem] = useState("")
  const [newEmojiItemPrice, setNewEmojiItemPrice] = useState("")
  const [newSoundItem, setNewSoundItem] = useState("")
  const [newSoundItemPrice, setNewSoundItemPrice] = useState("")
  const [newThemeItem, setNewThemeItem] = useState("")
  const [newThemeItemPrice, setNewThemeItemPrice] = useState("")
  const [newSoundPlayItem, setNewSoundPlayItem] = useState("")
  const [newSoundPlayItemPrice, setNewSoundPlayItemPrice] = useState("")
  const [newEmojiProposalItem, setNewEmojiProposalItem] = useState("")
  const [newEmojiProposalItemPrice, setNewEmojiProposalItemPrice] = useState("")
  const [newSoundProposalItem, setNewSoundProposalItem] = useState("")
  const [newSoundProposalItemPrice, setNewSoundProposalItemPrice] = useState("")
  const [adminSounds, setAdminSounds] = useState<AdminAsset[]>([])
  const [adminEmojis, setAdminEmojis] = useState<AdminAsset[]>([])
  const [adminAssetDrafts, setAdminAssetDrafts] = useState<Record<string, AdminAssetDraft>>({})
  const [adminSoundFile, setAdminSoundFile] = useState<File | null>(null)
  const [adminSoundUrl, setAdminSoundUrl] = useState("")
  const [adminSoundName, setAdminSoundName] = useState("")
  const [adminSoundLoudness, setAdminSoundLoudness] = useState("")
  const [adminSoundPrice, setAdminSoundPrice] = useState("")
  const [adminEmojiFile, setAdminEmojiFile] = useState<File | null>(null)
  const [adminEmojiUrl, setAdminEmojiUrl] = useState("")
  const [adminEmojiName, setAdminEmojiName] = useState("")
  const [adminEmojiPrice, setAdminEmojiPrice] = useState("")
  const [adminAssetsLoading, setAdminAssetsLoading] = useState(false)
  const [adminAssetSaving, setAdminAssetSaving] = useState(false)
  const [adminAssetDefaultPrices, setAdminAssetDefaultPrices] = useState<Record<"sound" | "emoji", number | null>>({
    sound: 100,
    emoji: 100,
  })
  const [adminAssetUploadErrors, setAdminAssetUploadErrors] = useState<Record<"sound" | "emoji", string>>({
    sound: "",
    emoji: "",
  })
  const [adminAssetManageErrors, setAdminAssetManageErrors] = useState<Record<"sound" | "emoji", string>>({
    sound: "",
    emoji: "",
  })
  const [adminAssetLookup, setAdminAssetLookup] = useState<Record<"sound" | "emoji", string>>({
    sound: "",
    emoji: "",
  })
  const [selectedAdminAsset, setSelectedAdminAsset] = useState<Record<"sound" | "emoji", string | null>>({
    sound: null,
    emoji: null,
  })
  const [shopCategory, setShopCategory] = useState<ShopCategory>("emoji")
  const [themeOptions, setThemeOptions] = useState<ThemeOption[]>([STANDARD_THEME])
  const [activeThemeId, setActiveThemeId] = useState(STANDARD_THEME_ID)
  const [savedThemeId, setSavedThemeId] = useState(STANDARD_THEME_ID)
  const [themePickerOpen, setThemePickerOpen] = useState(false)
  const [themeSaving, setThemeSaving] = useState(false)
  const [themeError, setThemeError] = useState("")
  const [adminThemes, setAdminThemes] = useState<ThemeOption[]>([])
  const [adminThemeName, setAdminThemeName] = useState("")
  const [adminThemePrimary, setAdminThemePrimary] = useState("#000000")
  const [adminThemePanel, setAdminThemePanel] = useState("#171717")
  const [adminThemeAccent, setAdminThemeAccent] = useState("#f9a8d4")
  const [adminThemePrice, setAdminThemePrice] = useState("")
  const [adminThemeBackgroundUrl, setAdminThemeBackgroundUrl] = useState("")
  const [adminThemeBackgroundFile, setAdminThemeBackgroundFile] = useState<File | null>(null)
  const adminThemeBackgroundInputRef = useRef<HTMLInputElement>(null)
  const [adminThemeBackgroundOpacity, setAdminThemeBackgroundOpacity] = useState("")
  const [adminThemeSaving, setAdminThemeSaving] = useState(false)
  const [adminThemeCreateError, setAdminThemeCreateError] = useState("")
  const [adminThemeManageError, setAdminThemeManageError] = useState("")
  const [adminThemeCreateNotice, setAdminThemeCreateNotice] = useState("")
  const [adminThemeManageNotice, setAdminThemeManageNotice] = useState("")
  const [adminThemeLookup, setAdminThemeLookup] = useState("")
  const [selectedAdminThemeId, setSelectedAdminThemeId] = useState<string | null>(null)
  const [adminThemeDrafts, setAdminThemeDrafts] = useState<Record<string, AdminThemeDraft>>({})
  const [adminThemePreview, setAdminThemePreview] = useState<ThemeOption | null>(null)
  const themePreviewGeneration = useRef(0)
  const [shopThemePreview, setShopThemePreview] = useState<ThemeOption | null>(null)
  const [proposalDrafts, setProposalDrafts] = useState<Record<"emoji" | "sound", ProposalDraft>>({
    emoji: { name: "", sourceUrl: "", loudness: "", exclusive: false },
    sound: { name: "", sourceUrl: "", loudness: "", exclusive: false },
  })
  const [proposalFiles, setProposalFiles] = useState<Record<"emoji" | "sound", File | null>>({
    emoji: null,
    sound: null,
  })
  const [proposalSaving, setProposalSaving] = useState<"emoji" | "sound" | null>(null)
  const [emojiShopSearch, setEmojiShopSearch] = useState("")
  const [soundShopSearch, setSoundShopSearch] = useState("")
  const [themeShopSearch, setThemeShopSearch] = useState("")
  const [shopAssets, setShopAssets] = useState<ShopCatalog>({ emoji: [], sound: [], theme: [] })
  const [shopProposalPrices, setShopProposalPrices] = useState<NonNullable<ShopCatalog["proposal_prices"]> | null>(null)
  const [shopLoading, setShopLoading] = useState(false)
  const [shopError, setShopError] = useState("")
  const [shopNotice, setShopNotice] = useState("")
  const [purchasingAssetId, setPurchasingAssetId] = useState<string | null>(null)

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [hoveredChatMessage, setHoveredChatMessage] = useState<number | null>(null)
  const [chatInput, setChatInput] = useState("")
  const [chatError, setChatError] = useState("")
  const [onlineUsers, setOnlineUsers] = useState<string[]>([])
  const [onlineUserRanks, setOnlineUserRanks] = useState<Record<string, { rank: string; rank_color: string | null }>>({})
  const [showEmojiPanel, setShowEmojiPanel] = useState(false)
  const [emojiUrls, setEmojiUrls] = useState<Record<string, string>>({})
  const [usableEmojis, setUsableEmojis] = useState<EmojiAsset[]>([])
  const [assetListsLoading, setAssetListsLoading] = useState(false)
  const [sounds, setSounds] = useState<SoundAsset[]>([])
  const [assetLoadError, setAssetLoadError] = useState("")
  const [soundSearch, setSoundSearch] = useState("");
  const [activeTab, setActiveTab] = useState("facememe")
  const [showOnlineList, setShowOnlineList] = useState(false)
  useLayoutEffect(() => {
    const scrollArea = onlineUsersScrollRef.current
    if (!scrollArea || !window.matchMedia("(min-width: 1024px)").matches) return

    const timeout = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? null
      : window.setTimeout(() => {
          scrollArea.style.overflowY = "auto"
        }, 220)

    scrollArea.style.overflowY = timeout === null ? "auto" : "hidden"
    return () => {
      if (timeout !== null) window.clearTimeout(timeout)
    }
  }, [showOnlineList])
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamPointSettings, setStreamPointSettings] = useState<StreamPointSettings>({
    points_per_interval: "100",
    interval_seconds: "60",
  })
  const [streamSettingsLoading, setStreamSettingsLoading] = useState(false)
  const [streamSettingsSaving, setStreamSettingsSaving] = useState(false)
  const isActiveTimeout = (timeoutUntil: string | null) => {
    if (!timeoutUntil) return false
    const expiresAt = Date.parse(timeoutUntil)
    return Number.isFinite(expiresAt) && expiresAt > timeoutClock
  }
  const isChatRestricted =
    currentModerationStatus === null ||
    isActiveTimeout(currentModerationStatus.chat_timeout_until)
  const timeoutDeadlines = [
    currentModerationStatus?.chat_timeout_until,
    managedUser?.chat_timeout_until,
  ]
    .map((timeoutUntil) => timeoutUntil ? Date.parse(timeoutUntil) : NaN)
    .filter((expiresAt) => Number.isFinite(expiresAt) && expiresAt > timeoutClock)
  const nextTimeoutDeadline = timeoutDeadlines.length ? Math.min(...timeoutDeadlines) : null

  const socketRef = useRef<Socket | null>(null)
  const chatBoxRef = useRef<HTMLDivElement>(null)
  const chatInputRef = useRef<HTMLInputElement>(null)
  const previewAudioRef = useRef<HTMLAudioElement | null>(null)
  const pendingShopRequestIds = useRef<Record<string, string>>({})
  const pendingUseRequestIds = useRef<Record<string, string>>({})
  const pendingPointAdjustment = useRef<{
    username: string
    amount: number
    requestId: string
  } | null>(null)

  const acceptPointBalance = useCallback((value: unknown) => {
    if (!isValidPointBalance(value)) {
      setPointsError(true)
      setPointsLoading(false)
      return
    }
    setCurrentPoints(value)
    setPointsError(false)
    setPointsLoading(false)
  }, [])

  const permission = (name: string) => currentPermissions?.capabilities[name] === true
  const isAdmin = permission("admin_console")
  const canInspectUsers = permission("inspect_users")
  const canManageTimeouts = permission("manage_timeouts")
  const activeTheme = adminThemePreview ?? shopThemePreview ?? themeOptions.find((themeOption) => themeOption.asset_id === activeThemeId) ?? STANDARD_THEME
  const renderThemeSwatch = (themeOption: ThemeOption, sizeClass: string, extraClass = "") => (
    <span
      aria-hidden="true"
      className={`relative isolate inline-block flex-shrink-0 ${sizeClass} ${extraClass}`}
      style={{
        borderColor: themeOption.primary_color,
      }}
    >
      <span
        className="absolute inset-0 overflow-hidden rounded-[inherit]"
        style={{
          background: `linear-gradient(135deg, ${themeOption.panel_color} 50%, ${themeOption.accent_color} 50%)`,
        }}
      >
        {themeOption.background_image_exists && themeOption.url && (
          <img
            src={themeOption.url}
            alt=""
            className="pointer-events-none absolute inset-0 h-full w-full rounded-[inherit] object-cover"
            style={{ opacity: themeOption.background_opacity }}
          />
        )}
      </span>
      <span
        className="absolute -right-[4px] -top-[4px] z-10 h-3 w-3 rounded-full border border-card"
        style={{ backgroundColor: themeOption.primary_color }}
      />
    </span>
  )
  const isFreeAction = (action: string) => {
    const freeActions = currentPermissions?.capabilities.free_actions
    return Array.isArray(freeActions) && freeActions.includes(action)
  }

  const refreshCurrentPoints = useCallback(async () => {
    setPointsError(false)
    setPointsLoading(true)
    try {
      const response = await fetch("/api/auth/session")
      const result = await response.json()
      if (!response.ok || result.authenticated !== true) {
        throw new Error(result.message || "Could not load point balance")
      }
      acceptPointBalance(result.points)
    } catch {
      setPointsError(true)
      setPointsLoading(false)
    }
  }, [acceptPointBalance])

  const getUsageCost = (action: string) => {
    if (isFreeAction(action)) return 0
    const cost = usageCosts[action]
    return Number.isSafeInteger(cost) && cost >= -1 ? cost : -1
  }
  const displayedUsageCost = (action: string) => getUsageCost(action)
  const canAffordAction = (action: string) =>
    currentPoints !== null && getUsageCost(action) >= 0 && currentPoints >= getUsageCost(action)
  const actionButtonText = (label: string, action: string) => {
    if (isAdmin || isFreeAction(action)) return label
    const cost = displayedUsageCost(action)
    return cost < 0 ? `${label} · Unavailable` : `${label} · ${cost}❖`
  }
  const canAffordSound = (sound: SoundAsset) =>
    isFreeAction("soundmeme") ||
    (currentPoints !== null && sound.play_cost >= 0 && currentPoints >= sound.play_cost)

  const updateActionPrice = (action: string, value: number) => {
    setPointPricing((current) => current
      ? { ...current, send_your_chaos: { ...current.send_your_chaos, [action]: value } }
      : current)
  }

  const updateCatalogDefault = (assetType: "emoji" | "sound" | "theme", value: number) => {
    setPointPricing((current) => current
      ? {
          ...current,
          catalog: {
            ...current.catalog,
            [assetType]: { ...current.catalog[assetType], default: value },
          },
        }
      : current)
  }

  const updateSoundPlayDefault = (value: number) => {
    setPointPricing((current) => current
      ? {
          ...current,
          catalog: {
            ...current.catalog,
            sound: { ...current.catalog.sound, play_default: value },
          },
        }
      : current)
  }

  const updateSoundPlayItemPrice = (key: string, value: number) => {
    setPointPricing((current) => current
      ? {
          ...current,
          catalog: {
            ...current.catalog,
            sound: {
              ...current.catalog.sound,
              play_items: { ...current.catalog.sound.play_items, [key]: value },
            },
          },
        }
      : current)
  }

  const updateEditedSoundPlayItemPrice = (key: string, rawValue: string) => {
    const inputKey = `sound-play:${key}`
    setEditedCatalogPrices((current) => ({ ...current, [inputKey]: rawValue }))
    if (!/^\d+$/.test(rawValue)) return
    const price = Number(rawValue)
    if (!Number.isSafeInteger(price)) return
    setPricingError("")
    updateSoundPlayItemPrice(key, price)
  }

  const removeSoundPlayItemPrice = (key: string) => {
    setEditedCatalogPrices((current) => {
      const updated = { ...current }
      delete updated[`sound-play:${key}`]
      return updated
    })
    setPointPricing((current) => {
      if (!current) return current
      const playItems = { ...current.catalog.sound.play_items }
      delete playItems[key]
      return {
        ...current,
        catalog: {
          ...current.catalog,
          sound: { ...current.catalog.sound, play_items: playItems },
        },
      }
    })
  }

  const updateCatalogItemPrice = (
    assetType: "emoji" | "sound" | "theme",
    key: string,
    value: number,
  ) => {
    setPointPricing((current) => current
      ? {
          ...current,
          catalog: {
            ...current.catalog,
            [assetType]: {
              ...current.catalog[assetType],
              items: { ...current.catalog[assetType].items, [key]: value },
            },
          },
        }
      : current)
  }

  const updateEditedCatalogItemPrice = (
    assetType: "emoji" | "sound" | "theme",
    key: string,
    rawValue: string,
  ) => {
    const inputKey = `${assetType}:${key}`
    setEditedCatalogPrices((current) => ({ ...current, [inputKey]: rawValue }))
    const price = parsePointPrice(rawValue)
    if (price === null) return
    setPricingError("")
    updateCatalogItemPrice(assetType, key, price)
  }

  const updateEditedThemePrice = (themeId: string, rawValue: string) => {
    setEditedCatalogPrices((current) => ({ ...current, [`theme:${themeId}`]: rawValue }))
    if (rawValue.trim() === "") {
      setPricingError("")
      setPointPricing((current) => {
        if (!current) return current
        const items = { ...current.catalog.theme.items }
        delete items[themeId]
        return {
          ...current,
          catalog: {
            ...current.catalog,
            theme: { ...current.catalog.theme, items },
          },
        }
      })
      return
    }
    const price = parsePointPrice(rawValue)
    if (price === null) return
    setPricingError("")
    updateCatalogItemPrice("theme", themeId, price)
  }

  const removeCatalogItemPrice = (assetType: "emoji" | "sound" | "theme", key: string) => {
    setEditedCatalogPrices((current) => {
      const updated = { ...current }
      delete updated[`${assetType}:${key}`]
      return updated
    })
    setPointPricing((current) => {
      if (!current) return current
      const items = { ...current.catalog[assetType].items }
      delete items[key]
      return {
        ...current,
        catalog: {
          ...current.catalog,
          [assetType]: { ...current.catalog[assetType], items },
        },
      }
    })
  }

  const loadAdminAssets = useCallback(async (assetType: "sound" | "emoji") => {
    setAdminAssetsLoading(true)
    setAdminAssetManageErrors((current) => ({ ...current, [assetType]: "" }))
    try {
      const response = await fetch(`/api/admin/assets/${assetType}`)
      const result = await response.json()
      if (!response.ok || !Array.isArray(result.assets)) {
        throw new Error(result.message || `Could not load ${assetType} assets`)
      }
      const assets = result.assets as AdminAsset[]
      if (typeof result.default_price === "number") {
        setAdminAssetDefaultPrices((current) => ({ ...current, [assetType]: result.default_price }))
      } else {
        const assetDefault = assets.find((asset) => typeof asset.default_price === "number")?.default_price
        if (typeof assetDefault === "number") {
          setAdminAssetDefaultPrices((current) => ({ ...current, [assetType]: assetDefault }))
        }
      }
      if (assetType === "sound") setAdminSounds(assets)
      else setAdminEmojis(assets)
      setAdminAssetDrafts((current) => ({
        ...current,
        ...Object.fromEntries(assets.map((asset) => [asset.asset_id, {
          name: asset.name,
          display_name: asset.display_name || asset.name,
          loudness: Number(asset.loudness ?? 1).toFixed(2),
          price: asset.price_exception === null ? "" : String(asset.price_exception),
          play_price: asset.play_price_exception == null ? "" : String(asset.play_price_exception),
        }])),
      }))
    } catch (error) {
      setAdminAssetManageErrors((current) => ({
        ...current,
        [assetType]: error instanceof Error ? error.message : `Could not load ${assetType} assets`,
      }))
    } finally {
      setAdminAssetsLoading(false)
    }
  }, [])

  const loadAdminBadges = useCallback(async () => {
    setAdminBadgeError("")
    try {
      const response = await fetch("/api/admin/badges")
      const result = await response.json()
      if (!response.ok || !Array.isArray(result.badges)) {
        throw new Error(result.message || "Could not load badges")
      }
      const badges = result.badges as BadgeAsset[]
      setAdminBadges(badges)
      setAdminBadgeDrafts((current) => ({
        ...current,
        ...Object.fromEntries(badges.map((badge) => [badge.asset_id, { name: badge.name }])),
      }))
    } catch (error) {
      setAdminBadgeError(error instanceof Error ? error.message : "Could not load badges")
    }
  }, [])

  useEffect(() => {
    if (isAdmin && adminView === "soundboard") void loadAdminAssets("sound")
    if (isAdmin && adminView === "emoji") void loadAdminAssets("emoji")
    if (isAdmin && adminView === "users") void loadAdminBadges()
    if (isAdmin && adminView === "badges") void loadAdminBadges()
  }, [adminView, isAdmin, loadAdminAssets, loadAdminBadges])

  const createAdminBadge = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (adminBadgeFile && adminBadgeUrl.trim()) {
      setAdminBadgeError("Choose an image file or enter an image URL, not both.")
      return
    }
    if (!adminBadgeFile && !adminBadgeUrl.trim()) {
      setAdminBadgeError("Choose an image file or enter an image URL.")
      return
    }
    const formData = new FormData()
    formData.set("name", adminBadgeName)
    if (adminBadgeFile) formData.set("file", adminBadgeFile)
    if (adminBadgeUrl.trim()) formData.set("source_url", adminBadgeUrl.trim())
    setAdminBadgeSaving(true)
    setAdminBadgeError("")
    setAdminBadgeNotice("")
    try {
      const response = await fetch("/api/admin/badges", { method: "POST", body: formData })
      const result = await response.json()
      if (!response.ok) throw new Error(result.message || "Could not create badge")
      setAdminBadgeName("")
      setAdminBadgeFile(null)
      setAdminBadgeUrl("")
      setAdminBadgeNotice("Badge added.")
      await loadAdminBadges()
    } catch (error) {
      setAdminBadgeError(error instanceof Error ? error.message : "Could not create badge")
    } finally {
      setAdminBadgeSaving(false)
    }
  }

  const saveAdminBadge = async (badge: BadgeAsset) => {
    const name = adminBadgeDrafts[badge.asset_id]?.name ?? badge.name
    const file = adminBadgeReplacementFiles[badge.asset_id]
    const sourceUrl = (adminBadgeReplacementUrls[badge.asset_id] ?? "").trim()
    if (file && sourceUrl) {
      setAdminBadgeError("Choose a replacement image file or enter an image URL, not both.")
      return
    }
    setAdminBadgeSaving(true)
    setAdminBadgeError("")
    setAdminBadgeNotice("")
    try {
      let response: Response
      if (file || sourceUrl) {
        const formData = new FormData()
        formData.set("name", name)
        if (file) formData.set("file", file)
        if (sourceUrl) formData.set("source_url", sourceUrl)
        response = await fetch(`/api/admin/badges/${badge.asset_id}`, { method: "PATCH", body: formData })
      } else {
        response = await fetch(`/api/admin/badges/${badge.asset_id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        })
      }
      const result = await response.json()
      if (!response.ok) throw new Error(result.message || "Could not update badge")
      setAdminBadgeReplacementFiles((current) => ({ ...current, [badge.asset_id]: null }))
      setAdminBadgeReplacementUrls((current) => ({ ...current, [badge.asset_id]: "" }))
      setAdminBadgeNotice("Badge updated.")
      await loadAdminBadges()
    } catch (error) {
      setAdminBadgeError(error instanceof Error ? error.message : "Could not update badge")
    } finally {
      setAdminBadgeSaving(false)
    }
  }

  const removeAdminBadge = async (badge: BadgeAsset) => {
    if (!window.confirm(`Remove badge "${badge.name}" and revoke it from all users?`)) return
    setAdminBadgeSaving(true)
    setAdminBadgeError("")
    setAdminBadgeNotice("")
    try {
      const response = await fetch(`/api/admin/badges/${badge.asset_id}`, { method: "DELETE" })
      const result = await response.json()
      if (!response.ok) throw new Error(result.message || "Could not remove badge")
      setSelectedAdminBadgeId(null)
      setAdminBadgeNotice("Badge removed.")
      await loadAdminBadges()
    } catch (error) {
      setAdminBadgeError(error instanceof Error ? error.message : "Could not remove badge")
    } finally {
      setAdminBadgeSaving(false)
    }
  }

  const grantBadgeOnline = async (badge: BadgeAsset) => {
    setAdminBadgeGranting(true)
    setAdminBadgeError("")
    setAdminBadgeNotice("")
    try {
      const response = await fetch(`/api/admin/badges/${badge.asset_id}/grant-online`, { method: "POST" })
      const result = await response.json()
      if (!response.ok) throw new Error(result.message || "Could not grant badge")
      setAdminBadgeNotice(`Granted badge to ${result.granted_count} online user${result.granted_count === 1 ? "" : "s"}.`)
    } catch (error) {
      setAdminBadgeError(error instanceof Error ? error.message : "Could not grant badge")
    } finally {
      setAdminBadgeGranting(false)
    }
  }

  const uploadAdminAsset = async (
    assetType: "sound" | "emoji",
    event: React.FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault()
    const file = assetType === "sound" ? adminSoundFile : adminEmojiFile
    const sourceUrl = assetType === "sound" ? adminSoundUrl.trim() : adminEmojiUrl.trim()
    if (file && sourceUrl) {
      setAdminAssetUploadErrors((current) => ({
        ...current,
        [assetType]: "Choose a file or enter a URL to upload, not both.",
      }))
      return
    }
    if (!file && !sourceUrl) {
      setAdminAssetUploadErrors((current) => ({ ...current, [assetType]: "Choose a file or enter a URL to upload." }))
      return
    }
    const formData = new FormData()
    if (file) formData.set("file", file)
    if (sourceUrl) formData.set("source_url", sourceUrl)
    if (assetType === "sound") {
      formData.set("display_name", adminSoundName)
      formData.set("loudness", adminSoundLoudness)
      if (adminSoundPrice !== "") formData.set("price", adminSoundPrice)
    } else {
      formData.set("name", adminEmojiName)
      if (adminEmojiPrice !== "") formData.set("price", adminEmojiPrice)
    }
    setAdminAssetSaving(true)
    setAdminAssetUploadErrors((current) => ({ ...current, [assetType]: "" }))
    setAdminAssetManageErrors((current) => ({ ...current, [assetType]: "" }))
    setAdminNotice("")
    try {
      const response = await fetch(`/api/admin/assets/${assetType}`, {
        method: "POST",
        body: formData,
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.message || `Could not upload ${assetType}`)
      if (assetType === "sound") {
        setAdminSoundFile(null)
        setAdminSoundUrl("")
        setAdminSoundName("")
        setAdminSoundLoudness("")
        setAdminSoundPrice("")
      } else {
        setAdminEmojiFile(null)
        setAdminEmojiUrl("")
        setAdminEmojiName("")
        setAdminEmojiPrice("")
      }
      setAdminNotice(`${assetType === "sound" ? "Sound" : "Emoji"} uploaded.`)
      await loadAdminAssets(assetType)
      await fetchShopCatalog().then(setShopAssets)
      await refreshOwnedAssetLists()
      if (assetType === "emoji") await refreshPublicEmojiUrls()
    } catch (error) {
      setAdminAssetUploadErrors((current) => ({
        ...current,
        [assetType]: error instanceof Error ? error.message : `Could not upload ${assetType}`,
      }))
    } finally {
      setAdminAssetSaving(false)
    }
  }

  const saveAdminAsset = async (assetType: "sound" | "emoji", asset: AdminAsset) => {
    const draft = adminAssetDrafts[asset.asset_id]
    if (!draft) return
    const price = draft.price === "" ? null : parsePointPrice(draft.price)
    const playPrice = draft.play_price === ""
      ? null
      : /^\d+$/.test(draft.play_price) && Number.isSafeInteger(Number(draft.play_price))
        ? Number(draft.play_price)
        : NaN
    const loudness = draft.loudness === "" ? 1 : Number(draft.loudness)
    if (
      (draft.price !== "" && price === null) ||
      (assetType === "sound" && (!Number.isFinite(loudness) || loudness < 0 || loudness > 2)) ||
      (assetType === "sound" && draft.play_price !== "" && !Number.isSafeInteger(playPrice))
    ) {
      setAdminAssetManageErrors((current) => ({
        ...current,
        [assetType]: "Enter a valid price and sound loudness from 0 to 2.",
      }))
      return
    }
    setAdminAssetSaving(true)
    setAdminAssetManageErrors((current) => ({ ...current, [assetType]: "" }))
    setAdminNotice("")
    try {
      const response = await fetch(`/api/admin/assets/${assetType}/${asset.asset_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(assetType === "sound"
            ? { display_name: draft.display_name, loudness }
            : { name: draft.name }),
          price,
          ...(assetType === "sound" ? { play_price: playPrice } : {}),
        }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.message || `Could not update ${assetType}`)
      setAdminNotice(`${assetType === "sound" ? "Sound" : "Emoji"} updated.`)
      await loadAdminAssets(assetType)
      await fetchShopCatalog().then(setShopAssets)
      await refreshOwnedAssetLists()
      if (assetType === "emoji") await refreshPublicEmojiUrls()
    } catch (error) {
      setAdminAssetManageErrors((current) => ({
        ...current,
        [assetType]: error instanceof Error ? error.message : `Could not update ${assetType}`,
      }))
    } finally {
      setAdminAssetSaving(false)
    }
  }

  const removeAdminAsset = async (assetType: "sound" | "emoji", asset: AdminAsset) => {
    if (!window.confirm(`Remove ${assetType} "${asset.display_name || asset.name}"?`)) return
    setAdminAssetSaving(true)
    setAdminAssetManageErrors((current) => ({ ...current, [assetType]: "" }))
    setAdminNotice("")
    try {
      const response = await fetch(`/api/admin/assets/${assetType}/${asset.asset_id}`, {
        method: "DELETE",
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.message || `Could not remove ${assetType}`)
      setAdminNotice(`${assetType === "sound" ? "Sound" : "Emoji"} removed.`)
      await loadAdminAssets(assetType)
      await fetchShopCatalog().then(setShopAssets)
      await refreshOwnedAssetLists()
      if (assetType === "emoji") await refreshPublicEmojiUrls()
    } catch (error) {
      setAdminAssetManageErrors((current) => ({
        ...current,
        [assetType]: error instanceof Error ? error.message : `Could not remove ${assetType}`,
      }))
    } finally {
      setAdminAssetSaving(false)
    }
  }

  const renderAdminAssetManagement = (assetType: "sound" | "emoji") => {
    const assets = assetType === "sound" ? adminSounds : adminEmojis
    const isSound = assetType === "sound"
    const lookup = adminAssetLookup[assetType].trim().toLocaleLowerCase()
    const selectedAsset = assets.find((asset) => asset.asset_id === selectedAdminAsset[assetType])
    const defaultPrice = adminAssetDefaultPrices[assetType] ?? pointPricing?.catalog[assetType].default
    const selectedDraft = selectedAsset ? adminAssetDrafts[selectedAsset.asset_id] : undefined
    const selectedPricePlaceholder = String(selectedAsset?.default_price ?? defaultPrice ?? "")
    return (
      <div className="space-y-4">
        <details className="rounded-md border">
          <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">
            Upload {isSound ? "sound" : "emoji"}
          </summary>
          <form
            className="space-y-2 px-3 pb-3"
            onSubmit={(event) => void uploadAdminAsset(assetType, event)}
          >
          <Input
            value={isSound ? adminSoundName : adminEmojiName}
            onChange={(event) => isSound
              ? setAdminSoundName(event.target.value)
              : setAdminEmojiName(event.target.value)}
            placeholder={isSound ? "Sound Name" : "emojiname"}
            aria-label={isSound ? "Sound name" : "Emoji name"}
            required
          />
          {isSound && (
            <Input
              type="text"
              inputMode="decimal"
              value={adminSoundLoudness}
              onChange={(event) => setAdminSoundLoudness(event.target.value)}
              onBlur={() => {
                if (!adminSoundLoudness.trim()) return
                const value = Number(adminSoundLoudness)
                if (Number.isFinite(value)) setAdminSoundLoudness(value.toFixed(2))
              }}
              placeholder="1.00"
              aria-label="New sound loudness"
            />
          )}
          <Input
            type="number"
            min={-1}
            step={1}
            value={isSound ? adminSoundPrice : adminEmojiPrice}
            onChange={(event) => isSound
              ? setAdminSoundPrice(event.target.value)
              : setAdminEmojiPrice(event.target.value)}
            placeholder={String(defaultPrice ?? "")}
            aria-label={`${isSound ? "Sound" : "Emoji"} price exception`}
          />
          <div className="space-y-1">
            <div className="flex gap-2">
              <Input
                type="url"
                value={isSound ? adminSoundUrl : adminEmojiUrl}
                onChange={(event) => {
                  if (isSound) {
                    setAdminSoundUrl(event.target.value)
                    if (event.target.value) setAdminSoundFile(null)
                  } else {
                    setAdminEmojiUrl(event.target.value)
                    if (event.target.value) setAdminEmojiFile(null)
                  }
                }}
                placeholder="URL..."
                className="h-7 flex-1 sm:h-8"
                aria-label={`${isSound ? "Sound" : "Emoji"} file URL`}
              />
              <div className="relative">
                <Input
                  type="file"
                  accept={isSound ? ".mp3,audio/mpeg" : ".jpg,.jpeg,.png,.gif,image/jpeg,image/png,image/gif"}
                  onChange={(event) => {
                    const file = event.target.files?.[0] ?? null
                    event.currentTarget.value = ""
                    if (isSound) {
                      setAdminSoundFile(file)
                      if (file) setAdminSoundUrl("")
                    } else {
                      setAdminEmojiFile(file)
                      if (file) setAdminEmojiUrl("")
                    }
                  }}
                  className="hidden"
                  id={`admin-${assetType}-file`}
                  aria-label={`${isSound ? "Sound" : "Emoji"} file to upload`}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-7 w-7 bg-transparent sm:h-8 sm:w-8"
                  asChild
                >
                  <label htmlFor={`admin-${assetType}-file`} className="cursor-pointer flex items-center justify-center">
                    <Upload className="h-3 w-3" />
                  </label>
                </Button>
              </div>
            </div>
            {(isSound ? adminSoundFile : adminEmojiFile) && (
              <div className="flex min-w-0 items-center gap-2 text-xs">
                <p className="min-w-0 flex-1 truncate text-muted-foreground">
                  {(isSound ? adminSoundFile : adminEmojiFile)?.name}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 px-2 sm:h-8"
                  onClick={() => isSound ? setAdminSoundFile(null) : setAdminEmojiFile(null)}
                >
                  Clear file
                </Button>
              </div>
            )}
          </div>
          <div className="pt-2">
            <Button type="submit" disabled={adminAssetSaving} className="w-full">
              {adminAssetSaving ? "Uploading..." : `Upload ${isSound ? "sound" : "emoji"}`}
            </Button>
          </div>
          {adminAssetUploadErrors[assetType] && (
            <p role="alert" className="text-sm text-destructive">{adminAssetUploadErrors[assetType]}</p>
          )}
          </form>
        </details>
        <section className="space-y-2 rounded-md border p-3">
          <h3 className="text-sm font-semibold">Manage existing {isSound ? "sounds" : "emojis"}</h3>
          {adminAssetsLoading && <p className="text-xs text-muted-foreground">Loading assets…</p>}
          {!adminAssetsLoading && assets.length === 0 && (
            <p className="text-xs text-muted-foreground">No uploaded assets.</p>
          )}
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              const match = assets.find((asset) =>
                [asset.name, asset.display_name ?? "", asset.file].some((name) =>
                  name.trim().toLocaleLowerCase() === lookup),
              )
              setSelectedAdminAsset((current) => ({
                ...current,
                [assetType]: match?.asset_id ?? null,
              }))
              setAdminAssetManageErrors((current) => ({
                ...current,
                [assetType]: match ? "" : `No ${isSound ? "sound" : "emoji"} found with that name.`,
              }))
            }}
          >
            <div className="min-w-0 flex-1 pr-2">
              <Input
                value={adminAssetLookup[assetType]}
                onChange={(event) => {
                  const value = event.target.value
                  setAdminAssetLookup((current) => ({ ...current, [assetType]: value }))
                  setSelectedAdminAsset((current) => ({ ...current, [assetType]: null }))
                }}
                placeholder={isSound ? "Sound Name" : "emojiname"}
                aria-label={`Find ${isSound ? "sound" : "emoji"} by name`}
              />
            </div>
            <Button type="submit" disabled={adminAssetsLoading}>Load</Button>
          </form>
          {selectedAsset && selectedDraft && (() => {
            const asset = selectedAsset
            const draft = selectedDraft
            return (
              <div key={asset.asset_id} className="space-y-2">
                <div className="flex items-center gap-2">
                  {!isSound && <img src={asset.url} alt="" className="h-8 w-8 rounded object-contain" />}
                  <span className="min-w-0 flex-1 truncate text-xs">{asset.file}</span>
                </div>
                <Input
                  value={isSound ? draft.display_name : draft.name}
                  onChange={(event) => setAdminAssetDrafts((current) => ({
                    ...current,
                    [asset.asset_id]: {
                      ...draft,
                      [isSound ? "display_name" : "name"]: event.target.value,
                    },
                  }))}
                  placeholder={isSound ? "Sound Name" : "emojiname"}
                  aria-label={`${isSound ? "Sound name" : "Emoji name"} for ${asset.name}`}
                />
                {isSound && (
                  <Input
                    type="number"
                    min={0}
                    max={2}
                    step="0.01"
                    value={draft.loudness}
                    onChange={(event) => setAdminAssetDrafts((current) => ({
                      ...current,
                      [asset.asset_id]: { ...draft, loudness: event.target.value },
                    }))}
                    placeholder="1.00"
                    aria-label={`Loudness for ${asset.name}`}
                  />
                )}
                <Input
                  type="number"
                  min={-1}
                  step={1}
                  value={draft.price}
                  onChange={(event) => setAdminAssetDrafts((current) => ({
                    ...current,
                    [asset.asset_id]: { ...draft, price: event.target.value },
                  }))}
                  placeholder={selectedPricePlaceholder}
                  aria-label={`Price exception for ${asset.name}`}
                />
                {isSound && (
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    value={draft.play_price}
                    onChange={(event) => setAdminAssetDrafts((current) => ({
                      ...current,
                      [asset.asset_id]: { ...draft, play_price: event.target.value },
                    }))}
                    placeholder={String(
                      asset.play_default_price ??
                      pointPricing?.catalog.sound.play_default ??
                      10,
                    )}
                    aria-label={`Play price exception for ${asset.name}`}
                  />
                )}
                <div className="grid grid-cols-2 gap-2 pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    disabled={adminAssetSaving}
                    onClick={() => void saveAdminAsset(assetType, asset)}
                  >
                    Save changes
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    className="w-full"
                    disabled={adminAssetSaving}
                    onClick={() => void removeAdminAsset(assetType, asset)}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            )
          })()}
          {adminAssetManageErrors[assetType] && (
            <p role="alert" className="text-sm text-destructive">{adminAssetManageErrors[assetType]}</p>
          )}
        </section>
        {adminNotice && <p role="status" className="text-sm text-muted-foreground">{adminNotice}</p>}
      </div>
    )
  }

  const updateProposalDefault = (proposalType: "sound" | "emoji", value: number) => {
    setPointPricing((current) => current
      ? {
          ...current,
          proposal_rewards: {
            ...current.proposal_rewards,
            [proposalType]: { ...current.proposal_rewards[proposalType], default: value },
          },
        }
      : current)
  }

  const updateProposalExclusive = (proposalType: "sound" | "emoji", value: number) => {
    setPointPricing((current) => current
      ? {
          ...current,
          proposal_rewards: {
            ...current.proposal_rewards,
            [proposalType]: { ...current.proposal_rewards[proposalType], exclusive: value },
          },
        }
      : current)
  }

  const updateProposalItemReward = (
    proposalType: "sound" | "emoji",
    key: string,
    value: number,
  ) => {
    setPointPricing((current) => current
      ? {
          ...current,
          proposal_rewards: {
            ...current.proposal_rewards,
            [proposalType]: {
              ...current.proposal_rewards[proposalType],
              items: { ...current.proposal_rewards[proposalType].items, [key]: value },
            },
          },
        }
      : current)
  }

  const updateEditedProposalItemReward = (
    proposalType: "sound" | "emoji",
    key: string,
    rawValue: string,
  ) => {
    const inputKey = `proposal-${proposalType}:${key}`
    setEditedCatalogPrices((current) => ({ ...current, [inputKey]: rawValue }))
    const price = parsePointPrice(rawValue)
    if (price === null) return
    setPricingError("")
    updateProposalItemReward(proposalType, key, price)
  }

  const removeProposalItemReward = (proposalType: "sound" | "emoji", key: string) => {
    setEditedCatalogPrices((current) => {
      const updated = { ...current }
      delete updated[`proposal-${proposalType}:${key}`]
      return updated
    })
    setPointPricing((current) => {
      if (!current) return current
      const items = { ...current.proposal_rewards[proposalType].items }
      delete items[key]
      return {
        ...current,
        proposal_rewards: {
          ...current.proposal_rewards,
          [proposalType]: { ...current.proposal_rewards[proposalType], items },
        },
      }
    })
  }

  const normalizeProposalItemName = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "")

  const updateAssetLimit = (
    assetType: "sound" | "emoji",
    field: "max_px" | "max_px_admin" | "max_length" | "max_length_admin",
    value: number,
  ) => {
    setPointPricing((current) => current
      ? {
          ...current,
          asset_limits: {
            ...current.asset_limits,
            [assetType]: { ...current.asset_limits[assetType], [field]: value },
          },
        }
      : current)
  }

  const loadPointPricing = useCallback(async () => {
    setPricingLoading(true)
    setPricingError("")
    try {
      const response = await fetch("/api/admin/pricing")
      const result = await response.json()
      if (!response.ok || !result.pricing) {
        throw new Error(result.message || "Could not load pricing")
      }
      setPointPricing(result.pricing)
    } catch (error) {
      setPricingError(error instanceof Error ? error.message : "Could not load pricing")
    } finally {
      setPricingLoading(false)
    }
  }, [])

  const savePointPricing = async () => {
    if (!pointPricing) return
    if (Object.entries(editedCatalogPrices).some(([key, value]) =>
      key.startsWith("sound-play:")
        ? !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))
        : key.startsWith("theme:") && value.trim() === ""
          ? false
        : parsePointPrice(value) === null,
    )) {
      setPricingError("Enter a valid price of -1 or a non-negative whole number.")
      return
    }
    setPricingSaving(true)
    setPricingError("")
    setPricingNotice("")
    try {
      const response = await fetch("/api/admin/pricing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pricing: pointPricing }),
      })
      const result = await response.json()
      if (!response.ok || !result.pricing) {
        throw new Error(result.message || "Could not save pricing")
      }
      setPointPricing(result.pricing)
      setEditedCatalogPrices({})
      setPricingNotice("Pricing saved.")
    } catch (error) {
      setPricingError(error instanceof Error ? error.message : "Could not save pricing")
    } finally {
      setPricingSaving(false)
    }
  }

  const fetchShopCatalog = useCallback(async (): Promise<ShopCatalog> => {
    const response = await fetch("/api/shop/catalog")
    const result = await response.json()
    if (!response.ok || !result.emoji || !result.sound || !result.theme || !result.proposal_prices) {
      throw new Error(result.message || "Could not load the Point Shop")
    }
    setShopProposalPrices(result.proposal_prices)
    return result as ShopCatalog
  }, [])

  const loadAccountTheme = useCallback(async (): Promise<{
    themes: ThemeOption[]
    selected_theme_id: string
  }> => {
    const response = await fetch("/api/account/theme", { cache: "no-store" })
    const result = await response.json()
    if (!response.ok || !Array.isArray(result.themes) || typeof result.selected_theme_id !== "string") {
      throw new Error(result.message || "Could not load the selected theme")
    }
    return { themes: result.themes as ThemeOption[], selected_theme_id: result.selected_theme_id }
  }, [])

  const refreshAccountThemes = useCallback(async () => {
    const accountTheme = await loadAccountTheme()
    const { themes, selected_theme_id } = accountTheme
    setThemeOptions(themes)
    setSavedThemeId(selected_theme_id)
    return accountTheme
  }, [loadAccountTheme])

  const loadAdminThemes = useCallback(async () => {
    const response = await fetch("/api/admin/themes")
    const result = await response.json()
    if (!response.ok || !Array.isArray(result.themes)) {
      throw new Error(result.message || "Could not load themes")
    }
    setAdminThemes(result.themes)
  }, [])

  const refreshPublicEmojiUrls = useCallback(async () => {
    const response = await fetch("/api/public-emojis")
    if (!response.ok) throw new Error(`Emoji image list request failed (${response.status})`)
    const result: { name: string; url: string }[] = await response.json()
    setEmojiUrls(Object.fromEntries(result.map((emoji) => [emoji.name, emoji.url])))
  }, [])

  const refreshOwnedAssetLists = useCallback(async () => {
    const [soundResponse, emojiResponse] = await Promise.all([
      fetch("/api/soundboardlist"),
      fetch("/api/usable-emojis"),
    ])
    const soundResult = await soundResponse.json()
    const emojiResult = await emojiResponse.json()
    if (!soundResponse.ok) {
      throw new Error(soundResult.message || `Sound list request failed (${soundResponse.status})`)
    }
    if (!emojiResponse.ok) {
      throw new Error(emojiResult.message || `Emoji list request failed (${emojiResponse.status})`)
    }
    if (!Array.isArray(soundResult) || !Array.isArray(emojiResult)) {
      throw new Error("Usable asset lists returned an invalid response")
    }
    setSounds(soundResult)
    setUsableEmojis(emojiResult)
    setAssetLoadError("")
  }, [])

  // Utility: cookies
  const getCookie = (name: string) => {
    const value = `; ${document.cookie}`
    const parts = value.split(`; ${name}=`)
    if (parts.length === 2) return parts.pop()?.split(";").shift()
    return ""
  }

  const setCookie = (name: string, value: string, days: number) => {
    const d = new Date()
    d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000)
    document.cookie = `${name}=${value};expires=${d.toUTCString()};path=/`
  }

  // THEME HANDLER
  useEffect(() => {
    const root = document.documentElement
    root.classList.add("dark")
    const backgroundText = contrastingTextColor(activeTheme.primary_color)
    const panelText = contrastingTextColor(activeTheme.panel_color)
    const mutedText = `color-mix(in srgb, ${panelText}, ${panelText === "#ffffff" ? "#000000" : "#ffffff"} 40%)`
    const accentText = contrastingTextColor(activeTheme.accent_color)
    const borderColor = `color-mix(in srgb, ${activeTheme.panel_color}, ${panelText} 35%)`
    const systemMessageBackground = `color-mix(in srgb, ${activeTheme.panel_color}, ${panelText === "#ffffff" ? "#000000" : "#ffffff"} 10%)`
    const systemMessageForeground = mutedText

    root.style.setProperty("--background", activeTheme.primary_color)
    root.style.setProperty("--foreground", backgroundText)
    root.style.setProperty("--card", activeTheme.panel_color)
    root.style.setProperty("--card-foreground", panelText)
    root.style.setProperty("--popover", activeTheme.panel_color)
    root.style.setProperty("--popover-foreground", panelText)
    root.style.setProperty("--primary", activeTheme.accent_color)
    root.style.setProperty("--primary-foreground", accentText)
    root.style.setProperty("--ring", activeTheme.accent_color)
    root.style.setProperty("--secondary", activeTheme.panel_color)
    root.style.setProperty("--secondary-foreground", panelText)
    root.style.setProperty("--muted", activeTheme.panel_color)
    root.style.setProperty("--muted-foreground", mutedText)
    root.style.setProperty("--accent", activeTheme.accent_color)
    root.style.setProperty("--accent-foreground", accentText)
    root.style.setProperty("--destructive-foreground", "#ffffff")
    root.style.setProperty("--border", borderColor)
    root.style.setProperty("--input", borderColor)
    root.style.setProperty("--sidebar", activeTheme.panel_color)
    root.style.setProperty("--sidebar-foreground", panelText)
    root.style.setProperty("--sidebar-primary", activeTheme.accent_color)
    root.style.setProperty("--sidebar-primary-foreground", accentText)
    root.style.setProperty("--sidebar-accent", activeTheme.panel_color)
    root.style.setProperty("--sidebar-accent-foreground", panelText)
    root.style.setProperty("--sidebar-border", borderColor)
    root.style.setProperty("--sidebar-ring", activeTheme.accent_color)
    root.style.setProperty("--chat-system-message-background", systemMessageBackground)
    root.style.setProperty("--chat-system-message-foreground", systemMessageForeground)
  }, [activeTheme])

  useEffect(() => {
    if (!shopThemePreview) return
    const timeout = window.setTimeout(() => setShopThemePreview(null), 3000)
    return () => window.clearTimeout(timeout)
  }, [shopThemePreview])

  useEffect(() => {
    return () => {
      if (adminThemePreview?.url.startsWith("blob:")) URL.revokeObjectURL(adminThemePreview.url)
    }
  }, [adminThemePreview])

  // USERNAME COOKIE HANDLER
  useEffect(() => {
    setIsChatOnly(window.location.pathname === "/chat")
  }, [])

  useEffect(() => {
    const savedUsername = getCookie("ats_username")
    if (savedUsername) setUsernameInput(savedUsername)
    fetch("/api/auth/session")
      .then((response) => {
        if (!response.ok) throw new Error(`Session request failed (${response.status})`)
        return response.json()
      })
      .then((result) => {
        if (!result.authenticated) {
          setCurrentPoints(null)
          setPointsLoading(false)
          return
        }
        acceptPointBalance(result.points)
        setUsername(result.username)
        setCookie("ats_username", result.username, 7)
        setCurrentRank(result.rank)
        setCurrentPermissions(result.permissions ?? null)
        setUsageCosts(result.usage_costs || {})
      })
      .catch(() => {
        setCurrentPoints(null)
        setPointsError(true)
        setPointsLoading(false)
      })
      .finally(() => setSessionRestored(true))
  }, [acceptPointBalance])

  useEffect(() => {
    fetch("/api/admin/ranks")
      .then((response) => response.json())
      .then((result) => setRankOptions(result.ranks || []))
      .catch((error) => console.error("Could not load ranks:", error))
  }, [])

  useEffect(() => {
    if (adminView === "pricing" && isAdmin) void loadPointPricing()
  }, [adminView, isAdmin, loadPointPricing])

  useEffect(() => {
    fetch("/api/admin/streaming")
      .then((response) => response.json())
      .then((result) => setIsStreaming(result.streaming === true))
      .catch((error) => console.error("Could not load streaming status:", error))
  }, [])

  useEffect(() => {
    if (!isAdmin) return
    let cancelled = false
    setStreamSettingsLoading(true)
    fetch("/api/admin/streaming/settings")
      .then(async (response) => {
        const result = await response.json()
        if (!response.ok) throw new Error(result.message || "Could not load stream settings")
        if (!cancelled) {
          setStreamPointSettings({
            points_per_interval: String(result.points_per_interval),
            interval_seconds: String(result.interval_seconds),
          })
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setAdminError(error instanceof Error ? error.message : "Could not load stream settings")
        }
      })
      .finally(() => {
        if (!cancelled) setStreamSettingsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [isAdmin])

  useEffect(() => {
    if (!username) {
      setCurrentModerationStatus(null)
      return
    }

    let cancelled = false
    const refreshModerationStatus = async () => {
      try {
        const response = await fetch(`/api/admin/users/${encodeURIComponent(username)}`)
        const result = await response.json()
        if (!response.ok || !result.user) {
          throw new Error(result.message || "Could not load moderation status")
        }
        if (!cancelled) {
          setCurrentModerationStatus({
            chat_timeout_until: typeof result.user.chat_timeout_until === "string"
              ? result.user.chat_timeout_until
              : null,
          })
        }
      } catch (error) {
        if (!cancelled) console.error("Could not load moderation status:", error)
      }
    }

    void refreshModerationStatus()
    const intervalId = window.setInterval(() => void refreshModerationStatus(), 5000)
    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [username])

  useEffect(() => {
    if (nextTimeoutDeadline === null) return
    const timeoutId = window.setTimeout(
      () => setTimeoutClock(Date.now()),
      Math.max(0, nextTimeoutDeadline - Date.now()) + 10,
    )
    return () => window.clearTimeout(timeoutId)
  }, [nextTimeoutDeadline])

  useEffect(() => {
    if (isChatRestricted) setShowEmojiPanel(false)
  }, [isChatRestricted])

  useEffect(() => {
    userInfoPanelRef.current = { open: showUserInfoPanel }
  }, [showUserInfoPanel])

  useEffect(() => {
    managedUserRef.current = managedUser
  }, [managedUser])

// SOCKET CONNECTION
useEffect(() => {
  if (!username) return;

  // Cleanup
  socketRef.current?.disconnect();

  socketRef.current = io(window.location.origin, {
    query: { username },
    transports: ['websocket', 'polling'],
    autoConnect: false,
  });

  const socket = socketRef.current;

  const refreshVisibleUserInfo = async (changedUsername?: string) => {
    if (!userInfoPanelRef.current.open || !username ||
      (changedUsername && changedUsername.toLowerCase() !== username.toLowerCase())) return
    try {
      const response = await fetch("/api/account/profile")
      const result = await response.json()
      if (!response.ok || !result.user) throw new Error(result.message || "Could not refresh profile")
      setUserInfo(result.user)
      setUserInfoError("")
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not refresh profile"
      setUserInfoError(message)
      console.error("Could not refresh account information:", error)
    }
  }


	socket.on('connect', () => {
	  socket.emit('getusers');
	});

	const localAudioContext = isAdmin ? new AudioContext() : null
	const localAudioElements = new Set<HTMLAudioElement>()
	const playLocalAudio = (src: string, loudness = 1) => {
	  if (!localAudioContext) return
	  const audio = new Audio(src)
	  const source = localAudioContext.createMediaElementSource(audio)
	  const gain = localAudioContext.createGain()
	  gain.gain.value = Math.max(0, Math.min(2, loudness))
	  source.connect(gain)
	  gain.connect(localAudioContext.destination)
	  localAudioElements.add(audio)
	  audio.addEventListener("ended", () => localAudioElements.delete(audio), { once: true })
	  audio.addEventListener("error", () => {
	    localAudioElements.delete(audio)
	    console.error("Local audio playback failed:", audio.error)
	  }, { once: true })
	  if (localAudioContext.state === "suspended") {
	    void localAudioContext.resume().catch((error: unknown) => {
	      console.error("Local audio context could not be resumed:", error)
	    })
	  }
	  void audio.play().catch((error: unknown) => {
	    localAudioElements.delete(audio)
	    if (error instanceof Error && error.name === "NotAllowedError") {
	      console.error("Local audio playback was blocked; allow audio playback for this site.")
	    } else {
	      console.error("Local audio playback failed:", error)
	    }
	  })
	}

	if (isAdmin) {
	  socket.on('playsound', (event: { file?: unknown; loudness?: unknown }) => {
	    if (
	      typeof event?.file !== "string"
	      || !event.file
	      || event.file === "."
	      || event.file === ".."
	      || /[\\/]/.test(event.file)
	    ) return
	    const loudness = typeof event.loudness === "number" && Number.isFinite(event.loudness)
	      ? event.loudness
	      : 1
	    playLocalAudio(`/static/sounds/soundboard/${encodeURIComponent(event.file)}.mp3`, loudness)
	  })

	  socket.on('tts_generated', (event: { _id?: unknown }) => {
	    if (typeof event?._id !== "string" || !/^[a-f\d]{24}$/i.test(event._id)) return
	    playLocalAudio(`/static/sounds/tts/${event._id}_tts.mp3`)
	  })
	}

	socket.on('points_changed', () => {
	  void refreshCurrentPoints()
	  void refreshVisibleUserInfo(username)
	});

  socket.on('usage_costs_changed', () => {
    void refreshOwnedAssetLists().catch((error) => {
      console.error("Could not refresh soundboard prices:", error)
    })
    void fetch("/api/auth/session")
      .then((response) => {
        if (!response.ok) throw new Error(`Session request failed (${response.status})`)
        return response.json()
      })
      .then((result) => {
        if (result.authenticated === true) setUsageCosts(result.usage_costs || {})
      })
      .catch((error) => console.error("Could not refresh action prices:", error))

    if (!isAdmin) {
      setShopLoading(true)
      setShopError("")
      void fetchShopCatalog()
        .then((catalog) => setShopAssets(catalog))
        .catch((error) => {
          setShopError(error instanceof Error ? error.message : "Could not refresh Point Shop prices")
          console.error("Could not refresh Point Shop prices:", error)
        })
        .finally(() => setShopLoading(false))
    }
  });

  socket.on('chat_message', (msg: ChatMessage) => {
    setChatMessages(prev => [...prev, msg]);
    if (msg.system || (msg.user && msg.user.toLowerCase() === username.toLowerCase())) {
      void refreshVisibleUserInfo()
    }
  });

  socket.on('chat_message_rejected', (result: { message: string; text?: string }) => {
    if (result.text) setChatInput((current) => current || result.text || "")
    setChatError(result.message || "Your message could not be sent")
  });

  socket.on('chat_history', (msgs: ChatMessage[]) => {
    setChatMessages(msgs);
  });

  socket.on('asset_catalog_changed', (event: { asset_type: "sound" | "emoji" | "theme" }) => {
    void refreshOwnedAssetLists().catch((error) => {
      console.error("Could not refresh usable assets:", error)
    })
    if (event?.asset_type === "emoji") {
      void refreshPublicEmojiUrls().catch((error) => {
        console.error("Could not refresh public emoji images:", error)
      })
    }
    if (event?.asset_type === "theme") {
      void refreshAccountThemes()
        .catch((error) => {
          console.error("Could not refresh themes:", error)
        })
    }
  })

  socket.on('badge_catalog_changed', () => {
    if (isAdmin) void loadAdminBadges()
  })

  socket.on('badge_data_changed', (event: { usernames?: string[] }) => {
    const usernames = event?.usernames ?? []
    if (usernames.some((changed) => changed.toLowerCase() === username.toLowerCase())) {
      void fetch("/api/account/profile")
        .then(async (response) => {
          const result = await response.json()
          if (!response.ok || !result.user) throw new Error(result.message || "Could not refresh profile")
          setUserInfo((current) => current?.username === username ? result.user : current)
          setUserBadgeSelection(result.user.visible_badge_id ?? "")
        })
        .catch((error) => console.error("Could not refresh badge ownership:", error))
    }
    const managedUsername = managedUserRef.current?.username
    if (managedUsername && usernames.some((changed) => changed.toLowerCase() === managedUsername.toLowerCase())) {
      void fetch(`/api/admin/users/${encodeURIComponent(managedUsername)}`)
        .then(async (response) => {
          const result = await response.json()
          if (!response.ok || !result.user) throw new Error(result.message || "Could not refresh managed user badges")
          setManagedUser((current) =>
            current?.username.toLowerCase() === managedUsername.toLowerCase() ? result.user : current,
          )
        })
        .catch((error) => console.error("Could not refresh managed user badges:", error))
    }
  })

  socket.on('rank_changed', (change: {
    username: string
    rank: string
    rank_color: string | null
    permissions?: RolePermissions | null
    usage_costs?: Record<string, number>
  }) => {
    void refreshVisibleUserInfo(change.username)
    setChatMessages((messages) =>
      messages.map((message) =>
        !message.system && message.user === change.username
          ? { ...message, rank: change.rank, rank_color: change.rank_color }
          : message
      )
    );
    setOnlineUserRanks((ranks) => ({
      ...ranks,
      [change.username]: { rank: change.rank, rank_color: change.rank_color },
    }));
    if (change.username === username) {
      setCurrentRank(change.rank);
      setCurrentPermissions(change.permissions ?? null)
      if (change.usage_costs) setUsageCosts(change.usage_costs)
    }
  });

  socket.on('online_user_ranks', (ranks: Record<string, { rank: string; rank_color: string | null }>) => {
    setOnlineUserRanks(ranks);
  });

  socket.on('update_users', (users: string[]) => {
    console.log('ðŸ‘¥ Online update:', users);  // DEBUG
    setOnlineUsers(users);
  });

  socket.on('streaming_status', (status: { streaming: boolean }) => {
    setIsStreaming(status.streaming === true);
  });

  socket.connect();

  return () => {
    socket.disconnect();
    localAudioElements.forEach((audio) => {
      audio.pause()
      audio.removeAttribute("src")
      audio.load()
    })
    if (localAudioContext) void localAudioContext.close()
  };
}, [username, isAdmin, fetchShopCatalog, refreshAccountThemes, refreshCurrentPoints, refreshPublicEmojiUrls, refreshOwnedAssetLists, loadAdminBadges]);

// CHAT
useEffect(() => {
  if (!username) return;

  const fetchHistory = async () => {
    try {
      const res = await fetch(`/api/chathistory`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const msgs: ChatMessage[] = await res.json();
      setChatMessages(msgs);
    } catch (err) {
      console.error('Failed chat history fetch:', err);
    }
  };

  fetchHistory();
}, [username]);

//LIST OF USERS
useEffect(() => {
  const handleUnload = () => {
    socketRef.current?.emit('user-leave', username);
  };

  window.addEventListener('beforeunload', handleUnload);
  window.addEventListener('pagehide', handleUnload);

  return () => {
    window.removeEventListener('beforeunload', handleUnload);
    window.removeEventListener('pagehide', handleUnload);
  };
}, [username]);

  // AUTO SCROLL CHAT
  useEffect(() => {
    if (chatBoxRef.current) chatBoxRef.current.scrollTop = chatBoxRef.current.scrollHeight
  }, [chatMessages])

// Load public emoji URLs for chat rendering separately from owned composer assets.
useEffect(() => {
  const loadEmojis = async () => {
    try {
      const res = await fetch("/api/public-emojis");
      if (!res.ok) throw new Error(res.statusText);
      const data: { name: string; url: string }[] = await res.json();
      setEmojiUrls(Object.fromEntries(data.map((emoji) => [emoji.name, emoji.url])))
    } catch (err) {
      console.error("Failed to load public emojis:", err);
    }
  };

  loadEmojis();
}, [])

// The backend returns only assets usable by the signed-in account.
useEffect(() => {
  setSounds([])
  setUsableEmojis([])
  setAssetLoadError("")
  if (!username) {
    setAssetListsLoading(false)
    return
  }

  let cancelled = false
  setAssetListsLoading(true)
  const loadUsableAssets = async () => {
    try {
      const [soundResponse, emojiResponse] = await Promise.all([
        fetch("/api/soundboardlist"),
        fetch("/api/usable-emojis"),
      ])
      const soundResult = await soundResponse.json()
      const emojiResult = await emojiResponse.json()
      if (!soundResponse.ok) {
        throw new Error(soundResult.message || `Sound list request failed (${soundResponse.status})`)
      }
      if (!emojiResponse.ok) {
        throw new Error(emojiResult.message || `Emoji list request failed (${emojiResponse.status})`)
      }
      if (!Array.isArray(soundResult) || !Array.isArray(emojiResult)) {
        throw new Error("Usable asset lists returned an invalid response")
      }
      if (cancelled) return
      setSounds(soundResult)
      setUsableEmojis(emojiResult)
    } catch (err) {
      if (cancelled) return
      setAssetLoadError(err instanceof Error ? err.message : "Usable assets could not be loaded")
      console.error("Failed to load usable assets:", err)
    } finally {
      if (!cancelled) setAssetListsLoading(false)
    }
  };

  void loadUsableAssets()
  return () => {
    cancelled = true
  }
}, [username, currentPermissions])

useEffect(() => {
  setShopAssets({ emoji: [], sound: [], theme: [] })
  setShopError("")
  if (!username || isAdmin) {
    setShopLoading(false)
    return
  }

  let cancelled = false
  setShopLoading(true)
  void fetchShopCatalog()
    .then((catalog) => {
      if (!cancelled) setShopAssets(catalog)
    })
    .catch((error) => {
      if (!cancelled) {
        setShopError(error instanceof Error ? error.message : "Could not load the Point Shop")
        console.error("Could not load Point Shop:", error)
      }
    })
    .finally(() => {
      if (!cancelled) setShopLoading(false)
    })
  return () => {
    cancelled = true
  }
}, [fetchShopCatalog, username, isAdmin])

useEffect(() => {
  if (!username) {
    setThemeOptions([STANDARD_THEME])
    setActiveThemeId(STANDARD_THEME_ID)
    setSavedThemeId(STANDARD_THEME_ID)
    setThemePickerOpen(false)
    return
  }

  let cancelled = false
  void loadAccountTheme()
    .then(({ themes, selected_theme_id }) => {
      if (cancelled) return
      setThemeOptions(themes)
      setSavedThemeId(selected_theme_id)
      setActiveThemeId(selected_theme_id)
      setThemeError("")
    })
    .catch((error) => {
      if (!cancelled) {
        setThemeError(error instanceof Error ? error.message : "Could not load the selected theme")
        console.error("Could not load the selected theme:", error)
      }
    })
  return () => {
    cancelled = true
  }
}, [loadAccountTheme, username])

useEffect(() => {
  if (!isAdmin || (adminView !== "pricing" && adminView !== "themes")) return
  void loadAdminThemes().catch((error) => {
    setAdminThemeManageError(error instanceof Error ? error.message : "Could not load themes")
    console.error("Could not load themes:", error)
  })
}, [adminView, isAdmin, loadAdminThemes])

useEffect(() => {
  if (themePickerOpen) {
    setThemePickerOpen(false)
    setActiveThemeId(savedThemeId)
  }
  setAdminThemePreview(null)
}, [activeTab, adminView, shopCategory])



  // STATE: Meme + TTS inputs
  const [faceMemeTop, setFaceMemeTop] = useState("")
  const [faceMemeBottom, setFaceMemeBottom] = useState("")
  const [normalMemeImage, setNormalMemeImage] = useState("")
  const [normalMemeFile, setNormalMemeFile] = useState<File | null>(null)
  const [normalMemeFileData, setNormalMemeFileData] = useState<string | null>(null)
  const [normalMemeTop, setNormalMemeTop] = useState("")
  const [normalMemeBottom, setNormalMemeBottom] = useState("")
  const [ttsText, setTtsText] = useState("")
  const [ttsLanguage, setTtsLanguage] = useState("en")

  const filteredSounds = sounds.filter((s) => s.title.toLowerCase().includes(soundSearch.toLowerCase()))
  const filteredShopAssets = (category: "emoji" | "sound" | "theme") => {
    const query = (
      category === "emoji"
        ? emojiShopSearch
        : category === "sound"
          ? soundShopSearch
          : themeShopSearch
    ).trim().toLowerCase()
    const statusOrder = { available: 0, owned: 1, unavailable: 2 }
    return shopAssets[category]
      .filter((asset) => `${asset.title ?? ""} ${asset.name}`.toLowerCase().includes(query))
      .sort((left, right) =>
        statusOrder[left.status] - statusOrder[right.status]
        || left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
        || left.name.localeCompare(right.name),
      )
  }
  const editableStaffRoleIds = currentPermissions?.capabilities.edit_staff_role_ids
  const assignableRankOptions = rankOptions.filter((option) =>
    option.staff === false && permission("assign_non_staff_rank")
    || option.staff === true
      && Array.isArray(editableStaffRoleIds)
      && editableStaffRoleIds.includes(option.id),
  )
  const canChangeManagedUserRank = Boolean(
    managedUser
    && permission("manage_ranks")
    && assignableRankOptions.length > 0
    && !managedUser.rank_immutable
    && (managedUser.staff
      ? Array.isArray(editableStaffRoleIds) && editableStaffRoleIds.includes(managedUser.rank_id)
      : managedUser.staff === false && permission("edit_non_staff_rank"))
    && (
      managedUser.username.toLowerCase() !== username.toLowerCase()
      || permission("edit_self")
    ),
  )
  const timeoutStaffRoleIds = currentPermissions?.capabilities.timeout_staff_role_ids
  const canTimeoutManagedUser = Boolean(
    managedUser
    && permission("manage_timeouts")
    && (managedUser.staff
      ? Array.isArray(timeoutStaffRoleIds) && timeoutStaffRoleIds.includes(managedUser.rank_id)
      : managedUser.staff === false && permission("timeout_non_staff")),
  )

  useEffect(() => {
    if (!isAdmin) setAdminView("users")
  }, [isAdmin])

  // --- Authentication + Admin logic ---
  const joinAsUsername = (name: string, rank: string, permissions: RolePermissions | null) => {
    setSounds([])
    setUsableEmojis([])
    setAssetLoadError("")
    setAssetListsLoading(true)
    setShowEmojiPanel(false)
    setUsername(name)
    setCurrentModerationStatus(null)
    setCookie("ats_username", name, 7)
    setCurrentRank(rank)
    setCurrentPermissions(permissions)
  }

  const handleLoginSubmit = async () => {
    const name = usernameInput.trim()
    setAuthError("")
    if (!name) {
      setAuthError("Enter your username.")
      return
    }
    if (!passwordInput) {
      setAuthError("Enter your password.")
      return
    }
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: name, password: passwordInput }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.message || "Login failed")
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      joinAsUsername(result.username, result.rank, result.permissions ?? null)
      acceptPointBalance(result.points)
      setUsageCosts(result.usage_costs || {})
      setPasswordInput("")
      setAuthError("")
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Login failed")
    }
  }

  const handleRegistrationSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    const name = registrationUsername.trim()
    setAuthError("")
    if (!name) {
      setAuthError("Enter a username.")
      return
    }
    if (!isValidEmail(emailInput)) {
      setAuthError("Enter a valid email address.")
      return
    }
    if (registrationPassword.length < 8 || registrationPassword.length > 256) {
      setAuthError("Password must be between 8 and 256 characters.")
      return
    }
    if (registrationPassword !== passwordConfirmation) {
      setAuthError("Passwords do not match.")
      return
    }
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intent: "register",
          username: name,
          email: emailInput.trim(),
          password: registrationPassword,
          confirmation: passwordConfirmation,
        }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.message || "Account creation failed")
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      joinAsUsername(result.username, result.rank, result.permissions ?? null)
      acceptPointBalance(result.points)
      setUsageCosts(result.usage_costs || {})
      setEmailInput("")
      setUsernameInput("")
      setPasswordInput("")
      setRegistrationUsername("")
      setRegistrationPassword("")
      setPasswordConfirmation("")
      setPasswordResetUsername("")
      setPasswordResetToken("")
      setPasswordResetAccount(null)
      setResetPasswordInput("")
      setResetPasswordConfirmation("")
      setResetEmailInput("")
      setShowRegistrationForm(false)
      setPasswordResetMode(false)
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Account creation failed")
    }
  }

  const handlePasswordResetSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setAuthError("")
    if (!passwordResetAccount) {
      if (!passwordResetToken.trim()) {
        setAuthError("Enter the one-time account recovery code.")
        return
      }
      try {
        const response = await fetch("/api/auth/password-reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "verify",
            reset_token: passwordResetToken,
          }),
        })
        const result = await response.json()
        if (!response.ok) throw new Error(result.message || "Could not verify reset code")
        if (result.recovery_type !== "password" && result.recovery_type !== "email") {
          throw new Error("The recovery code has an invalid purpose.")
        }
        setPasswordResetUsername(result.username)
        setPasswordResetAccount({
          username: result.username,
          recoveryType: result.recovery_type,
        })
        setResetPasswordInput("")
        setResetPasswordConfirmation("")
        setResetEmailInput("")
      } catch (error) {
        setAuthError(error instanceof Error ? error.message : "Could not verify reset code")
      }
      return
    }
    if (passwordResetAccount.recoveryType === "password") {
      if (resetPasswordInput.length < 8 || resetPasswordInput.length > 256) {
        setAuthError("Password must be between 8 and 256 characters.")
        return
      }
      if (resetPasswordInput !== resetPasswordConfirmation) {
        setAuthError("Passwords do not match.")
        return
      }
    } else if (!resetEmailInput.trim()) {
      setAuthError("Enter a valid email address.")
      return
    }
    try {
      const response = await fetch("/api/auth/password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reset_token: passwordResetToken,
          ...(passwordResetAccount.recoveryType === "password"
            ? {
                password: resetPasswordInput,
                confirmation: resetPasswordConfirmation,
              }
            : { email: resetEmailInput }),
        }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.message || "Account recovery failed")
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      window.location.replace("/")
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Account recovery failed")
    }
  }

  const handleLogout = async () => {
    setLogoutError("")
    setIsLoggingOut(true)
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" })
      const contentType = response.headers.get("content-type") || ""
      if (!contentType.toLowerCase().includes("application/json")) {
        if (!response.ok) throw new Error(`Logout failed (HTTP ${response.status})`)
        throw new Error("Logout returned an unexpected non-JSON response")
      }

      let result: { message?: string } | null
      try {
        result = await response.json()
      } catch {
        throw new Error(`Logout returned invalid JSON (HTTP ${response.status})`)
      }
      if (!response.ok) throw new Error(result?.message || `Logout failed (HTTP ${response.status})`)
      if (!result) throw new Error("Logout returned an unexpected response")

      socketRef.current?.disconnect()
      socketRef.current = null
      document.cookie = "ats_username=; Max-Age=0; path=/"
      setUsername("")
      setUserInfo(null)
      setShowUserInfoPanel(false)
      setUserInfoError("")
      setUserRecoveryToken("")
      setUserRecoveryError("")
      setUserRecoveryNotice("")
      setUserRecoveryCopyNotice("")
      setUsernameInput("")
      setEmailInput("")
      setRegistrationUsername("")
      setRegistrationPassword("")
      setPasswordInput("")
      setPasswordConfirmation("")
      setCurrentRank("User")
      setCurrentPermissions(null)
      setCurrentPoints(null)
      setPointsLoading(false)
      setPointsError(false)
      setUsageCosts({})
      setActionError("")
      setAdminIssuedRecoveryToken("")
      setShowRegistrationForm(false)
      setPasswordResetMode(false)
      setPasswordResetUsername("")
      setPasswordResetToken("")
      setPasswordResetAccount(null)
      setResetPasswordInput("")
      setResetPasswordConfirmation("")
      setSounds([])
      setUsableEmojis([])
      setAssetLoadError("")
      setAssetListsLoading(false)
      window.location.replace("/")
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : "Logout failed")
      setIsLoggingOut(false)
    }
  }

  const openChatWindow = () => {
    const chatUrl = `${window.location.origin}/chat`
    if (window.matchMedia("(max-width: 767px)").matches) {
      window.location.assign(chatUrl)
      return
    }

    const width = Math.min(460, window.screen.availWidth)
    const height = Math.min(820, window.screen.availHeight)
    const left = window.screenX + Math.max(0, (window.outerWidth - width) / 2)
    const top = window.screenY + Math.max(0, (window.outerHeight - height) / 2)
    const popup = window.open(
      chatUrl,
      "ats-chat",
      `popup=yes,resizable=yes,width=${width},height=${height},left=${left},top=${top}`,
    )
    setChatPopoutBlocked(!popup)
    popup?.focus()
  }

  const loadManagedUserByUsername = async (targetUsername: string) => {
    const target = targetUsername.trim()
    setAdminError("")
    setAdminNotice("")
    setAdminIssuedRecoveryToken("")
    setAdminRecoveryCopyNotice("")
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(target)}`)
      const result = await response.json()
      if (!response.ok) throw new Error(result.message || "Could not load user")
      setManagedUser((current) =>
        current?.username === result.user.username
          ? { ...current, ...result.user }
          : result.user,
      )
      if (result.user.username === username) acceptPointBalance(result.user.points)
      setRankSelection(result.user.rank_immutable ? "" : result.user.rank)
      setConfirmingPasswordReset(false)
      setConfirmingEmailReset(false)
    } catch (error) {
      setManagedUser(null)
      setAdminError(error instanceof Error ? error.message : "Could not load user")
    }
  }

  const loadManagedUser = async (event: React.FormEvent) => {
    event.preventDefault()
    await loadManagedUserByUsername(lookupUsername)
  }

  const inspectChatUser = (targetUsername: string) => {
    if (!canInspectUsers) return
    setLookupUsername(targetUsername)
    setAdminView("users")
    void loadManagedUserByUsername(targetUsername)
    if (permission("admin_console")) void loadAdminBadges()
  }

  const loadUserInfo = async (targetUsername: string) => {
    if (!username || targetUsername.toLowerCase() !== username.toLowerCase()) return
    setUserInfoLoading(true)
    setUserInfoError("")
    setUserRecoveryToken("")
    setUserRecoveryError("")
    setUserRecoveryNotice("")
    setUserRecoveryCopyNotice("")
    try {
      const response = await fetch("/api/account/profile")
      const result = await response.json()
      if (!response.ok || !result.user) throw new Error(result.message || "Could not load profile")
      setUserInfo(result.user)
      setUserBadgeSelection(result.user.visible_badge_id ?? "")
    } catch (error) {
      setUserInfo(null)
      setUserInfoError(error instanceof Error ? error.message : "Could not load profile")
    } finally {
      setUserInfoLoading(false)
    }
  }

  const toggleUserInfoPanel = () => {
    const opening = !showUserInfoPanel
    setShowUserInfoPanel(opening)
    if (opening && (!userInfo || userInfo.username !== username)) void loadUserInfo(username)
  }

  const saveUserBadgeSelection = async () => {
    setUserBadgeSaving(true)
    setUserInfoError("")
    try {
      const response = await fetch("/api/account/profile/badge", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ badge_id: userBadgeSelection || null }),
      })
      const result = await response.json()
      if (!response.ok || !result.user) throw new Error(result.message || "Could not update badge")
      setUserInfo(result.user)
      setUserBadgeSelection(result.user.visible_badge_id ?? "")
      if (managedUser?.username === result.user.username) setManagedUser(result.user)
    } catch (error) {
      setUserInfoError(error instanceof Error ? error.message : "Could not update badge")
    } finally {
      setUserBadgeSaving(false)
    }
  }

  const issueUserRecoveryCode = async (recoveryType: "password" | "email") => {
    setUserRecoveryError("")
    setUserRecoveryNotice("")
    setUserRecoveryCopyNotice("")
    setUserRecoveryToken("")
    try {
      const response = await fetch("/api/account/recovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recovery_type: recoveryType }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.message || "Could not create recovery code")
      setUserRecoveryToken(result.reset_token)
      setUserRecoveryNotice(`${recoveryType === "password" ? "Password" : "Email"} recovery code created. It expires in 30 minutes; log out before using it.`)
    } catch (error) {
      setUserRecoveryError(error instanceof Error ? error.message : "Could not create recovery code")
    }
  }

  const copyRecoveryCode = async (
    token: string,
    setNotice: React.Dispatch<React.SetStateAction<string>>,
    setError: React.Dispatch<React.SetStateAction<string>>,
  ) => {
    setNotice("")
    setError("")
    try {
      await navigator.clipboard.writeText(token)
      setNotice("Recovery code copied.")
    } catch (error) {
      setError("Could not copy the recovery code. Select and copy it manually.")
      console.error("Could not copy recovery code:", error)
    }
  }

  const changeBadgeForInspectedUser = async (action: "grant" | "remove") => {
    const matches = adminBadges.filter(
      (badge) => badge.name.trim().toLocaleLowerCase() === adminBadgeGrantName.trim().toLocaleLowerCase(),
    )
    if (!managedUser || matches.length !== 1) {
      setAdminError(matches.length > 1 ? "More than one badge matches that name." : "Enter an existing badge name.")
      return
    }
    const badgeId = matches[0].asset_id
    setAdminError("")
    setAdminNotice("")
    setAdminBadgeGranting(true)
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(managedUser.username)}/badges`, {
        method: action === "grant" ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ badge_id: badgeId }),
      })
      let result: { message?: string; granted?: boolean; removed?: boolean; user?: ManagedUser }
      try {
        result = await response.json()
      } catch {
        if (response.status === 405) {
          throw new Error("The running Flask service does not support badge removal yet. Restart Flask and try again.")
        }
        throw new Error(`Could not ${action} badge (HTTP ${response.status})`)
      }
      if (!response.ok) throw new Error(result.message || `Could not ${action} badge`)
      if (action === "remove" && result.removed !== true) {
        setAdminNotice(`${managedUser.username} does not have that badge.`)
        return
      }
      if (action === "grant" && result.granted !== true) {
        setAdminNotice(`${managedUser.username} already has that badge.`)
        return
      }
      const updatedUser = action === "remove" && result.user
        ? result.user
        : {
            ...managedUser,
            badges: [...managedUser.badges, matches[0]],
          }
      setManagedUser(updatedUser)
      setAdminBadgeGrantName("")
      setAdminNotice(`${action === "grant" ? "Granted" : "Removed"} badge ${action === "grant" ? "to" : "from"} ${managedUser.username}.`)
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : `Could not ${action} badge`)
    } finally {
      setAdminBadgeGranting(false)
    }
  }

  const updateManagedUser = async (operation: string, body: Record<string, string | number | boolean>) => {
    if (!managedUser) return
    setAdminError("")
    setAdminNotice("")
    if (operation === "reset-password" || operation === "reset-email") {
      setAdminIssuedRecoveryToken("")
      setAdminRecoveryCopyNotice("")
    }
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(managedUser.username)}/${operation}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.message || "User update failed")
      if (operation === "points") {
        const pending = pendingPointAdjustment.current
        const amount = body.amount
        if (typeof amount === "number") {
          try {
            sessionStorage.removeItem(`ats-point-adjustment:${managedUser.username}:${amount}`)
          } catch {
            // Storage is optional; request de-duplication remains server-side.
          }
        }
        if (pending?.requestId === body.request_id) pendingPointAdjustment.current = null
      }
      setManagedUser(result.user)
      setUserInfo((current) =>
        current?.username === result.user.username
          ? { ...current, ...result.user }
          : current,
      )
      if (result.user.username === username) acceptPointBalance(result.user.points)
      if (result.user.username === username) {
        setCurrentModerationStatus({
          chat_timeout_until: result.user.chat_timeout_until,
        })
      }
      if (operation === "rank") setRankSelection(result.user.rank)
      if (result.user.username === username) {
        setCurrentRank(result.user.rank)
        if (result.permissions) setCurrentPermissions(result.permissions)
        if (result.usage_costs) setUsageCosts(result.usage_costs)
      }
      setConfirmingPasswordReset(false)
      setConfirmingEmailReset(false)
      if (operation === "reset-password" || operation === "reset-email") {
        setAdminIssuedRecoveryToken(
          typeof result.reset_token === "string" ? result.reset_token : "",
        )
        setAdminNotice(
          operation === "reset-email"
            ? "Email recovery code generated. Share it with the user; it expires in 30 minutes."
            : "Password recovery code generated. Share it with the user; it expires in 30 minutes.",
        )
      } else {
        setAdminNotice("User updated.")
      }
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : "User update failed")
    }
  }

  const toggleStreaming = async () => {
    try {
      const response = await fetch("/api/stream-control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: isStreaming ? "stop" : "start" }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.message || "Could not update streaming status")
      setIsStreaming(result.streaming === true)
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : "Could not update streaming status")
    }
  }

  const saveStreamPointSettings = async () => {
    const points = Number(streamPointSettings.points_per_interval)
    const interval = Number(streamPointSettings.interval_seconds)
    if (
      !Number.isInteger(points) || points < 1 || points > 1_000_000
      || !Number.isInteger(interval) || interval < 1 || interval > 86_400
    ) {
      setAdminError("Points must be 1–1,000,000 and interval must be 1–86,400 seconds.")
      return
    }
    setStreamSettingsSaving(true)
    setAdminError("")
    setAdminNotice("")
    try {
      const response = await fetch("/api/admin/streaming/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          points_per_interval: points,
          interval_seconds: interval,
        }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.message || "Could not save stream settings")
      setStreamPointSettings({
        points_per_interval: String(result.points_per_interval),
        interval_seconds: String(result.interval_seconds),
      })
      setAdminNotice("Stream point settings saved. Changes apply when the next stream starts.")
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : "Could not save stream settings")
    } finally {
      setStreamSettingsSaving(false)
    }
  }

  const handleThemePickerOpenChange = (open: boolean) => {
    setThemeError("")
    if (!open) setActiveThemeId(savedThemeId)
    else setActiveThemeId(savedThemeId)
    setThemePickerOpen(open)
  }

  const saveSelectedTheme = async () => {
    const themeToSave = activeThemeId
    setThemeSaving(true)
    setThemeError("")
    try {
      const response = await fetch("/api/account/theme", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme_id: themeToSave }),
      })
      const result = await response.json()
      if (!response.ok || result.selected_theme_id !== themeToSave) {
        throw new Error(result.message || "Could not save the selected theme")
      }
      setSavedThemeId(themeToSave)
      setActiveThemeId(themeToSave)
      setThemePickerOpen(false)
    } catch (error) {
      setThemeError(error instanceof Error ? error.message : "Could not save the selected theme")
    } finally {
      setThemeSaving(false)
    }
  }

  const createAdminTheme = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (adminThemeBackgroundFile && adminThemeBackgroundUrl.trim()) {
      setAdminThemeCreateError("Choose a background file or enter a URL, not both.")
      return
    }
    const form = event.currentTarget
    setAdminThemeSaving(true)
    setAdminThemeCreateError("")
    setAdminThemeCreateNotice("")
    setAdminThemePreview(null)
    const formData = new FormData()
    formData.set("name", adminThemeName)
    formData.set("primary_color", adminThemePrimary)
    formData.set("panel_color", adminThemePanel)
    formData.set("accent_color", adminThemeAccent)
    formData.set("price", adminThemePrice)
    if (adminThemeBackgroundFile) {
      formData.set("background", adminThemeBackgroundFile)
      formData.set("background_opacity", adminThemeBackgroundOpacity || "0.2")
    } else if (adminThemeBackgroundUrl.trim()) {
      formData.set("background_url", adminThemeBackgroundUrl.trim())
      formData.set("background_opacity", adminThemeBackgroundOpacity || "0.2")
    }

    try {
      const response = await fetch("/api/admin/themes", { method: "POST", body: formData })
      const responseText = await response.text()
      let result: { message?: string; theme?: ThemeOption; price_overridden?: boolean }
      try {
        result = JSON.parse(responseText)
      } catch {
        const responseMessage = responseText
          .replace(/<[^>]*>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 240)
        throw new Error(
          responseMessage
            ? `Theme creation failed (${response.status}): ${responseMessage}`
            : `Theme creation failed (${response.status})`,
        )
      }
      if (!response.ok || !result.theme) {
        throw new Error(result.message || "Could not create theme")
      }
      const createdTheme: ThemeOption = {
        ...result.theme,
        price_overridden: result.price_overridden === true,
      }
      setAdminThemes((current) => [...current, createdTheme].sort((left, right) => left.name.localeCompare(right.name)))
      setAdminThemeName("")
      setAdminThemePrice("")
      setAdminThemeBackgroundUrl("")
      setAdminThemeBackgroundFile(null)
      form.reset()
      setAdminThemePrimary("#000000")
      setAdminThemePanel("#171717")
      setAdminThemeAccent("#f9a8d4")
      setAdminThemeBackgroundOpacity("0.2")
      setAdminThemeCreateNotice("Theme created.")
      try {
        await refreshAccountThemes()
      } catch (error) {
        console.error("Theme was created, but the picker could not be refreshed:", error)
        setAdminThemeCreateNotice("Theme created, but the theme picker could not be refreshed.")
      }
      await loadPointPricing()
    } catch (error) {
      setAdminThemeCreateError(error instanceof Error ? error.message : "Could not create theme")
    } finally {
      setAdminThemeSaving(false)
    }
  }

  const createThemePreviewUrl = async (file: File) => {
    const bitmap = await createImageBitmap(file)
    try {
      const maxDimension = 1600
      const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height))
      if (scale === 1) return URL.createObjectURL(file)

      const canvas = document.createElement("canvas")
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      const context = canvas.getContext("2d")
      if (!context) throw new Error("Could not prepare the theme background preview")
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)

      const previewBlob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (blob) => blob
            ? resolve(blob)
            : reject(new Error("Could not prepare the theme background preview")),
          "image/webp",
          0.82,
        )
      })
      return URL.createObjectURL(previewBlob)
    } finally {
      bitmap.close()
    }
  }

  const previewAdminTheme = async () => {
    const generation = ++themePreviewGeneration.current
    setAdminThemeCreateError("")
    try {
      const backgroundUrl = adminThemeBackgroundFile
        ? await createThemePreviewUrl(adminThemeBackgroundFile)
        : adminThemeBackgroundUrl.trim()
      if (generation !== themePreviewGeneration.current) {
        if (backgroundUrl.startsWith("blob:")) URL.revokeObjectURL(backgroundUrl)
        return
      }
      setAdminThemePreview({
        asset_id: "admin-theme-preview",
        name: adminThemeName.trim() || "Theme preview",
        title: adminThemeName.trim() || "Theme preview",
        price: 0,
        owned: true,
        status: "owned",
        primary_color: adminThemePrimary,
        panel_color: adminThemePanel,
        accent_color: adminThemeAccent,
        background_image_exists: Boolean(backgroundUrl),
        background_opacity: backgroundUrl ? Number(adminThemeBackgroundOpacity || "0.2") : 0,
        background_image_name: null,
        is_standard: false,
        url: backgroundUrl,
      })
    } catch (error) {
      if (generation === themePreviewGeneration.current) {
        setAdminThemeCreateError(error instanceof Error ? error.message : "Could not prepare the theme background preview")
      }
    }
  }

  const previewManagedAdminTheme = async (themeOption: ThemeOption, draft: AdminThemeDraft) => {
    const generation = ++themePreviewGeneration.current
    setAdminThemeManageError("")
    try {
      const backgroundUrl = draft.background_file
        ? await createThemePreviewUrl(draft.background_file)
        : draft.background_url.trim()
          ? draft.background_url.trim()
          : !draft.remove_background && themeOption.background_image_exists
            ? themeOption.url
            : ""
      if (generation !== themePreviewGeneration.current) {
        if (backgroundUrl.startsWith("blob:")) URL.revokeObjectURL(backgroundUrl)
        return
      }
      setAdminThemePreview({
        ...themeOption,
        name: draft.name.trim() || themeOption.name,
        title: draft.name.trim() || themeOption.name,
        primary_color: draft.primary_color,
        panel_color: draft.panel_color,
        accent_color: draft.accent_color,
        background_image_exists: Boolean(backgroundUrl),
        background_opacity: backgroundUrl ? Number(draft.background_opacity) : 0,
        url: backgroundUrl,
      })
    } catch (error) {
      if (generation === themePreviewGeneration.current) {
        setAdminThemeManageError(error instanceof Error ? error.message : "Could not prepare the theme background preview")
      }
    }
  }

  const clearAdminThemePreview = () => {
    themePreviewGeneration.current += 1
    setAdminThemePreview(null)
  }

  const saveAdminTheme = async (theme: ThemeOption) => {
    const draft = adminThemeDrafts[theme.asset_id]
    if (!draft) return
    if (draft.background_file && draft.background_url.trim()) {
      setAdminThemeManageError("Choose a background file or enter a URL, not both.")
      return
    }
    setAdminThemeSaving(true)
    setAdminThemeManageError("")
    setAdminThemeManageNotice("")
    const formData = new FormData()
    formData.set("name", draft.name)
    formData.set("primary_color", draft.primary_color)
    formData.set("panel_color", draft.panel_color)
    formData.set("accent_color", draft.accent_color)
    formData.set("price", draft.price)
    formData.set("background_opacity", draft.background_opacity)
    formData.set("remove_background", String(draft.remove_background))
    if (draft.background_file) formData.set("background", draft.background_file)
    if (draft.background_url.trim()) formData.set("background_url", draft.background_url.trim())

    try {
      const response = await fetch(`/api/admin/themes/${theme.asset_id}`, {
        method: "PATCH",
        body: formData,
      })
      const result = await response.json()
      if (!response.ok || !result.theme) {
        throw new Error(result.message || "Could not update theme")
      }

      const updatedTheme: ThemeOption = {
        ...result.theme,
        price_overridden: result.price_overridden === true,
      }
      setAdminThemeManageNotice("Theme updated.")
      setAdminThemeLookup(result.theme.name)
      setSelectedAdminThemeId(result.theme.asset_id)
      setAdminThemes((current) => current.map((themeOption) =>
        themeOption.asset_id === updatedTheme.asset_id ? updatedTheme : themeOption,
      ))
      setShopAssets((current) => ({
        ...current,
        theme: current.theme.map((themeOption) =>
          themeOption.asset_id === updatedTheme.asset_id ? updatedTheme : themeOption,
        ),
      }))
      setAdminThemeDrafts((current) => ({
        ...current,
        [result.theme.asset_id]: {
          name: result.theme.name,
          primary_color: result.theme.primary_color,
          panel_color: result.theme.panel_color,
          accent_color: result.theme.accent_color,
          price: result.price_overridden ? String(result.theme.price) : "",
          background_url: "",
          background_opacity: String(result.theme.background_opacity),
          background_file: null,
          remove_background: false,
        },
      }))
      await Promise.all([loadAdminThemes(), loadPointPricing(), fetchShopCatalog().then(setShopAssets)])
      const accountTheme = await refreshAccountThemes()
      setThemeOptions(accountTheme.themes.map((themeOption) =>
        themeOption.asset_id === updatedTheme.asset_id
          ? {
              ...themeOption,
              ...updatedTheme,
              owned: themeOption.owned,
              status: themeOption.status,
            }
          : themeOption,
      ))
      setSavedThemeId(accountTheme.selected_theme_id)
      setActiveThemeId(accountTheme.selected_theme_id)
      setShopThemePreview(null)
    } catch (error) {
      setAdminThemeManageError(error instanceof Error ? error.message : "Could not update theme")
    } finally {
      setAdminThemeSaving(false)
    }
  }

  const removeAdminTheme = async (theme: ThemeOption) => {
    if (!window.confirm(`Remove theme "${theme.name}"?`)) return
    setAdminThemeSaving(true)
    setAdminThemeManageError("")
    setAdminThemeManageNotice("")
    try {
      const response = await fetch(`/api/admin/themes/${theme.asset_id}`, { method: "DELETE" })
      const result = await response.json()
      if (!response.ok) throw new Error(result.message || "Could not remove theme")
      setAdminThemeManageNotice("Theme removed.")
      setAdminThemes((current) => current.filter((item) => item.asset_id !== theme.asset_id))
      setAdminThemeDrafts((current) => {
        const updated = { ...current }
        delete updated[theme.asset_id]
        return updated
      })
      setSelectedAdminThemeId(null)
      setAdminThemeLookup("")
      await Promise.all([loadAdminThemes(), loadPointPricing(), fetchShopCatalog().then(setShopAssets)])
      const accountTheme = await refreshAccountThemes()
      setActiveThemeId(accountTheme.selected_theme_id)
      setShopThemePreview(null)
    } catch (error) {
      setAdminThemeManageError(error instanceof Error ? error.message : "Could not remove theme")
    } finally {
      setAdminThemeSaving(false)
    }
  }

	// --- Chat handling ---
	const sendChatMessage = () => {
    if (isChatRestricted) return
	  if (!chatInput.trim()) return

	  // Send ONLY user/message - server adds to DB and broadcasts simplified version
	  if (socketRef.current?.connected) {
		socketRef.current.emit("chat_message", {
		  user: username,
		  message: chatInput.trim()
		})
	  }

	  setChatInput("")
	  setShowEmojiPanel(false)
	  setTimeout(() => chatInputRef.current?.focus(), 0)
	}

	const deleteMessage = (id: string) => {
	  // Client-side optimistic delete (server doesn't support yet)
	  setChatMessages((prev) => prev.filter((m) => m.id !== id))
	  if (socketRef.current?.connected) {
		socketRef.current.emit("delete_message", { messageId: id })
	  }
	}

	const insertEmoji = (emoji: string) => {
    setChatInput((prev) => prev + `:${emoji}:`)
    setChatError("")
  }

	const renderMessageWithEmojis = (
    message: string,
    literalEmojis: string[] = [],
    messageUser?: string,
  ) => {
	  const parts = message.split(/(:\w+:)/g)
    const ownedEmojiNames = new Set(usableEmojis.map((emoji) => emoji.name))
	  return parts.map((part, idx) => {
		const emojiName = part.replace(/:/g, "")
		const senderNowOwnsEmoji = messageUser === username && ownedEmojiNames.has(emojiName)
		if (
      emojiUrls[emojiName]
      && (!literalEmojis.includes(emojiName) || senderNowOwnsEmoji)
    ) {
		  return (
			<img
			  key={idx}
			  src={emojiUrls[emojiName]}
			  alt={emojiName}
			  className="inline h-5 w-5 align-text-bottom"
			/>
		  )
		} else if (part.startsWith("@")) {
		  return <span key={idx} className="mention-tag">{part}</span>
		} else {
		  return <span key={idx}>{part}</span>
		}
	  })
	}

  const paidUseStorageKey = (action: string) => `ats-paid-use:${username}:${action}`

  const getPaidUseRequestId = (action: string) => {
    if (!pendingUseRequestIds.current[action]) {
      try {
        pendingUseRequestIds.current[action] = sessionStorage.getItem(paidUseStorageKey(action)) || ""
      } catch {
        pendingUseRequestIds.current[action] = ""
      }
    }
    if (!pendingUseRequestIds.current[action]) {
      pendingUseRequestIds.current[action] = crypto.randomUUID()
      try {
        sessionStorage.setItem(paidUseStorageKey(action), pendingUseRequestIds.current[action])
      } catch {
        // The in-memory request ID still protects retries during this page session.
      }
    }
    return pendingUseRequestIds.current[action]
  }

  const clearPaidUseRequestId = (action: string) => {
    delete pendingUseRequestIds.current[action]
    try {
      sessionStorage.removeItem(paidUseStorageKey(action))
    } catch {
      // Storage is optional; the backend remains authoritative.
    }
  }

  const submitPaidUse = async (action: string, formData: FormData) => {
    const requestId = getPaidUseRequestId(action)
    formData.append("request_id", requestId)
    setActionError("")
    try {
      const response = await fetch("/api/handle_post", { method: "POST", body: formData })
      const result = await response.json().catch(() => null)
      if (!result) throw new Error(`Action could not be sent (server error ${response.status})`)
      if (!response.ok || result.status !== "ok") {
        if (
          response.status === 400
          || response.status === 402
          || result.code === "action_failed"
          || result.code === "request_id_conflict"
        ) {
          clearPaidUseRequestId(action)
        }
        throw new Error(result.message || "Action could not be sent")
      }
      acceptPointBalance(result.points)
      clearPaidUseRequestId(action)
      return true
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Action could not be sent")
      return false
    }
  }

	// FaceMeme
	const handleFaceMemeSubmit = async (e: React.FormEvent) => {
	  e.preventDefault()
    if (isChatRestricted) return
    setActionError("")
	  const formData = new FormData()
	  formData.append("user", username)
	  formData.append("top_text_facememe", faceMemeTop)
	  formData.append("bottom_text_facememe", faceMemeBottom)
    if (!await submitPaidUse("facemememe", formData)) return
	  setFaceMemeTop("")
	  setFaceMemeBottom("")
	}

	// NormalMeme
	const handleNormalMemeSubmit = async (e: React.FormEvent) => {
	  e.preventDefault()
    if (isChatRestricted) return
    setActionError("")
    if (normalMemeFile && !normalMemeFileData) {
      setActionError("Wait for the selected image to finish loading")
      return
    }
	  const formData = new FormData()
	  formData.append("user", username)
    formData.append("image_normalmeme", normalMemeFileData || normalMemeImage)
	  formData.append("top_text_normalmeme", normalMemeTop)
	  formData.append("bottom_text_normalmeme", normalMemeBottom)
    if (!await submitPaidUse("normalmeme", formData)) return
	  setNormalMemeImage("")
	  setNormalMemeFile(null)
    setNormalMemeFileData(null)
	  setNormalMemeTop("")
	  setNormalMemeBottom("")
	}

	// TTSMeme
	const handleTTSSubmit = async (e: React.FormEvent) => {
	  e.preventDefault()
    if (isChatRestricted) return
    setActionError("")
	  const trimmedTts = ttsText.trim()
	  if (!trimmedTts) {
		return
	  }
	  const formData = new FormData()
	  formData.append('user', username)
	  formData.append('text_ttsmeme', trimmedTts)
	  formData.append('language', ttsLanguage)
    if (await submitPaidUse("tts", formData)) setTtsText('')
	}

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (isChatRestricted) return
    const file = e.target.files?.[0]
    e.currentTarget.value = ""
    if (!file) return
    setNormalMemeFile(file)
    setNormalMemeFileData(null)
    setNormalMemeImage("")
    const reader = new FileReader()
    reader.onload = (event) => {
      if (typeof event.target?.result === "string") {
        setNormalMemeFileData(event.target.result)
      }
    }
    reader.onerror = () => {
      setNormalMemeFileData(null)
      setActionError("The selected image could not be read")
    }
    reader.readAsDataURL(file)
  }

	const playSound = (assetId: string) => {
    if (isChatRestricted) return
    const socket = socketRef.current
    if (!socket?.connected) {
      setActionError("Sound request could not be sent. Check the chat connection and retry.")
      return
    }
    const action = "soundmeme"
    const requestKey = `${action}:${assetId}`
    const requestId = getPaidUseRequestId(requestKey)
    setActionError("")
    socket.emit(
      "playsound",
      { asset_id: assetId, request_id: requestId },
      (result?: { status?: string; code?: string; message?: string; points?: number }) => {
        if (result?.status !== "ok") {
          if (typeof result?.points === "number") acceptPointBalance(result.points)
          if (result?.code === "insufficient_points") {
            clearPaidUseRequestId(requestKey)
          } else if (result?.code === "request_id_conflict" || result?.code === "action_failed") {
            clearPaidUseRequestId(requestKey)
          }
          setActionError(result?.message || "Sound request could not be confirmed. Retry it.")
          return
        }
        acceptPointBalance(result.points)
        clearPaidUseRequestId(requestKey)
      },
    )
	};

  const toggleSoundFavorite = async (sound: SoundAsset) => {
    setActionError("")
    try {
      const response = await fetch("/api/soundboard/favorites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asset_id: sound.asset_id, favorite: !sound.favorite }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.message || "Could not update sound favorite")
      await refreshOwnedAssetLists()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not update sound favorite")
    }
  }

  const previewShopSound = (sound: ShopAsset) => {
    previewAudioRef.current?.pause()
    const audio = new Audio(sound.url)
    audio.volume = Math.max(0, Math.min(1, sound.loudness ?? 1))
    previewAudioRef.current = audio
    audio.play().catch((error) => {
      console.error("Sound preview could not be played:", error)
      setShopError("Sound preview could not be played.")
    })
  }

  const purchaseShopAsset = async (assetType: "sound" | "emoji" | "theme", asset: ShopAsset) => {
    const requestKey = `${assetType}:${asset.asset_id}`
    let requestId = pendingShopRequestIds.current[requestKey]
    if (!requestId) {
      try {
        requestId = sessionStorage.getItem(`ats-shop-purchase:${username}:${requestKey}`) || ""
      } catch {
        requestId = ""
      }
    }
    if (!requestId) requestId = crypto.randomUUID()
    pendingShopRequestIds.current[requestKey] = requestId
    try {
      sessionStorage.setItem(`ats-shop-purchase:${username}:${requestKey}`, requestId)
    } catch {
      // The in-memory request ID still protects retries during this page session.
    }

    setPurchasingAssetId(asset.asset_id)
    setShopError("")
    setShopNotice("")
    try {
      const response = await fetch("/api/shop/purchase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          asset_type: assetType,
          asset_id: asset.asset_id,
          request_id: requestId,
          expected_price: asset.price,
        }),
      })
      const result = await response.json()
      if (!response.ok || result.status !== "ok") {
        if (
          response.status === 402
          || result.code === "asset_unavailable"
          || result.code === "price_changed"
          || result.code === "request_id_conflict"
        ) {
          delete pendingShopRequestIds.current[requestKey]
          try {
            sessionStorage.removeItem(`ats-shop-purchase:${username}:${requestKey}`)
          } catch {
            // Storage is optional; the backend remains authoritative.
          }
        }
        if (result.code === "price_changed") {
          try {
            setShopAssets(await fetchShopCatalog())
          } catch (error) {
            console.error("Updated Point Shop prices could not be loaded:", error)
          }
        }
        throw new Error(result.message || "Purchase could not be completed")
      }

      acceptPointBalance(result.points)
      delete pendingShopRequestIds.current[requestKey]
      try {
        sessionStorage.removeItem(`ats-shop-purchase:${username}:${requestKey}`)
      } catch {
        // Storage is optional; the backend remains authoritative.
      }
      setShopNotice(
        assetType === "theme"
          ? `${asset.title || asset.name} theme purchased.`
          : `${asset.title || asset.name} added to your ${assetType === "sound" ? "soundboard" : "emojis"}.`,
      )

      try {
        const catalog = await fetchShopCatalog()
        setShopAssets(catalog)
        if (assetType === "theme") {
          const accountTheme = await loadAccountTheme()
          setThemeOptions(accountTheme.themes)
          setSavedThemeId(accountTheme.selected_theme_id)
          setActiveThemeId(accountTheme.selected_theme_id)
        } else {
          await refreshOwnedAssetLists()
        }
      } catch (error) {
        setShopError(error instanceof Error ? error.message : "Purchased asset lists could not be refreshed")
        console.error("Purchased asset lists could not be refreshed:", error)
      }
    } catch (error) {
      setShopError(error instanceof Error ? error.message : "Purchase could not be completed")
    } finally {
      setPurchasingAssetId(null)
    }
  }

  const submitAssetProposal = async (event: React.FormEvent<HTMLFormElement>, assetType: "emoji" | "sound") => {
    event.preventDefault()
    const form = event.currentTarget
    const draft = proposalDrafts[assetType]
    const file = proposalFiles[assetType]
    if (file && draft.sourceUrl.trim()) {
      setShopError("Choose a file or enter a URL, not both.")
      return
    }
    if (!file && !draft.sourceUrl.trim()) {
      setShopError("Choose a file or enter a URL.")
      return
    }
    setProposalSaving(assetType)
    setShopError("")
    setShopNotice("")
    try {
      const formData = new FormData()
      formData.set("asset_type", assetType)
      formData.set("request_id", crypto.randomUUID())
      formData.set("exclusive", String(draft.exclusive))
      formData.set(assetType === "sound" ? "display_name" : "name", draft.name)
      formData.set("source_url", draft.sourceUrl)
      if (assetType === "sound") formData.set("loudness", draft.loudness.trim() || "1")
      if (file) formData.set("file", file)

      const response = await fetch("/api/shop/propose", { method: "POST", body: formData })
      const result = await response.json()
      if (!response.ok || result.status !== "ok") {
        if (typeof result.points === "number") acceptPointBalance(result.points)
        throw new Error(result.message || "Proposal could not be submitted.")
      }
      acceptPointBalance(result.points)
      setProposalDrafts((current) => ({
        ...current,
        [assetType]: { name: "", sourceUrl: "", loudness: "", exclusive: false },
      }))
      setProposalFiles((current) => ({ ...current, [assetType]: null }))
      form.reset()
      setShopNotice(`${assetType === "emoji" ? "Emoji" : "Sound"} added.`)
      setShopAssets(await fetchShopCatalog())
      await refreshOwnedAssetLists()
    } catch (error) {
      setShopError(error instanceof Error ? error.message : "Proposal could not be submitted.")
    } finally {
      setProposalSaving(null)
    }
  }

  const handleUsernameClick = (clickedUsername: string) => {
    const safeUsername = clickedUsername.trim()
    if (!safeUsername) return
    setChatInput((prev) => (prev.trim() ? `${prev} @${safeUsername} ` : `@${safeUsername} `))
    chatInputRef.current?.focus()
  }

  const getUserColor = (user: string, messageRank?: string) => {
    const rank = messageRank || (user === username ? currentRank : "User")
    return rankOptions.find((option) => option.rank.toLowerCase() === rank.toLowerCase())?.color
  }

  const isValidEmail = (value: string) => {
    const email = value.trim()
    if (email.length > 254 || email.split("@").length !== 2) return false

    const [local, domain] = email.split("@")
    const localAtom = "[A-Z0-9!#$%&'*+/=?^_`{|}~-]+"
    const domainLabel = "[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?"
    return (
      local.length <= 64 &&
      new RegExp(`^${localAtom}(?:\\.${localAtom})*$`, "i").test(local) &&
      domain.includes(".") &&
      domain.split(".").every((label) => new RegExp(`^${domainLabel}$`, "i").test(label))
    )
  }

if (!sessionRestored) {
  return (
    <div className="min-h-screen gradient-bg flex items-center justify-center p-4">
      <p role="status" className="text-sm text-muted-foreground">Checking your session...</p>
    </div>
  )
}

if (!username) {
    return (
      <div className="min-h-screen gradient-bg flex items-center justify-center p-4">
        <Card className="w-full max-w-md glow-primary">
          <CardHeader className="text-center">
            <CardTitle className="text-3xl font-bold text-card-foreground">
              Annoy the Streamer
            </CardTitle>
            <CardDescription>Log in or create an account to join the chaos.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!showRegistrationForm && !passwordResetMode && <form
              id="login-form"
              data-bwignore="true"
              autoComplete="on"
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault()
                void handleLoginSubmit()
              }}
            >
              <label className="sr-only" htmlFor="login-username">Username</label>
              <Input
                id="login-username"
                data-bwignore="true"
                placeholder="Username"
                name="username"
                autoComplete="username"
                value={usernameInput}
                onChange={(event) => setUsernameInput(event.target.value)}
                className="text-lg"
                required
              />
              <label className="sr-only" htmlFor="login-password">Password</label>
              <Input
                id="login-password"
                data-bwignore="true"
                type="password"
                name="password"
                placeholder="Password"
                autoComplete="current-password"
                value={passwordInput}
                onChange={(event) => setPasswordInput(event.target.value)}
                className="text-lg"
              />
              <Button type="submit" className="w-full" size="lg">
                Login
              </Button>
            </form>}

            {!showRegistrationForm && !passwordResetMode && (
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1"
                  onClick={() => {
                    setRegistrationUsername((current) => current || usernameInput)
                    setShowRegistrationForm(true)
                    setAuthError("")
                  }}
                >
                  Create account
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1"
                  onClick={() => {
                    setPasswordResetUsername(usernameInput || registrationUsername)
                    setShowRegistrationForm(false)
                    setPasswordResetMode(true)
                    setAuthError("")
                  }}
                >
                  Account recovery
                </Button>
              </div>
            )}

            {showRegistrationForm && (
              <section aria-label="Create account" className="space-y-3 border-t pt-3">
                <h2 className="text-sm font-semibold">Create account</h2>
                <form
                  id="registration-form"
                  data-bwignore="true"
                  autoComplete="on"
                  className="space-y-3"
                  onSubmit={(event) => void handleRegistrationSubmit(event)}
                >
                <Input
                  placeholder="Username"
                  name="username"
                  autoComplete="username"
                  value={registrationUsername}
                  onChange={(event) => setRegistrationUsername(event.target.value)}
                  className="text-lg"
                  required
                />
                <Input
                  type="email"
                  name="email"
                  placeholder="Email address"
                  value={emailInput}
                  onChange={(event) => setEmailInput(event.target.value)}
                  className="text-lg"
                  autoComplete="email"
                  required
                />
                <Input
                  type="password"
                  data-bwignore="true"
                  name="new-password"
                  placeholder="Create password"
                  value={registrationPassword}
                  onChange={(event) => setRegistrationPassword(event.target.value)}
                  className="text-lg"
                  autoComplete="new-password"
                  required
                />
                <Input
                  type="password"
                  name="password-confirmation"
                  placeholder="Confirm password"
                  value={passwordConfirmation}
                  onChange={(event) => setPasswordConfirmation(event.target.value)}
                  className="text-lg"
                  autoComplete="new-password"
                  required
                />
                <Button type="submit" className="w-full" size="lg">
                  Register
                </Button>
                </form>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => {
                    setShowRegistrationForm(false)
                    setAuthError("")
                  }}
                >
                  Back to login
                </Button>
              </section>
            )}

            {passwordResetMode && (
              <section aria-label="Account recovery" className="space-y-3 border-t pt-3">
                <h2 className="text-sm font-semibold">
                  {passwordResetAccount
                    ? passwordResetAccount.recoveryType === "email"
                      ? "Change account email"
                      : "Set a new password"
                    : "Verify account recovery"}
                </h2>
                <p className="text-xs text-muted-foreground">
                  Enter the one-time account recovery code.
                </p>
                <p className="text-sm">
                  Account: <span className="font-medium">
                    {passwordResetAccount?.username || passwordResetUsername}
                  </span>
                </p>
                <form
                  id="password-reset-form"
                  data-bwignore="true"
                  autoComplete="off"
                  className="space-y-3"
                  onSubmit={(event) => void handlePasswordResetSubmit(event)}
                >
                  <Input
                    name="reset-token"
                    placeholder="One-time recovery code"
                    data-bwignore="true"
                    autoComplete="off"
                    value={passwordResetToken}
                    onChange={(event) => {
                      setPasswordResetToken(event.target.value)
                      setPasswordResetAccount(null)
                      setResetPasswordInput("")
                      setResetPasswordConfirmation("")
                      setResetEmailInput("")
                    }}
                    className="text-lg"
                    required
                  />
                  {passwordResetAccount && (
                    passwordResetAccount.recoveryType === "email" ? (
                      <Input
                        type="email"
                        name="new-email"
                        placeholder="New email address"
                        data-bwignore="true"
                        autoComplete="email"
                        value={resetEmailInput}
                        onChange={(event) => setResetEmailInput(event.target.value)}
                        className="text-lg"
                        required
                      />
                    ) : (
                      <>
                        <Input
                          type="password"
                          name="new-password"
                          data-bwignore="true"
                          placeholder="New password"
                          autoComplete="new-password"
                          value={resetPasswordInput}
                          onChange={(event) => setResetPasswordInput(event.target.value)}
                          className="text-lg"
                          required
                        />
                        <Input
                          type="password"
                          data-bwignore="true"
                          name="new-password-confirmation"
                          placeholder="Confirm new password"
                          autoComplete="new-password"
                          value={resetPasswordConfirmation}
                          onChange={(event) => setResetPasswordConfirmation(event.target.value)}
                          className="text-lg"
                          required
                        />
                      </>
                    )
                  )}
                  <Button type="submit" className="w-full" size="lg">
                    {passwordResetAccount
                      ? passwordResetAccount.recoveryType === "email"
                        ? "Change email"
                        : "Set new password"
                      : "Verify recovery code"}
                  </Button>
                </form>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => {
                    setPasswordResetMode(false)
                    setAuthError("")
                  }}
                >
                  Back to login
                </Button>
              </section>
            )}

            {authError && <p role="alert" className="text-sm text-destructive">{authError}</p>}
          </CardContent>
        </Card>
      </div>
    )
  }



  // ----------------------------
  // Main Page Render (chat + memes + stream)
  // ----------------------------
  return (
    <div
      data-chat-only={isChatOnly}
      className="relative isolate min-h-screen gradient-bg p-2 sm:p-4"
      style={{ background: activeTheme.primary_color }}
    >
      {isChatOnly && (
        <style>{`
          [data-chat-only="true"] { height: 100dvh; min-height: 100dvh; overflow: hidden; padding: 0.5rem; }
          [data-chat-only="true"] > [data-chat-shell] { max-width: none; height: 100%; margin: 0; }
          [data-chat-only="true"] [data-site-header] { display: none; }
          [data-chat-only="true"] [data-chat-layout] { display: block; height: 100%; }
          [data-chat-only="true"] [data-chat-layout] > :not([data-chat-panel]) { display: none !important; }
          [data-chat-only="true"] [data-chat-panel] { height: 100%; width: 100%; }
          [data-chat-only="true"] [data-online-users] { display: none; }
          [data-chat-only="true"] [data-chat-panel] > [data-chat-card] { height: 100%; max-height: none; flex: 1; min-height: 0; }
        `}</style>
      )}
      {activeTheme.background_image_exists && activeTheme.url && (
        <img
          aria-hidden="true"
          data-theme-background
          src={activeTheme.url}
          alt=""
          className="pointer-events-none absolute inset-0 z-0 h-full w-full object-cover object-center"
          style={{ opacity: activeTheme.background_opacity }}
        />
      )}
      <div data-chat-shell className="relative z-10 mx-auto max-w-[2000px]">
        <div data-site-header className="mb-4 sm:mb-6 text-center relative">
          {username && (
            <Popover open={themePickerOpen} onOpenChange={handleThemePickerOpenChange}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="absolute right-0 top-0 bg-transparent"
                  aria-label="Choose theme"
                  title="Choose theme"
                >
                  {renderThemeSwatch(activeTheme, "h-5 w-5", "rounded-sm border")}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64 space-y-3">
                <div>
                  <h2 className="text-sm font-semibold">Choose a theme</h2>
                </div>
                <div className="grid max-h-64 grid-cols-[repeat(5,2.25rem)] justify-center gap-1.5 overflow-y-auto">
                  {themeOptions.filter((themeOption) => themeOption.owned).map((themeOption) => (
                    <button
                      key={themeOption.asset_id}
                      type="button"
                      disabled={themeSaving}
                      title={themeOption.name}
                      aria-label={themeOption.name}
                      aria-pressed={activeThemeId === themeOption.asset_id}
                      onClick={() => setActiveThemeId(themeOption.asset_id)}
                      className={`rounded-md border p-0.5 ${
                        activeThemeId === themeOption.asset_id ? "border-primary bg-muted" : "border-transparent"
                      }`}
                    >
                      {renderThemeSwatch(themeOption, "h-7 w-7", "rounded-sm border")}
                    </button>
                  ))}
                </div>
                {themeError && <p role="alert" className="text-xs text-destructive">{themeError}</p>}
                <Button
                  type="button"
                  className="w-full"
                  disabled={themeSaving || activeThemeId === savedThemeId}
                  onClick={() => void saveSelectedTheme()}
                >
                  {themeSaving ? "Saving..." : "Save Changes"}
                </Button>
              </PopoverContent>
            </Popover>
          )}
          <h1 className="text-2xl sm:text-4xl font-bold text-foreground mb-2">
            Annoy the Streamer
          </h1>
          <div className="flex flex-col items-center">
            <div className="text-sm sm:text-base text-muted-foreground flex items-center justify-center gap-1">
              <span>
                Welcome,{" "}
                <span style={{ color: getUserColor(username) }} className="font-semibold">
                  {username}
                </span>
              </span>
              <Badge
                className="ml-2"
                style={{
                  backgroundColor: getUserColor(username, currentRank),
                  color: contrastingTextColor(getUserColor(username, currentRank) || activeTheme.panel_color),
                }}
              >
                {isAdmin ? "Admin" : currentRank}
              </Badge>
              <Button
                variant="outline"
                size="sm"
                onClick={handleLogout}
                disabled={isLoggingOut}
                className="ml-2 h-7 px-2"
              >
                {isLoggingOut ? "Logging out..." : "Log out"}
              </Button>
            </div>
            <div className="text-xs text-muted-foreground" aria-live="polite">
              {currentPoints !== null
                ? `${currentPoints}❖`
                : pointsLoading
                  ? "Loading ❖..."
                  : pointsError
                    ? "❖ unavailable"
                    : ""}
            </div>
          </div>
          {logoutError && <p role="alert" className="mt-2 text-sm text-destructive">{logoutError}</p>}
        </div>

        <div data-chat-layout className="relative flex flex-col md:grid md:grid-cols-1 lg:grid lg:grid-cols-[repeat(auto-fit,320px)] gap-3 sm:gap-4 lg:items-start lg:justify-center">
          {/* --- Left Column: Send Chaos --- */}
          <div className="relative z-10 order-1 md:order-1 lg:order-3">
            <Card className={`card-hover relative flex flex-col h-auto max-h-[80dvh] overflow-hidden lg:h-[calc(100dvh_-_18rem)] lg:max-h-none lg:overflow-visible lg:!transition-[transform,box-shadow] ${isChatRestricted ? "opacity-60 grayscale" : ""}`}>
              <CardHeader className="pb-2 sm:pb-3 flex-shrink-0">
                <CardTitle className="text-base sm:text-lg">Send Your Chaos</CardTitle>
                <CardDescription className="text-xs">Choose your weapon</CardDescription>
              </CardHeader>
              <fieldset
                disabled={isChatRestricted}
                className="min-h-0 min-w-0 flex-1 overflow-y-auto border-0 p-3 sm:p-6 lg:overflow-hidden disabled:pointer-events-none"
              >
                <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col lg:h-full">
                  <TabsList data-columns="4" className="joined-tabs grid w-full grid-cols-4 mb-3 sm:mb-4 h-8 sm:h-10 flex-shrink-0">
                    <TabsTrigger value="facememe" className="gap-1 text-[10px] sm:text-xs px-1">
                      <MessageSquare className="h-3 w-3" /> <span className="hidden sm:inline">Face</span>
                    </TabsTrigger>
                    <TabsTrigger value="normalmeme" className="gap-1 text-[10px] sm:text-xs px-1">
                      <ImageIcon className="h-3 w-3" /> <span className="hidden sm:inline">Image</span>
                    </TabsTrigger>
                    <TabsTrigger value="tts" className="gap-1 text-[10px] sm:text-xs px-1">
                      <Mic className="h-3 w-3" /> <span className="hidden sm:inline">TTS</span>
                    </TabsTrigger>
                    <TabsTrigger value="soundboard" className="gap-1 text-[10px] sm:text-xs px-1">
                      <Volume2 className="h-3 w-3" /> <span className="hidden sm:inline">Sounds</span>
                    </TabsTrigger>
                  </TabsList>

                  {/* --- Face Meme Tab --- */}
                  <TabsContent value="facememe" className="space-y-2 sm:space-y-3 mt-0 flex flex-col lg:flex-1 lg:min-h-0">
                    <form autoComplete="off" onSubmit={handleFaceMemeSubmit} className="flex flex-col lg:h-full">
                      <div className="flex-1 space-y-2 sm:space-y-3">
                        <div>
                          <label className="text-xs font-medium mb-1 block">Top Text</label>
                          <Input
                            value={faceMemeTop}
                            onChange={(e) => setFaceMemeTop(e.target.value)}
                            placeholder="Top text..."
                            className="h-7 sm:h-8 text-xs sm:text-sm"
                          />
                        </div>
                        <div>
                          <label className="text-xs font-medium mb-1 block">Bottom Text</label>
                          <Input
                            value={faceMemeBottom}
                            onChange={(e) => setFaceMemeBottom(e.target.value)}
                            placeholder="Bottom text..."
                            className="h-7 sm:h-8 text-xs sm:text-sm"
                          />
                        </div>
                        {(faceMemeTop || faceMemeBottom) && (
                          <div className="space-y-1">
                            <div className="flex items-center justify-between">
                              <label className="text-xs font-medium">Preview</label>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-7 px-2"
                                onClick={() => {
                                  setFaceMemeTop("")
                                  setFaceMemeBottom("")
                                }}
                              >
                                Clear meme
                              </Button>
                            </div>
                            <div className="w-full max-w-[400px] mx-auto aspect-[4/3] overflow-hidden border rounded">
                              <FaceMemeArtwork
                                preview
                                toptext={faceMemeTop}
                                bottomtext={faceMemeBottom}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                      <Button type="submit" disabled={!canAffordAction("facemememe")} className="w-full h-7 sm:h-8 text-xs sm:text-sm mt-3 md:mt-3 lg:mt-auto disabled:grayscale">
                        {actionButtonText("Send Face Meme", "facemememe")}
                      </Button>
                    </form>
                  </TabsContent>

                  {/* --- Normal Meme Tab --- */}
                  <TabsContent value="normalmeme" className="space-y-2 sm:space-y-3 mt-0 flex flex-col lg:flex-1 lg:min-h-0">
                    <form autoComplete="off" onSubmit={handleNormalMemeSubmit} className="flex flex-col lg:h-full">
                      <div className="min-h-0 flex-1 space-y-2 sm:space-y-3">
                        <div>
                          <label className="text-xs font-medium mb-1 block">Image</label>
                          <div className="flex gap-2">
                            <Input
                              type="url"
                              value={normalMemeImage}
                              onChange={(e) => {
                                setNormalMemeImage(e.target.value)
                                if (e.target.value) {
                                  setNormalMemeFile(null)
                                  setNormalMemeFileData(null)
                                }
                              }}
                              placeholder="URL..."
                              className="h-7 sm:h-8 text-xs sm:text-sm flex-1"
                              aria-label="Normal meme image URL"
                            />
                            <div className="relative">
                              <Input
                                type="file"
                                accept="image/*"
                                onChange={handleFileUpload}
                                className="hidden"
                                id="file-upload"
                              />
                              <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                className="h-7 w-7 sm:h-8 sm:w-8 bg-transparent"
                                asChild
                              >
                                <label
                                  htmlFor="file-upload"
                                  className="cursor-pointer flex items-center justify-center"
                                >
                                  <Upload className="h-3 w-3" />
                                </label>
                              </Button>
                            </div>
                          </div>
                          {normalMemeFile && (
                            <div className="mt-1 flex min-w-0 items-center gap-2 text-xs">
                              <p className="min-w-0 flex-1 truncate text-muted-foreground">
                                {normalMemeFile.name}
                              </p>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-7 shrink-0 px-2 sm:h-8"
                                onClick={() => {
                                  setNormalMemeFile(null)
                                  setNormalMemeFileData(null)
                                }}
                              >
                                Clear file
                              </Button>
                            </div>
                          )}
                        </div>
                        <div>
                          <label className="text-xs font-medium mb-1 block">Top Text</label>
                          <Input
                            value={normalMemeTop}
                            onChange={(e) => setNormalMemeTop(e.target.value)}
                            placeholder="Top text..."
                            className="h-7 sm:h-8 text-xs sm:text-sm"
                          />
                        </div>
                        <div>
                          <label className="text-xs font-medium mb-1 block">Bottom Text</label>
                          <Input
                            value={normalMemeBottom}
                            onChange={(e) => setNormalMemeBottom(e.target.value)}
                            placeholder="Bottom text..."
                            className="h-7 sm:h-8 text-xs sm:text-sm"
                          />
                        </div>
                        {(normalMemeImage || normalMemeFileData || normalMemeTop || normalMemeBottom) && (
                          <div className="space-y-1">
                            <div className="flex items-center justify-between">
                              <label className="text-xs font-medium">Preview</label>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-7 px-2"
                                onClick={() => {
                                  setNormalMemeImage("")
                                  setNormalMemeFile(null)
                                  setNormalMemeFileData(null)
                                  setNormalMemeTop("")
                                  setNormalMemeBottom("")
                                }}
                              >
                                Clear meme
                              </Button>
                            </div>
                            <div className="w-full max-w-[400px] mx-auto aspect-[4/3] overflow-hidden border rounded">
                              <NormalMemeArtwork
                                preview
                                image={normalMemeFileData || normalMemeImage}
                                toptext={normalMemeTop}
                                bottomtext={normalMemeBottom}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                      <Button type="submit" disabled={!canAffordAction("normalmeme")} className="w-full h-7 sm:h-8 text-xs sm:text-sm mt-3 md:mt-3 lg:mt-auto disabled:grayscale">
                        {actionButtonText("Send Image Meme", "normalmeme")}
                      </Button>
                    </form>
                  </TabsContent>

                  {/* --- TTS Tab --- */}
                  <TabsContent value="tts" className="space-y-2 sm:space-y-3 mt-0 flex flex-col lg:flex-1 lg:min-h-0">
                    <form autoComplete="off" onSubmit={handleTTSSubmit} className="flex flex-col lg:h-full">
                      <div className="flex-1 space-y-2 sm:space-y-3">
                        <div>
                          <label className="text-xs font-medium mb-1 block">TTS Message</label>
                          <Textarea
                            value={ttsText}
                            onChange={(e) => setTtsText(e.target.value)}
                            placeholder="Type your TTS message..."
                            rows={3}
                            className="text-xs sm:text-sm resize-none"
                          />
                        </div>
                        <div>
                          <label className="text-xs font-medium mb-1 block">Language</label>
                          <select
                            value={ttsLanguage}
                            onChange={(e) => setTtsLanguage(e.target.value)}
                            className="w-full h-7 sm:h-8 rounded-md border border-input bg-background px-2 py-1 text-xs sm:text-sm"
                          >
                            <option value="en">English</option>
                            <option value="es">Spanish</option>
                            <option value="fr">French</option>
                            <option value="de">German</option>
                            <option value="it">Italian</option>
                            <option value="pt">Portuguese</option>
                            <option value="pl">Polish</option>
                            <option value="ru">Russian</option>
                            <option value="ja">Japanese</option>
                            <option value="ko">Korean</option>
                            <option value="zh">Chinese</option>
                            <option value="ar">Arabic</option>
                            <option value="hi">Hindi</option>
                            <option value="tr">Turkish</option>
                            <option value="nl">Dutch</option>
                            <option value="sv">Swedish</option>
                            <option value="no">Norwegian</option>
                            <option value="da">Danish</option>
                            <option value="fi">Finnish</option>
                          </select>
                        </div>
                      </div>
                      <Button type="submit" disabled={!canAffordAction("tts")} className="w-full h-7 sm:h-8 text-xs sm:text-sm mt-3 md:mt-3 lg:mt-auto disabled:grayscale">
                        {actionButtonText("Send TTS", "tts")}
                      </Button>
                    </form>
                  </TabsContent>
                  {/* --- Soundboard Tab --- */}
<TabsContent value="soundboard" className="mt-0 flex flex-col lg:flex-1 lg:min-h-0">
  <ScrollArea className="pr-3 lg:flex-1 lg:max-h-full lg:overflow-y-auto">
    <div className="mb-2">
      <Input
        value={soundSearch}
        onChange={(e) => setSoundSearch(e.target.value)}
        placeholder="Search sounds..."
        className="h-7 w-full text-xs sm:h-8 sm:text-sm"
      />
    </div>
    {assetLoadError && <p role="alert" className="text-xs text-destructive">{assetLoadError}</p>}
    <div className="space-y-2 pr-1">
      {filteredSounds.map((sound) => (
        <div key={sound.asset_id} className="flex min-w-0 items-center gap-2 rounded-md border p-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={`Play ${sound.title}`}
            disabled={!canAffordSound(sound) || isChatRestricted}
            onClick={() => playSound(sound.asset_id)}
            className="h-8 w-8 flex-shrink-0 disabled:grayscale"
          >
            <Volume2 className="h-3 w-3" />
          </Button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium">{sound.title}</p>
            <p className="text-[10px] text-muted-foreground">{sound.play_cost}❖</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`${sound.favorite ? "Remove" : "Add"} ${sound.title} ${sound.favorite ? "from" : "to"} favorites`}
            onClick={() => void toggleSoundFavorite(sound)}
            className="h-8 w-8 shrink-0 text-primary hover:text-primary/80"
          >
            <Star className={`h-3 w-3 ${sound.favorite ? "fill-primary" : ""}`} />
          </Button>
        </div>
      ))}
      {filteredSounds.length === 0 && (
        <p className="text-center text-[11px] text-muted-foreground mt-2">
          No sounds found.
        </p>
      )}
    </div>
  </ScrollArea>
</TabsContent>


                </Tabs>
              </fieldset>
              {actionError && (
                <p
                  role="alert"
                  title={actionError}
                  className="pointer-events-none absolute inset-x-3 bottom-0.5 truncate text-[10px] leading-3 text-destructive sm:inset-x-6 sm:bottom-1.5"
                >
                  {actionError}
                </p>
              )}
            </Card>
          </div>

          {username && permission("panel_access") && (
          <div className="relative z-10 order-3 md:order-3 lg:order-1">
            <Card className="card-hover flex flex-col h-auto max-h-[80dvh] overflow-hidden lg:h-[calc(100dvh_-_18rem)] lg:max-h-none lg:overflow-visible lg:!transition-[transform,box-shadow]">
              <CardHeader className="pb-2 sm:pb-3 flex-shrink-0">
                <CardTitle className="text-base sm:text-lg">{isAdmin ? "Admin" : "Moderation"}</CardTitle>
                <CardDescription className="text-xs">{isAdmin ? "Manage users and account settings" : "Inspect users and manage chat moderation"}</CardDescription>
              </CardHeader>
              <CardContent data-chaos-control-sizing className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-6 lg:overflow-hidden">
                <Tabs value={adminView} onValueChange={(value) => setAdminView(value as "users" | "admin" | "pricing" | "soundboard" | "emoji" | "themes" | "badges")} className="flex flex-col lg:h-full">
                  <TabsList
                    data-columns={isAdmin ? "3" : "1"}
                    className={`joined-tabs grid w-full ${isAdmin ? "grid-cols-3" : "grid-cols-1"} mb-3 sm:mb-4 h-auto flex-shrink-0`}
                  >
                    <TabsTrigger value="users" className="gap-1 text-[10px] sm:text-xs px-1">
                      <Users className="h-3 w-3" /> Users
                    </TabsTrigger>
                    {permission("admin_console") && (
                      <TabsTrigger value="admin" className="gap-1 text-[10px] sm:text-xs px-1">
                        <Shield className="h-3 w-3" /> Admin
                      </TabsTrigger>
                    )}
                    {permission("admin_console") && (
                      <TabsTrigger value="pricing" className="gap-1 text-[10px] sm:text-xs px-1">
                        ❖ Pricing
                      </TabsTrigger>
                    )}
                    {permission("admin_console") && (
                      <TabsTrigger value="soundboard" className="gap-1 text-[10px] sm:text-xs px-1">
                        <Music className="h-3 w-3 shrink-0" /> Soundboard
                      </TabsTrigger>
                    )}
                    {permission("admin_console") && (
                      <TabsTrigger value="emoji" className="gap-1 text-[10px] sm:text-xs px-1">
                        <Smile className="h-3 w-3" /> Emoji
                      </TabsTrigger>
                    )}
                    {permission("admin_console") && (
                      <TabsTrigger value="themes" className="gap-1 text-[10px] sm:text-xs px-1">
                        <Palette className="h-3 w-3" /> Themes
                      </TabsTrigger>
                    )}
                    {permission("admin_console") && (
                      <TabsTrigger value="badges" className="gap-1 text-[10px] sm:text-xs px-1">
                        <Award className="h-3 w-3" /> Badges
                      </TabsTrigger>
                    )}
                  </TabsList>
                  <TabsContent value="users" className="mt-0 space-y-3 lg:flex-1 lg:min-h-0 lg:overflow-y-auto">
                    <div className="space-y-3">
                  {adminView === "users" ? (
                    <>
                      <form data-bwignore="true" autoComplete="off" onSubmit={loadManagedUser} className="flex gap-2">
                        <Input
                          data-bwignore="true"
                          type="search"
                          name="admin-user-lookup"
                          autoComplete="off"
                          value={lookupUsername}
                          onChange={(event) => setLookupUsername(event.target.value)}
                          placeholder="Find account"
                          aria-label="Account to look up"
                        />
                        <Button type="submit" variant="outline" disabled={!lookupUsername.trim()}>
                          Confirm
                        </Button>
                      </form>
                      {managedUser && (
                        <div className="space-y-3 border-t pt-3">
                          <div className="space-y-1 text-sm">
                            <p className="font-semibold">{managedUser.username} · {managedUser.rank}</p>
                            <p>Messages: {managedUser.message_count}</p>
                            <p>❖: {managedUser.points}</p>
                            <p>
                              Chat timeout: {managedUser.chat_timeout_until
                                && isActiveTimeout(managedUser.chat_timeout_until)
                                ? new Date(managedUser.chat_timeout_until).toLocaleString()
                                : "No"}
                            </p>
                            <div className="flex flex-wrap items-center gap-1">
                              <span>Badges:</span>
                              {managedUser.badges.length
                                ? managedUser.badges.map((badge) => (
                                  <img key={badge.asset_id} src={badge.url} alt={badge.name} title={badge.name} className="h-4 w-4 object-contain" />
                                ))
                                : <span className="text-muted-foreground">None</span>}
                            </div>
                          </div>
                          {permission("admin_console") && (
                            <form
                              className="flex items-end gap-2"
                              onSubmit={(event) => {
                                event.preventDefault()
                                void changeBadgeForInspectedUser("grant")
                              }}
                            >
                              <label className="min-w-0 flex-1 space-y-1 text-xs">
                                <span>Badge</span>
                                <Input
                                  value={adminBadgeGrantName}
                                  onChange={(event) => setAdminBadgeGrantName(event.target.value)}
                                  placeholder="Badge name"
                                  className="h-8"
                                  aria-label="Badge name to grant to inspected user"
                                />
                              </label>
                              <Button type="submit" variant="outline" size="sm" className="h-8" disabled={!adminBadgeGrantName.trim() || adminBadgeGranting}>
                                {adminBadgeGranting ? "Granting…" : "Grant"}
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-8"
                                disabled={!adminBadgeGrantName.trim() || adminBadgeGranting}
                                onClick={() => void changeBadgeForInspectedUser("remove")}
                              >
                                {adminBadgeGranting ? "Removing…" : "Remove"}
                              </Button>
                            </form>
                          )}
                          {permission("adjust_points") && <form
                            autoComplete="off"
                            className="flex items-end gap-2"
                            onSubmit={(event) => {
                              event.preventDefault()
                              const amount = Number(pointsAdjustment)
                              if (Number.isInteger(amount)) {
                                const storageKey = `ats-point-adjustment:${managedUser.username}:${amount}`
                                if (
                                  !pendingPointAdjustment.current
                                  || pendingPointAdjustment.current.username !== managedUser.username
                                  || pendingPointAdjustment.current.amount !== amount
                                ) {
                                  let requestId = ""
                                  try {
                                    requestId = sessionStorage.getItem(storageKey) || ""
                                  } catch {
                                    requestId = ""
                                  }
                                  if (!requestId) {
                                    requestId = crypto.randomUUID()
                                    try {
                                      sessionStorage.setItem(storageKey, requestId)
                                    } catch {
                                      // The in-memory ID still protects same-page retries.
                                    }
                                  }
                                  pendingPointAdjustment.current = {
                                    username: managedUser.username,
                                    amount,
                                    requestId,
                                  }
                                }
                                void updateManagedUser("points", {
                                  amount,
                                  request_id: pendingPointAdjustment.current.requestId,
                                })
                              }
                            }}
                          >
                            <label className="flex-1 space-y-1 text-xs">
                              <span>Adjust points</span>
                              <Input type="number" step="1" value={pointsAdjustment} onChange={(event) => setPointsAdjustment(event.target.value)} placeholder="0" aria-label="Point adjustment (default 0)" />
                            </label>
                            <Button type="submit" variant="outline">Adjust</Button>
                          </form>}
                          {canChangeManagedUserRank && <div className="space-y-1">
                            <label htmlFor="user-rank" className="text-xs">Rank</label>
                            <div className="flex gap-2">
                              <select
                                id="user-rank"
                                value={rankSelection}
                                onChange={(event) => setRankSelection(event.target.value)}
                                className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                              >
                                <option value="">Select rank</option>
                                {assignableRankOptions.map((option) => (
                                  <option key={option.id} value={option.rank}>
                                    {option.rank}
                                  </option>
                                ))}
                              </select>
                              <Button
                                type="button"
                                variant="outline"
                                disabled={!rankSelection || rankSelection === managedUser.rank}
                                onClick={() => void updateManagedUser("rank", { rank: rankSelection })}
                              >
                                Save
                              </Button>
                            </div>
                            {rankOptions.find((option) => option.rank === rankSelection) && (
                              <span
                                className="inline-block h-3 w-3 rounded-full border"
                                style={{ backgroundColor: rankOptions.find((option) => option.rank === rankSelection)?.color }}
                                aria-label={`${rankSelection} color`}
                              />
                            )}
                          </div>}
                          {canManageTimeouts && canTimeoutManagedUser && (
                            <>
                              <form
                                autoComplete="off"
                                className="flex flex-nowrap items-end gap-2"
                                onSubmit={(event) => {
                                  event.preventDefault()
                                  const durationSeconds = Number(timeoutDurationSeconds || "60")
                                  if (!Number.isSafeInteger(durationSeconds) || durationSeconds <= 0) {
                                    setAdminError("Enter a whole number of seconds greater than zero.")
                                    return
                                  }
                                  void updateManagedUser("timeout", { duration_seconds: durationSeconds })
                                }}
                              >
                                <label className="min-w-0 flex-1 space-y-1 text-xs">
                                  <span>Chat timeout (seconds)</span>
                                  <Input
                                    type="number"
                                    min="1"
                                    step="1"
                                    value={timeoutDurationSeconds}
                                    onChange={(event) => setTimeoutDurationSeconds(event.target.value)}
                                    placeholder="60"
                                    aria-label="Chat timeout duration in seconds"
                                  />
                                </label>
                                <Button type="submit" variant="outline">Ban</Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  disabled={!isActiveTimeout(managedUser.chat_timeout_until)}
                                  onClick={() => void updateManagedUser("timeout", { clear: true })}
                                >
                                  Unban
                                </Button>
                              </form>
                            </>
                          )}
                          {permission("reset_password") && (
                            <div className="space-y-2">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-sm">Reset password</span>
                                {!confirmingPasswordReset ? (
                                  <Button variant="outline" className="w-32" onClick={() => setConfirmingPasswordReset(true)}>
                                    Reset password
                                  </Button>
                                ) : (
                                  <div className="flex gap-2">
                                    <Button variant="outline" onClick={() => setConfirmingPasswordReset(false)}>Cancel</Button>
                                    <Button variant="destructive" onClick={() => void updateManagedUser("reset-password", {})}>Confirm</Button>
                                  </div>
                                )}
                              </div>
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-sm">Reset email</span>
                                {!confirmingEmailReset ? (
                                  <Button variant="outline" className="w-32" onClick={() => setConfirmingEmailReset(true)}>
                                    Reset email
                                  </Button>
                                ) : (
                                  <div className="flex gap-2">
                                    <Button variant="outline" onClick={() => setConfirmingEmailReset(false)}>Cancel</Button>
                                    <Button variant="destructive" onClick={() => void updateManagedUser("reset-email", {})}>Confirm</Button>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  ) : <p className="text-sm text-muted-foreground">Admin tools are open for testing.</p>}
                    </div>
                    {adminError && <p role="alert" className="text-sm text-destructive">{adminError}</p>}
                    {adminNotice && (
                      <div role="status" className="space-y-1 text-sm text-muted-foreground">
                        <p>{adminNotice}</p>
                        {adminIssuedRecoveryToken && (
                          <>
                            <p className="break-all text-sm text-muted-foreground">
                              Recovery code:{" "}
                              <code
                                className="select-all cursor-pointer"
                                role="button"
                                tabIndex={0}
                                aria-label="Copy one-time account recovery code"
                                onClick={() => void copyRecoveryCode(adminIssuedRecoveryToken, setAdminRecoveryCopyNotice, setAdminError)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault()
                                    void copyRecoveryCode(adminIssuedRecoveryToken, setAdminRecoveryCopyNotice, setAdminError)
                                  }
                                }}
                              >
                                {adminIssuedRecoveryToken}
                              </code>
                            </p>
                            <p className="text-sm text-muted-foreground">After copying the recovery code, log out and press &quot;Account recovery&quot; button.</p>
                            {adminRecoveryCopyNotice && <p role="status" className="text-sm text-muted-foreground">{adminRecoveryCopyNotice}</p>}
                          </>
                        )}
                      </div>
                    )}
                  </TabsContent>
                  {permission("admin_console") && <TabsContent value="admin" className="mt-0 lg:flex-1 lg:min-h-0 lg:overflow-y-auto">
                    <div className="space-y-4">
                      <div className="flex items-center gap-3">
                        <Button variant={isStreaming ? "destructive" : "default"} onClick={() => void toggleStreaming()}>
                          {isStreaming ? "Stop streaming" : "Start streaming"}
                        </Button>
                        <span className="text-sm text-muted-foreground">
                          {isStreaming
                            ? "Point awards are on. Saved settings apply next stream."
                            : "Point awards are off."}
                        </span>
                      </div>
                      <div className="grid max-w-md grid-cols-2 gap-3">
                        <label className="space-y-1 text-xs">
                          <span>Points per interval</span>
                          <Input
                            aria-label="Points per stream interval"
                            type="number"
                            min={1}
                            max={1_000_000}
                            step={1}
                            disabled={streamSettingsLoading || streamSettingsSaving}
                            value={streamPointSettings.points_per_interval}
                            onChange={(event) => setStreamPointSettings((current) => ({
                              ...current,
                              points_per_interval: event.target.value,
                            }))}
                          />
                        </label>
                        <label className="space-y-1 text-xs">
                          <span>Interval (seconds)</span>
                          <Input
                            aria-label="Stream point interval in seconds"
                            type="number"
                            min={1}
                            max={86_400}
                            step={1}
                            disabled={streamSettingsLoading || streamSettingsSaving}
                            value={streamPointSettings.interval_seconds}
                            onChange={(event) => setStreamPointSettings((current) => ({
                              ...current,
                              interval_seconds: event.target.value,
                            }))}
                          />
                        </label>
                      </div>
                      <Button
                        variant="outline"
                        disabled={streamSettingsLoading || streamSettingsSaving}
                        onClick={() => void saveStreamPointSettings()}
                      >
                        {streamSettingsSaving ? "Saving..." : "Save point settings"}
                      </Button>
                    </div>
                  </TabsContent>}
                  {permission("admin_console") && <TabsContent value="pricing" className="mt-0 lg:flex-1 lg:min-h-0 lg:overflow-y-auto">
                    {pricingLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
                    {pointPricing && (
                      <div className="space-y-4">
                        <section className="space-y-2">
                          <h3 className="text-sm font-semibold">Send Your Chaos</h3>
                          <div className="grid grid-cols-2 gap-2 pt-2">
                            {SEND_YOUR_CHAOS_ACTIONS.map(({ key, label }) => (
                              <label key={key} className="space-y-1 text-xs">
                                <span>{label}</span>
                                <Input
                                  aria-label={`${label} price`}
                                  type="number"
                                  min={-1}
                                  step={1}
                                  value={pointPricing.send_your_chaos[key]}
                                  onChange={(event) => updateActionPrice(key, event.target.valueAsNumber)}
                                  className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                />
                              </label>
                            ))}
                          </div>
                        </section>

                        <details className="border-t pt-3">
                          <summary className="cursor-pointer text-sm font-semibold">Emoji</summary>
                          <section className="space-y-2 pt-3">
                          <label className="block space-y-1 text-xs">
                            <span>Default price</span>
                            <Input
                              aria-label="Default emoji price"
                              type="number"
                              min={-1}
                              step={1}
                              value={pointPricing.catalog.emoji.default}
                              onChange={(event) => updateCatalogDefault("emoji", event.target.valueAsNumber)}
                              className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                            />
                          </label>

                          <details className="rounded-md border px-3 py-2">
                            <summary className="cursor-pointer text-xs font-medium">
                              Exceptions ({Object.keys(pointPricing.catalog.emoji.items).length})
                            </summary>
                            <div className="space-y-2">
                              <form
                                autoComplete="off"
                                className="flex flex-col gap-2"
                                onSubmit={(event) => {
                                  event.preventDefault()
                                  const item = newEmojiItem.trim()
                                  const price = parsePointPrice(newEmojiItemPrice.trim() || "100")
                                  if (!item || Object.prototype.hasOwnProperty.call(pointPricing.catalog.emoji.items, item) || price === null) {
                                    setPricingError("Enter a new item name and a valid price of -1 or a non-negative whole number.")
                                    return
                                  }
                                  updateCatalogItemPrice("emoji", item, price)
                                  setNewEmojiItem("")
                                }}
                              >
                                <Input value={newEmojiItem} onChange={(event) => setNewEmojiItem(event.target.value)} placeholder="Emoji name" aria-label="New emoji exception name" className="w-full" />
                                <div className="flex items-center gap-2">
                                  <Input type="number" min={-1} step={1} value={newEmojiItemPrice} onChange={(event) => setNewEmojiItemPrice(event.target.value)} placeholder="100" aria-label="New emoji exception price (default 100)" className="w-full [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />
                                  <Button type="submit" variant="outline">Add</Button>
                                </div>
                              </form>
                              {Object.entries(pointPricing.catalog.emoji.items).map(([item, price]) => (
                                <div key={item} className="flex items-center gap-2">
                                  <span className="min-w-0 flex-1 truncate text-xs">{item}</span>
                                  <Input
                                    aria-label={`${item} emoji price`}
                                    type="number"
                                    min={-1}
                                    step={1}
                                    inputMode="decimal"
                                    value={editedCatalogPrices[`emoji:${item}`] ?? String(price)}
                                    onChange={(event) => updateEditedCatalogItemPrice("emoji", item, event.target.value)}
                                    className="w-24 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                  />
                                  <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${item} emoji exception`} onClick={() => removeCatalogItemPrice("emoji", item)}>
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </div>
                              ))}
                            </div>
                          </details>

                          <label className="block space-y-1 text-xs">
                            <span>Add your own</span>
                            <Input
                              aria-label="Add your own emoji price"
                              type="number"
                              min={-1}
                              step={1}
                              value={pointPricing.proposal_rewards.emoji.default}
                              onChange={(event) => updateProposalDefault("emoji", event.target.valueAsNumber)}
                              className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                            />
                          </label>
                          <label className="block space-y-1 text-xs">
                            <span>Add your own (exclusive)</span>
                            <Input
                              aria-label="Add your own exclusive emoji price"
                              type="number"
                              min={-1}
                              step={1}
                              value={pointPricing.proposal_rewards.emoji.exclusive}
                              onChange={(event) => updateProposalExclusive("emoji", event.target.valueAsNumber)}
                            />
                          </label>
                          <details className="rounded-md border px-3 py-2">
                            <summary className="cursor-pointer text-xs font-medium">
                              Proposal reward exceptions ({Object.keys(pointPricing.proposal_rewards.emoji.items).length})
                            </summary>
                            <div className="space-y-2 pt-2">
                              <form
                                autoComplete="off"
                                className="flex flex-col gap-2"
                                onSubmit={(event) => {
                                  event.preventDefault()
                                  const item = normalizeProposalItemName(newEmojiProposalItem)
                                  const price = parsePointPrice(newEmojiProposalItemPrice)
                                  if (!item || Object.prototype.hasOwnProperty.call(pointPricing.proposal_rewards.emoji.items, item) || price === null) {
                                    setPricingError("Enter a new emoji name and a valid proposal reward of -1 or a non-negative whole number.")
                                    return
                                  }
                                  updateProposalItemReward("emoji", item, price)
                                  setNewEmojiProposalItem("")
                                  setNewEmojiProposalItemPrice("")
                                }}
                              >
                                <Input
                                  value={newEmojiProposalItem}
                                  onChange={(event) => setNewEmojiProposalItem(event.target.value)}
                                  placeholder="Emoji name"
                                  aria-label="New emoji proposal reward name"
                                  className="w-full"
                                />
                                <div className="flex items-center gap-2">
                                  <Input
                                    type="number"
                                    min={-1}
                                    step={1}
                                    value={newEmojiProposalItemPrice}
                                    onChange={(event) => setNewEmojiProposalItemPrice(event.target.value)}
                                    aria-label="New emoji proposal reward"
                                    className="w-full [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                  />
                                  <Button type="submit" variant="outline">Add</Button>
                                </div>
                              </form>
                              {Object.entries(pointPricing.proposal_rewards.emoji.items).map(([item, price]) => (
                                <div key={item} className="flex items-center gap-2">
                                  <span className="min-w-0 flex-1 truncate text-xs">{item}</span>
                                  <Input
                                    aria-label={`${item} emoji proposal reward`}
                                    type="number"
                                    min={-1}
                                    step={1}
                                    value={editedCatalogPrices[`proposal-emoji:${item}`] ?? String(price)}
                                    onChange={(event) => updateEditedProposalItemReward("emoji", item, event.target.value)}
                                    className="w-24 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                  />
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    aria-label={`Remove ${item} emoji proposal reward`}
                                    onClick={() => removeProposalItemReward("emoji", item)}
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </div>
                              ))}
                            </div>
                          </details>
                          <div className="grid grid-cols-2 gap-2">
                            <label className="space-y-1 text-xs">
                              <span>Max px</span>
                              <Input
                                aria-label="Emoji max px"
                                type="number"
                                min={1}
                                max={8192}
                                step={1}
                                value={pointPricing.asset_limits.emoji.max_px}
                                onChange={(event) => updateAssetLimit("emoji", "max_px", event.target.valueAsNumber)}
                              />
                            </label>
                            <label className="space-y-1 text-xs">
                              <span>Max px (admin)</span>
                              <Input
                                aria-label="Emoji max px admin"
                                type="number"
                                min={1}
                                max={8192}
                                step={1}
                                value={pointPricing.asset_limits.emoji.max_px_admin}
                                onChange={(event) => updateAssetLimit("emoji", "max_px_admin", event.target.valueAsNumber)}
                              />
                            </label>
                          </div>
                          </section>
                        </details>

                        <details className="border-t pt-3">
                          <summary className="cursor-pointer text-sm font-semibold">Soundboard</summary>
                          <section className="space-y-2 pt-3">
                          <label className="block space-y-1 text-xs">
                            <span>Default price</span>
                            <Input
                              aria-label="Default sound price"
                              type="number"
                              min={-1}
                              step={1}
                              value={pointPricing.catalog.sound.default}
                              onChange={(event) => updateCatalogDefault("sound", event.target.valueAsNumber)}
                              className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                            />
                          </label>

                          <details className="rounded-md border px-3 py-2">
                            <summary className="cursor-pointer text-xs font-medium">
                              Exceptions ({Object.keys(pointPricing.catalog.sound.items).length})
                            </summary>
                            <div className="space-y-2 pt-2">
                              <form
                                autoComplete="off"
                                className="flex flex-col gap-2"
                                onSubmit={(event) => {
                                  event.preventDefault()
                                  const item = newSoundItem.trim()
                                  const price = parsePointPrice(newSoundItemPrice.trim() || "100")
                                  if (!item || Object.prototype.hasOwnProperty.call(pointPricing.catalog.sound.items, item) || price === null) {
                                    setPricingError("Enter a sound filename and a valid price of -1 or a non-negative whole number.")
                                    return
                                  }
                                  updateCatalogItemPrice("sound", item, price)
                                  setNewSoundItem("")
                                }}
                              >
                                <Input value={newSoundItem} onChange={(event) => setNewSoundItem(event.target.value)} placeholder="Sound filename (e.g. 21.mp3)" aria-label="New sound exception filename" className="w-full" />
                                <div className="flex items-center gap-2">
                                  <Input type="number" min={-1} step={1} value={newSoundItemPrice} onChange={(event) => setNewSoundItemPrice(event.target.value)} placeholder="100" aria-label="New sound exception price (default 100)" className="w-full [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />
                                  <Button type="submit" variant="outline">Add</Button>
                                </div>
                              </form>
                              {Object.entries(pointPricing.catalog.sound.items).map(([item, price]) => (
                                <div key={item} className="flex items-center gap-2">
                                  <span className="min-w-0 flex-1 truncate text-xs">{item}</span>
                                  <Input
                                    aria-label={`${item} sound price`}
                                    type="number"
                                    min={-1}
                                    step={1}
                                    inputMode="decimal"
                                    value={editedCatalogPrices[`sound:${item}`] ?? String(price)}
                                    onChange={(event) => updateEditedCatalogItemPrice("sound", item, event.target.value)}
                                    className="w-24 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                  />
                                  <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${item} sound exception`} onClick={() => removeCatalogItemPrice("sound", item)}>
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </div>
                              ))}
                            </div>
                          </details>

                          <label className="block space-y-1 text-xs">
                            <span>Default play price</span>
                            <Input
                              aria-label="Default sound play price"
                              type="number"
                              min={0}
                              step={1}
                              value={pointPricing.catalog.sound.play_default}
                              onChange={(event) => updateSoundPlayDefault(event.target.valueAsNumber)}
                              className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                            />
                          </label>

                          <details className="rounded-md border px-3 py-2">
                            <summary className="cursor-pointer text-xs font-medium">
                              Play exceptions ({Object.keys(pointPricing.catalog.sound.play_items).length})
                            </summary>
                            <div className="space-y-2 pt-2">
                              <form
                                autoComplete="off"
                                className="flex flex-col gap-2"
                                onSubmit={(event) => {
                                  event.preventDefault()
                                  const item = newSoundPlayItem.trim()
                                  const rawPrice = newSoundPlayItemPrice
                                  const price = /^\d+$/.test(rawPrice) ? Number(rawPrice) : NaN
                                  if (
                                    !item ||
                                    Object.prototype.hasOwnProperty.call(pointPricing.catalog.sound.play_items, item) ||
                                    !Number.isSafeInteger(price)
                                  ) {
                                    setPricingError("Enter a sound filename and a non-negative whole-number play price.")
                                    return
                                  }
                                  updateSoundPlayItemPrice(item, price)
                                  setNewSoundPlayItem("")
                                  setNewSoundPlayItemPrice("")
                                }}
                              >
                                <Input
                                  value={newSoundPlayItem}
                                  onChange={(event) => setNewSoundPlayItem(event.target.value)}
                                  placeholder="Sound filename (e.g. 21.mp3)"
                                  aria-label="New sound play exception filename"
                                  className="w-full"
                                />
                                <div className="flex items-center gap-2">
                                  <Input
                                    type="number"
                                    min={0}
                                    step={1}
                                    value={newSoundPlayItemPrice}
                                    placeholder={String(pointPricing.catalog.sound.play_default)}
                                    onChange={(event) => setNewSoundPlayItemPrice(event.target.value)}
                                    aria-label="New sound play exception price"
                                    className="w-full [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                  />
                                  <Button type="submit" variant="outline">Add</Button>
                                </div>
                              </form>
                              {Object.entries(pointPricing.catalog.sound.play_items).map(([item, price]) => (
                                <div key={item} className="flex items-center gap-2">
                                  <span className="min-w-0 flex-1 truncate text-xs">{item}</span>
                                  <Input
                                    aria-label={`${item} sound play price`}
                                    type="number"
                                    min={0}
                                    step={1}
                                    value={editedCatalogPrices[`sound-play:${item}`] ?? String(price)}
                                    onChange={(event) => updateEditedSoundPlayItemPrice(item, event.target.value)}
                                    className="w-24 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                  />
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    aria-label={`Remove ${item} sound play exception`}
                                    onClick={() => removeSoundPlayItemPrice(item)}
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </div>
                              ))}
                            </div>
                          </details>

                          <label className="block space-y-1 text-xs">
                            <span>Add your own</span>
                            <Input
                              aria-label="Add your own sound price"
                              type="number"
                              min={-1}
                              step={1}
                              value={pointPricing.proposal_rewards.sound.default}
                              onChange={(event) => updateProposalDefault("sound", event.target.valueAsNumber)}
                              className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                            />
                          </label>
                          <label className="block space-y-1 text-xs">
                            <span>Add your own (exclusive)</span>
                            <Input
                              aria-label="Add your own exclusive sound price"
                              type="number"
                              min={-1}
                              step={1}
                              value={pointPricing.proposal_rewards.sound.exclusive}
                              onChange={(event) => updateProposalExclusive("sound", event.target.valueAsNumber)}
                            />
                          </label>
                          <details className="rounded-md border px-3 py-2">
                            <summary className="cursor-pointer text-xs font-medium">
                              Proposal reward exceptions ({Object.keys(pointPricing.proposal_rewards.sound.items).length})
                            </summary>
                            <div className="space-y-2 pt-2">
                              <form
                                autoComplete="off"
                                className="flex flex-col gap-2"
                                onSubmit={(event) => {
                                  event.preventDefault()
                                  const item = normalizeProposalItemName(newSoundProposalItem)
                                  const price = parsePointPrice(newSoundProposalItemPrice)
                                  if (!item || Object.prototype.hasOwnProperty.call(pointPricing.proposal_rewards.sound.items, item) || price === null) {
                                    setPricingError("Enter a new sound name and a valid proposal reward of -1 or a non-negative whole number.")
                                    return
                                  }
                                  updateProposalItemReward("sound", item, price)
                                  setNewSoundProposalItem("")
                                  setNewSoundProposalItemPrice("")
                                }}
                              >
                                <Input
                                  value={newSoundProposalItem}
                                  onChange={(event) => setNewSoundProposalItem(event.target.value)}
                                  placeholder="Sound name"
                                  aria-label="New sound proposal reward name"
                                  className="w-full"
                                />
                                <div className="flex items-center gap-2">
                                  <Input
                                    type="number"
                                    min={-1}
                                    step={1}
                                    value={newSoundProposalItemPrice}
                                    onChange={(event) => setNewSoundProposalItemPrice(event.target.value)}
                                    aria-label="New sound proposal reward"
                                    className="w-full [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                  />
                                  <Button type="submit" variant="outline">Add</Button>
                                </div>
                              </form>
                              {Object.entries(pointPricing.proposal_rewards.sound.items).map(([item, price]) => (
                                <div key={item} className="flex items-center gap-2">
                                  <span className="min-w-0 flex-1 truncate text-xs">{item}</span>
                                  <Input
                                    aria-label={`${item} sound proposal reward`}
                                    type="number"
                                    min={-1}
                                    step={1}
                                    value={editedCatalogPrices[`proposal-sound:${item}`] ?? String(price)}
                                    onChange={(event) => updateEditedProposalItemReward("sound", item, event.target.value)}
                                    className="w-24 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                  />
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    aria-label={`Remove ${item} sound proposal reward`}
                                    onClick={() => removeProposalItemReward("sound", item)}
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </div>
                              ))}
                            </div>
                          </details>
                          <div className="grid grid-cols-2 gap-2">
                            <label className="space-y-1 text-xs">
                              <span>Max length (seconds)</span>
                              <Input
                                aria-label="Sound max length"
                                type="number"
                                min={1}
                                max={180}
                                step={1}
                                value={pointPricing.asset_limits.sound.max_length}
                                onChange={(event) => updateAssetLimit("sound", "max_length", event.target.valueAsNumber)}
                              />
                            </label>
                            <label className="space-y-1 text-xs">
                              <span>Max length (admin)</span>
                              <Input
                                aria-label="Sound max length admin"
                                type="number"
                                min={1}
                                max={180}
                                step={1}
                                value={pointPricing.asset_limits.sound.max_length_admin}
                                onChange={(event) => updateAssetLimit("sound", "max_length_admin", event.target.valueAsNumber)}
                              />
                            </label>
                          </div>
                          </section>
                        </details>

                        <details className="border-t pt-3">
                          <summary className="cursor-pointer text-sm font-semibold">Themes</summary>
                          <section className="space-y-2 pt-3">
                            <label className="block space-y-1 text-xs">
                              <span>Default price</span>
                              <Input
                                aria-label="Default theme price"
                                type="number"
                                min={-1}
                                step={1}
                                value={pointPricing.catalog.theme.default}
                                onChange={(event) => updateCatalogDefault("theme", event.target.valueAsNumber)}
                                className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                              />
                            </label>
                            <details className="rounded-md border px-3 py-2">
                              <summary className="cursor-pointer text-xs font-medium">
                                Exceptions ({Object.keys(pointPricing.catalog.theme.items).length})
                              </summary>
                              <div className="space-y-2 pt-2">
                                <form
                                  autoComplete="off"
                                  className="flex flex-col gap-2"
                                  onSubmit={(event) => {
                                    event.preventDefault()
                                    const theme = adminThemes.find((themeOption) =>
                                      !themeOption.is_standard &&
                                      themeOption.name.trim().toLocaleLowerCase() === newThemeItem.trim().toLocaleLowerCase(),
                                    )
                                    const price = parsePointPrice(newThemeItemPrice)
                                    if (!theme || price === null) {
                                      setPricingError("Enter an existing theme name and a valid price of -1 or a non-negative whole number.")
                                      return
                                    }
                                    if (Object.prototype.hasOwnProperty.call(pointPricing.catalog.theme.items, theme.asset_id)) {
                                      setPricingError("That theme already has a price exception.")
                                      return
                                    }
                                    updateEditedThemePrice(theme.asset_id, newThemeItemPrice)
                                    setNewThemeItem("")
                                    setNewThemeItemPrice("")
                                  }}
                                >
                                  <Input
                                    value={newThemeItem}
                                    onChange={(event) => setNewThemeItem(event.target.value)}
                                    placeholder="Theme Name"
                                    aria-label="Theme price exception name"
                                    className="w-full"
                                  />
                                  <div className="flex items-center gap-2">
                                    <Input
                                      type="number"
                                      min={-1}
                                      step={1}
                                      value={newThemeItemPrice}
                                      onChange={(event) => setNewThemeItemPrice(event.target.value)}
                                      aria-label="New theme exception price"
                                      className="w-full [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                    />
                                    <Button type="submit" variant="outline">Add</Button>
                                  </div>
                                </form>
                                {Object.entries(pointPricing.catalog.theme.items).map(([themeId, price]) => {
                                  const themeOption = adminThemes.find((theme) => theme.asset_id === themeId)
                                  const themeName = themeOption?.name ?? themeId
                                  return (
                                    <div key={themeId} className="flex items-center gap-2">
                                      <span className="min-w-0 flex-1 truncate text-xs">{themeName}</span>
                                      <Input
                                        aria-label={`${themeName} theme price`}
                                        type="number"
                                        min={-1}
                                        step={1}
                                        value={editedCatalogPrices[`theme:${themeId}`] ?? String(price)}
                                        onChange={(event) => updateEditedThemePrice(themeId, event.target.value)}
                                        className="w-24 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                      />
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        aria-label={`Remove ${themeName} theme price exception`}
                                        onClick={() => removeCatalogItemPrice("theme", themeId)}
                                      >
                                        <Trash2 className="h-3 w-3" />
                                      </Button>
                                    </div>
                                  )
                                })}
                              </div>
                            </details>
                          </section>
                        </details>

                        <div className="space-y-2 border-t pt-3">
                          <Button type="button" onClick={() => void savePointPricing()} disabled={pricingSaving || pricingLoading}>
                            {pricingSaving ? "Saving..." : "Save"}
                          </Button>
                          {pricingError && <p role="alert" className="text-sm text-destructive">{pricingError}</p>}
                          {pricingNotice && <p role="status" className="text-sm text-muted-foreground">{pricingNotice}</p>}
                        </div>
                      </div>
                    )}
                    {!pricingLoading && !pointPricing && (
                      <div className="space-y-2">
                        {pricingError && <p role="alert" className="text-sm text-destructive">{pricingError}</p>}
                        <Button type="button" variant="outline" onClick={() => void loadPointPricing()}>Retry</Button>
                      </div>
                    )}
                  </TabsContent>}
                  {permission("admin_console") && (
                    <TabsContent value="soundboard" className="mt-0 lg:flex-1 lg:min-h-0 lg:overflow-y-auto lg:pr-3">
                      {renderAdminAssetManagement("sound")}
                    </TabsContent>
                  )}
                  {permission("admin_console") && (
                    <TabsContent value="emoji" className="mt-0 lg:flex-1 lg:min-h-0 lg:overflow-y-auto lg:pr-3">
                      {renderAdminAssetManagement("emoji")}
                    </TabsContent>
                  )}
                  {permission("admin_console") && (
                    <TabsContent value="themes" className="mt-0 space-y-4 lg:flex-1 lg:min-h-0 lg:overflow-y-auto lg:pr-3">
                      <details
                        className="rounded-md border"
                        onToggle={(event) => {
                          if (!event.currentTarget.open) clearAdminThemePreview()
                        }}
                      >
                        <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">Upload theme</summary>
                        <form className="space-y-2 px-3 pb-3" onSubmit={(event) => void createAdminTheme(event)}>
                          <Input
                            value={adminThemeName}
                            onChange={(event) => setAdminThemeName(event.target.value)}
                            maxLength={80}
                            placeholder="Theme Name"
                            required
                            aria-label="Theme name"
                          />
                          <div className="grid grid-cols-3 gap-2">
                            <label className="block space-y-1 text-xs">
                              <span>Background</span>
                              <Input
                                type="color"
                                value={adminThemePrimary}
                                onChange={(event) => setAdminThemePrimary(event.target.value)}
                                aria-label="Theme background color"
                                className="h-9 p-1"
                              />
                            </label>
                            <label className="block space-y-1 text-xs">
                              <span>Panels</span>
                              <Input
                                type="color"
                                value={adminThemePanel}
                                onChange={(event) => setAdminThemePanel(event.target.value)}
                                aria-label="Theme panel color"
                                className="h-9 p-1"
                              />
                            </label>
                            <label className="block space-y-1 text-xs">
                              <span>Accents</span>
                              <Input
                                type="color"
                                value={adminThemeAccent}
                                onChange={(event) => setAdminThemeAccent(event.target.value)}
                                aria-label="Theme accent color"
                                className="h-9 p-1"
                              />
                            </label>
                          </div>
                          <div className="space-y-1">
                            <div className="flex gap-2">
                              <Input
                                type="url"
                                value={adminThemeBackgroundUrl}
                                onChange={(event) => {
                                  setAdminThemeBackgroundUrl(event.target.value)
                                  if (event.target.value) {
                                    setAdminThemeBackgroundFile(null)
                                    if (adminThemeBackgroundInputRef.current) {
                                      adminThemeBackgroundInputRef.current.value = ""
                                    }
                                  }
                                }}
                                placeholder="URL..."
                                className="h-7 flex-1 sm:h-8"
                                aria-label="Theme background image URL"
                              />
                              <div className="relative">
                                <Input
                                  type="file"
                                  accept=".jpg,.jpeg,.png,.gif,image/jpeg,image/png,image/gif"
                                  ref={adminThemeBackgroundInputRef}
                                  onChange={(event) => {
                                    const file = event.target.files?.[0] ?? null
                                    event.currentTarget.value = ""
                                    setAdminThemeBackgroundFile(file)
                                    if (file) setAdminThemeBackgroundUrl("")
                                  }}
                                  className="hidden"
                                  id="admin-theme-background-file"
                                  aria-label="Theme background image file"
                                />
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="icon"
                                  className="h-7 w-7 bg-transparent sm:h-8 sm:w-8"
                                  asChild
                                >
                                  <label htmlFor="admin-theme-background-file" className="flex cursor-pointer items-center justify-center">
                                    <Upload className="h-3 w-3" />
                                  </label>
                                </Button>
                              </div>
                            </div>
                            {adminThemeBackgroundFile && (
                              <div className="flex min-w-0 items-center gap-2 text-xs">
                                <p className="min-w-0 flex-1 truncate text-muted-foreground">{adminThemeBackgroundFile.name}</p>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="h-7 shrink-0 px-2 sm:h-8"
                                  onClick={() => {
                                    setAdminThemeBackgroundFile(null)
                                    if (adminThemeBackgroundInputRef.current) {
                                      adminThemeBackgroundInputRef.current.value = ""
                                    }
                                    clearAdminThemePreview()
                                  }}
                                >
                                  Clear file
                                </Button>
                              </div>
                            )}
                          </div>
                          {(adminThemeBackgroundFile || adminThemeBackgroundUrl.trim()) && (
                            <Button
                              type="button"
                              variant="outline"
                              className="w-full"
                              onClick={() => {
                                setAdminThemeBackgroundFile(null)
                                setAdminThemeBackgroundUrl("")
                                if (adminThemeBackgroundInputRef.current) {
                                  adminThemeBackgroundInputRef.current.value = ""
                                }
                                clearAdminThemePreview()
                              }}
                            >
                              Remove background
                            </Button>
                          )}
                          {(adminThemeBackgroundFile || adminThemeBackgroundUrl.trim()) && (
                            <Input
                              type="number"
                              min={0}
                              max={1}
                              step={0.05}
                              value={adminThemeBackgroundOpacity}
                              onChange={(event) => setAdminThemeBackgroundOpacity(event.target.value)}
                              placeholder="0.2"
                              aria-label="Theme background opacity"
                            />
                          )}
                          <Input
                            type="number"
                            min={-1}
                            step={1}
                            value={adminThemePrice}
                            onChange={(event) => setAdminThemePrice(event.target.value)}
                            placeholder={String(pointPricing?.catalog.theme.default ?? 10_000)}
                            aria-label="Theme price"
                          />
                          <div className="space-y-2 pt-2">
                            <div className="grid grid-cols-2 gap-2">
                              <Button type="button" variant="outline" className="w-full" onClick={() => void previewAdminTheme()}>
                                Preview
                              </Button>
                              <Button type="button" variant="outline" className="w-full" onClick={clearAdminThemePreview}>
                                Clear
                              </Button>
                            </div>
                            <Button type="submit" className="w-full" disabled={adminThemeSaving}>
                              {adminThemeSaving ? "Uploading..." : "Upload theme"}
                            </Button>
                          </div>
                          {adminThemeCreateError && <p role="alert" className="text-xs text-destructive">{adminThemeCreateError}</p>}
                          {adminThemeCreateNotice && <p role="status" className="text-xs text-muted-foreground">{adminThemeCreateNotice}</p>}
                        </form>
                      </details>
                      <section className="space-y-2 rounded-md border p-3">
                        <h3 className="text-sm font-semibold">Manage existing themes</h3>
                        <form
                          className="flex gap-2"
                          onSubmit={(event) => {
                            event.preventDefault()
                            const match = adminThemes.find((themeOption) =>
                              themeOption.name.trim().toLocaleLowerCase() === adminThemeLookup.trim().toLocaleLowerCase(),
                            )
                            setSelectedAdminThemeId(match?.asset_id ?? null)
                            setAdminThemeManageError(match ? "" : "No theme found with that name.")
                            if (match) {
                              setAdminThemeDrafts((current) => ({
                                ...current,
                                [match.asset_id]: {
                                  name: match.name,
                                  primary_color: match.primary_color,
                                  panel_color: match.panel_color,
                                  accent_color: match.accent_color,
                                  price: match.price_overridden ? String(match.price) : "",
                                  background_url: "",
                                  background_opacity: String(match.background_opacity),
                                  background_file: null,
                                  remove_background: false,
                                },
                              }))
                            }
                          }}
                        >
                          <div className="min-w-0 flex-1">
                            <Input
                              value={adminThemeLookup}
                              onChange={(event) => {
                                setAdminThemeLookup(event.target.value)
                                setSelectedAdminThemeId(null)
                              }}
                              placeholder="Theme name"
                              aria-label="Find theme by name"
                            />
                          </div>
                          <Button type="submit">Load</Button>
                        </form>
                        {selectedAdminThemeId && !adminThemes.find((item) => item.asset_id === selectedAdminThemeId) && (
                          <p className="text-xs text-muted-foreground">No themes available.</p>
                        )}
                        {selectedAdminThemeId && adminThemeDrafts[selectedAdminThemeId] && (() => {
                          const themeOption = adminThemes.find((item) => item.asset_id === selectedAdminThemeId)
                          const draft = adminThemeDrafts[selectedAdminThemeId]
                          if (!themeOption) return null
                          return (
                            <form
                              className="space-y-2 border-t pt-3"
                              onSubmit={(event) => {
                                event.preventDefault()
                                void saveAdminTheme(themeOption)
                              }}
                            >
                              <div className="flex items-center gap-2">
                                {renderThemeSwatch(themeOption, "h-8 w-8", "rounded-sm border")}
                                <span className="min-w-0 flex-1 truncate text-xs">{themeOption.name}</span>
                              </div>
                              <Input
                                value={draft.name}
                                onChange={(event) => setAdminThemeDrafts((current) => ({
                                  ...current,
                                  [themeOption.asset_id]: { ...draft, name: event.target.value },
                                }))}
                                maxLength={80}
                                placeholder="Theme Name"
                                required
                                aria-label="Edit theme name"
                              />
                              <div className="grid grid-cols-3 gap-2">
                                <label className="block space-y-1 text-xs">
                                  <span>Background</span>
                                  <Input
                                    type="color"
                                    value={draft.primary_color}
                                    onChange={(event) => setAdminThemeDrafts((current) => ({
                                      ...current,
                                      [themeOption.asset_id]: { ...draft, primary_color: event.target.value },
                                    }))}
                                    aria-label="Edit theme background color"
                                    className="h-9 p-1"
                                  />
                                </label>
                                <label className="block space-y-1 text-xs">
                                  <span>Panels</span>
                                  <Input
                                    type="color"
                                    value={draft.panel_color}
                                    onChange={(event) => setAdminThemeDrafts((current) => ({
                                      ...current,
                                      [themeOption.asset_id]: { ...draft, panel_color: event.target.value },
                                    }))}
                                    aria-label="Edit theme panel color"
                                    className="h-9 p-1"
                                  />
                                </label>
                                <label className="block space-y-1 text-xs">
                                  <span>Accents</span>
                                  <Input
                                    type="color"
                                    value={draft.accent_color}
                                    onChange={(event) => setAdminThemeDrafts((current) => ({
                                      ...current,
                                      [themeOption.asset_id]: { ...draft, accent_color: event.target.value },
                                    }))}
                                    aria-label="Edit theme accent color"
                                    className="h-9 p-1"
                                  />
                                </label>
                              </div>
                              {!themeOption.is_standard && (
                                <Input
                                  type="number"
                                  min={-1}
                                  step={1}
                                  value={draft.price}
                                  placeholder={String(pointPricing?.catalog.theme.default ?? 10_000)}
                                  onChange={(event) => setAdminThemeDrafts((current) => ({
                                    ...current,
                                    [themeOption.asset_id]: { ...draft, price: event.target.value },
                                  }))}
                                  aria-label="Edit theme price"
                                />
                              )}
                              <div className="space-y-1">
                                <div className="flex gap-2">
                                  <Input
                                    type="url"
                                    value={draft.background_url}
                                    onChange={(event) => setAdminThemeDrafts((current) => ({
                                      ...current,
                                      [themeOption.asset_id]: {
                                        ...draft,
                                        background_url: event.target.value,
                                        ...(event.target.value ? { background_file: null } : {}),
                                        ...(event.target.value ? { remove_background: false } : {}),
                                      },
                                    }))}
                                    placeholder="URL..."
                                    className="h-7 flex-1 sm:h-8"
                                    aria-label="Edit theme background URL"
                                  />
                                  <div className="relative">
                                    <Input
                                      type="file"
                                      accept=".jpg,.jpeg,.png,.gif,image/jpeg,image/png,image/gif"
                                      onChange={(event) => {
                                        const file = event.target.files?.[0] ?? null
                                        event.currentTarget.value = ""
                                        setAdminThemeDrafts((current) => ({
                                          ...current,
                                          [themeOption.asset_id]: {
                                            ...draft,
                                            background_file: file,
                                            ...(file ? { background_url: "" } : {}),
                                            ...(file ? { remove_background: false } : {}),
                                          },
                                        }))
                                      }}
                                      className="hidden"
                                      id={`admin-theme-background-file-${themeOption.asset_id}`}
                                      aria-label="Edit theme background upload"
                                    />
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="icon"
                                      className="h-7 w-7 bg-transparent sm:h-8 sm:w-8"
                                      asChild
                                    >
                                      <label
                                        htmlFor={`admin-theme-background-file-${themeOption.asset_id}`}
                                        className="flex cursor-pointer items-center justify-center"
                                      >
                                        <Upload className="h-3 w-3" />
                                      </label>
                                    </Button>
                                  </div>
                                </div>
                                {draft.background_file && (
                                  <div className="flex min-w-0 items-center gap-2 text-xs">
                                    <p className="min-w-0 flex-1 truncate text-muted-foreground">{draft.background_file.name}</p>
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      className="h-7 shrink-0 px-2 sm:h-8"
                                      onClick={() => setAdminThemeDrafts((current) => ({
                                        ...current,
                                        [themeOption.asset_id]: { ...draft, background_file: null },
                                      }))}
                                    >
                                      Clear file
                                    </Button>
                                  </div>
                                )}
                              </div>
                              {themeOption.background_image_exists && (
                                <label className="flex items-center gap-2 text-xs">
                                  <input
                                    type="checkbox"
                                    checked={draft.remove_background}
                                    onChange={(event) => setAdminThemeDrafts((current) => ({
                                      ...current,
                                      [themeOption.asset_id]: { ...draft, remove_background: event.target.checked },
                                    }))}
                                  />
                                  Remove background
                                </label>
                              )}
                              {(themeOption.background_image_exists || draft.background_file || draft.background_url.trim()) && (
                                <Input
                                  type="number"
                                  min={0}
                                  max={1}
                                  step={0.05}
                                  value={draft.background_opacity}
                                  onChange={(event) => setAdminThemeDrafts((current) => ({
                                    ...current,
                                    [themeOption.asset_id]: { ...draft, background_opacity: event.target.value },
                                  }))}
                                  aria-label="Edit theme background opacity"
                                />
                              )}
                              <div className="space-y-2 pt-2">
                                <div className="grid grid-cols-2 gap-2">
                                  <Button
                                    type="button"
                                    variant="outline"
                                    className="w-full"
                                    onClick={() => void previewManagedAdminTheme(themeOption, draft)}
                                  >
                                    Preview
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    className="w-full"
                                    onClick={clearAdminThemePreview}
                                  >
                                    Clear
                                  </Button>
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                  <Button
                                    type="button"
                                    variant="outline"
                                    className="w-full"
                                    disabled={adminThemeSaving}
                                    onClick={() => void saveAdminTheme(themeOption)}
                                  >
                                    {adminThemeSaving ? "Saving..." : "Save changes"}
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="destructive"
                                    className="w-full"
                                    disabled={adminThemeSaving}
                                    onClick={() => void removeAdminTheme(themeOption)}
                                  >
                                    Remove
                                  </Button>
                                </div>
                              </div>
                            </form>
                          )
                        })()}
                        {adminThemeManageError && <p role="alert" className="text-sm text-destructive">{adminThemeManageError}</p>}
                        {adminThemeManageNotice && <p role="status" className="text-sm text-muted-foreground">{adminThemeManageNotice}</p>}
                      </section>
                    </TabsContent>
                  )}
                  {permission("admin_console") && (
                    <TabsContent value="badges" className="mt-0 space-y-4 lg:flex-1 lg:min-h-0 lg:overflow-y-auto lg:pr-3">
                      <details className="rounded-md border">
                        <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">Upload badge</summary>
                        <form className="space-y-2 px-3 pb-3" onSubmit={(event) => void createAdminBadge(event)}>
                          <Input
                            value={adminBadgeName}
                            onChange={(event) => setAdminBadgeName(event.target.value)}
                            maxLength={120}
                            placeholder="Badge Name"
                            aria-label="Badge name"
                            required
                          />
                          <div className="space-y-1">
                            <div className="flex gap-2">
                              <Input
                                type="url"
                                value={adminBadgeUrl}
                                onChange={(event) => {
                                  setAdminBadgeUrl(event.target.value)
                                  if (event.target.value) setAdminBadgeFile(null)
                                }}
                                placeholder="URL..."
                                className="h-7 flex-1 sm:h-8"
                                aria-label="Badge image URL"
                              />
                              <div className="relative">
                                <Input
                                  type="file"
                                  accept=".jpg,.jpeg,.png,.gif,image/jpeg,image/png,image/gif"
                                  onChange={(event) => {
                                    const file = event.target.files?.[0] ?? null
                                    event.currentTarget.value = ""
                                    setAdminBadgeFile(file)
                                    if (file) setAdminBadgeUrl("")
                                  }}
                                  className="hidden"
                                  id="admin-badge-file"
                                  aria-label="Badge image file"
                                />
                                <Button type="button" variant="outline" size="icon" className="h-7 w-7 bg-transparent sm:h-8 sm:w-8" asChild>
                                  <label htmlFor="admin-badge-file" className="flex cursor-pointer items-center justify-center">
                                    <Upload className="h-3 w-3" />
                                  </label>
                                </Button>
                              </div>
                            </div>
                            {adminBadgeFile && (
                              <div className="flex min-w-0 items-center gap-2 text-xs">
                                <p className="min-w-0 flex-1 truncate text-muted-foreground">{adminBadgeFile.name}</p>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="h-7 shrink-0 px-2 sm:h-8"
                                  onClick={() => setAdminBadgeFile(null)}
                                >
                                  Clear file
                                </Button>
                              </div>
                            )}
                          </div>
                          <Button type="submit" className="w-full" disabled={adminBadgeSaving}>
                            {adminBadgeSaving ? "Uploading…" : "Upload badge"}
                          </Button>
                        </form>
                      </details>

                      <section className="space-y-2 rounded-md border p-3">
                        <h3 className="text-sm font-semibold">Manage existing badges</h3>
                        {adminBadgeError && <p role="alert" className="text-sm text-destructive">{adminBadgeError}</p>}
                        {adminBadgeNotice && <p role="status" className="text-sm text-muted-foreground">{adminBadgeNotice}</p>}
                        <form
                          className="flex gap-2"
                          onSubmit={(event) => {
                            event.preventDefault()
                            const match = adminBadges.find((badge) =>
                              badge.name.trim().toLocaleLowerCase() === adminBadgeLookup.trim().toLocaleLowerCase(),
                            )
                            setSelectedAdminBadgeId(match?.asset_id ?? null)
                            setAdminBadgeError(match ? "" : "No badge found with that name.")
                          }}
                        >
                          <Input
                            value={adminBadgeLookup}
                            onChange={(event) => {
                              setAdminBadgeLookup(event.target.value)
                              setSelectedAdminBadgeId(null)
                            }}
                            placeholder="Badge Name"
                            aria-label="Find badge by name"
                          />
                          <Button type="submit">Load</Button>
                        </form>
                        {!adminBadges.length && <p className="text-xs text-muted-foreground">No badges have been created.</p>}
                      </section>
                      {selectedAdminBadgeId && adminBadges.filter((badge) => badge.asset_id === selectedAdminBadgeId).map((badge) => (
                        <section key={badge.asset_id} className="space-y-2 rounded-md border p-3">
                          <div className="flex items-center gap-2">
                            <img src={badge.url} alt="" className="h-8 w-8 object-contain" />
                            <Input
                              value={adminBadgeDrafts[badge.asset_id]?.name ?? badge.name}
                              onChange={(event) => setAdminBadgeDrafts((current) => ({
                                ...current,
                                [badge.asset_id]: { name: event.target.value },
                              }))}
                              maxLength={120}
                              placeholder="Badge Name"
                              aria-label={`Edit ${badge.name} badge name`}
                            />
                          </div>
                          <div className="space-y-1">
                            <div className="flex gap-2">
                              <Input
                                type="url"
                                value={adminBadgeReplacementUrls[badge.asset_id] ?? ""}
                                onChange={(event) => {
                                  setAdminBadgeReplacementUrls((current) => ({ ...current, [badge.asset_id]: event.target.value }))
                                  if (event.target.value) setAdminBadgeReplacementFiles((current) => ({ ...current, [badge.asset_id]: null }))
                                }}
                                placeholder="URL..."
                                className="h-7 flex-1 sm:h-8"
                                aria-label={`Replace ${badge.name} image URL`}
                              />
                              <div className="relative">
                                <Input
                                  type="file"
                                  accept=".jpg,.jpeg,.png,.gif,image/jpeg,image/png,image/gif"
                                  onChange={(event) => {
                                    const file = event.target.files?.[0] ?? null
                                    event.currentTarget.value = ""
                                    setAdminBadgeReplacementFiles((current) => ({ ...current, [badge.asset_id]: file }))
                                    if (file) setAdminBadgeReplacementUrls((current) => ({ ...current, [badge.asset_id]: "" }))
                                  }}
                                  className="hidden"
                                  id={`admin-badge-replacement-${badge.asset_id}`}
                                  aria-label={`Replace ${badge.name} image file`}
                                />
                                <Button type="button" variant="outline" size="icon" className="h-7 w-7 bg-transparent sm:h-8 sm:w-8" asChild>
                                  <label htmlFor={`admin-badge-replacement-${badge.asset_id}`} className="flex cursor-pointer items-center justify-center">
                                    <Upload className="h-3 w-3" />
                                  </label>
                                </Button>
                              </div>
                            </div>
                            {adminBadgeReplacementFiles[badge.asset_id] && (
                              <div className="flex min-w-0 items-center gap-2 text-xs">
                                <p className="min-w-0 flex-1 truncate text-muted-foreground">
                                  {adminBadgeReplacementFiles[badge.asset_id]?.name}
                                </p>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="h-7 shrink-0 px-2 sm:h-8"
                                  onClick={() => setAdminBadgeReplacementFiles((current) => ({
                                    ...current,
                                    [badge.asset_id]: null,
                                  }))}
                                >
                                  Clear file
                                </Button>
                              </div>
                            )}
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <Button type="button" variant="outline" disabled={adminBadgeSaving} onClick={() => void saveAdminBadge(badge)}>
                              Save changes
                            </Button>
                            <Button
                              type="button"
                              variant="destructive"
                              disabled={adminBadgeSaving}
                              onClick={() => void removeAdminBadge(badge)}
                            >
                              Remove
                            </Button>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            className="w-full"
                            disabled={adminBadgeGranting}
                            onClick={() => void grantBadgeOnline(badge)}
                          >
                            {adminBadgeGranting ? "Granting…" : "Grant to currently online users"}
                          </Button>
                        </section>
                      ))}
                    </TabsContent>
                  )}
                </Tabs>
              </CardContent>
            </Card>
          </div>
          )}

          {username && !isAdmin && (
            <div className="relative z-10 order-4 md:order-4 lg:order-2">
              <Card className="card-hover flex flex-col h-auto max-h-[80dvh] overflow-hidden lg:h-[calc(100dvh_-_18rem)] lg:max-h-none lg:overflow-visible lg:!transition-[transform,box-shadow]">
                <CardHeader className="pb-2 sm:pb-3 flex-shrink-0">
                  <CardTitle className="text-base sm:text-lg">Point Shop</CardTitle>
                  <CardDescription className="text-xs">Preview and unlock sounds and emojis</CardDescription>
                </CardHeader>
                <CardContent className="min-h-0 flex-1 overflow-hidden p-3 sm:p-6">
                  <Tabs
                    value={shopCategory}
                    onValueChange={(value) => setShopCategory(value as ShopCategory)}
                    className="flex h-full flex-col"
                  >
                    <TabsList data-columns="4" className="joined-tabs grid w-full grid-cols-4 mb-3 h-8 sm:h-10 flex-shrink-0">
                      <TabsTrigger value="emoji" className="gap-1 text-[10px] sm:text-xs px-1">
                        <Smile className="h-3 w-3" /> Emojis
                      </TabsTrigger>
                      <TabsTrigger value="sound" className="gap-1 text-[10px] sm:text-xs px-1">
                        <Volume2 className="h-3 w-3" /> Sounds
                      </TabsTrigger>
                      <TabsTrigger value="theme" className="gap-1 text-[10px] sm:text-xs px-1">
                        <Palette className="h-3 w-3" /> Themes
                      </TabsTrigger>
                      <TabsTrigger value="add" className="gap-1 text-[10px] sm:text-xs px-1">
                        <Upload className="h-3 w-3" /> Add
                      </TabsTrigger>
                    </TabsList>
                    {(["emoji", "sound", "theme", "add"] as const).map((category) => (
                      <TabsContent
                        key={category}
                        value={category}
                        className="mt-0 min-h-0 flex-1 overflow-hidden"
                      >
                        {category === "add" ? (
                          <ScrollArea className="h-full pr-2">
                            <div className="space-y-4">
                              {(["emoji", "sound"] as const).map((assetType) => {
                                const draft = proposalDrafts[assetType]
                                const prices = shopProposalPrices?.[assetType]
                                const normalizedName = draft.name.toLowerCase().replace(/[^a-z0-9]/g, "")
                                const regularPrice = prices
                                  ? prices.items[normalizedName] ?? prices.default
                                  : null
                                const submissionPrice = prices
                                  ? draft.exclusive ? prices.exclusive : regularPrice
                                  : null
                                const title = assetType === "emoji" ? "Upload emoji" : "Upload sound"
                                const submitLabel = assetType === "emoji" ? "Add emoji" : "Add sound"
                                const submitText = submissionPrice === null
                                  ? submitLabel
                                  : submissionPrice === -1
                                    ? `${submitLabel} · Unavailable`
                                    : `${submitLabel} · ${submissionPrice}❖`
                                return (
                                  <form
                                    key={assetType}
                                    data-chaos-control-sizing
                                    className="space-y-2 rounded-md border p-3"
                                    autoComplete="off"
                                    onSubmit={(event) => void submitAssetProposal(event, assetType)}
                                  >
                                    <h3 className="text-sm font-semibold">{title}</h3>
                                    <Input
                                      value={draft.name}
                                      onChange={(event) => setProposalDrafts((current) => ({
                                        ...current,
                                        [assetType]: { ...current[assetType], name: event.target.value },
                                      }))}
                                      maxLength={120}
                                      placeholder={assetType === "emoji" ? "emojiname" : "Sound Name"}
                                      aria-label={assetType === "emoji" ? "Emoji name" : "Sound name"}
                                      required
                                    />
                                    {assetType === "sound" && (
                                      <Input
                                        type="text"
                                        inputMode="decimal"
                                        value={draft.loudness}
                                        onChange={(event) => setProposalDrafts((current) => ({
                                          ...current,
                                          sound: { ...current.sound, loudness: event.target.value },
                                        }))}
                                        placeholder="1.00"
                                        aria-label="New sound loudness"
                                      />
                                    )}
                                    <div className="space-y-1">
                                      <div className="flex gap-2">
                                        <Input
                                          type="url"
                                          value={draft.sourceUrl}
                                          placeholder="URL..."
                                          onChange={(event) => {
                                            setProposalDrafts((current) => ({
                                              ...current,
                                              [assetType]: { ...current[assetType], sourceUrl: event.target.value },
                                            }))
                                            if (event.target.value) {
                                              setProposalFiles((current) => ({ ...current, [assetType]: null }))
                                            }
                                          }}
                                          className="h-7 flex-1 sm:h-8"
                                          aria-label={`${assetType === "sound" ? "Sound" : "Emoji"} file URL`}
                                        />
                                        <div className="relative">
                                          <Input
                                            type="file"
                                            accept={assetType === "sound" ? ".mp3,audio/mpeg" : ".jpg,.jpeg,.png,.gif,image/jpeg,image/png,image/gif"}
                                            onChange={(event) => {
                                              const file = event.target.files?.[0] ?? null
                                              event.currentTarget.value = ""
                                              setProposalFiles((current) => ({ ...current, [assetType]: file }))
                                              if (file) {
                                                setProposalDrafts((current) => ({
                                                  ...current,
                                                  [assetType]: { ...current[assetType], sourceUrl: "" },
                                                }))
                                              }
                                            }}
                                            className="hidden"
                                            id={`proposal-${assetType}-file`}
                                            aria-label={`${assetType === "sound" ? "Sound" : "Emoji"} file to upload`}
                                          />
                                          <Button
                                            type="button"
                                            variant="outline"
                                            size="icon"
                                            className="h-7 w-7 bg-transparent sm:h-8 sm:w-8"
                                            asChild
                                          >
                                            <label htmlFor={`proposal-${assetType}-file`} className="flex cursor-pointer items-center justify-center">
                                              <Upload className="h-3 w-3" />
                                            </label>
                                          </Button>
                                        </div>
                                      </div>
                                      {proposalFiles[assetType] && (
                                        <div className="flex min-w-0 items-center gap-2 text-xs">
                                          <p className="min-w-0 flex-1 truncate text-muted-foreground">{proposalFiles[assetType]?.name}</p>
                                          <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            className="h-7 shrink-0 px-2 sm:h-8"
                                            onClick={() => setProposalFiles((current) => ({
                                              ...current,
                                              [assetType]: null,
                                            }))}
                                          >
                                            Clear file
                                          </Button>
                                        </div>
                                      )}
                                    </div>
                                    <label className="flex items-center gap-2 text-xs">
                                      <input
                                        type="checkbox"
                                        checked={draft.exclusive}
                                        onChange={(event) => setProposalDrafts((current) => ({
                                          ...current,
                                          [assetType]: { ...current[assetType], exclusive: event.target.checked },
                                        }))}
                                      />
                                      Exclusive
                                    </label>
                                    <Button
                                      type="submit"
                                      disabled={proposalSaving !== null || submissionPrice === null || submissionPrice === -1}
                                      className="mt-3 h-7 w-full text-xs disabled:grayscale sm:h-8 sm:text-sm"
                                    >
                                      {proposalSaving === assetType ? "Adding..." : submitText}
                                    </Button>
                                  </form>
                                )
                              })}
                            </div>
                          </ScrollArea>
                        ) : (
                          <div className="flex h-full flex-col gap-2">
                            <Input
                              value={
                                category === "emoji"
                                  ? emojiShopSearch
                                  : category === "sound"
                                    ? soundShopSearch
                                    : themeShopSearch
                              }
                              onChange={(event) => {
                                if (category === "emoji") setEmojiShopSearch(event.target.value)
                                else if (category === "sound") setSoundShopSearch(event.target.value)
                                else setThemeShopSearch(event.target.value)
                              }}
                              placeholder={`Search ${category === "theme" ? "themes" : category === "sound" ? "sounds" : "emojis"}...`}
                              aria-label={`Search shop ${category === "theme" ? "themes" : category === "sound" ? "sounds" : "emojis"}`}
                              className="h-7 flex-shrink-0 text-xs sm:h-8 sm:text-sm"
                            />
                            <ScrollArea className="min-h-0 flex-1 pr-2">
                              {shopLoading && (
                                <p role="status" className="py-4 text-center text-xs text-muted-foreground">
                                  Loading shop items...
                                </p>
                              )}
                              {!shopLoading && filteredShopAssets(category).length === 0 && (
                                <p className="py-4 text-center text-xs text-muted-foreground">
                                  {shopAssets[category].length === 0
                                    ? `No ${category === "theme" ? "themes" : category === "sound" ? "sounds" : "emojis"} available.`
                                    : `No ${category === "theme" ? "themes" : category === "sound" ? "sounds" : "emojis"} match your search.`}
                                </p>
                              )}
                              <div className="space-y-2" data-testid={`shop-${category}-items`}>
                                {filteredShopAssets(category).map((asset) => {
                                  const themeOption = category === "theme"
                                    ? shopAssets.theme.find((option) => option.asset_id === asset.asset_id)
                                    : undefined
                                  return (
                                    <div
                                      key={asset.asset_id}
                                      className="flex items-center gap-2 rounded-md border p-2"
                                    >
                                      {category === "emoji" ? (
                                        <img
                                          src={asset.url}
                                          alt={asset.name}
                                          className="h-8 w-8 flex-shrink-0 object-contain"
                                        />
                                      ) : themeOption ? (
                                        <Button
                                          type="button"
                                          size="icon"
                                          variant="ghost"
                                          aria-label={`Preview ${themeOption.name} theme`}
                                          onClick={() => {
                                            clearAdminThemePreview()
                                            setShopThemePreview({ ...themeOption })
                                          }}
                                          className="h-8 w-8 flex-shrink-0 p-0"
                                        >
                                          {renderThemeSwatch(themeOption, "h-8 w-8", "rounded-sm border")}
                                        </Button>
                                      ) : (
                                        <Button
                                          type="button"
                                          size="icon"
                                          variant="outline"
                                          aria-label={`Preview ${asset.title || asset.name}`}
                                          onClick={() => previewShopSound(asset)}
                                          className="h-8 w-8 flex-shrink-0"
                                        >
                                          <Volume2 className="h-3 w-3" />
                                        </Button>
                                      )}
                                      <div className="min-w-0 flex-1">
                                        <p className="truncate text-xs font-medium">
                                          {asset.title || asset.name}
                                        </p>
                                        <p className="text-[10px] text-muted-foreground">
                                          {asset.status === "owned"
                                            ? "Owned"
                                            : asset.status === "unavailable"
                                              ? "Unavailable"
                                              : `${asset.price}❖`}
                                        </p>
                                      </div>
                                      {asset.status === "available" && (
                                        <Button
                                          type="button"
                                          size="sm"
                                          disabled={
                                            purchasingAssetId === asset.asset_id
                                            || currentPoints === null
                                            || currentPoints < asset.price
                                          }
                                          onClick={() => void purchaseShopAsset(category, asset)}
                                          className="h-7 px-2 text-[10px] sm:text-xs"
                                        >
                                          {purchasingAssetId === asset.asset_id ? "Buying..." : "Buy"}
                                        </Button>
                                      )}
                                    </div>
                                  )
                                })}
                              </div>
                            </ScrollArea>
                          </div>
                        )}
                      </TabsContent>
                    ))}
                  </Tabs>
                  {shopError && <p role="alert" className="mt-2 text-xs text-destructive">{shopError}</p>}
                  {shopNotice && <p role="status" className="mt-2 text-xs text-muted-foreground">{shopNotice}</p>}
                </CardContent>
              </Card>
            </div>
          )}

          {/* --- Right Column: Chat + Online Users --- */}
          <div data-chat-panel className="relative z-10 order-2 md:order-2 lg:order-4 flex flex-col gap-3 sm:gap-4 lg:h-[calc(100dvh_-_18rem)]">
            <Card data-chat-card className="card-hover flex max-h-[80dvh] flex-col overflow-hidden lg:flex-1 lg:min-h-0 lg:max-h-none lg:!transition-[transform,box-shadow]">
              <CardHeader className="flex flex-row items-center justify-between pb-1 sm:pb-2 flex-shrink-0">
                <CardTitle className={`flex items-center gap-2 ${isChatOnly ? "text-lg" : "text-base sm:text-lg"}`}>
                  <MessageSquare className="h-3 w-3 sm:h-4 sm:w-4 text-primary" /> Chat
                </CardTitle>
                <div className="flex items-center gap-2">
                  {!isChatOnly && (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label="Open chat in a separate window"
                      title="Open chat in a separate window"
                      onClick={openChatWindow}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  <span className="flex items-center gap-2 text-xs text-muted-foreground" title={isStreaming ? "Streaming on" : "Streaming off"}>
                    <span className={`h-2.5 w-2.5 rounded-full ${isStreaming ? "bg-green-500 shadow-[0_0_8px_2px_rgba(34,197,94,0.75)]" : "bg-red-500"}`} />
                    <span className="sr-only">{isStreaming ? "Streaming on" : "Streaming off"}</span>
                  </span>
                </div>
              </CardHeader>
              <CardContent className="flex min-h-0 flex-1 flex-col space-y-2 overflow-hidden p-3 sm:p-4 lg:max-h-full">
                {chatPopoutBlocked && !isChatOnly && (
                  <p role="status" className="text-xs text-muted-foreground">
                    Pop-up blocked. <a href="/chat" className="underline">Open chat page</a>
                  </p>
                )}
                <div
			  className="min-h-0 flex-1 overflow-y-auto pr-2"
			  ref={chatBoxRef}
			  style={{ display: "flex", flexDirection: "column" }}
			>
			  <div className="space-y-1.5 sm:space-y-2">
				{Array.isArray(chatMessages) && chatMessages.length > 0 ? (
				  [...chatMessages].map((msg, idx) => {
					if (msg.system) {
					  return (
						<div
						  key={msg.id || idx}
						  className={`rounded px-1 py-0.5 leading-tight sm:px-1.5 sm:py-0.5 ${isChatOnly ? "text-[13px]" : "text-[10px] sm:text-[13px]"}`}
						  style={{
                backgroundColor: "var(--chat-system-message-background)",
                color: "var(--chat-system-message-foreground)",
              }}
						>
						  {msg.actor && <span>{msg.actor}: </span>}
						  <span className="break-words">{msg.message}</span>
						</div>
					  )
					}

					const isMentioned = new RegExp(`@${username}\\b`, "i").test(msg.message)

					return (
					  <div
						key={idx} // Add stable key
						className={`group ${isChatOnly ? "text-sm" : "text-[11px] sm:text-sm"} p-1.5 sm:p-2 rounded flex items-start justify-between gap-2 ${
						  isMentioned ? "mention-highlight-self" : ""
						}`}
					  >
						<div className="flex-1 min-w-0 break-words">
						  <span
                className="relative"
                onMouseEnter={() => setHoveredChatMessage(idx)}
                onMouseLeave={() => setHoveredChatMessage(null)}
              >
                <span style={{ color: msg.rank_color ?? undefined }} className="font-semibold">
                  {msg.user}
                </span>
                {msg.badge && (
                  <img
                    src={msg.badge.url}
                    alt=""
                    title={msg.badge.name}
                    className="mx-0.5 inline-block h-3.5 w-3.5 align-[-2px] object-contain"
                  />
                )}
                <span>:</span>
                <span className={`absolute bottom-full left-0 z-20 inline-flex items-baseline gap-1 whitespace-nowrap ${hoveredChatMessage === idx ? "pointer-events-auto" : "pointer-events-none"}`}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={`h-5 px-1 py-0 text-[10px] transition-opacity ${hoveredChatMessage === idx ? "opacity-100" : "opacity-0"} focus-visible:opacity-100`}
                    onClick={() => handleUsernameClick(msg.user)}
                  >
                    Reply
                  </Button>
                  {canInspectUsers && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={`h-5 px-1 py-0 text-[10px] transition-opacity ${hoveredChatMessage === idx ? "opacity-100" : "opacity-0"} focus-visible:opacity-100`}
                      onClick={() => inspectChatUser(msg.user)}
                    >
                      Inspect
                    </Button>
                  )}
                </span>
              </span>{" "}
						  <span className="break-words" style={{ color: "var(--card-foreground)" }}>
                {renderMessageWithEmojis(msg.message, msg.literal_emojis, msg.user)}
              </span>
						</div>

            {msg.id && (
						  <Button
							variant="ghost"
							size="icon"
							className="h-4 w-4 sm:h-5 sm:w-5 flex-shrink-0 opacity-0 group-hover:opacity-100 hover:text-red-500 transition-opacity"
							onClick={() => deleteMessage(msg.id!)}
						  >
							<Trash2 className="h-2.5 w-2.5 sm:h-3 sm:w-3" />
						  </Button>
						)}
					  </div>
					)
				  })
				) : (
				  <div className="text-center text-muted-foreground text-[10px] sm:text-xs py-4 sm:py-8 flex-1 flex items-center justify-center">
					No messages yet. Start the conversation!
				  </div>
				)}
			  </div>
			</div>

                <fieldset
                  disabled={isChatRestricted}
                  className={`flex flex-col gap-2 border-0 p-0 ${isChatRestricted ? "opacity-50 grayscale pointer-events-none" : ""}`}
                >
                  <div className="relative">
                    <Card
                      aria-hidden={!showEmojiPanel}
                      inert={!showEmojiPanel}
                      className={`absolute bottom-full left-0 right-0 z-10 mb-2 gap-0 py-1 origin-bottom transition-all duration-200 ease-out motion-reduce:transition-none ${
                        showEmojiPanel
                          ? "visible translate-y-0 opacity-100"
                          : "invisible translate-y-2 opacity-0"
                      }`}
                    >
                        <CardContent className="p-2">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-medium">Emojis (A-Z)</span>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setShowEmojiPanel(false)}
                              className="h-6 w-6 p-0"
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                          {assetLoadError && <p role="alert" className="mb-2 text-xs text-destructive">{assetLoadError}</p>}
<div className="max-h-[108px] overflow-y-auto pr-2 sm:max-h-[116px]">
  {assetListsLoading ? (
    <p role="status" className="py-2 text-xs text-muted-foreground">Loading usable emojis...</p>
  ) : usableEmojis.length > 0 ? (
    <div
      aria-label="Usable emojis"
      data-testid="usable-emoji-picker"
      className="flex flex-wrap items-start gap-0.5 sm:gap-1 emoji-panel"
    >
      {usableEmojis.map((emoji) => (
        <button
          key={emoji.asset_id}
          type="button"
          onClick={() => insertEmoji(emoji.name)}
          className="p-0 m-0 flex items-center justify-center"
          title={emoji.name}
        >
          <img src={emoji.url} alt={emoji.name} className="h-5 w-5" />
        </button>
      ))}
    </div>
  ) : (
    <p className="py-2 text-xs text-muted-foreground">
      {assetLoadError ? "Usable emojis are unavailable." : "No usable emojis yet."}
    </p>
  )}
</div>


                        </CardContent>
                    </Card>
                  </div>

                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="icon"
                    disabled={isChatRestricted}
                    onClick={() => setShowEmojiPanel(!showEmojiPanel)}
                    className="h-7 w-7 sm:h-8 sm:w-8"
                    aria-label={showEmojiPanel ? "Close emoji picker" : "Open emoji picker"}
                  >
                    <Smile className="h-3 w-3" />
                  </Button>
                  <Input
                    ref={chatInputRef}
                    autoComplete="off"
                    value={chatInput}
                    onChange={(e) => {
                      setChatInput(e.target.value)
                      setChatError("")
                    }}
                    onKeyDown={(e) => e.key === "Enter" && sendChatMessage()}
                    placeholder="Type a message..."
                    maxLength={100}
                    disabled={isChatRestricted}
                    className={`flex-1 h-7 sm:h-8 ${isChatOnly ? "text-sm" : "text-xs sm:text-sm"}`}
                  />
                  <Button disabled={isChatRestricted} onClick={sendChatMessage} size="icon" className="h-7 w-7 sm:h-8 sm:w-8">
                    <Send className="h-3 w-3" />
                  </Button>
                </div>
                </fieldset>
                {chatError && <p role="alert" className="mt-1 text-xs text-destructive">{chatError}</p>}
              </CardContent>
            </Card>

            {username && !isChatOnly && (
              <Card
                data-user-info-panel
                onTransitionEnd={(event) => {
                  if (event.target !== event.currentTarget || event.propertyName !== "height") return
                  const content = event.currentTarget.querySelector<HTMLElement>("[data-user-info-content]")
                  if (content) content.style.overflowY = "auto"
                  if (!showUserInfoPanel || !window.matchMedia("(min-width: 1024px)").matches) {
                    event.currentTarget.style.height = "auto"
                  }
                }}
                className={`card-hover flex flex-col gap-0 overflow-hidden transition-[height,transform,box-shadow] duration-300 ease-in-out motion-reduce:transition-none lg:flex-shrink-0 lg:!transition-[height,transform,box-shadow] ${
                  showUserInfoPanel ? "lg:max-h-[calc(100dvh_-_28rem)]" : ""
                }`}
              >
                <CardHeader
                  className="flex cursor-pointer flex-row items-center justify-between py-2 sm:py-3 flex-shrink-0"
                  role="button"
                  tabIndex={0}
                  aria-expanded={showUserInfoPanel}
                  aria-label={showUserInfoPanel ? "Collapse account information" : "Expand account information"}
                  onClick={toggleUserInfoPanel}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      toggleUserInfoPanel()
                    }
                  }}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <Users className="h-3 w-3 sm:h-4 sm:w-4 text-primary" />
                    <CardTitle className="truncate text-xs sm:text-sm">
                      Account information
                    </CardTitle>
                  </div>
                  <span
                    className="inline-flex h-5 w-5 items-center justify-center rounded-md transition-all hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50 sm:h-6 sm:w-6"
                    aria-hidden="true"
                  >
                    {showUserInfoPanel
                      ? <ChevronDown className="size-4" />
                      : <ChevronUp className="size-4" />}
                  </span>
                </CardHeader>
                <div
                  ref={userInfoPanelBodyRef}
                  aria-hidden={!showUserInfoPanel}
                  inert={!showUserInfoPanel}
                  onTransitionEnd={(event) => {
                    if (event.target === event.currentTarget && event.propertyName === "height" && showUserInfoPanel && !window.matchMedia("(min-width: 1024px)").matches) {
                      event.currentTarget.style.height = "auto"
                    }
                  }}
                  className="min-h-0 overflow-hidden transition-[height] duration-300 ease-in-out motion-reduce:transition-none lg:flex-none"
                  style={{ height: 0 }}
                >
                  <div className="flex h-full min-h-0 flex-col overflow-hidden">
                  <CardContent
                    data-user-info-content
                    className="min-h-0 space-y-3 overflow-y-auto p-3 pt-6 text-xs sm:p-4 sm:pt-6 lg:flex-1"
                  >
                    {userInfoLoading && <p role="status">Loading profile…</p>}
                    {userInfoError && <p role="alert" className="text-destructive">{userInfoError}</p>}
                    {userInfo && (
                      <>
                        <details>
                          <summary className="cursor-pointer font-medium">{userInfo.username}</summary>
                          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                            <dt className="text-muted-foreground">Rank</dt>
                            <dd>{userInfo.rank}</dd>
                            <dt className="text-muted-foreground">Messages</dt>
                            <dd>{userInfo.message_count}</dd>
                            <dt className="text-muted-foreground">Email</dt>
                            <dd className="break-all">{userInfo.email || "Not set"}</dd>
                            <dt className="text-muted-foreground">Ban</dt>
                            <dd>
                              {userInfo.chat_timeout_until && isActiveTimeout(userInfo.chat_timeout_until)
                                ? `Until ${formatBanUntil(userInfo.chat_timeout_until)}`
                                : userInfo.banned ? "Banned" : "Not banned"}
                            </dd>
                            <dt className="text-muted-foreground">Points</dt>
                            <dd>{userInfo.points}❖</dd>
                          </dl>
                        </details>

                        <details
                          className="border-t pt-2"
                          onToggle={(event) => {
                            if (event.currentTarget.open) {
                              setUserBadgeSelection(userInfo.visible_badge_id ?? "")
                            }
                          }}
                        >
                          <summary className="cursor-pointer font-medium">Badges</summary>
                          <div className="space-y-2 pt-2">
                            <div className="flex flex-wrap gap-2">
                              {userInfo.badges.length ? (
                                userInfo.badges.map((badge) => (
                                  <button
                                    key={badge.asset_id}
                                    type="button"
                                    className={`flex h-8 w-8 items-center justify-center rounded border p-1 ${
                                      userInfo.username === username && userBadgeSelection === badge.asset_id
                                        ? "border-primary"
                                        : "border-border"
                                    }`}
                                    aria-pressed={userInfo.username === username && userBadgeSelection === badge.asset_id}
                                    disabled={userInfo.username !== username}
                                    onClick={() => {
                                      setUserBadgeSelection(badge.asset_id)
                                    }}
                                    title={badge.name}
                                    aria-label={badge.name}
                                  >
                                    <img src={badge.url} alt="" className="h-full w-full object-contain" />
                                  </button>
                                ))
                              ) : (
                                <p className="basis-full text-muted-foreground">No badges yet.</p>
                              )}
                              {userInfo.username === username && (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="icon"
                                  className={`h-8 w-8 p-1 ${!userBadgeSelection ? "border-primary dark:border-primary" : "border-border"}`}
                                  aria-pressed={!userBadgeSelection}
                                  aria-label="No badge"
                                  onClick={() => {
                                    setUserBadgeSelection("")
                                  }}
                                >
                                  <X className="h-4 w-4" />
                                </Button>
                              )}
                              <p className="basis-full">
                                {userBadgeSelection
                                  ? userInfo.badges.find((badge) => badge.asset_id === userBadgeSelection)?.name ?? "No badge"
                                  : "No badge"}
                              </p>
                            </div>
                            {userInfo.username === username && (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-7 w-full px-2 text-[10px]"
                                disabled={userBadgeSaving || userBadgeSelection === (userInfo.visible_badge_id ?? "")}
                                onClick={() => void saveUserBadgeSelection()}
                              >
                                {userBadgeSaving ? "Saving…" : "Save visible badge"}
                              </Button>
                            )}
                          </div>
                        </details>

                        {userInfo.username === username && (
                          <details className="border-t pt-2">
                            <summary className="cursor-pointer font-medium">Account recovery</summary>
                            <div className="space-y-2 pt-2">
                            <div className="flex flex-wrap gap-2">
                              <Button type="button" variant="outline" size="sm" onClick={() => void issueUserRecoveryCode("password")}>
                                Reset password
                              </Button>
                              <Button type="button" variant="outline" size="sm" onClick={() => void issueUserRecoveryCode("email")}>
                                Reset email
                              </Button>
                            </div>
                            {userRecoveryNotice && <p role="status" className="text-muted-foreground">{userRecoveryNotice}</p>}
                            {userRecoveryError && <p role="alert" className="text-destructive">{userRecoveryError}</p>}
                            {userRecoveryToken && (
                              <p className="break-all text-sm text-muted-foreground">
                                Recovery code:{" "}
                                <code
                                  className="select-all cursor-pointer"
                                  role="button"
                                  tabIndex={0}
                                  aria-label="Copy one-time account recovery code"
                                  onClick={() => void copyRecoveryCode(userRecoveryToken, setUserRecoveryCopyNotice, setUserRecoveryError)}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter" || event.key === " ") {
                                      event.preventDefault()
                                      void copyRecoveryCode(userRecoveryToken, setUserRecoveryCopyNotice, setUserRecoveryError)
                                    }
                                  }}
                                >
                                  {userRecoveryToken}
                                </code>
                              </p>
                            )}
                            {userRecoveryToken && (
                              <>
                                <p className="text-sm text-muted-foreground">After copying the recovery code, log out and press &quot;Account recovery&quot; button.</p>
                                {userRecoveryCopyNotice && <p role="status" className="text-sm text-muted-foreground">{userRecoveryCopyNotice}</p>}
                              </>
                            )}
                            </div>
                          </details>
                        )}
                      </>
                    )}
                  </CardContent>
                  </div>
                </div>
              </Card>
            )}

            {/* Online Users */}
            <Card data-online-users className="card-hover flex flex-col gap-0 transition-all duration-200 ease-in-out motion-reduce:!transition-none lg:flex-shrink-0 lg:max-h-[250px] lg:!transition-all">
              <CardHeader
                className="flex flex-row items-center justify-between pb-2 sm:pb-3 cursor-pointer py-2 sm:py-3 flex-shrink-0"
                onClick={() => setShowOnlineList(!showOnlineList)}
              >
                <div className="flex items-center gap-2">
                  <Users className="h-3 w-3 sm:h-4 sm:w-4 text-primary" />
                  <CardTitle className="text-xs sm:text-sm">Online {onlineUsers.length}</CardTitle>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 sm:h-6 sm:w-6"
                  aria-label={showOnlineList ? "Collapse online users" : "Expand online users"}
                  aria-expanded={showOnlineList}
                >
                  {showOnlineList ? (
                    <ChevronDown className="h-2.5 w-2.5 sm:h-3 sm:w-3" />
                  ) : (
                    <ChevronUp className="h-2.5 w-2.5 sm:h-3 sm:w-3" />
                  )}
                </Button>
              </CardHeader>
              <div
                aria-hidden={!showOnlineList}
                inert={!showOnlineList}
                className="grid min-h-0 overflow-hidden transition-all duration-200 ease-in-out motion-reduce:transition-none lg:flex-1"
                style={{ gridTemplateRows: showOnlineList ? "1fr" : "0fr" }}
              >
                <div className="flex min-h-0 flex-col overflow-hidden">
                <CardContent className="pt-6 p-3 sm:p-6 lg:flex-1 lg:min-h-0 lg:overflow-hidden">
                  <div
                    ref={onlineUsersScrollRef}
                    data-online-users-scroll
                    className="pr-2 lg:h-full lg:max-h-[180px] lg:overflow-y-auto"
                  >
                    <div className="flex flex-wrap gap-1 sm:gap-1.5">
                      {onlineUsers.map((user, idx) => (
                        <Badge
                          key={idx}
                          variant="secondary"
                          className="cursor-pointer hover:opacity-80 transition-opacity text-[10px] sm:text-xs px-1.5 sm:px-2 py-0.5"
                          style={{
                            backgroundColor: onlineUserRanks[user]?.rank_color
                              ? `${onlineUserRanks[user].rank_color}20`
                              : undefined,
                            color: onlineUserRanks[user]?.rank_color || undefined,
                          }}
                          onClick={() => handleUsernameClick(user)}
                        >
                          {user}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </CardContent>
                </div>
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
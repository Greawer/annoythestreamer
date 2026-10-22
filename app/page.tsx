"use client"

import type React from "react"
import { useState, useEffect, useRef, useCallback } from "react"
import { io, type Socket } from "socket.io-client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
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
  Sun,
  Moon,
  Upload,
  Trash2,
  Shield,
  ChevronDown,
  ChevronUp,
} from "lucide-react"

interface ChatMessage {
  user: string
  message: string
  literal_emojis?: string[]
  rank?: string
  rank_color?: string | null
  id?: string
}

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

interface PointPricing {
  send_your_chaos: Record<string, number>
  catalog: {
    emoji: {
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

interface ShopCatalog {
  emoji: ShopAsset[]
  sound: ShopAsset[]
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

type ShopCategory = "emoji" | "sound" | "add"

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

export default function AnnoyTheStreamer() {
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
    email: string | null
  } | null>(null)
  const [resetPasswordInput, setResetPasswordInput] = useState("")
  const [resetPasswordConfirmation, setResetPasswordConfirmation] = useState("")
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
  const [adminView, setAdminView] = useState<"users" | "admin" | "pricing" | "soundboard" | "emoji">("users")
  const [lookupUsername, setLookupUsername] = useState("")
  const [managedUser, setManagedUser] = useState<ManagedUser | null>(null)
  const [currentModerationStatus, setCurrentModerationStatus] = useState<{
    chat_timeout_until: string | null
  } | null>(null)
  const [timeoutClock, setTimeoutClock] = useState(() => Date.now())
  const [rankOptions, setRankOptions] = useState<RankOption[]>([])
  const [rankSelection, setRankSelection] = useState("")
  const [pointsAdjustment, setPointsAdjustment] = useState("0")
  const [timeoutDurationSeconds, setTimeoutDurationSeconds] = useState("60")
  const [adminError, setAdminError] = useState("")
  const [adminNotice, setAdminNotice] = useState("")
  const [confirmingPasswordReset, setConfirmingPasswordReset] = useState(false)
  const [adminIssuedPasswordResetToken, setAdminIssuedPasswordResetToken] = useState("")
  const [pointPricing, setPointPricing] = useState<PointPricing | null>(null)
  const [editedCatalogPrices, setEditedCatalogPrices] = useState<Record<string, string>>({})
  const [pricingLoading, setPricingLoading] = useState(false)
  const [pricingSaving, setPricingSaving] = useState(false)
  const [pricingError, setPricingError] = useState("")
  const [pricingNotice, setPricingNotice] = useState("")
  const [newEmojiItem, setNewEmojiItem] = useState("")
  const [newEmojiItemPrice, setNewEmojiItemPrice] = useState("100")
  const [newSoundItem, setNewSoundItem] = useState("")
  const [newSoundItemPrice, setNewSoundItemPrice] = useState("100")
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
  const [shopAssets, setShopAssets] = useState<ShopCatalog>({ emoji: [], sound: [] })
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
  const [theme, setTheme] = useState<"light" | "dark">("dark")
  const [showOnlineList, setShowOnlineList] = useState(false)
  const [isStreaming, setIsStreaming] = useState(false)
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

  const updateCatalogDefault = (assetType: "emoji" | "sound", value: number) => {
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
    assetType: "emoji" | "sound",
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
    assetType: "emoji" | "sound",
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

  const removeCatalogItemPrice = (assetType: "emoji" | "sound", key: string) => {
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

  useEffect(() => {
    if (isAdmin && adminView === "soundboard") void loadAdminAssets("sound")
    if (isAdmin && adminView === "emoji") void loadAdminAssets("emoji")
  }, [adminView, isAdmin, loadAdminAssets])

  const uploadAdminAsset = async (
    assetType: "sound" | "emoji",
    event: React.FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault()
    const file = assetType === "sound" ? adminSoundFile : adminEmojiFile
    const sourceUrl = assetType === "sound" ? adminSoundUrl.trim() : adminEmojiUrl.trim()
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
      (assetType === "sound" && !Number.isSafeInteger(playPrice))
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
          <label className="block space-y-1 text-xs">
            <span>Name</span>
            <Input
              value={isSound ? adminSoundName : adminEmojiName}
              onChange={(event) => isSound
                ? setAdminSoundName(event.target.value)
                : setAdminEmojiName(event.target.value)}
              placeholder={isSound ? "Sound Name" : "emojiname"}
              aria-label={isSound ? "Sound display name" : "Emoji name"}
              required
            />
          </label>
          {isSound && (
            <label className="block space-y-1 text-xs">
              <span>Loudness (0–2x multiplier)</span>
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
            </label>
          )}
          <label className="block space-y-1 text-xs">
            <span>Price</span>
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
          </label>
          <div className="space-y-1 text-xs">
            <span>Upload {isSound ? "sound" : "emoji"} file or URL</span>
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
                className="flex-1"
                aria-label={`${isSound ? "Sound" : "Emoji"} file URL`}
              />
              <div className="relative">
                <Input
                  type="file"
                  accept={isSound ? ".mp3,audio/mpeg" : ".jpg,.jpeg,.png,.gif,image/jpeg,image/png,image/gif"}
                  onChange={(event) => {
                    const file = event.target.files?.[0] ?? null
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
                  className="h-8 w-8 bg-transparent"
                  asChild
                >
                  <label htmlFor={`admin-${assetType}-file`} className="cursor-pointer flex items-center justify-center">
                    <Upload className="h-3 w-3" />
                  </label>
                </Button>
              </div>
            </div>
            {(isSound ? adminSoundFile : adminEmojiFile) && (
              <p className="truncate text-muted-foreground">
                {(isSound ? adminSoundFile : adminEmojiFile)?.name}
              </p>
            )}
          </div>
          <div className="pt-2">
            <Button type="submit" disabled={adminAssetSaving}>
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
                placeholder={isSound ? "Sound name" : "Emoji name"}
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
                <label className="block space-y-1 text-xs">
                  <span>Name</span>
                  <Input
                    value={isSound ? draft.display_name : draft.name}
                    onChange={(event) => setAdminAssetDrafts((current) => ({
                      ...current,
                      [asset.asset_id]: {
                        ...draft,
                        [isSound ? "display_name" : "name"]: event.target.value,
                      },
                    }))}
                    aria-label={`${isSound ? "Sound display name" : "Emoji name"} for ${asset.name}`}
                  />
                </label>
                {isSound && (
                  <label className="block space-y-1 text-xs">
                    <span>Loudness</span>
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
                      aria-label={`Loudness for ${asset.name}`}
                    />
                  </label>
                )}
                <label className="block space-y-1 text-xs">
                  <span>Price</span>
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
                </label>
                {isSound && (
                  <label className="block space-y-1 text-xs">
                    <span>Play price</span>
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
                  </label>
                )}
                <div className="flex gap-2 pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={adminAssetSaving}
                    onClick={() => void saveAdminAsset(assetType, asset)}
                  >
                    Save changes
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
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
    if (!response.ok || !result.emoji || !result.sound || !result.proposal_prices) {
      throw new Error(result.message || "Could not load the Point Shop")
    }
    setShopProposalPrices(result.proposal_prices)
    return result as ShopCatalog
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
    if (theme === "dark") document.documentElement.classList.add("dark")
    else document.documentElement.classList.remove("dark")
  }, [theme])

  // USERNAME COOKIE HANDLER
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


	socket.on('connect', () => {
	  socket.emit('getusers');
	});

  socket.on('points_changed', () => {
    void refreshCurrentPoints()
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
  });

  socket.on('chat_message_rejected', (result: { message: string; text?: string }) => {
    if (result.text) setChatInput((current) => current || result.text || "")
    setChatError(result.message || "Your message could not be sent")
  });

  socket.on('chat_history', (msgs: ChatMessage[]) => {
    setChatMessages(msgs);
  });

  socket.on('asset_catalog_changed', (event: { asset_type: "sound" | "emoji" }) => {
    void refreshOwnedAssetLists().catch((error) => {
      console.error("Could not refresh usable assets:", error)
    })
    if (event?.asset_type === "emoji") {
      void refreshPublicEmojiUrls().catch((error) => {
        console.error("Could not refresh public emoji images:", error)
      })
    }
  })

  socket.on('rank_changed', (change: {
    username: string
    rank: string
    rank_color: string | null
    permissions?: RolePermissions | null
    usage_costs?: Record<string, number>
  }) => {
    setChatMessages((messages) =>
      messages.map((message) => message.user === change.username ? { ...message, rank: change.rank, rank_color: change.rank_color } : message)
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
  };
}, [username, isAdmin, fetchShopCatalog, refreshCurrentPoints, refreshPublicEmojiUrls, refreshOwnedAssetLists]);

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
  setShopAssets({ emoji: [], sound: [] })
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



  // STATE: Meme + TTS inputs
  const [faceMemeTop, setFaceMemeTop] = useState("")
  const [faceMemeBottom, setFaceMemeBottom] = useState("")
  const [normalMemeImage, setNormalMemeImage] = useState("")
  const [normalMemeFile, setNormalMemeFile] = useState<File | null>(null)
  const [normalMemeTop, setNormalMemeTop] = useState("")
  const [normalMemeBottom, setNormalMemeBottom] = useState("")
  const [ttsText, setTtsText] = useState("")
  const [ttsLanguage, setTtsLanguage] = useState("en")

  const filteredSounds = sounds.filter((s) => s.title.toLowerCase().includes(soundSearch.toLowerCase()))
  const filteredShopAssets = (category: "emoji" | "sound") => {
    const query = (category === "emoji" ? emojiShopSearch : soundShopSearch).trim().toLowerCase()
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
  const canChangeManagedUserRank = Boolean(
    managedUser
    && permission("manage_ranks")
    && permission("assign_non_staff_rank")
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
        setAuthError("Enter the one-time reset code provided by an Admin.")
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
        setPasswordResetUsername(result.username)
        setPasswordResetAccount({
          username: result.username,
          email: typeof result.email === "string" ? result.email : null,
        })
      } catch (error) {
        setAuthError(error instanceof Error ? error.message : "Could not verify reset code")
      }
      return
    }
    if (resetPasswordInput.length < 8 || resetPasswordInput.length > 256) {
      setAuthError("Password must be between 8 and 256 characters.")
      return
    }
    if (resetPasswordInput !== resetPasswordConfirmation) {
      setAuthError("Passwords do not match.")
      return
    }
    try {
      const response = await fetch("/api/auth/password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: passwordResetAccount.username,
          reset_token: passwordResetToken,
          password: resetPasswordInput,
          confirmation: resetPasswordConfirmation,
        }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.message || "Password reset failed")
      window.location.replace("/")
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Password reset failed")
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
      setAdminIssuedPasswordResetToken("")
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

  const loadManagedUserByUsername = async (targetUsername: string) => {
    setAdminError("")
    setAdminNotice("")
    setAdminIssuedPasswordResetToken("")
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(targetUsername.trim())}`)
      const result = await response.json()
      if (!response.ok) throw new Error(result.message || "Could not load user")
      setManagedUser(result.user)
      if (result.user.username === username) acceptPointBalance(result.user.points)
      setRankSelection(result.user.rank_immutable ? "" : result.user.rank)
      setConfirmingPasswordReset(false)
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
  }

  const updateManagedUser = async (operation: string, body: Record<string, string | number | boolean>) => {
    if (!managedUser) return
    setAdminError("")
    setAdminNotice("")
    if (operation === "reset-password") setAdminIssuedPasswordResetToken("")
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
      if (operation === "reset-password") {
        setAdminIssuedPasswordResetToken(
          typeof result.reset_token === "string" ? result.reset_token : "",
        )
        setAdminNotice("One-time reset code generated. Share it with the user; it expires in 30 minutes.")
      } else {
        setAdminNotice("User updated.")
      }
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : "User update failed")
    }
  }

  const toggleStreaming = async () => {
    try {
      const response = await fetch("/api/admin/streaming", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ streaming: !isStreaming }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.message || "Could not update streaming status")
      setIsStreaming(result.streaming === true)
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : "Could not update streaming status")
    }
  }

  const toggleTheme = () => setTheme((p) => (p === "dark" ? "light" : "dark"))
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
      const result = await response.json()
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
	  const formData = new FormData()
	  formData.append("user", username)
    formData.append("image_normalmeme", normalMemeImage)
	  formData.append("top_text_normalmeme", normalMemeTop)
	  formData.append("bottom_text_normalmeme", normalMemeBottom)
    if (!await submitPaidUse("normalmeme", formData)) return
	  setNormalMemeImage("")
	  setNormalMemeFile(null)
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
    if (!file) return
    setNormalMemeFile(file)
    const reader = new FileReader()
    reader.onload = (ev) => setNormalMemeImage(ev.target?.result as string)
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

  const purchaseShopAsset = async (assetType: "sound" | "emoji", asset: ShopAsset) => {
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
      setShopNotice(`${asset.title || asset.name} added to your ${assetType === "sound" ? "soundboard" : "emojis"}.`)

      try {
        const catalog = await fetchShopCatalog()
        setShopAssets(catalog)
        await refreshOwnedAssetLists()
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
            <CardTitle className="text-3xl font-bold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
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
                  Reset password
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
              <section aria-label="Set a new password" className="space-y-3 border-t pt-3">
                <h2 className="text-sm font-semibold">
                  {passwordResetAccount ? "Set a new password" : "Verify password reset"}
                </h2>
                <p className="text-xs text-muted-foreground">
                  Enter the one-time reset code provided by an Admin to securely access this reset.
                </p>
                <p className="text-sm">
                  Account: <span className="font-medium">
                    {passwordResetAccount?.username || passwordResetUsername}
                  </span>
                </p>
                {passwordResetAccount && (
                  <p className="text-sm">
                    Email on file: <span className="font-medium">
                      {passwordResetAccount.email || "No email address on file"}
                    </span>
                  </p>
                )}
                <form
                  id="password-reset-form"
                  data-bwignore="true"
                  autoComplete="off"
                  className="space-y-3"
                  onSubmit={(event) => void handlePasswordResetSubmit(event)}
                >
                  <Input
                    name="reset-token"
                    placeholder="One-time reset code"
                    data-bwignore="true"
                    autoComplete="off"
                    value={passwordResetToken}
                    onChange={(event) => {
                      setPasswordResetToken(event.target.value)
                      setPasswordResetAccount(null)
                      setResetPasswordInput("")
                      setResetPasswordConfirmation("")
                    }}
                    className="text-lg"
                    required
                  />
                  {passwordResetAccount && (
                    <>
                      <Input
                        type="password"
                        name="new-password"
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
                  )}
                  <Button type="submit" className="w-full" size="lg">
                    {passwordResetAccount ? "Set new password" : "Verify reset code"}
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
    <div className="min-h-screen gradient-bg p-2 sm:p-4">
      <div className="max-w-[2000px] mx-auto">
        <div className="mb-4 sm:mb-6 text-center relative">
          <Button
            variant="outline"
            size="icon"
            onClick={toggleTheme}
            className="absolute right-0 top-0 bg-transparent"
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          >
            {theme === "dark" ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
          </Button>
          <h1 className="text-2xl sm:text-4xl font-bold bg-gradient-to-r from-primary via-accent to-primary bg-clip-text text-transparent mb-2">
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
                className={`ml-2 ${isAdmin ? "bg-pink-300 text-pink-900" : "text-zinc-900"}`}
                style={{ backgroundColor: getUserColor(username, currentRank) }}
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

        <div className="flex flex-col md:grid md:grid-cols-1 lg:grid lg:grid-cols-[repeat(auto-fit,320px)] gap-3 sm:gap-4 lg:items-start lg:justify-center">
          {/* --- Left Column: Send Chaos --- */}
          <div className="order-1 md:order-1 lg:order-3">
            <Card className={`card-hover flex flex-col h-auto max-h-[80dvh] overflow-hidden lg:h-[calc(100dvh_-_18rem)] lg:max-h-none lg:overflow-visible lg:!transition-[transform,box-shadow] ${isChatRestricted ? "opacity-60 grayscale" : ""}`}>
              <CardHeader className="pb-2 sm:pb-3 flex-shrink-0">
                <CardTitle className="text-base sm:text-lg">Send Your Chaos</CardTitle>
                <CardDescription className="text-xs">Choose your weapon</CardDescription>
              </CardHeader>
              <fieldset
                disabled={isChatRestricted}
                className="min-h-0 min-w-0 flex-1 overflow-y-auto border-0 p-3 sm:p-6 lg:overflow-hidden disabled:pointer-events-none"
              >
                {actionError && <p role="alert" className="mb-2 text-xs text-destructive">{actionError}</p>}
                <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col lg:h-full">
                  <TabsList className="grid w-full grid-cols-4 mb-3 sm:mb-4 h-8 sm:h-10 flex-shrink-0">
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
                      </div>
                      <Button type="submit" disabled={!canAffordAction("facemememe")} className="w-full h-7 sm:h-8 text-xs sm:text-sm mt-3 md:mt-3 lg:mt-auto disabled:grayscale">
                        {actionButtonText("Send Face Meme", "facemememe")}
                      </Button>
                    </form>
                  </TabsContent>

                  {/* --- Normal Meme Tab --- */}
                  <TabsContent value="normalmeme" className="space-y-2 sm:space-y-3 mt-0 flex flex-col lg:flex-1 lg:min-h-0">
                    <form autoComplete="off" onSubmit={handleNormalMemeSubmit} className="flex flex-col lg:h-full">
                      <div className="flex-1 space-y-2 sm:space-y-3">
                        <div>
                          <label className="text-xs font-medium mb-1 block">Image</label>
                          <div className="flex gap-2">
                            <Input
                              value={normalMemeImage}
                              onChange={(e) => setNormalMemeImage(e.target.value)}
                              placeholder="URL..."
                              className="h-7 sm:h-8 text-xs sm:text-sm flex-1"
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
                            <p className="text-[10px] sm:text-xs text-muted-foreground mt-1 truncate">
                              {normalMemeFile.name}
                            </p>
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
            </Card>
          </div>

          {username && permission("panel_access") && (
          <div className="order-3 md:order-3 lg:order-1">
            <Card className="card-hover flex flex-col h-auto max-h-[80dvh] overflow-hidden lg:h-[calc(100dvh_-_18rem)] lg:max-h-none lg:overflow-visible lg:!transition-[transform,box-shadow]">
              <CardHeader className="pb-2 sm:pb-3 flex-shrink-0">
                <CardTitle className="text-base sm:text-lg">{isAdmin ? "Admin" : "Moderation"}</CardTitle>
                <CardDescription className="text-xs">{isAdmin ? "Manage users and account settings" : "Inspect users and manage chat moderation"}</CardDescription>
              </CardHeader>
              <CardContent className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-6 lg:overflow-hidden">
                <Tabs value={adminView} onValueChange={(value) => setAdminView(value as "users" | "admin" | "pricing" | "soundboard" | "emoji")} className="flex flex-col lg:h-full">
                  <TabsList className={`grid w-full ${isAdmin ? "grid-cols-6" : "grid-cols-1"} mb-3 sm:mb-4 h-auto flex-shrink-0`}>
                    <TabsTrigger value="users" className={`gap-1 text-[10px] sm:text-xs px-1 ${isAdmin ? "col-span-2" : ""}`}>
                      <Users className="h-3 w-3" /> Users
                    </TabsTrigger>
                    {permission("admin_console") && (
                      <TabsTrigger value="admin" className="col-span-2 gap-1 text-[10px] sm:text-xs px-1">
                        <Shield className="h-3 w-3" /> Admin
                      </TabsTrigger>
                    )}
                    {permission("admin_console") && (
                      <TabsTrigger value="pricing" className="col-span-2 gap-1 text-[10px] sm:text-xs px-1">
                        ❖ Pricing
                      </TabsTrigger>
                    )}
                    {permission("admin_console") && (
                      <TabsTrigger value="soundboard" className="col-start-2 col-span-2 gap-1 text-[10px] sm:text-xs px-1">
                        <Music className="h-3 w-3" /> Soundboard
                      </TabsTrigger>
                    )}
                    {permission("admin_console") && (
                      <TabsTrigger value="emoji" className="col-start-4 col-span-2 gap-1 text-[10px] sm:text-xs px-1">
                        <Smile className="h-3 w-3" /> Emoji
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
                          </div>
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
                              <Input type="number" step="1" value={pointsAdjustment} onChange={(event) => setPointsAdjustment(event.target.value)} aria-label="Point adjustment" />
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
                                {rankOptions.filter((option) => option.staff === false).map((option) => (
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
                                  const durationSeconds = Number(timeoutDurationSeconds)
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
                          {permission("reset_password") && <div className="flex items-center justify-between gap-2">
                            <span className="text-sm">Reset password</span>
                            {!confirmingPasswordReset ? (
                              <Button variant="outline" onClick={() => setConfirmingPasswordReset(true)}>
                                Reset password
                              </Button>
                            ) : (
                              <div className="flex gap-2">
                                <Button variant="outline" onClick={() => setConfirmingPasswordReset(false)}>Cancel</Button>
                                <Button variant="destructive" onClick={() => void updateManagedUser("reset-password", {})}>Confirm</Button>
                              </div>
                            )}
                          </div>}
                        </div>
                      )}
                    </>
                  ) : <p className="text-sm text-muted-foreground">Admin tools are open for testing.</p>}
                    </div>
                    {adminError && <p role="alert" className="text-sm text-destructive">{adminError}</p>}
                    {adminNotice && (
                      <div role="status" className="space-y-1 text-sm text-muted-foreground">
                        <p>{adminNotice}</p>
                        {adminIssuedPasswordResetToken && (
                          <p className="break-all">
                            Reset code (shown once):{" "}
                            <code className="select-all">{adminIssuedPasswordResetToken}</code>
                          </p>
                        )}
                      </div>
                    )}
                  </TabsContent>
                  {permission("admin_console") && <TabsContent value="admin" className="mt-0 lg:flex-1 lg:min-h-0 lg:overflow-y-auto">
                    <div className="flex items-center gap-3">
                      <Button variant={isStreaming ? "destructive" : "default"} onClick={() => void toggleStreaming()}>
                        {isStreaming ? "Stop streaming" : "Start streaming"}
                      </Button>
                      <span className="text-sm text-muted-foreground">{isStreaming ? "Points accrue every 60 seconds." : "Point awards are off."}</span>
                    </div>
                  </TabsContent>}
                  {permission("admin_console") && <TabsContent value="pricing" className="mt-0 lg:flex-1 lg:min-h-0 lg:overflow-y-auto">
                    {pricingLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
                    {pointPricing && (
                      <div className="space-y-4">
                        <section className="space-y-2">
                          <h3 className="text-sm font-semibold">Send Your Chaos</h3>
                          <div className="grid grid-cols-2 gap-2">
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
                            <div className="space-y-2 pt-2">
                              <form
                                autoComplete="off"
                                className="flex flex-col gap-2"
                                onSubmit={(event) => {
                                  event.preventDefault()
                                  const item = newEmojiItem.trim()
                                  const price = parsePointPrice(newEmojiItemPrice)
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
                                  <Input type="number" min={-1} step={1} value={newEmojiItemPrice} onChange={(event) => setNewEmojiItemPrice(event.target.value)} aria-label="New emoji exception price" className="w-full [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />
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
                                  const price = parsePointPrice(newSoundItemPrice)
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
                                  <Input type="number" min={-1} step={1} value={newSoundItemPrice} onChange={(event) => setNewSoundItemPrice(event.target.value)} aria-label="New sound exception price" className="w-full [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />
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
                </Tabs>
              </CardContent>
            </Card>
          </div>
          )}

          {username && !isAdmin && (
            <div className="order-4 md:order-4 lg:order-2">
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
                    <TabsList className="grid w-full grid-cols-3 mb-3 h-8 sm:h-10 flex-shrink-0">
                      <TabsTrigger value="emoji" className="gap-1 text-[10px] sm:text-xs px-1">
                        <Smile className="h-3 w-3" /> Emojis
                      </TabsTrigger>
                      <TabsTrigger value="sound" className="gap-1 text-[10px] sm:text-xs px-1">
                        <Volume2 className="h-3 w-3" /> Sounds
                      </TabsTrigger>
                      <TabsTrigger value="add" className="gap-1 text-[10px] sm:text-xs px-1">
                        <Upload className="h-3 w-3" /> Add
                      </TabsTrigger>
                    </TabsList>
                    {(["emoji", "sound", "add"] as const).map((category) => (
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
                                    className="space-y-2 rounded-md border p-3"
                                    autoComplete="off"
                                    onSubmit={(event) => void submitAssetProposal(event, assetType)}
                                  >
                                    <h3 className="text-sm font-semibold">{title}</h3>
                                    <label className="block space-y-1 text-xs">
                                      <span>Name</span>
                                      <Input
                                        value={draft.name}
                                        onChange={(event) => setProposalDrafts((current) => ({
                                          ...current,
                                          [assetType]: { ...current[assetType], name: event.target.value },
                                        }))}
                                        maxLength={120}
                                        placeholder={assetType === "emoji" ? "emojiname" : "Sound Name"}
                                        aria-label={assetType === "emoji" ? "Emoji name" : "Sound display name"}
                                        required
                                      />
                                    </label>
                                    {assetType === "sound" && (
                                      <label className="block space-y-1 text-xs">
                                        <span>Loudness (0–2x multiplier)</span>
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
                                      </label>
                                    )}
                                    <div className="space-y-1 text-xs">
                                      <span>Upload {assetType} file or URL</span>
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
                                          className="flex-1"
                                          aria-label={`${assetType === "sound" ? "Sound" : "Emoji"} file URL`}
                                        />
                                        <div className="relative">
                                          <Input
                                            type="file"
                                            accept={assetType === "sound" ? ".mp3,audio/mpeg" : ".jpg,.jpeg,.png,.gif,image/jpeg,image/png,image/gif"}
                                            onChange={(event) => {
                                              const file = event.target.files?.[0] ?? null
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
                                            className="h-8 w-8 bg-transparent"
                                            asChild
                                          >
                                            <label htmlFor={`proposal-${assetType}-file`} className="flex cursor-pointer items-center justify-center">
                                              <Upload className="h-3 w-3" />
                                            </label>
                                          </Button>
                                        </div>
                                      </div>
                                      {proposalFiles[assetType] && (
                                        <p className="truncate text-muted-foreground">{proposalFiles[assetType]?.name}</p>
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
                                      className="mt-3 h-7 w-full text-xs sm:h-8 sm:text-sm disabled:grayscale"
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
                              value={category === "emoji" ? emojiShopSearch : soundShopSearch}
                              onChange={(event) => {
                                if (category === "emoji") setEmojiShopSearch(event.target.value)
                                else setSoundShopSearch(event.target.value)
                              }}
                              placeholder={`Search ${category === "sound" ? "sounds" : "emojis"}...`}
                              aria-label={`Search shop ${category === "sound" ? "sounds" : "emojis"}`}
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
                                    ? `No ${category === "sound" ? "sounds" : "emojis"} available.`
                                    : `No ${category === "sound" ? "sounds" : "emojis"} match your search.`}
                                </p>
                              )}
                              <div className="space-y-2" data-testid={`shop-${category}-items`}>
                                {filteredShopAssets(category).map((asset) => (
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
                                ))}
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
          <div className="order-2 md:order-2 lg:order-4 flex flex-col gap-3 sm:gap-4 lg:h-[calc(100dvh_-_18rem)]">
            <Card className="card-hover flex max-h-[80dvh] flex-col overflow-hidden lg:flex-1 lg:min-h-0 lg:max-h-none lg:!transition-[transform,box-shadow]">
              <CardHeader className="flex flex-row items-center justify-between pb-1 sm:pb-2 flex-shrink-0">
                <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
                  <MessageSquare className="h-3 w-3 sm:h-4 sm:w-4 text-primary" /> Chat
                </CardTitle>
                <span className="flex items-center gap-2 text-xs text-muted-foreground" title={isStreaming ? "Streaming on" : "Streaming off"}>
                  <span className={`h-2.5 w-2.5 rounded-full ${isStreaming ? "bg-green-500 shadow-[0_0_8px_2px_rgba(34,197,94,0.75)]" : "bg-red-500"}`} />
                  <span className="sr-only">{isStreaming ? "Streaming on" : "Streaming off"}</span>
                </span>
              </CardHeader>
              <CardContent className="flex min-h-0 flex-1 flex-col space-y-2 overflow-hidden p-3 sm:p-4 lg:max-h-full">
                <div
			  className="min-h-0 flex-1 overflow-y-auto pr-2"
			  ref={chatBoxRef}
			  style={{ display: "flex", flexDirection: "column" }}
			>
			  <div className="space-y-1.5 sm:space-y-2">
				{Array.isArray(chatMessages) && chatMessages.length > 0 ? (
				  [...chatMessages].map((msg, idx) => {
					const isMentioned = new RegExp(`@${username}\\b`, "i").test(msg.message)

					return (
					  <div
						key={idx} // Add stable key
						className={`group text-[11px] sm:text-sm p-1.5 sm:p-2 rounded flex items-start justify-between gap-2 ${
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
                  {msg.user}:
                </span>
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
						  <span className="text-foreground break-words">{renderMessageWithEmojis(msg.message, msg.literal_emojis, msg.user)}</span>
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
                  {showEmojiPanel && (
                    <div className="relative">
                      <Card className="absolute bottom-full left-0 right-0 mb-2 z-10 gap-0 py-1">
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
                  )}

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
                    className="flex-1 h-7 sm:h-8 text-xs sm:text-sm"
                  />
                  <Button disabled={isChatRestricted} onClick={sendChatMessage} size="icon" className="h-7 w-7 sm:h-8 sm:w-8">
                    <Send className="h-3 w-3" />
                  </Button>
                </div>
                </fieldset>
                {chatError && <p role="alert" className="mt-1 text-xs text-destructive">{chatError}</p>}
              </CardContent>
            </Card>

            {/* Online Users */}
            <Card className="card-hover flex flex-col lg:flex-shrink-0 lg:max-h-[250px] lg:!transition-[transform,box-shadow]">
              <CardHeader
                className="flex flex-row items-center justify-between pb-2 sm:pb-3 cursor-pointer py-2 sm:py-3 flex-shrink-0"
                onClick={() => setShowOnlineList(!showOnlineList)}
              >
                <div className="flex items-center gap-2">
                  <Users className="h-3 w-3 sm:h-4 sm:w-4 text-primary" />
                  <CardTitle className="text-xs sm:text-sm">Online {onlineUsers.length}</CardTitle>
                </div>
                <Button variant="ghost" size="icon" className="h-5 w-5 sm:h-6 sm:w-6">
                  {showOnlineList ? (
                    <ChevronDown className="h-2.5 w-2.5 sm:h-3 sm:w-3" />
                  ) : (
                    <ChevronUp className="h-2.5 w-2.5 sm:h-3 sm:w-3" />
                  )}
                </Button>
              </CardHeader>
              {showOnlineList && (
                <CardContent className="pt-0 p-3 sm:p-6 lg:flex-1 lg:min-h-0 lg:overflow-hidden">
                  <div className="pr-2 lg:h-full lg:max-h-[180px] lg:overflow-y-auto">
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
              )}
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
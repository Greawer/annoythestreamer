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
  Users,
  Send,
  Smile,
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
  catalog: Record<string, {
    default: number
    categories: Record<string, number>
    items: Record<string, number>
  }>
  proposal_rewards: Record<string, {
    default: number
    items: Record<string, number>
  }>
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

export default function AnnoyTheStreamer() {
  const [username, setUsername] = useState<string>("")
  const [showUsernamePrompt, setShowUsernamePrompt] = useState(true)
  const [usernameInput, setUsernameInput] = useState("")
  const [emailInput, setEmailInput] = useState("")
  const [passwordInput, setPasswordInput] = useState("")
  const [passwordConfirmation, setPasswordConfirmation] = useState("")
  const [passwordMode, setPasswordMode] = useState<"login" | "create">("login")
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
  const [showPasswordPrompt, setShowPasswordPrompt] = useState(false)
  const [adminView, setAdminView] = useState<"users" | "admin" | "pricing">("users")
  const [adminLoginUsername, setAdminLoginUsername] = useState("")
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
  const [pointPricing, setPointPricing] = useState<PointPricing | null>(null)
  const [pricingLoading, setPricingLoading] = useState(false)
  const [pricingSaving, setPricingSaving] = useState(false)
  const [pricingError, setPricingError] = useState("")
  const [pricingNotice, setPricingNotice] = useState("")
  const [newEmojiItem, setNewEmojiItem] = useState("")
  const [newEmojiItemPrice, setNewEmojiItemPrice] = useState("100")
  const [newSoundItem, setNewSoundItem] = useState("")
  const [newSoundItemPrice, setNewSoundItemPrice] = useState("100")

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [hoveredChatMessage, setHoveredChatMessage] = useState<number | null>(null)
  const [chatInput, setChatInput] = useState("")
  const [onlineUsers, setOnlineUsers] = useState<string[]>([])
  const [onlineUserRanks, setOnlineUserRanks] = useState<Record<string, { rank: string; rank_color: string | null }>>({})
  const [showEmojiPanel, setShowEmojiPanel] = useState(false)
  const [emojis, setEmojis] = useState<string[]>([])
  const [sounds, setSounds] = useState<{ file: string; title: string; url: string }[]>([]);
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

  const removeCatalogItemPrice = (assetType: "emoji" | "sound", key: string) => {
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
      setPricingNotice("Pricing saved.")
    } catch (error) {
      setPricingError(error instanceof Error ? error.message : "Could not save pricing")
    } finally {
      setPricingSaving(false)
    }
  }

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
        setShowUsernamePrompt(false)
      })
      .catch(() => {
        setCurrentPoints(null)
        setPointsError(true)
        setPointsLoading(false)
      })
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
    void fetch("/api/auth/session")
      .then((response) => {
        if (!response.ok) throw new Error(`Session request failed (${response.status})`)
        return response.json()
      })
      .then((result) => {
        if (result.authenticated === true) setUsageCosts(result.usage_costs || {})
      })
      .catch((error) => console.error("Could not refresh action prices:", error))
  });

  socket.on('chat_message', (msg: ChatMessage) => {
    setChatMessages(prev => [...prev, msg]);
  });

  socket.on('chat_history', (msgs: ChatMessage[]) => {
    setChatMessages(msgs);
  });

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
}, [username, refreshCurrentPoints]);

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

// LOAD EMOJIS & SOUNDS DYNAMICALLY
useEffect(() => {
  // --- Load emojis ---
  const loadEmojis = async () => {
    try {
      const res = await fetch("/api/list-emojis");
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      setEmojis(data);
    } catch (err) {
      console.warn("Failed to load emojis:", err);
    }
  };

  // --- Load sounds ---
  const loadSoundsFromBackend = async () => {
    try {
      const res = await fetch("/api/soundboardlist");
      if (!res.ok) throw new Error(res.statusText);
      setSounds(await res.json());
    } catch (err) {
      console.warn("Failed to load sounds:", err);
    }
  };

  loadEmojis();
  loadSoundsFromBackend();
}, []);



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

  // --- Username + Admin logic ---
  const joinAsUsername = (name: string, rank: string, permissions: RolePermissions | null) => {
    setUsername(name)
    setCurrentModerationStatus(null)
    setCookie("ats_username", name, 7)
    setCurrentRank(rank)
    setCurrentPermissions(permissions)
    setShowUsernamePrompt(false)
  }

  const handleUsernameSubmit = async () => {
    const name = usernameInput.trim()
    if (!name) return
    setAuthError("")
    try {
      const response = await fetch("/api/auth/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: name }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.message || "Could not check account")
      setAdminLoginUsername(name)
      setPasswordMode(result.requires_password_creation ? "create" : "login")
      setEmailInput("")
      setPasswordInput("")
      setPasswordConfirmation("")
      setShowPasswordPrompt(true)
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Could not check account")
    }
  }

  const handlePasswordSubmit = async () => {
    setAuthError("")
    if (passwordMode === "create" && !isValidEmail(emailInput)) {
      setAuthError("Enter a valid email address.")
      return
    }
    if (passwordMode === "create" && passwordInput !== passwordConfirmation) {
      setAuthError("Passwords do not match.")
      return
    }
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: adminLoginUsername,
          email: passwordMode === "create" ? emailInput.trim() : undefined,
          password: passwordInput,
          confirmation: passwordConfirmation,
        }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.message || "Login failed")
      joinAsUsername(result.username, result.rank, result.permissions ?? null)
      acceptPointBalance(result.points)
      setUsageCosts(result.usage_costs || {})
      setEmailInput("")
      setPasswordInput("")
      setPasswordConfirmation("")
      setShowPasswordPrompt(false)
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Login failed")
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
      setCurrentRank("User")
      setCurrentPermissions(null)
      setCurrentPoints(null)
      setPointsLoading(false)
      setPointsError(false)
      setUsageCosts({})
      setActionError("")
      setShowPasswordPrompt(false)
      setPasswordInput("")
      setPasswordConfirmation("")
      setShowUsernamePrompt(true)
      window.location.replace("/")
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : "Logout failed")
      setIsLoggingOut(false)
    }
  }

  const loadManagedUserByUsername = async (targetUsername: string) => {
    setAdminError("")
    setAdminNotice("")
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
      setAdminNotice(operation === "reset-password" ? "Password reset." : "User updated.")
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

	const insertEmoji = (emoji: string) => setChatInput((prev) => prev + `:${emoji}:`)

	const renderMessageWithEmojis = (message: string) => {
	  const parts = message.split(/(:\w+:)/g)
	  return parts.map((part, idx) => {
		const emojiName = part.replace(/:/g, "")
		if (emojis.includes(emojiName)) {
		  return (
			<img
			  key={idx}
			  src={`/img/emoji/${emojiName}.png`}
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

	const playSound = (file: string) => {
    if (isChatRestricted) return
    const socket = socketRef.current
    if (!socket?.connected) {
      setActionError("Sound request could not be sent. Check the chat connection and retry.")
      return
    }
    const action = "soundmeme"
    const requestKey = `${action}:${file}`
    const requestId = getPaidUseRequestId(requestKey)
    setActionError("")
    socket.emit(
      "playsound",
      { file: file.replace(/\.mp3$/i, ""), request_id: requestId },
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

if (showUsernamePrompt) {
    return (
      <div className="min-h-screen gradient-bg flex items-center justify-center p-4">
        <Card className="w-full max-w-md glow-primary">
          <CardHeader className="text-center">
            <CardTitle className="text-3xl font-bold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
              Annoy the Streamer
            </CardTitle>
            <CardDescription>
              {showPasswordPrompt
                ? passwordMode === "create" ? "Create your account" : "Enter your password"
                : "Enter your username to join the chaos"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!showPasswordPrompt ? (
              <>
                <Input
                  placeholder="Your username..."
                  value={usernameInput}
                  onChange={(e) => setUsernameInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleUsernameSubmit()}
                  className="text-lg"
                />
                <Button onClick={handleUsernameSubmit} className="w-full" size="lg">
                  Join the Fun
                </Button>
              </>
            ) : (
              <>
                {passwordMode === "create" && (
                  <Input
                    type="email"
                    placeholder="Email address..."
                    value={emailInput}
                    onChange={(e) => setEmailInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handlePasswordSubmit()}
                    className="text-lg"
                    autoComplete="email"
                    required
                  />
                )}
                <Input
                  type="password"
                  placeholder={passwordMode === "create" ? "Create password..." : "Password..."}
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handlePasswordSubmit()}
                  className="text-lg"
                  autoFocus
                />
                {passwordMode === "create" && (
                  <Input
                    type="password"
                    placeholder="Confirm password..."
                    value={passwordConfirmation}
                    onChange={(e) => setPasswordConfirmation(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handlePasswordSubmit()}
                    className="text-lg"
                  />
                )}
                {authError && <p role="alert" className="text-sm text-destructive">{authError}</p>}
                <div className="flex gap-2">
                  <Button
                    onClick={() => {
                      setShowPasswordPrompt(false)
                      setPasswordInput("")
                      setPasswordConfirmation("")
                      setAuthError("")
                    }}
                    variant="outline"
                    className="flex-1"
                  >
                    Back
                  </Button>
                  <Button onClick={handlePasswordSubmit} className="flex-1" size="lg">
                    {passwordMode === "create" ? "Create account" : "Login"}
                  </Button>
                </div>
              </>
            )}
            {!showPasswordPrompt && authError && <p role="alert" className="text-sm text-destructive">{authError}</p>}
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
          <div className="order-1 md:order-1 lg:order-1">
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
                    <form onSubmit={handleFaceMemeSubmit} className="flex flex-col lg:h-full">
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
                    <form onSubmit={handleNormalMemeSubmit} className="flex flex-col lg:h-full">
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
                    <form onSubmit={handleTTSSubmit} className="flex flex-col lg:h-full">
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
    <div className="mb-2 flex gap-2">
      <Input
        value={soundSearch}
        onChange={(e) => setSoundSearch(e.target.value)}
        placeholder="Search sounds..."
        className="h-7 flex-1 text-xs sm:h-8 sm:text-sm"
      />
      {!isAdmin && (
        <Button
          type="button"
          disabled
          className="h-7 px-2 text-xs disabled:opacity-100 sm:h-8 sm:text-sm"
        >
          {displayedUsageCost("soundmeme") < 0 ? "Unavailable" : `${displayedUsageCost("soundmeme")}❖`}
        </Button>
      )}
    </div>
    <div className="grid grid-cols-2 gap-1.5 sm:gap-2 pr-1">
      {filteredSounds.map((sound, idx) => (
<Button
  key={idx}
  variant="outline"
  disabled={!canAffordAction("soundmeme")}
  onClick={() => playSound(sound.file)}
  className="h-auto py-1 sm:py-1.5 px-1.5 sm:px-2 text-[10px] sm:text-xs text-left justify-start disabled:grayscale"
>
  <Volume2 className="h-2.5 w-2.5 sm:h-3 sm:w-3 mr-1 flex-shrink-0" />
  <span className="truncate">{sound.title}</span>
</Button>

      ))}
      {filteredSounds.length === 0 && (
        <p className="text-[11px] text-muted-foreground col-span-2 text-center mt-2">
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
          <div className="order-2 md:order-2 lg:order-2">
            <Card className="card-hover flex flex-col h-auto max-h-[80dvh] overflow-hidden lg:h-[calc(100dvh_-_18rem)] lg:max-h-none lg:overflow-visible lg:!transition-[transform,box-shadow]">
              <CardHeader className="pb-2 sm:pb-3 flex-shrink-0">
                <CardTitle className="text-base sm:text-lg">{isAdmin ? "Admin" : "Moderation"}</CardTitle>
                <CardDescription className="text-xs">{isAdmin ? "Manage users and account settings" : "Inspect users and manage chat moderation"}</CardDescription>
              </CardHeader>
              <CardContent className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-6 lg:overflow-hidden">
                <Tabs value={adminView} onValueChange={(value) => setAdminView(value as "users" | "admin" | "pricing")} className="flex flex-col lg:h-full">
                  <TabsList className={`grid w-full ${isAdmin ? "grid-cols-3" : "grid-cols-1"} mb-3 sm:mb-4 h-8 sm:h-10 flex-shrink-0`}>
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
                  </TabsList>
                  <TabsContent value="users" className="mt-0 space-y-3 lg:flex-1 lg:min-h-0 lg:overflow-y-auto">
                    <div className="space-y-3">
                  {adminView === "users" ? (
                    <>
                      <form onSubmit={loadManagedUser} className="flex gap-2">
                        <Input
                          value={lookupUsername}
                          onChange={(event) => setLookupUsername(event.target.value)}
                          placeholder="Username"
                          aria-label="Username to look up"
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
                    {adminNotice && <p role="status" className="text-sm text-muted-foreground">{adminNotice}</p>}
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
                                  onChange={(event) => updateActionPrice(key, Number(event.target.value))}
                                  className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                />
                              </label>
                            ))}
                          </div>
                        </section>

                        <section className="space-y-2 border-t pt-3">
                          <h3 className="text-sm font-semibold">Emoji</h3>
                          <label className="block space-y-1 text-xs">
                            <span>Default price</span>
                            <Input
                              aria-label="Default emoji price"
                              type="number"
                              min={-1}
                              step={1}
                              value={pointPricing.catalog.emoji.default}
                              onChange={(event) => updateCatalogDefault("emoji", Number(event.target.value))}
                              className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                            />
                          </label>

                          <details className="rounded-md border px-3 py-2">
                            <summary className="cursor-pointer text-xs font-medium">
                              Exceptions ({Object.keys(pointPricing.catalog.emoji.items).length})
                            </summary>
                            <div className="space-y-2 pt-2">
                              <form
                                className="flex flex-col gap-2"
                                onSubmit={(event) => {
                                  event.preventDefault()
                                  const item = newEmojiItem.trim()
                                  if (!item || Object.prototype.hasOwnProperty.call(pointPricing.catalog.emoji.items, item)) {
                                    setPricingError("Enter a new item name.")
                                    return
                                  }
                                  updateCatalogItemPrice("emoji", item, Number(newEmojiItemPrice))
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
                                    value={price}
                                    onChange={(event) => updateCatalogItemPrice("emoji", item, Number(event.target.value))}
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
                              onChange={(event) => updateProposalDefault("emoji", Number(event.target.value))}
                              className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                            />
                          </label>
                        </section>

                        <section className="space-y-2 border-t pt-3">
                          <h3 className="text-sm font-semibold">Soundboard</h3>
                          <label className="block space-y-1 text-xs">
                            <span>Default price</span>
                            <Input
                              aria-label="Default sound price"
                              type="number"
                              min={-1}
                              step={1}
                              value={pointPricing.catalog.sound.default}
                              onChange={(event) => updateCatalogDefault("sound", Number(event.target.value))}
                              className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                            />
                          </label>

                          <details className="rounded-md border px-3 py-2">
                            <summary className="cursor-pointer text-xs font-medium">
                              Exceptions ({Object.keys(pointPricing.catalog.sound.items).length})
                            </summary>
                            <div className="space-y-2 pt-2">
                              <form
                                className="flex flex-col gap-2"
                                onSubmit={(event) => {
                                  event.preventDefault()
                                  const item = newSoundItem.trim()
                                  if (!item || Object.prototype.hasOwnProperty.call(pointPricing.catalog.sound.items, item)) {
                                    setPricingError("Enter a new item name.")
                                    return
                                  }
                                  updateCatalogItemPrice("sound", item, Number(newSoundItemPrice))
                                  setNewSoundItem("")
                                }}
                              >
                                <Input value={newSoundItem} onChange={(event) => setNewSoundItem(event.target.value)} placeholder="Sound name" aria-label="New sound exception name" className="w-full" />
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
                                    value={price}
                                    onChange={(event) => updateCatalogItemPrice("sound", item, Number(event.target.value))}
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
                            <span>Add your own</span>
                            <Input
                              aria-label="Add your own sound price"
                              type="number"
                              min={-1}
                              step={1}
                              value={pointPricing.proposal_rewards.sound.default}
                              onChange={(event) => updateProposalDefault("sound", Number(event.target.value))}
                              className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                            />
                          </label>
                        </section>

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
                </Tabs>
              </CardContent>
            </Card>
          </div>
          )}



          {/* --- Right Column: Chat + Online Users --- */}
          <div className="order-3 lg:order-3 md:order-3 flex flex-col gap-3 sm:gap-4 lg:h-[calc(100dvh_-_18rem)]">
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
						  <span className="text-foreground break-words">{renderMessageWithEmojis(msg.message)}</span>
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
                      <Card className="absolute bottom-full left-0 right-0 mb-2 z-10">
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
<ScrollArea className="h-32 pr-2">
  <div className="grid grid-cols-[repeat(auto-fit,minmax(20px,1fr))] gap-0.5 sm:gap-1 emoji-panel">
    {emojis.map((emoji) => (
      <button
        key={emoji}
        onClick={() => insertEmoji(emoji)}
        className="p-0 m-0 flex items-center justify-center"
        title={emoji}
      >
        <img src={`/img/emoji/${emoji}.png`} alt={emoji} className="h-5 w-5" />
      </button>
    ))}
  </div>
</ScrollArea>


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
                  >
                    <Smile className="h-3 w-3" />
                  </Button>
                  <Input
                    ref={chatInputRef}
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
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
                    <ChevronUp className="h-2.5 w-2.5 sm:h-3 sm:w-3" />
                  ) : (
                    <ChevronDown className="h-2.5 w-2.5 sm:h-3 sm:w-3" />
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
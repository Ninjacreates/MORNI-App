

























/* =========================================================
   MORNI — Smart Morning Ecosystem
   Complete app.js replacement
   Requires config.js to load before this file.
   ========================================================= */

(() => {
  "use strict";

  const CFG = window.MORNI_CONFIG || {};

  const STORE = "morni_v4_designer";
  const XP_STORE = "morni_v4_progress";
  const CONNECTION_STORE = "morni_connection_settings_v1";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const safe = value =>
    String(value ?? "").replace(/[&<>"']/g, char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[char]);

  const read = (key, fallback) => {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  };

  const write = (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.warn("MORNI could not save local data:", error);
    }
  };

  /* ---------------------------------------------------------
     CONNECTION SETTINGS
     --------------------------------------------------------- */

  const savedConnection = read(CONNECTION_STORE, {});

  // Demo-first default keeps MORNI fully presentable when the physical station is unfinished.
  // A previously saved, explicit live selection is still respected.
  let connectionMode = savedConnection.mode || "demo";

  if (!["demo", "live"].includes(connectionMode)) {
    connectionMode = "demo";
  }

  let deviceBaseUrl = String(
    savedConnection.deviceBaseUrl || CFG.deviceBaseUrl || ""
  ).trim().replace(/\/+$/, "");

  const isDemoMode = () => connectionMode === "demo";

  function saveConnectionSettings() {
    write(CONNECTION_STORE, {
      mode: connectionMode,
      deviceBaseUrl
    });
  }

  function endpoint(name, fallback) {
    return CFG.endpoints?.[name] || fallback;
  }

  function makeDeviceUrl(path) {
    if (!deviceBaseUrl) {
      throw new Error("Enter your ESP8266 IP address in Settings.");
    }

    const cleanPath = String(path || "").trim();

    if (/^https?:\/\//i.test(cleanPath)) {
      throw new Error("Use a device endpoint, not a full URL.");
    }

    return `${deviceBaseUrl}${cleanPath.startsWith("/") ? "" : "/"}${cleanPath}`;
  }

  function validDeviceAddress(value) {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        !!url.hostname &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }

  /* ---------------------------------------------------------
     DEVICE NETWORK REQUESTS
     --------------------------------------------------------- */

  async function request(path, options = {}) {
    // In LIVE mode MORNI uses the USB serial bridge, never an ESP8266 IP.
    if (connectionMode === "live") {
      const usb = window.MORNI_USB_BRIDGE;
      if (!usb || !usb.connected || typeof usb.request !== "function") {
        throw new Error("MORNI is set to USB hardware mode. Open Device Studio and click Connect MORNI by USB.");
      }
      return usb.request(path, options);
    }

    const url = makeDeviceUrl(path);
    const timeoutMs = Number(
      CFG.requestTimeoutMs || CFG.requestTimeout || 3500
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: options.method || "GET",
        headers: {
          Accept: "application/json",
          ...(options.headers || {})
        },
        signal: controller.signal,
        mode: "cors",
        cache: "no-store"
      });

      const bodyText = await response.text();
      let data = {};

      if (bodyText) {
        try {
          data = JSON.parse(bodyText);
        } catch {
          data = { message: bodyText };
        }
      }

      if (!response.ok) {
        throw new Error(
          data.error ||
          data.message ||
          `ESP8266 returned HTTP ${response.status}`
        );
      }

      return data;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("Connection timed out. Check the ESP8266 IP and Wi-Fi.");
      }

      if (error instanceof TypeError) {
        throw new Error(
          "Browser could not reach the ESP8266. Check Wi-Fi, IP address, CORS and browser local-network permissions."
        );
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function sendCommand(path, label) {
    if (isDemoMode()) {
      toast("Demo mode: no physical command was sent.");
      return false;
    }

    if (!state.device.online) {
      toast("Station is offline. No command was sent.");
      return false;
    }

    if (!state.device.hardwareReady) {
      toast("Hardware is not confirmed ready. Command locked.");
      return false;
    }

    try {
      await request(path);
      if (label) toast(label);
      return true;
    } catch (error) {
      state.device.lastError = error.message;
      save();
      updateConnection();
      toast(`Command failed: ${error.message}`);
      return false;
    }
  }

  /* ---------------------------------------------------------
     STATE AND MIGRATION
     --------------------------------------------------------- */

  const defaultState = () => ({
    profile: {
      name: CFG.defaultUser || "MORNI User",
      wakeTime: "06:30"
    },

    date: today(),
    theme: "light",

    routine: {
      started: false,
      complete: false,
      toothbrush: false,
      brushingComplete: false,
      handwash: false
    },

    checklist: {
      uniform: false,
      bag: false,
      bottle: false,
      homework: false
    },

    timer: {
      running: false,
      remaining: 120,
      endsAt: 0
    },

    streak: 0,
    bestStreak: 0,
    lastCompleteDate: "",
    history: [],

    counts: {
      handwash: 0,
      brush: 0
    },

    capacity: {
      handwash: Number(CFG.refill?.handwashCapacity || 250)
    },

    used: {
      handwash: 0
    },

    average: {
      handwash: Number(CFG.refill?.handwashPerUse || 2)
    },

    device: {
      online: false,
      ip: "Not connected",
      lastSeen: 0,
      hardwareReady: false,
      mode: "unknown",
      lastError: ""
    },

    activity: [],
    seenEvents: [],
    mode: "auto",
    startTime: null
  });

  const legacyState = read("morni_v3", null);
  const legacyXP = read("morni_plus_v1", null);

  const migratedState = legacyState ? {
    profile: legacyState.profile,
    date: legacyState.date,
    theme: legacyState.theme,

    routine: {
      started: !!(legacyState.routine?.brush || legacyState.routine?.handwash),
      complete: false,
      toothbrush: false,
      brushingComplete: !!legacyState.routine?.brush,
      handwash: !!legacyState.routine?.handwash
    },

    checklist: legacyState.checklist,
    streak: legacyState.streak,
    bestStreak: legacyState.bestStreak,
    lastCompleteDate: legacyState.lastCompleteDate,
    history: legacyState.history,

    counts: {
      handwash: legacyState.counts?.handwash || 0,
      brush: legacyState.counts?.brush || 0
    },

    capacity: {
      handwash: legacyState.capacity?.handwash || 250
    },

    used: {
      handwash: legacyState.used?.handwash || 0
    },

    average: {
      handwash: legacyState.average?.handwash || 2
    },

    activity: legacyState.activity
  } : {};

  let state = Object.assign(
    defaultState(),
    migratedState,
    read(STORE, {})
  );

  const fresh = defaultState();

  for (const key of [
    "profile",
    "routine",
    "checklist",
    "timer",
    "counts",
    "capacity",
    "used",
    "average",
    "device"
  ]) {
    state[key] = Object.assign({}, fresh[key], state[key] || {});
  }

  if (!Array.isArray(state.history)) state.history = [];
  if (!Array.isArray(state.activity)) state.activity = [];
  if (!Array.isArray(state.seenEvents)) state.seenEvents = [];

  if (state.date !== today()) {
    state.date = today();
    state.routine = { ...fresh.routine };
    state.checklist = { ...fresh.checklist };
    state.timer = { ...fresh.timer };
    state.startTime = null;
  }

  let xp = Object.assign(
    {
      points: 0,
      unlocked: [],
      missionDate: today(),
      missions: [],
      fullDays: 0
    },
    legacyXP ? {
      points: legacyXP.xp || 0,
      unlocked: legacyXP.unlocked || [],
      missionDate: legacyXP.missionDate || today(),
      missions: legacyXP.missionDone || [],
      fullDays: legacyXP.fullDays || 0
    } : {},
    read(XP_STORE, {})
  );

  if (!Array.isArray(xp.unlocked)) xp.unlocked = [];
  if (!Array.isArray(xp.missions)) xp.missions = [];

  if (xp.missionDate !== today()) {
    xp.missionDate = today();
    xp.missions = [];
  }

  let page = "home";
  let timerLoop = null;
  let pollLoop = null;
  let toastLoop = null;
  let pollBusy = false;

  /* ---------------------------------------------------------
     ROUTINE DATA
     --------------------------------------------------------- */

  const steps = [
    {
      id: "toothbrush",
      title: "Brush your teeth",
      detail: "A complete two-minute brushing session",
      icon: "✳",
      time: "02:00"
    },
    {
      id: "handwash",
      title: "Wash your hands",
      detail: "A fresh, clean finish",
      icon: "◌",
      time: "30 sec"
    }
  ];

  const missions = [
    {
      id: "start",
      title: "Start with intention",
      desc: "Activate your MORNI routine",
      test: () => state.routine.started
    },
    {
      id: "brush",
      title: "Two-minute focus",
      desc: "Finish your brushing session",
      test: () => state.routine.brushingComplete
    },
    {
      id: "clean",
      title: "Clean hands",
      desc: "Complete a handwash",
      test: () => state.counts.handwash > 0
    },
    {
      id: "school",
      title: "Ready to roll",
      desc: "Finish your school checklist",
      test: () => Object.values(state.checklist).every(Boolean)
    }
  ];

  const achievements = [
    ["first", "First light", "Start your first MORNI routine"],
    ["brush", "Two-minute club", "Complete your first brushing session"],
    ["hands", "Fresh hands", "Complete your first handwash"],
    ["routine", "Morning mastered", "Complete your first full routine"],
    ["streak3", "Consistency", "Build a 3-day routine streak"],
    ["streak7", "One week strong", "Build a 7-day streak"],
    ["school", "School-ready", "Complete your school checklist"],
    ["connected", "Connected", "Connect to your MORNI station"],
    ["xp100", "Century", "Earn 100 MORNI points"],
    ["streak14", "Two weeks strong", "Reach a 14-day streak"],
    ["streak30", "A month of mornings", "Reach a 30-day streak"],
    ["brush10", "Brushing regular", "Complete 10 brushing sessions"],
    ["brush25", "Brushing champion", "Complete 25 brushing sessions"],
    ["hands10", "Clean routine", "Complete 10 handwash events"],
    ["hands50", "Freshness expert", "Complete 50 handwash events"],
    ["routines5", "Getting consistent", "Complete 5 full routines"],
    ["routines10", "Habit builder", "Complete 10 full routines"],
    ["routines25", "Morning legend", "Complete 25 full routines"],
    ["xp500", "Rising star", "Earn 500 MORNI points"],
    ["xp1000", "MORNI elite", "Earn 1,000 MORNI points"],
    ["perfectweek", "Perfect week", "Complete seven mornings in a row"]
  ];

  const save = () => {
    write(STORE, state);
    write(XP_STORE, xp);
  };

  const fmt = seconds =>
    `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

  const time = value =>
    new Date(value).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    });

  const dateText = () =>
    new Date().toLocaleDateString([], {
      weekday: "long",
      month: "long",
      day: "numeric"
    });

  function toast(message) {
    let element = $("#toast");

    if (!element) {
      element = document.createElement("div");
      element.id = "toast";
      element.className = "toast";
      document.body.append(element);
    }

    element.textContent = message;
    element.classList.add("show");

    clearTimeout(toastLoop);

    toastLoop = setTimeout(() => {
      element.classList.remove("show");
    }, 2600);
  }

  function log(title, detail = "", kind = "activity") {
    state.activity.unshift({
      id: `${Date.now()}-${Math.random()}`,
      time: new Date().toISOString(),
      title,
      detail,
      kind
    });

    state.activity = state.activity.slice(0, 60);
    save();
  }

  function award(id, amount, label) {
    const key = `${id}-${today()}`;

    if (xp.missions.includes(key)) return;

    xp.missions.push(key);
    xp.points += amount;

    toast(`+${amount} MORNI points · ${label}`);
    save();
  }

  function unlock(id) {
    if (xp.unlocked.includes(id)) return;

    xp.unlocked.push(id);
    xp.points += 15;

    const achievement = achievements.find(item => item[0] === id);

    toast(`Achievement unlocked · ${achievement?.[1] || id}`);
    log("Achievement unlocked", achievement?.[1] || id, "achievement");
  }

  const level = () => Math.floor(Math.sqrt(xp.points / 40)) + 1;

  const nextXP = () =>
    Math.max(0, level() * level() * 40 - xp.points);

  const completed = () =>
    Number(state.routine.brushingComplete) +
    Number(state.routine.handwash);

  const progress = () =>
    Math.round(completed() / 2 * 100);

  function checkAchievements() {
    if (state.routine.started) unlock("first");
    if (state.routine.brushingComplete) unlock("brush");
    if (state.counts.handwash > 0) unlock("hands");
    if (completed() === 2) unlock("routine");

    if (state.streak >= 3) unlock("streak3");
    if (state.streak >= 7) unlock("streak7");
    if (state.streak >= 14) unlock("streak14");
    if (state.streak >= 30) unlock("streak30");

    if (Object.values(state.checklist).every(Boolean)) unlock("school");
    if (state.device.online) unlock("connected");

    if (state.counts.brush >= 10) unlock("brush10");
    if (state.counts.brush >= 25) unlock("brush25");
    if (state.counts.handwash >= 10) unlock("hands10");
    if (state.counts.handwash >= 50) unlock("hands50");

    if (state.history.length >= 5) unlock("routines5");
    if (state.history.length >= 10) unlock("routines10");
    if (state.history.length >= 25) unlock("routines25");

    if (state.history.length >= 7) {
      const lastSeven = state.history.slice(-7);
      const uniqueDays = new Set(lastSeven.map(item => item.date));

      if (uniqueDays.size === 7) unlock("perfectweek");
    }

    if (xp.points >= 100) unlock("xp100");
    if (xp.points >= 500) unlock("xp500");
    if (xp.points >= 1000) unlock("xp1000");

    missions.forEach(mission => {
      if (mission.test()) {
        award(`mission-${mission.id}`, 5, mission.title);
      }
    });
  }

  /* ---------------------------------------------------------
     ROUTINE ACTIONS
     --------------------------------------------------------- */

  function startRoutine(source = "app") {
    if (state.routine.started) return;

    state.routine.started = true;
    state.startTime = new Date().toISOString();

    log("MORNI routine started", source);
    award("start", 10, "Routine started");

    checkAchievements();
    save();
    render();

    toast("Your morning has officially started.");
  }

  function finishRoutineIfReady() {
    if (completed() !== 2 || state.routine.complete) return;

    state.routine.complete = true;

    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);

    const yesterday =
      `${yesterdayDate.getFullYear()}-${String(yesterdayDate.getMonth() + 1).padStart(2, "0")}-${String(yesterdayDate.getDate()).padStart(2, "0")}`;

    state.streak =
      state.lastCompleteDate === yesterday
        ? state.streak + 1
        : 1;

    state.bestStreak = Math.max(state.bestStreak, state.streak);
    state.lastCompleteDate = today();

    state.history.push({
      date: today(),
      score: 100
    });

    state.history = state.history.slice(-60);
    xp.fullDays++;

    award("complete", 30, "Morning routine complete");
    log("Morning routine completed", "All hygiene steps complete", "success");

    toast("Beautiful work. MORNI routine complete!");

    checkAchievements();
    save();
  }

  function completeBrush(source = "app") {
    if (state.routine.brushingComplete) return;

    state.routine.brushingComplete = true;
    state.routine.toothbrush = false;
    state.counts.brush++;

    state.timer = {
      running: false,
      remaining: 0,
      endsAt: 0
    };

    clearInterval(timerLoop);

    award("brush", 20, "Brushing complete");
    log("Brushing completed", source);

    finishRoutineIfReady();
    checkAchievements();
    save();
    render();
  }

  function markHandwash(source = "app") {
    if (state.routine.handwash) return;

    state.routine.handwash = true;
    state.counts.handwash++;

    state.used.handwash += Number(state.average.handwash || 2);

    award("handwash", 15, "Handwash complete");
    log("Handwash completed", source);

    finishRoutineIfReady();
    checkAchievements();
    save();
    render();
  }

  /* ---------------------------------------------------------
     TIMER
     --------------------------------------------------------- */

  function timerStart(source = "app") {
    if (state.timer.running || state.routine.brushingComplete) return;

    startRoutine(source);

    state.routine.toothbrush = true;
    state.timer.running = true;
    state.timer.endsAt = Date.now() + state.timer.remaining * 1000;

    log("Brushing timer started", "Two-minute session");

    if (!isDemoMode()) {
      sendCommand(endpoint("timerStart", "/timer?cmd=start"), "Timer command sent");
    }

    save();
    startTimerLoop();
    render();
  }

  function timerPause() {
    if (!state.timer.running) return;

    state.timer.remaining = Math.max(
      0,
      Math.ceil((state.timer.endsAt - Date.now()) / 1000)
    );

    state.timer.running = false;
    state.timer.endsAt = 0;

    clearInterval(timerLoop);

    if (!isDemoMode()) {
      sendCommand(endpoint("timerPause", "/timer?cmd=pause"), "Pause command sent");
    }

    save();
    render();
  }

  function timerReset() {
    state.timer = {
      running: false,
      remaining: 120,
      endsAt: 0
    };

    state.routine.toothbrush = false;

    clearInterval(timerLoop);

    if (!isDemoMode()) {
      sendCommand(endpoint("timerReset", "/timer?cmd=reset"), "Reset command sent");
    }

    save();
    render();
  }

  function startTimerLoop() {
    clearInterval(timerLoop);

    timerLoop = setInterval(() => {
      if (!state.timer.running) return;

      state.timer.remaining = Math.max(
        0,
        Math.ceil((state.timer.endsAt - Date.now()) / 1000)
      );

      const digits = $("#timerDigits");
      const ring = $("#timerProgress");

      if (digits) digits.textContent = fmt(state.timer.remaining);

      if (ring) {
        ring.style.setProperty(
          "--ring",
          `${(120 - state.timer.remaining) / 120 * 360}deg`
        );
      }

      if (state.timer.remaining <= 0) {
        completeBrush("timer");
      }
    }, 200);
  }

  let schoolSyncInFlight = null;
  let schoolSyncRequested = false;
  let schoolSyncFeedback = false;

  async function syncSchoolChecklistToLCD(options = {}) {
    const bridge = window.MORNI_USB_BRIDGE;
    if (!bridge?.connected || typeof bridge.send !== "function") {
      if (!options.silent) toast("Connect MORNI by USB in Device Studio first.");
      return false;
    }

    schoolSyncRequested = true;
    schoolSyncFeedback = schoolSyncFeedback || !options.silent;

    // Keep only one checklist transfer active at a time. If the user changes
    // several boxes quickly, send the latest complete snapshot after the
    // current transfer rather than interleaving serial commands.
    if (schoolSyncInFlight) return schoolSyncInFlight;

    schoolSyncInFlight = (async () => {
      let success = true;

      try {
        while (schoolSyncRequested) {
          schoolSyncRequested = false;

          const currentBridge = window.MORNI_USB_BRIDGE;
          if (!currentBridge?.connected || typeof currentBridge.send !== "function") {
            throw new Error("MORNI USB disconnected before checklist sync finished.");
          }

          const items = [
            ["Uniform", "uniform"],
            ["Bag", "bag"],
            ["Water", "bottle"],
            ["Homework", "homework"]
          ];

          const snapshot = items.map(([label, key]) => ({
            label,
            done: Boolean(state.checklist[key])
          }));

          for (let i = 0; i < snapshot.length; i++) {
            if (!currentBridge.connected) {
              throw new Error("MORNI USB disconnected during checklist sync.");
            }
            const item = snapshot[i];
            await currentBridge.send("SCHOOL", i, item.done ? 1 : 0, item.label);
          }
        }

        if (schoolSyncFeedback) toast("School checklist synced to MORNI's LCD.");
      } catch (error) {
        success = false;
        console.warn("MORNI school checklist LCD sync failed:", error);
        if (schoolSyncFeedback) {
          toast("LCD sync failed. Check USB and upload the updated MORNI firmware.");
        }
      } finally {
        schoolSyncFeedback = false;
        schoolSyncInFlight = null;
      }

      return success;
    })();

    return schoolSyncInFlight;
  }

  function toggleChecklist(id) {
    if (!(id in state.checklist)) return;

    state.checklist[id] = !state.checklist[id];

    if (Object.values(state.checklist).every(Boolean)) {
      award("school", 15, "School checklist complete");
      log("School checklist completed");
      checkAchievements();
    }

    save();
    render();

    if (window.MORNI_USB_BRIDGE?.connected) {
      syncSchoolChecklistToLCD({ silent: false });
    }
  }

  function simulateEvent(type) {
    if (!isDemoMode()) {
      toast("Switch to demo mode to preview simulated events.");
      return;
    }

    if (type === "start") {
      startRoutine("demo control");
    }

    if (type === "toothbrush") {
      if (state.routine.brushingComplete) {
        toast("Brushing is already complete today.");
        return;
      }

      state.timer.remaining = 120;
      timerStart("demo toothbrush pickup");
    }

    if (type === "handwash") {
      startRoutine("demo handwash");
      markHandwash("demo control");
    }

    if (type === "completeBrush") {
      completeBrush("demo control");
    }
  }

  /* ---------------------------------------------------------
     DEVICE EVENTS
     --------------------------------------------------------- */

  function processEvent(event) {
    if (!event || typeof event !== "object") return;

    const id = String(
      event.id ||
      event.eventId ||
      event.timestamp ||
      `${event.type}-${event.time || ""}`
    );

    if (state.seenEvents.includes(id)) return;

    state.seenEvents.push(id);
    state.seenEvents = state.seenEvents.slice(-150);

    const type = String(
      event.type || event.event || event.name || ""
    ).toLowerCase().replace(/[\s-]+/g, "_");

    const source = "ESP8266";

    if (
      type.includes("routine_started") ||
      type.includes("start_touched") ||
      type === "start"
    ) {
      startRoutine(source);
    } else if (
      type.includes("toothbrush_removed") ||
      type.includes("brush_pickup") ||
      type.includes("toothbrush_picked") ||
      type.includes("brushing_started")
    ) {
      if (!state.routine.brushingComplete) {
        startRoutine(source);
        state.routine.toothbrush = true;

        if (!state.timer.running) {
          state.timer.remaining = 120;
          timerStart(source);
        }
      }
    } else if (type.includes("brush_progress")) {
      const remaining = Number(
        event.remaining ?? event.secondsRemaining
      );

      if (Number.isFinite(remaining)) {
        state.timer.remaining = Math.max(
          0,
          Math.min(120, remaining)
        );

        if (state.timer.running) {
          state.timer.endsAt =
            Date.now() + state.timer.remaining * 1000;
        }
      }
    } else if (
      type.includes("brush_complete") ||
      type.includes("brushing_complete")
    ) {
      completeBrush(source);
    } else if (type.includes("handwash")) {
      markHandwash(source);
    } else if (type.includes("routine_complete")) {
      state.routine.brushingComplete = true;
      state.routine.handwash = true;
      finishRoutineIfReady();
    } else if (
      type.includes("toothbrush_placed") ||
      type.includes("brush_return")
    ) {
      state.routine.toothbrush = false;
      log("Toothbrush returned", source);
    }

    save();
  }

  /* ---------------------------------------------------------
     DEVICE POLLING
     --------------------------------------------------------- */

  async function pollDevice() {
    if (pollBusy) return;

    if (isDemoMode()) {
      state.device.online = false;
      state.device.hardwareReady = false;
      state.device.mode = "demo";
      state.device.ip = "Demo mode";
      state.device.lastError = "";

      updateConnection();

      if (page === "device" || page === "home") {
        refreshLiveBits();
      }

      return;
    }

    pollBusy = true;

    try {
      const data = await request(
        endpoint("status", "/status")
      );

      state.device.online = data.online !== false;
      state.device.lastSeen = Date.now();
      state.device.ip = deviceBaseUrl || "Connected";

      state.device.hardwareReady =
        data.hardwareConnected === true ||
        data.hardwareReady === true;

      state.device.mode = data.mode || "connected";
      state.device.lastError = "";

      if (Array.isArray(data.events)) {
        data.events.forEach(processEvent);
      }

      if (typeof data.toothbrushPresent === "boolean") {
        state.routine.toothbrush = data.toothbrushPresent;
      }

      if (
        typeof data.brushingRemaining === "number" &&
        state.timer.running
      ) {
        state.timer.remaining = Math.max(
          0,
          Math.min(120, data.brushingRemaining)
        );
      }

      try {
        const eventData = await request(
          endpoint("events", "/events")
        );

        if (Array.isArray(eventData.events)) {
          eventData.events.forEach(processEvent);
        }
      } catch (eventError) {
        // Status can still be useful even if the events endpoint fails.
        console.warn("MORNI events endpoint:", eventError.message);
      }

      checkAchievements();

    } catch (error) {
      state.device.lastError = error.message || "Unable to reach station";
      state.device.online = false;
      state.device.hardwareReady = false;
    } finally {
      pollBusy = false;

      save();
      updateConnection();

      if (page === "device" || page === "home") {
        refreshLiveBits();
      }
    }
  }

  function updateConnection() {
    const demo = isDemoMode();
    const online = !demo && state.device.online;

    const side = $("#sideConnection");

    if (side) {
      side.textContent = demo
        ? "Demo mode active"
        : online
          ? "ESP8266 connected"
          : "Device offline";
    }

    const ip = $("#sideIp");

    if (ip) {
      ip.textContent = demo
        ? "Hardware disconnected"
        : online
          ? "USB serial · ESP8266"
          : "Connect in Device Studio";
    }

    const dot = $("#sideDot");

    if (dot) {
      dot.classList.toggle("online", online);
    }

    const pill = $("#modePill");

    if (pill) {
      pill.textContent = demo ? "DEMO MODE" : "LIVE DEVICE";
      pill.classList.toggle("live", !demo);
    }

    const avatar = $("#avatar");

    if (avatar) {
      avatar.textContent = (state.profile.name || "M")
        .trim()
        .slice(0, 1)
        .toUpperCase();
    }
  }

  /* ---------------------------------------------------------
     UI HELPERS
     --------------------------------------------------------- */

  const card = (title, content, cls = "") =>
    `<section class="panel ${cls}">
      <div class="panel-heading"><h2>${title}</h2></div>
      ${content}
    </section>`;

  const progressBar = value =>
    `<div class="track">
      <span style="width:${Math.max(0, Math.min(100, value))}%"></span>
    </div>`;

  function greeting() {
    const hour = new Date().getHours();

    return hour < 11
      ? "Good morning"
      : hour < 17
        ? "Hello there"
        : "Good evening";
  }

  function coach() {
    if (state.routine.complete) {
      return "You did it. Your essentials are complete — take that fresh-start feeling into the day.";
    }

    if (!state.routine.started) {
      return "A calmer morning starts with one small action. Tap start when you're ready.";
    }

    if (!state.routine.brushingComplete) {
      return "Give your brushing session two focused minutes. MORNI will keep the time for you.";
    }

    if (!state.routine.handwash) {
      return "One last hygiene step: wash your hands and you're ready to go.";
    }

    return "One step at a time. You're building a routine that works for you.";
  }

  function miniTimeline() {
    if (!state.activity.length) {
      return `<div class="empty-state">
        <span class="empty-orbit">✦</span>
        <b>Your morning story starts here</b>
        <small>Routine events will appear here as you use MORNI.</small>
      </div>`;
    }

    return `<div class="activity-list">
      ${state.activity.slice(0, 5).map(item => `
        <div class="activity-row">
          <span class="activity-symbol">
            ${item.kind === "success" ? "✓" : item.kind === "achievement" ? "✧" : "•"}
          </span>
          <div>
            <b>${safe(item.title)}</b>
            <small>${safe(item.detail)}</small>
          </div>
          <time>${time(item.time)}</time>
        </div>
      `).join("")}
    </div>`;
  }

  
function twin() {
  const online = state.device.online;
  const ready = state.device.hardwareReady;
  const brushing = state.timer.running;
  const complete = state.routine.complete;

  const screenTitle = complete
    ? "ROUTINE COMPLETE"
    : brushing
      ? "BRUSHING IN PROGRESS"
      : state.routine.started
        ? "MORNING IN MOTION"
        : "READY WHEN YOU ARE";

  const screenTime = brushing
    ? fmt(Math.max(0, Math.ceil((state.timer.endsAt - Date.now()) / 1000)))
    : new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      });

  return `
    <div style="
      position:relative;
      width:100%;
      min-height:300px;
      padding:18px 10px;
      display:flex;
      align-items:center;
      justify-content:center;
      overflow:hidden;
      border-radius:18px;
      background:linear-gradient(145deg,#e9f3e9,#f8edda);
      isolation:isolate;
    ">
      <div style="
        position:absolute;
        width:230px;height:230px;
        border-radius:50%;
        background:rgba(235,174,75,.19);
        filter:blur(3px);
        top:30px;left:50%;
        transform:translateX(-50%);
      "></div>

      <div style="
        position:absolute;
        width:260px;height:260px;
        border:1px solid rgba(48,103,68,.16);
        border-radius:50%;
        top:20px;left:50%;
        transform:translateX(-50%);
      "></div>

      <div style="
        position:absolute;
        width:205px;height:205px;
        border:1px dashed rgba(48,103,68,.20);
        border-radius:50%;
        top:48px;left:50%;
        transform:translateX(-50%);
      "></div>

      <div style="
        position:relative;
        z-index:1;
        width:min(100%,260px);
        filter:drop-shadow(0 16px 18px rgba(26,61,39,.17));
      ">
        <svg viewBox="0 0 300 310"
          role="img"
          aria-label="MORNI smart morning station illustration"
          style="display:block;width:100%;height:auto;overflow:visible">

          <defs>
            <linearGradient id="morniTwinBody" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#fffdf5"/>
              <stop offset="1" stop-color="#dce9d9"/>
            </linearGradient>

            <linearGradient id="morniTwinScreen" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#183e2d"/>
              <stop offset="1" stop-color="#0d281d"/>
            </linearGradient>

            <linearGradient id="morniTwinBottle" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#f4c16e"/>
              <stop offset="1" stop-color="#df8c3e"/>
            </linearGradient>
          </defs>

          <ellipse cx="150" cy="286" rx="112" ry="12"
            fill="#234c35" opacity=".13"/>

          <rect x="24" y="105" width="35" height="104" rx="13"
            fill="#d4e3d2" stroke="#a8c3a8" stroke-width="2"/>
          <rect x="241" y="105" width="35" height="104" rx="13"
            fill="#d4e3d2" stroke="#a8c3a8" stroke-width="2"/>

          <circle cx="41.5" cy="123" r="5" fill="#e9a84c"/>
          <circle cx="258.5" cy="123" r="5" fill="#e9a84c"/>

          <rect x="47" y="36" width="206" height="240" rx="30"
            fill="url(#morniTwinBody)"
            stroke="#b4cbb4"
            stroke-width="3"/>

          <path d="M77 36 H223 Q253 36 253 66 V83 H47 V66 Q47 36 77 36Z"
            fill="#244d35"/>

          <text x="150" y="65"
            text-anchor="middle"
            font-size="16"
            font-weight="800"
            letter-spacing="3"
            fill="#fff9e9">MORNI</text>

          <circle cx="225" cy="59" r="5"
            fill="${online ? "#7ee09a" : "#e8a84c"}"/>

          <rect x="67" y="99" width="166" height="82" rx="12"
            fill="url(#morniTwinScreen)"
            stroke="#91ad8f"
            stroke-width="3"/>

          <text x="150" y="120"
            text-anchor="middle"
            font-size="8"
            font-weight="700"
            letter-spacing="1.3"
            fill="#b9d8b6">SMART MORNING STATION</text>

          <text x="150" y="143"
            text-anchor="middle"
            font-size="${screenTitle.length > 17 ? "9" : "11"}"
            font-weight="800"
            fill="#fff5dc">${screenTitle}</text>

          <text x="150" y="165"
            text-anchor="middle"
            font-size="17"
            font-weight="700"
            fill="#f3bd68">${screenTime}</text>

          <circle cx="119" cy="198" r="5"
            fill="${state.routine.brushingComplete ? "#4a9b61" : "#c5d6c3"}"/>
          <circle cx="150" cy="198" r="5"
            fill="${state.routine.handwash ? "#4a9b61" : "#c5d6c3"}"/>
          <circle cx="181" cy="198" r="5"
            fill="${ready ? "#4a9b61" : "#e2a14c"}"/>

          <rect x="69" y="218" width="162" height="40" rx="12"
            fill="#e3eddf" stroke="#c2d5bf"/>

          <text x="150" y="234"
            text-anchor="middle"
            font-size="8"
            font-weight="800"
            letter-spacing="1"
            fill="#315b3d">YOUR MORNING COMPANION</text>

          <text x="150" y="248"
            text-anchor="middle"
            font-size="8"
            fill="#64806a">${online ? (ready ? "HARDWARE READY" : "DEVICE CONNECTED") : "STATION PREVIEW"}</text>

          <path d="M145 86 C130 75 134 65 150 69 C164 73 162 84 145 86Z"
            fill="#e9a84c"/>
          <path d="M145 85 Q148 77 155 73"
            fill="none" stroke="#fff2d6" stroke-width="1.5"/>

          <g transform="translate(4 172)">
            <rect x="5" y="0" width="27" height="10" rx="3"
              fill="#315b3d"/>
            <rect x="1" y="9" width="35" height="79" rx="10"
              fill="url(#morniTwinBottle)"
              stroke="#c77e39" stroke-width="2"/>
            <rect x="6" y="31" width="25" height="29" rx="5"
              fill="#fff4dc" opacity=".95"/>
            <text x="18.5" y="43" text-anchor="middle"
              font-size="6" font-weight="800" fill="#315b3d">HAND</text>
            <text x="18.5" y="51" text-anchor="middle"
              font-size="6" font-weight="800" fill="#315b3d">WASH</text>
          </g>

          <g transform="translate(261 174) rotate(9)">
            <rect x="6" y="0" width="13" height="16" rx="4"
              fill="#315b3d"/>
            <path d="M5 15 H20 L18 91 Q12 99 7 91Z"
              fill="#e6a34d" stroke="#bd7b38" stroke-width="1.5"/>
            <path d="M6 4 H19" stroke="#fff1d1" stroke-width="2"/>
            <path d="M8 1 V-5 M12 1 V-6 M16 1 V-5"
              stroke="#fff8e9" stroke-width="2" stroke-linecap="round"/>
          </g>
        </svg>
      </div>

      <div style="
        position:absolute;
        left:12px;bottom:12px;
        padding:6px 9px;
        border-radius:20px;
        background:rgba(255,255,255,.78);
        color:#315b3d;
        font-size:9px;
        font-weight:800;
        letter-spacing:.5px;
      ">
        ${online ? "● DEVICE ONLINE" : "○ DIGITAL PREVIEW"}
      </div>

      <div style="
        position:absolute;
        right:12px;bottom:12px;
        padding:6px 9px;
        border-radius:20px;
        background:rgba(255,255,255,.78);
        color:#315b3d;
        font-size:9px;
        font-weight:800;
      ">
        ${ready ? "HARDWARE READY" : "PREVIEW"}
      </div>
    </div>
  `;
}


  /* ---------------------------------------------------------
     HOME PAGE
     --------------------------------------------------------- */

  function home() {
    const pct = progress();

    const xpPct = Math.round(
      (xp.points - (level() - 1) ** 2 * 40) /
      (level() ** 2 * 40 - (level() - 1) ** 2 * 40) * 100
    );

    return `<div class="page-enter">

      <section class="welcome-hero">
        <div class="hero-copy">
          <div class="eyebrow">
            <span class="eyebrow-dot"></span>
            YOUR PERSONAL MORNING SYSTEM
            <span class="eyebrow-line"></span>
          </div>

          <h1>${greeting()},<br/><em>${safe(state.profile.name.split(" ")[0] || "friend")}.</em></h1>

          <p>
            ${dateText()}
            <span class="hero-separator">·</span>
            ${safe(coach())}
          </p>

          <div class="hero-actions">
            <button class="btn btn-primary" data-action="start-routine">
              ${state.routine.started ? "Routine in progress" : "Start my morning"}
              <span>↗</span>
            </button>

            <button class="btn btn-ghost" data-page="routine">
              View routine <span>→</span>
            </button>
          </div>

          <div class="hero-footnote">
            <span class="live-pulse"></span>
            ${state.device.online
              ? "MORNI station is on your network"
              : "Your morning companion is ready"}
          </div>
        </div>

        <div class="hero-art">
          <div class="sun-disc">
            <div class="sun-core"></div>
            <div class="sun-ray ray-1"></div>
            <div class="sun-ray ray-2"></div>
            <div class="sun-ray ray-3"></div>
            <div class="sun-ray ray-4"></div>
            <div class="sun-horizon"></div>
          </div>

          <div class="hero-leaf leaf-a">✦</div>
          <div class="hero-leaf leaf-b">✧</div>

          <div class="hero-art-label">
            A FRESH START<br/><b>EVERY DAY</b>
          </div>
        </div>

        <div class="hero-grain"></div>
      </section>

      <div class="metric-strip">
        <div class="metric">
          <span class="metric-icon">◉</span>
          <div>
            <small>TODAY'S PROGRESS</small>
            <b>${pct}%</b>
            <span>${completed()}/2 essentials</span>
          </div>
        </div>

        <div class="metric">
          <span class="metric-icon orange">↗</span>
          <div>
            <small>CURRENT STREAK</small>
            <b>${state.streak} <i>days</i></b>
            <span>Best: ${state.bestStreak} days</span>
          </div>
        </div>

        <div class="metric">
          <span class="metric-icon violet">✧</span>
          <div>
            <small>MORNI POINTS</small>
            <b>${xp.points}</b>
            <span>Level ${level()} · ${nextXP()} to next</span>
          </div>
        </div>

        <div class="metric">
          <span class="metric-icon blue">⌁</span>
          <div>
            <small>STATION STATUS</small>
            <b class="metric-status ${state.device.online ? "is-online" : ""}">
              ${state.device.online ? "Online" : "Offline"}
            </b>
            <span>${state.device.hardwareReady
              ? "Hardware ready"
              : "Hardware integration pending"}</span>
          </div>
        </div>
      </div>

      <div class="morni-home-launch">
        <div><span class="morni-kicker">THE NEXT MORNING, REIMAGINED</span><b>Explore the MORNI experience</b><small>Guided hygiene, adaptive planning, rewards and a judge-ready product tour.</small></div>
        <button class="btn btn-primary" data-page="home">Go to Home ↗</button>
      </div>

      <div class="dashboard-grid">
        <div class="dashboard-main">

          ${card("Your morning, made simple", `
            <div class="section-intro">
              <span>THE ESSENTIALS</span>
              <b>${completed()}/2 complete</b>
            </div>

            ${progressBar(pct)}

            <div class="routine-cards">
              ${steps.map(step => {
                const done = step.id === "toothbrush"
                  ? state.routine.brushingComplete
                  : state.routine.handwash;

                const active =
                  step.id === "toothbrush" && state.timer.running;

                return `
                  <button class="routine-tile ${done ? "is-done" : ""} ${active ? "is-active" : ""}"
                    data-page="routine">
                    <span class="routine-tile-icon">${step.icon}</span>
                    <span class="routine-tile-copy">
                      <b>${step.title}</b>
                      <small>${done ? "Completed" : active ? "In progress" : "Ready when you are"}</small>
                    </span>
                    <span class="routine-tile-state">
                      ${done ? "✓" : active ? "···" : "↗"}
                    </span>
                  </button>
                `;
              }).join("")}
            </div>

            <button class="text-link" data-page="routine">
              Open my routine <span>→</span>
            </button>
          `)}

          ${card("Your morning timeline", miniTimeline())}
        </div>

        <div class="dashboard-side">
          ${card("MORNI · digital twin", twin(), "twin-panel")}

          ${card("A little nudge", `
            <div class="coach-card">
              <span class="coach-spark">✳</span>
              <div>
                <b>Today's thought</b>
                <p>${safe(coach())}</p>
              </div>
            </div>

            <div class="xp-mini">
              <div>
                <small>LEVEL ${level()}</small>
                <b>${xp.points} <i>PTS</i></b>
              </div>
              ${progressBar(xpPct)}
            </div>
          `)}
        </div>
      </div>
    </div>`;
  }

  /* ---------------------------------------------------------
     ROUTINE PAGE
     --------------------------------------------------------- */

 
function routine() {
  const remaining = state.timer.running
    ? Math.max(0, Math.ceil((state.timer.endsAt - Date.now()) / 1000))
    : state.timer.remaining;

  return `<div class="page-enter">

    <div class="page-title-row">
      <div>
        <div class="eyebrow">YOUR DAILY FLOW</div>
        <h1>My routine<span class="title-period">.</span></h1>
        <p>Two essentials. One better start.</p>
      </div>

      <span class="date-chip">◷ ${dateText()}</span>
    </div>

    <div class="routine-layout">
      <div>
        ${card("The essentials", `
          <div class="large-step ${state.routine.brushingComplete ? "complete" : ""}">
            <div class="large-step-icon">✳</div>
            <div class="large-step-copy">
              <span>01 / BRUSHING</span>
              <h3>Two minutes for you.</h3>
              <p>Pick up your toothbrush to begin. Your station detects the pickup and starts the timer.</p>
              <div class="step-state">
                ${state.routine.brushingComplete
                  ? "✓ Completed"
                  : state.timer.running
                    ? "● Timer running"
                    : "○ Waiting for toothbrush"}
              </div>
            </div>
          </div>

          <div class="large-step ${state.routine.handwash ? "complete" : ""}">
            <div class="large-step-icon orange-icon">◌</div>
            <div class="large-step-copy">
              <span>02 / HANDWASH</span>
              <h3>Finish fresh.</h3>
              <p>Your station detects your hand and dispenses handwash automatically.</p>
              <div class="step-state">
                ${state.routine.handwash ? "✓ Completed" : "○ Waiting for handwash event"}
              </div>
            </div>
          </div>

          <div class="routine-footer">
            <span>${completed()} of 2 essentials complete</span>
            <b>${progress()}%</b>
          </div>

          ${progressBar(progress())}
        `)}

        ${card("School-day checklist", checklistMarkup())}
      </div>

      <div>
        ${card("Brushing timer", `
          <div class="timer-face">
            <div class="timer-orbit"></div>

            <div class="timer-ring" id="timerProgress"
              style="--ring:${(120 - remaining) / 120 * 360}deg">
              <div class="timer-center">
                <b id="timerDigits">${fmt(remaining)}</b>
                <small>${state.timer.running ? "BRUSHING" : "TWO-MINUTE TIMER"}</small>
              </div>
            </div>
          </div>

          <div class="timer-message">
            ${state.timer.running
              ? "Stay with it. You're doing great."
              : state.routine.brushingComplete
                ? "Brushing complete. Great work!"
                : "Ready when your toothbrush is picked up."}
          </div>

          <div class="timer-controls">
            <button class="btn btn-primary" data-action="timer-start"
              ${state.timer.running || state.routine.brushingComplete ? "disabled" : ""}>
              ${state.timer.running ? "Running" : "Start timer"}
            </button>

            <button class="btn btn-soft" data-action="timer-pause"
              ${!state.timer.running ? "disabled" : ""}>
              Pause
            </button>

            <button class="btn btn-soft" data-action="timer-reset">
              Reset
            </button>
          </div>

          <div class="timer-note">
            ${isDemoMode()
              ? "Demo timer · hardware pickup will start this automatically when connected"
              : "Live mode · timer commands sync only when firmware reports hardware readiness"}
          </div>
        `)}

        ${card("Routine status", `
          <div class="status-line">
            <span>Routine activation</span>
            <b>${state.routine.started ? "Started" : "Not started"}</b>
          </div>

          <div class="status-line">
            <span>Toothbrush holder</span>
            <b>${state.routine.toothbrush ? "Picked up" : "In holder / unknown"}</b>
          </div>

          <div class="status-line">
            <span>Handwash station</span>
            <b>${state.routine.handwash ? "Used" : "Awaiting event"}</b>
          </div>
        `)}

        ${isDemoMode() ? card("Demo controls", `
          <p class="body-copy">
            Preview the complete morning routine without physical hardware.
            These controls only simulate events in the app.
          </p>

          <div class="timer-controls">
            <button class="btn btn-primary" data-action="demo-start">
              ▶ Simulate START
            </button>

            <button class="btn btn-soft" data-action="demo-brush">
              ✳ Simulate toothbrush pickup
            </button>

            <button class="btn btn-soft" data-action="demo-complete-brush">
              ✓ Complete brushing
            </button>

            <button class="btn btn-soft" data-action="demo-handwash">
              ◌ Simulate handwash
            </button>
          </div>
        `) : ""}
      </div>
    </div>
  </div>`;
}

  function checklistMarkup() {
    const items = [
      ["uniform", "Uniform ready", "A quick outfit check"],
      ["bag", "School bag packed", "Books, notes and essentials"],
      ["bottle", "Water bottle filled", "Keep hydration close"],
      ["homework", "Homework checked", "Everything ready to go"]
    ];

    return `<div class="checklist">
      ${items.map(([id, title, detail]) => `
        <label class="check-item">
          <input type="checkbox" data-check="${id}"
            ${state.checklist[id] ? "checked" : ""}/>
          <span class="check-custom">✓</span>
          <span>
            <b>${title}</b>
            <small>${detail}</small>
          </span>
        </label>
      `).join("")}
    </div>`;
  }

  /* ---------------------------------------------------------
     DEVICE PAGE
     --------------------------------------------------------- */

  function device() {
    return `<div class="page-enter">

      <div class="page-title-row">
        <div>
          <div class="eyebrow">THE CONNECTED STATION</div>
          <h1>Device studio<span class="title-period">.</span></h1>
          <p>One connected experience, from station to screen.</p>
        </div>

        <button class="btn btn-soft" data-action="check-device">
          ↻ Check connection
        </button>
      </div>

      <section id="morniUsbPanel" style="margin:18px 0;padding:20px;border:1px solid #cbd8c7;border-radius:18px;background:var(--card-bg,#fff);color:var(--text,inherit)">
        <div style="font-size:11px;letter-spacing:2px;font-weight:800;color:#b77935">MORNI · DIRECT USB LINK</div>
        <h2 style="margin:6px 0 4px">Connect your physical station</h2>
        <p style="margin:0 0 12px;opacity:.75">Keep your laptop connected to SNIT. The ESP8266 communicates through its USB cable, not a second Wi-Fi network.</p>
        <button type="button" id="morniUsbConnect" style="padding:11px 16px;border:0;border-radius:10px;background:#347b45;color:white;font-weight:700">Connect MORNI by USB</button>
        <button type="button" id="morniUsbDisconnect" style="padding:11px 16px;border:0;border-radius:10px">Disconnect</button>
        <p id="morniUsbStatus" role="status" style="font-weight:700;margin:12px 0">Not connected. Close Arduino Serial Monitor before connecting.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0">
          <button type="button" data-morni-command="start">Wake MORNI</button>
          <button type="button" data-morni-command="paste">Start paste</button>
          <button type="button" data-morni-command="brush">Start 2-min brush</button>
          <button type="button" data-morni-command="pause">Pause</button>
          <button type="button" data-morni-command="resume">Resume</button>
          <button type="button" data-morni-command="reset">Reset</button>
          <button type="button" data-morni-display="on">LCD ON</button>
          <button type="button" data-morni-display="off">LCD OFF</button>
          <button type="button" id="morniUsbClock">Sync RTC from laptop</button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin-top:14px">
          <div style="padding:14px;border:1px solid #ddd;border-radius:12px">
            <b>LCD message</b>
            <input id="morniUsbMessage" maxlength="16" placeholder="Max 16 characters" style="display:block;width:100%;box-sizing:border-box;padding:10px;margin:8px 0">
            <button type="button" id="morniUsbSendMessage">Send to LCD</button>
          </div>
          <div style="padding:14px;border:1px solid #ddd;border-radius:12px">
            <b>Schedule a meeting / task reminder</b>
            <input id="morniUsbWhen" type="datetime-local" style="display:block;width:100%;box-sizing:border-box;padding:10px;margin:8px 0">
            <input id="morniUsbReminderText" maxlength="16" placeholder="e.g. Meeting 10:30 (16 chars)" style="display:block;width:100%;box-sizing:border-box;padding:10px;margin:8px 0">
            <button type="button" id="morniUsbAddReminder">Save reminder to MORNI</button>
            <small style="display:block;margin-top:7px;opacity:.7">Up to 5 meeting or task reminders are stored on the ESP8266. The LCD displays each one when it is due, even after the laptop is disconnected.</small>
          </div>
        </div>
        <div style="margin-top:12px"><b>Upcoming reminders</b><div id="morniUsbReminderList"></div></div>
        <div id="morniUsbLive" style="margin-top:12px;padding:10px;border-radius:10px;background:rgba(80,130,80,.08)">Hardware status: waiting for connection</div>
      </section>

      <div class="device-hero-grid">

        ${card("Connection overview", `
          <div class="connection-visual">
            <span class="connection-icon ${state.device.online ? "online" : ""}">⌁</span>

            <div>
              <b>${state.device.online ? "ESP8266 connected" : isDemoMode() ? "Demo mode active" : "Station offline"}</b>
              <small>${safe(state.device.ip)}</small>
            </div>

            <span class="connection-badge ${state.device.online ? "ok" : "bad"}">
              ${state.device.online ? "ONLINE" : isDemoMode() ? "DEMO" : "OFFLINE"}
            </span>
          </div>

          <div class="status-line">
            <span>Last response</span>
            <b>${state.device.lastSeen ? time(state.device.lastSeen) : "Not yet checked"}</b>
          </div>

          <div class="status-line">
            <span>Firmware-reported hardware</span>
            <b>${state.device.hardwareReady ? "Ready" : "Integration pending"}</b>
          </div>

          <div class="status-line">
            <span>Operating mode</span>
            <b>${safe(state.device.mode)}</b>
          </div>

          ${state.device.lastError
            ? `<p class="error-note">${safe(state.device.lastError)}</p>`
            : ""}
        `)}

        ${card("Digital twin", twin(), "twin-panel")}
      </div>

      <div class="dashboard-grid device-lower">
        <div>
          ${card("Station components", `
            <div class="component-row">
              <span class="component-glyph">⌁</span>
              <div>
                <b>ESP8266 NodeMCU microcontroller</b>
                <small>Runs MORNI and links the website to the physical station over USB</small>
              </div>
              <em class="pending-pill">Awaiting hardware</em>
            </div>

            <div class="component-row">
              <span class="component-glyph">✳</span>
              <div>
                <b>Toothbrush holder IR sensor</b>
                <small>Detects toothbrush pickup and return</small>
              </div>
              <em class="pending-pill">Awaiting hardware</em>
            </div>

            <div class="component-row">
              <span class="component-glyph">◉</span>
              <div>
                <b>START touch sensor</b>
                <small>Wakes MORNI and activates the routine</small>
              </div>
              <em class="pending-pill">Awaiting hardware</em>
            </div>

            <div class="component-row">
              <span class="component-glyph">▤</span>
              <div>
                <b>16×2 LCD + DS3231 RTC</b>
                <small>Live clock, scrolling demo news, countdowns and scheduled reminders</small>
              </div>
              <em class="pending-pill">Awaiting hardware</em>
            </div>
          `)}

          ${card("Hardware integration notes", `
            <p class="body-copy">
              A successful USB connection confirms serial communication with the ESP8266.
              The firmware separately reports whether the RTC and LCD are available.
            </p>

            <div class="notice-box">
              <span>ⓘ</span>
              <p>
                The physical commands remain locked until the firmware reports
                <b>hardwareConnected: true</b> or <b>hardwareReady: true</b>.
              </p>
            </div>
          `)}
        </div>

        <div>
          ${card("Safe command preview", `
            <p class="body-copy">
              ${state.device.hardwareReady
                ? "Firmware reports hardware readiness. Only configured commands can be sent."
                : "These controls are locked until the station reports hardware readiness."}
            </p>

            <button class="command-row" disabled>
              <span>🧼</span>
              <b>School checklist LCD sync</b>
              <small>Send Uniform, Bag, Water and Homework status to the LCD</small>
            </button>

            <button class="command-row" disabled>
              <span>✳</span>
              <b>Meeting and task reminders</b>
              <small>Schedule up to five reminders for the ESP8266 LCD</small>
            </button>

            <button class="command-row" disabled>
              <span>◉</span>
              <b>Touch-activated morning routine</b>
              <small>The physical touch sensor starts MORNI's morning sequence</small>
            </button>
          `)}

          ${isDemoMode() ? card("Demo controls", `
            <p class="body-copy">
              These simulate app events only. They do not control physical hardware.
            </p>

            <button class="btn btn-soft" data-action="demo-start">
              Simulate START
            </button>

            <button class="btn btn-soft" data-action="demo-brush">
              Simulate toothbrush pickup
            </button>

            <button class="btn btn-soft" data-action="demo-handwash">
              Simulate handwash
            </button>

            <button class="btn btn-soft" data-action="demo-complete-brush">
              Complete brushing
            </button>
          `) : ""}
        </div>
      </div>
    </div>`;
  }

  /* ---------------------------------------------------------
     SCHOOL PAGE
     --------------------------------------------------------- */

  function school() {
    const items = [
      ["uniform", "Uniform ready", "A quick outfit check"],
      ["bag", "School bag packed", "Books, notes and essentials"],
      ["bottle", "Water bottle filled", "Keep hydration close"],
      ["homework", "Homework checked", "Everything ready to go"]
    ];

    const count = Object.values(state.checklist).filter(Boolean).length;

    return `<div class="page-enter">

      <div class="page-title-row">
        <div>
          <div class="eyebrow">BEYOND THE BATHROOM</div>
          <h1>School prep<span class="title-period">.</span></h1>
          <p>Leave the house feeling ready, not rushed.</p>
        </div>

        <div class="date-chip">${count}/4 READY</div>
      </div>

      <div class="school-layout">
        ${card("Your departure checklist", `
          <div class="school-progress">
            <b>${Math.round(count / 4 * 100)}%</b>
            <span>ready to go</span>
            ${progressBar(count / 4 * 100)}
          </div>

          <div class="checklist">
            ${items.map(([id, title, detail]) => `
              <label class="check-item">
                <input type="checkbox" data-check="${id}"
                  ${state.checklist[id] ? "checked" : ""}/>
                <span class="check-custom">✓</span>
                <span>
                  <b>${title}</b>
                  <small>${detail}</small>
                </span>
              </label>
            `).join("")}
          </div>
          <button class="btn btn-primary" data-action="sync-school-lcd" style="margin-top:14px">
            ↗ Sync checklist to MORNI LCD
          </button>
          <p class="muted" style="margin:8px 0 0">MORNI will show the next unfinished item. When all four are checked, the LCD celebrates: SCHOOL READY!</p>
        `)}

        ${card("A calmer exit", `
          <div class="exit-card">
            <span>✧</span>
            <h3>Give yourself a 5-minute buffer.</h3>
            <p>
              Pack the essentials before you start getting ready.
              A little preparation makes the morning feel lighter.
            </p>
          </div>
        `)}
      </div>
    </div>`;
  }

  /* ---------------------------------------------------------
     INSIGHTS, MISSIONS AND ACHIEVEMENTS
     --------------------------------------------------------- */

  function missionPanel() {
    return `<div class="mission-grid">
      ${missions.map(mission => {
        const done = mission.test();

        return `
          <div class="mission-card ${done ? "mission-done" : ""}">
            <div class="mission-icon">${done ? "✓" : "✧"}</div>
            <div class="mission-copy">
              <b>${mission.title}</b>
              <small>${mission.desc}</small>
            </div>
            <span class="mission-reward">${done ? "DONE" : "+5 XP"}</span>
          </div>
        `;
      }).join("")}
    </div>`;
  }

  function insights() {
    const fullDays = state.history.length;

    const days = Array.from({ length: 7 }, (_, index) => {
      const date = new Date();
      date.setDate(date.getDate() - 6 + index);

      const key =
        `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

      return {
        label: date.toLocaleDateString([], { weekday: "short" }),
        done: state.history.some(item => item.date === key)
      };
    });

    const calendar = Array.from({ length: 28 }, (_, index) => {
      const date = new Date();
      date.setDate(date.getDate() - 27 + index);

      const key =
        `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

      return {
        label: date.getDate(),
        done: state.history.some(item => item.date === key)
      };
    });

    const xpPct = Math.max(0, Math.min(100,
      Math.round(
        (xp.points - (level() - 1) ** 2 * 40) /
        (level() ** 2 * 40 - (level() - 1) ** 2 * 40) * 100
      )
    ));

    const earned = achievements.filter(item =>
      xp.unlocked.includes(item[0])
    ).length;

    return `<div class="page-enter">

      <div class="page-title-row">
        <div>
          <div class="eyebrow">YOUR MORNI JOURNEY</div>
          <h1>Your insights<span class="title-period">.</span></h1>
          <p>Every small action is part of something bigger.</p>
        </div>

        <span class="date-chip">LEVEL ${level()} · ${xp.points} XP</span>
      </div>

      <div class="level-showcase panel">
        <div class="level-orb">
          <span>${level()}</span>
          <small>LEVEL</small>
        </div>

        <div class="level-info">
          <div class="level-heading">
            <b>Your MORNI journey</b>
            <span>${nextXP()} XP to next level</span>
          </div>

          ${progressBar(xpPct)}
          <small>${xp.points} total MORNI points earned</small>
        </div>
      </div>

      <div class="insight-metrics">
        ${card("Completed mornings", `
          <b class="insight-number">${fullDays}</b>
          <small>Your recorded full routines</small>
        `)}

        ${card("Current streak", `
          <b class="insight-number">${state.streak}<i> days</i></b>
          <small>Personal best: ${state.bestStreak} days</small>
        `)}

        ${card("Achievements", `
          <b class="insight-number">${earned}<i> / ${achievements.length}</i></b>
          <small>Milestones unlocked</small>
        `)}
      </div>

      <div class="insight-layout">
        ${card("Your last seven days", `
          <div class="week-chart">
            ${days.map(day => `
              <div class="week-day">
                <div class="week-bar ${day.done ? "done" : ""}">
                  <span>${day.done ? "✓" : "·"}</span>
                </div>
                <small>${day.label}</small>
              </div>
            `).join("")}
          </div>

          <p class="chart-caption">
            Completed mornings are highlighted.
          </p>
        `)}

        ${card("Your activity calendar", `
          <p class="body-copy">
            Your last 28 days of recorded routine activity.
          </p>

          <div class="activity-calendar">
            ${calendar.map(day => `
              <div class="calendar-day ${day.done ? "calendar-done" : ""}"
                title="${day.label}${day.done ? " · Completed" : " · No completed routine"}">
                ${day.label}
              </div>
            `).join("")}
          </div>

          <div class="calendar-legend">
            <span></span> Completed morning
            <span class="legend-empty"></span> Not completed
          </div>
        `)}
      </div>

      ${card("Today's missions", missionPanel())}

      ${card("Achievement collection", `
        <div class="achievement-summary">
          <b>${earned} achievements unlocked</b>
          <span>${achievements.length - earned} still waiting</span>
        </div>

        ${progressBar(earned / achievements.length * 100)}

        <div class="achievement-grid">
          ${achievements.map(item => {
            const unlocked = xp.unlocked.includes(item[0]);

            return `
              <div class="achievement ${unlocked ? "earned" : "locked"}">
                <span>${unlocked ? "✧" : "◇"}</span>
                <div>
                  <b>${item[1]}</b>
                  <small>${item[2]}</small>
                  <small>${unlocked ? "UNLOCKED" : "NOT YET UNLOCKED"}</small>
                </div>
              </div>
            `;
          }).join("")}
        </div>
      `)}

      ${card("Recent activity", miniTimeline())}
    </div>`;
  }

  /* ---------------------------------------------------------
     SETTINGS PAGE
     --------------------------------------------------------- */

  function settings() {
    const demo = isDemoMode();

    return `<div class="page-enter">

      <div class="page-title-row">
        <div>
          <div class="eyebrow">MAKE MORNI YOURS</div>
          <h1>Settings<span class="title-period">.</span></h1>
          <p>Your preferences stay on this browser.</p>
        </div>
      </div>

      <div class="settings-layout">

        ${card("Device connection", `
          <p class="body-copy">
            Choose how MORNI connects to your physical station.
          </p>

          <label class="field-label">
            Connection mode
            <select class="field-input" id="connectionMode">
              <option value="demo" ${demo ? "selected" : ""}>Demo mode</option>
              <option value="live" ${!demo ? "selected" : ""}>USB hardware (ESP8266)</option>
            </select>
          </label>

          <p class="body-copy">
            USB hardware mode connects directly to the ESP8266 through your laptop's USB cable.
            Keep your laptop on SNIT for internet. No ESP8266 IP address or second Wi-Fi network is needed.
            After saving, open Device Studio and choose Connect MORNI by USB.
          </p>

          <button class="btn btn-primary" data-action="save-connection">
            Save connection settings
          </button>

          <div class="refill-result">
            <b>${demo ? "DEMO MODE" : "LIVE MODE"}</b>
            <small>${demo
              ? "Physical hardware is not contacted"
              : "Live connection selected"}</small>
          </div>
        `)}

        ${card("Personal profile", `
          <label class="field-label">
            Display name
            <input class="field-input" id="profileName"
              maxlength="32"
              value="${safe(state.profile.name)}">
          </label>

          <label class="field-label">
            Usual wake-up time
            <input class="field-input" id="wakeTime"
              type="time"
              value="${safe(state.profile.wakeTime)}">
          </label>

          <button class="btn btn-primary" data-action="save-profile">
            Save preferences
          </button>
        `)}

        ${card("Handwash refill estimate", `
          <p class="body-copy">
            Estimates only — MORNI does not measure liquid level unless
            a separate level sensor is added.
          </p>

          <label class="field-label">
            Bottle capacity (ml)
            <input class="field-input" id="capacity"
              type="number" min="1"
              value="${state.capacity.handwash}">
          </label>

          <label class="field-label">
            Estimated amount per use (ml)
            <input class="field-input" id="average"
              type="number" min="0.1" step="0.1"
              value="${state.average.handwash}">
          </label>

          <button class="btn btn-primary" data-action="save-refill">
            Save estimate
          </button>

          <div class="refill-result">
            <b>${Math.max(0, Math.round(state.capacity.handwash - state.used.handwash))} ml</b>
            <small>estimated remaining</small>
          </div>
        `)}

        ${card("Appearance", `
          <div class="setting-row">
            <div>
              <b>Interface theme</b>
              <small>Choose a comfortable display.</small>
            </div>

            <button class="btn btn-soft" data-action="theme">
              ${state.theme === "dark" ? "Switch to light" : "Switch to dark"}
            </button>
          </div>
        `)}

        ${card("Data & privacy", `
          <p class="body-copy">
            Routine history, preferences and points are stored locally
            in this browser. They are not synced to an account.
          </p>

          <button class="btn btn-danger" data-action="reset">
            Reset local MORNI data
          </button>
        `)}
      </div>
    </div>`;
  }

  /* =========================================================
     MORNI ULTIMATE EXPERIENCE LAYER
     A complete software-first morning companion. All simulated
     interactions are labelled and never impersonate hardware.
     ========================================================= */

  const EXTRA_STORE = "morni_ultimate_experience_v1";
  const extraDefaults = () => ({
    handwash: {
      running: false,
      remaining: 30,
      endsAt: 0,
      stageIndex: 0,
      sessions: [],
      lastCompletedDate: ""
    },
    water: { count: 0, target: 6, date: today(), awardedDate: "" },
    plan: {
      wake: state.profile.wakeTime || "06:30",
      leave: "07:30",
      buffer: 10,
      tasks: [
        { id: "wake", title: "Wake up and get ready", minutes: 5, done: false },
        { id: "hygiene", title: "Complete hygiene routine", minutes: 10, done: false },
        { id: "dress", title: "Get dressed", minutes: 10, done: false },
        { id: "breakfast", title: "Have breakfast", minutes: 15, done: false },
        { id: "pack", title: "Final bag and bottle check", minutes: 5, done: false }
      ]
    },
    rewards: {
      owned: ["sunrise"],
      equipped: "sunrise",
      transactions: []
    },
    reflection: { date: today(), energy: "steady", note: "" },
    resource: { mlPerPump: Number(CFG.refill?.handwashPerUse || 2), refillReminder: 20 },
    showcase: { step: 0, completed: [] },
    focus: { running: false, remaining: 300, endsAt: 0, sessions: 0 }
  });

  let extra = Object.assign(extraDefaults(), read(EXTRA_STORE, {}));
  const extraFresh = extraDefaults();
  for (const key of Object.keys(extraFresh)) {
    extra[key] = Object.assign({}, extraFresh[key], extra[key] || {});
  }
  for (const key of ["sessions"]) {
    if (!Array.isArray(extra.handwash[key])) extra.handwash[key] = [];
  }
  if (!Array.isArray(extra.plan.tasks)) extra.plan.tasks = extraFresh.plan.tasks;
  if (!Array.isArray(extra.rewards.owned)) extra.rewards.owned = ["sunrise"];
  if (!Array.isArray(extra.rewards.transactions)) extra.rewards.transactions = [];
  if (!Array.isArray(extra.showcase.completed)) extra.showcase.completed = [];
  if (extra.water.date !== today()) {
    extra.water.count = 0;
    extra.water.date = today();
  }
  if (extra.reflection.date !== today()) {
    extra.reflection = { date: today(), energy: "steady", note: "" };
  }
  if (!Number.isFinite(Number(extra.resource.mlPerPump)) || Number(extra.resource.mlPerPump) <= 0) {
    extra.resource.mlPerPump = Number(CFG.refill?.handwashPerUse || 2);
  }

  if (!Number.isFinite(extra.handwash.remaining) || extra.handwash.remaining < 0 || extra.handwash.remaining > 30) extra.handwash.remaining = 30;
  if (!Number.isFinite(extra.water.count) || extra.water.count < 0) extra.water.count = 0;
  if (!Number.isFinite(extra.water.target) || extra.water.target < 1) extra.water.target = 6;
  if (!extra.rewards.owned.includes("sunrise")) extra.rewards.owned.unshift("sunrise");
  if (!extra.rewards.owned.includes(extra.rewards.equipped)) extra.rewards.equipped = "sunrise";
  saveExtra();

  let handwashLoop = null;
  let focusLoop = null;
  let featureToastLoop = null;

  function saveExtra() {
    write(EXTRA_STORE, extra);
  }

  const handwashStages = [
    { title: "Wet your hands", detail: "Use clean running water to wet both hands.", icon: "💧", seconds: 5 },
    { title: "Apply soap", detail: "Use enough soap to cover both hands.", icon: "🫧", seconds: 5 },
    { title: "Palm to palm", detail: "Rub your palms together to build a lather.", icon: "🤲", seconds: 5 },
    { title: "Between fingers", detail: "Clean the backs of your hands and between every finger.", icon: "✋", seconds: 5 },
    { title: "Thumbs and fingertips", detail: "Give thumbs, fingertips and nail areas attention.", icon: "✨", seconds: 5 },
    { title: "Rinse and dry", detail: "Rinse thoroughly and dry with a clean towel.", icon: "🌿", seconds: 5 }
  ];

  const rewardCatalog = [
    { id: "sunrise", name: "First Light", category: "Starter", cost: 0, icon: "🌅", description: "Your original MORNI sunrise identity." },
    { id: "leaf", name: "Eco Explorer", category: "Badge", cost: 45, icon: "🍃", description: "A little reminder to make thoughtful choices." },
    { id: "orbit", name: "Orbit Trail", category: "Theme", cost: 70, icon: "🪐", description: "A space-inspired profile collectible." },
    { id: "spark", name: "Bright Spark", category: "Badge", cost: 90, icon: "✨", description: "Celebrate the small wins that add up." },
    { id: "citrus", name: "Citrus Glow", category: "Theme", cost: 110, icon: "🍊", description: "A warm, energetic morning collectible." },
    { id: "cloud", name: "Cloud Nine", category: "Theme", cost: 140, icon: "☁️", description: "A calm, airy look for your collection." },
    { id: "comet", name: "Comet Club", category: "Badge", cost: 180, icon: "☄️", description: "A milestone collectible for consistent mornings." },
    { id: "forest", name: "Forest Keeper", category: "Theme", cost: 220, icon: "🌳", description: "A nature-inspired collection piece." },
    { id: "golden", name: "Golden Hour", category: "Prestige", cost: 300, icon: "🏆", description: "A premium milestone for your MORNI profile." },
    { id: "galaxy", name: "Galaxy Garden", category: "Prestige", cost: 420, icon: "🌌", description: "A special collectible for long-term progress." }
  ];

  const showcaseSteps = [
    { title: "A morning, understood", page: "lab", description: "MORNI brings hygiene, school preparation, planning and progress into one calm command centre.", proof: "A unified daily experience rather than a collection of disconnected timers." },
    { title: "Guidance that works without sensors", page: "handwash", description: "A timed, step-by-step handwashing guide makes the software useful even before the physical station is ready.", proof: "The guide is interactive and clearly labelled as app-guided, not sensor-verified." },
    { title: "A plan that respects real time", page: "planner", description: "The planner estimates the available morning window and helps organise tasks around a chosen departure time.", proof: "Time estimates are visible and editable by the user." },
    { title: "Progress with a purpose", page: "rewards", description: "Points can be spent on cosmetic collectibles, giving achievements a visible use.", proof: "Purchases are local, persistent and cannot create a negative balance." },
    { title: "A transparent readiness picture", page: "impact", description: "The MORNI Readiness Index combines routine, school preparation, planning and recent consistency.", proof: "Its formula is disclosed and it is not presented as a medical or scientific score." },
    { title: "Hardware-ready by design", page: "device", description: "The digital twin and demo flow are available now; physical commands remain locked until firmware confirms hardware readiness.", proof: "A reachable ESP8266 is not misrepresented as fully assembled hardware." }
  ];

  function featureNav() {
    const links = [
      ["home", "⌂", "Home"],
      ["lab", "⌘", "Command centre"],
      ["handwash", "◌", "Handwash lab"],
      ["planner", "◷", "Morning planner"],
      ["rewards", "✧", "Rewards shop"],
      ["impact", "◎", "Readiness lab"],
      ["showcase", "▶", "Judge tour"],
      ["focus", "◉", "Focus space"],
      ["device", "⌁", "Device studio"]
    ];
    return `<nav class="morni-feature-nav" aria-label="MORNI experience">
      <span class="morni-nav-label">EXPLORE MORNI</span>
      ${links.map(([id, icon, label]) => `<button type="button" data-page="${id}" class="${page === id ? "active" : ""}"><span>${icon}</span>${label}</button>`).join("")}
      <button type="button" class="morni-profile-button ${page === "profile" ? "active" : ""}" data-page="profile" aria-label="Open profile"><span class="morni-profile-avatar">${safe((state.profile.name || "M").trim().charAt(0).toUpperCase())}</span><span class="morni-profile-label">Profile</span></button>
    </nav>`;
  }

  function featureCard(title, text, icon, pageId, meta = "OPEN EXPERIENCE") {
    return `<button type="button" class="feature-card" data-page="${pageId}">
      <span class="feature-card-icon">${icon}</span>
      <span class="feature-card-copy"><b>${title}</b><small>${text}</small><em>${meta} ↗</em></span>
    </button>`;
  }

  function handwashElapsed() {
    return extra.handwash.running
      ? Math.max(0, Math.ceil((extra.handwash.endsAt - Date.now()) / 1000))
      : Math.max(0, extra.handwash.remaining);
  }

  function handwashStageForRemaining(remaining) {
    const elapsed = Math.max(0, 30 - remaining);
    return Math.min(handwashStages.length - 1, Math.floor(elapsed / 5));
  }

  function startHandwashGuide() {
    if (extra.handwash.running) return;
    if (extra.handwash.remaining <= 0) extra.handwash.remaining = 30;
    extra.handwash.running = true;
    extra.handwash.endsAt = Date.now() + extra.handwash.remaining * 1000;
    extra.handwash.stageIndex = handwashStageForRemaining(extra.handwash.remaining);
    saveExtra();
    clearInterval(handwashLoop);
    handwashLoop = setInterval(tickHandwashGuide, 200);
    render();
    featureToast("Guided handwash started · app timer only");
  }

  function pauseHandwashGuide() {
    if (!extra.handwash.running) return;
    extra.handwash.remaining = handwashElapsed();
    extra.handwash.running = false;
    extra.handwash.endsAt = 0;
    clearInterval(handwashLoop);
    saveExtra();
    render();
    featureToast("Handwash guide paused");
  }

  function resetHandwashGuide() {
    clearInterval(handwashLoop);
    extra.handwash.running = false;
    extra.handwash.remaining = 30;
    extra.handwash.endsAt = 0;
    extra.handwash.stageIndex = 0;
    saveExtra();
    render();
    featureToast("Handwash guide reset");
  }

  function tickHandwashGuide() {
    const remaining = handwashElapsed();
    extra.handwash.remaining = remaining;
    extra.handwash.stageIndex = handwashStageForRemaining(remaining);
    const digits = $("#handwashDigits");
    const stageTitle = $("#handwashStageTitle");
    const stageDetail = $("#handwashStageDetail");
    const stageIcon = $("#handwashStageIcon");
    const ring = $("#handwashRing");
    const progress = $("#handwashProgressText");
    if (digits) digits.textContent = fmt(remaining);
    if (stageTitle) stageTitle.textContent = handwashStages[extra.handwash.stageIndex].title;
    if (stageDetail) stageDetail.textContent = handwashStages[extra.handwash.stageIndex].detail;
    if (stageIcon) stageIcon.textContent = handwashStages[extra.handwash.stageIndex].icon;
    if (ring) ring.style.setProperty("--ring", `${(30 - remaining) / 30 * 360}deg`);
    if (progress) progress.textContent = `${Math.min(100, Math.round((30 - remaining) / 30 * 100))}% complete`;
    if (remaining <= 0) completeHandwashGuide();
  }

  function completeHandwashGuide() {
    if (!extra.handwash.running && extra.handwash.remaining <= 0 && extra.handwash.lastCompletedDate === today()) return;
    clearInterval(handwashLoop);
    extra.handwash.running = false;
    extra.handwash.remaining = 0;
    extra.handwash.endsAt = 0;
    extra.handwash.stageIndex = handwashStages.length - 1;
    extra.handwash.lastCompletedDate = today();
    extra.handwash.sessions.unshift({ date: today(), time: new Date().toISOString(), duration: 30, source: "guided-app" });
    extra.handwash.sessions = extra.handwash.sessions.slice(0, 100);
    saveExtra();
    if (!state.routine.handwash) markHandwash("guided app timer");
    else award("handwash-guide-extra", 3, "Guided wash completed");
    featureToast("30-second guide complete · remember to rinse and dry");
    render();
  }

  function featureToast(message) {
    let element = $("#toast");
    if (!element) {
      element = document.createElement("div");
      element.id = "toast";
      element.className = "toast";
      document.body.append(element);
    }
    element.textContent = message;
    element.classList.add("show");
    clearTimeout(featureToastLoop);
    featureToastLoop = setTimeout(() => element.classList.remove("show"), 3000);
  }

  function addWaterGlass() {
    if (extra.water.count >= 20) {
      featureToast("Today's tracker is capped at 20 entries.");
      return;
    }
    extra.water.count += 1;
    saveExtra();
    if (extra.water.count >= Number(extra.water.target || 6) && extra.water.awardedDate !== today()) {
      extra.water.awardedDate = today();
      award("water-target", 5, "Personal hydration target reached");
    }
    render();
  }

  function removeWaterGlass() {
    extra.water.count = Math.max(0, extra.water.count - 1);
    saveExtra();
    render();
  }

  function saveWaterTarget() {
    const value = Number($("#waterTarget")?.value);
    if (!Number.isInteger(value) || value < 1 || value > 20) {
      featureToast("Choose a target between 1 and 20 tracker entries.");
      return;
    }
    extra.water.target = value;
    saveExtra();
    render();
    featureToast("Personal tracker target saved.");
  }

  function parseClock(value) {
    const match = /^(\d{2}):(\d{2})$/.exec(String(value || ""));
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
  }

  function clockLabel(total) {
    const wrapped = ((total % 1440) + 1440) % 1440;
    return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
  }

  function plannerSummary() {
    const wake = parseClock(extra.plan.wake);
    const leave = parseClock(extra.plan.leave);
    if (wake === null || leave === null) return { available: 0, needed: 0, gap: 0, valid: false };
    const available = (leave - wake + 1440) % 1440;
    const needed = extra.plan.tasks.reduce((sum, task) => sum + Math.max(0, Number(task.minutes) || 0), 0) + Math.max(0, Number(extra.plan.buffer) || 0);
    return { available, needed, gap: available - needed, valid: available > 0 };
  }

  function saveMorningPlan() {
    const wake = $("#planWake")?.value;
    const leave = $("#planLeave")?.value;
    const buffer = Number($("#planBuffer")?.value);
    const start = parseClock(wake);
    const end = parseClock(leave);
    if (start === null || end === null || start === end) {
      featureToast("Enter a valid wake-up and departure time.");
      return;
    }
    if (!Number.isFinite(buffer) || buffer < 0 || buffer > 90) {
      featureToast("Buffer must be between 0 and 90 minutes.");
      return;
    }
    extra.plan.wake = wake;
    extra.plan.leave = leave;
    extra.plan.buffer = buffer;
    state.profile.wakeTime = wake;
    saveExtra();
    save();
    render();
    featureToast("Your morning plan has been updated.");
  }

  function togglePlanTask(id) {
    const task = extra.plan.tasks.find(item => item.id === id);
    if (!task) return;
    task.done = !task.done;
    saveExtra();
    render();
  }

  function addPlanTask() {
    const title = String($("#newTaskTitle")?.value || "").trim();
    const minutes = Number($("#newTaskMinutes")?.value || 5);
    if (!title || title.length > 60) {
      featureToast("Give your task a name of up to 60 characters.");
      return;
    }
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) {
      featureToast("Task duration must be 1–180 minutes.");
      return;
    }
    extra.plan.tasks.push({ id: `custom-${Date.now()}`, title, minutes, done: false });
    saveExtra();
    render();
    featureToast("Task added to your morning plan.");
  }

  function removePlanTask(id) {
    if (extra.plan.tasks.length <= 1) {
      featureToast("Keep at least one task in your plan.");
      return;
    }
    extra.plan.tasks = extra.plan.tasks.filter(task => task.id !== id);
    saveExtra();
    render();
  }

  function buyReward(id) {
    const item = rewardCatalog.find(reward => reward.id === id);
    if (!item) return;
    if (extra.rewards.owned.includes(id)) {
      featureToast("You already own this collectible.");
      return;
    }
    if (xp.points < item.cost) {
      featureToast(`You need ${item.cost - xp.points} more points for this item.`);
      return;
    }
    if (!confirm(`Unlock ${item.name} for ${item.cost} MORNI points?`)) return;
    xp.points -= item.cost;
    extra.rewards.owned.push(id);
    extra.rewards.transactions.unshift({ id, name: item.name, cost: item.cost, date: new Date().toISOString() });
    extra.rewards.transactions = extra.rewards.transactions.slice(0, 50);
    save();
    saveExtra();
    render();
    featureToast(`${item.name} unlocked. Equip it from your collection.`);
  }

  function equipReward(id) {
    if (!extra.rewards.owned.includes(id)) return;
    extra.rewards.equipped = id;
    saveExtra();
    render();
    featureToast("Profile collectible equipped.");
  }

  function readinessBreakdown() {
    const hygiene = Math.round(completed() / 2 * 100);
    const school = Math.round(Object.values(state.checklist).filter(Boolean).length / Object.keys(state.checklist).length * 100);
    const plan = Math.round(extra.plan.tasks.filter(task => task.done).length / Math.max(1, extra.plan.tasks.length) * 100);
    const lastSeven = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(); d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      return state.history.some(item => item.date === key);
    });
    const consistency = Math.round(lastSeven.filter(Boolean).length / 7 * 100);
    const score = Math.round((hygiene + school + plan + consistency) / 4);
    return { hygiene, school, plan, consistency, score };
  }

  function adaptiveNudge() {
    if (!state.routine.brushingComplete) return { title: "Start with the essentials", text: "Your two-minute brushing session is still open. Start it when you're ready.", page: "routine" };
    if (!state.routine.handwash) return { title: "Finish with clean hands", text: "Use the guided handwash timer to complete the second hygiene step.", page: "handwash" };
    const unfinished = extra.plan.tasks.find(task => !task.done);
    if (unfinished) return { title: "One school-prep task left to tackle", text: `Next up: ${unfinished.title}.`, page: "planner" };
    if (!Object.values(state.checklist).every(Boolean)) return { title: "Do a final school check", text: "Your school checklist can catch the little things before you leave.", page: "school" };
    return { title: "Your essentials are in a good place", text: "Take a look at your weekly pattern and choose one small improvement for tomorrow.", page: "impact" };
  }

  function lab() {
    const score = readinessBreakdown();
    const nudge = adaptiveNudge();
    const waterPct = Math.min(100, Math.round(extra.water.count / Math.max(1, extra.water.target) * 100));
    const reward = rewardCatalog.find(item => item.id === extra.rewards.equipped) || rewardCatalog[0];
    return `<div class="page-enter morni-lab-page">
      <section class="morni-command-hero">
        <div class="morni-command-copy">
          <span class="morni-kicker">MORNI · MORNING OPERATING SYSTEM</span>
          <h1>Make room for a<br><em>better morning.</em></h1>
          <p>One thoughtful flow for hygiene, school readiness, personal progress and your connected station.</p>
          <div class="morni-hero-tags"><span>✦ Guided routines</span><span>◉ Adaptive planning</span><span>⌁ Hardware-ready</span></div>
        </div>
        <div class="morni-command-orb"><div class="orb-sun"></div><span>YOUR DAY<br><b>STARTS HERE</b></span></div>
      </section>

      <section class="morni-software-demo-note">
        <span class="morni-demo-note-icon">✦</span>
        <div><b>${isDemoMode() ? "Software-only demo is ready" : "Hardware integration status"}</b>
        <p>${isDemoMode()
          ? "MORNI can be presented without the physical station. Use Demo mode to demonstrate the guided routine, handwash timer, planner, rewards shop, readiness insights and judge tour. Demo actions are simulated in the app and are not real sensor readings or dispenser operations."
          : "The app can still be demonstrated if the physical station is unfinished. Switch to Demo mode in Settings to run simulated interactions without sending commands to the ESP8266."}</p></div>
        <button class="btn btn-soft" data-page="showcase">Open judge tour ↗</button>
      </section>

      <div class="morni-section-heading"><div><span class="morni-kicker">TODAY AT A GLANCE</span><h2>Your morning command centre</h2></div><span class="morni-date-stamp">${dateText()}</span></div>
      <div class="morni-score-row">
        <section class="morni-score-card"><div class="score-dial" style="--score:${score.score * 3.6}deg"><div><b>${score.score}</b><small>/100</small></div></div><div><span class="morni-kicker">MORNI READINESS INDEX</span><h3>${score.score >= 80 ? "Looking ready" : score.score >= 50 ? "Building momentum" : "A fresh start"}</h3><p>A transparent app estimate from four daily signals.</p></div></section>
        <section class="morni-water-card"><div class="water-card-top"><span>💧</span><span>PERSONAL TRACKER</span></div><b>${extra.water.count}<small> / ${extra.water.target}</small></b><p>Water entries today</p><div class="morni-meter"><i style="width:${waterPct}%"></i></div><div class="water-actions"><button data-extra-action="water-remove" aria-label="Remove one entry">−</button><button data-extra-action="water-add">+ Add entry</button></div><div class="water-target-control"><label for="waterTarget">Personal target</label><input id="waterTarget" type="number" min="1" max="20" value="${extra.water.target}"><button data-extra-action="water-target-save">Save</button></div><small class="morni-disclaimer">A simple log, not a medical hydration target.</small></section>
      </div>

      <section class="morni-nudge-card"><span class="nudge-icon">✳</span><div><span class="morni-kicker">MORNI'S NEXT BEST STEP</span><h3>${nudge.title}</h3><p>${nudge.text}</p></div><button class="btn btn-primary" data-page="${nudge.page}">Go to step ↗</button></section>

      <div class="morni-section-heading"><div><span class="morni-kicker">THE MORNI TOOLKIT</span><h2>Everything in one place</h2></div></div>
      <div class="feature-card-grid">
        ${featureCard("Guided handwash", "A timed, six-stage hygiene guide that works without sensors.", "◌", "handwash", "30-SECOND GUIDE")}
        ${featureCard("Morning planner", "Build a realistic schedule around your departure time.", "◷", "planner", "PLAN YOUR WINDOW")}
        ${featureCard("Rewards studio", "Turn earned points into profile collectibles.", "✧", "rewards", `${xp.points} POINTS AVAILABLE`)}
        ${featureCard("Readiness lab", "See the four signals behind your MORNI score.", "◎", "impact", "VIEW YOUR INDEX")}
        ${featureCard("Digital station", "Explore the twin and the real hardware connection state.", "⌁", "device", state.device.hardwareReady ? "FIRMWARE READY" : "HARDWARE INTEGRATION PENDING")}
        ${featureCard("Judge presentation", "A guided product tour with honest, hardware-independent demos.", "▶", "showcase", "PRESENT MORNI")}
        ${featureCard("Focus space", "An optional five-minute get-ready focus block.", "◉", "focus", "START A FOCUS BLOCK")}
      </div>

      <div class="morni-lower-grid">
        <section class="morni-glass-panel"><div class="morni-panel-head"><div><span class="morni-kicker">YOUR COLLECTION</span><h3>Equipped collectible</h3></div><span class="morni-collectible-icon">${reward.icon}</span></div><div class="equipped-preview"><b>${reward.name}</b><small>${reward.description}</small></div><button class="text-link" data-page="rewards">Open rewards studio →</button></section>
        <section class="morni-glass-panel"><div class="morni-panel-head"><div><span class="morni-kicker">MORNING SIGNALS</span><h3>Four parts of readiness</h3></div><span>◈</span></div>${[["Hygiene",score.hygiene],["School prep",score.school],["Morning plan",score.plan],["7-day consistency",score.consistency]].map(([label,value])=>`<div class="readiness-line"><span>${label}</span><b>${value}%</b><div class="morni-meter"><i style="width:${value}%"></i></div></div>`).join("")}</section>
      </div>
      <p class="morni-footnote">MORNI is a personal organisation and hygiene-support concept. The Readiness Index is an app-generated progress indicator, not a health assessment.</p>
    </div>`;
  }

  function handwashPage() {
    const remaining = handwashElapsed();
    const stage = handwashStages[extra.handwash.running ? handwashStageForRemaining(remaining) : extra.handwash.stageIndex] || handwashStages[0];
    const done = remaining === 0 && extra.handwash.lastCompletedDate === today();
    return `<div class="page-enter morni-feature-page">
      <div class="morni-page-heading"><div><span class="morni-kicker">MORNI HYGIENE LAB · GUIDED MODE</span><h1>Clean hands,<br><em>step by step.</em></h1><p>A clear 30-second guide that stays useful even when the physical station is not connected.</p></div><span class="morni-live-label">APP-GUIDED · NOT SENSOR VERIFIED</span></div>
      <div class="handwash-workspace">
        <section class="morni-glass-panel handwash-main-panel">
          <div class="handwash-stage-visual"><div class="handwash-glow"></div><div class="handwash-stage-icon" id="handwashStageIcon">${done ? "✓" : stage.icon}</div><div class="handwash-step-count">STEP ${done ? "6" : extra.handwash.stageIndex + 1} / 6</div></div>
          <div class="handwash-current"><span class="morni-kicker">CURRENT STEP</span><h2 id="handwashStageTitle">${done ? "Guide complete" : stage.title}</h2><p id="handwashStageDetail">${done ? "Rinse thoroughly and dry with a clean towel." : stage.detail}</p></div>
          <div class="handwash-timer-wrap"><div class="timer-ring handwash-ring" id="handwashRing" style="--ring:${(30 - remaining) / 30 * 360}deg"><div class="timer-center"><b id="handwashDigits">${fmt(remaining)}</b><small>SECONDS LEFT</small></div></div><span id="handwashProgressText">${Math.round((30 - remaining) / 30 * 100)}% complete</span></div>
          <div class="handwash-controls"><button class="btn btn-primary" data-extra-action="${extra.handwash.running ? "handwash-pause" : "handwash-start"}" ${done ? "disabled" : ""}>${extra.handwash.running ? "Pause guide" : done ? "Completed today" : "Start 30-second guide"}</button><button class="btn btn-soft" data-extra-action="handwash-reset">Reset</button></div>
          <p class="morni-disclaimer">This is a timed educational guide. It does not detect your hands, measure soap, or verify that washing physically occurred.</p>
        </section>
        <section class="morni-glass-panel handwash-steps-panel"><div class="morni-panel-head"><div><span class="morni-kicker">THE SIX-STAGE FLOW</span><h3>Follow the sequence</h3></div><span>✦</span></div>
          ${handwashStages.map((item,index)=>`<div class="handwash-step-row ${index < extra.handwash.stageIndex || done ? "step-passed" : index === extra.handwash.stageIndex ? "step-current" : ""}"><span class="step-row-icon">${item.icon}</span><div><b>${item.title}</b><small>${item.detail}</small></div><em>${item.seconds}s</em></div>`).join("")}
          <div class="handwash-tip"><b>Remember</b><p>Use soap, cover all hand surfaces, rinse well and dry. Follow local school or public-health guidance if it specifies a different procedure.</p></div>
        </section>
      </div>
      <div class="morni-section-heading"><div><span class="morni-kicker">YOUR HISTORY</span><h2>Guided sessions</h2></div><span class="morni-date-stamp">${extra.handwash.sessions.length} saved</span></div>
      <section class="morni-glass-panel">${extra.handwash.sessions.length ? extra.handwash.sessions.slice(0,6).map(session=>`<div class="morni-history-row"><span>✓</span><div><b>Guided wash completed</b><small>${safe(session.source)} · ${new Date(session.time).toLocaleString()}</small></div><em>30 sec</em></div>`).join("") : `<div class="morni-empty-state"><span>◌</span><b>Your guided sessions will appear here.</b><small>Start the timer when you are ready to follow the steps.</small></div>`}</section>
    </div>`;
  }

  function plannerPage() {
    const summary = plannerSummary();
    let cursor = parseClock(extra.plan.wake) || 0;
    const taskRows = extra.plan.tasks.map(task => {
      const start = cursor;
      cursor += Math.max(0, Number(task.minutes) || 0);
      return { ...task, startLabel: clockLabel(start), endLabel: clockLabel(cursor) };
    });
    const completedTasks = extra.plan.tasks.filter(task=>task.done).length;
    return `<div class="page-enter morni-feature-page">
      <div class="morni-page-heading"><div><span class="morni-kicker">MORNI FLOW PLANNER</span><h1>Make time for<br><em>what matters.</em></h1><p>Plan backwards from when you need to leave. MORNI makes the time budget visible.</p></div><span class="morni-live-label">EDITABLE ESTIMATES</span></div>
      <div class="planner-top-grid">
        <section class="morni-glass-panel planner-settings"><div class="morni-panel-head"><div><span class="morni-kicker">YOUR TIME WINDOW</span><h3>Set your morning</h3></div><span>◷</span></div>
          <label class="morni-field">Wake-up time<input id="planWake" type="time" value="${safe(extra.plan.wake)}"></label>
          <label class="morni-field">Leave home at<input id="planLeave" type="time" value="${safe(extra.plan.leave)}"></label>
          <label class="morni-field">Extra buffer (minutes)<input id="planBuffer" type="number" min="0" max="90" value="${Number(extra.plan.buffer)||0}"></label>
          <button class="btn btn-primary" data-extra-action="plan-save">Update time window</button>
        </section>
        <section class="morni-glass-panel time-budget-card"><span class="morni-kicker">YOUR TIME BUDGET</span><div class="time-budget-number">${summary.valid ? summary.available : "—"}<small>minutes available</small></div><div class="budget-comparison"><div><small>PLANNED TASKS + BUFFER</small><b>${summary.needed} min</b></div><div><small>TIME ${summary.gap >= 0 ? "LEFT OVER" : "OVER BUDGET"}</small><b class="${summary.gap < 0 ? "budget-warning" : ""}">${summary.valid ? Math.abs(summary.gap) : "—"} min</b></div></div><p>${!summary.valid ? "Choose two different times to calculate your morning window." : summary.gap >= 0 ? "Your plan fits inside the selected time window." : "Your current plan is longer than the available window. Shorten or move tasks rather than rushing."}</p></section>
      </div>
      <div class="morni-section-heading"><div><span class="morni-kicker">YOUR SEQUENCE</span><h2>Morning timeline</h2></div><span class="morni-date-stamp">${completedTasks}/${extra.plan.tasks.length} done</span></div>
      <section class="morni-glass-panel planner-timeline">${taskRows.map((task,index)=>`<div class="planner-task-row ${task.done ? "task-done" : ""}"><button class="planner-check" data-extra-action="plan-toggle" data-extra-id="${safe(task.id)}" aria-label="Toggle ${safe(task.title)}">${task.done ? "✓" : index+1}</button><div class="planner-task-copy"><b>${safe(task.title)}</b><small>${task.startLabel} – ${task.endLabel} · ${task.minutes} min</small></div>${task.id.startsWith("custom-") ? `<button class="planner-remove" data-extra-action="plan-remove" data-extra-id="${safe(task.id)}" aria-label="Remove task">×</button>` : `<span class="planner-fixed-label">PLAN</span>`}</div>`).join("")}</section>
      <section class="morni-glass-panel add-task-panel"><div><span class="morni-kicker">MAKE IT YOURS</span><h3>Add a task</h3><p>Keep the plan personal. Add anything you want to remember before leaving.</p></div><div class="add-task-fields"><input id="newTaskTitle" maxlength="60" placeholder="e.g. Feed the pet"><input id="newTaskMinutes" type="number" min="1" max="180" value="5" aria-label="Task minutes"><button class="btn btn-primary" data-extra-action="plan-add">Add task</button></div></section>
      <p class="morni-disclaimer">All durations are user-editable estimates. MORNI does not assume travel time, traffic, school schedules or your actual pace.</p>
    </div>`;
  }

  function rewardsPage() {
    return `<div class="page-enter morni-feature-page">
      <div class="morni-page-heading"><div><span class="morni-kicker">MORNI REWARDS ECONOMY</span><h1>Small wins.<br><em>Real unlocks.</em></h1><p>Use points earned through your routine to collect profile cosmetics. Rewards do not control or alter the physical station.</p></div><div class="points-wallet"><span>YOUR BALANCE</span><b>✧ ${xp.points}</b><small>MORNI points</small></div></div>
      <div class="reward-feature-banner"><div><span class="morni-kicker">YOUR CURRENT COLLECTIBLE</span><h2>${(rewardCatalog.find(item=>item.id===extra.rewards.equipped)||rewardCatalog[0]).name}</h2><p>Collect, unlock and equip your favourite MORNI identity.</p></div><span>${(rewardCatalog.find(item=>item.id===extra.rewards.equipped)||rewardCatalog[0]).icon}</span></div>
      <div class="morni-section-heading"><div><span class="morni-kicker">THE COLLECTION</span><h2>Rewards shop</h2></div><span class="morni-date-stamp">${extra.rewards.owned.length}/${rewardCatalog.length} owned</span></div>
      <div class="reward-shop-grid">${rewardCatalog.map(item=>{
        const owned=extra.rewards.owned.includes(item.id);
        const equipped=extra.rewards.equipped===item.id;
        const canBuy=xp.points>=item.cost;
        return `<article class="reward-item ${owned?"reward-owned":""}"><div class="reward-item-art"><span>${item.icon}</span><small>${item.category}</small></div><div class="reward-item-copy"><h3>${item.name}</h3><p>${item.description}</p></div><div class="reward-item-footer"><b>${item.cost===0?"FREE":`✧ ${item.cost}`}</b>${owned?`<button class="btn ${equipped?"btn-soft":"btn-primary"}" data-extra-action="reward-equip" data-extra-id="${item.id}" ${equipped?"disabled":""}>${equipped?"Equipped":"Equip"}</button>`:`<button class="btn ${canBuy?"btn-primary":"btn-soft"}" data-extra-action="reward-buy" data-extra-id="${item.id}" ${canBuy?"":"disabled"}>Unlock</button>`}</div></article>`;
      }).join("")}</div>
      <div class="morni-section-heading"><div><span class="morni-kicker">YOUR ACTIVITY</span><h2>Purchase history</h2></div></div>
      <section class="morni-glass-panel">${extra.rewards.transactions.length?extra.rewards.transactions.slice(0,8).map(item=>`<div class="morni-history-row"><span>✧</span><div><b>${safe(item.name)}</b><small>${new Date(item.date).toLocaleString()}</small></div><em>−${item.cost} pts</em></div>`).join(""):`<div class="morni-empty-state"><span>✧</span><b>Your first unlock is waiting.</b><small>Earn points by completing your routine and personal missions.</small></div>`}</section>
      <p class="morni-disclaimer">Points and collectibles are stored in this browser. They have no cash value and do not represent physical prizes.</p>
    </div>`;
  }

  function impactPage() {
    const s=readinessBreakdown();
    const ml=Math.max(0,Number(state.used.handwash)||0);
    const capacity=Math.max(1,Number(state.capacity.handwash)||250);
    const remaining=Math.max(0,capacity-ml);
    const percent=Math.max(0,Math.min(100,remaining/capacity*100));
    const signals=[
      {id:"hygiene",name:"Hygiene routine",value:s.hygiene,detail:"Brushing and handwash steps recorded today",icon:"◌"},
      {id:"school",name:"School readiness",value:s.school,detail:"Items checked in your school checklist",icon:"▤"},
      {id:"plan",name:"Morning plan",value:s.plan,detail:"Tasks marked complete in your personal plan",icon:"◷"},
      {id:"consistency",name:"Recent consistency",value:s.consistency,detail:"Completed routines across the last seven days",icon:"✧"}
    ];
    return `<div class="page-enter morni-feature-page">
      <div class="morni-page-heading"><div><span class="morni-kicker">MORNI READINESS LAB</span><h1>See the pattern.<br><em>Shape the next day.</em></h1><p>A transparent view of the signals MORNI tracks so you can decide what to improve next.</p></div><span class="morni-live-label">PERSONAL PROGRESS · NOT A HEALTH SCORE</span></div>
      <section class="readiness-hero-card"><div class="readiness-big-dial" style="--score:${s.score*3.6}deg"><div><b>${s.score}</b><small>INDEX</small></div></div><div><span class="morni-kicker">MORNI READINESS INDEX</span><h2>${s.score>=80?"A strong start is taking shape":s.score>=50?"You're building your flow":"Every morning is a new opportunity"}</h2><p>The index is the simple average of four equally weighted app signals. It is an organisation indicator—not a clinical, scientific or school performance assessment.</p></div></section>
      <div class="morni-section-heading"><div><span class="morni-kicker">THE FORMULA</span><h2>Four transparent signals</h2></div></div>
      <div class="readiness-signal-grid">${signals.map(item=>`<article class="readiness-signal"><span>${item.icon}</span><div><b>${item.name}</b><small>${item.detail}</small></div><strong>${item.value}%</strong><div class="morni-meter"><i style="width:${item.value}%"></i></div></article>`).join("")}</div>
      <section class="morni-glass-panel formula-panel"><span class="morni-kicker">HOW THE INDEX IS CALCULATED</span><h3>(Hygiene + School + Plan + Consistency) ÷ 4</h3><p>Each signal is converted to a percentage using recorded app actions. Missing actions lower the indicator; the score does not guess what happened outside the app.</p></section>
      <div class="morni-section-heading"><div><span class="morni-kicker">RESOURCE AWARENESS</span><h2>Refill intelligence</h2></div></div>
      <section class="morni-glass-panel resource-panel"><div class="resource-bottle"><span>🧴</span><div><b>${Math.round(remaining)} ml</b><small>estimated remaining</small></div></div><div class="resource-details"><div class="resource-detail-top"><b>Handwash bottle estimate</b><span>${Math.round(percent)}%</span></div><div class="morni-meter"><i style="width:${percent}%"></i></div><p>${Math.round(ml)} ml estimated used from a ${Math.round(capacity)} ml capacity.</p><label class="morni-field">Estimated ml per pump<input id="resourceMl" type="number" min="0.1" max="30" step="0.1" value="${Number(extra.resource.mlPerPump).toFixed(1)}"></label><button class="btn btn-primary" data-extra-action="resource-save">Save estimate</button><small class="morni-disclaimer">This is a calculated estimate based on recorded uses and the value you enter. It is not a liquid-level sensor reading.</small></div></section>
      <section class="morni-nudge-card"><span class="nudge-icon">✳</span><div><span class="morni-kicker">ONE PRACTICAL IMPROVEMENT</span><h3>${adaptiveNudge().title}</h3><p>${adaptiveNudge().text}</p></div><button class="btn btn-primary" data-page="${adaptiveNudge().page}">Take action ↗</button></section>
    </div>`;
  }

  function showcasePage() {
    const current=showcaseSteps[extra.showcase.step]||showcaseSteps[0];
    const done=extra.showcase.completed.length;
    return `<div class="page-enter morni-feature-page showcase-page">
      <section class="showcase-hero"><span class="morni-kicker">MORNI · COMPETITION PRESENTATION MODE</span><h1>A better morning,<br><em>designed as a system.</em></h1><p>A guided walkthrough of the product vision, the working software experience and the path to physical integration.</p><div class="showcase-trust-tags"><span>✓ Works as a software demo</span><span>✓ Hardware status is transparent</span><span>✓ No fabricated sensor data</span></div></section>
      <div class="showcase-progress-head"><div><span class="morni-kicker">THE SIX-MINUTE STORY</span><h2>Presentation journey</h2></div><b>${done}/6 explored</b></div>
      <div class="showcase-layout"><section class="morni-glass-panel showcase-step-card"><div class="showcase-step-count">CHAPTER ${String(extra.showcase.step+1).padStart(2,"0")} / 06</div><div class="showcase-step-mark">${["✦","◌","◷","✧","◎","⌁"][extra.showcase.step]}</div><span class="morni-kicker">THE STORY</span><h2>${current.title}</h2><p>${current.description}</p><div class="showcase-proof"><b>WHAT TO SHOW THE PANEL</b><span>${current.proof}</span></div><div class="showcase-controls"><button class="btn btn-soft" data-extra-action="tour-prev" ${extra.showcase.step===0?"disabled":""}>← Previous</button><button class="btn btn-primary" data-extra-action="tour-open">Open this feature ↗</button><button class="btn btn-soft" data-extra-action="tour-next">${extra.showcase.step===5?"Restart tour":"Next chapter →"}</button></div></section><section class="morni-glass-panel showcase-chapters"><span class="morni-kicker">PRESENTATION OUTLINE</span>${showcaseSteps.map((item,index)=>`<button class="showcase-chapter ${index===extra.showcase.step?"chapter-active":""} ${extra.showcase.completed.includes(index)?"chapter-done":""}" data-extra-action="tour-select" data-extra-index="${index}"><span>${extra.showcase.completed.includes(index)?"✓":String(index+1).padStart(2,"0")}</span><div><b>${item.title}</b><small>${item.page.replace("lab","command centre").replace("handwash","guided hygiene").replace("planner","time planning").replace("rewards","points economy").replace("impact","readiness analytics").replace("device","hardware integration")}</small></div><em>↗</em></button>`).join("")}</section></div>
      <section class="showcase-honesty"><span>ⓘ</span><div><b>How to present hardware honestly</b><p>Say: “The software experience is operational in simulation mode. The ESP8266 communication layer is designed for integration, while sensor and dispenser readiness is still being completed. We are showing the complete user journey today and will connect verified hardware when it is ready.” Only claim the parts you have physically tested.</p></div></section>
      <div class="showcase-footer-actions"><button class="btn btn-primary" data-extra-action="tour-reset">Reset presentation progress</button><button class="btn btn-soft" data-extra-action="export-data">Export MORNI data backup</button></div>
    </div>`;
  }

  function focusPage() {
    const remaining=extra.focus.running?Math.max(0,Math.ceil((extra.focus.endsAt-Date.now())/1000)):extra.focus.remaining;
    return `<div class="page-enter morni-feature-page"><div class="morni-page-heading"><div><span class="morni-kicker">MORNI FOCUS SPACE</span><h1>One thing<br><em>at a time.</em></h1><p>A short, optional get-ready focus block for one small task before you leave.</p></div><span class="morni-live-label">OPTIONAL · 5 MINUTES</span></div><section class="morni-glass-panel focus-card"><div class="focus-orb"><span>◉</span></div><div class="focus-timer" id="focusDigits">${fmt(remaining)}</div><p>${extra.focus.running?"Stay with the one task you chose.":"Choose one small task, then begin when ready."}</p><div class="focus-controls"><button class="btn btn-primary" data-extra-action="focus-toggle">${extra.focus.running?"Pause focus":"Start 5-minute focus"}</button><button class="btn btn-soft" data-extra-action="focus-reset">Reset</button></div><small>${extra.focus.sessions} completed focus sessions recorded locally.</small></section><p class="morni-disclaimer">This is a productivity timer, not a treatment or a requirement. Skip it whenever it is not useful.</p></div>`;
  }

  function tickFocus() {
    const remaining=Math.max(0,Math.ceil((extra.focus.endsAt-Date.now())/1000));
    extra.focus.remaining=remaining;
    const digits=$("#focusDigits"); if(digits) digits.textContent=fmt(remaining);
    if(remaining<=0){
      clearInterval(focusLoop); extra.focus.running=false; extra.focus.endsAt=0; extra.focus.remaining=300; extra.focus.sessions+=1; saveExtra(); award("focus-session",3,"Focus session complete"); featureToast("Focus block complete. Nice work."); render();
    }
  }

  function toggleFocus() {
    if(extra.focus.running){
      extra.focus.remaining=Math.max(0,Math.ceil((extra.focus.endsAt-Date.now())/1000)); extra.focus.running=false; extra.focus.endsAt=0; clearInterval(focusLoop); saveExtra(); render(); return;
    }
    if(extra.focus.remaining<=0) extra.focus.remaining=300;
    extra.focus.running=true; extra.focus.endsAt=Date.now()+extra.focus.remaining*1000; saveExtra(); clearInterval(focusLoop); focusLoop=setInterval(tickFocus,250); render();
  }

  function exportMorniData() {
    const payload={
      product:"MORNI",
      exportVersion:1,
      exportedAt:new Date().toISOString(),
      note:"Local browser backup. Hardware telemetry is not included unless present in the app state.",
      state,
      points:xp,
      experience:extra
    };
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob);
    const link=document.createElement("a");
    link.href=url; link.download=`morni-backup-${today()}.json`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    featureToast("MORNI backup prepared for download.");
  }

  function handleExtraAction(action, element) {
    const id=element?.dataset.extraId;
    if(action==="handwash-start") startHandwashGuide();
    else if(action==="handwash-pause") pauseHandwashGuide();
    else if(action==="handwash-reset") resetHandwashGuide();
    else if(action==="water-add") addWaterGlass();
    else if(action==="water-remove") removeWaterGlass();
    else if(action==="water-target-save") saveWaterTarget();
    else if(action==="plan-save") saveMorningPlan();
    else if(action==="plan-toggle") togglePlanTask(id);
    else if(action==="plan-add") addPlanTask();
    else if(action==="plan-remove") removePlanTask(id);
    else if(action==="reward-buy") buyReward(id);
    else if(action==="reward-equip") equipReward(id);
    else if(action==="resource-save") {
      const value=Number($("#resourceMl")?.value);
      if(!Number.isFinite(value)||value<0.1||value>30){featureToast("Enter an estimate between 0.1 and 30 ml.");return;}
      extra.resource.mlPerPump=value; state.average.handwash=value; saveExtra(); save(); render(); featureToast("Dispense estimate saved.");
    }
    else if(action==="tour-prev") { extra.showcase.step=Math.max(0,extra.showcase.step-1); saveExtra(); render(); }
    else if(action==="tour-next") { extra.showcase.completed=[...new Set([...extra.showcase.completed,extra.showcase.step])]; extra.showcase.step=(extra.showcase.step+1)%showcaseSteps.length; saveExtra(); render(); }
    else if(action==="tour-select") { extra.showcase.step=Math.max(0,Math.min(showcaseSteps.length-1,Number(element.dataset.extraIndex)||0)); saveExtra(); render(); }
    else if(action==="tour-open") { extra.showcase.completed=[...new Set([...extra.showcase.completed,extra.showcase.step])]; saveExtra(); navigate(showcaseSteps[extra.showcase.step].page); }
    else if(action==="tour-reset") { extra.showcase={step:0,completed:[]}; saveExtra(); render(); featureToast("Presentation tour reset."); }
    else if(action==="export-data") exportMorniData();
    else if(action==="focus-toggle") toggleFocus();
    else if(action==="focus-reset") { clearInterval(focusLoop); extra.focus={running:false,remaining:300,endsAt:0,sessions:extra.focus.sessions||0}; saveExtra(); render(); }
  }

  function injectUltimateStyles() {
    if($("#morni-ultimate-styles")) return;
    const css=`

      :root{
  --mori-ink:#193b2a;
  --mori-green:#2f6b45;
  --mori-leaf:#78a77a;
  --mori-orange:#e5a14b;
  --mori-cream:#fbf8ef;
  --mori-line:rgba(39,82,53,.13);
  --mori-muted:#718174;
  --mori-shadow:0 18px 55px rgba(32,68,43,.08)
}

      .morni-home-launch{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:14px;
  padding:16px 19px;
  margin:16px 0;
  border:1px solid var(--mori-line);
  border-radius:17px;
  background:linear-gradient(100deg,#f7f2e4,#edf4e9)
}
.morni-home-launch b{
  display:block;
  font-size:14px;
  color:#244d35;
  margin:4px 0
}
.morni-home-launch small{
  display:block;
  font-size:10px;
  color:#718174
}
.morni-feature-nav{
  display:flex;
  align-items:center;
  gap:7px;
  overflow-x:auto;
  padding:9px 0 16px;
  margin-bottom:4px;
  scrollbar-width:thin
}

      .morni-nav-label{
  font-size:9px;
  letter-spacing:1.5px;
  font-weight:900;
  color:var(--mori-muted);
  white-space:nowrap;
  margin-right:7px
}

      .morni-feature-nav button{
  border:1px solid var(--mori-line);
  background:var(--surface,var(--mori-cream));
  color:var(--text,var(--mori-ink));
  border-radius:999px;
  padding:9px 13px;
  min-height:38px;
  font-size:11px;
  font-weight:750;
  white-space:nowrap;
  display:flex;
  align-items:center;
  gap:7px;
  cursor:pointer;
  transition:.2s
}

      .morni-feature-nav button:hover,.morni-feature-nav button.active{
  background:#244d35;
  color:#fff;
  border-color:#244d35;
  transform:translateY(-1px)
}

      .morni-feature-nav button span{
  font-size:14px
}

      .morni-command-hero{
  position:relative;
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:25px;
  min-height:270px;
  padding:35px 42px;
  border-radius:27px;
  overflow:hidden;
  background:linear-gradient(112deg,#173e2b 0%,#285b3b 58%,#d78e3d 160%);
  color:#fff;
  box-shadow:var(--mori-shadow)
}

      .morni-command-hero:after{
  content:"";
  position:absolute;
  width:360px;
  height:360px;
  border:1px solid rgba(255,255,255,.15);
  border-radius:50%;
  right:5%;
  top:-180px;
  box-shadow:0 0 0 35px rgba(255,255,255,.035),0 0 0 75px rgba(255,255,255,.025)
}

      .morni-command-copy{
  position:relative;
  z-index:1;
  max-width:620px
}
.morni-kicker{
  display:block;
  font-size:9px;
  letter-spacing:1.8px;
  font-weight:900;
  color:#a4c5a4
}
.morni-command-hero h1,.morni-page-heading h1,.showcase-hero h1{
  font-size:clamp(34px,5vw,56px);
  line-height:1.04;
  letter-spacing:-2px;
  margin:14px 0;
  color:inherit
}
.morni-command-hero h1 em,.morni-page-heading h1 em,.showcase-hero h1 em{
  font-family:Georgia,serif;
  font-weight:500;
  color:#f2bd70
}
.morni-command-hero p{
  color:rgba(255,255,255,.78);
  max-width:540px;
  line-height:1.7;
  font-size:14px
}
.morni-hero-tags{
  display:flex;
  gap:8px;
  flex-wrap:wrap;
  margin-top:20px
}
.morni-hero-tags span,.showcase-trust-tags span{
  font-size:10px;
  padding:7px 10px;
  border:1px solid rgba(255,255,255,.22);
  border-radius:30px;
  color:#fff;
  background:rgba(255,255,255,.07)
}

      .morni-command-orb{
  width:180px;
  height:180px;
  flex:0 0 180px;
  border-radius:50%;
  border:1px solid rgba(255,255,255,.3);
  display:grid;
  place-items:center;
  position:relative;
  background:radial-gradient(circle at 50% 43%,rgba(245,190,105,.22),rgba(255,255,255,.03) 65%);
  z-index:1;
  text-align:center;
  font-size:9px;
  letter-spacing:2px;
  color:#e8f0df
}
.morni-command-orb:before,.morni-command-orb:after{
  content:"";
  position:absolute;
  inset:13px;
  border:1px dashed rgba(255,255,255,.27);
  border-radius:50%
}
.morni-command-orb:after{
  inset:-13px;
  border-style:solid;
  opacity:.4
}
.morni-command-orb b{
  font-size:12px;
  color:#f2bd70
}
.orb-sun{
  width:68px;
  height:68px;
  border-radius:50%;
  background:linear-gradient(145deg,#ffe2a2,#e99c45);
  box-shadow:0 0 45px rgba(243,176,83,.45);
  position:absolute;
  top:34px
}
.morni-command-orb span{
  position:relative;
  z-index:1;
  margin-top:90px
}

      .morni-section-heading{
  display:flex;
  align-items:end;
  justify-content:space-between;
  gap:15px;
  margin:29px 0 14px
}
.morni-section-heading h2{
  font-size:22px;
  color:var(--text,var(--mori-ink));
  margin:5px 0 0;
  letter-spacing:-.6px
}
.morni-section-heading .morni-kicker{
  color:var(--mori-green)
}
.morni-date-stamp{
  font-size:10px;
  color:var(--mori-muted);
  font-weight:800;
  white-space:nowrap
}

      .morni-score-row{
  display:grid;
  grid-template-columns:1.4fr 1fr;
  gap:14px;
  margin-top:15px
}
.morni-score-card,.morni-water-card,.morni-glass-panel{
  background:var(--surface,var(--mori-cream));
  border:1px solid var(--mori-line);
  border-radius:21px;
  padding:20px;
  box-shadow:var(--mori-shadow);
  min-width:0
}
.morni-score-card{
  display:flex;
  align-items:center;
  gap:20px
}
.score-dial,.readiness-big-dial{
  width:116px;
  height:116px;
  flex:0 0 116px;
  border-radius:50%;
  display:grid;
  place-items:center;
  background:conic-gradient(#e3a14d var(--score),rgba(53,103,66,.12) 0);
  position:relative
}
.score-dial:before,.readiness-big-dial:before{
  content:"";
  position:absolute;
  inset:9px;
  border-radius:50%;
  background:var(--surface,var(--mori-cream))
}
.score-dial>div,.readiness-big-dial>div{
  position:relative;
  text-align:center
}
.score-dial b,.readiness-big-dial b{
  display:block;
  font-size:33px;
  line-height:1;
  color:var(--text,var(--mori-ink))
}
.score-dial small,.readiness-big-dial small{
  font-size:10px;
  color:var(--mori-muted)
}
.morni-score-card h3{
  font-size:20px;
  margin:6px 0;
  color:var(--text,var(--mori-ink))
}
.morni-score-card p,.morni-water-card p{
  font-size:12px;
  line-height:1.6;
  color:var(--mori-muted);
  margin:4px 0
}
.morni-water-card{
  background:linear-gradient(145deg,#f7fbf3,#edf5e9)
}
.water-card-top{
  display:flex;
  justify-content:space-between;
  align-items:center;
  font-size:9px;
  letter-spacing:1px;
  font-weight:900;
  color:#66816b
}
.water-card-top span:first-child{
  font-size:22px
}
.morni-water-card>b{
  display:block;
  font-size:30px;
  color:#244d35;
  margin-top:8px
}
.morni-water-card>b small{
  font-size:15px;
  color:#819582
}
.morni-meter{
  height:7px;
  border-radius:20px;
  background:rgba(47,91,57,.11);
  overflow:hidden;
  margin:9px 0
}
.morni-meter i{
  display:block;
  height:100%;
  border-radius:inherit;
  background:linear-gradient(90deg,#579366,#e5a14b);
  transition:width .35s
}
.water-actions{
  display:flex;
  gap:8px;
  margin-top:9px
}
.water-actions button{
  border:1px solid rgba(47,91,57,.17);
  border-radius:9px;
  background:#fff;
  color:#315b3d;
  padding:7px 12px;
  font-size:11px;
  font-weight:800;
  cursor:pointer
}
.water-actions button:last-child{
  background:#315b3d;
  color:#fff
}
.water-target-control{display:flex;align-items:center;gap:6px;margin-top:9px}.water-target-control label{font-size:9px;color:#66816b;font-weight:800}.water-target-control input{width:46px;min-height:29px;border:1px solid rgba(47,91,57,.17);border-radius:8px;padding:4px;background:#fff;color:#315b3d;font-size:11px}.water-target-control button{border:0;border-radius:8px;background:#e7efdf;color:#315b3d;padding:7px 9px;font-size:9px;font-weight:900;cursor:pointer}
      .morni-disclaimer,.morni-footnote{
  display:block;
  font-size:10px;
  color:var(--mori-muted);
  line-height:1.55;
  margin-top:12px
}

      .morni-nudge-card{
  display:flex;
  align-items:center;
  gap:15px;
  padding:18px 20px;
  margin-top:14px;
  border-radius:18px;
  background:linear-gradient(100deg,#fff8e9,#f3f7ed);
  border:1px solid rgba(221,166,84,.2)
}
.nudge-icon{
  width:42px;
  height:42px;
  border-radius:14px;
  background:#e9ad58;
  color:#fff;
  display:grid;
  place-items:center;
  font-size:21px;
  flex:0 0 42px
}
.morni-nudge-card>div{
  flex:1;
  min-width:0
}
.morni-nudge-card .morni-kicker{
  color:#9c7138
}
.morni-nudge-card h3{
  font-size:16px;
  margin:4px 0;
  color:#244d35
}
.morni-nudge-card p{
  font-size:12px;
  color:#6f7e70;
  margin:0;
  line-height:1.5
}
.morni-nudge-card .btn{
  white-space:nowrap
}

      .feature-card-grid{
  display:grid;
  grid-template-columns:repeat(3,minmax(0,1fr));
  gap:12px
}
.feature-card{
  display:flex;
  align-items:flex-start;
  gap:14px;
  text-align:left;
  padding:18px;
  border-radius:18px;
  border:1px solid var(--mori-line);
  background:var(--surface,var(--mori-cream));
  color:var(--text,var(--mori-ink));
  cursor:pointer;
  min-height:132px;
  transition:.2s;
  box-shadow:0 8px 25px rgba(32,68,43,.04)
}
.feature-card:hover{
  transform:translateY(-3px);
  box-shadow:var(--mori-shadow);
  border-color:rgba(62,121,76,.35)
}
.feature-card-icon{
  width:43px;
  height:43px;
  flex:0 0 43px;
  border-radius:14px;
  background:#edf4e9;
  color:#315f3c;
  display:grid;
  place-items:center;
  font-size:22px
}
.feature-card-copy{
  display:flex;
  flex-direction:column;
  gap:6px
}
.feature-card-copy b{
  font-size:14px
}
.feature-card-copy small{
  font-size:11px;
  line-height:1.5;
  color:var(--mori-muted)
}
.feature-card-copy em{
  font-size:8px;
  letter-spacing:1px;
  font-style:normal;
  font-weight:900;
  color:#b57b38;
  margin-top:4px
}
.morni-lower-grid{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:14px;
  margin-top:14px
}
.morni-panel-head{
  display:flex;
  align-items:center;
  justify-content:space-between;
  margin-bottom:15px
}
.morni-panel-head h3{
  font-size:17px;
  margin:4px 0;
  color:var(--text,var(--mori-ink))
}
.morni-panel-head>span{
  font-size:22px;
  color:#d99a48
}
.morni-collectible-icon{
  width:45px;
  height:45px;
  border-radius:14px;
  background:#f8edda;
  display:grid;
  place-items:center;
  font-size:25px
}
.equipped-preview b{
  display:block;
  font-size:18px;
  color:var(--text,var(--mori-ink))
}
.equipped-preview small{
  display:block;
  color:var(--mori-muted);
  font-size:11px;
  margin-top:4px
}
.text-link{
  border:0;
  background:transparent;
  color:#3c784c;
  font-size:11px;
  font-weight:900;
  padding:12px 0 0;
  cursor:pointer
}
.readiness-line{
  display:grid;
  grid-template-columns:1fr auto;
  gap:5px 12px;
  margin:11px 0
}
.readiness-line span{
  font-size:11px;
  color:var(--mori-muted)
}
.readiness-line b{
  font-size:11px;
  color:var(--text,var(--mori-ink))
}
.readiness-line .morni-meter{
  grid-column:1/-1;
  margin:0
}

      .morni-page-heading{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:20px;
  margin:12px 0 24px
}
.morni-page-heading>div{
  max-width:680px
}
.morni-page-heading .morni-kicker{
  color:#52815a
}
.morni-page-heading h1{
  color:var(--text,var(--mori-ink));
  margin:8px 0
}
.morni-page-heading p{
  font-size:13px;
  color:var(--mori-muted);
  line-height:1.65;
  max-width:610px
}
.morni-live-label{
  font-size:9px;
  font-weight:900;
  letter-spacing:1px;
  color:#9a6c30;
  background:#fff3df;
  border:1px solid #f0dfc4;
  padding:9px 12px;
  border-radius:30px;
  white-space:nowrap
}
.handwash-workspace{
  display:grid;
  grid-template-columns:1.1fr .9fr;
  gap:14px
}
.handwash-main-panel{
  display:grid;
  grid-template-columns:180px 1fr;
  align-items:center;
  gap:15px
}
.handwash-stage-visual{
  width:170px;
  height:170px;
  border-radius:50%;
  display:grid;
  place-items:center;
  position:relative;
  background:radial-gradient(circle,#fff5df 0%,#f2f5e8 65%,transparent 66%)
}
.handwash-glow{
  position:absolute;
  inset:14px;
  border:1px dashed rgba(52,103,61,.25);
  border-radius:50%;
  animation:morni-orbit 24s linear infinite
}
.handwash-stage-icon{
  font-size:55px;
  z-index:1
}
.handwash-step-count{
  position:absolute;
  bottom:13px;
  font-size:8px;
  font-weight:900;
  letter-spacing:1px;
  color:#68816b
}
.handwash-current .morni-kicker{
  color:#63906b
}
.handwash-current h2{
  font-size:25px;
  color:var(--text,var(--mori-ink));
  margin:7px 0
}
.handwash-current p{
  font-size:12px;
  line-height:1.6;
  color:var(--mori-muted)
}
.handwash-timer-wrap{
  grid-column:1/-1;
  display:flex;
  align-items:center;
  justify-content:center;
  gap:18px;
  padding:6px
}
.handwash-ring{
  width:105px;
  height:105px;
  flex:0 0 105px
}
.handwash-ring .timer-center b{
  font-size:23px
}
.handwash-timer-wrap>span{
  font-size:11px;
  color:var(--mori-muted);
  font-weight:800
}
.handwash-controls{
  grid-column:1/-1;
  display:flex;
  gap:9px;
  justify-content:center
}
.handwash-steps-panel .morni-panel-head{
  margin-bottom:7px
}
.handwash-step-row{
  display:flex;
  align-items:center;
  gap:11px;
  padding:12px 0;
  border-bottom:1px solid var(--mori-line)
}
.step-row-icon{
  width:34px;
  height:34px;
  border-radius:11px;
  background:#f0f5eb;
  display:grid;
  place-items:center;
  flex:0 0 34px
}
.handwash-step-row>div{
  flex:1;
  min-width:0
}
.handwash-step-row b{
  display:block;
  font-size:12px;
  color:var(--text,var(--mori-ink))
}
.handwash-step-row small{
  display:block;
  font-size:10px;
  color:var(--mori-muted);
  line-height:1.4;
  margin-top:3px
}
.handwash-step-row em{
  font-size:10px;
  font-style:normal;
  color:#9b783f;
  font-weight:900
}
.step-current .step-row-icon{
  background:#e5f1df;
  box-shadow:0 0 0 3px rgba(90,145,88,.1)
}
.step-current b{
  color:#39734a
}
.step-passed{
  opacity:.65
}
.handwash-tip{
  margin-top:14px;
  padding:12px;
  border-radius:13px;
  background:#f8f3e7
}
.handwash-tip b{
  font-size:11px;
  color:#966c36
}
.handwash-tip p{
  font-size:10px;
  line-height:1.5;
  color:#777b68;
  margin:5px 0 0
}
.morni-history-row{
  display:flex;
  align-items:center;
  gap:12px;
  padding:12px 0;
  border-bottom:1px solid var(--mori-line)
}
.morni-history-row:last-child{
  border:0
}
.morni-history-row>span{
  width:30px;
  height:30px;
  border-radius:10px;
  background:#eaf3e7;
  color:#3e794d;
  display:grid;
  place-items:center
}
.morni-history-row>div{
  flex:1;
  min-width:0
}
.morni-history-row b{
  display:block;
  font-size:12px;
  color:var(--text,var(--mori-ink))
}
.morni-history-row small{
  display:block;
  font-size:10px;
  color:var(--mori-muted);
  margin-top:3px
}
.morni-history-row em{
  font-style:normal;
  font-size:10px;
  color:#8a9b89
}
.morni-empty-state{
  text-align:center;
  padding:25px 10px;
  color:var(--mori-muted)
}
.morni-empty-state>span{
  font-size:30px;
  color:#d59a4c
}
.morni-empty-state b{
  display:block;
  font-size:13px;
  color:var(--text,var(--mori-ink));
  margin:8px 0
}
.morni-empty-state small{
  font-size:11px
}

      .planner-top-grid{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:14px
}
.morni-field{
  display:flex;
  flex-direction:column;
  gap:6px;
  font-size:11px;
  font-weight:800;
  color:var(--text,var(--mori-ink));
  margin:13px 0
}
.morni-field input,.add-task-fields input{
  border:1px solid var(--mori-line);
  border-radius:11px;
  padding:11px 12px;
  background:var(--surface,var(--mori-cream));
  color:var(--text,var(--mori-ink));
  font:inherit;
  min-height:42px
}
.planner-settings .btn{
  margin-top:7px
}
.time-budget-card{
  background:linear-gradient(145deg,#244d35,#376a47);
  color:#fff
}
.time-budget-card .morni-kicker{
  color:#b9d3ae
}
.time-budget-number{
  font-size:55px;
  font-weight:850;
  letter-spacing:-2px;
  margin:12px 0
}
.time-budget-number small{
  display:block;
  font-size:11px;
  letter-spacing:0;
  font-weight:600;
  color:rgba(255,255,255,.7)
}
.budget-comparison{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:10px;
  border-top:1px solid rgba(255,255,255,.18);
  padding-top:13px
}
.budget-comparison small{
  display:block;
  font-size:8px;
  letter-spacing:1px;
  color:rgba(255,255,255,.65)
}
.budget-comparison b{
  display:block;
  font-size:17px;
  margin-top:5px
}
.budget-comparison .budget-warning{
  color:#ffcf9b
}
.time-budget-card>p{
  font-size:11px;
  line-height:1.5;
  color:rgba(255,255,255,.78)
}
.planner-timeline{
  padding:8px 20px
}
.planner-task-row{
  display:flex;
  align-items:center;
  gap:13px;
  padding:14px 0;
  border-bottom:1px solid var(--mori-line)
}
.planner-task-row:last-child{
  border:0
}
.planner-check{
  width:31px;
  height:31px;
  border:1px solid #c8d8c4;
  border-radius:50%;
  background:#f7f8f1;
  color:#456d4b;
  font-weight:900;
  cursor:pointer;
  flex:0 0 31px
}
.task-done .planner-check{
  background:#3e754a;
  color:white
}
.planner-task-copy{
  flex:1;
  min-width:0
}
.planner-task-copy b{
  display:block;
  font-size:13px;
  color:var(--text,var(--mori-ink))
}
.planner-task-copy small{
  display:block;
  font-size:10px;
  color:var(--mori-muted);
  margin-top:4px
}
.task-done .planner-task-copy b{
  text-decoration:line-through;
  opacity:.65
}
.planner-fixed-label{
  font-size:8px;
  letter-spacing:1px;
  color:#9a8a6b
}
.planner-remove{
  border:0;
  background:transparent;
  color:#b56c4c;
  font-size:20px;
  cursor:pointer
}
.add-task-panel{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:18px;
  margin-top:14px
}
.add-task-panel h3{
  margin:5px 0;
  color:var(--text,var(--mori-ink))
}
.add-task-panel p{
  font-size:11px;
  color:var(--mori-muted);
  margin:0
}
.add-task-fields{
  display:flex;
  gap:7px;
  align-items:center
}
.add-task-fields input:first-child{
  width:190px
}
.add-task-fields input:nth-child(2){
  width:70px
}

      .points-wallet{
  padding:15px 22px;
  border-radius:17px;
  background:#fff4df;
  border:1px solid #efdfc2;
  min-width:145px
}
.points-wallet span,.points-wallet small{
  display:block;
  font-size:8px;
  letter-spacing:1px;
  font-weight:900;
  color:#9b7844
}
.points-wallet b{
  display:block;
  font-size:28px;
  color:#244d35;
  margin:5px 0
}
.reward-feature-banner{
  display:flex;
  align-items:center;
  justify-content:space-between;
  padding:22px 28px;
  border-radius:20px;
  background:linear-gradient(105deg,#f7f0df,#eaf2e5);
  border:1px solid #e6e5d4
}
.reward-feature-banner h2{
  font-size:24px;
  color:#244d35;
  margin:7px 0
}
.reward-feature-banner p{
  font-size:11px;
  color:#718174
}
.reward-feature-banner>span{
  font-size:52px
}
.reward-shop-grid{
  display:grid;
  grid-template-columns:repeat(3,minmax(0,1fr));
  gap:13px
}
.reward-item{
  border:1px solid var(--mori-line);
  border-radius:17px;
  padding:14px;
  background:var(--surface,var(--mori-cream));
  box-shadow:0 8px 25px rgba(32,68,43,.04);
  min-width:0
}
.reward-item-art{
  height:100px;
  border-radius:13px;
  background:linear-gradient(145deg,#f4f3e7,#eaf2e5);
  display:flex;
  align-items:center;
  justify-content:center;
  position:relative
}
.reward-item-art>span{
  font-size:43px
}
.reward-item-art small{
  position:absolute;
  right:8px;
  top:8px;
  background:rgba(255,255,255,.8);
  border-radius:20px;
  padding:4px 7px;
  font-size:8px;
  color:#718174
}
.reward-item-copy h3{
  font-size:14px;
  color:var(--text,var(--mori-ink));
  margin:12px 0 5px
}
.reward-item-copy p{
  font-size:10px;
  line-height:1.5;
  color:var(--mori-muted);
  min-height:31px;
  margin:0
}
.reward-item-footer{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:8px;
  margin-top:12px
}
.reward-item-footer>b{
  font-size:11px;
  color:#9a713c
}
.reward-item-footer .btn{
  padding:8px 12px;
  min-height:34px;
  font-size:10px
}
.reward-owned{
  border-color:rgba(69,132,78,.25)
}
.reward-owned .reward-item-art{
  background:linear-gradient(145deg,#e6f2e3,#f7f1e3)
}

      .readiness-hero-card{
  display:flex;
  align-items:center;
  gap:25px;
  padding:25px;
  border-radius:22px;
  background:linear-gradient(110deg,#1d482f,#376c46);
  color:#fff
}
.readiness-big-dial{
  width:140px;
  height:140px;
  flex-basis:140px;
  background:conic-gradient(#efb35f var(--score),rgba(255,255,255,.18) 0)
}
.readiness-big-dial:before{
  background:#285738
}
.readiness-big-dial b{
  color:white;
  font-size:42px
}
.readiness-big-dial small{
  color:#c6d9c3
}
.readiness-hero-card .morni-kicker{
  color:#c0d8b7
}
.readiness-hero-card h2{
  font-size:22px;
  margin:8px 0
}
.readiness-hero-card p{
  font-size:11px;
  line-height:1.6;
  color:rgba(255,255,255,.75);
  max-width:570px
}
.readiness-signal-grid{
  display:grid;
  grid-template-columns:repeat(2,minmax(0,1fr));
  gap:12px
}
.readiness-signal{
  display:grid;
  grid-template-columns:36px 1fr auto;
  align-items:center;
  gap:8px 12px;
  padding:16px;
  border-radius:16px;
  background:var(--surface,var(--mori-cream));
  border:1px solid var(--mori-line)
}
.readiness-signal>span{
  width:34px;
  height:34px;
  border-radius:11px;
  background:#edf4e9;
  display:grid;
  place-items:center;
  color:#47764d;
  font-size:18px
}
.readiness-signal>div{
  min-width:0
}
.readiness-signal b{
  display:block;
  font-size:12px;
  color:var(--text,var(--mori-ink))
}
.readiness-signal small{
  display:block;
  font-size:10px;
  color:var(--mori-muted);
  line-height:1.4;
  margin-top:3px
}
.readiness-signal strong{
  font-size:15px;
  color:#397349
}
.readiness-signal .morni-meter{
  grid-column:1/-1;
  margin:0
}
.formula-panel{
  margin-top:14px
}
.formula-panel h3{
  font-size:18px;
  color:var(--text,var(--mori-ink));
  margin:9px 0
}
.formula-panel p{
  font-size:11px;
  color:var(--mori-muted);
  line-height:1.6
}
.resource-panel{
  display:grid;
  grid-template-columns:190px 1fr;
  gap:20px;
  align-items:center
}
.resource-bottle{
  display:flex;
  flex-direction:column;
  align-items:center;
  gap:7px;
  padding:20px;
  border-radius:17px;
  background:#f4f1e4
}
.resource-bottle>span{
  font-size:55px
}
.resource-bottle b{
  display:block;
  font-size:24px;
  color:#315b3d
}
.resource-bottle small{
  font-size:10px;
  color:#7b8c7c
}
.resource-details{
  min-width:0
}
.resource-detail-top{
  display:flex;
  justify-content:space-between;
  font-size:12px;
  color:var(--text,var(--mori-ink))
}
.resource-details p{
  font-size:11px;
  color:var(--mori-muted)
}
.resource-details .morni-field{
  max-width:250px
}

      .showcase-hero{
  padding:32px;
  border-radius:24px;
  background:linear-gradient(115deg,#173e2b,#315f3c 65%,#d78e3d);
  color:#fff
}
.showcase-hero h1{
  margin:12px 0
}
.showcase-hero p{
  font-size:13px;
  line-height:1.7;
  color:rgba(255,255,255,.8);
  max-width:650px
}
.showcase-trust-tags{
  display:flex;
  flex-wrap:wrap;
  gap:8px;
  margin-top:20px
}
.showcase-progress-head{
  display:flex;
  align-items:end;
  justify-content:space-between;
  margin:25px 0 12px
}
.showcase-progress-head h2{
  font-size:21px;
  color:var(--text,var(--mori-ink));
  margin:5px 0
}
.showcase-progress-head>b{
  font-size:11px;
  color:var(--mori-muted)
}
.showcase-layout{
  display:grid;
  grid-template-columns:1.2fr .8fr;
  gap:14px
}
.showcase-step-card{
  padding:24px
}
.showcase-step-count{
  font-size:9px;
  letter-spacing:1.5px;
  font-weight:900;
  color:#b47d3d
}
.showcase-step-mark{
  width:60px;
  height:60px;
  border-radius:18px;
  background:#edf4e9;
  display:grid;
  place-items:center;
  font-size:28px;
  color:#3c7548;
  margin:16px 0
}
.showcase-step-card h2{
  font-size:24px;
  color:var(--text,var(--mori-ink));
  margin:6px 0
}
.showcase-step-card>p{
  font-size:12px;
  line-height:1.7;
  color:var(--mori-muted)
}
.showcase-proof{
  padding:14px;
  border-radius:13px;
  background:#f8f3e8;
  margin-top:18px
}
.showcase-proof b{
  display:block;
  font-size:8px;
  letter-spacing:1px;
  color:#a47a40
}
.showcase-proof span{
  display:block;
  font-size:11px;
  line-height:1.55;
  color:#5e715f;
  margin-top:5px
}
.showcase-controls{
  display:flex;
  flex-wrap:wrap;
  gap:7px;
  margin-top:20px
}
.showcase-controls .btn{
  font-size:10px;
  padding:9px 12px
}
.showcase-chapters{
  padding:18px
}
.showcase-chapter{
  width:100%;
  display:flex;
  align-items:center;
  gap:11px;
  padding:13px 7px;
  border:0;
  border-bottom:1px solid var(--mori-line);
  background:transparent;
  text-align:left;
  cursor:pointer
}
.showcase-chapter:last-child{
  border:0
}
.showcase-chapter>span{
  width:30px;
  height:30px;
  border-radius:10px;
  background:#f0f3e9;
  display:grid;
  place-items:center;
  font-size:10px;
  font-weight:900;
  color:#527654
}
.showcase-chapter>div{
  flex:1;
  min-width:0
}
.showcase-chapter b{
  display:block;
  font-size:11px;
  color:var(--text,var(--mori-ink))
}
.showcase-chapter small{
  display:block;
  font-size:9px;
  color:var(--mori-muted);
  margin-top:3px
}
.showcase-chapter em{
  font-style:normal;
  color:#a47a40
}
.chapter-active{
  background:#f5f7ee;
  border-radius:12px
}
.chapter-done>span{
  background:#3d7849;
  color:#fff
}
.showcase-honesty{
  display:flex;
  gap:13px;
  padding:17px;
  margin-top:14px;
  border-radius:16px;
  background:#fff5e6;
  border:1px solid #f0dfc4
}
.showcase-honesty>span{
  font-size:21px;
  color:#a77838
}
.showcase-honesty b{
  font-size:12px;
  color:#805d30
}
.showcase-honesty p{
  font-size:11px;
  line-height:1.65;
  color:#776b57;
  margin:5px 0 0
}
.showcase-footer-actions{
  display:flex;
  gap:8px;
  flex-wrap:wrap;
  margin-top:15px
}
.focus-card{
  text-align:center;
  max-width:600px;
  margin:0 auto;
  padding:35px
}
.focus-orb{
  width:120px;
  height:120px;
  margin:0 auto 15px;
  border-radius:50%;
  display:grid;
  place-items:center;
  background:radial-gradient(circle,#fff0d1,#e7f1e4);
  font-size:40px;
  color:#39734a
}
.focus-timer{
  font-size:58px;
  font-weight:850;
  letter-spacing:-2px;
  color:var(--text,var(--mori-ink))
}
.focus-card p{
  font-size:12px;
  color:var(--mori-muted)
}
.focus-controls{
  display:flex;
  justify-content:center;
  gap:9px;
  margin:18px
}
.focus-card>small{
  font-size:10px;
  color:var(--mori-muted)
}

      body[data-theme="dark"] .morni-glass-panel,body[data-theme="dark"] .feature-card,body[data-theme="dark"] .morni-score-card,body[data-theme="dark"] .morni-water-card,body[data-theme="dark"] .reward-item,body[data-theme="dark"] .readiness-signal{
  background:var(--surface,#17251c);
  color:var(--text,#eef2e9)
}

      body[data-theme="dark"] .morni-feature-nav button{
  background:#17251c;
  color:#eaf0e6
}
body[data-theme="dark"] .morni-feature-nav button.active{
  background:#3a7548;
  color:#fff
}
body[data-theme="dark"] .morni-nudge-card,body[data-theme="dark"] .showcase-proof,body[data-theme="dark"] .handwash-tip{
  background:#263528
}
body[data-theme="dark"] .reward-feature-banner,body[data-theme="dark"] .reward-item-art,body[data-theme="dark"] .resource-bottle{
  background:#263528
}
body[data-theme="dark"] .morni-score-card p,body[data-theme="dark"] .feature-card-copy small,body[data-theme="dark"] .morni-page-heading p{
  color:#b3c1b1
}

      @keyframes morni-orbit{
  to{
  transform:rotate(360deg)
}

}

      @media(max-width:900px){
  .feature-card-grid,.reward-shop-grid{
  grid-template-columns:repeat(2,minmax(0,1fr))
}
.handwash-workspace,.showcase-layout{
  grid-template-columns:1fr
}
.morni-score-row{
  grid-template-columns:1fr 1fr
}
.handwash-main-panel{
  grid-template-columns:150px 1fr
}
.handwash-stage-visual{
  width:145px;
  height:145px
}
.planner-top-grid{
  grid-template-columns:1fr 1fr
}

}

      @media(max-width:650px){
  .morni-home-launch{
  align-items:flex-start;
  flex-direction:column
}
.morni-home-launch .btn{
  width:100%
}
.morni-command-hero{
  padding:25px 20px;
  min-height:300px
}
.morni-command-orb{
  width:100px;
  height:100px;
  flex-basis:100px;
  opacity:.8
}
.morni-command-orb:before{
  inset:7px
}
.morni-command-orb:after{
  inset:-7px
}
.orb-sun{
  width:40px;
  height:40px;
  top:18px
}
.morni-command-orb span{
  font-size:7px;
  margin-top:52px
}
.morni-command-orb b{
  font-size:8px
}
.morni-command-hero h1{
  font-size:36px
}
.morni-hero-tags span{
  font-size:8px
}
.morni-score-row,.morni-lower-grid,.planner-top-grid,.readiness-signal-grid{
  grid-template-columns:1fr
}
.morni-score-card{
  gap:13px
}
.score-dial{
  width:90px;
  height:90px;
  flex-basis:90px
}
.score-dial b{
  font-size:27px
}
.morni-nudge-card{
  align-items:flex-start;
  flex-wrap:wrap
}
.morni-nudge-card>div{
  width:calc(100% - 60px)
}
.morni-nudge-card .btn{
  margin-left:56px
}
.feature-card-grid,.reward-shop-grid{
  grid-template-columns:1fr 1fr
}
.feature-card{
  padding:13px;
  gap:9px;
  min-height:145px
}
.feature-card-icon{
  width:34px;
  height:34px;
  flex-basis:34px;
  font-size:18px
}
.feature-card-copy b{
  font-size:12px
}
.feature-card-copy small{
  font-size:10px
}
.morni-page-heading{
  align-items:flex-start;
  flex-direction:column;
  gap:8px
}
.morni-page-heading h1{
  font-size:39px
}
.morni-live-label{
  white-space:normal
}
.handwash-main-panel{
  grid-template-columns:1fr;
  text-align:center
}
.handwash-stage-visual{
  margin:auto
}
.handwash-current{
  padding:0 5px
}
.handwash-timer-wrap{
  grid-column:1
}
.handwash-controls{
  grid-column:1;
  flex-wrap:wrap
}
.add-task-panel{
  align-items:stretch;
  flex-direction:column
}
.add-task-fields{
  display:grid;
  grid-template-columns:1fr 70px
}
.add-task-fields input:first-child{
  width:100%;
  grid-column:1/-1
}
.add-task-fields input:nth-child(2){
  width:100%
}
.add-task-fields .btn{
  grid-column:1/-1
}
.readiness-hero-card{
  align-items:flex-start;
  flex-direction:column
}
.resource-panel{
  grid-template-columns:1fr
}
.resource-bottle{
  flex-direction:row;
  justify-content:center
}
.showcase-hero{
  padding:23px
}
.showcase-hero h1{
  font-size:37px
}
.showcase-controls .btn{
  flex:1
}
.points-wallet{
  width:100%
}
.morni-feature-nav{
  margin-inline:-3px
}
.morni-nav-label{
  display:none
}

}

      @media(max-width:390px){
  .feature-card-grid,.reward-shop-grid{
  grid-template-columns:1fr
}
.morni-command-orb{
  display:none
}
.morni-command-hero{
  min-height:0
}
.morni-score-card{
  align-items:flex-start;
  flex-direction:column
}
.morni-score-row{
  gap:9px
}
.morni-section-heading{
  align-items:flex-start;
  flex-direction:column
}
.morni-nudge-card .btn{
  margin-left:0
}
.showcase-controls{
  display:grid;
  grid-template-columns:1fr 1fr
}
.showcase-controls .btn:nth-child(2){
  grid-column:1/-1;
  grid-row:1
}

}

      @media(prefers-reduced-motion:reduce){
  .handwash-glow{
  animation:none!important
}
.feature-card,.morni-feature-nav button{
  transition:none!important
}

}

    

/* Hardware-independent presentation note */
.morni-software-demo-note{display:flex;align-items:center;gap:13px;padding:15px 18px;margin:14px 0;border:1px solid rgba(71,119,74,.2);border-radius:16px;background:linear-gradient(105deg,#edf5e5,#fff3df);color:#244d35}
.morni-demo-note-icon{display:grid;place-items:center;width:36px;height:36px;flex:none;border-radius:12px;background:#dcebbd;color:#315b3d;font-size:18px}
.morni-software-demo-note>div{flex:1;min-width:0}
.morni-software-demo-note b{display:block;color:#244d35;font-size:12px}
.morni-software-demo-note p{margin:4px 0 0;color:#617465;font-size:10px;line-height:1.55}
body[data-theme="dark"] .morni-software-demo-note{background:#263528;border-color:#425746}
body[data-theme="dark"] .morni-software-demo-note b{color:#edf4e8}
body[data-theme="dark"] .morni-software-demo-note p{color:#b3c1b1}
@media(max-width:650px){.morni-software-demo-note{align-items:flex-start;flex-wrap:wrap}.morni-software-demo-note .btn{width:100%}}
/* MORNI readability and profile polish */
#pageContent .morni-profile-button{
  margin-left:auto;
  display:flex;
  align-items:center;
  gap:8px;
  padding:6px 12px 6px 7px;
  border-radius:999px;
  border:1px solid var(--mori-line);
  background:var(--surface,#f7f5eb);
  color:var(--text,#193b2a);
  font-weight:800;
}
#pageContent .morni-profile-button.active{background:#244d35;color:#fff}
.morni-profile-avatar,.profile-summary-avatar,.profile-avatar-large{
  display:grid;place-items:center;border-radius:50%;font-weight:900;
  background:linear-gradient(145deg,#d8edaa,#f2c27c);color:#244d35;
}
.morni-profile-avatar{width:27px;height:27px;font-size:12px}
.profile-avatar-large{width:76px;height:76px;font-size:30px;flex:none}
.profile-summary-card{display:flex;align-items:center;gap:16px;padding:22px;margin:14px 0}
.profile-summary-avatar{width:58px;height:58px;font-size:23px;flex:none}
.profile-summary-copy{flex:1;min-width:0}
.profile-summary-copy h2{margin:4px 0;color:var(--text,#193b2a)}
.profile-summary-copy p{margin:0;color:var(--muted,#718174);font-size:12px}
.profile-level{padding:10px 17px;border-radius:13px;background:#e8f0dc;color:#244d35;text-align:center}
.profile-level small,.profile-stat-grid article>span{display:block;font-size:9px;letter-spacing:1px;font-weight:900}
.profile-level b{font-size:25px}
.profile-stat-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:14px 0}
.profile-stat-grid article{padding:17px}
.profile-stat-grid article>span{color:var(--mori-muted)}
.profile-stat-grid article>b{display:block;font-size:25px;color:var(--text,#193b2a);margin:8px 0}
.profile-stat-grid article>small{color:var(--muted,#718174);font-size:10px}
.profile-edit-card{display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:20px}
.profile-edit-card>div{grid-column:1/-1}
.profile-edit-card h2{margin:4px 0;color:var(--text,#193b2a)}
.profile-edit-card p{margin:0;color:var(--muted,#718174);font-size:12px}
.profile-edit-card .btn{align-self:end}
.profile-shortcuts{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap}
/* Correct legacy white-on-white and white-on-cream text combinations. */
#pageContent .morni-glass-panel,
#pageContent .feature-card,
#pageContent .reward-item,
#pageContent .readiness-signal,
#pageContent .planner-task-row,
#pageContent .morni-score-card,
#pageContent .morni-water-card{
  color:var(--text,#193b2a);
}
#pageContent .morni-glass-panel :is(h1,h2,h3,h4,b,strong,label),
#pageContent .feature-card-copy b,
#pageContent .reward-item-copy h3{
  color:var(--text,#193b2a);
}
#pageContent .morni-glass-panel :is(p,small,.muted),
#pageContent .feature-card-copy small,
#pageContent .reward-item-copy p{
  color:var(--muted,#66796a);
}
#pageContent input:not([type="checkbox"]),
#pageContent select,
#pageContent textarea{
  background:var(--input-bg,#fffdf7);
  color:var(--text,#193b2a);
  border-color:var(--line,var(--mori-line));
}
#pageContent input::placeholder,
#pageContent textarea::placeholder{color:#718174;opacity:1}
#pageContent .morni-home-launch,
#pageContent .morni-home-launch *{color:#244d35}
#pageContent .morni-home-launch small{color:#647568}
body[data-theme="dark"] #pageContent .morni-glass-panel,
body[data-theme="dark"] #pageContent .feature-card,
body[data-theme="dark"] #pageContent .reward-item,
body[data-theme="dark"] #pageContent .readiness-signal,
body[data-theme="dark"] #pageContent .planner-task-row{
  background:var(--surface,#17251c);color:var(--text,#eef2e9);
}
body[data-theme="dark"] #pageContent .morni-glass-panel :is(h1,h2,h3,h4,b,strong,label),
body[data-theme="dark"] #pageContent .feature-card-copy b,
body[data-theme="dark"] #pageContent .reward-item-copy h3,
body[data-theme="dark"] #pageContent .profile-summary-copy h2{
  color:var(--text,#eef2e9);
}
body[data-theme="dark"] #pageContent .morni-glass-panel :is(p,small),
body[data-theme="dark"] #pageContent .feature-card-copy small,
body[data-theme="dark"] #pageContent .reward-item-copy p{
  color:var(--muted,#b3c1b1);
}
body[data-theme="dark"] #pageContent .morni-home-launch{background:#263528;border-color:#3a4b3a}
body[data-theme="dark"] #pageContent .morni-home-launch *{color:#edf4e8}
body[data-theme="dark"] #pageContent input:not([type="checkbox"]),
body[data-theme="dark"] #pageContent select,
body[data-theme="dark"] #pageContent textarea{background:#17251c;color:#eef2e9;border-color:#425746}
@media(max-width:650px){
  .profile-stat-grid{grid-template-columns:1fr}
  .profile-edit-card{grid-template-columns:1fr}
  .profile-edit-card>div{grid-column:auto}
  .profile-summary-card{flex-wrap:wrap}
  .profile-level{margin-left:auto}
  .morni-profile-label{display:none}
}
\n    `;
    const style=document.createElement("style");style.id="morni-ultimate-styles";style.textContent=css;document.head.appendChild(style);
  }

  /* ---------------------------------------------------------
     PAGE RENDERING AND NAVIGATION
     --------------------------------------------------------- */

  function profilePage() {
    const firstName = safe((state.profile.name || "MORNI User").trim());
    const equipped = rewardCatalog.find(item => item.id === extra.rewards.equipped) || rewardCatalog[0];
    const earned = (state.history || []).length;
    return `<div class="page-enter morni-feature-page morni-profile-page">
      <div class="morni-page-heading">
        <div><span class="morni-kicker">YOUR MORNI IDENTITY</span><h1>Your profile<span class="title-period">.</span></h1><p>Manage your MORNI name, morning preferences and personal progress.</p></div>
        <div class="profile-avatar-large">${safe((state.profile.name || "M").trim().charAt(0).toUpperCase())}</div>
      </div>
      <section class="morni-glass-panel profile-summary-card">
        <div class="profile-summary-avatar">${safe((state.profile.name || "M").trim().charAt(0).toUpperCase())}</div>
        <div class="profile-summary-copy"><span class="morni-kicker">MORNI MEMBER</span><h2>${firstName}</h2><p>Current collectible: ${equipped.icon} ${safe(equipped.name)}</p></div>
        <div class="profile-level"><small>LEVEL</small><b>${level()}</b></div>
      </section>
      <div class="profile-stat-grid">
        <article class="morni-glass-panel"><span>POINTS BALANCE</span><b>✧ ${xp.points}</b><small>Earn points through routine milestones</small></article>
        <article class="morni-glass-panel"><span>ROUTINE STREAK</span><b>${Number(state.streak) || 0} days</b><small>Consistency builds over time</small></article>
        <article class="morni-glass-panel"><span>RECORDED SESSIONS</span><b>${earned}</b><small>Saved activity on this browser</small></article>
      </div>
      <section class="morni-glass-panel profile-edit-card">
        <div><span class="morni-kicker">PERSONAL DETAILS</span><h2>Profile settings</h2><p>Your details are stored locally in this browser.</p></div>
        <label class="morni-field">Display name<input id="profileName" maxlength="32" value="${safe(state.profile.name)}"></label>
        <label class="morni-field">Usual wake-up time<input id="wakeTime" type="time" value="${safe(state.profile.wakeTime)}"></label>
        <button class="btn btn-primary" data-action="save-profile">Save profile</button>
      </section>
      <div class="profile-shortcuts">
        <button class="btn btn-soft" data-page="rewards">✧ Open rewards shop</button>
        <button class="btn btn-soft" data-page="settings">⚙ Open settings</button>
      </div>
      <p class="morni-disclaimer">MORNI profile and progress are saved on this device. They are not an online account and will not automatically sync between devices.</p>
    </div>`;
  }

  const pages = {
    home,
    routine,
    device,
    school,
    insights,
    settings,
    lab,
    handwash: handwashPage,
    planner: plannerPage,
    rewards: rewardsPage,
    impact: impactPage,
    showcase: showcasePage,
    focus: focusPage,
    profile: profilePage
  };

  function render() {
    const root = $("#pageContent");
    if (!root) return;

    injectUltimateStyles();
    root.innerHTML = featureNav() + (pages[page] || home)();

    $$('[data-page="overview"]').forEach(element => {
      element.dataset.page = "home";
      element.setAttribute("aria-label", "Home");
      const textNode = Array.from(element.childNodes).find(node => node.nodeType === 3 && node.textContent.trim());
      if (textNode) textNode.textContent = " Home ";
      else if (!element.querySelector("svg, img, i")) element.textContent = "Home";
    });

    document.body.dataset.theme = state.theme;

    const breadcrumb = $("#breadcrumb");

    if (breadcrumb) {
      breadcrumb.textContent =
        `Workspace / ${page[0].toUpperCase()}${page.slice(1)}`;
    }

    $$("[data-page]").forEach(element => {
      element.classList.toggle(
        "active",
        element.dataset.page === page
      );
    });

    updateConnection();

    if (state.timer.running) {
      startTimerLoop();
    }
  }

  function refreshLiveBits() {
    updateConnection();
  }

  function navigate(next) {
    if (!pages[next]) return;

    page = next;
    render();

    window.scrollTo({
      top: 0,
      behavior: "smooth"
    });
  }

  /* ---------------------------------------------------------
     SAVE CONNECTION SETTINGS
     --------------------------------------------------------- */

  async function saveConnectionFromForm() {
    const selectedMode = $("#connectionMode")?.value || "demo";
    const address = ($("#deviceAddress")?.value || "").trim().replace(/\/+$/, "");

    if (!["demo", "live"].includes(selectedMode)) {
      toast("Choose a valid connection mode.");
      return;
    }

    connectionMode = selectedMode;

    // The USB hardware path does not use an IP address. Keep any old address
    // stored for compatibility, but never contact it in USB/live mode.

    saveConnectionSettings();

    state.device.online = false;
    state.device.hardwareReady = false;
    state.device.lastError = "";
    state.device.mode = isDemoMode() ? "demo" : "not checked";
    state.device.ip = isDemoMode() ? "Demo mode" : deviceBaseUrl;

    save();
    render();

    if (isDemoMode()) {
      toast("Demo mode saved. Physical device will not be contacted.");
      return;
    }

    if (window.MORNI_USB_BRIDGE?.connected) {
      toast("USB hardware mode saved. Checking MORNI over USB...");
      await pollDevice();
      toast(state.device.online
        ? "MORNI is connected over USB."
        : "USB is open, but MORNI did not answer. Check the firmware response.");
    } else {
      toast("USB hardware mode saved. Open Device Studio and click Connect MORNI by USB.");
    }
  }

  /* ---------------------------------------------------------
     EVENT HANDLERS
     --------------------------------------------------------- */

  function bindEvents() {
    document.addEventListener("click", event => {
      const nav = event.target.closest("[data-page]");

      if (nav) {
        event.preventDefault();
        navigate(nav.dataset.page === "overview" ? "home" : nav.dataset.page);
        return;
      }

      const extraActionElement = event.target.closest("[data-extra-action]");
      if (extraActionElement) {
        event.preventDefault();
        handleExtraAction(extraActionElement.dataset.extraAction, extraActionElement);
        return;
      }

      const actionElement = event.target.closest("[data-action]");
      const action = actionElement?.dataset.action;

      if (!action) return;

      if (action === "start-routine") {
        startRoutine("dashboard");
      }

      if (action === "timer-start") {
        timerStart();
      }

      if (action === "timer-pause") {
        timerPause();
      }

      if (action === "timer-reset") {
        timerReset();
      }

      if (action === "check-device") {
        pollDevice().then(() => {
          toast(
            state.device.online
              ? "Station is reachable."
              : "Station is offline."
          );
        });
      }

      if (action === "sync-school-lcd") {
        syncSchoolChecklistToLCD();
      }

      if (action === "save-connection") {
        saveConnectionFromForm();
      }

      if (action === "save-profile") {
        state.profile.name =
          $("#profileName")?.value.trim() || "MORNI User";

        state.profile.wakeTime =
          $("#wakeTime")?.value || "06:30";

        save();
        render();
        toast("Preferences saved.");
      }

      if (action === "save-refill") {
        state.capacity.handwash = Math.max(
          1,
          Number($("#capacity")?.value) || 250
        );

        state.average.handwash = Math.max(
          0.1,
          Number($("#average")?.value) || 2
        );

        save();
        render();
        toast("Refill estimate saved.");
      }

      if (action === "theme") {
        state.theme = state.theme === "light" ? "dark" : "light";
        save();
        render();
      }

      if (action === "demo-start") {
        simulateEvent("start");
      }

      if (action === "demo-brush") {
        simulateEvent("toothbrush");
      }

      if (action === "demo-handwash") {
        simulateEvent("handwash");
      }

      if (action === "demo-complete-brush") {
        simulateEvent("completeBrush");
      }

      if (action === "reset") {
        if (confirm("Reset all MORNI data saved in this browser?")) {
          localStorage.removeItem(STORE);
          localStorage.removeItem(XP_STORE);

          state = defaultState();

          xp = {
            points: 0,
            unlocked: [],
            missionDate: today(),
            missions: [],
            fullDays: 0
          };

          save();
          render();
          toast("Local MORNI data reset.");
        }
      }
    });

    document.addEventListener("change", event => {
      const extraCheckbox = event.target.closest("[data-extra-check]");
      if (extraCheckbox) {
        const task = extra.plan.tasks.find(item => item.id === extraCheckbox.dataset.extraCheck);
        if (task) { task.done = extraCheckbox.checked; saveExtra(); render(); }
      }

      const checkbox = event.target.closest("[data-check]");

      if (checkbox) {
        toggleChecklist(checkbox.dataset.check);
      }
    });
  }

  /* ---------------------------------------------------------
     INITIALISATION AND CLEANUP
     --------------------------------------------------------- */

  function init() {
    document.body.dataset.theme = state.theme;

    bindEvents();

    const themeButton = $("#themeBtn");

    if (themeButton) {
      themeButton.addEventListener("click", () => {
        state.theme = state.theme === "light" ? "dark" : "light";
        save();
        render();
      });
    }

    render();

    if (state.timer.running) {
      startTimerLoop();
    }

    if (extra.handwash.running) {
      if (handwashElapsed() <= 0) completeHandwashGuide();
      else {
        extra.handwash.endsAt = Date.now() + extra.handwash.remaining * 1000;
        handwashLoop = setInterval(tickHandwashGuide, 200);
      }
    }

    if (extra.focus.running) {
      extra.focus.endsAt = Date.now() + extra.focus.remaining * 1000;
      focusLoop = setInterval(tickFocus, 250);
    }

    if (isDemoMode()) {
      updateConnection();
    } else {
      pollDevice();
    }

    pollLoop = setInterval(
      pollDevice,
      Number(CFG.heartbeatInterval || 5000)
    );

    window.addEventListener("beforeunload", () => {
      clearInterval(timerLoop);
      clearInterval(pollLoop);
      clearInterval(handwashLoop);
      clearInterval(focusLoop);
      clearTimeout(toastLoop);
      clearTimeout(featureToastLoop);
    });
  }

  /* ---------------------------------------------------------
     PUBLIC APP API
     --------------------------------------------------------- */

  window.addEventListener("morni-usb-connected", async () => {
    connectionMode = "live";
    saveConnectionSettings();
    state.device.online = true;
    state.device.hardwareReady = true;
    state.device.lastSeen = Date.now();
    state.device.ip = "USB serial · ESP8266";
    state.device.mode = "USB connected";
    state.device.lastError = "";
    save();
    updateConnection();
    await pollDevice();
    await syncSchoolChecklistToLCD({ silent: false });
  });

  window.addEventListener("morni-usb-disconnected", () => {
    if (connectionMode !== "live") return;
    state.device.online = false;
    state.device.hardwareReady = false;
    state.device.mode = "disconnected";
    state.device.ip = "Connect in Device Studio";
    state.device.lastError = "USB disconnected";
    save();
    updateConnection();
  });

  window.showPage = navigate;
  window.navigate = navigate;

  window.completeRoutineStep = id => {
    if (id === "handwash") {
      return markHandwash("app");
    }

    if (id === "brush" || id === "toothbrush") {
      return completeBrush("app");
    }

    return null;
  };

  window.MORNI_EXPERIENCE = {
    open: navigate,
    getReadiness: readinessBreakdown,
    getHandwashStages: () => handwashStages.map(stage => ({ ...stage })),
    getRewards: () => rewardCatalog.map(item => ({ ...item, owned: extra.rewards.owned.includes(item.id), equipped: extra.rewards.equipped === item.id })),
    getPlan: () => JSON.parse(JSON.stringify(extra.plan)),
    getHardwareStatus: () => ({ online: state.device.online, hardwareReady: state.device.hardwareReady, mode: state.device.mode }),
    exportData: exportMorniData
  };

  window.MORNI_PLUS = {
    complete: window.completeRoutineStep,

    getStats: () => ({
      xp: xp.points,
      level: level(),
      streak: state.streak,
      bestStreak: state.bestStreak,
      completed: completed(),
      score: progress()
    }),

    getMissions: () => missions.map(mission => ({
      id: mission.id,
      title: mission.title,
      description: mission.desc,
      completed: mission.test()
    })),

    getAchievements: () => achievements.map(item => ({
      id: item[0],
      name: item[1],
      description: item[2],
      unlocked: xp.unlocked.includes(item[0])
    })),

    getWeeklyStats: () => state.history.slice(-7),

    getCoachMessage: coach,

    refresh: render,

    resetToday: () => {
      state.routine = { ...defaultState().routine };
      state.timer = { ...defaultState().timer };
      state.date = today();
      state.startTime = null;

      save();
      render();
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

})();


/* =========================================================
   MORNI RESPONSIVE + SUNRISE BRANDING
   ========================================================= */

(() => {
  "use strict";

  const LOGO = "./logo.svg";
  const MANIFEST = "./manifest.json";

  function setLink(rel, href, type) {
    let link = document.querySelector(`link[rel="${rel}"]`);

    if (!link) {
      link = document.createElement("link");
      link.rel = rel;
      document.head.appendChild(link);
    }

    link.href = href;

    if (type) {
      link.type = type;
    }
  }

  function updateBranding() {
    setLink("icon", LOGO, "image/svg+xml");
    setLink("apple-touch-icon", LOGO);
    setLink("manifest", MANIFEST);

    let theme = document.querySelector('meta[name="theme-color"]');

    if (!theme) {
      theme = document.createElement("meta");
      theme.name = "theme-color";
      document.head.appendChild(theme);
    }

    theme.content = "#173d2b";
    document.title = "MORNI | Smart Morning Ecosystem";

    document.querySelectorAll(
      ".brand-icon img, .mobile-brand img, .hub-ring img, img[src$='icon.svg']"
    ).forEach(img => {
      img.src = LOGO;
      img.alt = "MORNI sunrise logo";
    });
  }

  updateBranding();

  const logoObserver = new MutationObserver(() => {
    updateBranding();
  });

  if (document.body) {
    logoObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  const responsiveCSS = `
    *, *::before, *::after {
      box-sizing: border-box;
    }

    html, body {
      width: 100%;
      max-width: 100%;
      overflow-x: hidden;
    }

    body {
      -webkit-text-size-adjust: 100%;
      text-size-adjust: 100%;
    }

    img, svg, video, canvas {
      max-width: 100%;
    }

    button, input, select, textarea {
      max-width: 100%;
      touch-action: manipulation;
    }

    button {
      min-height: 40px;
    }

    .app-shell, .main, .page-content, .page-enter,
    .panel, .welcome-hero, .dashboard-grid > *,
    .device-hero-grid > *, .routine-layout > *,
    .school-layout > *, .settings-layout > * {
      min-width: 0;
    }

    .page-content {
      width: 100%;
      max-width: 1600px;
      margin-inline: auto;
    }

    .panel {
      overflow-wrap: anywhere;
    }

    .brand-icon img, .mobile-brand img, .hub-ring img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: contain;
    }

    .brand-icon {
      overflow: hidden;
    }

    @media (min-width: 761px) and (max-width: 1050px) {
      .sidebar {
        width: 205px;
        padding-inline: 13px;
      }

      .main {
        margin-left: 205px;
        width: calc(100% - 205px);
      }

      .dashboard-grid,
      .device-hero-grid,
      .routine-layout,
      .school-layout,
      .settings-layout,
      .insight-layout {
        grid-template-columns: minmax(0, 1fr);
      }

      .welcome-hero {
        padding-right: 190px;
      }

      .hero-art {
        transform: translateY(-50%) scale(.62);
        transform-origin: right center;
      }

      .panel {
        padding: 18px;
      }
    }

    @media (max-width: 760px) {
      .sidebar {
        display: none !important;
      }

      .main {
        margin: 0 !important;
        width: 100% !important;
        min-width: 0;
      }

      .topbar {
        height: 60px;
        padding: 0 13px;
        gap: 8px;
      }

      .mobile-brand {
        display: flex !important;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
        font-size: 17px;
      }

      .mobile-brand img {
        width: 30px;
        height: 30px;
        border-radius: 9px;
      }

      .breadcrumb {
        display: none !important;
      }

      .top-actions {
        margin-left: auto;
        gap: 7px;
      }

      .mode-pill {
        font-size: 7px;
        padding: 6px 8px;
        white-space: nowrap;
      }

      .page-content {
        width: 100%;
        padding: 16px 13px calc(100px + env(safe-area-inset-bottom));
      }

      .dashboard-grid,
      .dashboard-side,
      .device-hero-grid,
      .routine-layout,
      .school-layout,
      .settings-layout,
      .insight-layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr) !important;
        gap: 13px;
      }

      .dashboard-side {
        display: grid;
      }

      .panel {
        width: 100%;
        padding: 16px;
        border-radius: 17px;
      }

      .page-title-row {
        align-items: flex-start;
        flex-direction: column;
        gap: 10px;
      }

      .page-title-row h1 {
        font-size: clamp(30px, 8vw, 40px);
        overflow-wrap: anywhere;
      }

      .welcome-hero {
        min-height: 370px;
        padding: 22px 17px;
        overflow: hidden;
      }

      .hero-copy {
        width: 100%;
        max-width: 100%;
        position: relative;
        z-index: 2;
      }

      .welcome-hero h1 {
        font-size: clamp(36px, 10vw, 48px);
        overflow-wrap: anywhere;
      }

      .welcome-hero p {
        max-width: 100%;
        line-height: 1.7;
      }

      .hero-art {
        right: -22px;
        top: auto;
        bottom: -38px;
        transform: scale(.55);
        transform-origin: bottom right;
        opacity: .42;
      }

      .hero-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 9px;
      }

      .hero-actions .btn {
        min-height: 44px;
      }

      .metric-strip {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 9px;
      }

      .metric {
        min-width: 0;
        padding: 12px 9px;
        gap: 7px;
      }

      .metric b {
        font-size: clamp(17px, 5vw, 22px);
      }

      .metric small {
        font-size: 8px;
      }

      .metric span:last-child {
        overflow-wrap: anywhere;
      }

      .mobile-nav {
        display: flex !important;
        position: fixed;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 100;
        min-height: 62px;
        padding: 7px 3px calc(7px + env(safe-area-inset-bottom));
        justify-content: space-around;
        background: color-mix(in srgb, var(--surface) 96%, transparent);
        border-top: 1px solid var(--line);
        backdrop-filter: blur(16px);
      }

      .mobile-nav button {
        min-width: 0;
        min-height: 45px;
        padding: 3px 1px;
        flex: 1;
        display: grid;
        justify-items: center;
        align-content: center;
        gap: 3px;
        font-size: 9px;
        white-space: nowrap;
      }

      .mobile-nav button span {
        font-size: 18px;
      }

      .station-stage {
        width: 100%;
        height: clamp(250px, 70vw, 310px);
        overflow: hidden;
      }

      .station-illustration {
        min-width: 0;
        width: min(235px, 88%);
        transform: translate(-50%, -48%) scale(.9);
      }

      .station-hardware {
        gap: 5px;
      }

      .station-base {
        font-size: 7px;
      }

      .component-row {
        flex-wrap: wrap;
        gap: 9px;
      }

      .component-row > div {
        min-width: 0;
      }

      .component-row small,
      .component-row b {
        overflow-wrap: anywhere;
      }

      .field-input,
      input,
      select,
      textarea {
        width: 100%;
        min-height: 44px;
        font-size: 16px !important;
      }

      .achievement-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .toast {
        left: 12px;
        right: 12px;
        bottom: calc(78px + env(safe-area-inset-bottom));
        text-align: center;
      }

      .setting-row {
        align-items: flex-start;
        flex-direction: column;
      }

      .setting-row button {
        width: 100%;
      }
    }

    @media (max-width: 390px) {
      .page-content {
        padding-left: 10px;
        padding-right: 10px;
      }

      .topbar {
        padding-inline: 9px;
      }

      .top-actions {
        gap: 5px;
      }

      .top-actions .avatar {
        display: none;
      }

      .metric-strip,
      .achievement-grid {
        grid-template-columns: minmax(0, 1fr);
      }

      .metric {
        display: flex;
      }

      .welcome-hero {
        min-height: 390px;
        padding: 18px 14px;
      }

      .station-illustration {
        transform: translate(-50%, -48%) scale(.82);
      }

      .mobile-nav button {
        font-size: 8px;
      }
    }

    @media (max-width: 900px) and (orientation: landscape) {
      .welcome-hero {
        min-height: 300px;
      }

      .mobile-nav {
        min-height: 52px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        scroll-behavior: auto !important;
        animation-duration: .01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: .01ms !important;
      }
    }
  `;

  const style = document.createElement("style");
  style.id = "morni-responsive-addon";
  style.textContent = responsiveCSS;
  document.head.appendChild(style);

  console.info("MORNI responsive and sunrise branding loaded.");

})();

/* ==========================================
   MORNI — DARK MODE READABILITY PATCH
   Paste at the VERY BOTTOM of app.js
========================================== */

(() => {
  const morniDarkFix = document.createElement("style");

  morniDarkFix.id = "morni-dark-readability-fix";

  morniDarkFix.textContent = `
    body[data-theme="dark"] #pageContent .profile-level {
      background: #294633 !important;
      color: #f2f7ed !important;
      border: 1px solid #527653 !important;
    }

    body[data-theme="dark"] #pageContent .level-showcase,
    body[data-theme="dark"] #pageContent .level-info {
      color: #eef4e9 !important;
    }

    body[data-theme="dark"] #pageContent .level-orb {
      background: linear-gradient(145deg, #d5edaa, #76ad78) !important;
      color: #173d29 !important;
      border: 2px solid #8fbd83 !important;
    }

    body[data-theme="dark"] #pageContent .morni-glass-panel,
    body[data-theme="dark"] #pageContent .feature-card,
    body[data-theme="dark"] #pageContent .reward-item,
    body[data-theme="dark"] #pageContent .readiness-signal,
    body[data-theme="dark"] #pageContent .planner-task-row,
    body[data-theme="dark"] #pageContent .morni-score-card,
    body[data-theme="dark"] #pageContent .morni-water-card {
      background: #1c2b21 !important;
      color: #eef4e9 !important;
      border-color: #3b5140 !important;
    }

    body[data-theme="dark"] #pageContent input,
    body[data-theme="dark"] #pageContent select,
    body[data-theme="dark"] #pageContent textarea {
      background: #17251c !important;
      color: #eef4e9 !important;
      border-color: #405744 !important;
    }

    body[data-theme="dark"] #pageContent input::placeholder,
    body[data-theme="dark"] #pageContent textarea::placeholder {
      color: #a9bbaa !important;
      opacity: 1;
    }

    body[data-theme="dark"] #pageContent .morni-water-card {
      background: linear-gradient(145deg, #203729, #263d2d) !important;
    }

    body[data-theme="dark"] #pageContent .morni-nudge-card {
      background: linear-gradient(110deg, #263528, #302e22) !important;
      border-color: #526147 !important;
      color: #edf4e8 !important;
    }

    body[data-theme="dark"] #pageContent .morni-nudge-card h3,
    body[data-theme="dark"] #pageContent .morni-nudge-card p {
      color: #edf4e8 !important;
    }
  `;

  document.getElementById("morni-dark-readability-fix")?.remove();
  document.head.appendChild(morniDarkFix);
})();


/* ============================================================
   MORNI CONNECTED SERVICES — PREMIUM EDITION
   Gmail + Smart Meetings + Google Maps + Weather + News
   Replace the previous Services extensions with this block.
   ============================================================ */

(() => {
  "use strict";

  const CLIENT_ID =
    "367611240198-lukr25vboivbmgcodmpeb6lhibeje432.apps.googleusercontent.com";

  const GMAIL_SCOPE =
    "https://www.googleapis.com/auth/gmail.readonly";

  const root = document.getElementById("pageContent");
  const sidebar = document.querySelector(".side-nav");

  if (!root || !sidebar) {
    console.error("MORNI Services: app navigation not found.");
    return;
  }

  // Remove any old Services elements.
  document.getElementById("morni-services-button")?.remove();
  document.getElementById("morni-services-overlay")?.remove();
  document.getElementById("morni-services-panel")?.remove();

  document.getElementById("morni-connected-services-styles")?.remove();

  const STORE = "morni_meeting_events_v1";

  let gmailToken = null;
  let tokenClient = null;
  let gmailPolling = null;
  let previousMailIds = new Set();
  let userLocation = null;
  let servicesOpen = false;

  let meetings = readEvents();

  const escapeHTML = value =>
    String(value ?? "").replace(/[&<>"']/g, c => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[c]);

  function readEvents() {
    try {
      const value = JSON.parse(localStorage.getItem(STORE) || "[]");
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  function saveEvents(value) {
    meetings = value;
    localStorage.setItem(STORE, JSON.stringify(value));
  }

  function notify(message) {
    const toast = document.getElementById("toast");

    if (toast) {
      toast.textContent = message;
      toast.classList.add("show");
      setTimeout(() => toast.classList.remove("show"), 3200);
    } else {
      console.info("MORNI:", message);
    }
  }

  function formatDate(value) {
    return new Date(value).toLocaleDateString([], {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric"
    });
  }

  function formatTime(value) {
    return new Date(value).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function getNextMeeting() {
    return readEvents()
      .filter(m => new Date(m.startAt).getTime() >= Date.now())
      .sort((a, b) =>
        new Date(a.startAt) - new Date(b.startAt)
      )[0] || null;
  }

  function addMeeting(item) {
    const list = readEvents();
    const index = list.findIndex(m => m.id === item.id);

    if (index >= 0) {
      list[index] = { ...list[index], ...item };
    } else {
      list.push(item);
    }

    saveEvents(list);

    if (servicesOpen) renderPage();
    updateOverviewCard();
  }

  /* ---------------- NAVIGATION ---------------- */

  const navButton = document.createElement("button");
  navButton.type = "button";
  navButton.className = "nav-btn";
  navButton.dataset.page = "services";
  navButton.innerHTML =
    '<span class="ms-nav-icon">✦</span><span>Connected Services</span>';

  const insights = sidebar.querySelector('[data-page="insights"]');

  if (insights) {
    insights.insertAdjacentElement("afterend", navButton);
  } else {
    sidebar.appendChild(navButton);
  }

  function showPage() {
    servicesOpen = true;

    document.querySelectorAll("[data-page]").forEach(el => {
      el.classList.toggle("active", el.dataset.page === "services");
    });

    const breadcrumb = document.getElementById("breadcrumb");
    if (breadcrumb) {
      breadcrumb.textContent = "Workspace / Connected Services";
    }

    renderPage();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  document.addEventListener("click", event => {
    const button = event.target.closest('[data-page="services"]');
    if (!button) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    showPage();
  }, true);

  document.addEventListener("click", event => {
    if (event.target.closest('[data-page]:not([data-page="services"])')) {
      servicesOpen = false;
    }
  });

  /* ---------------- PREMIUM DESIGN ---------------- */

  const css = `
    #pageContent .ms-page {
      color:var(--text,#193b2a);
      animation:msEnter .35s ease both;
    }

    @keyframes msEnter {
      from {opacity:0;transform:translateY(12px)}
      to {opacity:1;transform:translateY(0)}
    }

    #pageContent .ms-heading {
      display:flex;
      justify-content:space-between;
      align-items:center;
      flex-wrap:wrap;
      gap:12px;
      margin:8px 0 22px;
    }

    #pageContent .ms-kicker {
      color:#bd8539;
      font-size:10px;
      font-weight:900;
      letter-spacing:2px;
    }

    #pageContent .ms-heading h1 {
      font-size:clamp(30px,4vw,43px);
      letter-spacing:-1.7px;
      margin:5px 0;
      color:var(--text,#193b2a);
    }

    #pageContent .ms-heading p {
      color:var(--muted,#718174);
      line-height:1.6;
      margin:5px 0;
    }

    #pageContent .ms-hero {
      position:relative;
      overflow:hidden;
      padding:clamp(22px,4vw,34px);
      border-radius:25px;
      margin-bottom:18px;
      color:white;
      background:
        radial-gradient(circle at 90% 15%,#e9b45a66,transparent 32%),
        linear-gradient(115deg,#153b29,#28734a 70%,#a66b32);
      box-shadow:0 15px 35px #183d2925;
    }

    #pageContent .ms-hero h2 {
      color:white;
      font-size:clamp(23px,3vw,30px);
      margin:0 0 9px;
    }

    #pageContent .ms-hero p {
      color:#edf5e9;
      max-width:620px;
      line-height:1.7;
      margin:0;
    }

    #pageContent .ms-hero-mark {
      position:absolute;
      right:25px;
      top:0;
      font-size:100px;
      opacity:.15;
      pointer-events:none;
    }

    #pageContent .ms-grid {
      display:grid;
      grid-template-columns:repeat(2,minmax(0,1fr));
      gap:16px;
    }

    #pageContent .ms-card {
      min-width:0;
      padding:21px;
      border:1px solid var(--line,#e2e9de);
      border-radius:21px;
      background:var(--surface,#fffdf7);
      box-shadow:0 7px 24px #183d2909;
      transition:transform .2s,border-color .2s,box-shadow .2s;
    }

    #pageContent .ms-card:hover {
      transform:translateY(-2px);
      border-color:#a8c5a5;
      box-shadow:0 12px 28px #183d2912;
    }

    #pageContent .ms-card h2 {
      font-size:18px;
      margin:0 0 8px;
      color:var(--text,#193b2a);
    }

    #pageContent .ms-card h3 {
      font-size:15px;
      margin:0 0 9px;
      color:var(--text,#193b2a);
    }

    #pageContent .ms-icon {
      width:45px;
      height:45px;
      display:grid;
      place-items:center;
      border-radius:14px;
      background:linear-gradient(145deg,#eaf3e5,#f6ead7);
      color:#286b42;
      font-size:21px;
      margin-bottom:14px;
    }

    #pageContent .ms-muted {
      color:var(--muted,#718174);
      font-size:12px;
      line-height:1.7;
    }

    #pageContent .ms-status {
      color:var(--muted,#718174);
      font-size:12px;
      line-height:1.6;
      margin:11px 0;
      overflow-wrap:anywhere;
    }

    #pageContent .ms-button {
      border:0;
      border-radius:11px;
      padding:11px 15px;
      background:#286b43;
      color:white;
      font-weight:800;
      cursor:pointer;
      margin:5px 5px 4px 0;
      transition:transform .18s,filter .18s;
    }

    #pageContent .ms-button:hover {
      transform:translateY(-2px);
      filter:brightness(1.09);
    }

    #pageContent .ms-button.orange {
      background:#c98236;
    }

    #pageContent .ms-button.soft {
      background:#e9f1e5;
      color:#285b3b;
    }

    #pageContent .ms-input {
      width:100%;
      box-sizing:border-box;
      padding:12px;
      min-height:43px;
      border:1px solid var(--line,#dce5d9);
      border-radius:11px;
      background:var(--input-bg,#fff);
      color:var(--text,#193b2a);
      font:inherit;
      margin:6px 0 10px;
    }

    #pageContent .ms-list-item {
      padding:13px 0;
      border-bottom:1px solid var(--line,#e4e9df);
      overflow-wrap:anywhere;
    }

    #pageContent .ms-list-item:last-child {
      border-bottom:0;
    }

    #pageContent .ms-list-item strong {
      display:block;
      margin-bottom:6px;
      color:var(--text,#193b2a);
      line-height:1.5;
    }

    #pageContent .ms-list-item small {
      display:block;
      color:var(--muted,#718174);
      line-height:1.6;
      margin:3px 0;
    }

    #pageContent .ms-list-item a {
      display:inline-block;
      margin-top:7px;
      color:#32764a;
      font-size:12px;
      font-weight:800;
    }

    #pageContent .ms-meeting {
      padding:16px;
      margin:12px 0;
      border-radius:16px;
      border:1px solid #d5e5d0;
      background:linear-gradient(140deg,#f0f7eb,#fff9ef);
      color:#24452e;
    }

    #pageContent .ms-meeting strong {
      font-size:16px;
      display:block;
      margin-bottom:7px;
    }

    #pageContent .ms-meeting p {
      font-size:12px;
      line-height:1.6;
      margin:6px 0;
      color:#536b56;
      overflow-wrap:anywhere;
    }

    #pageContent .ms-meeting input {
      width:85px;
      padding:8px;
      border:1px solid #cbdac8;
      border-radius:8px;
      margin:4px;
    }

    #pageContent .ms-result {
      color:#286b43;
      font-size:12px;
      font-weight:800;
      line-height:1.6;
      margin:9px 0;
    }

    .ms-nav-icon {
      display:inline-grid;
      place-items:center;
      width:23px;
      height:23px;
      margin-right:9px;
      border-radius:8px;
      background:#e9f0df;
      color:#b77c35;
    }

    body[data-theme="dark"] #pageContent .ms-card {
      background:#1c2b21;
      border-color:#3b5140;
    }

    body[data-theme="dark"] #pageContent .ms-card h2,
    body[data-theme="dark"] #pageContent .ms-card h3,
    body[data-theme="dark"] #pageContent .ms-list-item strong {
      color:#eef4e9;
    }

    body[data-theme="dark"] #pageContent .ms-meeting {
      background:#263b2b;
      border-color:#526b50;
      color:#eef4e9;
    }

    body[data-theme="dark"] #pageContent .ms-meeting p {
      color:#d3e5cf;
    }

    body[data-theme="dark"] #pageContent .ms-input,
    body[data-theme="dark"] #pageContent .ms-meeting input {
      background:#17251c;
      color:#eef4e9;
      border-color:#425746;
    }

    @media(max-width:700px) {
      #pageContent .ms-grid {grid-template-columns:1fr}
      #pageContent .ms-hero-mark {font-size:65px}
    }

    @media(prefers-reduced-motion:reduce) {
      #pageContent .ms-page,
      #pageContent .ms-card,
      #pageContent .ms-button {animation:none;transition:none}
    }
  `;

  const style = document.createElement("style");
  style.id = "morni-connected-services-styles";
  style.textContent = css;
  document.head.appendChild(style);

  /* ---------------- PAGE RENDERING ---------------- */

  function renderPage() {
    const next = getNextMeeting();

    root.innerHTML = `
      <div class="ms-page">
        <header class="ms-heading">
          <div>
            <span class="ms-kicker">MORNI · CONNECTED ECOSYSTEM</span>
            <h1>Connected Services<span style="color:#c98236">.</span></h1>
            <p>Your information, meetings and everyday tools — together.</p>
          </div>
        </header>

        <section class="ms-hero">
          <div class="ms-hero-mark">✦</div>
          <h2>Your world, in sync.</h2>
          <p>
            Stay on top of your inbox, discover your next destination,
            understand the news and plan your day with MORNI.
          </p>
        </section>

        <div class="ms-grid">

          <section class="ms-card">
            <div class="ms-icon">✉</div>
            <h2>Gmail Inbox</h2>
            <p class="ms-muted">Read recent inbox messages using secure, read-only Google access.</p>
            <div id="ms-gmail-status" class="ms-status">
              Gmail is not connected in this session.
            </div>
            <button class="ms-button" data-action="connect">Connect Gmail</button>
            <button class="ms-button soft" data-action="refresh">Refresh</button>
            <div id="ms-gmail-list"></div>
          </section>

          <section class="ms-card">
            <div class="ms-icon">◷</div>
            <h2>Meeting Assistant</h2>
            <p class="ms-muted">Find meeting details in your emails and plan your journey.</p>
            <div id="ms-meetings">${renderMeetings()}</div>
          </section>

          <section class="ms-card">
            <div class="ms-icon">⌖</div>
            <h2>Live Location & Maps</h2>
            <p class="ms-muted">Find your current position and open Google Maps.</p>
            <div id="ms-location-status" class="ms-status">
              Location has not been requested.
            </div>
            <button class="ms-button" data-action="locate">Find My Location</button>
            <button class="ms-button soft" data-action="map">Open Google Maps</button>
          </section>

          <section class="ms-card">
            <div class="ms-icon">☀</div>
            <h2>Local Weather</h2>
            <p class="ms-muted">Live weather conditions for your current location.</p>
            <div id="ms-weather" class="ms-status">
              Find your location to load weather.
            </div>
            <button class="ms-button" data-action="weather">Refresh Weather</button>
          </section>

          <section class="ms-card">
            <div class="ms-icon">▤</div>
            <h2>Daily News</h2>
            <p class="ms-muted">Headlines with simpler descriptions and useful context.</p>
            <input id="ms-news-city" class="ms-input" value="Kerala"
              placeholder="Enter city or region">
            <button class="ms-button" data-action="news">Discover News</button>
            <div id="ms-news" class="ms-status">
              Choose a region to load headlines.
            </div>
          </section>

          <section class="ms-card">
            <div class="ms-icon">✧</div>
            <h2>Privacy & Connections</h2>
            <p class="ms-muted">
              Gmail uses read-only access. Your access token stays in memory.
              Location is requested only when you choose to share it.
            </p>
            <div class="ms-status">
              Meeting details are stored locally in this browser.
            </div>
            <div class="ms-status">
              Disconnecting or refreshing the page may require reconnecting Gmail.
            </div>
          </section>

        </div>
      </div>
    `;

    updateLocationStatus();

    // The Connected Services page is rebuilt when the user navigates away
    // and returns. Keep the OAuth token in memory (never localStorage), then
    // restore the Gmail status and inbox into the newly-created page.
    if (gmailToken) {
      const gmailStatus = document.getElementById("ms-gmail-status");
      if (gmailStatus) {
        gmailStatus.textContent = "Gmail connected. Restoring your inbox...";
      }
      loadInbox(true);
    }
  }

  function renderMeetings() {
    const list = readEvents()
      .filter(m => new Date(m.startAt).getTime() > Date.now())
      .sort((a, b) => new Date(a.startAt) - new Date(b.startAt));

    let html = `
      <form id="ms-meeting-form" style="margin-top:15px">
        <h3>Add a meeting</h3>
        <input class="ms-input" name="title" required placeholder="Meeting title">
        <input class="ms-input" name="venue" placeholder="Venue or destination">
        <input class="ms-input" name="startAt" type="datetime-local" required>
        <button class="ms-button orange" type="submit">Add Meeting</button>
      </form>
    `;

    if (!list.length) {
      return html + '<p class="ms-status">No upcoming meetings found yet.</p>';
    }

    html += '<h3 style="margin-top:20px">Upcoming meetings</h3>';

    list.slice(0, 8).forEach(item => {
      html += `
        <article class="ms-meeting" data-meeting="${escapeHTML(item.id)}">
          <strong>${escapeHTML(item.title)}</strong>
          <p>◷ ${formatDate(item.startAt)} · ${formatTime(item.startAt)}</p>
          <p>⌖ Destination: ${escapeHTML(item.venue || "Not detected — please add it")}</p>
          ${item.venueConfirmed
            ? '<p>Destination extracted from email. Verify the exact place in Maps.</p>'
            : '<p>Check the venue before travelling.</p>'}
          <p>Travel estimate in minutes</p>
          <input type="number" min="0" max="600" data-travel
            value="${Number(item.travelMinutes ?? 30)}">
          <p>Extra buffer in minutes</p>
          <input type="number" min="0" max="180" data-buffer
            value="${Number(item.bufferMinutes ?? 15)}">
          <br>
          <button class="ms-button" data-action="route">Get Directions</button>
          <button class="ms-button soft" data-action="departure">Plan Departure</button>
          <button class="ms-button soft" data-action="remove">Remove</button>
          <div class="ms-result" data-result></div>
        </article>
      `;
    });

    return html;
  }

  /* ---------------- DATE AND TIME EXTRACTION ---------------- */

  function extractDateTime(text) {
    let year, month, day;
    let match;

    match = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);

    if (match) {
      year = Number(match[1]);
      month = Number(match[2]) - 1;
      day = Number(match[3]);
    }

    if (!match) {
      match = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](20\d{2})\b/);

      if (match) {
        day = Number(match[1]);
        month = Number(match[2]) - 1;
        year = Number(match[3]);
      }
    }

    if (!match) {
      match = text.match(
        /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})(?:,?\s+(20\d{2}))?/i
      );

      if (match) {
        const names = [
          "jan","feb","mar","apr","may","jun",
          "jul","aug","sep","oct","nov","dec"
        ];
        month = names.indexOf(match[1].slice(0,3).toLowerCase());
        day = Number(match[2]);
        year = Number(match[3] || new Date().getFullYear());
      }
    }

    if (!match && /\btomorrow\b/i.test(text)) {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      year = d.getFullYear();
      month = d.getMonth();
      day = d.getDate();
    }

    if (!match && /\btoday\b/i.test(text)) {
      const d = new Date();
      year = d.getFullYear();
      month = d.getMonth();
      day = d.getDate();
    }

    if (year == null) return null;

    const timeMatch = text.match(
      /\b(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i
    );

    let hour = 9;
    let minute = 0;

    if (timeMatch) {
      hour = Number(timeMatch[1]);
      minute = Number(timeMatch[2] || 0);

      if (/^p/i.test(timeMatch[3]) && hour < 12) hour += 12;
      if (/^a/i.test(timeMatch[3]) && hour === 12) hour = 0;
    } else {
      const time24 = text.match(/\b(?:at\s*)?([01]?\d|2[0-3]):([0-5]\d)\b/);
      if (!time24) return null;
      hour = Number(time24[1]);
      minute = Number(time24[2]);
    }

    const result = new Date(year, month, day, hour, minute);

    // Reject invalid calendar dates rather than silently changing them.
    if (
      result.getFullYear() !== year ||
      result.getMonth() !== month ||
      result.getDate() !== day
    ) return null;

    return result;
  }

  /* ---------------- GENERAL VENUE EXTRACTION ---------------- */

  function extractVenue(text) {
    const clean = String(text || "")
      .replace(/\r/g, "\n")
      .replace(/\s+/g, " ")
      .trim();

    const patterns = [
      /\b(?:the meeting|our meeting|meeting|appointment|event|interview|conference)\s+(?:will\s+be\s+)?(?:is\s+)?(?:going\s+to\s+be\s+)?(?:held\s+)?(?:at|in|near)\s+(.+?)(?=\.|,?\s+(?:the date|date|on \d|tomorrow|today|at \d|time will|time is|and the time|please come|so please)\b|$)/i,
      /\b(?:venue|location|address|destination)\s*[:\-]\s*(.+?)(?=\.|,?\s+(?:date|time|tomorrow|today)\b|$)/i,
      /\bwe\s+(?:will\s+)?meet\s+(?:you\s+)?(?:at|in|near)\s+(.+?)(?=\.|,?\s+(?:on \d|tomorrow|today|at \d|the date|the time)\b|$)/i,
      /\b(?:come|go|reach|arrive)\s+(?:to|at)\s+(.+?)(?=\.|,?\s+(?:on \d|tomorrow|today|at \d|the date|the time)\b|$)/i
    ];

    for (const pattern of patterns) {
      const match = clean.match(pattern);
      if (match && match[1]) {
        let venue = match[1]
          .replace(/\b(?:and the date|and the time|the date will be|the time will be).*$/i, "")
          .replace(/[.!?]+$/, "")
          .trim();

        venue = venue.replace(/^(?:the|a|an)\s+/i, "");

        if (venue.length >= 3 && venue.length <= 180) {
          return venue;
        }
      }
    }

    return "";
  }

  function extractMeeting(mail) {
    const headers = mail.payload?.headers || [];
    const getHeader = name =>
      headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";

    const subject = getHeader("Subject");
    const body = mail._morniText || "";
    const combined = subject + "\n" + body;

    if (!/\b(meeting|appointment|interview|conference|webinar|event|google meet|zoom call|invitation|invite|session)\b/i.test(combined)) {
      return null;
    }

    const start = extractDateTime(combined);
    if (!start || start.getTime() < Date.now() - 86400000) return null;

    const venue = extractVenue(body);

    return {
      id: "gmail-" + mail.id,
      title: subject || "Scheduled meeting",
      venue,
      venueConfirmed: Boolean(venue),
      startAt: start.toISOString(),
      source: "Gmail",
      travelMinutes: 30,
      bufferMinutes: 15
    };
  }

  /* ---------------- EMAIL BODY DECODING ---------------- */

  function decodeBase64URL(value) {
    try {
      const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
      const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
      const binary = atob(padded);
      const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch {
      return "";
    }
  }

  function getEmailBody(payload) {
    const plain = [];
    const html = [];

    function walk(part) {
      if (!part) return;

      if (part.mimeType === "text/plain" && part.body?.data) {
        plain.push(decodeBase64URL(part.body.data));
      }

      if (part.mimeType === "text/html" && part.body?.data) {
        html.push(
          decodeBase64URL(part.body.data)
            .replace(/<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<script[\s\S]*?<\/script>/gi, " ")
            .replace(/<[^>]+>/g, " ")
        );
      }

      (part.parts || []).forEach(walk);
    }

    walk(payload);

    return (plain.length ? plain : html)
      .join("\n")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .trim();
  }

  /* ---------------- GMAIL ---------------- */

  function loadGoogleIdentity() {
    return new Promise((resolve, reject) => {
      if (window.google?.accounts?.oauth2) {
        resolve();
        return;
      }

      const existing = document.querySelector(
        'script[src="https://accounts.google.com/gsi/client"]'
      );

      if (existing) {
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", reject, { once: true });
        return;
      }

      const script = document.createElement("script");
      script.src = "https://accounts.google.com/gsi/client";
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  async function connectGmail() {
    const status = document.getElementById("ms-gmail-status");
    if (status) status.textContent = "Preparing Google sign-in...";

    try {
      await loadGoogleIdentity();

      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: GMAIL_SCOPE,
        callback: async response => {
          if (response.error) {
            if (status) status.textContent = "Google sign-in failed.";
            return;
          }

          gmailToken = response.access_token;
          previousMailIds = new Set();

          await loadInbox(true);

          if (gmailPolling) clearInterval(gmailPolling);
          gmailPolling = setInterval(() => loadInbox(false), 30000);
        }
      });

      tokenClient.requestAccessToken();
    } catch {
      if (status) status.textContent = "Google sign-in could not load. Check your connection.";
    }
  }

  async function loadInbox(initial = false) {
    if (!gmailToken) {
      const status = document.getElementById("ms-gmail-status");
      if (status) status.textContent = "Connect Gmail first.";
      return;
    }

    const status = document.getElementById("ms-gmail-status");
    const list = document.getElementById("ms-gmail-list");

    if (status) status.textContent = "Checking your inbox...";

    try {
      const response = await fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=15&labelIds=INBOX",
        { headers: { Authorization: "Bearer " + gmailToken } }
      );

      if (response.status === 401) {
        gmailToken = null;
        if (gmailPolling) clearInterval(gmailPolling);
        if (status) status.textContent = "Gmail session expired. Please reconnect.";
        return;
      }

      if (!response.ok) throw new Error("Gmail request failed");

      const data = await response.json();
      const messages = data.messages || [];
      const ids = new Set(messages.map(m => m.id));

      if (!initial && previousMailIds.size) {
        if (messages.some(m => !previousMailIds.has(m.id))) {
          notify("📧 MORNI: You received a new email.");
        }
      }

      previousMailIds = ids;

      const details = await Promise.all(
        messages.slice(0, 12).map(async item => {
          const result = await fetch(
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/" +
            item.id + "?format=full",
            { headers: { Authorization: "Bearer " + gmailToken } }
          );

          if (!result.ok) return null;

          const mail = await result.json();
          mail._morniText = getEmailBody(mail.payload);
          return mail;
        })
      );

      const valid = details.filter(Boolean);

      // Batch changes, then render only once.
      const existing = readEvents();

      for (const mail of valid) {
        const meeting = extractMeeting(mail);
        if (!meeting) continue;

        const index = existing.findIndex(m => m.id === meeting.id);

        if (index >= 0) {
          existing[index] = { ...existing[index], ...meeting };
        } else {
          existing.push(meeting);
        }
      }

      saveEvents(existing);

      if (list) {
        list.innerHTML = "";

        if (!valid.length) {
          list.textContent = "Your inbox is empty.";
        }

        valid.slice(0, 8).forEach(mail => {
          const headers = mail.payload?.headers || [];
          const getHeader = name =>
            headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "Not available";

          const item = document.createElement("div");
          item.className = "ms-list-item";

          const subject = document.createElement("strong");
          subject.textContent = getHeader("Subject");

          const from = document.createElement("small");
          from.textContent = "From: " + getHeader("From");

          const date = document.createElement("small");
          date.textContent = getHeader("Date");

          item.append(subject, from, date);
          list.appendChild(item);
        });
      }

      if (status) status.textContent = "Connected · Inbox updated.";

      if (servicesOpen) {
        const meetingsContainer = document.getElementById("ms-meetings");
        if (meetingsContainer) meetingsContainer.innerHTML = renderMeetings();
      }

      updateOverviewCard();

    } catch {
      if (status) status.textContent = "Inbox could not load. Check your connection or reconnect Gmail.";
    }
  }

  /* ---------------- LOCATION AND MAPS ---------------- */

  function updateLocationStatus() {
    const status = document.getElementById("ms-location-status");
    if (!status) return;

    status.textContent = userLocation
      ? "Location found. Your coordinates are ready for Maps."
      : "Location has not been requested in this session.";
  }

  function locate() {
    const status = document.getElementById("ms-location-status");

    if (!navigator.geolocation) {
      if (status) status.textContent = "Location is not supported by this browser.";
      return;
    }

    if (status) status.textContent = "Requesting location permission...";

    navigator.geolocation.getCurrentPosition(
      position => {
        userLocation = {
          lat: position.coords.latitude,
          lon: position.coords.longitude
        };

        updateLocationStatus();
        loadWeather();
        notify("Location found.");
      },
      () => {
        if (status) status.textContent =
          "Location unavailable. Check browser permission and try again.";
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  }

  function openCurrentMap() {
    if (!userLocation) {
      notify("Find your location first.");
      return;
    }

    const url = new URL("https://www.google.com/maps/search/");
    url.searchParams.set("api", "1");
    url.searchParams.set("query", userLocation.lat + "," + userLocation.lon);

    window.open(url.toString(), "_blank", "noopener,noreferrer");
  }

  function openMeetingRoute(meeting) {
    if (!meeting.venue || !meeting.venue.trim()) {
      notify("No meeting venue was detected. Add the venue first.");
      return;
    }

    const url = new URL("https://www.google.com/maps/dir/");
    url.searchParams.set("api", "1");
    url.searchParams.set("destination", meeting.venue.trim());
    url.searchParams.set("travelmode", "driving");

    if (userLocation) {
      url.searchParams.set(
        "origin",
        userLocation.lat + "," + userLocation.lon
      );
    }

    window.open(url.toString(), "_blank", "noopener,noreferrer");
  }

  /* ---------------- WEATHER ---------------- */

  async function loadWeather() {
    const result = document.getElementById("ms-weather");

    if (!userLocation) {
      if (result) result.textContent = "Find your location first.";
      return;
    }

    if (result) result.textContent = "Loading current weather...";

    try {
      const url =
        "https://api.open-meteo.com/v1/forecast?latitude=" +
        userLocation.lat +
        "&longitude=" +
        userLocation.lon +
        "&current=temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m";

      const response = await fetch(url);
      if (!response.ok) throw new Error("Weather unavailable");

      const data = await response.json();
      const weather = data.current;

      if (result) {
        result.innerHTML = `
          <div style="font-size:39px;font-weight:900;color:#39834e">
            ${Math.round(weather.temperature_2m)}°C
          </div>
          <p>Feels like ${Math.round(weather.apparent_temperature)}°C</p>
          <p>Humidity: ${weather.relative_humidity_2m}%</p>
          <p>Wind: ${weather.wind_speed_10m} km/h</p>
        `;
      }
    } catch {
      if (result) result.textContent = "Weather could not load right now.";
    }
  }

  /* ---------------- NEWS ---------------- */

  function cleanHeadline(value) {
    return String(value || "News update")
      .replace(/\s+-\s+[^-]{2,80}$/, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function cleanDescription(value) {
    const temp = document.createElement("div");
    temp.innerHTML = String(value || "");
    return (temp.textContent || temp.innerText || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 420);
  }

  async function loadNews() {
    const city = document.getElementById("ms-news-city")?.value.trim();
    const result = document.getElementById("ms-news");

    if (!city) {
      if (result) result.textContent = "Enter a city or region.";
      return;
    }

    if (result) result.textContent = "Finding the latest headlines...";

    try {
      const rss =
        "https://news.google.com/rss/search?q=" +
        encodeURIComponent(city) +
        "&hl=en-IN&gl=IN&ceid=IN:en";

      const url =
        "https://api.rss2json.com/v1/api.json?rss_url=" +
        encodeURIComponent(rss);

      const response = await fetch(url);
      if (!response.ok) throw new Error("News unavailable");

      const data = await response.json();
      if (data.status !== "ok") throw new Error("News feed unavailable");

      if (!result) return;
      result.innerHTML = "";

      (data.items || []).slice(0, 7).forEach(article => {
        const item = document.createElement("div");
        item.className = "ms-list-item";

        const title = document.createElement("strong");
        title.textContent = cleanHeadline(article.title);

        const description = document.createElement("small");
        const summary = cleanDescription(article.description);

        description.textContent = summary ||
          "Open the original report for the full story.";

        const date = document.createElement("small");
        date.textContent = article.pubDate
          ? "Published: " + new Date(article.pubDate).toLocaleString()
          : "";

        const link = document.createElement("a");
        link.textContent = "Read full report →";
        link.href = article.link;
        link.target = "_blank";
        link.rel = "noopener noreferrer";

        item.append(title, description, date, link);
        result.appendChild(item);
      });

      if (!data.items?.length) {
        result.textContent = "No headlines found for this region.";
      }

    } catch {
      if (result) result.textContent =
        "News could not load. Please try again later.";
    }
  }

  /* ---------------- DEPARTURE PLANNER ---------------- */

  function planDeparture(card) {
    const meeting = readEvents().find(
      m => m.id === card.dataset.meeting
    );

    if (!meeting) return;

    const travel = Math.max(
      0,
      Math.min(600, Number(card.querySelector("[data-travel]")?.value || 30))
    );

    const buffer = Math.max(
      0,
      Math.min(180, Number(card.querySelector("[data-buffer]")?.value || 15))
    );

    const departure = new Date(
      new Date(meeting.startAt).getTime() - (travel + buffer) * 60000
    );

    const result = card.querySelector("[data-result]");

    if (result) {
      result.textContent =
        "Suggested departure: " + formatDate(departure) +
        " · " + formatTime(departure) +
        ". This uses your entered travel estimate, not live traffic.";
    }

    const list = readEvents();
    const index = list.findIndex(m => m.id === meeting.id);

    if (index >= 0) {
      list[index].travelMinutes = travel;
      list[index].bufferMinutes = buffer;
      saveEvents(list);
    }
  }

  /* ---------------- MANUAL MEETINGS ---------------- */

  root.addEventListener("submit", event => {
    if (event.target.id !== "ms-meeting-form") return;

    event.preventDefault();

    const form = new FormData(event.target);
    const title = String(form.get("title") || "").trim();
    const venue = String(form.get("venue") || "").trim();
    const startAt = new Date(String(form.get("startAt") || ""));

    if (!title || Number.isNaN(startAt.getTime())) {
      notify("Enter a valid meeting title and date.");
      return;
    }

    addMeeting({
      id: "manual-" + Date.now(),
      title,
      venue,
      venueConfirmed: Boolean(venue),
      startAt: startAt.toISOString(),
      source: "Manual",
      travelMinutes: 30,
      bufferMinutes: 15
    });

    notify("Meeting added.");
  });

  /* ---------------- BUTTON ACTIONS ---------------- */

   /* =====================================================
   MORNI V4 — INTELLIGENCE INTEGRATION BRIDGE
   Connects the new upgrade to the original Services data.
   ===================================================== */

window.MORNI_V4_BRIDGE = {
  getMeetings: () => {
    try {
      return readEvents();
    } catch (error) {
      console.error("MORNI V4: Could not read meetings", error);
      return [];
    }
  },

  getNextMeeting: () => {
    try {
      return getNextMeeting();
    } catch (error) {
      console.error("MORNI V4: Could not find next meeting", error);
      return null;
    }
  },

  refreshInbox: () => {
    try {
      return loadInbox(false);
    } catch (error) {
      console.error("MORNI V4: Could not refresh Gmail", error);
    }
  }
};
  root.addEventListener("click", event => {
    const button = event.target.closest("[data-action]");
    if (!button) return;

    const action = button.dataset.action;

    if (action === "connect") connectGmail();
    if (action === "refresh") loadInbox(false);
    if (action === "locate") locate();
    if (action === "map") openCurrentMap();
    if (action === "weather") loadWeather();
    if (action === "news") loadNews();

    const card = button.closest("[data-meeting]");

    if (action === "route" && card) {
      const meeting = readEvents().find(m => m.id === card.dataset.meeting);
      if (meeting) openMeetingRoute(meeting);
    }

    if (action === "departure" && card) {
      planDeparture(card);
    }

    if (action === "remove" && card) {
      saveEvents(
        readEvents().filter(m => m.id !== card.dataset.meeting)
      );
      renderPage();
      updateOverviewCard();
      notify("Meeting removed.");
    }
  });

  /* ---------------- OVERVIEW MEETING CARD ---------------- */

  function updateOverviewCard() {
    if (servicesOpen) return;

    const homeButton =
      document.querySelector('.side-nav [data-page="home"]');

    if (homeButton && !homeButton.classList.contains("active")) return;

    const pageRoot = document.getElementById("pageContent");
    if (!pageRoot) return;

    pageRoot.querySelector("#ms-overview-meeting")?.remove();

    const next = getNextMeeting();
    if (!next) return;

    const card = document.createElement("section");
    card.id = "ms-overview-meeting";
    card.className = "morni-glass-panel";
    card.style.cssText =
      "padding:18px;margin:14px 0;border:1px solid #d5e5ce;border-radius:17px";

    card.innerHTML = `
      <span style="font-size:10px;font-weight:900;letter-spacing:1.5px;color:#368653">
        UPCOMING MEETING
      </span>
      <h3 style="margin:8px 0">${escapeHTML(next.title)}</h3>
      <p>${formatDate(next.startAt)} · ${formatTime(next.startAt)}</p>
      <p>${escapeHTML(next.venue || "Venue not specified")}</p>
      <button class="btn btn-primary" data-page="services">
        Open Meeting Assistant
      </button>
    `;

    const hero = pageRoot.querySelector(".welcome-hero");

    if (hero) {
      hero.insertAdjacentElement("afterend", card);
    } else {
      pageRoot.prepend(card);
    }
  }

  /* ---------------- PUBLIC CONTROLS ---------------- */

  window.MORNI_SERVICES = {
    open: showPage,
    locate,
    refreshWeather: loadWeather,
    refreshGmail: () => loadInbox(false),
    refreshNews: loadNews,
    getMeetings: () => readEvents()
  };

  setTimeout(updateOverviewCard, 1000);

  console.info("MORNI Premium Connected Services loaded.");
})();

/* =====================================================
   MORNI SERVICES — NAVIGATION & BRANDING POLISH
   ===================================================== */

/* =========================================================
   MORNI SERVICES — NATIVE SIDEBAR INTEGRATION
   ========================================================= */
(() => {
  "use strict";

  const button = document.getElementById("morni-services-button");
  const overlay = document.getElementById("morni-services-overlay");
  const panel = document.getElementById("morni-services-panel");

  if (!button || !overlay || !panel) return;

  const style = document.createElement("style");

  style.textContent = `
    /* Native sidebar item */
    #morni-services-button {
      position: static !important;
      inset: auto !important;
      z-index: auto !important;
      width: 100% !important;
      min-height: 46px !important;
      display: flex !important;
      align-items: center !important;
      justify-content: flex-start !important;
      gap: 13px !important;
      padding: 0 16px !important;
      margin: 5px 0 0 !important;
      border: 0 !important;
      border-radius: 12px !important;
      background: transparent !important;
      color: var(--muted,#68776b) !important;
      box-shadow: none !important;
      font-family: inherit !important;
      font-size: 13px !important;
      font-weight: 650 !important;
      text-align: left !important;
      cursor: pointer !important;
      transition: background .22s ease, color .22s ease,
                  transform .22s ease !important;
    }

    #morni-services-button:hover {
      background: rgba(56,115,70,.10) !important;
      color: #285b3b !important;
      transform: translateX(3px) !important;
    }

    #morni-services-button.morni-sidebar-active {
      background: #244d35 !important;
      color: white !important;
      box-shadow: 0 5px 14px rgba(36,77,53,.15) !important;
    }

    #morni-services-button .morni-services-icon {
      width: 23px;
      height: 23px;
      flex: 0 0 23px;
      display: grid;
      place-items: center;
      border-radius: 8px;
      background: rgba(218,169,91,.19);
      color: #c58a3d;
      font-size: 15px;
    }

    body[data-theme="dark"] #morni-services-button {
      color: #bdcbbb !important;
    }

    body[data-theme="dark"] #morni-services-button:hover {
      background: rgba(140,190,130,.12) !important;
      color: #dcebd5 !important;
    }

    body[data-theme="dark"] #morni-services-button.morni-sidebar-active {
      background: #3a7548 !important;
      color: white !important;
    }

    /* Smooth services window */
    #morni-services-overlay {
      background: rgba(9,24,16,.66) !important;
      backdrop-filter: blur(9px);
      -webkit-backdrop-filter: blur(9px);
      opacity: 0;
      transition: opacity .22s ease;
    }

    #morni-services-overlay.morni-services-visible {
      opacity: 1;
    }

    #morni-services-panel {
      width: min(780px,100%) !important;
      max-height: 88vh !important;
      overflow-y: auto !important;
      padding: clamp(20px,4vw,34px) !important;
      border: 1px solid rgba(205,174,119,.48) !important;
      border-radius: 25px !important;
      background: linear-gradient(145deg,#fbfaf2,#edf3e8) !important;
      color: #244332 !important;
      box-shadow: 0 25px 90px rgba(0,0,0,.28) !important;
      transform: translateY(14px) scale(.985);
      transition: transform .25s cubic-bezier(.2,.8,.2,1);
    }

    #morni-services-overlay.morni-services-visible
    #morni-services-panel {
      transform: translateY(0) scale(1);
    }

    #morni-services-panel h2 {
      font-family: inherit !important;
      color: #244d35 !important;
      font-size: clamp(24px,4vw,32px) !important;
      letter-spacing: -1px;
      margin: 4px 0 5px !important;
    }

    #morni-services-panel > p {
      color: #718174 !important;
      line-height: 1.6;
    }

    #morni-services-panel .morni-service-section {
      padding: 19px !important;
      margin: 14px 0 !important;
      border: 1px solid rgba(48,99,62,.14) !important;
      border-radius: 17px !important;
      background: rgba(255,255,255,.62) !important;
      box-shadow: 0 5px 18px rgba(30,65,40,.035);
      transition: border-color .2s, transform .2s;
    }

    #morni-services-panel .morni-service-section:hover {
      border-color: rgba(48,99,62,.34) !important;
    }

    #morni-services-panel .morni-service-section h3 {
      color: #285b3b !important;
      font-size: 16px !important;
      font-weight: 800 !important;
      margin-bottom: 12px !important;
    }

    #morni-services-panel .morni-service-button {
      background: #2f6b45 !important;
      color: white !important;
      border: 1px solid #2f6b45 !important;
      border-radius: 10px !important;
      padding: 10px 15px !important;
      font-weight: 750 !important;
      transition: .2s ease !important;
    }

    #morni-services-panel .morni-service-button:hover {
      background: #e5a14b !important;
      border-color: #e5a14b !important;
      color: #193b2a !important;
      transform: translateY(-1px);
    }

    #morni-services-panel .morni-service-input {
      background: #fffdf5 !important;
      color: #193b2a !important;
      border: 1px solid #cbd8c7 !important;
      border-radius: 10px !important;
      padding: 12px !important;
    }

    #morni-services-panel .morni-mail-item,
    #morni-services-panel .morni-news-item {
      padding: 13px 5px !important;
      border-bottom: 1px solid rgba(47,107,69,.15) !important;
      color: #244332 !important;
      line-height: 1.55;
    }

    #morni-services-panel a {
      color: #2f6b45 !important;
      font-weight: 750;
    }

    #morni-services-close {
      background: #f0dfc0 !important;
      color: #244d35 !important;
      border: 1px solid #e3c99c !important;
      border-radius: 10px !important;
      padding: 9px 13px !important;
      font-weight: 800;
    }

    /* Dark theme */
    body[data-theme="dark"] #morni-services-panel {
      background: linear-gradient(145deg,#17271e,#203529) !important;
      color: #edf4e8 !important;
      border-color: #49634c !important;
    }

    body[data-theme="dark"] #morni-services-panel h2,
    body[data-theme="dark"] #morni-services-panel h3 {
      color: #c1ddaF !important;
    }

    body[data-theme="dark"] #morni-services-panel > p {
      color: #b7c7b6 !important;
    }

    body[data-theme="dark"] #morni-services-panel .morni-service-section {
      background: rgba(255,255,255,.045) !important;
      border-color: #405b46 !important;
    }

    body[data-theme="dark"] #morni-services-panel .morni-service-input {
      background: #14231a !important;
      color: #edf4e8 !important;
      border-color: #526a55 !important;
    }

    body[data-theme="dark"] #morni-services-panel .morni-mail-item,
    body[data-theme="dark"] #morni-services-panel .morni-news-item {
      color: #edf4e8 !important;
      border-color: #405b46 !important;
    }

    body[data-theme="dark"] #morni-services-panel a {
      color: #c1ddaf !important;
    }

    body[data-theme="dark"] #morni-services-close {
      background: #354a37 !important;
      color: #edf4e8 !important;
      border-color: #526a55 !important;
    }

    @media(max-width:760px) {
      #morni-services-panel {
        max-height: 92vh !important;
        border-radius: 19px !important;
      }
    }

    @media(prefers-reduced-motion:reduce) {
      #morni-services-button,
      #morni-services-panel,
      #morni-services-overlay {
        transition: none !important;
      }
    }
  `;

  document.head.appendChild(style);

  // Move the Services button into the real sidebar.
  const sidebarNav = document.querySelector(".side-nav");
  if (!sidebarNav) return;

  button.className = "nav-btn";
  button.innerHTML = `
    <span class="morni-services-icon">✦</span>
    <span>Connected Services</span>
  `;
  button.setAttribute("aria-label", "Open Connected Services");

  const insightsButton = sidebarNav.querySelector(
    '[data-page="insights"]'
  );

  if (insightsButton) {
    insightsButton.insertAdjacentElement("afterend", button);
  } else {
    sidebarNav.appendChild(button);
  }

  function openServices() {
    overlay.style.display = "flex";
    button.classList.add("morni-sidebar-active");
    requestAnimationFrame(() => {
      overlay.classList.add("morni-services-visible");
    });
  }

  function closeServices() {
    overlay.classList.remove("morni-services-visible");
    button.classList.remove("morni-sidebar-active");

    setTimeout(() => {
      if (!overlay.classList.contains("morni-services-visible")) {
        overlay.style.display = "none";
      }
    }, 230);
  }

  // Replace the original simple open/close behaviour.
  button.onclick = openServices;
  document.getElementById("morni-services-close").onclick = closeServices;

  overlay.addEventListener("click", event => {
    if (event.target === overlay) closeServices();
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && overlay.style.display === "flex") {
      closeServices();
    }
  });

})();

/* ============================================================
   MORNI — MORNING INTELLIGENCE V3
   STABLE EDITION
   - No page-wide MutationObserver
   - No repeated rebuilding of input fields
   - Weather using Open-Meteo
   - Smart morning briefing
   - Smart commute calculator
   - Google Maps directions
   - Session-based location memory
   - Preserves existing MORNI services and Gmail code
   ============================================================ */

(() => {
  "use strict";

  /* Prevent accidental duplicate installation */
  if (window.__MORNI_INTELLIGENCE_V3__) return;
  window.__MORNI_INTELLIGENCE_V3__ = true;

  const STYLE_ID = "morni-intelligence-v3-style";
  const ROOT_ID = "morni-intelligence-v3";
  const LOCATION_KEY = "morni-v3-location";

  let lastBriefingUpdate = 0;
  let weatherLoading = false;
  let weatherLoaded = false;

  const $ = (selector, root = document) =>
    root.querySelector(selector);

  const safeText = (element) =>
    element ? (element.innerText || element.textContent || "").trim() : "";

  /* ------------------------------------------------------------
     1. FIND THE EXISTING CONNECTED SERVICES PAGE
     ------------------------------------------------------------ */

  function findServicesPage() {
    const panel = $("#morni-services-panel");

    if (panel) {
      const page = panel.querySelector(".ms-page");
      if (page) return page;
    }

    return Array.from(document.querySelectorAll(".ms-page")).find(page =>
      page.querySelector("#ms-weather") &&
      page.querySelector("#ms-gmail-list")
    ) || null;
  }

  function panelIsVisible() {
    const panel = $("#morni-services-panel");

    if (!panel) return false;

    const style = window.getComputedStyle(panel);

    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      panel.getClientRects().length > 0
    );
  }

  /* ------------------------------------------------------------
     2. STYLES
     ------------------------------------------------------------ */

  function addStyles() {
    if ($("#" + STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;

    style.textContent = `
      #${ROOT_ID} {
        width: 100%;
        margin: 22px 0;
        color: var(--text, #f5f7f4);
        font-family: inherit;
      }

      #${ROOT_ID} * {
        box-sizing: border-box;
      }

      #${ROOT_ID} .mi3-heading {
        margin: 0 0 14px;
        font-size: 21px;
        font-weight: 800;
        letter-spacing: -.4px;
      }

      #${ROOT_ID} .mi3-subheading {
        margin: 0 0 17px;
        color: var(--muted, #9ca99f);
        font-size: 13px;
        line-height: 1.5;
      }

      #${ROOT_ID} .mi3-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 15px;
      }

      #${ROOT_ID} .mi3-card {
        min-width: 0;
        padding: 19px;
        border-radius: 19px;
        border: 1px solid rgba(130, 160, 130, .20);
        background:
          linear-gradient(
            145deg,
            rgba(40, 65, 43, .28),
            rgba(22, 31, 25, .78)
          );
        box-shadow: 0 8px 25px rgba(0,0,0,.10);
      }

      #${ROOT_ID} .mi3-card-wide {
        grid-column: 1 / -1;
      }

      #${ROOT_ID} .mi3-card-title {
        display: flex;
        align-items: center;
        gap: 9px;
        margin: 0 0 12px;
        font-size: 15px;
        font-weight: 800;
      }

      #${ROOT_ID} .mi3-icon {
        width: 34px;
        height: 34px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 11px;
        background: rgba(117, 174, 91, .15);
        font-size: 18px;
        flex-shrink: 0;
      }

      #${ROOT_ID} .mi3-body {
        color: var(--text, #e9eee8);
        font-size: 13px;
        line-height: 1.7;
        overflow-wrap: anywhere;
      }

      #${ROOT_ID} .mi3-muted {
        color: var(--muted, #9ca99f);
        font-size: 12px;
        line-height: 1.6;
      }

      #${ROOT_ID} .mi3-weather-temp {
        margin: 7px 0;
        font-size: 32px;
        font-weight: 850;
        letter-spacing: -1px;
      }

      #${ROOT_ID} .mi3-weather-details {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 12px;
      }

      #${ROOT_ID} .mi3-chip {
        padding: 6px 9px;
        border-radius: 9px;
        background: rgba(255,255,255,.055);
        color: var(--text, #e9eee8);
        font-size: 11px;
      }

      #${ROOT_ID} .mi3-field {
        display: block;
        width: 100%;
        margin: 7px 0 12px;
        padding: 11px 12px;
        border: 1px solid rgba(150,170,150,.25);
        border-radius: 10px;
        background: rgba(0,0,0,.18);
        color: var(--text, #fff);
        font: inherit;
        font-size: 13px;
        min-width: 0;
      }

      #${ROOT_ID} .mi3-field:focus {
        outline: 2px solid rgba(132,190,105,.55);
        outline-offset: 1px;
      }

      #${ROOT_ID} .mi3-label {
        display: block;
        margin-top: 8px;
        color: var(--muted, #aab5a8);
        font-size: 11px;
        font-weight: 700;
      }

      #${ROOT_ID} .mi3-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 7px;
        min-height: 39px;
        padding: 10px 14px;
        border: 0;
        border-radius: 10px;
        background: linear-gradient(135deg, #79b957, #4c8b45);
        color: #fff;
        font-size: 12px;
        font-weight: 800;
        cursor: pointer;
        transition: transform .15s ease, filter .15s ease;
      }

      #${ROOT_ID} .mi3-button:hover {
        filter: brightness(1.08);
        transform: translateY(-1px);
      }

      #${ROOT_ID} .mi3-button-secondary {
        background: rgba(255,255,255,.09);
        border: 1px solid rgba(255,255,255,.12);
      }

      #${ROOT_ID} .mi3-button-row {
        display: flex;
        flex-wrap: wrap;
        gap: 9px;
        margin-top: 12px;
      }

      #${ROOT_ID} .mi3-result {
        margin-top: 13px;
        padding: 12px;
        border-radius: 11px;
        background: rgba(117,174,91,.10);
        border: 1px solid rgba(117,174,91,.18);
        color: var(--text, #e9eee8);
        font-size: 12px;
        line-height: 1.7;
        overflow-wrap: anywhere;
      }

      @media (max-width: 650px) {
        #${ROOT_ID} .mi3-grid {
          grid-template-columns: 1fr;
        }

        #${ROOT_ID} .mi3-card-wide {
          grid-column: auto;
        }
      }
    `;

    document.head.appendChild(style);
  }

  /* ------------------------------------------------------------
     3. CREATE THE DASHBOARD ONCE
     ------------------------------------------------------------ */

  function mountDashboard() {
    const page = findServicesPage();

    if (!page) return false;

    if (page.querySelector("#" + ROOT_ID)) return true;

    addStyles();

    const root = document.createElement("section");
    root.id = ROOT_ID;

    root.innerHTML = `
      <h2 class="mi3-heading">☀️ Morning Intelligence</h2>
      <p class="mi3-subheading">
        Your day, organised. A simple briefing of your inbox,
        weather and plans.
      </p>

      <div class="mi3-grid">

        <article class="mi3-card mi3-card-wide">
          <h3 class="mi3-card-title">
            <span class="mi3-icon">🧠</span>
            Your Morning Briefing
          </h3>
          <div class="mi3-body" id="mi3-briefing">
            Preparing your morning briefing...
          </div>
          <div class="mi3-button-row">
            <button class="mi3-button mi3-button-secondary"
                    type="button"
                    data-mi3-action="refresh-briefing">
              ↻ Refresh briefing
            </button>
          </div>
        </article>

        <article class="mi3-card">
          <h3 class="mi3-card-title">
            <span class="mi3-icon">🌤️</span>
            Live Weather
          </h3>
          <div id="mi3-weather">
            <div class="mi3-body">Location not loaded yet.</div>
            <p class="mi3-muted">
              Allow location access to get local weather.
            </p>
          </div>
          <div class="mi3-button-row">
            <button class="mi3-button"
                    type="button"
                    data-mi3-action="locate">
              📍 Get my weather
            </button>
            <button class="mi3-button mi3-button-secondary"
                    type="button"
                    data-mi3-action="refresh-weather">
              ↻ Refresh
            </button>
          </div>
        </article>

        <article class="mi3-card">
          <h3 class="mi3-card-title">
            <span class="mi3-icon">🚗</span>
            Smart Commute
          </h3>

          <p class="mi3-muted">
            Enter your meeting details to calculate when to leave.
          </p>

          <label class="mi3-label" for="mi3-destination">
            Meeting destination
          </label>
          <input class="mi3-field"
                 id="mi3-destination"
                 type="text"
                 maxlength="180"
                 placeholder="e.g. School auditorium">

          <label class="mi3-label" for="mi3-meeting-time">
            Meeting date and time
          </label>
          <input class="mi3-field"
                 id="mi3-meeting-time"
                 type="datetime-local">

          <label class="mi3-label" for="mi3-travel">
            Estimated travel time (minutes)
          </label>
          <input class="mi3-field"
                 id="mi3-travel"
                 type="number"
                 min="0"
                 max="600"
                 value="30">

          <label class="mi3-label" for="mi3-buffer">
            Extra time buffer (minutes)
          </label>
          <input class="mi3-field"
                 id="mi3-buffer"
                 type="number"
                 min="0"
                 max="180"
                 value="15">

          <div class="mi3-button-row">
            <button class="mi3-button"
                    type="button"
                    data-mi3-action="calculate">
              ⏱️ Calculate departure
            </button>
            <button class="mi3-button mi3-button-secondary"
                    type="button"
                    data-mi3-action="directions">
              🗺️ Directions
            </button>
          </div>

          <div class="mi3-result"
               id="mi3-commute-result"
               aria-live="polite">
            Your departure plan will appear here.
          </div>
        </article>

      </div>
    `;

    const hero = page.querySelector(".ms-hero");

    if (hero) {
      hero.insertAdjacentElement("afterend", root);
    } else {
      page.prepend(root);
    }

    updateBriefing(true);
    restoreWeather();

    return true;
  }

  /* ------------------------------------------------------------
     4. MORNING BRIEFING
     Reads visible information from existing MORNI service cards.
     It does not access or transmit email data.
     ------------------------------------------------------------ */

  function updateBriefing(force = false) {
    const output = $("#mi3-briefing");

    if (!output) return;

    const now = Date.now();

    if (!force && now - lastBriefingUpdate < 10000) return;

    lastBriefingUpdate = now;

    const gmailList = $("#ms-gmail-list");
    const newsArea = $("#ms-news");

    const emailText = safeText(gmailList);
    const newsText = safeText(newsArea);

    const emailItems = gmailList
      ? Array.from(gmailList.querySelectorAll(".ms-list-item"))
      : [];

    const emailCount = emailItems.length;

    const importantWords =
      /\b(urgent|important|deadline|exam|meeting|tomorrow|today|reminder|action required)\b/i;

    let priorityCount = 0;

    emailItems.forEach(item => {
      if (importantWords.test(safeText(item))) {
        priorityCount++;
      }
    });

    const lines = [];

    if (!gmailList || !emailText) {
      lines.push(
        "📧 Your inbox is not showing any messages yet. " +
        "Connect or refresh Gmail in the Gmail section."
      );
    } else {
      lines.push(
        "📧 Your inbox currently displays " +
        emailCount +
        " message" +
        (emailCount === 1 ? "" : "s") +
        "."
      );

      if (priorityCount > 0) {
        lines.push(
          "⭐ " + priorityCount +
          " displayed message(s) contain priority-related words. " +
          "Review them in Gmail."
        );
      } else {
        lines.push(
          "✅ No obvious priority keywords were found in the displayed messages."
        );
      }
    }

    const meetingsArea = $("#ms-meetings");
    const meetingsText = safeText(meetingsArea);

    if (meetingsText) {
      lines.push(
        "📅 Meeting Assistant has information available. " +
        "Check its meeting list for your next event."
      );
    } else {
      lines.push(
        "📅 No meeting information is currently displayed. " +
        "Check Meeting Assistant or add a meeting."
      );
    }

    if (newsText) {
      const headline = newsText
        .split("\n")
        .map(line => line.trim())
        .find(line =>
          line.length > 15 &&
          !/^(refresh|read more|load more|news)$/i.test(line)
        );

      if (headline) {
        lines.push(
          "📰 News update: " + headline.slice(0, 180)
        );
      }
    } else {
      lines.push(
        "📰 Local news has not loaded yet. Check the News section."
      );
    }

    if (weatherLoaded) {
      lines.push(
        "🌤️ Local weather is available in your Live Weather card."
      );
    } else {
      lines.push(
        "🌤️ Get your local weather to complete your morning overview."
      );
    }

    lines.push(
      "💡 MORNI tip: Review important messages and confirm your next meeting before leaving."
    );

    const newText = lines.join("\n\n");

    if (output.textContent !== newText) {
      output.textContent = newText;
      output.style.whiteSpace = "pre-line";
    }
  }

  /* ------------------------------------------------------------
     5. WEATHER
     Uses Open-Meteo. No API key required.
     ------------------------------------------------------------ */

  function weatherDescription(code) {
    const descriptions = {
      0: "Clear sky",
      1: "Mostly clear",
      2: "Partly cloudy",
      3: "Overcast",
      45: "Foggy",
      48: "Foggy",
      51: "Light drizzle",
      53: "Drizzle",
      55: "Heavy drizzle",
      56: "Freezing drizzle",
      57: "Freezing drizzle",
      61: "Light rain",
      63: "Rain",
      65: "Heavy rain",
      66: "Freezing rain",
      67: "Freezing rain",
      71: "Light snow",
      73: "Snow",
      75: "Heavy snow",
      77: "Snow grains",
      80: "Rain showers",
      81: "Rain showers",
      82: "Heavy rain showers",
      85: "Snow showers",
      86: "Heavy snow showers",
      95: "Thunderstorm",
      96: "Thunderstorm with hail",
      99: "Thunderstorm with hail"
    };

    return descriptions[code] || "Weather conditions";
  }

  function weatherAdvice(code, temperature, rainChance) {
    if (code >= 95) {
      return "Thunderstorms may occur. Check local weather alerts before travelling.";
    }

    if (rainChance >= 60 || (code >= 51 && code <= 82)) {
      return "Rain is possible. Consider carrying an umbrella.";
    }

    if (temperature >= 34) {
      return "It may feel hot. Stay hydrated and plan for the heat.";
    }

    if (temperature <= 15) {
      return "It may feel cool. Consider carrying an extra layer.";
    }

    return "Conditions may be comfortable for your usual plans.";
  }

  function getSavedLocation() {
    try {
      const raw = sessionStorage.getItem(LOCATION_KEY);
      if (!raw) return null;

      const location = JSON.parse(raw);

      if (
        Number.isFinite(location.latitude) &&
        Number.isFinite(location.longitude)
      ) {
        return location;
      }
    } catch (error) {
      console.warn("MORNI: Could not restore saved location.", error);
    }

    return null;
  }

  function saveLocation(latitude, longitude) {
    try {
      sessionStorage.setItem(
        LOCATION_KEY,
        JSON.stringify({ latitude, longitude })
      );
    } catch (error) {
      console.warn("MORNI: Location could not be saved for this session.");
    }
  }

  async function loadWeather(latitude, longitude) {
    if (weatherLoading) return;

    weatherLoading = true;

    const output = $("#mi3-weather");

    if (output) {
      output.textContent = "Loading local weather...";
    }

    try {
      const params = new URLSearchParams({
        latitude: String(latitude),
        longitude: String(longitude),
        current:
          "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m",
        daily:
          "temperature_2m_max,temperature_2m_min,precipitation_probability_max",
        timezone: "auto"
      });

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);

      let response;

      try {
        response = await fetch(
          "https://api.open-meteo.com/v1/forecast?" + params.toString(),
          { signal: controller.signal }
        );
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        throw new Error("Weather service returned " + response.status);
      }

      const data = await response.json();

      if (!data.current) {
        throw new Error("Weather data was incomplete.");
      }

      const current = data.current;
      const daily = data.daily || {};

      const temperature = Math.round(current.temperature_2m);
      const feelsLike = Math.round(current.apparent_temperature);
      const humidity = Math.round(current.relative_humidity_2m);
      const wind = Math.round(current.wind_speed_10m);
      const rainChance = daily.precipitation_probability_max
        ? daily.precipitation_probability_max[0]
        : 0;

      const description = weatherDescription(current.weather_code);

      const advice = weatherAdvice(
        current.weather_code,
        temperature,
        rainChance || 0
      );

      if (!output) return;

      output.innerHTML = `
        <div class="mi3-weather-temp">
          ${temperature}°C
        </div>
        <div class="mi3-body">${description}</div>
        <div class="mi3-muted">
          Feels like ${feelsLike}°C
        </div>
        <div class="mi3-weather-details">
          <span class="mi3-chip">💧 ${humidity}% humidity</span>
          <span class="mi3-chip">💨 ${wind} km/h wind</span>
          <span class="mi3-chip">🌧️ ${rainChance ?? 0}% rain chance</span>
        </div>
        <p class="mi3-muted" style="margin-top:12px">
          ${advice}
        </p>
        <p class="mi3-muted">
          Live forecast provided by Open-Meteo.
        </p>
      `;

      weatherLoaded = true;
      updateBriefing(true);

      const locationStatus = $("#ms-location-status");

      if (locationStatus) {
        locationStatus.textContent = "Location weather loaded.";
      }

    } catch (error) {
      console.error("MORNI V3 weather error:", error);

      if (output) {
        output.textContent =
          "Weather could not load. Check your internet connection and try again.";
      }
    } finally {
      weatherLoading = false;
    }
  }

  function requestLocation() {
    const output = $("#mi3-weather");

    if (!navigator.geolocation) {
      if (output) {
        output.textContent =
          "Your browser does not support location services.";
      }
      return;
    }

    if (output) {
      output.textContent = "Requesting your location...";
    }

    navigator.geolocation.getCurrentPosition(
      position => {
        const latitude = position.coords.latitude;
        const longitude = position.coords.longitude;

        saveLocation(latitude, longitude);
        loadWeather(latitude, longitude);
      },
      error => {
        console.warn("MORNI location error:", error);

        if (output) {
          output.textContent =
            "Location access was unavailable. Allow location permission in your browser and try again.";
        }
      },
      {
        enableHighAccuracy: false,
        timeout: 12000,
        maximumAge: 300000
      }
    );
  }

  function restoreWeather() {
    const location = getSavedLocation();

    if (location) {
      loadWeather(location.latitude, location.longitude);
    }
  }

  /* ------------------------------------------------------------
     6. SMART COMMUTE
     Calculates departure time from the user's supplied details.
     Google Maps handles the actual route.
     ------------------------------------------------------------ */

  function getCommuteValues() {
    const destination = ($("#mi3-destination")?.value || "").trim();
    const meetingTime = $("#mi3-meeting-time")?.value || "";

    const travel = Number($("#mi3-travel")?.value);
    const buffer = Number($("#mi3-buffer")?.value);

    if (!destination) {
      return { error: "Enter your meeting destination first." };
    }

    if (!meetingTime) {
      return { error: "Enter the meeting date and time first." };
    }

    if (
      !Number.isFinite(travel) ||
      travel < 0 ||
      travel > 600
    ) {
      return { error: "Travel time must be between 0 and 600 minutes." };
    }

    if (
      !Number.isFinite(buffer) ||
      buffer < 0 ||
      buffer > 180
    ) {
      return { error: "Your extra buffer must be between 0 and 180 minutes." };
    }

    const meetingDate = new Date(meetingTime);

    if (Number.isNaN(meetingDate.getTime())) {
      return { error: "Please enter a valid meeting date and time." };
    }

    return {
      destination,
      meetingDate,
      travel,
      buffer
    };
  }

  function calculateDeparture() {
    const result = $("#mi3-commute-result");
    const values = getCommuteValues();

    if (!result) return;

    if (values.error) {
      result.textContent = values.error;
      return;
    }

    const totalMinutes = values.travel + values.buffer;
    const departure = new Date(
      values.meetingDate.getTime() - totalMinutes * 60000
    );

    const now = new Date();

    if (values.meetingDate <= now) {
      result.textContent =
        "This meeting time is in the past. Update the date and time.";
      return;
    }

    const dateOptions = {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit"
    };

    result.textContent =
      "🕒 Suggested departure: " +
      departure.toLocaleString(undefined, dateOptions) +
      "\n\n" +
      "Meeting time: " +
      values.meetingDate.toLocaleString(undefined, dateOptions) +
      "\n" +
      "Estimated travel: " + values.travel + " minutes\n" +
      "Extra buffer: " + values.buffer + " minutes\n" +
      "Total planned time: " + totalMinutes + " minutes\n\n" +
      "This is based on the travel time you entered. Check Google Maps for the current route and traffic before leaving.";
  }

  function openDirections() {
    const destination = ($("#mi3-destination")?.value || "").trim();
    const result = $("#mi3-commute-result");

    if (!destination) {
      if (result) {
        result.textContent = "Enter a destination before opening directions.";
      }
      return;
    }

    const url =
      "https://www.google.com/maps/dir/?api=1&destination=" +
      encodeURIComponent(destination) +
      "&travelmode=driving";

    window.open(url, "_blank", "noopener,noreferrer");
  }

  /* ------------------------------------------------------------
     7. BUTTON HANDLERS
     All V3 buttons use their own data-mi3-action attributes.
     ------------------------------------------------------------ */

  document.addEventListener("click", event => {
    const button = event.target.closest("[data-mi3-action]");

    if (!button) return;

    const action = button.getAttribute("data-mi3-action");

    if (action === "locate") {
      requestLocation();
    }

    if (action === "refresh-weather") {
      const location = getSavedLocation();

      if (location) {
        loadWeather(location.latitude, location.longitude);
      } else {
        requestLocation();
      }
    }

    if (action === "refresh-briefing") {
      updateBriefing(true);
    }

    if (action === "calculate") {
      calculateDeparture();
    }

    if (action === "directions") {
      openDirections();
    }
  });

  /* ------------------------------------------------------------
     8. CONNECT TO THE EXISTING LOCATION BUTTON
     Prevents the old and new location handlers from firing twice.
     ------------------------------------------------------------ */

  document.addEventListener("click", event => {
    const oldLocateButton = event.target.closest(
      '#morni-services-panel [data-action="locate"]'
    );

    if (!oldLocateButton) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    requestLocation();
  }, true);

  /* ------------------------------------------------------------
     9. SAFE INITIALISATION
     No MutationObserver.
     No constant DOM rebuilding.
     Polls only while Connected Services is visible.
     ------------------------------------------------------------ */

  function initialise() {
    mountDashboard();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialise, {
      once: true
    });
  } else {
    initialise();
  }

  /* Open Connected Services: mount after its existing click handler. */
  document.addEventListener("click", event => {
    const servicesButton = event.target.closest(
      "#morni-services-button"
    );

    if (servicesButton) {
      setTimeout(mountDashboard, 150);
      setTimeout(mountDashboard, 500);
    }
  }, true);

  /* Light check: only looks for the dashboard while panel is open. */
  setInterval(() => {
    if (!panelIsVisible()) return;

    mountDashboard();

    const now = Date.now();

    if (now - lastBriefingUpdate >= 12000) {
      updateBriefing();
    }
  }, 1500);

  /* Public refresh controls for future MORNI integrations. */
  window.MORNI_INTELLIGENCE = {
    version: "3.0",
    refresh: () => {
      mountDashboard();
      updateBriefing(true);
    },
    refreshBriefing: () => updateBriefing(true),
    refreshWeather: () => {
      const location = getSavedLocation();

      if (location) {
        loadWeather(location.latitude, location.longitude);
      } else {
        requestLocation();
      }
    },
    locate: requestLocation,
    calculateDeparture: calculateDeparture,
    openDirections: openDirections
  };

  console.log("MORNI Morning Intelligence V3 loaded.");
})();


/* ============================================================
   MORNI V4 — CONNECTED INTELLIGENCE EXPANSION
   ------------------------------------------------------------
   Additive extension. Does not replace original MORNI code.
   Integrates through the existing Connected Services DOM.
   
   Features:
   - Unified Smart Morning Briefing
   - Gmail priority overview
   - Existing meeting awareness
   - Meeting-specific route and departure shortcuts
   - Smart manual commute calculator
   - Weather and news summaries
   - One-click refresh of existing services
   - Safe, lightweight updates
   - No MutationObserver or repeated form rebuilding
   ============================================================ */

(() => {
  "use strict";

  if (window.__MORNI_V4_INSTALLED__) return;
  window.__MORNI_V4_INSTALLED__ = true;

  const ID = "morni-v4-intelligence";
  const STYLE_ID = "morni-v4-styles";

  let lastSummary = "";
  let lastMeetingsSignature = "";
  let meetingsCache = [];

  const $ = (selector, root = document) =>
    root.querySelector(selector);

  const $$ = (selector, root = document) =>
    Array.from(root.querySelectorAll(selector));

  const clean = value =>
    String(value || "").replace(/\s+/g, " ").trim();

  function getPage() {
    const panel = $("#morni-services-panel");

    if (panel) {
      const page = $(".ms-page", panel);
      if (page) return page;
    }

    return $$(".ms-page").find(page =>
      $("#ms-gmail-list", page) &&
      $("#ms-meetings", page)
    ) || null;
  }

  function isVisible(element) {
    if (!element) return false;

    const style = getComputedStyle(element);

    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      element.getClientRects().length > 0
    );
  }

  /* ----------------------------------------------------------
     1. DESIGN
     ---------------------------------------------------------- */

  function installStyles() {
    if ($("#" + STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;

    style.textContent = `
      #${ID} {
        margin: 24px 0;
        color: var(--text, #edf2eb);
        font-family: inherit;
      }

      #${ID} * {
        box-sizing: border-box;
      }

      #${ID} .v4-heading {
        margin: 0 0 6px;
        font-size: 23px;
        font-weight: 850;
        letter-spacing: -.6px;
      }

      #${ID} .v4-description {
        color: var(--muted, #a5b0a4);
        font-size: 13px;
        line-height: 1.6;
        margin: 0 0 17px;
      }

      #${ID} .v4-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 15px;
      }

      #${ID} .v4-card {
        min-width: 0;
        padding: 18px;
        border: 1px solid rgba(130,165,125,.20);
        border-radius: 17px;
        background: linear-gradient(
          145deg,
          rgba(45,72,46,.28),
          rgba(22,31,25,.76)
        );
        box-shadow: 0 8px 24px rgba(0,0,0,.09);
      }

      #${ID} .v4-wide {
        grid-column: 1 / -1;
      }

      #${ID} .v4-title {
        display: flex;
        align-items: center;
        gap: 10px;
        margin: 0 0 12px;
        font-size: 15px;
        font-weight: 800;
      }

      #${ID} .v4-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 35px;
        height: 35px;
        flex-shrink: 0;
        border-radius: 11px;
        background: rgba(119,177,91,.15);
        font-size: 18px;
      }

      #${ID} .v4-content {
        font-size: 13px;
        line-height: 1.75;
        color: var(--text, #edf2eb);
        overflow-wrap: anywhere;
      }

      #${ID} .v4-muted {
        color: var(--muted, #a5b0a4);
        font-size: 12px;
        line-height: 1.6;
      }

      #${ID} .v4-item {
        padding: 10px 0;
        border-bottom: 1px solid rgba(150,170,150,.12);
      }

      #${ID} .v4-item:last-child {
        border-bottom: 0;
      }

      #${ID} .v4-field {
        display: block;
        width: 100%;
        min-width: 0;
        margin: 7px 0 12px;
        padding: 11px 12px;
        border: 1px solid rgba(150,170,150,.25);
        border-radius: 10px;
        background: rgba(0,0,0,.18);
        color: var(--text, #fff);
        font: inherit;
        font-size: 13px;
      }

      #${ID} .v4-field:focus {
        outline: 2px solid rgba(130,190,105,.55);
        outline-offset: 1px;
      }

      #${ID} .v4-label {
        display: block;
        margin-top: 8px;
        color: var(--muted, #aab5a8);
        font-size: 11px;
        font-weight: 750;
      }

      #${ID} .v4-button {
        min-height: 38px;
        padding: 9px 13px;
        border: 0;
        border-radius: 10px;
        background: linear-gradient(135deg,#79b957,#4c8b45);
        color: white;
        font-size: 12px;
        font-weight: 800;
        cursor: pointer;
      }

      #${ID} .v4-button:hover {
        filter: brightness(1.1);
      }

      #${ID} .v4-secondary {
        background: rgba(255,255,255,.09);
        border: 1px solid rgba(255,255,255,.12);
      }

      #${ID} .v4-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 9px;
        margin-top: 13px;
      }

      #${ID} .v4-result {
        margin-top: 13px;
        padding: 12px;
        border-radius: 11px;
        border: 1px solid rgba(119,177,91,.19);
        background: rgba(119,177,91,.09);
        font-size: 12px;
        line-height: 1.7;
        white-space: pre-line;
        overflow-wrap: anywhere;
      }

      #${ID} .v4-status {
        display: inline-block;
        padding: 5px 9px;
        border-radius: 8px;
        background: rgba(119,177,91,.12);
        color: var(--text, #edf2eb);
        font-size: 11px;
      }

      @media(max-width:650px) {
        #${ID} .v4-grid {
          grid-template-columns: 1fr;
        }

        #${ID} .v4-wide {
          grid-column: auto;
        }
      }
    `;

    document.head.appendChild(style);
  }

  /* ----------------------------------------------------------
     2. CREATE THE V4 INTERFACE
     ---------------------------------------------------------- */

  function mount() {
    const page = getPage();

    if (!page) return false;

    if ($("#" + ID, page)) return true;

    installStyles();

    const section = document.createElement("section");
    section.id = ID;

    section.innerHTML = `
      <h2 class="v4-heading">✦ MORNI Intelligence</h2>
      <p class="v4-description">
        Your connected day, understood in one place.
        Your inbox, meetings, weather and news work together.
      </p>

      <div class="v4-grid">

        <article class="v4-card v4-wide">
          <h3 class="v4-title">
            <span class="v4-icon">🧠</span>
            Smart Morning Briefing
          </h3>

          <div class="v4-content" id="v4-briefing">
            Preparing your briefing...
          </div>

          <div class="v4-actions">
            <button class="v4-button" data-v4="refresh">
              ↻ Refresh connected information
            </button>
            <button class="v4-button v4-secondary" data-v4="briefing">
              Update briefing
            </button>
          </div>

          <p class="v4-muted" id="v4-updated">
            Briefing uses information currently displayed in MORNI.
          </p>
        </article>

        <article class="v4-card">
          <h3 class="v4-title">
            <span class="v4-icon">📅</span>
            Meeting Intelligence
          </h3>

          <div id="v4-meetings" class="v4-content">
            Looking for your meetings...
          </div>

          <label class="v4-label" for="v4-meeting-select">
            Select a detected meeting
          </label>

          <select class="v4-field" id="v4-meeting-select">
            <option value="">No meeting selected</option>
          </select>

          <div class="v4-actions">
            <button class="v4-button" data-v4="meeting-route">
              🗺️ Open meeting route
            </button>
            <button class="v4-button v4-secondary" data-v4="meeting-departure">
              ⏱️ Existing departure planner
            </button>
          </div>
        </article>

        <article class="v4-card">
          <h3 class="v4-title">
            <span class="v4-icon">🚗</span>
            Smart Commute Planner
          </h3>

          <p class="v4-muted">
            Plan a journey using your meeting time, estimated travel
            duration and an extra buffer.
          </p>

          <label class="v4-label" for="v4-destination">
            Destination
          </label>
          <input class="v4-field" id="v4-destination"
            maxlength="180" placeholder="Enter a destination">

          <label class="v4-label" for="v4-time">
            Meeting date and time
          </label>
          <input class="v4-field" id="v4-time" type="datetime-local">

          <label class="v4-label" for="v4-travel">
            Estimated journey (minutes)
          </label>
          <input class="v4-field" id="v4-travel"
            type="number" min="0" max="600" value="30">

          <label class="v4-label" for="v4-buffer">
            Extra buffer (minutes)
          </label>
          <input class="v4-field" id="v4-buffer"
            type="number" min="0" max="180" value="15">

          <div class="v4-actions">
            <button class="v4-button" data-v4="calculate">
              Calculate departure
            </button>
            <button class="v4-button v4-secondary" data-v4="directions">
              Open Google Maps
            </button>
          </div>

          <div class="v4-result" id="v4-commute-result">
            Your departure recommendation will appear here.
          </div>
        </article>

        <article class="v4-card">
          <h3 class="v4-title">
            <span class="v4-icon">🌤️</span>
            Weather Intelligence
          </h3>

          <div id="v4-weather" class="v4-content">
            Waiting for weather information...
          </div>

          <p class="v4-muted">
            Uses your existing MORNI weather card.
          </p>
        </article>

        <article class="v4-card">
          <h3 class="v4-title">
            <span class="v4-icon">📰</span>
            News Intelligence
          </h3>

          <div id="v4-news" class="v4-content">
            Waiting for news headlines...
          </div>

          <p class="v4-muted">
            A shorter view of the headlines already loaded in MORNI.
          </p>
        </article>

      </div>
    `;

    const previous = $("#" + "morni-intelligence-v3", page);
    const hero = $(".ms-hero", page);
    const grid = $(".ms-grid", page);

    if (previous) {
      previous.insertAdjacentElement("afterend", section);
    } else if (grid) {
      grid.insertAdjacentElement("afterend", section);
    } else if (hero) {
      hero.insertAdjacentElement("afterend", section);
    } else {
      page.appendChild(section);
    }

    refreshAllDisplays();

    return true;
  }

  /* ----------------------------------------------------------
     3. READ EXISTING CONNECTED SERVICES
     ---------------------------------------------------------- */

  function getEmailItems() {
    const list = $("#ms-gmail-list");
    if (!list) return [];

    return $$(".ms-list-item", list)
      .map(item => clean(item.innerText || item.textContent))
      .filter(Boolean);
  }

  function getMeetingCards() {
    const area = $("#ms-meetings");
    if (!area) return [];

    return $$("[data-meeting]", area).filter(card =>
      clean(card.innerText || card.textContent)
    );
  }

  function getMeetingTitle(card) {
    const heading = $("h1,h2,h3,h4,strong", card);

    if (heading) return clean(heading.textContent);

    return clean(card.innerText || card.textContent)
      .split("\n")
      .filter(Boolean)[0] || "Scheduled meeting";
  }

  function getMeetingSummary(card) {
    return clean(card.innerText || card.textContent)
      .slice(0, 220);
  }

  function getNewsLines() {
    const area = $("#ms-news");
    if (!area) return [];

    return clean(area.innerText || area.textContent)
      .split(/(?<=[.!?])\s+|\n+/)
      .map(clean)
      .filter(line =>
        line.length > 20 &&
        !/^(refresh|read more|load more|discover news)$/i.test(line)
      );
  }

  function getWeatherText() {
    return clean($("#ms-weather")?.innerText || "");
  }

  /* ----------------------------------------------------------
     4. BRIEFING GENERATION
     ---------------------------------------------------------- */

  function buildBriefing() {
    const emails = getEmailItems();
    const meetings = getMeetingCards();
    const weather = getWeatherText();
    const news = getNewsLines();

    const priorityPattern =
      /\b(urgent|important|deadline|exam|meeting|tomorrow|today|reminder|action required|invitation)\b/i;

    const priorities = emails.filter(email =>
      priorityPattern.test(email)
    );

    const lines = [];

    lines.push(
      emails.length
        ? `📧 Your inbox currently displays ${emails.length} message(s).`
        : "📧 No inbox messages are currently displayed. Check your Gmail connection."
    );

    if (priorities.length) {
      lines.push(
        `⭐ ${priorities.length} displayed email(s) contain priority-related keywords. Review these messages in Gmail.`
      );

      priorities.slice(0, 3).forEach(email => {
        lines.push("• " + email.slice(0, 150));
      });
    } else if (emails.length) {
      lines.push("✅ No obvious priority keywords were found in the displayed messages.");
    }

    lines.push(
      meetings.length
        ? `📅 MORNI currently displays ${meetings.length} meeting(s) in Meeting Assistant.`
        : "📅 No detected meetings are currently displayed. Check your Meeting Assistant."
    );

    meetings.slice(0, 2).forEach(card => {
      lines.push("• " + getMeetingSummary(card));
    });

    lines.push(
      weather
        ? "🌤️ Weather: " + weather.slice(0, 240)
        : "🌤️ Weather has not loaded yet. Use the existing weather card."
    );

    if (news.length) {
      lines.push("📰 News to know:");

      news.slice(0, 3).forEach(headline => {
        lines.push("• " + headline.slice(0, 170));
      });
    } else {
      lines.push("📰 News has not loaded yet. Use Discover News in the existing card.");
    }

    lines.push(
      "💡 MORNI recommendation: Review priority emails, confirm your next meeting and check your route before travelling."
    );

    return lines.join("\n\n");
  }

  function updateBriefing() {
    const output = $("#v4-briefing");
    if (!output) return;

    const result = buildBriefing();

    if (result !== lastSummary) {
      output.textContent = result;
      output.style.whiteSpace = "pre-line";
      lastSummary = result;
    }

    const updated = $("#v4-updated");
    if (updated) {
      updated.textContent =
        "Last updated: " +
        new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit"
        });
    }
  }

  /* ----------------------------------------------------------
     5. MEETING INTELLIGENCE
     ---------------------------------------------------------- */

  function updateMeetings() {
    const cards = getMeetingCards();
    const signature = cards.map(card =>
      card.dataset.meeting + ":" + getMeetingSummary(card)
    ).join("|");

    const output = $("#v4-meetings");
    const select = $("#v4-meeting-select");

    if (!output || !select) return;

    if (signature === lastMeetingsSignature) return;

    lastMeetingsSignature = signature;
    meetingsCache = cards;

    if (!cards.length) {
      output.textContent =
        "No meeting cards are currently displayed. Connect Gmail or add a meeting using your existing Meeting Assistant.";
    } else {
      output.textContent =
        cards.length + " meeting(s) currently available in MORNI.";
    }

    const oldValue = select.value;

    select.replaceChildren();

    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "Choose a meeting";
    select.appendChild(empty);

    cards.forEach((card, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = getMeetingTitle(card);
      select.appendChild(option);
    });

    if (oldValue !== "" && Number(oldValue) < cards.length) {
      select.value = oldValue;
    }
  }

  function selectedMeeting() {
    const select = $("#v4-meeting-select");

    if (!select || select.value === "") return null;

    return meetingsCache[Number(select.value)] || null;
  }

  function useExistingMeetingAction(action) {
    const card = selectedMeeting();
    const result = $("#v4-commute-result");

    if (!card) {
      if (result) result.textContent = "Select a detected meeting first.";
      return;
    }

    const button = $(`[data-action="${action}"]`, card);

    if (!button) {
      if (result) {
        result.textContent =
          "The selected meeting does not currently provide this action.";
      }
      return;
    }

    button.click();
  }

  /* ----------------------------------------------------------
     6. WEATHER AND NEWS SUMMARIES
     ---------------------------------------------------------- */

  function updateWeather() {
    const output = $("#v4-weather");
    if (!output) return;

    const weather = getWeatherText();

    output.textContent = weather
      ? weather.slice(0, 450)
      : "Weather is not available yet. Use Find My Location or Refresh Weather in the original MORNI card.";
  }

  function updateNews() {
    const output = $("#v4-news");
    if (!output) return;

    const headlines = getNewsLines();

    if (!headlines.length) {
      output.textContent =
        "No headlines are currently displayed. Choose your region and use Discover News in the original MORNI card.";
      return;
    }

    output.replaceChildren();

    headlines.slice(0, 4).forEach(headline => {
      const item = document.createElement("div");
      item.className = "v4-item";
      item.textContent = headline.slice(0, 200);
      output.appendChild(item);
    });
  }

  function refreshAllDisplays() {
    updateBriefing();
    updateMeetings();
    updateWeather();
    updateNews();
  }

  /* ----------------------------------------------------------
     7. REFRESH EXISTING SERVICES
     Uses the original buttons, preserving their event handlers.
     ---------------------------------------------------------- */

  function refreshConnectedServices() {
    const page = getPage();
    if (!page) return;

    const actions = ["refresh", "weather", "news"];

    actions.forEach(action => {
      const button = $(`[data-action="${action}"]`, page);

      if (button && !button.disabled) {
        button.click();
      }
    });

    setTimeout(refreshAllDisplays, 1200);
    setTimeout(refreshAllDisplays, 3500);
  }

  /* ----------------------------------------------------------
     8. SMART COMMUTE
     ---------------------------------------------------------- */

  function commuteValues() {
    const destination = clean($("#v4-destination")?.value);
    const time = $("#v4-time")?.value;
    const travel = Number($("#v4-travel")?.value);
    const buffer = Number($("#v4-buffer")?.value);

    if (!destination) return { error: "Enter a destination." };
    if (!time) return { error: "Enter the meeting date and time." };

    if (!Number.isFinite(travel) || travel < 0 || travel > 600) {
      return { error: "Travel time must be between 0 and 600 minutes." };
    }

    if (!Number.isFinite(buffer) || buffer < 0 || buffer > 180) {
      return { error: "Buffer must be between 0 and 180 minutes." };
    }

    const meeting = new Date(time);

    if (Number.isNaN(meeting.getTime())) {
      return { error: "Please enter a valid meeting date and time." };
    }

    return { destination, meeting, travel, buffer };
  }

  function calculateDeparture() {
    const output = $("#v4-commute-result");
    if (!output) return;

    const values = commuteValues();

    if (values.error) {
      output.textContent = values.error;
      return;
    }

    if (values.meeting <= new Date()) {
      output.textContent = "That meeting time is in the past. Please update it.";
      return;
    }

    const departure = new Date(
      values.meeting.getTime() -
      (values.travel + values.buffer) * 60000
    );

    const format = date => date.toLocaleString([], {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit"
    });

    output.textContent =
      "🚗 Suggested departure: " + format(departure) +
      "\n\nMeeting: " + format(values.meeting) +
      "\nEstimated journey: " + values.travel + " minutes" +
      "\nExtra buffer: " + values.buffer + " minutes" +
      "\n\nThis calculation uses your estimated journey duration. Check Google Maps for live traffic and updated travel times.";
  }

  function openDirections() {
    const values = commuteValues();
    const output = $("#v4-commute-result");

    if (values.error) {
      if (output) output.textContent = values.error;
      return;
    }

    const url =
      "https://www.google.com/maps/dir/?api=1" +
      "&destination=" + encodeURIComponent(values.destination) +
      "&travelmode=driving";

    window.open(url, "_blank", "noopener,noreferrer");
  }

  /* ----------------------------------------------------------
     9. V4 BUTTON HANDLING
     ---------------------------------------------------------- */

  document.addEventListener("click", event => {
    const button = event.target.closest("[data-v4]");
    if (!button || !button.closest("#" + ID)) return;

    const action = button.dataset.v4;

    if (action === "briefing") {
      refreshAllDisplays();
    }

    if (action === "refresh") {
      refreshConnectedServices();
    }

    if (action === "meeting-route") {
      useExistingMeetingAction("route");
    }

    if (action === "meeting-departure") {
      useExistingMeetingAction("departure");
    }

    if (action === "calculate") {
      calculateDeparture();
    }

    if (action === "directions") {
      openDirections();
    }
  });

  /* ----------------------------------------------------------
     10. SAFE STARTUP AND PAGE RECOVERY
     No MutationObserver.
     No repeated input rebuilding.
     ---------------------------------------------------------- */

  function start() {
    mount();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }

  document.addEventListener("click", event => {
    if (event.target.closest("#morni-services-button")) {
      setTimeout(mount, 200);
      setTimeout(mount, 600);
    }
  }, true);

  // Only checks for the panel when it is actually visible.
  // Existing form values are never rebuilt by this timer.
  setInterval(() => {
    const panel = $("#morni-services-panel");

    if (!panel || !isVisible(panel)) return;

    mount();
    refreshAllDisplays();
  }, 12000);

window.MORNI_V4 = {
    version: "4.0",
    refresh: refreshAllDisplays,
    refreshConnectedServices,
    updateBriefing,
    updateMeetings,
    calculateDeparture,
    openDirections,
    mount: start
};

  console.log("MORNI V4 Connected Intelligence loaded.");
})();

/* ============================================================
   MORNI V4 — CONNECTED MORNING INTELLIGENCE
   Append at the absolute bottom of app.js.
   Preserves the original Services and Meeting Assistant.
   ============================================================ */

(() => {
  "use strict";

  if (window.__MORNI_V4_INSTALLED__) return;
  window.__MORNI_V4_INSTALLED__ = true;

  const BRIDGE = window.MORNI_V4_BRIDGE;
  const PANEL_ID = "morni-v4-dashboard";
  const STYLE_ID = "morni-v4-styles";

  let currentLocation = null;
  let currentWeather = null;
  let weatherBusy = false;

  const $ = (selector, root = document) =>
    root.querySelector(selector);

  const escapeHTML = value =>
    String(value ?? "").replace(/[&<>"']/g, char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[char]);

  function getMeetings() {
    try {
      const meetings = BRIDGE?.getMeetings?.();
      return Array.isArray(meetings) ? meetings : [];
    } catch (error) {
      console.error("MORNI V4 meetings:", error);
      return [];
    }
  }

  function getNextMeeting() {
    const now = Date.now();

    return getMeetings()
      .filter(meeting => {
        const time = new Date(meeting.startAt).getTime();
        return Number.isFinite(time) && time >= now;
      })
      .sort((a, b) =>
        new Date(a.startAt) - new Date(b.startAt)
      )[0] || null;
  }

  function getGmailSummary() {
    const list = $("#ms-gmail-list");

    if (!list) {
      return {
        count: 0,
        text: "Gmail information is not currently visible."
      };
    }

    const text = (list.innerText || "").trim();

    const items = list.querySelectorAll(
      ".ms-list-item, [data-email], .email-item"
    );

    return {
      count: items.length,
      text: text.slice(0, 1800)
    };
  }

  function getNewsSummary() {
    const news = $("#ms-news");
    return news ? (news.innerText || "").trim().slice(0, 1200) : "";
  }

  function getMeetingTime(meeting) {
    return new Date(meeting.startAt).toLocaleString([], {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit"
    });
  }

  function addStyles() {
    if ($("#" + STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;

    style.textContent = `
      #${PANEL_ID} {
        margin: 24px 0;
        color: var(--text, inherit);
        font-family: inherit;
      }

      #${PANEL_ID} * { box-sizing: border-box; }

      #${PANEL_ID} .mi4-heading {
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:14px;
        flex-wrap:wrap;
        margin-bottom:18px;
      }

      #${PANEL_ID} .mi4-kicker {
        color:#bd823d;
        font-size:11px;
        font-weight:800;
        letter-spacing:2px;
      }

      #${PANEL_ID} h2 {
        margin:5px 0;
        font-size:clamp(22px,3vw,30px);
      }

      #${PANEL_ID} .mi4-muted {
        opacity:.72;
        font-size:13px;
        line-height:1.6;
      }

      #${PANEL_ID} .mi4-grid {
        display:grid;
        grid-template-columns:repeat(2,minmax(0,1fr));
        gap:15px;
      }

      #${PANEL_ID} .mi4-card {
        min-width:0;
        padding:19px;
        border:1px solid rgba(150,150,150,.2);
        border-radius:18px;
        background:var(--card-bg,rgba(255,255,255,.045));
      }

      #${PANEL_ID} .mi4-wide { grid-column:1/-1; }

      #${PANEL_ID} .mi4-card h3 {
        margin:0 0 10px;
        font-size:16px;
      }

      #${PANEL_ID} .mi4-value {
        font-size:15px;
        line-height:1.7;
        white-space:pre-wrap;
        overflow-wrap:anywhere;
      }

      #${PANEL_ID} .mi4-weather-temp {
        font-size:32px;
        font-weight:800;
        margin:8px 0;
      }

      #${PANEL_ID} .mi4-button {
        border:0;
        border-radius:11px;
        padding:11px 15px;
        margin:7px 6px 0 0;
        cursor:pointer;
        background:#bd823d;
        color:white;
        font-weight:750;
        font-size:13px;
      }

      #${PANEL_ID} .mi4-button.secondary {
        background:rgba(150,150,150,.17);
        color:inherit;
        border:1px solid rgba(150,150,150,.2);
      }

      #${PANEL_ID} .mi4-input {
        width:100%;
        min-width:0;
        padding:12px;
        margin:6px 0;
        border-radius:10px;
        border:1px solid rgba(150,150,150,.3);
        background:var(--input-bg,rgba(120,120,120,.1));
        color:inherit;
        font:inherit;
      }

      #${PANEL_ID} .mi4-status {
        font-size:12px;
        opacity:.72;
        margin-top:9px;
        line-height:1.5;
      }

      #${PANEL_ID} .mi4-meeting {
        padding:12px 0;
        border-bottom:1px solid rgba(150,150,150,.18);
      }

      #${PANEL_ID} .mi4-meeting:last-child {
        border-bottom:0;
      }

      @media(max-width:650px) {
        #${PANEL_ID} .mi4-grid {
          grid-template-columns:1fr;
        }
        #${PANEL_ID} .mi4-wide {
          grid-column:auto;
        }
      }
    `;

    document.head.appendChild(style);
  }

  function buildDashboard() {
    const page = document.querySelector(
      "#morni-services-panel .ms-page"
    ) || [...document.querySelectorAll(".ms-page")]
      .find(element => element.querySelector("#ms-gmail-list"));

    if (!page) return false;

    if ($("#" + PANEL_ID)) return true;

    const dashboard = document.createElement("section");
    dashboard.id = PANEL_ID;

    dashboard.innerHTML = `
      <div class="mi4-heading">
        <div>
          <div class="mi4-kicker">MORNI INTELLIGENCE · V4</div>
          <h2>Your morning, intelligently organised.</h2>
          <div class="mi4-muted">
            Your meetings, inbox, weather and journey — in one place.
          </div>
        </div>
        <button class="mi4-button" data-mi4="refresh">
          Refresh intelligence
        </button>
      </div>

      <div class="mi4-grid">

        <section class="mi4-card mi4-wide">
          <h3>✦ Your Morning Briefing</h3>
          <div id="mi4-briefing" class="mi4-value">
            Preparing your morning briefing...
          </div>
          <div class="mi4-status" id="mi4-briefing-status">
            Uses information currently available in MORNI.
          </div>
        </section>

        <section class="mi4-card">
          <h3>☀ Live Weather</h3>
          <div id="mi4-weather">
            <div class="mi4-value">Location needed to load local weather.</div>
          </div>
          <button class="mi4-button" data-mi4="location">
            Find my location
          </button>
          <button class="mi4-button secondary" data-mi4="weather">
            Refresh weather
          </button>
        </section>

        <section class="mi4-card">
          <h3>◷ Next Meeting</h3>
          <div id="mi4-next-meeting" class="mi4-value">
            Checking your meeting schedule...
          </div>
          <button class="mi4-button secondary" data-mi4="meeting-route">
            Open meeting directions
          </button>
        </section>

        <section class="mi4-card mi4-wide">
          <h3>⌖ Smart Commute Planner</h3>
          <div class="mi4-muted">
            Plan your departure using your saved meeting time,
            estimated journey duration and preparation buffer.
          </div>
          <input class="mi4-input" id="mi4-destination"
            placeholder="Meeting destination">
          <input class="mi4-input" id="mi4-travel"
            type="number" min="1" max="600" value="30"
            placeholder="Estimated travel time in minutes">
          <input class="mi4-input" id="mi4-buffer"
            type="number" min="0" max="240" value="15"
            placeholder="Extra buffer in minutes">
          <div id="mi4-departure" class="mi4-value">
            Select a meeting to calculate your departure.
          </div>
          <button class="mi4-button" data-mi4="calculate">
            Calculate departure
          </button>
          <button class="mi4-button secondary" data-mi4="directions">
            Get Google Maps directions
          </button>
          <div class="mi4-status">
            Travel duration is your estimate. Google Maps provides
            route information; this calculation does not independently
            verify live traffic.
          </div>
        </section>

        <section class="mi4-card">
          <h3>✉ Inbox Overview</h3>
          <div id="mi4-inbox" class="mi4-value">
            Checking available inbox information...
          </div>
          <button class="mi4-button secondary" data-mi4="inbox">
            Refresh Gmail
          </button>
        </section>

        <section class="mi4-card">
          <h3>▤ News Snapshot</h3>
          <div id="mi4-news" class="mi4-value">
            Checking your Services news feed...
          </div>
          <button class="mi4-button secondary" data-mi4="news">
            Refresh news
          </button>
        </section>

      </div>
    `;

    const hero = $(".ms-hero", page);

    if (hero) {
      hero.insertAdjacentElement("afterend", dashboard);
    } else {
      page.prepend(dashboard);
    }

    return true;
  }

  function renderMeetings() {
    const meeting = getNextMeeting();
    const output = $("#mi4-next-meeting");
    if (!output) return;

    if (!meeting) {
      output.textContent = "No upcoming meetings found in your saved schedule.";
      return;
    }

    output.innerHTML = `
      <strong>${escapeHTML(meeting.title || "Scheduled meeting")}</strong>
      <br>${escapeHTML(getMeetingTime(meeting))}
      <br>📍 ${escapeHTML(meeting.venue || "No destination provided")}
    `;

    const destination = $("#mi4-destination");
    const travel = $("#mi4-travel");
    const buffer = $("#mi4-buffer");

    if (destination && !destination.value && meeting.venue) {
      destination.value = meeting.venue;
    }

    if (travel && meeting.travelMinutes != null) {
      travel.value = meeting.travelMinutes;
    }

    if (buffer && meeting.bufferMinutes != null) {
      buffer.value = meeting.bufferMinutes;
    }
  }

  function renderInbox() {
    const output = $("#mi4-inbox");
    if (!output) return;

    const summary = getGmailSummary();

    output.textContent = summary.count
      ? `${summary.count} visible email items.\n\n${summary.text.slice(0, 500)}`
      : summary.text;
  }

  function renderNews() {
    const output = $("#mi4-news");
    if (!output) return;

    const news = getNewsSummary();

    output.textContent = news
      ? news.slice(0, 650)
      : "No news headlines are currently visible. Load news in the Daily News card.";
  }

  function renderBriefing() {
    const output = $("#mi4-briefing");
    if (!output) return;

    const meeting = getNextMeeting();
    const inbox = getGmailSummary();
    const news = getNewsSummary();

    const parts = [];

    const hour = new Date().getHours();
    parts.push(
      hour < 12 ? "Good morning!" :
      hour < 17 ? "Good afternoon!" : "Good evening!"
    );

    if (meeting) {
      parts.push(
        `Your next meeting is "${meeting.title || "Scheduled meeting"}" at ${getMeetingTime(meeting)}.`
      );

      if (meeting.venue) {
        parts.push(`Your meeting destination is ${meeting.venue}.`);
      }
    } else {
      parts.push("There are no upcoming meetings in your saved schedule.");
    }

    if (inbox.count) {
      parts.push(
        `MORNI can currently see ${inbox.count} visible email items in your inbox panel.`
      );
    } else {
      parts.push(
        "Your inbox summary is limited until Gmail is connected and its messages are loaded."
      );
    }

    if (currentWeather) {
      parts.push(
        `Current local weather: ${currentWeather.temperature}°C, ${currentWeather.description}.`
      );
      parts.push(currentWeather.advice);
    } else {
      parts.push("Share your location to include local weather advice.");
    }

    if (news) {
      const firstHeadline = news.split("\n").map(x => x.trim()).find(Boolean);
      if (firstHeadline) {
        parts.push(`Your news feed currently includes: ${firstHeadline.slice(0, 180)}.`);
      }
    } else {
      parts.push("Load Daily News to include local headlines in your briefing.");
    }

    output.textContent = parts.join("\n\n");
  }

  function weatherDescription(code) {
    if (code === 0) return "Clear sky";
    if ([1, 2].includes(code)) return "Mainly clear or partly cloudy";
    if (code === 3) return "Overcast";
    if ([45, 48].includes(code)) return "Foggy";
    if ([51, 53, 55, 56, 57].includes(code)) return "Drizzle";
    if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "Rain";
    if ([71, 73, 75, 77, 85, 86].includes(code)) return "Snow";
    if ([95, 96, 99].includes(code)) return "Thunderstorms";
    return "Variable conditions";
  }

  function weatherAdvice(code, temperature) {
    const advice = [];

    if ([61,63,65,80,81,82,95,96,99].includes(code)) {
      advice.push("Rain is possible. Consider carrying an umbrella.");
    }

    if (temperature >= 32) {
      advice.push("It may feel hot. Stay hydrated.");
    } else if (temperature <= 18) {
      advice.push("Consider carrying a light layer.");
    }

    return advice.join(" ") || "Check conditions again before heading out.";
  }

  async function loadWeather() {
    if (!currentLocation || weatherBusy) return;

    weatherBusy = true;
    const output = $("#mi4-weather");
    if (output) output.textContent = "Loading local weather...";

    try {
      const { latitude, longitude } = currentLocation;

      const url = new URL("https://api.open-meteo.com/v1/forecast");
      url.search = new URLSearchParams({
        latitude,
        longitude,
        current: "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m"
      }).toString();

      const response = await fetch(url);
      if (!response.ok) throw new Error("Weather service unavailable");

      const data = await response.json();
      const current = data.current;

      currentWeather = {
        temperature: Math.round(current.temperature_2m),
        description: weatherDescription(current.weather_code),
        advice: weatherAdvice(
          current.weather_code,
          current.temperature_2m
        )
      };

      if (output) {
        output.innerHTML = `
          <div class="mi4-weather-temp">
            ${currentWeather.temperature}°C
          </div>
          <strong>${escapeHTML(currentWeather.description)}</strong>
          <div class="mi4-muted">
            Feels like ${Math.round(current.apparent_temperature)}°C
            · Humidity ${current.relative_humidity_2m}%
            · Wind ${Math.round(current.wind_speed_10m)} km/h
          </div>
          <p>${escapeHTML(currentWeather.advice)}</p>
        `;
      }

      renderBriefing();
    } catch (error) {
      console.error("MORNI V4 weather:", error);
      if (output) {
        output.textContent = "Weather could not load. Please try again.";
      }
    } finally {
      weatherBusy = false;
    }
  }

  function locate() {
    if (!navigator.geolocation) {
      alert("Location is not supported by this browser.");
      return;
    }

    const output = $("#mi4-weather");
    if (output) output.textContent = "Requesting location permission...";

    navigator.geolocation.getCurrentPosition(
      position => {
        currentLocation = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude
        };

        loadWeather();
      },
      error => {
        console.warn("MORNI V4 location:", error);
        if (output) {
          output.textContent =
            "Location permission was unavailable. Check browser location permissions and try again.";
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 300000
      }
    );
  }

  function calculateDeparture() {
    const meeting = getNextMeeting();
    const result = $("#mi4-departure");

    if (!meeting) {
      if (result) result.textContent = "No upcoming meeting is available.";
      return;
    }

    const destination = ($("#mi4-destination")?.value || "").trim();
    const travel = Number($("#mi4-travel")?.value);
    const buffer = Number($("#mi4-buffer")?.value);

    if (!destination) {
      if (result) result.textContent = "Enter the meeting destination first.";
      return;
    }

    if (!Number.isFinite(travel) || travel < 1 ||
        !Number.isFinite(buffer) || buffer < 0) {
      if (result) result.textContent = "Enter valid travel and buffer times.";
      return;
    }

    const meetingTime = new Date(meeting.startAt);
    const departure = new Date(
      meetingTime.getTime() - (travel + buffer) * 60000
    );

    if (result) {
      result.textContent =
        `Meeting: ${getMeetingTime(meeting)}\n` +
        `Estimated travel: ${travel} minutes\n` +
        `Preparation buffer: ${buffer} minutes\n\n` +
        `Suggested departure: ${departure.toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit"
        })}`;
    }
  }

  function openDirections() {
    const destination = ($("#mi4-destination")?.value || "").trim();

    if (!destination) {
      alert("Enter a destination first.");
      return;
    }

    const url = new URL("https://www.google.com/maps/dir/");
    url.searchParams.set("api", "1");
    url.searchParams.set("destination", destination);

    if (currentLocation) {
      url.searchParams.set(
        "origin",
        `${currentLocation.latitude},${currentLocation.longitude}`
      );
    }

    url.searchParams.set("travelmode", "driving");
    window.open(url.toString(), "_blank", "noopener");
  }

  function refresh() {
    renderMeetings();
    renderInbox();
    renderNews();
    renderBriefing();
    calculateDeparture();
  }

  function handleClick(event) {
    const button = event.target.closest("[data-mi4]");
    if (!button || !button.closest("#" + PANEL_ID)) return;

    const action = button.dataset.mi4;

    if (action === "refresh") {
      refresh();
    }

    if (action === "location") {
      locate();
    }

    if (action === "weather") {
      if (!currentLocation) locate();
      else loadWeather();
    }

    if (action === "calculate") {
      calculateDeparture();
    }

    if (action === "directions" || action === "meeting-route") {
      const meeting = getNextMeeting();

      if (action === "meeting-route" && meeting?.venue) {
        const destination = $("#mi4-destination");
        if (destination) destination.value = meeting.venue;
      }

      openDirections();
    }

    if (action === "inbox") {
      const status = $("#mi4-inbox");
      if (status) status.textContent = "Refreshing Gmail...";
      Promise.resolve(BRIDGE?.refreshInbox?.())
        .then(() => {
          renderInbox();
          renderBriefing();
        })
        .catch(error => {
          console.error("MORNI V4 Gmail:", error);
          renderInbox();
        });
    }

    if (action === "news") {
      const newsButton = $("#morni-services-panel [data-action='news']");
      if (newsButton) newsButton.click();
      setTimeout(() => {
        renderNews();
        renderBriefing();
      }, 1800);
    }
  }

  function initialise() {
    addStyles();

    if (!buildDashboard()) return;

    refresh();

    if (!document.__MORNI_V4_CLICK_HANDLER__) {
      document.addEventListener("click", handleClick);
      document.__MORNI_V4_CLICK_HANDLER__ = true;
    }
  }

  // Wait for the original Services interface to become available.
  // No global MutationObserver and no rapid polling loop.
  document.addEventListener("click", () => {
    setTimeout(initialise, 250);
  }, true);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialise, {
      once: true
    });
  } else {
    initialise();
  }
})();


/* =========================================================
   MORNI — V4 RECOVERY PANEL
   Uses the verified Services bridge.
   Safe, independent of older V3/V4 dashboard code.
   ========================================================= */
(() => {
  "use strict";

  if (window.__MORNI_V4_RECOVERY__) return;
  window.__MORNI_V4_RECOVERY__ = true;

  const BRIDGE = window.MORNI_V4_BRIDGE;
  const PANEL_ID = "morni-v4-recovery";

  const style = document.createElement("style");
  style.textContent = `
    #${PANEL_ID} {
      margin: 22px 0;
      padding: 22px;
      border-radius: 22px;
      background: linear-gradient(135deg,#102b22,#183d2e);
      color: #f4fff7;
      border: 1px solid rgba(160,220,170,.2);
      box-shadow: 0 12px 35px rgba(0,0,0,.16);
      font-family: inherit;
    }
    #${PANEL_ID} * { box-sizing: border-box; }
    #${PANEL_ID} .m4-heading {
      font-size: 21px; font-weight: 800; margin-bottom: 5px;
    }
    #${PANEL_ID} .m4-sub {
      color: #b8d8c2; font-size: 13px; margin-bottom: 18px;
    }
    #${PANEL_ID} .m4-grid {
      display: grid; grid-template-columns: repeat(2,minmax(0,1fr));
      gap: 12px;
    }
    #${PANEL_ID} .m4-card {
      min-width: 0; padding: 16px; border-radius: 16px;
      background: rgba(255,255,255,.075);
      border: 1px solid rgba(255,255,255,.09);
    }
    #${PANEL_ID} .m4-label {
      color: #b9d9c2; font-size: 11px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .8px;
      margin-bottom: 9px;
    }
    #${PANEL_ID} .m4-value {
      font-size: 16px; font-weight: 750; line-height: 1.4;
      overflow-wrap: anywhere;
    }
    #${PANEL_ID} .m4-detail {
      color: #c7ddcd; font-size: 12px; margin-top: 6px;
      line-height: 1.5;
    }
    #${PANEL_ID} .m4-actions {
      display: flex; flex-wrap: wrap; gap: 9px; margin-top: 15px;
    }
    #${PANEL_ID} button, #${PANEL_ID} a {
      border: 0; border-radius: 11px; padding: 10px 14px;
      background: #b9e76b; color: #17301f; font-weight: 750;
      font-size: 12px; text-decoration: none; cursor: pointer;
    }
    #${PANEL_ID} button.secondary {
      background: rgba(255,255,255,.12); color: white;
      border: 1px solid rgba(255,255,255,.15);
    }
    @media(max-width:520px) {
      #${PANEL_ID} { padding: 16px; }
      #${PANEL_ID} .m4-grid { grid-template-columns: 1fr; }
    }
  `;
  document.head.appendChild(style);

  const getMeetings = () => {
    try {
      const result = BRIDGE.getMeetings();
      return Array.isArray(result) ? result : [];
    } catch (error) {
      console.error("MORNI: Meeting read failed", error);
      return [];
    }
  };

  const getNextMeeting = () => {
    const now = Date.now();
    return getMeetings()
      .map(m => ({ ...m, _date: new Date(m.startAt) }))
      .filter(m => m.startAt && !isNaN(m._date.getTime()) && m._date.getTime() > now)
      .sort((a, b) => a._date - b._date)[0] || null;
  };

  const formatDate = date =>
    date.toLocaleString([], {
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit"
    });

  function mount() {
    const page = document.querySelector("#pageContent .ms-page");
    if (!page || !page.querySelector("#ms-gmail-list")) return;

    // The pageContent observer also sees text updates inside this panel.
    // Do not update an existing panel from the observer callback: that would
    // retrigger the observer continuously and freeze the Services page.
    if (page.querySelector("#" + PANEL_ID)) return;

    const panel = document.createElement("section");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="m4-heading">☀️ MORNI Morning Intelligence</div>
      <div class="m4-sub">Your day, organised in one place.</div>
      <div class="m4-grid">
        <div class="m4-card">
          <div class="m4-label">📅 Next meeting</div>
          <div class="m4-value" id="m4-meeting">Checking your schedule...</div>
          <div class="m4-detail" id="m4-meeting-detail"></div>
        </div>
        <div class="m4-card">
          <div class="m4-label">✉️ Gmail inbox</div>
          <div class="m4-value" id="m4-inbox">Checking inbox...</div>
          <div class="m4-detail">Updates from your connected Gmail inbox</div>
        </div>
        <div class="m4-card">
          <div class="m4-label">🌤️ Local weather</div>
          <div class="m4-value" id="m4-weather">Location not checked</div>
          <div class="m4-detail" id="m4-weather-detail">Use the button below to get local weather</div>
        </div>
        <div class="m4-card">
          <div class="m4-label">🚗 Smart commute</div>
          <div class="m4-value" id="m4-commute">Waiting for meeting details</div>
          <div class="m4-detail" id="m4-commute-detail">Departure time will be calculated from your next meeting</div>
        </div>
      </div>
      <div class="m4-actions">
        <button id="m4-refresh">↻ Refresh briefing</button>
        <button class="secondary" id="m4-weather-button">Get local weather</button>
        <button class="secondary" id="m4-route" style="display:none">Open directions ↗</button>
      </div>
      <div class="m4-detail" id="m4-status" aria-live="polite"></div>
    `;

    const hero = page.querySelector(".ms-hero");
    if (hero) hero.insertAdjacentElement("afterend", panel);
    else page.prepend(panel);

    panel.querySelector("#m4-refresh").addEventListener("click", async () => {
      panel.querySelector("#m4-status").textContent = "Refreshing your briefing...";
      try {
        await BRIDGE.refreshInbox();
      } catch (error) {
        console.error("MORNI: Inbox refresh failed", error);
      }
      setTimeout(update, 900);
    });

    panel.querySelector("#m4-weather-button").addEventListener("click", loadWeather);
    panel.querySelector("#m4-route").addEventListener("click", () => {
      const meeting = getNextMeeting();
      if (!meeting || !meeting.venue) return;
      const url = "https://www.google.com/maps/dir/?api=1&destination="
        + encodeURIComponent(meeting.venue);
      window.open(url, "_blank", "noopener");
    });

    update();
  }

  function update() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    const meeting = getNextMeeting();
    const meetingEl = panel.querySelector("#m4-meeting");
    const meetingDetail = panel.querySelector("#m4-meeting-detail");
    const commute = panel.querySelector("#m4-commute");
    const commuteDetail = panel.querySelector("#m4-commute-detail");
    const routeButton = panel.querySelector("#m4-route");

    if (meeting) {
      meetingEl.textContent = meeting.title || "Upcoming meeting";
      meetingDetail.textContent =
        formatDate(meeting._date) +
        (meeting.venue ? " · " + meeting.venue : "");

      const travel = Math.max(0, Number(meeting.travelMinutes) || 30);
      const buffer = Math.max(0, Number(meeting.bufferMinutes) || 15);
      const departure = new Date(meeting._date.getTime() - (travel + buffer) * 60000);

      commute.textContent = "Leave by " +
        departure.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      commuteDetail.textContent =
        travel + " min estimated travel + " + buffer + " min buffer";

      routeButton.style.display = meeting.venue ? "" : "none";
    } else {
      meetingEl.textContent = "No upcoming meetings";
      meetingDetail.textContent = "Your schedule is clear.";
      commute.textContent = "No commute needed";
      commuteDetail.textContent = "No upcoming meeting found.";
      routeButton.style.display = "none";
    }

    const gmail = panel.querySelector("#m4-inbox");
    const list = document.querySelector("#ms-gmail-list");
    if (list) {
      const count = list.querySelectorAll(":scope > *").length;
      gmail.textContent = count + (count === 1 ? " visible email" : " visible emails");
    } else {
      gmail.textContent = "Inbox information unavailable";
    }

    panel.querySelector("#m4-status").textContent =
      "Briefing updated " + new Date().toLocaleTimeString([], {
        hour: "numeric", minute: "2-digit"
      });
  }

  function loadWeather() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    const weather = panel.querySelector("#m4-weather");
    const detail = panel.querySelector("#m4-weather-detail");

    if (!navigator.geolocation) {
      weather.textContent = "Location unavailable";
      detail.textContent = "Your browser does not support location access.";
      return;
    }

    weather.textContent = "Finding your location...";
    detail.textContent = "Please allow location access in your browser.";

    navigator.geolocation.getCurrentPosition(async position => {
      try {
        const { latitude, longitude } = position.coords;
        const url = "https://api.open-meteo.com/v1/forecast?latitude="
          + latitude + "&longitude=" + longitude
          + "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m";

        const response = await fetch(url);
        if (!response.ok) throw new Error("Weather request failed");
        const data = await response.json();
        const current = data.current;

        const descriptions = {
          0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy",
          3: "Overcast", 45: "Foggy", 48: "Foggy",
          51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
          61: "Light rain", 63: "Rain", 65: "Heavy rain",
          71: "Light snow", 73: "Snow", 75: "Heavy snow",
          80: "Rain showers", 81: "Rain showers", 82: "Heavy showers",
          95: "Thunderstorm", 96: "Thunderstorm", 99: "Thunderstorm"
        };

        weather.textContent = Math.round(current.temperature_2m) + "°C · " +
          (descriptions[current.weather_code] || "Current conditions");
        detail.textContent = "Feels like " +
          Math.round(current.apparent_temperature) + "°C · Wind " +
          Math.round(current.wind_speed_10m) + " km/h";
      } catch (error) {
        weather.textContent = "Weather unavailable";
        detail.textContent = "Please try again in a moment.";
        console.error("MORNI weather:", error);
      }
    }, error => {
      weather.textContent = "Location permission needed";
      detail.textContent = "Allow location access and try again.";
    }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 });
  }

  // Wait for the real Services page, wherever the app renders it.
  function start() {
    mount();

    const host = document.getElementById("pageContent");
    if (!host || window.__MORNI_V4_RECOVERY_OBSERVER__) return;

    const observer = new MutationObserver(() => mount());
    observer.observe(host, { childList: true, subtree: true });
    window.__MORNI_V4_RECOVERY_OBSERVER__ = observer;
  }

  window.MORNI_V4_RECOVERY = { mount, update, loadWeather };
  start();
})();


/* =====================================================
   MORNI — DASHBOARD RECOVERY PATCH
   Independent mount system. Preserves existing features.
   ===================================================== */
(() => {
  "use strict";

  if (window.MORNI_DASHBOARD_RECOVERY) return;

  const DASHBOARD_ID = "morni-recovery-dashboard";
  let observer = null;

  function getPage() {
    return document.querySelector(
      "#pageContent .ms-page"
    );
  }

  function getMeetings() {
    try {
      const result = window.MORNI_V4_BRIDGE?.getMeetings?.();
      return Array.isArray(result) ? result : [];
    } catch (error) {
      console.warn("MORNI meetings unavailable:", error);
      return [];
    }
  }

  function makeDashboard() {
    const dashboard = document.createElement("section");
    dashboard.id = DASHBOARD_ID;

    dashboard.style.cssText = `
      margin:24px 0;
      padding:22px;
      border-radius:20px;
      background:linear-gradient(135deg,#123d2c,#1d6545);
      color:white;
      font-family:inherit;
      box-shadow:0 10px 30px rgba(0,0,0,.15);
    `;

    dashboard.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap">
        <div>
          <div style="font-size:12px;letter-spacing:2px;opacity:.8">MORNI INTELLIGENCE</div>
          <h2 style="margin:6px 0;font-size:25px">Your day, made smarter.</h2>
          <div style="opacity:.8;font-size:13px">Your connected morning overview</div>
        </div>
        <button id="morni-recovery-refresh" style="border:0;border-radius:12px;padding:11px 16px;background:#f4a340;color:#182d20;font-weight:700;cursor:pointer">
          Refresh
        </button>
      </div>
      <div id="morni-recovery-content" style="margin-top:20px">
        Loading your day...
      </div>
    `;

    dashboard.querySelector("#morni-recovery-refresh")
      .addEventListener("click", updateDashboard);

    return dashboard;
  }

  function updateDashboard() {
    const content = document.getElementById("morni-recovery-content");
    if (!content) return;

    const meetings = getMeetings()
      .filter(item => item && item.startAt)
      .map(item => ({ ...item, date: new Date(item.startAt) }))
      .filter(item => !Number.isNaN(item.date.getTime()) && item.date >= new Date())
      .sort((a, b) => a.date - b.date);

    const next = meetings[0];

    const meetingHTML = next
      ? `<div style="font-size:12px;opacity:.75">NEXT MEETING</div>
         <div style="font-size:20px;font-weight:700;margin:5px 0">${escapeHTML(next.title || "Upcoming meeting")}</div>
         <div>${escapeHTML(next.date.toLocaleString())}</div>
         <div style="opacity:.8;margin-top:4px">${escapeHTML(next.venue || "Location not specified")}</div>
         <button id="morni-recovery-route" style="margin-top:12px;border:0;border-radius:10px;padding:10px 14px;background:#f4a340;color:#182d20;font-weight:700;cursor:pointer">Open directions</button>`
      : `<div style="font-size:18px;font-weight:700">No upcoming meetings found</div>
         <div style="opacity:.8;margin-top:5px">Your schedule is clear for now.</div>`;

    content.innerHTML = `
      <div style="padding:17px;border-radius:15px;background:rgba(255,255,255,.1)">
        ${meetingHTML}
      </div>
      <div style="margin-top:12px;font-size:12px;opacity:.7">
        ${meetings.length} upcoming meeting(s) detected
      </div>
    `;

    const routeButton = content.querySelector("#morni-recovery-route");
    if (routeButton && next?.venue) {
      routeButton.addEventListener("click", () => {
        const destination = encodeURIComponent(next.venue);
        window.open(
          "https://www.google.com/maps/dir/?api=1&destination=" + destination,
          "_blank",
          "noopener"
        );
      });
    }
  }

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[char]);
  }

  function mount() {
    const page = getPage();
    if (!page || page.querySelector("#" + DASHBOARD_ID)) return;

    const hero = page.querySelector(".ms-hero");
    const dashboard = makeDashboard();

    if (hero) {
      hero.insertAdjacentElement("afterend", dashboard);
    } else {
      page.prepend(dashboard);
    }

    updateDashboard();
  }

  function start() {
    mount();

    const target = document.getElementById("pageContent") || document.body;

    if (!observer) {
      observer = new MutationObserver(() => mount());
      observer.observe(target, { childList: true, subtree: true });
    }
  }

  window.MORNI_DASHBOARD_RECOVERY = {
    mount,
    refresh: updateDashboard,
    getMeetings
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
   
  function updateGmailVisibility() {
    const page = getPage();
    if (!page) return;

    const gmailList = page.querySelector("#ms-gmail-list");
    if (!gmailList) return;

    const gmailCard =
      gmailList.closest(".ms-card") ||
      gmailList.closest(".ms-section") ||
      gmailList.parentElement;

    if (!gmailCard) return;

    const hasInboxContent =
      gmailList.children.length > 0 &&
      gmailList.textContent.trim().length > 0;

    const connected = hasInboxContent &&
      !/connect gmail|not connected|sign in to gmail/i.test(
        gmailList.textContent
      );

    gmailCard.style.display = connected ? "" : "none";
  }

  const gmailObserver = new MutationObserver(updateGmailVisibility);

  function watchGmail() {
    const page = getPage();
    const gmailList = page?.querySelector("#ms-gmail-list");

    if (gmailList) {
      gmailObserver.observe(gmailList, {
        childList: true,
        subtree: true,
        characterData: true
      });
      updateGmailVisibility();
    }
  }

})();



/* ============================================================
   MORNI USB HARDWARE BRIDGE
   GitHub Pages (HTTPS) -> Chrome Web Serial -> ESP8266 USB
   Keeps laptop internet on SNIT; ESP8266 does not join Wi-Fi.
   ============================================================ */
(() => {
  "use strict";
  if (window.__MORNI_USB_BRIDGE_INSTALLED__) return;
  window.__MORNI_USB_BRIDGE_INSTALLED__ = true;

  const STORE = "morni_usb_reminders_v1";
  let port = null, reader = null, writer = null, readTask = null;
  let buffer = "", sequence = 1, connected = false;
  const pending = new Map();
  let statusTimer = null;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
  })[c]);

  const MAX_REMINDERS = 5;

  function readReminderStore() {
    try {
      const value = JSON.parse(localStorage.getItem(STORE) || "[]");
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  function reminders() {
    const stored = readReminderStore();
    const now = Date.now();
    const active = stored.filter(item => {
      const slot = Number(item?.slot);
      const when = Date.parse(item?.when);
      return Number.isInteger(slot) && slot >= 0 && slot < MAX_REMINDERS &&
        typeof item?.text === "string" && item.text.trim().length > 0 &&
        Number.isFinite(when) && when > now;
    }).sort((a, b) => Date.parse(a.when) - Date.parse(b.when));

    if (active.length !== stored.length) {
      try { localStorage.setItem(STORE, JSON.stringify(active)); }
      catch (error) { console.warn("MORNI could not refresh its saved reminder list:", error); }
    }
    return active;
  }

  function saveReminders(items) {
    try {
      localStorage.setItem(STORE, JSON.stringify(items));
    } catch (error) {
      throw new Error("The reminder was sent to MORNI, but this browser could not save its reminder list.");
    }
  }
  function setStatus(message, good = false) {
    const el = $("morniUsbStatus");
    if (el) {
      el.textContent = message;
      el.style.color = good ? "#267344" : "#a15c22";
    }
  }
  function renderReminderList() {
    const el = $("morniUsbReminderList");
    if (!el) return;

    const items = reminders();
    const listHTML = items.length ? items.map((item, i) => `
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid #ddd">
        <span><b>${esc(item.text)}</b><br><small>${esc(new Date(item.when).toLocaleString())}</small></span>
        <button type="button" data-morni-remove="${i}" style="padding:7px 10px">Remove</button>
      </div>`).join("") : "<small>No upcoming reminders saved in this browser.</small>";

    const html = `<small style="display:block;margin-bottom:6px;opacity:.7">${items.length}/${MAX_REMINDERS} reminder slots in use</small>${listHTML}`;
    // Avoid needlessly changing the DOM: this panel is observed by the
    // Device Studio mount observer.
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  function panelHTML() {
    return `
      <section id="morniUsbPanel" style="margin:18px 0;padding:20px;border:1px solid #cbd8c7;border-radius:18px;background:var(--card-bg,#fff);color:var(--text,inherit)">
        <div style="font-size:11px;letter-spacing:2px;font-weight:800;color:#b77935">MORNI · DIRECT USB LINK</div>
        <h2 style="margin:6px 0 4px">Connect your physical station</h2>
        <p style="margin:0 0 12px;opacity:.75">Keep your laptop connected to SNIT. The ESP8266 communicates through its USB cable, not a second Wi-Fi network.</p>
        <button type="button" id="morniUsbConnect" style="padding:11px 16px;border:0;border-radius:10px;background:#347b45;color:white;font-weight:700">Connect MORNI by USB</button>
        <button type="button" id="morniUsbDisconnect" style="padding:11px 16px;border:0;border-radius:10px">Disconnect</button>
        <p id="morniUsbStatus" role="status" style="font-weight:700;margin:12px 0">Not connected. Close Arduino Serial Monitor before connecting.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0">
          <button type="button" data-morni-command="start">Wake MORNI</button>
          <button type="button" data-morni-command="paste">Start paste</button>
          <button type="button" data-morni-command="brush">Start 2-min brush</button>
          <button type="button" data-morni-command="pause">Pause</button>
          <button type="button" data-morni-command="resume">Resume</button>
          <button type="button" data-morni-command="reset">Reset</button>
          <button type="button" data-morni-display="on">LCD ON</button>
          <button type="button" data-morni-display="off">LCD OFF</button>
          <button type="button" id="morniUsbClock">Sync RTC from laptop</button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin-top:14px">
          <div style="padding:14px;border:1px solid #ddd;border-radius:12px">
            <b>LCD message</b>
            <input id="morniUsbMessage" maxlength="16" placeholder="Max 16 characters" style="display:block;width:100%;box-sizing:border-box;padding:10px;margin:8px 0">
            <button type="button" id="morniUsbSendMessage">Send to LCD</button>
          </div>
          <div style="padding:14px;border:1px solid #ddd;border-radius:12px">
            <b>Schedule a meeting / task reminder</b>
            <input id="morniUsbWhen" type="datetime-local" style="display:block;width:100%;box-sizing:border-box;padding:10px;margin:8px 0">
            <input id="morniUsbReminderText" maxlength="16" placeholder="Reminder (max 16 chars)" style="display:block;width:100%;box-sizing:border-box;padding:10px;margin:8px 0">
            <button type="button" id="morniUsbAddReminder">Save reminder to MORNI</button>
            <small style="display:block;margin-top:7px;opacity:.7">Up to 5 meeting or task reminders are stored on the ESP8266 and shown on the LCD when due.</small>
          </div>
        </div>
        <div style="margin-top:12px"><b>Upcoming reminders</b><div id="morniUsbReminderList"></div></div>
        <div id="morniUsbLive" style="margin-top:12px;padding:10px;border-radius:10px;background:rgba(80,130,80,.08)">Hardware status: waiting for connection</div>
      </section>`;
  }

  function bindConnectButton() {
    const button = $("morniUsbConnect");
    if (!button || button.dataset.morniUsbBound === "1") return;
    button.dataset.morniUsbBound = "1";

    // Attach directly to the real Device Studio button. requestPort() runs
    // synchronously in this trusted click event, before any async operation.
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (button.dataset.morniConnecting === "1" || connected) return;

      if (!window.isSecureContext) {
        setStatus("Open the MORNI GitHub Pages HTTPS site in desktop Chrome.");
        return;
      }
      if (!navigator.serial || typeof navigator.serial.requestPort !== "function") {
        setStatus("Web Serial is unavailable. Use desktop Chrome or Edge, not an embedded preview.");
        return;
      }

      let portPromise;
      try {
        // Keep this exact call directly inside the physical button click.
        portPromise = navigator.serial.requestPort();
      } catch (error) {
        setStatus("Chrome USB picker error: " + (error?.message || String(error)));
        return;
      }

      button.dataset.morniConnecting = "1";
      button.disabled = true;
      button.textContent = "Choose MORNI USB port in Chrome…";
      setStatus("Chrome should display the USB device picker. Select the USB Serial (COM) device.");

      connect(portPromise).catch(error => {
        setStatus("USB connection failed: " + (error?.message || String(error)));
      }).finally(() => {
        button.dataset.morniConnecting = "0";
        button.disabled = false;
        button.textContent = connected ? "MORNI connected" : "Connect MORNI by USB";
      });
    }, { capture: true });
  }

 
function setReminderMinimum() {
  const input = $("morniUsbWhen");
  if (!input) return;

  const localNow = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
  input.min = localNow;
}

function mount() {
  if ($("morniUsbPanel")) {
    bindConnectButton();
    setReminderMinimum();
    renderReminderList();
    return;
  }

  const heading = [...document.querySelectorAll("h1,h2")]
    .find(h => /device studio/i.test((h.textContent || "").trim()));

  if (!heading) return;

  const panel = document.createElement("div");
  panel.innerHTML = panelHTML();

  const usbPanel = panel.firstElementChild;
  heading.insertAdjacentElement("afterend", usbPanel);

  bindConnectButton();
  setReminderMinimum();
  renderReminderList();
}

  function handleLine(line) {
    if (!line.startsWith("MORNI|")) return; // Ignore ordinary boot/debug messages.
    const parts = line.split("|");
    const id = parts[1];

    if (id === "EVENT") {
      if (parts[2] === "REMINDER") {
        const slot = Number(parts[3]);
        if (Number.isInteger(slot) && slot >= 0 && slot < MAX_REMINDERS) {
          const remaining = readReminderStore().filter(item => Number(item?.slot) !== slot);
          try { saveReminders(remaining); } catch (error) {
            console.warn("MORNI could not update the local reminder list:", error);
          }
          renderReminderList();
        }
        setStatus("A scheduled reminder was displayed on the LCD.", true);
      }
      return;
    }
    if (id === "READY") {
      setStatus("MORNI is ready over USB.", true);
      return;
    }
    const task = pending.get(id);
    if (!task) return;

    pending.delete(id);
    clearTimeout(task.timeout);
    if (parts[2] === "ERR") task.reject(new Error(parts.slice(3).join("|") || "ESP8266 error"));
    else if (parts[2] === "STATUS") {
      task.resolve({
        time: parts[3], timer: parts[4], state: parts[5],
        rtc: parts[6] === "1", lcd: parts[7] === "1", brush: parts[8] === "1"
      });
    } else task.resolve(parts.slice(2));
  }

  async function readLoop() {
    const decoder = new TextDecoder();
    try {
      while (connected && port && port.readable) {
        reader = port.readable.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) {
              if (connected) throw new Error("The USB serial stream closed unexpectedly.");
              break;
            }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || "";
            lines.forEach(line => handleLine(line.trim()));
          }
        } finally {
          reader.releaseLock();
          reader = null;
        }
      }
    } catch (error) {
      if (connected) {
        connected = false;
        clearInterval(statusTimer);

        for (const [id, task] of pending) {
          clearTimeout(task.timeout);
          task.reject(new Error("USB connection lost."));
          pending.delete(id);
        }

        try { if (writer) writer.releaseLock(); } catch {}
        writer = null;
        try { if (port) await port.close(); } catch {}
        port = null;

        setStatus("USB connection lost: " + error.message);
        window.dispatchEvent(new Event("morni-usb-disconnected"));
      }
    }
  }

  async function send(op, ...args) {
    if (!connected || !writer) throw new Error("Connect MORNI by USB first.");

    const id = String(sequence++);
    const line = `REQ|${id}|${op}${args.length ? "|" + args.join("|") : ""}\n`;
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error("MORNI did not reply. Check USB cable and firmware."));
      }, 4500);
      pending.set(id, { resolve, reject, timeout });
    });

    try {
      await writer.write(new TextEncoder().encode(line));
    } catch (error) {
      const task = pending.get(id);
      if (task) {
        clearTimeout(task.timeout);
        pending.delete(id);
      }
      throw new Error("Could not write to MORNI over USB: " + (error?.message || String(error)));
    }

    return promise;
  }

  async function connect(portChoice) {
    if (!("serial" in navigator) || !navigator.serial) {
      throw new Error("Web Serial is unavailable. Use desktop Chrome or Edge on the GitHub Pages HTTPS site.");
    }
    if (!window.isSecureContext) throw new Error("Open the HTTPS GitHub Pages address, not a local HTTP copy.");
    if (connected) return;
    if (!portChoice) throw new Error("The Chrome USB picker was not opened. Click Connect MORNI by USB again.");

    try {
      // The picker promise was created directly inside the button click handler.
      port = await portChoice;
      await port.open({ baudRate: 115200 });
      writer = port.writable.getWriter();
      connected = true;
      setStatus("USB opened. Waiting for MORNI to restart…", true);
      readTask = readLoop();

      // Opening the serial port resets most NodeMCU boards. Wait for startup,
      // then prove the firmware responds before declaring the app connected.
      await new Promise(resolve => setTimeout(resolve, 2200));
      const firstStatus = await send("STATUS");
      if (firstStatus.rtc) {
        try {
          await send("CLOCK", Math.floor(Date.now() / 1000), -new Date().getTimezoneOffset() * 60);
        } catch (clockError) {
          setStatus("USB connected; RTC sync warning: " + clockError.message);
        }
      }
      await refreshStatus();
      clearInterval(statusTimer);
      statusTimer = setInterval(refreshStatus, 2500);
      setStatus("MORNI connected over USB. Laptop internet remains on SNIT.", true);
      window.dispatchEvent(new Event("morni-usb-connected"));
    } catch (error) {
      try { await disconnect(); } catch {}
      throw error;
    }
  }

  async function disconnect() {
    connected = false;
    clearInterval(statusTimer);
    for (const [id, task] of pending) {
      clearTimeout(task.timeout);
      task.reject(new Error("USB disconnected"));
      pending.delete(id);
    }
    try { if (reader) await reader.cancel(); } catch {}
    try { if (readTask) await readTask; } catch {}
    readTask = null;
    try { if (writer) { writer.releaseLock(); writer = null; } } catch {}
    try { if (port) await port.close(); } catch {}
    port = null;
    setStatus("USB disconnected.");
    window.dispatchEvent(new Event("morni-usb-disconnected"));
  }

  function parseDevicePath(path) {
    const url = new URL(String(path || "/"), "https://morni.invalid");
    return { pathname: url.pathname.replace(/\/+$/, "") || "/", query: url.searchParams };
  }

  async function request(path, options = {}) {
    if (!connected) throw new Error("MORNI USB is not connected. Connect it in Device Studio first.");
    const { pathname, query } = parseDevicePath(path);
    const leaf = pathname.split("/").pop();

    if (leaf === "status") {
      const d = await send("STATUS");
      return {
        online: true,
        hardwareReady: d.lcd === true,
        mode: "USB connected",
        time: d.time,
        timer: d.timer,
        state: d.state,
        rtcWorking: d.rtc,
        lcdEnabled: d.lcd,
        toothbrushPresent: d.brush,
        events: []
      };
    }

    if (leaf === "events") return { events: [] };

    if (leaf === "timer") {
      const cmd = (query.get("cmd") || "").toLowerCase();
      const map = { start: "brush", pause: "pause", resume: "resume", reset: "reset" };
      if (!map[cmd]) throw new Error("Unsupported MORNI timer command: " + cmd);
      return await send("COMMAND", map[cmd]);
    }

    if (leaf === "command") {
      const cmd = (query.get("cmd") || "").toLowerCase();
      if (!cmd) throw new Error("Missing MORNI command.");
      return await send("COMMAND", cmd);
    }

    if (leaf === "message") {
      const message = query.get("text") || query.get("message") || "";
      return await send("MESSAGE", message);
    }

    if (leaf === "display") {
      const value = (query.get("state") || query.get("on") || "on").toLowerCase();
      return await send("DISPLAY", value === "false" || value === "0" ? "off" : value);
    }

    if (leaf === "setclock" || leaf === "clock") {
      return await send("CLOCK", Math.floor(Date.now() / 1000), -new Date().getTimezoneOffset() * 60);
    }

    throw new Error("This website action has no USB firmware mapping: " + pathname);
  }

  async function refreshStatus() {
    try {
      const d = await send("STATUS");
      const el = $("morniUsbLive");
      if (el) el.textContent =
        `RTC ${d.rtc ? "OK" : "NOT FOUND"} · LCD ${d.lcd ? "ON" : "OFF"} · ` +
        `Time ${d.time} · Timer ${d.timer} · State ${d.state} · ` +
        `Brush ${d.brush ? "detected" : "not detected"}`;
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function run(action) {
    try {
      await action();
      setStatus("Command sent to MORNI.", true);
      await refreshStatus();
    } catch (error) {
      setStatus(error.message);
    }
  }

  document.addEventListener("click", event => {
    const t = event.target instanceof Element ? event.target : event.target?.parentElement;
    if (!t) return;
    if (t.closest("#morniUsbConnect")) return; // handled directly on the button
    else if (t.closest("#morniUsbDisconnect")) run(disconnect);
    else if (t.closest("#morniUsbClock")) run(async () => {
      await send("CLOCK", Math.floor(Date.now() / 1000), -new Date().getTimezoneOffset() * 60);
    });
    else if (t.closest("#morniUsbSendMessage")) run(async () => {
      const value = $("morniUsbMessage")?.value.trim() || "";
      if (!value || value.length > 16) throw new Error("Enter a 1-16 character LCD message.");
      await send("MESSAGE", value);
    });
    else if (t.closest("#morniUsbAddReminder")) run(async () => {
      const when = $("morniUsbWhen")?.value;
      const message = $("morniUsbReminderText")?.value.trim() || "";
      const epoch = Math.floor(new Date(when).getTime() / 1000);

      if (!when || !Number.isFinite(epoch) || epoch <= Math.floor(Date.now() / 1000)) {
        throw new Error("Choose a future reminder time.");
      }
      if (!message || message.length > 16) {
        throw new Error("Reminder text must be 1-16 characters.");
      }

      const items = reminders();
      if (items.length >= MAX_REMINDERS) {
        throw new Error("All five MORNI reminder slots are in use. Remove an upcoming reminder first.");
      }

      const result = await send("REMINDER", epoch, message);
      const slot = Number(result?.[2]);
      if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_REMINDERS) {
        throw new Error("MORNI did not confirm a valid reminder slot. Check the firmware response.");
      }

      const updated = items.filter(item => Number(item.slot) !== slot);
      updated.push({ slot, when: new Date(epoch * 1000).toISOString(), text: message });
      saveReminders(updated);
      renderReminderList();
      $("morniUsbReminderText").value = "";
      $("morniUsbWhen").value = "";
      setReminderMinimum();
    });
    else if (t.dataset.morniCommand) run(() => send("COMMAND", t.dataset.morniCommand));
    else if (t.dataset.morniDisplay) run(() => send("DISPLAY", t.dataset.morniDisplay));
    else if (t.dataset.morniRemove !== undefined) run(async () => {
      const index = Number(t.dataset.morniRemove);
      const items = reminders();
      const item = items[index];
      if (!item) return;
      await send("CANCEL", item.slot);
      saveReminders(items.filter(saved => Number(saved.slot) !== Number(item.slot)));
      renderReminderList();
    });
  });

  // The original app owns its timer click handlers. They now reach this
  // bridge through request(), avoiding duplicate serial commands.

  const observer = new MutationObserver(mount);
  function start() {
    // Observe the whole app because its router may replace content outside
    // the #pageContent element used by older layouts.
    observer.observe(document.body, {
      childList: true, subtree: true
    });
    mount();
    if (!("serial" in navigator)) {
      console.warn("MORNI: Web Serial unavailable; use desktop Chrome/Edge.");
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else start();

  window.MORNI_USB_BRIDGE = {
    connect,
    disconnect,
    refreshStatus,
    request,
    send,
    get connected() { return connected; }
  };
})();

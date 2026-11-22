
window.MORNI_CONFIG = {
  // The app can switch modes from Settings.
  // false = start in live-device mode.
  simulationMode: false,

  deviceBaseUrl: "http://192.168.0.196",

  heartbeatInterval: 5000,
  offlineTimeout: 15000,

  requestTimeoutMs: 3500,
  requestTimeout: 3500,

  defaultUser: "MORNI User",

  endpoints: {
    status: "/status",
    events: "/events",
    handwash: "/dispense?id=handwash",
    sanitizer: "/dispense?id=sanitizer",
    timerStart: "/timer?cmd=start",
    timerPause: "/timer?cmd=pause",
    timerResume: "/timer?cmd=resume",
    timerReset: "/timer?cmd=reset",
    autoOn: "/mode?auto=1",
    autoOff: "/mode?auto=0"
  },

  refill: {
    handwashCapacity: 250,
    sanitizerCapacity: 100,
    handwashPerUse: 2,
    sanitizerPerUse: 1
  }
};

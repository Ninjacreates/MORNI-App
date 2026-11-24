
#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <RTClib.h>
#include <time.h>
#include <EEPROM.h>

// =====================================================
// MORNI - ESP8266 NODEMCU ESP-12E
// LCD + DS3231 + TOUCH + IR + WEB CONTROL
// =====================================================

// SNIT OPEN WI-FI
const char* WIFI_NAME = "SNIT ECE Dept";

// MORNI BACKUP WI-FI
const char* AP_NAME = "MORNI-Hardware";
const char* AP_PASSWORD = "morni123";

// PINS
#define TOUCH_PIN D6
#define TOUCH_LEVEL HIGH

#define IR_PIN D7
#define IR_DETECTED_LEVEL LOW

#define SDA_PIN D2
#define SCL_PIN D1

// LCD
#define LCD_ADDRESS 0x27

// TIMINGS
const unsigned long PASTE_DURATION = 10000UL;
const unsigned long BRUSH_DURATION = 120000UL;
const unsigned long DEBOUNCE_TIME = 60UL;
const unsigned long LCD_REFRESH = 200UL;
const unsigned long WIFI_RETRY = 20000UL;
const unsigned long NEWS_SCROLL_TIME = 400UL;
const unsigned long MESSAGE_TIME = 3000UL;
const unsigned long SCHOOL_ROTATE_TIME = 2800UL;

// OBJECTS
LiquidCrystal_I2C lcd(LCD_ADDRESS, 16, 2);
RTC_DS3231 rtc;
ESP8266WebServer server(80);

// =====================================================
// GLOBAL STATE
// =====================================================

enum RoutineState {
  WAITING,
  READY_FOR_PASTE,
  PASTE_COUNTDOWN,
  BRUSHING,
  PAUSED,
  COMPLETED
};

RoutineState state = WAITING;
RoutineState pausedState = PASTE_COUNTDOWN;

bool rtcOK = false;
int32_t displayTimezoneOffsetSeconds = 0; // Set by the browser during USB clock sync.
bool lcdOn = true;
bool messageActive = false;

String messageText = "";

unsigned long messageStart = 0;
unsigned long phaseStart = 0;
unsigned long phaseDuration = 0;
unsigned long pausedRemaining = 0;

unsigned long lastLCD = 0;
unsigned long lastWiFiAttempt = 0;
unsigned long lastNewsScroll = 0;
unsigned long lastTouchChange = 0;
unsigned long lastIRChange = 0;

bool rawTouch = false;
bool stableTouch = false;

bool rawIR = false;
bool stableIR = false;
bool brushWasPresent = false;

String oldLine1 = "";
String oldLine2 = "";

int newsIndex = 0;
int newsOffset = 0;
unsigned long lastSchoolRotate = 0;
int schoolDisplayIndex = 0;

const char* news[] = {
  "Space: Moon missions",
  "Technology: AI grows",
  "Nature: Plant more trees",
  "Science: New discoveries",
  "Energy: Go greener"
};

const int NEWS_COUNT = 5;

#define SCHOOL_MAGIC 0x5343484CUL
struct SchoolItem {
  char label[13];
  uint8_t done;
  uint8_t configured;
};
struct SchoolStore {
  uint32_t magic;
  SchoolItem items[4];
};
SchoolStore schoolStore;


const int MAX_EVENTS = 12;
String eventLog[MAX_EVENTS];
int eventCount = 0;

// =====================================================
// EVENTS
// =====================================================

void addEvent(String text) {
  String entry = text;

  if (rtcOK) {
    DateTime now = rtc.now();
    char t[8];
    snprintf(t, sizeof(t), "%02d:%02d",
             now.hour(), now.minute());
    entry = String(t) + " - " + text;
  }

  if (eventCount < MAX_EVENTS) {
    eventLog[eventCount++] = entry;
  } else {
    for (int i = 1; i < MAX_EVENTS; i++) {
      eventLog[i - 1] = eventLog[i];
    }
    eventLog[MAX_EVENTS - 1] = entry;
  }

  Serial.println(entry);
}

// =====================================================
// LCD - NO CONSTANT CLEARING
// =====================================================

void lcdWriteLine(byte row, String text, String &previous) {
  if (!lcdOn) return;

  if (text.length() > 16) {
    text = text.substring(0, 16);
  }

  while (text.length() < 16) {
    text += " ";
  }

  if (text != previous) {
    lcd.setCursor(0, row);
    lcd.print(text);
    previous = text;
  }
}

void resetLCDCache() {
  oldLine1 = "";
  oldLine2 = "";
}

void showMessage(String text) {
  text.trim();
  if (text.length() == 0) return;

  messageText = text;
  messageActive = true;
  messageStart = millis();

  lcdOn = true;
  lcd.backlight();
  resetLCDCache();

  addEvent("Message: " + text);
}

void displayOn() {
  lcdOn = true;
  lcd.backlight();
  resetLCDCache();
  addEvent("LCD ON");
}

void displayOff() {
  lcdOn = false;
  lcd.noBacklight();
  addEvent("LCD OFF");
}

// =====================================================
// CLOCK
// =====================================================

String getClockText() {
  if (!rtcOK) return "NO RTC";

  DateTime now(rtc.now().unixtime() + displayTimezoneOffsetSeconds);

  char buffer[17];
  snprintf(buffer, sizeof(buffer), "%02d:%02d",
           now.hour(), now.minute());

  return String(buffer);
}

// =====================================================
// TIMER
// =====================================================

unsigned long remainingTime() {
  if (state == PAUSED) return pausedRemaining;

  if (state != PASTE_COUNTDOWN && state != BRUSHING) {
    return 0;
  }

  unsigned long elapsed = millis() - phaseStart;

  if (elapsed >= phaseDuration) return 0;

  return phaseDuration - elapsed;
}

String timerText(unsigned long ms) {
  unsigned long seconds = (ms + 999UL) / 1000UL;

  char buffer[12];
  snprintf(buffer, sizeof(buffer), "%02lu:%02lu",
           seconds / 60UL, seconds % 60UL);

  return String(buffer);
}

void startPaste() {
  state = PASTE_COUNTDOWN;
  phaseStart = millis();
  phaseDuration = PASTE_DURATION;

  addEvent("Paste countdown started");
  showMessage("Apply toothpaste");
}

void startBrush() {
  state = BRUSHING;
  phaseStart = millis();
  phaseDuration = BRUSH_DURATION;

  addEvent("2 minute brushing started");
  showMessage("Start brushing!");
}

void completeRoutine() {
  state = COMPLETED;
  phaseDuration = 0;
  pausedRemaining = 0;

  addEvent("Brushing completed");
  showMessage("Well done!");
}

void pauseRoutine() {
  if (state != PASTE_COUNTDOWN && state != BRUSHING) {
    return;
  }

  pausedRemaining = remainingTime();
  pausedState = state;
  state = PAUSED;

  addEvent("Timer paused");
}

void resumeRoutine() {
  if (state != PAUSED) return;

  if (pausedRemaining == 0) {
    if (pausedState == PASTE_COUNTDOWN) {
      startBrush();
    } else {
      completeRoutine();
    }
    return;
  }

  phaseStart = millis();
  phaseDuration = pausedRemaining;
  state = pausedState;

  addEvent("Timer resumed");
}

void resetRoutine() {
  state = WAITING;
  phaseStart = 0;
  phaseDuration = 0;
  pausedRemaining = 0;
  messageActive = false;

  resetLCDCache();
  addEvent("Routine reset");
}

void updateTimer() {
  if (state != PASTE_COUNTDOWN && state != BRUSHING) {
    return;
  }

  if (remainingTime() == 0) {
    if (state == PASTE_COUNTDOWN) {
      startBrush();
    } else {
      completeRoutine();
    }
  }
}

// =====================================================
// TOUCH SENSOR
// First touch: wake MORNI
// Second touch: start paste countdown
// =====================================================

void handleTouch() {
  bool reading = (digitalRead(TOUCH_PIN) == TOUCH_LEVEL);

  if (reading != rawTouch) {
    rawTouch = reading;
    lastTouchChange = millis();
  }

  if (millis() - lastTouchChange < DEBOUNCE_TIME) {
    return;
  }

  if (reading != stableTouch) {
    stableTouch = reading;

    if (stableTouch) {
      if (state == WAITING) {
        state = READY_FOR_PASTE;
        addEvent("MORNI awakened");
        showMessage("Good morning!");
      }
      else if (state == READY_FOR_PASTE) {
        startPaste();
      }
      else if (state == COMPLETED) {
        resetRoutine();
        showMessage("Touch to begin");
      }
    }
  }
}

// =====================================================
// IR SENSOR
// Brush removed from holder = start paste countdown
// =====================================================

void handleIR() {
  bool reading = (digitalRead(IR_PIN) == IR_DETECTED_LEVEL);

  if (reading != rawIR) {
    rawIR = reading;
    lastIRChange = millis();
  }

  if (millis() - lastIRChange < DEBOUNCE_TIME) {
    return;
  }

  if (reading != stableIR) {
    stableIR = reading;

    if (stableIR) {
      brushWasPresent = true;
      addEvent("Brush detected in holder");
    } else {
      if (brushWasPresent && state == READY_FOR_PASTE) {
        brushWasPresent = false;
        addEvent("Brush removed");
        startPaste();
      } else {
        brushWasPresent = false;
      }
    }
  }
}

// =====================================================
// STATE DISPLAY
// =====================================================

String stateText() {
  switch (state) {
    case WAITING:
      return "Touch to wake";

    case READY_FOR_PASTE:
      return "Remove brush";

    case PASTE_COUNTDOWN:
      return "Paste " + timerText(remainingTime());

    case BRUSHING:
      return "Brush " + timerText(remainingTime());

    case PAUSED:
      return "Paused " + timerText(remainingTime());

    case COMPLETED:
      return "Well done!";

    default:
      return "MORNI READY";
  }
}

// =====================================================
// NEWS SCROLLING
// =====================================================

String getNewsWindow() {
  String headline = String(news[newsIndex]) + "                ";

  if (newsOffset >= headline.length()) {
    newsOffset = 0;
  }

  String result = headline.substring(newsOffset);
  result += headline.substring(0, newsOffset);

  return result.substring(0, 16);
}

void updateNews() {
  if (millis() - lastNewsScroll >= NEWS_SCROLL_TIME) {
    lastNewsScroll = millis();

    String headline = String(news[newsIndex]) + "                ";
    newsOffset++;

    if (newsOffset >= headline.length()) {
      newsOffset = 0;
      newsIndex = (newsIndex + 1) % NEWS_COUNT;
    }
  }
}

// =====================================================
// LCD UPDATE
// =====================================================

void updateLCD() {
  if (!lcdOn) return;

  if (millis() - lastLCD < LCD_REFRESH) return;
  lastLCD = millis();

  if (messageActive) {
    if (millis() - messageStart < MESSAGE_TIME) {
      lcdWriteLine(0, "MORNI MESSAGE", oldLine1);
      lcdWriteLine(1, messageText, oldLine2);
      return;
    }

    messageActive = false;
    resetLCDCache();
  }

  lcdWriteLine(0, "MORNI " + getClockText(), oldLine1);

  if (state == WAITING) {
    // Rotate school readiness on the LCD between the existing news headlines.
    bool anySchoolTask = false;
    bool allSchoolReady = true;
    for (int i = 0; i < 4; i++) {
      if (schoolStore.items[i].configured) {
        anySchoolTask = true;
        if (!schoolStore.items[i].done) allSchoolReady = false;
      }
    }

    if (anySchoolTask) {
      if (millis() - lastSchoolRotate >= SCHOOL_ROTATE_TIME) {
        lastSchoolRotate = millis();
        schoolDisplayIndex = (schoolDisplayIndex + 1) % 5;
      }

      if (allSchoolReady) {
        lcdWriteLine(1, "SCHOOL READY!", oldLine2);
      } else if (schoolDisplayIndex == 0) {
        lcdWriteLine(1, "School checklist", oldLine2);
      } else {
        int shown = -1;
        int seen = 0;
        for (int i = 0; i < 4; i++) {
          if (schoolStore.items[i].configured) {
            seen++;
            if (seen == schoolDisplayIndex) { shown = i; break; }
          }
        }
        if (shown >= 0) {
          String line = String(schoolStore.items[shown].label) + ":" +
            (schoolStore.items[shown].done ? " DONE" : " TODO");
          lcdWriteLine(1, line, oldLine2);
        } else {
          updateNews();
          lcdWriteLine(1, getNewsWindow(), oldLine2);
        }
      }
    } else {
      updateNews();
      lcdWriteLine(1, getNewsWindow(), oldLine2);
    }
  }
  else if (state == READY_FOR_PASTE) {
    lcdWriteLine(1, "Remove brush", oldLine2);
  }
  else {
    lcdWriteLine(1, stateText(), oldLine2);
  }
}


// =====================================================
// USB SERIAL BRIDGE + PERSISTENT LCD REMINDERS
// Browser connects using Chrome Web Serial at 115200 baud.
// Commands: REQ|id|STATUS / COMMAND|name / MESSAGE|text /
// CLOCK|unixSeconds / REMINDER|unixSeconds|text / CANCEL|slot
// =====================================================

#define EEPROM_BYTES 512
#define REMINDER_MAGIC 0x4D4F524E
#define MAX_REMINDERS 5

struct ReminderRecord {
  uint32_t epoch;
  char text[17];
  uint8_t active;
};

struct ReminderStore {
  uint32_t magic;
  ReminderRecord items[MAX_REMINDERS];
};

ReminderStore reminderStore;
String serialBuffer = "";

void saveReminderStore() {
  EEPROM.put(0, reminderStore);
  EEPROM.commit();
}

void initReminderStore() {
  EEPROM.begin(EEPROM_BYTES);
  EEPROM.get(0, reminderStore);

  if (reminderStore.magic != REMINDER_MAGIC) {
    memset(&reminderStore, 0, sizeof(reminderStore));
    reminderStore.magic = REMINDER_MAGIC;
    saveReminderStore();
  }

  EEPROM.get(sizeof(ReminderStore), schoolStore);
  if (schoolStore.magic != SCHOOL_MAGIC) {
    memset(&schoolStore, 0, sizeof(schoolStore));
    schoolStore.magic = SCHOOL_MAGIC;
    EEPROM.put(sizeof(ReminderStore), schoolStore);
    EEPROM.commit();
  }
}

void saveSchoolStore() {
  EEPROM.put(sizeof(ReminderStore), schoolStore);
  EEPROM.commit();
}

String serialStateName() {
  switch (state) {
    case WAITING: return "WAITING";
    case READY_FOR_PASTE: return "READY_FOR_PASTE";
    case PASTE_COUNTDOWN: return "PASTE_COUNTDOWN";
    case BRUSHING: return "BRUSHING";
    case PAUSED: return "PAUSED";
    case COMPLETED: return "COMPLETED";
    default: return "UNKNOWN";
  }
}

void serialReply(String id, String payload) {
  Serial.println("MORNI|" + id + "|" + payload);
}

void handleSerialRequest(String line) {
  if (!line.startsWith("REQ|")) return;

  int first = line.indexOf('|');
  int second = line.indexOf('|', first + 1);
  if (second < 0) return;

  String id = line.substring(first + 1, second);
  String rest = line.substring(second + 1);
  int split = rest.indexOf('|');
  String op = split < 0 ? rest : rest.substring(0, split);
  String args = split < 0 ? "" : rest.substring(split + 1);

  if (op == "STATUS") {
    String payload = "STATUS|" + getClockText() + "|" +
      timerText(remainingTime()) + "|" + serialStateName() + "|" +
      (rtcOK ? "1" : "0") + "|" + (lcdOn ? "1" : "0") + "|" +
      (stableIR ? "1" : "0");
    serialReply(id, payload);
    return;
  }

  if (op == "COMMAND") {
    if (args == "start") {
      if (state == WAITING) {
        state = READY_FOR_PASTE;
        addEvent("Started from USB website");
        showMessage("Good morning!");
      } else if (state == READY_FOR_PASTE) {
        startPaste();
      }
    } else if (args == "paste") {
      if (state == READY_FOR_PASTE) startPaste();
    } else if (args == "brush") {
      startBrush();
    } else if (args == "pause") {
      pauseRoutine();
    } else if (args == "resume") {
      resumeRoutine();
    } else if (args == "reset") {
      resetRoutine();
    } else {
      serialReply(id, "ERR|Unknown command");
      return;
    }
    serialReply(id, "OK|COMMAND");
    return;
  }

  if (op == "SCHOOL") {
    int firstSep = args.indexOf('|');
    int secondSep = firstSep < 0 ? -1 : args.indexOf('|', firstSep + 1);
    if (firstSep < 0 || secondSep < 0) {
      serialReply(id, "ERR|Use index|done|label");
      return;
    }
    int index = args.substring(0, firstSep).toInt();
    int done = args.substring(firstSep + 1, secondSep).toInt();
    String label = args.substring(secondSep + 1);
    label.trim();
    if (index < 0 || index >= 4 || label.length() == 0 || label.length() > 12) {
      serialReply(id, "ERR|Invalid school checklist item");
      return;
    }
    SchoolItem &item = schoolStore.items[index];
    memset(item.label, 0, sizeof(item.label));
    label.toCharArray(item.label, sizeof(item.label));
    item.done = done ? 1 : 0;
    item.configured = 1;
    saveSchoolStore();
    resetLCDCache();
    addEvent(String("School item ") + label + (done ? " complete" : " pending"));
    serialReply(id, "OK|SCHOOL|" + String(index));
    return;
  }

  if (op == "MESSAGE") {
    args.trim();
    if (args.length() == 0 || args.length() > 16) {
      serialReply(id, "ERR|LCD message must be 1-16 characters");
      return;
    }
    showMessage(args);
    serialReply(id, "OK|MESSAGE");
    return;
  }

  if (op == "DISPLAY") {
    if (args == "on") displayOn();
    else if (args == "off") displayOff();
    else {
      serialReply(id, "ERR|Use on or off");
      return;
    }
    serialReply(id, "OK|DISPLAY");
    return;
  }

  if (op == "CLOCK") {
    if (!rtcOK) {
      serialReply(id, "ERR|DS3231 not detected");
      return;
    }
    int divider = args.indexOf('|');
    String epochText = divider < 0 ? args : args.substring(0, divider);
    uint32_t epoch = (uint32_t) epochText.toInt();
    int offsetSeconds = divider < 0 ? 0 : args.substring(divider + 1).toInt();
    if (epoch < 1700000000UL || offsetSeconds < -50400 || offsetSeconds > 50400) {
      serialReply(id, "ERR|Invalid clock timestamp or timezone offset");
      return;
    }
    rtc.adjust(DateTime(epoch));
    displayTimezoneOffsetSeconds = offsetSeconds;
    resetLCDCache();
    addEvent("Clock synchronized over USB");
    serialReply(id, "OK|CLOCK");
    return;
  }

  if (op == "REMINDER") {
    int divider = args.indexOf('|');
    if (divider < 0 || !rtcOK) {
      serialReply(id, rtcOK ? "ERR|Use timestamp and message" : "ERR|DS3231 not detected");
      return;
    }

    uint32_t epoch = (uint32_t) args.substring(0, divider).toInt();
    String reminderText = args.substring(divider + 1);
    reminderText.trim();

    if (epoch <= (uint32_t) rtc.now().unixtime() ||
        reminderText.length() == 0 || reminderText.length() > 16) {
      serialReply(id, "ERR|Choose a future time and a 1-16 character message");
      return;
    }

    int slot = -1;
    for (int i = 0; i < MAX_REMINDERS; i++) {
      if (!reminderStore.items[i].active ||
          reminderStore.items[i].epoch <= (uint32_t) rtc.now().unixtime()) {
        slot = i;
        break;
      }
    }

    if (slot < 0) {
      serialReply(id, "ERR|Reminder storage is full (5 maximum)");
      return;
    }

    reminderStore.items[slot].epoch = epoch;
    memset(reminderStore.items[slot].text, 0, sizeof(reminderStore.items[slot].text));
    reminderText.toCharArray(reminderStore.items[slot].text, sizeof(reminderStore.items[slot].text));
    reminderStore.items[slot].active = 1;
    saveReminderStore();

    serialReply(id, "OK|REMINDER|" + String(slot));
    return;
  }

  if (op == "CANCEL") {
    int slot = args.toInt();
    if (slot < 0 || slot >= MAX_REMINDERS) {
      serialReply(id, "ERR|Invalid reminder slot");
      return;
    }
    reminderStore.items[slot].active = 0;
    saveReminderStore();
    serialReply(id, "OK|CANCEL");
    return;
  }

  serialReply(id, "ERR|Unknown operation");
}

void handleSerialInput() {
  while (Serial.available()) {
    char c = (char) Serial.read();
    if (c == '\r') continue;

    if (c == '\n') {
      String line = serialBuffer;
      serialBuffer = "";
      line.trim();
      if (line.length()) handleSerialRequest(line);
    } else if (serialBuffer.length() < 120) {
      serialBuffer += c;
    } else {
      serialBuffer = "";
    }
  }
}

void updateReminders() {
  if (!rtcOK) return;
  uint32_t nowEpoch = (uint32_t) rtc.now().unixtime();

  for (int i = 0; i < MAX_REMINDERS; i++) {
    ReminderRecord &item = reminderStore.items[i];
    if (item.active && nowEpoch >= item.epoch) {
      String text = String(item.text);
      item.active = 0;
      saveReminderStore();
      showMessage(text);
      addEvent("Reminder: " + text);
      Serial.println("MORNI|EVENT|REMINDER|" + String(i));
    }
  }
}


// =====================================================
// WEB HELPERS
// =====================================================

void sendJSON(int code, String body) {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.send(code, "application/json", body);
}

String jsonEscape(String s) {
  s.replace("\\", "\\\\");
  s.replace("\"", "\\\"");
  s.replace("\n", "\\n");
  s.replace("\r", "");
  return s;
}

// =====================================================
// WEB STATUS
// =====================================================

void handleStatus() {
  String st;

  switch (state) {
    case WAITING: st = "WAITING"; break;
    case READY_FOR_PASTE: st = "READY_FOR_PASTE"; break;
    case PASTE_COUNTDOWN: st = "PASTE_COUNTDOWN"; break;
    case BRUSHING: st = "BRUSHING"; break;
    case PAUSED: st = "PAUSED"; break;
    case COMPLETED: st = "COMPLETED"; break;
  }

  String ip = WiFi.status() == WL_CONNECTED
              ? WiFi.localIP().toString()
              : WiFi.softAPIP().toString();

  String json = "{";
  json += "\"time\":\"" + getClockText() + "\",";
  json += "\"timer\":\"" + timerText(remainingTime()) + "\",";
  json += "\"state\":\"" + st + "\",";
  json += "\"rtcWorking\":" + String(rtcOK ? "true" : "false") + ",";
  json += "\"lcdEnabled\":" + String(lcdOn ? "true" : "false") + ",";
  json += "\"wifiConnected\":" + String(WiFi.status() == WL_CONNECTED ? "true" : "false") + ",";
  json += "\"ip\":\"" + ip + "\",";
  json += "\"brushDetected\":" + String(stableIR ? "true" : "false");
  json += "}";

  sendJSON(200, json);
}

void handleEvents() {
  String json = "{\"events\":[";

  for (int i = 0; i < eventCount; i++) {
    if (i) json += ",";
    json += "\"" + jsonEscape(eventLog[i]) + "\"";
  }

  json += "]}";
  sendJSON(200, json);
}

// =====================================================
// WEB COMMANDS
// =====================================================

void handleCommand() {
  if (!server.hasArg("cmd")) {
    sendJSON(400, "{\"error\":\"Missing command\"}");
    return;
  }

  String cmd = server.arg("cmd");

  if (cmd == "start") {
    if (state == WAITING) {
      state = READY_FOR_PASTE;
      showMessage("Good morning!");
      addEvent("Started from website");
    } else if (state == READY_FOR_PASTE) {
      startPaste();
    }
  }
  else if (cmd == "paste") {
    if (state == READY_FOR_PASTE) startPaste();
  }
  else if (cmd == "brush") {
    startBrush();
  }
  else if (cmd == "pause") {
    pauseRoutine();
  }
  else if (cmd == "resume") {
    resumeRoutine();
  }
  else if (cmd == "reset") {
    resetRoutine();
  }
  else {
    sendJSON(400, "{\"error\":\"Unknown command\"}");
    return;
  }

  sendJSON(200, "{\"success\":true}");
}

void handleMessage() {
  if (!server.hasArg("text")) {
    sendJSON(400, "{\"error\":\"Missing text\"}");
    return;
  }

  String msg = server.arg("text");
  msg.trim();

  if (msg.length() == 0 || msg.length() > 16) {
    sendJSON(400, "{\"error\":\"Message must be 1 to 16 characters\"}");
    return;
  }

  showMessage(msg);
  sendJSON(200, "{\"success\":true}");
}

void handleDisplay() {
  if (server.arg("state") == "on") {
    displayOn();
  } else if (server.arg("state") == "off") {
    displayOff();
  } else {
    sendJSON(400, "{\"error\":\"Use on or off\"}");
    return;
  }

  sendJSON(200, "{\"success\":true}");
}

// Set clock from laptop browser local time.
// Example: /setclock?y=2026&mo=11&d=24&h=11&mi=20&s=0

void handleSetClock() {
  if (!rtcOK) {
    sendJSON(503, "{\"error\":\"DS3231 not detected\"}");
    return;
  }

  const char* keys[] = {"y", "mo", "d", "h", "mi", "s"};

  for (int i = 0; i < 6; i++) {
    if (!server.hasArg(keys[i])) {
      sendJSON(400, "{\"error\":\"Missing time values\"}");
      return;
    }
  }

  int y = server.arg("y").toInt();
  int mo = server.arg("mo").toInt();
  int d = server.arg("d").toInt();
  int h = server.arg("h").toInt();
  int mi = server.arg("mi").toInt();
  int s = server.arg("s").toInt();

  if (y < 2020 || y > 2099 || mo < 1 || mo > 12 ||
      d < 1 || d > 31 || h < 0 || h > 23 ||
      mi < 0 || mi > 59 || s < 0 || s > 59) {
    sendJSON(400, "{\"error\":\"Invalid date/time\"}");
    return;
  }

  rtc.adjust(DateTime(y, mo, d, h, mi, s));

  resetLCDCache();
  addEvent("Clock synchronized from browser");

  sendJSON(200, "{\"success\":true}");
}

// =====================================================
// WEB PAGE
// =====================================================

void handleRoot() {
  String page = R"rawliteral(
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MORNI Hardware</title>
<style>
body{font-family:Arial;background:#edf5e9;color:#23452e;text-align:center;padding:15px}
.card{background:white;max-width:440px;margin:14px auto;padding:18px;border-radius:15px;box-shadow:0 3px 12px #0001}
button{border:0;border-radius:9px;padding:12px 16px;margin:5px;background:#347b45;color:white;font-size:15px}
input{padding:11px;border-radius:8px;border:1px solid #aaa}
.value{font-size:32px;font-weight:bold}
small{color:#657568}
</style>
</head>
<body>
<h1>MORNI</h1>
<p>Hardware Control Centre</p>

<div class="card">
<h2>Clock</h2>
<div class="value" id="clock">--:--</div>
<p id="wifi">Checking connection...</p>
<button onclick="syncClock()">Sync laptop time</button>
</div>

<div class="card">
<h2>Routine</h2>
<p id="state">Loading...</p>
<div class="value" id="timer">02:00</div>
<button onclick="cmd('start')">Wake / Start</button>
<button onclick="cmd('paste')">Start paste timer</button>
<button onclick="cmd('brush')">Start brushing</button>
<button onclick="cmd('pause')">Pause</button>
<button onclick="cmd('resume')">Resume</button>
<button onclick="cmd('reset')">Reset</button>
</div>

<div class="card">
<h2>LCD Message</h2>
<input id="msg" maxlength="16" placeholder="Maximum 16 characters">
<button onclick="sendMsg()">Send to LCD</button>
<br>
<button onclick="fetch('/display?state=on')">LCD ON</button>
<button onclick="fetch('/display?state=off')">LCD OFF</button>
<button onclick="fetch('/greeting')">Greeting</button>
</div>

<div class="card">
<h2>Hardware status</h2>
<p id="hardware">Checking...</p>
</div>

<div class="card">
<h2>Recent events</h2>
<div id="events">Loading...</div>
</div>

<script>
async function cmd(c){
  try{
    const r=await fetch('/command?cmd='+c);
    const d=await r.json();
    if(!r.ok) alert(d.error||'Command failed');
    refresh();
  }catch(e){alert('Cannot reach MORNI');}
}

async function sendMsg(){
  const m=document.getElementById('msg').value.trim();
  if(!m)return alert('Enter a message');
  try{
    await fetch('/message?text='+encodeURIComponent(m));
    refresh();
  }catch(e){alert('Cannot reach MORNI');}
}

async function syncClock(){
  const n=new Date();
  const q='/setclock?y='+n.getFullYear()+
    '&mo='+(n.getMonth()+1)+
    '&d='+n.getDate()+
    '&h='+n.getHours()+
    '&mi='+n.getMinutes()+
    '&s='+n.getSeconds();

  try{
    const r=await fetch(q);
    const d=await r.json();
    if(!r.ok) alert(d.error||'Clock sync failed');
    else alert('MORNI clock synchronized!');
    refresh();
  }catch(e){alert('Clock sync failed');}
}

async function refresh(){
  try{
    const r=await fetch('/status');
    const d=await r.json();

    document.getElementById('clock').textContent=d.time;
    document.getElementById('timer').textContent=d.timer;
    document.getElementById('state').textContent=d.state;

    document.getElementById('wifi').textContent=
      d.wifiConnected?'SNIT connected: '+d.ip:'MORNI backup Wi-Fi: '+d.ip;

    document.getElementById('hardware').textContent=
      'RTC: '+(d.rtcWorking?'OK':'NOT DETECTED')+
      ' | LCD: '+(d.lcdEnabled?'ON':'OFF')+
      ' | Brush: '+(d.brushDetected?'Detected':'Not detected');

    const er=await fetch('/events');
    const ed=await er.json();
    document.getElementById('events').innerHTML=
      ed.events.map(x=>'<div>'+x.replace(/</g,'&lt;')+'</div>').join('');
  }catch(e){}
}

syncClock();
refresh();
setInterval(refresh,1000);
</script>
</body>
</html>
)rawliteral";

  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(200, "text/html", page);
}

// =====================================================
// WIFI - AP ALWAYS STARTS, SNIT IS OPTIONAL
// =====================================================

void startWiFi() {
  // The laptop stays on SNIT for internet. ESP8266 uses USB serial only.
  WiFi.persistent(false);
  WiFi.mode(WIFI_OFF);
  Serial.println("MORNI USB mode: ESP8266 Wi-Fi disabled.");
}

// =====================================================
// SERVER
// =====================================================

void setupServer() {
  server.on("/", HTTP_GET, handleRoot);
  server.on("/status", HTTP_GET, handleStatus);
  server.on("/events", HTTP_GET, handleEvents);
  server.on("/command", HTTP_GET, handleCommand);
  server.on("/message", HTTP_GET, handleMessage);
  server.on("/display", HTTP_GET, handleDisplay);
  server.on("/setclock", HTTP_GET, handleSetClock);

  server.on("/greeting", HTTP_GET, []() {
    showMessage("Good morning!");
    sendJSON(200, "{\"success\":true}");
  });

  server.onNotFound([]() {
    if (server.method() == HTTP_OPTIONS) {
      server.sendHeader("Access-Control-Allow-Origin", "*");
      server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
      server.send(204);
    } else {
      sendJSON(404, "{\"error\":\"Not found\"}");
    }
  });

  server.begin();
  Serial.println("MORNI web server started");
}

// =====================================================
// SETUP
// =====================================================

void setup() {
  Serial.begin(115200);
  delay(200);
  initReminderStore();

  pinMode(TOUCH_PIN, INPUT);
  pinMode(IR_PIN, INPUT);

  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(100000);

  lcd.init();
  lcd.backlight();
  lcd.clear();

  lcd.setCursor(0, 0);
  lcd.print("MORNI");
  lcd.setCursor(0, 1);
  lcd.print("Starting...");

  if (rtc.begin()) {
    rtcOK = true;
    Serial.println("DS3231 RTC detected");

    if (rtc.lostPower()) {
      Serial.println("RTC lost power; browser time sync required");
    }
  } else {
    rtcOK = false;
    Serial.println("RTC NOT DETECTED");
  }

  rawTouch = digitalRead(TOUCH_PIN) == TOUCH_LEVEL;
  stableTouch = rawTouch;
  lastTouchChange = millis();

  rawIR = digitalRead(IR_PIN) == IR_DETECTED_LEVEL;
  stableIR = rawIR;
  brushWasPresent = stableIR;
  lastIRChange = millis();

  startWiFi();
  setupServer();

  addEvent("MORNI hardware started");

  showMessage("Good morning!");
  Serial.println("MORNI|READY|USB");
}

// =====================================================
// LOOP
// =====================================================

void loop() {
  handleSerialInput();

  handleTouch();
  handleIR();

  updateTimer();
  updateReminders();
  updateLCD();

  yield();
}